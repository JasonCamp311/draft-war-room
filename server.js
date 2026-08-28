#!/usr/bin/env node
'use strict';
/*
 * Draft War Room server — zero dependencies (Node 18+).
 *
 * Sections:
 *   1. config + tiny utils
 *   2. persistence (data/*.json)
 *   3. players cache (Sleeper /players/nfl, 24h TTL)
 *   4. name normalization + player matching
 *   5. rankings import (CSV -> resolved rows)
 *   6. board computation (pure math: availability, gaps, survival, VORP, fallback)
 *   7. Sleeper poller (backoff, never dies)
 *   8. advisor engine (speculative requests, stale guards, latency log)
 *   9. Anthropic streaming client (raw fetch SSE) + mock LLM
 *  10. SSE hub + HTTP server / routes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- 1. config

const PORT = Number(process.env.PORT || 8484);
const REPLAY = process.env.REPLAY === '1' || process.argv.includes('--replay');
const REPLAY_PORT = Number(process.env.REPLAY_PORT || 3999);
const MOCK_LLM = process.env.MOCK_LLM === '1';
const EFFORT = process.env.EFFORT || 'high';           // low|medium|high|xhigh|max
const SPECULATE_WITHIN = Number(process.env.SPECULATE_WITHIN || 2);
const POLL_MS = Number(process.env.POLL_MS || (REPLAY ? 1000 : 2000));
const DATA_DIR = path.join(__dirname, 'data');
const SLEEPER_REAL = 'https://api.sleeper.app/v1';
const SLEEPER_BASE = REPLAY ? `http://127.0.0.1:${REPLAY_PORT}/v1` : SLEEPER_REAL;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-fable-5';

const FANTASY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function warn(...a) { console.warn(new Date().toISOString().slice(11, 19), 'WARN', ...a); }

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url}`); e.status = r.status; throw e; }
  return r.json();
}

// ---------------------------------------------------------- 2. persistence

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { warn(`corrupt ${name}, using fallback:`, e.message); return fallback; }
}

const saveTimers = {};
function saveJson(name, obj) {          // debounced atomic write
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    try {
      const p = path.join(DATA_DIR, name);
      fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
      fs.renameSync(p + '.tmp', p);
    } catch (e) { warn(`save ${name} failed:`, e.message); }
  }, 250);
}

// Global state. Everything the UI needs lives here and survives restarts via data/.
const ST = {
  players: {},            // id -> {n, p, t, sr}
  nameIndex: null,        // built after players load
  rankings: [],           // resolved CSV rows
  rankingsMeta: null,     // {name, importedAt, matchStats}
  session: loadJson('session.json', { draft_id: null, my_slot: null, manual: {}, notes: {} }),
  draft: { meta: null, picks: [], anomalies: [], status: null },
  board: null,            // computed
  poll: { failures: 0, degraded: false, lastOkAt: 0, timer: null, running: false },
  adv: {                  // advisor engine state
    seq: 0, inflight: null, latest: null, latency: [],
    killLLM: false,       // debug: simulate Anthropic outage
  },
  sse: new Set(),
  staticPrefix: null,     // cached-prompt block (byte-stable)
};

// ------------------------------------------------- 3. players cache (24h TTL)

const PLAYERS_TTL_MS = 24 * 3600 * 1000;

async function loadPlayers() {
  const cache = loadJson('players-cache.json', null);
  if (cache && Date.now() - cache.fetchedAt < PLAYERS_TTL_MS) {
    ST.players = cache.players;
    log(`players cache: ${Object.keys(ST.players).length} players (age ${((Date.now() - cache.fetchedAt) / 3600e3).toFixed(1)}h)`);
    buildNameIndex();
    return;
  }
  try {
    log('fetching Sleeper players/nfl (~5MB, cached 24h)...');
    // Always the real API — the replay mock does not carry the 5MB blob.
    const full = await fetchJson(`${SLEEPER_REAL}/players/nfl`, {}, 60000);
    const trimmed = {};
    for (const [id, p] of Object.entries(full)) {
      if (!p || !FANTASY_POS.has(p.position)) continue;
      const sr = (typeof p.search_rank === 'number' && p.search_rank > 0) ? p.search_rank : 9999999;
      if (!p.team && p.position !== 'DEF' && sr > 2000) continue;   // cut long-retired players
      trimmed[id] = {
        n: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        p: p.position, t: p.team || '', sr,
      };
    }
    ST.players = trimmed;
    fs.writeFileSync(path.join(DATA_DIR, 'players-cache.json'), JSON.stringify({ fetchedAt: Date.now(), players: trimmed }));
    log(`players cache refreshed: ${Object.keys(trimmed).length} fantasy-relevant players`);
  } catch (e) {
    if (cache) { ST.players = cache.players; warn(`players fetch failed (${e.message}); using STALE cache from ${new Date(cache.fetchedAt).toISOString()}`); }
    else throw new Error(`players fetch failed and no cache exists: ${e.message}`);
  }
  buildNameIndex();
}

// ------------------------------------- 4. normalization + player matching

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function normName(s) {
  const toks = String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(t => t && !SUFFIXES.has(t));
  // collapse runs of single letters so "A.J." == "AJ" ("a j brown" -> "aj brown")
  const merged = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].length === 1) {
      let j = i, run = '';
      while (j < toks.length && toks[j].length === 1) { run += toks[j]; j++; }
      merged.push(run); i = j - 1;
    } else merged.push(toks[i]);
  }
  return merged.join(' ');
}

function normPos(s) {
  let p = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');  // "RB12" -> "RB"
  if (p === 'DST' || p === 'DS' || p === 'D') p = 'DEF';
  if (p === 'PK') p = 'K';
  return p;
}

const TEAM_ALIAS = { JAC: 'JAX', WSH: 'WAS', LVR: 'LV', SD: 'LAC', OAK: 'LV', STL: 'LAR', LA: 'LAR' };
function normTeam(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  return TEAM_ALIAS[t] || t;
}

function buildNameIndex() {
  const ix = { byNamePos: new Map(), byName: new Map(), byLastPos: new Map() };
  const add = (map, key, id) => {
    if (!key) return;
    const a = map.get(key); if (a) { if (!a.includes(id)) a.push(id); } else map.set(key, [id]);
  };
  for (const [id, pl] of Object.entries(ST.players)) {
    const keys = new Set([normName(pl.n)]);
    if (pl.p === 'DEF') {
      // Sleeper DEF: id = team code, name = "Los Angeles Chargers".
      const words = normName(pl.n).split(' ');
      keys.add(words[words.length - 1]);              // "chargers"
      keys.add(id.toLowerCase());                     // "lac"
      keys.add(normName(pl.n) + ' defense');
      for (const k of [...keys]) { keys.add(k + ' dst'); keys.add(k + ' d st'); }
    }
    for (const k of keys) {
      add(ix.byNamePos, `${k}|${pl.p}`, id);
      add(ix.byName, k, id);
    }
    const parts = normName(pl.n).split(' ');
    if (parts.length >= 2 && pl.p !== 'DEF') {
      add(ix.byLastPos, `${parts[parts.length - 1]} ${parts[0][0]}|${pl.p}`, id);
    }
  }
  ST.nameIndex = ix;
}

function lev(a, b) {                                   // small-string levenshtein
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Resolve a CSV row to a Sleeper player_id. Returns {id, method} or null.
function resolvePlayer(name, pos, team) {
  const nn = normName(name), np = normPos(pos), nt = normTeam(team);
  const ix = ST.nameIndex;
  const pickByTeam = (ids) => {
    if (ids.length === 1) return ids[0];
    if (nt) { const f = ids.filter(id => ST.players[id].t === nt); if (f.length === 1) return f[0]; }
    // last resort among exact-name dupes: most fantasy-relevant (lowest search_rank)
    return ids.slice().sort((a, b) => ST.players[a].sr - ST.players[b].sr)[0];
  };
  if (np) {
    const ids = ix.byNamePos.get(`${nn}|${np}`);
    if (ids) return { id: pickByTeam(ids), method: ids.length === 1 ? 'exact' : 'exact-multi' };
  }
  const anyPos = ix.byName.get(nn);
  if (anyPos) {
    const f = np ? anyPos.filter(id => ST.players[id].p === np) : anyPos;
    if (f.length) return { id: pickByTeam(f), method: 'name' };
    if (anyPos.length === 1) return { id: anyPos[0], method: 'name-posmismatch' };
  }
  const parts = nn.split(' ');
  if (parts.length >= 2 && np) {
    const ids = ix.byLastPos.get(`${parts[parts.length - 1]} ${parts[0][0]}|${np}`);
    if (ids) return { id: pickByTeam(ids), method: 'initial-last' };
  }
  // fuzzy: same pos (and same team if known), edit distance <= 2, unique best
  let best = null, bestD = 3, ties = 0;
  for (const [id, pl] of Object.entries(ST.players)) {
    if (np && pl.p !== np) continue;
    if (nt && pl.t && pl.t !== nt && np !== 'DEF') continue;
    const d = lev(nn, normName(pl.n));
    if (d < bestD) { bestD = d; best = id; ties = 0; }
    else if (d === bestD && id !== best) ties++;
  }
  if (best && ties === 0 && bestD <= 2) return { id: best, method: `fuzzy${bestD}` };
  return null;
}

// ----------------------------------------------- 5. rankings import (CSV)

// Tolerant CSV parser (handles quoted fields, CRLF, embedded commas/quotes).
function parseCsv(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some(f => f.trim() !== '')) rows.push(row); }
  return rows;
}

const COL_PATTERNS = {
  rank: /^(rk|rank|ovr|overall|ecr)$/i,
  tier: /^tiers?$/i,
  name: /^(player( name)?|name)$/i,
  team: /^(team|tm)$/i,
  pos: /^(pos|position)$/i,
  bye: /^(bye( week)?)$/i,
  proj: /^(proj|projection|proj pts|fpts|points|proj\.? points)$/i,
  notes: /^(notes?|comment s?)$/i,
};

function importRankings(csvText, fileName) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const header = rows[0].map(h => h.trim());
  const col = {};
  header.forEach((h, i) => {
    for (const [k, re] of Object.entries(COL_PATTERNS)) if (col[k] === undefined && re.test(h)) col[k] = i;
  });
  if (col.name === undefined) {
    // headerless or odd header: guess by content of first data row
    throw new Error(`could not find a player-name column in header: ${header.join(', ')}`);
  }
  const out = []; const stats = { exact: 0, fallback: 0, unmatched: 0, byMethod: {} };
  rows.slice(1).forEach((r, i) => {
    const name = (r[col.name] || '').trim();
    if (!name) return;
    const pos = normPos(col.pos !== undefined ? r[col.pos] : '');
    const team = normTeam(col.team !== undefined ? r[col.team] : '');
    const rank = col.rank !== undefined ? Number(r[col.rank]) || (i + 1) : (i + 1);
    const tier = col.tier !== undefined ? Number(r[col.tier]) || null : null;
    const bye = col.bye !== undefined ? Number(r[col.bye]) || null : null;
    const proj = col.proj !== undefined ? Number(String(r[col.proj]).replace(/[^0-9.]/g, '')) || null : null;
    const notes = col.notes !== undefined ? (r[col.notes] || '').trim() : '';
    const m = resolvePlayer(name, pos, team);
    const row = {
      rank, tier, name, pos: pos || (m ? ST.players[m.id].p : ''), team: team || (m ? ST.players[m.id].t : ''),
      bye, proj, notes,
      player_id: m ? m.id : null, match: m ? m.method : 'none',
    };
    if (m) { if (m.method.startsWith('exact')) stats.exact++; else stats.fallback++; stats.byMethod[m.method] = (stats.byMethod[m.method] || 0) + 1; }
    else { stats.unmatched++; }
    out.push(row);
  });
  out.sort((a, b) => a.rank - b.rank);
  // duplicate player_id guard (two CSV rows resolving to one player)
  const seen = new Map();
  for (const r of out) {
    if (!r.player_id) continue;
    if (seen.has(r.player_id)) { warn(`CSV rows ${seen.get(r.player_id)} and "${r.name}" both resolved to ${r.player_id}; keeping first`); r.player_id = null; r.match = 'dup'; stats.unmatched++; }
    else seen.set(r.player_id, r.name);
  }
  ST.rankings = out;
  ST.rankingsMeta = { name: fileName || 'rankings.csv', importedAt: Date.now(), stats, rows: out.length };
  computeVorp();
  saveJson('rankings.json', { meta: ST.rankingsMeta, rows: out });
  rebuildStaticPrefix();
  return ST.rankingsMeta;
}

function loadRankingsFromDisk() {
  const d = loadJson('rankings.json', null);
  if (d && Array.isArray(d.rows)) { ST.rankings = d.rows; ST.rankingsMeta = d.meta; computeVorp(); }
}

// VORP: replacement level = starters x teams per position (flex apportioned RB/WR/TE).
function computeVorp() {
  const meta = ST.draft.meta;
  const withProj = ST.rankings.filter(r => r.proj != null).length;
  if (!ST.rankings.length || withProj < ST.rankings.length * 0.8) {
    for (const r of ST.rankings) delete r.vorp;
    return;   // no/partial projections: skip silently per spec
  }
  const s = meta ? meta.settings : {};
  const teams = (s && s.teams) || 10;
  const flex = (s && s.slots_flex) || 0;
  const starters = {
    QB: ((s && s.slots_qb) || 1) + ((s && s.slots_super_flex) || 0) * 0.8,
    RB: ((s && s.slots_rb) || 2) + flex * 0.45,
    WR: ((s && s.slots_wr) || 2) + flex * 0.45,
    TE: ((s && s.slots_te) || 1) + flex * 0.10,
    K: (s && s.slots_k) || 1, DEF: (s && s.slots_def) || 1,
  };
  const byPos = {};
  for (const r of ST.rankings) { (byPos[r.pos] = byPos[r.pos] || []).push(r); }
  for (const [pos, rows] of Object.entries(byPos)) {
    rows.sort((a, b) => a.rank - b.rank);
    const replIdx = Math.round((starters[pos] || 1) * teams) - 1;
    const repl = rows[Math.min(replIdx, rows.length - 1)];
    const replProj = repl ? (repl.proj || 0) : 0;
    for (const r of rows) r.vorp = r.proj != null ? Math.round((r.proj - replProj) * 10) / 10 : null;
  }
}

// ------------------------------------ 6. board computation (pure math)

function draftSlots(meta) {
  const s = (meta && meta.settings) || {};
  return {
    QB: s.slots_qb || 0, RB: s.slots_rb || 0, WR: s.slots_wr || 0, TE: s.slots_te || 0,
    K: s.slots_k || 0, DEF: s.slots_def || 0,
    FLEX: (s.slots_flex || 0) + (s.slots_wr_rb || 0) + (s.slots_rec_flex || 0),
    SFLEX: s.slots_super_flex || 0, BN: s.slots_bn || 0,
  };
}

function pickToSlot(pickNo, meta) {
  const s = meta.settings; const teams = s.teams;
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams;
  let fwd = round % 2 === 1;
  if (meta.type === 'linear') fwd = true;
  else if (s.reversal_round && round >= s.reversal_round) fwd = !fwd;
  return { round, slot: fwd ? idx + 1 : teams - idx };
}

// Roster needs: dedicated slots first, spill into FLEX/SFLEX, then bench-phase weights.
function rosterNeeds(posCounts, slots, round, totalRounds) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, ...posCounts };
  const ded = {};
  for (const p of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) ded[p] = Math.max(0, (slots[p] || 0) - counts[p]);
  let flexOpen = slots.FLEX || 0;
  for (const p of ['RB', 'WR', 'TE']) {
    const spill = Math.max(0, counts[p] - (slots[p] || 0));
    flexOpen = Math.max(0, flexOpen - spill);
  }
  let sflexOpen = slots.SFLEX || 0;
  if (sflexOpen) sflexOpen = Math.max(0, sflexOpen - Math.max(0, counts.QB - (slots.QB || 0)));
  const lateRounds = round >= totalRounds - 1;         // K/DEF window: last 2 rounds
  const w = {};
  for (const p of ['QB', 'RB', 'WR', 'TE']) w[p] = ded[p];
  if (flexOpen) { w.RB += 0.35 * flexOpen; w.WR += 0.35 * flexOpen; w.TE += 0.1 * flexOpen; }
  if (sflexOpen) w.QB += 0.8 * sflexOpen;
  w.K = ded.K ? (lateRounds ? 1.2 : 0.02) : 0;
  w.DEF = ded.DEF ? (lateRounds ? 1.2 : 0.03) : 0;
  const anyStarterNeed = Object.values(w).some(v => v >= 0.5);
  if (!anyStarterNeed) {                                // bench phase: upside skew
    w.RB += 0.4; w.WR += 0.4; w.QB += 0.1; w.TE += 0.1;
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const norm = {}; for (const [k, v] of Object.entries(w)) norm[k] = v / sum;
  return { weights: norm, dedicated: ded, flexOpen, sflexOpen };
}

function computeBoard() {
  const { meta, picks } = ST.draft;
  const mySlot = Number(ST.session.my_slot) || null;
  if (!meta) { ST.board = null; return null; }
  const s = meta.settings || {};
  const teams = s.teams || 10, rounds = s.rounds || 15;
  const totalPicks = teams * rounds;

  // --- anomaly detection: gaps + slot-math mismatches (traded/moved/skipped slots)
  const anomalies = [];
  const byNo = new Map(picks.map(p => [p.pick_no, p]));
  let maxNo = 0;
  for (const p of picks) maxNo = Math.max(maxNo, p.pick_no);
  for (let n = 1; n <= maxNo; n++) if (!byNo.has(n)) anomalies.push(`pick #${n} missing from Sleeper feed (skipped/removed?)`);
  let slotMismatch = 0;
  for (const p of picks) {
    const exp = pickToSlot(p.pick_no, meta);
    if (exp.slot !== p.draft_slot) slotMismatch++;
  }
  if (slotMismatch) anomalies.push(`${slotMismatch} pick(s) landed on unexpected slots — snake math may be off (3rd-round reversal? manual reorder?). Trust the picks feed, double-check "picks until you".`);
  if (meta.type === 'auction') anomalies.push('This is an AUCTION draft — this tool only supports snake/linear order math. Pick predictions will be wrong.');

  const pickCount = picks.length;
  const currentPickNo = pickCount + 1;
  const cur = currentPickNo <= totalPicks ? pickToSlot(currentPickNo, meta) : null;

  // my upcoming picks
  let myNextPickNo = null, myPickNos = [];
  if (mySlot) {
    for (let n = currentPickNo; n <= totalPicks; n++) {
      if (pickToSlot(n, meta).slot === mySlot) { myPickNos.push(n); if (myNextPickNo === null) myNextPickNo = n; if (myPickNos.length >= 3) break; }
    }
  }
  const status = ST.draft.status;
  const onClock = !!(mySlot && cur && cur.slot === mySlot && status === 'drafting');
  const picksUntilMine = myNextPickNo !== null ? myNextPickNo - currentPickNo : null;

  // --- picked set & pick matching
  const pickedIds = new Set(picks.map(p => p.player_id));
  const manual = ST.session.manual || {};
  for (const [pid, v] of Object.entries(manual)) if (v) pickedIds.add(pid);
  const rowByPid = new Map(ST.rankings.filter(r => r.player_id).map(r => [r.player_id, r]));

  // fallback name-match: link picks to unresolved CSV rows so they leave the board
  const unresolvedRows = ST.rankings.filter(r => !r.player_id);
  const pickInfo = [];       // annotated pick feed (most recent last)
  const unmatchedPicks = []; // picks we cannot identify at all
  for (const p of picks) {
    const pl = ST.players[p.player_id];
    const md = p.metadata || {};
    const name = pl ? pl.n : `${md.first_name || ''} ${md.last_name || ''}`.trim();
    const pos = pl ? pl.p : (md.position || '?');
    let row = rowByPid.get(p.player_id) || null;
    if (!row && unresolvedRows.length) {
      const nn = normName(name);
      row = unresolvedRows.find(r => normName(r.name) === nn && (!r.pos || r.pos === pos)) || null;
      if (row) { row._linkedPick = p.player_id; pickedIds.add('csvrow:' + row.rank); }
    }
    if (!pl && !name) unmatchedPicks.push({ pick_no: p.pick_no, player_id: p.player_id });
    pickInfo.push({
      pick_no: p.pick_no, round: p.round, slot: p.draft_slot, player_id: p.player_id,
      name, pos, team: pl ? pl.t : (md.team || ''),
      rank: row ? row.rank : null, inCsv: !!row, mine: p.draft_slot === mySlot,
    });
  }

  // --- availability
  const available = ST.rankings.filter(r =>
    !(r.player_id && pickedIds.has(r.player_id)) &&
    !(!r.player_id && pickedIds.has('csvrow:' + r.rank)) &&
    !(r.player_id && manual[r.player_id]) &&
    !manual['csvrow:' + r.rank]                      // manual X on an unresolved CSV row
  );

  // --- rosters + needs per slot
  const slots = draftSlots(meta);
  const currentRound = cur ? cur.round : rounds;
  const rosterBySlot = {};
  for (let sl = 1; sl <= teams; sl++) rosterBySlot[sl] = { players: [], counts: {} };
  for (const p of pickInfo) {
    const r = rosterBySlot[p.slot]; if (!r) continue;
    r.players.push({ name: p.name, pos: p.pos, team: p.team, round: p.round });
    r.counts[p.pos] = (r.counts[p.pos] || 0) + 1;
  }
  const needsBySlot = {};
  for (let sl = 1; sl <= teams; sl++) needsBySlot[sl] = rosterNeeds(rosterBySlot[sl].counts, slots, currentRound, rounds);

  // --- teams picking between now and my next pick, with predicted targets.
  // When I'm ON the clock, the question becomes "will X survive to my FOLLOWING
  // pick if I pass now" — so the horizon is myPickNos[1], not the current pick.
  const intervening = [];
  const survivalHorizon = onClock ? (myPickNos[1] || null) : myNextPickNo;
  if (survivalHorizon !== null) {
    for (let n = currentPickNo + (onClock ? 1 : 0); n < survivalHorizon; n++) {
      const t = pickToSlot(n, meta);
      const needs = needsBySlot[t.slot];
      const top = Object.entries(needs.weights).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0.12).slice(0, 3);
      intervening.push({ pick_no: n, slot: t.slot, targets: top.map(([p, v]) => ({ pos: p, w: Math.round(v * 100) / 100 })) });
    }
  }

  // --- survival odds (explainable): each intervening team drafts from the top
  // W available by rank with linearly decreasing appetite, scaled by its
  // positional need relative to a neutral team.
  const W = 8;
  const linW = []; { let sum = 0; for (let i = 0; i < W; i++) { linW.push(W - i); sum += W - i; } for (let i = 0; i < W; i++) linW[i] /= sum; }
  const neutral = { QB: 0.12, RB: 0.33, WR: 0.33, TE: 0.12, K: 0.05, DEF: 0.05 };
  function survivalFor(row, idx) {
    if (idx >= W + intervening.length) return { base: 99, adj: 99, hungry: 0 };
    let base = 1, adj = 1, hungry = 0;
    for (const t of intervening) {
      const pBase = idx < W ? linW[idx] : 0;
      const needW = needsBySlot[t.slot].weights[row.pos] || 0;
      const scale = Math.min(2.5, needW / (neutral[row.pos] || 0.1));
      if (scale > 1.3) hungry++;
      base *= (1 - Math.min(0.95, pBase));
      adj *= (1 - Math.min(0.95, pBase * scale));
    }
    return { base: Math.round(base * 100), adj: Math.round(adj * 100), hungry };
  }

  const myNeeds = mySlot ? needsBySlot[mySlot] : null;
  const phase = currentRound <= 3 ? 'early' : (currentRound >= rounds - 3 ? 'late' : 'middle');

  // --- candidates: top 12 overall + top 3 at each pos I still need
  const candidates = [];
  const seen = new Set();
  const pushCand = (row, i) => {
    if (seen.has(row)) return; seen.add(row);
    const sv = survivalFor(row, i);
    candidates.push({ ...row, availIdx: i, survival: sv });
  };
  available.slice(0, 12).forEach((r, i) => pushCand(r, i));
  if (myNeeds) {
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      if ((myNeeds.weights[pos] || 0) < 0.08 && !(phase === 'late' && (pos === 'K' || pos === 'DEF') && myNeeds.dedicated[pos])) continue;
      let count = 0;
      for (let i = 0; i < available.length && count < 3; i++) {
        if (available[i].pos === pos) { pushCand(available[i], i); count++; }
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);

  // --- deterministic fallback: top 5 by rank with tier/need annotations
  const tierCounts = {};
  for (const r of available) if (r.tier != null) tierCounts[`${r.pos}|${r.tier}`] = (tierCounts[`${r.pos}|${r.tier}`] || 0) + 1;
  const fallback = available.slice(0, 5).map(r => {
    const notes = [];
    if (r.tier != null) {
      const left = tierCounts[`${r.pos}|${r.tier}`];
      notes.push(left === 1 ? `LAST in ${r.pos} tier ${r.tier}` : `${r.pos} tier ${r.tier} (${left} left)`);
    }
    if (myNeeds && myNeeds.dedicated[r.pos] > 0) notes.push(`fills open ${r.pos}`);
    else if (myNeeds && myNeeds.flexOpen && ['RB', 'WR', 'TE'].includes(r.pos)) notes.push('fits FLEX');
    const sv = survivalFor(r, available.indexOf(r));
    if (picksUntilMine > 0) notes.push(`~${sv.adj}% survives to your pick`);
    return { rank: r.rank, tier: r.tier, name: r.name, pos: r.pos, team: r.team, vorp: r.vorp, note: notes.join(' · ') };
  });

  const unresolvedCsv = ST.rankings.filter(r => !r.player_id && !r._linkedPick).length;

  // Is the currently displayed recommendation's player already gone?
  let adviceRecTaken = false;
  const rec = ST.adv.latest && ST.adv.latest.parsed && ST.adv.latest.parsed.pick;
  if (rec && rec.name) {
    const rn = normName(rec.name);
    const stillHere = available.some(r => normName(r.name) === rn);
    adviceRecTaken = !stillHere;
  }

  ST.board = {
    status, teams, rounds, totalPicks, pickCount, currentPickNo,
    currentRound, phase, onClockSlot: cur ? cur.slot : null,
    mySlot, myNextPickNo, myPickNos, picksUntilMine, onClock,
    anomalies, unmatchedPicks, unresolvedCsv, adviceRecTaken,
    picks: pickInfo, availableCount: available.length,
    available,                                  // full list; a rankings CSV is a few hundred rows

    rosterBySlot, myNeeds, intervening, candidates, fallback,
    scoring: meta.metadata ? meta.metadata.scoring_type : null,
    degraded: ST.poll.degraded, lastSyncAt: ST.poll.lastOkAt,
  };
  return ST.board;
}

// ------------------------------------------------- 7. Sleeper poller

let pollTick = 0;
function startPolling() {
  if (ST.poll.running) return;
  ST.poll.running = true;
  scheduleNextPoll(0);
  log(`polling ${SLEEPER_BASE} for draft ${ST.session.draft_id} every ${POLL_MS}ms`);
}

function scheduleNextPoll(delay) {
  clearTimeout(ST.poll.timer);
  ST.poll.timer = setTimeout(() => { pollOnce().catch(e => warn('pollOnce escaped:', e.message)); }, delay);
}

async function pollOnce() {
  const id = ST.session.draft_id;
  if (!id) { ST.poll.running = false; return; }
  let delay = POLL_MS;
  try {
    pollTick++;
    const needMeta = !ST.draft.meta || pollTick % 8 === 1 || ST.draft.status !== 'drafting';
    if (needMeta) {
      const meta = await fetchJson(`${SLEEPER_BASE}/draft/${id}`, {}, 10000);
      if (ST.session.draft_id !== id) return scheduleNextPoll(POLL_MS);  // draft switched mid-fetch
      const prevStatus = ST.draft.status;
      ST.draft.meta = meta; ST.draft.status = meta.status;
      if (prevStatus && prevStatus !== meta.status) {
        log(`draft status: ${prevStatus} -> ${meta.status}`);
        if (meta.status === 'complete') broadcast('toast', { kind: 'info', msg: 'Draft complete.' });
        if (prevStatus === 'pre_draft' && meta.status === 'drafting') broadcast('toast', { kind: 'info', msg: 'Draft is live!' });
        computeVorp(); rebuildStaticPrefix();
      } else if (!prevStatus) { computeVorp(); rebuildStaticPrefix(); }
    }
    if (ST.draft.status !== 'pre_draft') {
      const picks = await fetchJson(`${SLEEPER_BASE}/draft/${id}/picks`, {}, 10000);
      if (ST.session.draft_id !== id) return scheduleNextPoll(POLL_MS);  // draft switched mid-fetch
      const changed = picks.length !== ST.draft.picks.length;
      ST.draft.picks = picks;
      if (changed || needMeta) {
        computeBoard();
        broadcast('board', ST.board);
        if (changed) advisorOnBoardChange();
      }
    } else if (pollTick % 4 === 1) {
      computeBoard(); broadcast('board', ST.board);
    }
    // recovered?
    if (ST.poll.failures > 0) { log(`Sleeper poll recovered after ${ST.poll.failures} failure(s)`); broadcast('status', pollStatus()); }
    ST.poll.failures = 0; ST.poll.degraded = false; ST.poll.lastOkAt = Date.now();
    if (ST.draft.status === 'complete') delay = 30000;   // draft over: idle slowly
  } catch (e) {
    ST.poll.failures++;
    ST.poll.degraded = ST.poll.failures >= 2;
    delay = Math.min(15000, 1000 * 2 ** Math.min(ST.poll.failures - 1, 4));   // 1,2,4,8,15s
    warn(`Sleeper poll failure #${ST.poll.failures}: ${e.message}; retry in ${delay}ms`);
    if (ST.board) { ST.board.degraded = ST.poll.degraded; ST.board.lastSyncAt = ST.poll.lastOkAt; }
    broadcast('status', pollStatus());
  }
  scheduleNextPoll(delay);
}

function pollStatus() {
  return { degraded: ST.poll.degraded, failures: ST.poll.failures, lastSyncAt: ST.poll.lastOkAt, replay: REPLAY, mockLLM: MOCK_LLM, hasKey: !!process.env.ANTHROPIC_API_KEY };
}

// --------------------------------- 8. advisor engine (speculative, guarded)

function advisorOnBoardChange() {
  const b = ST.board;
  const turnStarted = b && b.onClock && !ST.adv.prevOnClock;
  if (b) ST.adv.prevOnClock = b.onClock;
  if (!b || b.status !== 'drafting' || !b.mySlot || !ST.rankings.length) return;
  if (b.picksUntilMine === null) return;
  if (turnStarted) {
    ST.adv.turn = { pickNo: b.currentPickNo, startedAt: Date.now(), visibleAt: null, how: null };
    ST.adv.turns = ST.adv.turns || [];
    ST.adv.turns.push(ST.adv.turn);
  } else if (!b.onClock) ST.adv.turn = null;
  const withinWindow = b.picksUntilMine <= SPECULATE_WITHIN;   // 0 = on the clock
  if (!withinWindow) {
    // outside window: cancel any in-flight speculation, keep last completed
    if (ST.adv.inflight) abortInflight('outside-window');
    return;
  }
  const inf = ST.adv.inflight;
  const latest = ST.adv.latest;
  if (latest && latest.basedOn === b.pickCount) {
    // fully current recommendation already exists
    if (inf && inf.basedOn !== b.pickCount) abortInflight('superseded-by-latest');
    if (b.onClock) { broadcast('advice', adviceEvent(latest)); markVisible('precomputed'); }
    return;
  }
  if (inf) {
    if (inf.basedOn === b.pickCount) return;                   // current request already running
    if (b.onClock && inf.buffer) {
      // My turn started while a speculative request is mid-stream: KEEP it
      // (tagged "as of pick N"), refresh on the current board once it lands.
      inf.refreshAfter = true;
      if (latest) { broadcast('advice', adviceEvent(latest)); markVisible('stale-precomputed'); }
      else if (inf.pickLine) markVisible('stale-streaming');
      return;
    }
    abortInflight('superseded');
  }
  // instant visibility with the last completed rec (tagged stale) while fresh one runs
  if (b.onClock && latest) { broadcast('advice', adviceEvent(latest)); markVisible('stale-precomputed'); }
  startAdvice(b);
}

function markVisible(how) {
  const t = ST.adv.turn;
  if (t && t.visibleAt == null) { t.visibleAt = Date.now(); t.how = how; t.visibleMs = t.visibleAt - t.startedAt; }
}

function abortInflight(reason) {
  const inf = ST.adv.inflight;
  if (!inf) return;
  inf.aborted = reason;
  try { inf.controller.abort(); } catch { /* ignore */ }
  ST.adv.inflight = null;
  const entry = ST.adv.latency.find(l => l.seq === inf.seq);
  if (entry) { entry.aborted = reason; entry.total = Date.now() - entry.startedAt; }
}

function adviceEvent(rec) {
  return {
    seq: rec.seq, basedOn: rec.basedOn, phase: 'done', stale: rec.basedOn !== (ST.board ? ST.board.pickCount : rec.basedOn),
    text: rec.text, parsed: rec.parsed, pickLine: rec.pickLine, mock: rec.mock || false,
    timings: rec.timings,
  };
}

function startAdvice(board) {
  if (!process.env.ANTHROPIC_API_KEY && !MOCK_LLM) {
    broadcast('advice', { phase: 'error', basedOn: board.pickCount, error: 'ANTHROPIC_API_KEY not set — using fallback board', seq: ++ST.adv.seq });
    if (board.onClock) markVisible('fallback-no-key');
    return;
  }
  const seq = ++ST.adv.seq;
  const controller = new AbortController();
  const inf = {
    seq, basedOn: board.pickCount, controller, startedAt: Date.now(),
    buffer: '', pickLine: null, aborted: null, onClockAtStart: board.onClock,
  };
  ST.adv.inflight = inf;
  const lat = { seq, basedOn: inf.basedOn, startedAt: inf.startedAt, ttfe: null, ttft: null, total: null, aborted: null, error: null, cacheRead: null, cacheWrite: null, inputTokens: null, outputTokens: null, mock: MOCK_LLM, speculative: !board.onClock };
  ST.adv.latency.push(lat);
  if (ST.adv.latency.length > 300) ST.adv.latency.splice(0, ST.adv.latency.length - 300);
  broadcast('advice', { phase: 'reasoning', seq, basedOn: inf.basedOn, speculative: !board.onClock });

  const handlers = {
    onEvent() { if (lat.ttfe === null) lat.ttfe = Date.now() - inf.startedAt; },
    onText(delta) {
      if (inf.aborted) return;
      if (lat.ttft === null) { lat.ttft = Date.now() - inf.startedAt; }
      inf.buffer += delta;
      if (!inf.pickLine) {
        const m = inf.buffer.match(/PICK:\s*([^\n]+)\n/);
        if (m) {
          inf.pickLine = m[1].trim();
          broadcast('advice', { phase: 'streaming', seq, basedOn: inf.basedOn, pickLine: inf.pickLine });
          if (ST.board && ST.board.onClock) markVisible('streaming');
        }
      }
      broadcast('advice_delta', { seq, basedOn: inf.basedOn, delta });
    },
    onUsage(u) {
      if (!u) return;
      if (u.cache_read_input_tokens != null) lat.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) lat.cacheWrite = u.cache_creation_input_tokens;
      if (u.input_tokens != null) lat.inputTokens = u.input_tokens;
      if (u.output_tokens != null) lat.outputTokens = u.output_tokens;
    },
  };

  // Watchdogs: a hung connection must never leave the UI stuck on "reasoning".
  // No first event within 30s, or no completion within ADVICE_TIMEOUT_MS,
  // aborts through the ERROR path (fallback + on-clock retry), not silently.
  const firstEventTimer = setTimeout(() => {
    if (!inf.aborted && lat.ttfe === null) { inf.timedOut = 'no-first-event'; controller.abort(); }
  }, 30000);
  const totalTimer = setTimeout(() => {
    if (!inf.aborted) { inf.timedOut = 'total-timeout'; controller.abort(); }
  }, Number(process.env.ADVICE_TIMEOUT_MS || 150000));
  const clearTimers = () => { clearTimeout(firstEventTimer); clearTimeout(totalTimer); };

  const run = MOCK_LLM ? mockAdvise(board, controller.signal, handlers) : callAnthropic(board, controller.signal, handlers);
  run.then((result) => {
    clearTimers();
    if (inf.aborted) return;
    ST.adv.inflight = null;
    lat.total = Date.now() - inf.startedAt;
    const parsed = parseAdviceJson(inf.buffer);
    const rec = {
      seq, basedOn: inf.basedOn, text: inf.buffer, parsed, pickLine: inf.pickLine,
      mock: MOCK_LLM, completedAt: Date.now(),
      timings: { ttft: lat.ttft, total: lat.total, cacheRead: lat.cacheRead, stopReason: result && result.stopReason },
    };
    if (result && result.stopReason === 'refusal') {
      lat.error = 'refusal';
      broadcast('advice', { phase: 'error', seq, basedOn: inf.basedOn, error: 'model declined — fallback board is live' });
      return;
    }
    ST.adv.latest = rec;
    broadcast('advice', adviceEvent(rec));
    if (ST.board && ST.board.onClock) markVisible('completed');
    log(`advice #${seq} done (basedOn=${rec.basedOn}, ttft=${lat.ttft}ms, total=${lat.total}ms, cacheRead=${lat.cacheRead})`);
    // a kept-stale stream finished while on the clock: refresh on the current board
    const b = ST.board;
    if (inf.refreshAfter && b && b.onClock && b.status === 'drafting' && b.pickCount !== inf.basedOn && !ST.adv.inflight) {
      startAdvice(b);
    }
  }).catch((e) => {
    clearTimers();
    if (inf.aborted) return;               // deliberate aborts are expected, not errors
    ST.adv.inflight = null;
    lat.total = Date.now() - inf.startedAt;
    lat.error = inf.timedOut ? `timeout (${inf.timedOut})` : e.message;
    if (inf.timedOut) e = new Error(lat.error);
    warn(`advice #${seq} failed: ${e.message}`);
    broadcast('advice', { phase: 'error', seq, basedOn: inf.basedOn, error: `advisor error (${e.message}) — fallback board is live` });
    if (ST.board && ST.board.onClock) markVisible('fallback-after-error');
    // one automatic retry if we're actually on the clock and this wasn't a kill-switch test
    const b = ST.board;
    if (b && b.onClock && b.pickCount === inf.basedOn && !ST.adv.retryPending) {
      ST.adv.retryPending = true;
      setTimeout(() => { ST.adv.retryPending = false; const bb = ST.board; if (bb && bb.onClock && !ST.adv.inflight && !(ST.adv.latest && ST.adv.latest.basedOn === bb.pickCount)) startAdvice(bb); }, 2500);
    }
  });
}

function parseAdviceJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[1] || m[0]); } catch { return null; }
}

// ---------------------- 9. Anthropic streaming client (raw fetch) + mock

function rebuildStaticPrefix() {
  if (!ST.rankings.length) { ST.staticPrefix = null; return; }
  const meta = ST.draft.meta;
  const s = (meta && meta.settings) || {};
  const slots = draftSlots(meta);
  const scoring = meta && meta.metadata ? meta.metadata.scoring_type : 'unknown';
  const lines = ST.rankings.map(r => {
    const f = [r.rank, r.tier != null ? r.tier : '', r.name, r.pos, r.team, r.bye != null ? r.bye : '', r.proj != null ? r.proj : '', r.vorp != null ? r.vorp : '', r.notes || ''];
    return f.join('|');
  });
  ST.staticPrefix = [
    'You are the draft-room analyst inside a live fantasy football draft tool. You are called once per recommendation, dozens of times across the draft, always with the same structure: this static briefing, then a user message with the precomputed board state. Recommend exactly ONE pick.',
    '',
    '## League',
    `Teams: ${s.teams || '?'} · Rounds: ${s.rounds || '?'} · Scoring: ${scoring}`,
    `Starting slots: QB ${slots.QB}, RB ${slots.RB}, WR ${slots.WR}, TE ${slots.TE}, FLEX ${slots.FLEX}${slots.SFLEX ? `, SUPERFLEX ${slots.SFLEX}` : ''}, K ${slots.K}, DEF ${slots.DEF}, Bench ${slots.BN}`,
    '',
    '## Decision framework by phase (the user message states the current phase)',
    '- EARLY (rounds 1-3): best value wins; roster composition is a light tiebreak. Reaching more than ~5 spots past rank needs a strong reason. Anchor RB/WR tiers matter most; in PPR lean receptions.',
    '- MIDDLE: tier cliffs and positional runs dominate. The LAST player of a tier with low adjusted survival beats a marginally higher-ranked player from a deep tier. React to runs one pick early, not one late.',
    '- LATE (final 4 rounds): ceiling over floor. Prioritize: handcuffs to YOUR OWN early RBs, cheap QB/pass-catcher stacks with players already on your roster, league-winner upside bench picks. Take K and DEF in the last 2 rounds only, one each, prioritizing good week-1 matchups.',
    '',
    '## How to read the numbers (all precomputed — trust them, do not recalculate)',
    '- survival base% = chance the player survives to your next pick from rank pressure alone; adj% additionally accounts for the actual roster needs of the specific teams picking before you; [n] = how many of those teams are hungry for that position. Low adj% on a player you want means take him NOW; high adj% means you can defer and gain a pick.',
    '- VORP = projected points above the replacement-level starter at that position for this league. Use it to compare value ACROSS positions; rank compares within the consensus.',
    '- Roster-gap listings for other teams tell you where runs will come from.',
    '',
    '## Hard rules',
    '- Recommend ONLY players from the CANDIDATES list. Never invent players, stats, or news.',
    '- Bye weeks are a minor tiebreak, never a primary reason before the late rounds.',
    '- Do not restate this briefing or the board; output only the format below.',
    '',
    '## Output format (STRICT — parsed by machine)',
    'First line, immediately: `PICK: <Player Name> (<POS>, <TEAM>)`',
    'Then a fenced ```json block exactly matching:',
    '{"pick":{"name":"","position":"","team":"","why":"<=30 words"},"alternatives":[{"name":"","position":"","why":"<=15 words"},{"name":"","position":"","why":"<=15 words"}],"tier_alert":<string or null>,"run_risk":<string or null>,"board_read":"<=40 words"}',
    'Use the exact player names as they appear in CANDIDATES. alternatives = the best two different-strategy fallbacks if your pick is sniped. tier_alert = a tier about to close that affects THIS pick, else null. run_risk = a run likely before your next turn, else null. No text after the JSON block.',
    '',
    '## Your full rankings (rank|tier|name|pos|team|bye|proj|vorp|notes)',
    ...lines,
  ].join('\n');
}

function buildDynamicMessage(board) {
  const b = board;
  const lines = [];
  lines.push(`# Board state as of pick ${b.pickCount} (${b.onClock ? 'YOU ARE ON THE CLOCK' : `you pick in ${b.picksUntilMine} pick(s)`})`);
  lines.push(`Current: pick #${b.currentPickNo} overall, round ${b.currentRound} of ${b.rounds} (${b.phase} phase). Your slot: ${b.mySlot}. Your next picks: ${b.myPickNos.map(n => '#' + n).join(', ')}.`);
  lines.push('');
  const my = b.rosterBySlot[b.mySlot];
  lines.push(`## Your roster (${my.players.length} picks)`);
  lines.push(my.players.length ? my.players.map(p => `R${p.round} ${p.name} (${p.pos} ${p.team || ''})`).join('; ') : '(empty)');
  const d = b.myNeeds.dedicated;
  lines.push(`Open starters: ${Object.entries(d).filter(([, v]) => v > 0).map(([k, v]) => `${k}x${v}`).join(', ') || 'none'}${b.myNeeds.flexOpen ? `, FLEXx${b.myNeeds.flexOpen}` : ''}${b.myNeeds.sflexOpen ? `, SFLEXx${b.myNeeds.sflexOpen}` : ''}`);
  lines.push('');
  const recent = b.picks.slice(-12);
  lines.push('## Last picks');
  lines.push(recent.map(p => `#${p.pick_no} ${p.name} (${p.pos})${p.mine ? ' [YOU]' : ''}`).join('; ') || '(none)');
  lines.push('');
  if (b.intervening.length) {
    lines.push(`## Teams picking before your next turn (${b.intervening.length})`);
    for (const t of b.intervening) lines.push(`pick #${t.pick_no} slot ${t.slot}: likely targets ${t.targets.map(x => `${x.pos}(${Math.round(x.w * 100)}%)`).join(', ') || 'any'}`);
    lines.push('');
  }
  lines.push('## CANDIDATES (rank | tier | name | pos team | bye | proj | vorp | survival base%->adj% [n hungry teams] | notes)');
  for (const c of b.candidates) {
    lines.push(`${c.rank} | ${c.tier != null ? 'T' + c.tier : '-'} | ${c.name} | ${c.pos} ${c.team} | ${c.bye != null ? c.bye : '-'} | ${c.proj != null ? c.proj : '-'} | ${c.vorp != null ? c.vorp : '-'} | ${c.survival.base}%->${c.survival.adj}% [${c.survival.hungry}] | ${c.notes || ''}`);
  }
  const notes = Object.entries(ST.session.notes || {}).filter(([, v]) => v);
  if (notes.length) {
    lines.push('');
    lines.push('## My manual notes');
    for (const [pid, note] of notes) { const pl = ST.players[pid]; lines.push(`${pl ? pl.n : pid}: ${note}`); }
  }
  if (b.anomalies.length) { lines.push(''); lines.push(`## Warnings: ${b.anomalies.join(' | ')}`); }
  lines.push('');
  lines.push('Give your recommendation now in the strict output format.');
  return lines.join('\n');
}

// Write the prompt-cache entry before the draft heats up so the first real
// advice call reads the cache instead of writing it. max_tokens: 0 is the
// documented pre-warm shape (no output billed). Failures are non-fatal.
let prewarmedPrefix = null;
async function prewarmCache() {
  if (MOCK_LLM || !process.env.ANTHROPIC_API_KEY) return;
  if (!ST.staticPrefix || ST.staticPrefix === prewarmedPrefix) return;
  prewarmedPrefix = ST.staticPrefix;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 0,
        system: [{ type: 'text', text: ST.staticPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: 'warmup' }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.usage) log(`prompt cache prewarmed: wrote ${j.usage.cache_creation_input_tokens || 0}, read ${j.usage.cache_read_input_tokens || 0} tokens`);
    else warn(`cache prewarm skipped (HTTP ${r.status}${j && j.error ? ': ' + j.error.message : ''})`);
  } catch (e) { warn('cache prewarm failed (non-fatal):', e.message); }
}

async function callAnthropic(board, signal, h) {
  if (ST.adv.killLLM) throw new Error('simulated API outage (debug kill switch)');
  if (!ST.staticPrefix) rebuildStaticPrefix();
  const body = {
    model: MODEL,
    max_tokens: 12000,
    stream: true,
    fallbacks: 'default',
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: ST.staticPrefix, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: buildDynamicMessage(board) }],
  };
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  let stopReason = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let data = null;
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      h.onEvent(ev);
      switch (ev.type) {
        case 'message_start': if (ev.message && ev.message.usage) h.onUsage(ev.message.usage); break;
        case 'content_block_delta':
          if (ev.delta && ev.delta.type === 'text_delta') h.onText(ev.delta.text);
          break;
        case 'message_delta':
          if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.usage) h.onUsage(ev.usage);
          break;
        case 'error':
          throw new Error(`stream error: ${ev.error ? ev.error.message : 'unknown'}`);
      }
    }
  }
  return { stopReason };
}

// Mock LLM: exercises the exact same pipeline (thinking delay, token trickle,
// abort handling) without an API key. Deterministic choice: best adjusted
// (vorp/rank) candidate weighted by tier urgency.
const MOCK_THINK_MS = Number(process.env.MOCK_THINK_MS || 4000);
async function mockAdvise(board, signal, h) {
  if (ST.adv.killLLM) throw new Error('simulated API outage (debug kill switch)');
  const sleep = (ms) => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  });
  h.onEvent({ type: 'message_start' });
  await sleep(MOCK_THINK_MS * (0.5 + Math.random()));
  const cands = board.candidates.length ? board.candidates : board.fallback;
  const scored = cands.map(c => ({ c, s: (200 - c.rank) + (c.vorp || 0) * 0.5 + (c.survival && c.survival.adj < 40 ? 25 : 0) + ((board.myNeeds && board.myNeeds.dedicated[c.pos] > 0) ? 15 : 0) - ((c.pos === 'K' || c.pos === 'DEF') && board.phase !== 'late' ? 500 : 0) }));
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0].c, alt1 = (scored[1] || scored[0]).c, alt2 = (scored[2] || scored[0]).c;
  const payload = {
    pick: { name: top.name, position: top.pos, team: top.team, why: `Best value on the board at rank ${top.rank}${top.survival ? ` with ${top.survival.adj}% survival` : ''} (mock reasoning).` },
    alternatives: [
      { name: alt1.name, position: alt1.pos, why: `Rank ${alt1.rank} alternative.` },
      { name: alt2.name, position: alt2.pos, why: `Rank ${alt2.rank} alternative.` },
    ],
    tier_alert: top.tier != null ? `Tier ${top.tier} ${top.pos} thinning out` : null,
    run_risk: null,
    board_read: `Mock advisor: deterministic scoring over ${cands.length} candidates at pick ${board.currentPickNo}.`,
  };
  const full = `PICK: ${top.name} (${top.pos}, ${top.team})\n\`\`\`json\n${JSON.stringify(payload, null, 1)}\n\`\`\`\n`;
  for (let i = 0; i < full.length; i += 12) {
    await sleep(25);
    h.onText(full.slice(i, i + 12));
  }
  return { stopReason: 'end_turn' };
}

// -------------------------------------- 10. SSE hub + HTTP server / routes

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}

function broadcast(event, data) {
  for (const res of ST.sse) sseWrite(res, event, data);
}

setInterval(() => broadcast('ping', { t: Date.now() }), 15000).unref();

function snapshot() {
  return {
    board: ST.board,
    session: { draft_id: ST.session.draft_id, my_slot: ST.session.my_slot, manual: ST.session.manual, notes: ST.session.notes },
    rankingsMeta: ST.rankingsMeta,
    rankings: ST.rankings,
    advice: ST.adv.latest ? adviceEvent(ST.adv.latest) : null,
    adviceInflight: ST.adv.inflight ? { seq: ST.adv.inflight.seq, basedOn: ST.adv.inflight.basedOn, buffer: ST.adv.inflight.buffer, pickLine: ST.adv.inflight.pickLine } : null,
    status: pollStatus(),
  };
}

function latencySummary() {
  const done = ST.adv.latency.filter(l => l.total != null && !l.aborted && !l.error);
  const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const ttfts = done.map(l => l.ttft).filter(x => x != null);
  const totals = done.map(l => l.total);
  return {
    requests: ST.adv.latency.length, completed: done.length,
    aborted: ST.adv.latency.filter(l => l.aborted).length,
    errors: ST.adv.latency.filter(l => l.error).length,
    ttft_p50: pct(ttfts, 0.5), ttft_p95: pct(ttfts, 0.95),
    total_p50: pct(totals, 0.5), total_p95: pct(totals, 0.95),
    cacheReads: done.filter(l => l.cacheRead > 0).length,
    turns: (ST.adv.turns || []).map(t => ({ pickNo: t.pickNo, visibleMs: t.visibleMs != null ? t.visibleMs : null, how: t.how })),
    log: ST.adv.latency.slice(-100),
  };
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      ST.sse.add(res);
      sseWrite(res, 'snapshot', snapshot());
      req.on('close', () => ST.sse.delete(res));
      req.on('error', () => ST.sse.delete(res));
      res.on('error', () => ST.sse.delete(res));
      return;
    }

    if (p === '/api/state') return json(res, 200, snapshot());
    if (p === '/api/latency') return json(res, 200, latencySummary());

    if (p === '/api/players') {
      const body = JSON.stringify(ST.players);
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}), 'cache-control': 'max-age=3600' });
      return res.end(gz ? zlib.gzipSync(body) : body);
    }

    if (p === '/api/rankings' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const meta = importRankings(body.csvText, body.name);
      computeBoard();
      broadcast('rankings', { meta, rankings: ST.rankings });
      broadcast('board', ST.board);
      prewarmCache();                       // fire-and-forget
      return json(res, 200, meta);
    }

    if (p === '/api/draft' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const draftId = String(body.draft_id || '').trim();
      if (!/^\d{5,25}$/.test(draftId)) return json(res, 400, { error: 'draft_id must be the numeric Sleeper draft id' });
      let meta;
      try {
        meta = await fetchJson(`${SLEEPER_BASE}/draft/${draftId}`, {}, 10000);
      } catch (e) { return json(res, 502, { error: `could not fetch draft: ${e.message}` }); }
      // validated: now commit the session change
      ST.session.draft_id = draftId;
      ST.session.my_slot = Number(body.my_slot) || null;
      saveJson('session.json', ST.session);
      ST.draft = { meta, picks: [], anomalies: [], status: meta.status };
      ST.adv.latest = null; ST.adv.prevOnClock = false; if (ST.adv.inflight) abortInflight('draft-changed');
      computeVorp(); rebuildStaticPrefix(); computeBoard();
      prewarmCache();                       // fire-and-forget
      startPolling();
      broadcast('board', ST.board);
      broadcast('status', pollStatus());
      return json(res, 200, { ok: true, status: ST.draft.status, meta: { teams: ST.draft.meta.settings.teams, rounds: ST.draft.meta.settings.rounds, type: ST.draft.meta.type } });
    }

    if (p === '/api/slot' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      ST.session.my_slot = Number(body.my_slot) || null;
      saveJson('session.json', ST.session);
      computeBoard(); broadcast('board', ST.board);
      advisorOnBoardChange();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/mark' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.player_id) return json(res, 400, { error: 'player_id required' });
      if (body.drafted) ST.session.manual[body.player_id] = true;
      else delete ST.session.manual[body.player_id];
      saveJson('session.json', ST.session);
      computeBoard(); broadcast('board', ST.board);
      broadcast('session', { draft_id: ST.session.draft_id, my_slot: ST.session.my_slot, manual: ST.session.manual, notes: ST.session.notes });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/note' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.player_id) return json(res, 400, { error: 'player_id required' });
      if (body.note) ST.session.notes[body.player_id] = String(body.note).slice(0, 300);
      else delete ST.session.notes[body.player_id];
      saveJson('session.json', ST.session);
      broadcast('session', { draft_id: ST.session.draft_id, my_slot: ST.session.my_slot, manual: ST.session.manual, notes: ST.session.notes });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/advise/refresh' && req.method === 'POST') {
      if (ST.adv.inflight) abortInflight('manual-refresh');
      ST.adv.latest = null;
      if (ST.board) startAdvice(ST.board);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      ST.session = { draft_id: null, my_slot: null, manual: {}, notes: {} };
      saveJson('session.json', ST.session);
      ST.draft = { meta: null, picks: [], anomalies: [], status: null };
      ST.board = null; ST.adv.latest = null; ST.adv.prevOnClock = false; ST.adv.turn = null;
      if (ST.adv.inflight) abortInflight('reset');
      clearTimeout(ST.poll.timer); ST.poll.running = false; ST.poll.failures = 0; ST.poll.degraded = false;
      broadcast('board', null); broadcast('status', pollStatus());
      return json(res, 200, { ok: true });
    }

    // debug endpoints — replay/test mode only
    if (p.startsWith('/api/debug/') && (REPLAY || MOCK_LLM)) {
      if (p === '/api/debug/kill-llm' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        ST.adv.killLLM = !!body.on;
        if (ST.adv.killLLM && ST.adv.inflight) abortInflight('killed');
        log(`debug: LLM kill switch ${ST.adv.killLLM ? 'ON' : 'OFF'}`);
        return json(res, 200, { killLLM: ST.adv.killLLM });
      }
      if (p === '/api/debug/stats') {
        return json(res, 200, { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, sseClients: ST.sse.size, uptime: process.uptime() });
      }
      if (p === '/api/debug/prompt') {
        return json(res, 200, { staticPrefix: ST.staticPrefix, dynamic: ST.board ? buildDynamicMessage(ST.board) : null });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    warn('request error:', req.url, e.message);
    try { json(res, 500, { error: e.message }); } catch { /* headers sent */ }
  }
});

process.on('uncaughtException', (e) => { warn('uncaughtException:', e.stack || e.message); });
process.on('unhandledRejection', (e) => { warn('unhandledRejection:', e && (e.stack || e.message || e)); });

(async () => {
  await loadPlayers();
  loadRankingsFromDisk();
  server.listen(PORT, () => {
    log(`Draft War Room on http://localhost:${PORT}${REPLAY ? ` [REPLAY via :${REPLAY_PORT}]` : ''}${MOCK_LLM ? ' [MOCK_LLM]' : ''} effort=${EFFORT}`);
    if (!process.env.ANTHROPIC_API_KEY && !MOCK_LLM) warn('ANTHROPIC_API_KEY is not set — advisor disabled, fallback board only');
    if (ST.session.draft_id) {
      log(`resuming draft ${ST.session.draft_id} (slot ${ST.session.my_slot}) from session.json`);
      startPolling();
    }
  });
})();
