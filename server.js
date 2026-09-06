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
 *   7b. ESPN adapter + poller (translates ESPN's league doc into the Sleeper draft shape)
 *   8. advisor engine (speculative requests, stale guards, latency log)
 *   9. Anthropic streaming client (raw fetch SSE) + mock LLM
 *  10. SSE hub + HTTP server / routes
 *  11. season poller (league/rosters/matchups/projections, slow-cadence, never dies)
 *  12. season math (pure: optimal lineup, values, waivers, trades, power)
 *  13. season prompts (briefing + per-kind builders for the external advisor)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- 1. config

// Profiles: one server per league. `node server.js --profile bros --port 8485`
// (or PROFILE/PORT env) keeps that league's session/rankings/advice under
// data/profiles/<name>/ while the big player caches stay shared in data/.
const ARGV = process.argv.slice(2);
const argOf = (k) => { const i = ARGV.indexOf(k); return i >= 0 ? ARGV[i + 1] : null; };
const PROFILE = String(argOf('--profile') || process.env.PROFILE || '').replace(/[^A-Za-z0-9_-]/g, '') || null;
const PORT = Number(argOf('--port') || process.env.PORT || 8484);
const REPLAY = process.env.REPLAY === '1' || process.argv.includes('--replay');
const REPLAY_PORT = Number(process.env.REPLAY_PORT || 3999);
const MOCK_LLM = process.env.MOCK_LLM === '1';
// Advisor source: 'api' (Anthropic), 'mock' (testing), or 'external' — a Claude
// Code session (or manual paste) generates advice; the server serves the prompt
// context at GET /api/advisor/context and accepts POST /api/advisor/submit.
// External is the default whenever no API key is set.
const ADVISOR = process.env.ADVISOR ||
  (MOCK_LLM ? 'mock' : (process.env.ANTHROPIC_API_KEY ? 'api' : 'external'));
const EFFORT = process.env.EFFORT || 'high';           // low|medium|high|xhigh|max
const SPECULATE_WITHIN = Number(process.env.SPECULATE_WITHIN || 2);
const POLL_MS = Number(process.env.POLL_MS || (REPLAY ? 1000 : 2000));
const SEASON_POLL_MS = Number(process.env.SEASON_POLL_MS || 60000);
const SEASON_FIXTURE = process.env.SEASON_FIXTURE === '1';   // load data/season-fixture.json, no season polling
const PLAYERS_REFRESH_MS = Number(process.env.PLAYERS_REFRESH_MS || 4 * 3600 * 1000);
const SHARED_DIR = path.join(__dirname, 'data');                                   // player caches (shared by every profile)
const DATA_DIR = PROFILE ? path.join(SHARED_DIR, 'profiles', PROFILE) : SHARED_DIR;   // this league's state
const SLEEPER_REAL = 'https://api.sleeper.app/v1';
const SLEEPER_BASE = REPLAY ? `http://127.0.0.1:${REPLAY_PORT}/v1` : SLEEPER_REAL;
// Undocumented Sleeper host for projections/stats (different host from the v1 API).
const SLEEPER_STATS = 'https://api.sleeper.com';
// ESPN fantasy (unofficial v3 API). Private leagues need the espn_s2 + SWID cookies.
const ESPN_BASE = process.env.ESPN_BASE || 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';   // env override = tools/espn-mock.js
const ESPN_POLL_MS = Number(process.env.ESPN_POLL_MS || (REPLAY ? 1000 : 3000));
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

// Default dir = the ACTIVE league's dir (players caches pass SHARED_DIR explicitly).
function loadJson(name, fallback, dir = (ST.ctx ? ST.ctx.dir : DATA_DIR)) {
  try {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { warn(`corrupt ${name}, using fallback:`, e.message); return fallback; }
}

const saveTimers = {};
function saveJson(name, obj, dir = (ST.ctx ? ST.ctx.dir : DATA_DIR)) {          // debounced atomic write
  const key = dir + '|' + name;                       // dir captured NOW (the active league may change before the timer fires)
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => {
    try {
      const p = path.join(dir, name);
      fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
      fs.renameSync(p + '.tmp', p);
    } catch (e) { warn(`save ${name} failed:`, e.message); }
  }, 250);
}

// ------------------------------------------------ 2b. leagues (multi-league state)
//
// One server holds MANY leagues at once. Everything league-specific (session,
// draft, board, advisor state, season state, rankings, SSE viewers) lives in a
// league CONTEXT; `ST.<key>` is an accessor onto the ACTIVE context, so the
// thousands of existing `ST.draft` / `ST.session` references work unchanged.
// Rules that keep this safe (Node is single-threaded):
//   - every request handler and every poll loop calls activate(ctx) at its top
//     and again after EVERY await (another league may have run in between);
//   - timer/promise callbacks capture their ctx and activate it first;
//   - withCtx(ctx, fn) runs a SYNC fn against another league and restores.
// Each league persists under its own dir: the original league keeps data/ so
// existing installs upgrade in place; new ones live in data/leagues/<id>/.

const CTX_KEYS = ['session', 'draft', 'board', 'poll', 'adv', 'season', 'sse', 'staticPrefix', 'rankings', 'rankingsMeta', 'prewarmedPrefix'];
const ST = {
  players: {},            // id -> {n, p, t, sr, inj, dpo}   (shared by all leagues)
  nameIndex: null,        // built after players load
  playersFetchedAt: 0,    // for in-season staleness labeling + 4h refresh
  ctx: null,              // the ACTIVE league context (see accessors below)
  leagues: new Map(),     // id -> ctx
  registry: null,         // {leagues: [{id, name, dir}], active}
};
for (const k of CTX_KEYS) Object.defineProperty(ST, k, { enumerable: true, get() { return ST.ctx[k]; }, set(v) { ST.ctx[k] = v; } });
function activate(ctx) { ST.ctx = ctx; return ctx; }
function withCtx(ctx, fn) { const prev = ST.ctx; ST.ctx = ctx; try { return fn(); } finally { ST.ctx = prev; } }

function newCtx(id, dir, name) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const session = loadJson('session.json', { draft_id: null, my_slot: null, manual: {}, notes: {} }, dir);
  // session.json v2: league identity rides alongside the draft fields.
  if (session.league_id === undefined) session.league_id = null;
  if (session.my_roster_id === undefined) session.my_roster_id = null;
  if (session.my_user_id === undefined) session.my_user_id = null;
  // session.json v3: draft source ('sleeper' | 'espn') + ESPN connection details.
  // ESPN cookies live ONLY here (data/ is gitignored) and in env; never broadcast.
  if (!session.source) session.source = 'sleeper';
  if (!session.espn) session.espn = { league_id: null, season: null, team_id: null, espn_s2: null, swid: null };
  if (!session.manual) session.manual = {};
  if (!session.notes) session.notes = {};
  return {
    id, dir, name: name || null,
    session,
    rankings: [],           // resolved CSV rows
    rankingsMeta: null,     // {name, importedAt, matchStats}
    draft: { meta: null, picks: [], anomalies: [], status: null },
    board: null,            // computed
    poll: { failures: 0, degraded: false, lastOkAt: 0, timer: null, running: false },
    adv: {                  // advisor engine state
      seq: 0, inflight: null, latest: null, latency: [],
      killLLM: false,       // debug: simulate Anthropic outage
      season: { pending: {}, latest: {}, history: [] },   // kind -> {since, params} / kind -> rec / past advice lines
    },
    season: {               // in-season subsystem (parallel to draft; own poll loop)
      league: null, users: [], rosters: [],
      nfl: { week: null, season: null, season_type: null },
      matchups: null, transactions: [],
      proj: { week: null, byId: {}, fetchedAt: 0, degraded: true, count: 0 },
      stats: { byWeek: {} },              // completed weeks -> {pid: pts}
      liveStats: { week: null, byId: {}, fetchedAt: 0 },   // current week, refreshed fast during games
      schedule: { byWeek: {}, fetchedAt: 0 },              // byWeek[w][TEAM] = {status, date, opp}
      leagueSchedule: {},                 // league pairings: week -> [{roster_id, matchup_id}]
      matchupHistory: {},                 // completed weeks -> matchups array (for recaps)
      injSeen: {},                        // my players' last-seen injury status (alert diffing)
      alerts: [],                         // [{pid, name, kind, from, to, at, week}]
      odds: null,                         // cached playoff-odds sim {key, pct}
      trending: { add: [], drop: [], fetchedAt: 0 },
      rev: 0,                             // bumped on any data change; advice freshness token
      sig: {},                            // change-detection signatures per dataset
      poll: { failures: 0, degraded: false, lastOkAt: 0, timer: null, running: false, tick: 0 },
      view: null,                         // computeSeason() output
    },
    sse: new Set(),         // SSE viewers of THIS league
    staticPrefix: null,     // cached-prompt block (byte-stable)
    prewarmedPrefix: null,
  };
}

// Registry: data/leagues.json. The first/original league is 'main' and owns data/ itself.
function loadRegistry() {
  const reg = loadJson('leagues.json', null, DATA_DIR) || { leagues: [{ id: 'main', name: null, dir: '.' }], active: 'main' };
  if (!reg.leagues.some(l => l.id === 'main')) reg.leagues.unshift({ id: 'main', name: null, dir: '.' });
  ST.registry = reg;
  for (const l of reg.leagues) {
    if (ST.leagues.has(l.id)) continue;
    ST.leagues.set(l.id, newCtx(l.id, path.resolve(DATA_DIR, l.dir), l.name));
  }
  if (!ST.leagues.has(reg.active)) reg.active = 'main';
  activate(ST.leagues.get(reg.active));
}
function saveRegistry() {                 // rare + important: written synchronously, not debounced
  ST.registry.leagues = [...ST.leagues.values()].map(c => ({ id: c.id, name: c.name, dir: path.relative(DATA_DIR, c.dir) || '.' }));
  try {
    const p = path.join(DATA_DIR, 'leagues.json');
    fs.writeFileSync(p + '.tmp', JSON.stringify(ST.registry));
    fs.renameSync(p + '.tmp', p);
  } catch (e) { warn('save leagues.json failed:', e.message); }
}
function leagueName(ctx) {
  if (ctx.name) return ctx.name;
  const s = ctx.session || {};
  if (ctx.season && ctx.season.league && ctx.season.league.name) return ctx.season.league.name;
  if (ctx.draft && ctx.draft.meta && ctx.draft.meta.metadata && ctx.draft.meta.metadata.name) return ctx.draft.meta.metadata.name;
  if (s.source === 'espn' && s.espn && s.espn.league_id) return `ESPN ${s.espn.league_id}`;
  if (s.draft_id) return `Sleeper draft …${String(s.draft_id).slice(-6)}`;
  if (s.league_id) return `Sleeper league …${String(s.league_id).slice(-6)}`;
  return ctx.id === 'main' ? 'Main league' : 'New league';
}
function leagueView(ctx) {
  return withCtx(ctx, () => ({
    id: ctx.id, name: leagueName(ctx), custom: !!ctx.name,
    source: ctx.session.source || 'sleeper',
    draftStatus: ctx.draft.status, draftId: ctx.session.draft_id, mySlot: ctx.session.my_slot,
    seasonLeague: ctx.season.league ? ctx.season.league.name : null, seasonConnected: !!ctx.session.league_id,
    needAdvice: externalNeedAdvice(), seasonPending: Object.keys(ctx.adv.season.pending || {}),
    picksUntilMine: ctx.board ? ctx.board.picksUntilMine : null, onClock: !!(ctx.board && ctx.board.onClock),
    degraded: !!ctx.poll.degraded, viewers: ctx.sse.size,
    active: ST.registry && ST.registry.active === ctx.id,
  }));
}
function leaguesView() { return { leagues: [...ST.leagues.values()].map(leagueView), active: ST.registry.active }; }
function createLeague(name) {
  const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const ctx = newCtx(id, path.join(DATA_DIR, 'leagues', id), name || null);
  ST.leagues.set(id, ctx);
  saveRegistry();
  return ctx;
}
function removeLeague(id) {
  const ctx = ST.leagues.get(id);
  if (!ctx || id === 'main') return false;
  withCtx(ctx, () => {
    clearTimeout(ctx.poll.timer); ctx.poll.running = false;
    clearTimeout(ctx.season.poll.timer); ctx.season.poll.running = false;
    if (ctx.adv.inflight) abortInflight('league-removed');
    for (const res of ctx.sse) { sseWrite(res, 'league_removed', { id }); try { res.end(); } catch { /* gone */ } }
  });
  ST.leagues.delete(id);
  if (ST.registry.active === id) ST.registry.active = 'main';
  if (ST.ctx === ctx) activate(ST.leagues.get('main'));
  saveRegistry();
  // the league's files stay on disk (data/leagues/<id>/) — nothing is destroyed
  return true;
}
// Boot one league: rankings + persisted advice + season state, then resume its pollers.
function bootCtx(ctx) {
  withCtx(ctx, () => {
    loadRankingsFromDisk();
    const savedAdvice = loadJson('season-advice.json', null);
    if (savedAdvice && savedAdvice.latest) ST.adv.season.latest = savedAdvice.latest;
    if (savedAdvice && Array.isArray(savedAdvice.history)) ST.adv.season.history = savedAdvice.history;
    loadSeasonFromDisk();
  });
}
function resumeCtx(ctx) {
  withCtx(ctx, () => {
    if (ST.session.draft_id || (ST.session.source === 'espn' && ST.session.espn && ST.session.espn.league_id)) {
      log(`[${leagueName(ctx)}] resuming ${ST.session.source === 'espn' ? 'ESPN' : 'Sleeper'} draft ${ST.session.draft_id} (slot ${ST.session.my_slot})`);
      startPolling();
    }
    if (ST.session.league_id && !SEASON_FIXTURE) {
      log(`[${leagueName(ctx)}] resuming league ${ST.session.league_id} (roster ${ST.session.my_roster_id || '?'})`);
      startSeasonPolling();
    }
  });
}
// Resolve which league an HTTP request is about: ?league=, x-league header, else the server default.
function resolveCtx(url, req) {
  const id = url.searchParams.get('league') || req.headers['x-league'] || ST.registry.active;
  return ST.leagues.get(id) || ST.leagues.get(ST.registry.active) || ST.leagues.get('main');
}
loadRegistry();

// What the UI/tools may see of the session (cookies stripped).
function sessionView() {
  const e = ST.session.espn || {};
  return {
    draft_id: ST.session.draft_id, my_slot: ST.session.my_slot, manual: ST.session.manual, notes: ST.session.notes,
    league_id: ST.session.league_id, my_roster_id: ST.session.my_roster_id,
    source: ST.session.source || 'sleeper',
    espn: { league_id: e.league_id, season: e.season, team_id: e.team_id, hasCookies: !!(espnCookies()) },
  };
}

// ------------------------------------------------- 3. players cache (24h TTL)

const PLAYERS_TTL_MS = 24 * 3600 * 1000;
const PLAYERS_CACHE_V = 2;   // v2 adds inj (injury_status) + dpo (depth_chart_order)

async function loadPlayers(opts = {}) {
  const cache = loadJson('players-cache.json', null, SHARED_DIR);
  const cacheOk = cache && cache.v === PLAYERS_CACHE_V;
  if (!opts.force && cacheOk && Date.now() - cache.fetchedAt < PLAYERS_TTL_MS) {
    ST.players = cache.players;
    ST.playersFetchedAt = cache.fetchedAt;
    log(`players cache v${PLAYERS_CACHE_V}: ${Object.keys(ST.players).length} players (age ${((Date.now() - cache.fetchedAt) / 3600e3).toFixed(1)}h)`);
    buildNameIndex();
    return;
  }
  try {
    log(`fetching Sleeper players/nfl (~5MB, cached 24h)${cache && !cacheOk ? ' [cache v' + (cache.v || 1) + ' invalidated]' : ''}...`);
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
        inj: p.injury_status || '',
        dpo: typeof p.depth_chart_order === 'number' ? p.depth_chart_order : null,
      };
    }
    ST.players = trimmed;
    ST.playersFetchedAt = Date.now();
    fs.writeFileSync(path.join(SHARED_DIR, 'players-cache.json'), JSON.stringify({ v: PLAYERS_CACHE_V, fetchedAt: ST.playersFetchedAt, players: trimmed }));
    log(`players cache refreshed: ${Object.keys(trimmed).length} fantasy-relevant players`);
  } catch (e) {
    if (cache) { ST.players = cache.players; ST.playersFetchedAt = cache.fetchedAt; warn(`players fetch failed (${e.message}); using STALE cache from ${new Date(cache.fetchedAt).toISOString()}`); }
    else throw new Error(`players fetch failed and no cache exists: ${e.message}`);
  }
  buildNameIndex();
}

// In-season: injuries/teams change daily. Refresh the cache in the background
// when it ages past PLAYERS_REFRESH_MS. Called from the season poll loop only,
// so draft-day boot behavior is unchanged. Failures are non-fatal (stale cache stays).
let playersRefreshing = false;
async function maybeRefreshPlayers() {
  if (playersRefreshing || Date.now() - ST.playersFetchedAt < PLAYERS_REFRESH_MS) return false;
  playersRefreshing = true;
  try {
    const before = JSON.stringify(Object.values(ST.players).map(p => p.inj + '|' + p.t));
    await loadPlayers({ force: true });
    const after = JSON.stringify(Object.values(ST.players).map(p => p.inj + '|' + p.t));
    return before !== after;
  } catch (e) { warn('players refresh failed (non-fatal):', e.message); return false; }
  finally { playersRefreshing = false; }
}

// ------------------------------------- 4. normalization + player matching

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function normName(s) {
  const toks = String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')                      // Ja'Marr == JaMarr
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
  proj: /^(proj\.?|projection|proj\.?\s*pts\.?|fpts|points|proj\.?\s*points|proj\.?\s*pts)$/i,
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
  for (let n = 1; n <= maxNo; n++) if (!byNo.has(n)) anomalies.push(`pick #${n} missing from ${meta.source === 'espn' ? 'ESPN' : 'Sleeper'} feed (skipped/removed?)`);
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
    source: meta.source || 'sleeper',
    slotNames: meta.espn_teams ? Object.fromEntries(meta.espn_teams.filter(t => t.slot).map(t => [t.slot, t.name])) : null,
    degraded: ST.poll.degraded, lastSyncAt: ST.poll.lastOkAt,
  };
  return ST.board;
}

// ------------------------------------------------- 7. Sleeper poller

let pollTick = 0;
function startPolling(restart = false) {
  // restart: a (re)connect must poll NOW, not after a completed draft's 30s idle delay.
  // Safe: scheduleNextPoll clears the previous timer, so there is never more than one loop.
  if (ST.poll.running && !restart) return;
  ST.poll.running = true;
  scheduleNextPoll(0);
  if (ST.session.source === 'espn') log(`polling ESPN league ${(ST.session.espn || {}).league_id} (${(ST.session.espn || {}).season}) every ${ESPN_POLL_MS}ms`);
  else log(`polling ${SLEEPER_BASE} for draft ${ST.session.draft_id} every ${POLL_MS}ms`);
}

function scheduleNextPoll(delay) {
  const ctx = ST.ctx;                                   // the loop belongs to this league
  if (!ST.leagues.has(ctx.id)) { ctx.poll.running = false; return; }   // league removed while a fetch was in flight
  clearTimeout(ST.poll.timer);
  ST.poll.timer = setTimeout(() => { activate(ctx); pollOnce().catch(e => warn('pollOnce escaped:', e.message)); }, delay);
}

async function pollOnce() {
  const ctx = ST.ctx;
  if (ST.session.source === 'espn') return pollEspnOnce();
  const id = ST.session.draft_id;
  if (!id) { ST.poll.running = false; return; }
  let delay = POLL_MS;
  try {
    pollTick++;
    const needMeta = !ST.draft.meta || pollTick % 8 === 1 || ST.draft.status !== 'drafting';
    if (needMeta) {
      const meta = await fetchJson(`${SLEEPER_BASE}/draft/${id}`, {}, 10000);
      activate(ctx);
      if (ST.session.draft_id !== id) return scheduleNextPoll(POLL_MS);  // draft switched mid-fetch
      const prevStatus = ST.draft.status;
      ST.draft.meta = meta; ST.draft.status = meta.status;
      if (prevStatus && prevStatus !== meta.status) {
        log(`draft status: ${prevStatus} -> ${meta.status}`); leaguesChanged();
        if (meta.status === 'complete') broadcast('toast', { kind: 'info', msg: 'Draft complete.' });
        if (prevStatus === 'pre_draft' && meta.status === 'drafting') broadcast('toast', { kind: 'info', msg: 'Draft is live!' });
        computeVorp(); rebuildStaticPrefix();
      } else if (!prevStatus) { computeVorp(); rebuildStaticPrefix(); }
    }
    if (ST.draft.status !== 'pre_draft') {
      const picks = await fetchJson(`${SLEEPER_BASE}/draft/${id}/picks`, {}, 10000);
      activate(ctx);
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
    activate(ctx);
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
  return { degraded: ST.poll.degraded, failures: ST.poll.failures, lastSyncAt: ST.poll.lastOkAt, replay: REPLAY, mockLLM: MOCK_LLM, hasKey: !!process.env.ANTHROPIC_API_KEY, advisor: ADVISOR, source: ST.session.source || 'sleeper', profile: PROFILE, port: PORT };
}

// ------------------------------------------------- 7b. ESPN adapter + poller
//
// ESPN exposes one league document (?view=mDraftDetail&view=mSettings&view=mTeam)
// that carries settings, teams, the pick order and every pick made so far. We
// translate it into the exact {meta, picks} shape the Sleeper poller produces, so
// the board math, prompts and UI stay byte-identical. ESPN player ids are mapped
// to Sleeper ids by name/pos/team (same resolver the CSV import uses); a pick we
// cannot map keeps an 'espn:<id>' id plus name metadata, which the board's
// name-fallback still clears from the rankings.

const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const ESPN_PRO_TEAM = {
  0: '', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU',
};
// lineupSlotCounts ids -> our slot keys (ids not listed are ignored; 21 = IR is not drafted)
const ESPN_LINEUP_SLOT = { 0: 'slots_qb', 1: 'slots_qb', 2: 'slots_rb', 3: 'slots_wr_rb', 4: 'slots_wr', 5: 'slots_rec_flex', 6: 'slots_te', 7: 'slots_super_flex', 16: 'slots_def', 17: 'slots_k', 20: 'slots_bn', 23: 'slots_flex' };

function espnCookies() {
  const e = ST.session.espn || {};
  let s2 = e.espn_s2 || process.env.ESPN_S2 || '';
  let swid = e.swid || process.env.ESPN_SWID || '';
  if (!s2 || !swid) {
    // same ESPN account across leagues: borrow another league's cookies
    for (const c of ST.leagues.values()) { const o = c.session.espn || {}; if (o.espn_s2 && o.swid) { s2 = o.espn_s2; swid = o.swid; break; } }
  }
  if (!s2 || !swid) return null;
  return `espn_s2=${s2}; SWID=${swid}`;
}

function espnHeaders(extra = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DraftWarRoom/1.0', accept: 'application/json', ...extra };
  const c = espnCookies();
  if (c) h.cookie = c;
  return h;
}

function espnSeasonDefault() {
  const d = new Date();
  return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1;   // Mar+ = new season
}

function espnLeagueUrl(leagueId, season) {
  return `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?view=mDraftDetail&view=mSettings&view=mTeam`;
}

async function fetchEspnLeague(leagueId, season) {
  return fetchJson(espnLeagueUrl(leagueId, season), { headers: espnHeaders() }, 12000);
}

// ESPN player directory (id -> {n, pos, t}); cached per season for 24h. Used to
// name picks. Non-fatal on failure: unknown ids are resolved on demand below.
const espnPlayers = { season: null, byId: {}, fetchedAt: 0, loading: null };
function espnPlayerRow(p) {
  if (!p || p.id == null) return null;
  return { n: p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(), pos: ESPN_POS[p.defaultPositionId] || '', t: ESPN_PRO_TEAM[p.proTeamId] || '' };
}
async function loadEspnPlayers(season) {
  if (espnPlayers.season === season && Date.now() - espnPlayers.fetchedAt < PLAYERS_TTL_MS) return;
  if (espnPlayers.loading) return espnPlayers.loading;
  espnPlayers.loading = (async () => {
    const name = `espn-players-${ESPN_BASE.includes('espn.com') ? '' : 'mock-'}${season}.json`;   // a mock's ids must never poison the real cache
    const cache = loadJson(name, null, SHARED_DIR);
    if (cache && Date.now() - cache.fetchedAt < PLAYERS_TTL_MS) {
      espnPlayers.season = season; espnPlayers.byId = cache.byId; espnPlayers.fetchedAt = cache.fetchedAt;
      log(`espn players ${season}: ${Object.keys(cache.byId).length} from cache`);
      return;
    }
    try {
      const url = `${ESPN_BASE}/seasons/${season}/players?scoringPeriodId=0&view=players_wl`;
      const list = await fetchJson(url, { headers: espnHeaders({ 'x-fantasy-filter': JSON.stringify({ filterActive: { value: true } }) }) }, 30000);
      const byId = {};
      for (const p of (Array.isArray(list) ? list : [])) { const row = espnPlayerRow(p); if (row && row.pos) byId[p.id] = row; }
      espnPlayers.season = season; espnPlayers.byId = byId; espnPlayers.fetchedAt = Date.now();
      saveJson(name, { fetchedAt: espnPlayers.fetchedAt, byId }, SHARED_DIR);
      log(`espn players ${season}: ${Object.keys(byId).length} fetched`);
    } catch (e) {
      if (cache) { espnPlayers.season = season; espnPlayers.byId = cache.byId; espnPlayers.fetchedAt = cache.fetchedAt; }
      else if (espnPlayers.season !== season) { espnPlayers.season = season; espnPlayers.byId = {}; espnPlayers.fetchedAt = 0; }
      warn(`espn players fetch failed (non-fatal, ids resolved on demand): ${e.message}`);
    }
  })().finally(() => { espnPlayers.loading = null; });
  return espnPlayers.loading;
}
// Look up specific ESPN player ids via the league's kona_player_info view.
async function espnLookupIds(leagueId, season, ids, headers = espnHeaders()) {
  if (!ids.length) return;
  const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_player_info`;
  const filter = { players: { filterIds: { value: ids.slice(0, 50) }, limit: 50 } };
  const j = await fetchJson(url, { headers: { ...headers, 'x-fantasy-filter': JSON.stringify(filter) } }, 12000);
  let n = 0;
  for (const e of (j && j.players) || []) { const row = espnPlayerRow(e.player || e); if (row) { espnPlayers.byId[e.id != null ? e.id : e.player.id] = row; n++; } }
  if (n) saveJson(`espn-players-${ESPN_BASE.includes('espn.com') ? '' : 'mock-'}${season}.json`, { fetchedAt: espnPlayers.fetchedAt || Date.now(), byId: espnPlayers.byId }, SHARED_DIR);
  return n;
}

// Pure: ESPN league document -> {meta, picks, teams, mySlot, unknownIds}.
// `lookup(id)` returns {n,pos,t} or null; `resolve(name,pos,team)` returns {id} or null.
function espnToDraft(raw, opts = {}) {
  const lookup = opts.lookup || ((id) => espnPlayers.byId[id] || null);
  const resolve = opts.resolve || ((n, p, t) => (ST.nameIndex ? resolvePlayer(n, p, t) : null));
  const settings = raw.settings || {};
  const ds = settings.draftSettings || {};
  const lsc = (settings.rosterSettings && settings.rosterSettings.lineupSlotCounts) || {};
  const teamsRaw = raw.teams || [];
  const teamCount = settings.size || teamsRaw.length || 10;
  const s = { teams: teamCount, rounds: 0, reversal_round: 0 };
  for (const [id, cnt] of Object.entries(lsc)) {
    const key = ESPN_LINEUP_SLOT[id];
    if (key) s[key] = (s[key] || 0) + Number(cnt || 0);
    if (Number(id) !== 21) s.rounds += Number(cnt || 0);     // everything but IR is drafted
  }
  for (const k of ['slots_qb', 'slots_rb', 'slots_wr', 'slots_te', 'slots_flex', 'slots_super_flex', 'slots_wr_rb', 'slots_rec_flex', 'slots_k', 'slots_def', 'slots_bn']) if (!s[k]) s[k] = 0;
  if (!s.rounds) s.rounds = 16;
  // scoring type from the receptions stat (statId 53)
  let scoring = 'std';
  const items = (settings.scoringSettings && settings.scoringSettings.scoringItems) || [];
  const rec = items.find(i => i.statId === 53);
  if (rec && rec.points >= 0.9) scoring = 'ppr'; else if (rec && rec.points > 0) scoring = 'half_ppr';
  const dtype = String(ds.type || 'SNAKE').toUpperCase();
  const type = dtype === 'AUCTION' ? 'auction' : 'snake';
  const order = Array.isArray(ds.pickOrder) ? ds.pickOrder.filter(x => x != null) : [];
  const teamName = (t) => (t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || `Team ${t.id}`);
  const members = new Map((raw.members || []).map(m => [m.id, m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim()]));
  const positionalSlot = (round, rpn) => (type === 'auction' ? rpn : (round % 2 === 1 ? rpn : teamCount - rpn + 1));
  const dd = raw.draftDetail || {};
  const rawPicks = (dd.picks || []).filter(p => p && p.playerId != null && p.playerId !== 0 && p.overallPickNumber > 0)
    .sort((a, b) => a.overallPickNumber - b.overallPickNumber);
  // slot per team: pickOrder first, else infer from round-1 picks
  const slotOfTeam = new Map(order.map((tid, i) => [tid, i + 1]));
  for (const p of rawPicks) if (p.roundId === 1 && !slotOfTeam.has(p.teamId)) slotOfTeam.set(p.teamId, positionalSlot(1, p.roundPickNumber));
  const unknownIds = [];
  const picks = rawPicks.map(p => {
    const pl = lookup(p.playerId);
    if (!pl) unknownIds.push(p.playerId);
    const name = pl ? pl.n : '';
    const r = pl ? resolve(pl.n, pl.pos, pl.t) : null;
    const parts = name.split(' ');
    const slot = slotOfTeam.get(p.teamId) || positionalSlot(p.roundId, p.roundPickNumber);
    return {
      round: p.roundId, pick_no: p.overallPickNumber, draft_slot: slot,
      player_id: r ? r.id : `espn:${p.playerId}`, roster_id: p.teamId, picked_by: String(p.teamId),
      metadata: { first_name: parts[0] || '', last_name: parts.slice(1).join(' '), position: pl ? pl.pos : '', team: pl ? pl.t : '', espn_id: p.playerId, keeper: !!p.keeper },
    };
  });
  const total = s.teams * s.rounds;
  let status = 'pre_draft';
  if (dd.drafted || (picks.length && picks.length >= total)) status = 'complete';
  else if (dd.inProgress || picks.length) status = 'drafting';
  const teams = teamsRaw.map(t => ({ id: t.id, name: teamName(t), abbrev: t.abbrev || '', slot: slotOfTeam.get(t.id) || null, owner: members.get((t.owners || [])[0] || t.primaryOwner) || null }))
    .sort((a, b) => (a.slot || 99) - (b.slot || 99) || a.id - b.id);
  const mySlot = opts.teamId != null ? (slotOfTeam.get(Number(opts.teamId)) || null) : null;
  const meta = {
    draft_id: `espn:${raw.id || settings.id || ''}`, source: 'espn', status, type, settings: s,
    metadata: { scoring_type: scoring, name: settings.name || '' },
    start_time: ds.date || null, league_id: null, espn_teams: teams, order_set: order.length > 0,
  };
  return { meta, picks, teams, mySlot, unknownIds: [...new Set(unknownIds)] };
}

async function pollEspnOnce() {
  const ctx = ST.ctx;
  const e = ST.session.espn || {};
  const key = `${e.league_id}|${e.season}`;
  if (!e.league_id) { ST.poll.running = false; return; }
  let delay = ESPN_POLL_MS;
  try {
    pollTick++;
    const headers = espnHeaders();                       // cookies read while this league is active
    await loadEspnPlayers(e.season);
    const raw = await fetchJson(espnLeagueUrl(e.league_id, e.season), { headers }, 12000);
    activate(ctx);
    if (`${(ST.session.espn || {}).league_id}|${(ST.session.espn || {}).season}` !== key) return scheduleNextPoll(ESPN_POLL_MS);   // switched mid-fetch
    let conv = espnToDraft(raw, { teamId: e.team_id });
    if (conv.unknownIds.length) {
      try { await espnLookupIds(e.league_id, e.season, conv.unknownIds, headers); activate(ctx); conv = espnToDraft(raw, { teamId: e.team_id }); }
      catch (err) { activate(ctx); warn(`espn id lookup failed (${conv.unknownIds.length} unknown): ${err.message}`); }
    }
    const prevStatus = ST.draft.status;
    const first = !ST.draft.meta;
    ST.draft.meta = conv.meta; ST.draft.status = conv.meta.status;
    if (e.team_id != null && conv.mySlot && conv.mySlot !== ST.session.my_slot) {
      ST.session.my_slot = conv.mySlot; saveJson('session.json', ST.session);
      log(`espn: my team ${e.team_id} drafts from slot ${conv.mySlot}`);
      broadcast('session', sessionView());
    }
    if (prevStatus && prevStatus !== conv.meta.status) {
      log(`draft status: ${prevStatus} -> ${conv.meta.status}`); leaguesChanged();
      if (conv.meta.status === 'complete') broadcast('toast', { kind: 'info', msg: 'Draft complete.' });
      if (prevStatus === 'pre_draft' && conv.meta.status === 'drafting') broadcast('toast', { kind: 'info', msg: 'Draft is live!' });
      computeVorp(); rebuildStaticPrefix();
    } else if (first) { computeVorp(); rebuildStaticPrefix(); }
    const changed = conv.picks.length !== ST.draft.picks.length || conv.picks.some((p, i) => p.player_id !== (ST.draft.picks[i] || {}).player_id);
    ST.draft.picks = conv.picks;
    computeBoard();
    broadcast('board', ST.board);
    if (changed) advisorOnBoardChange();
    if (ST.poll.failures > 0) { log(`ESPN poll recovered after ${ST.poll.failures} failure(s)`); broadcast('status', pollStatus()); }
    ST.poll.failures = 0; ST.poll.degraded = false; ST.poll.lastOkAt = Date.now();
    if (ST.draft.status === 'complete') delay = 30000;
    else if (ST.draft.status === 'pre_draft') delay = Math.max(ESPN_POLL_MS, 5000);
  } catch (err) {
    activate(ctx);
    ST.poll.failures++;
    ST.poll.degraded = ST.poll.failures >= 2;
    delay = Math.min(15000, 1000 * 2 ** Math.min(ST.poll.failures - 1, 4));
    warn(`ESPN poll failure #${ST.poll.failures}: ${err.message}; retry in ${delay}ms`);
    if (ST.board) { ST.board.degraded = ST.poll.degraded; ST.board.lastSyncAt = ST.poll.lastOkAt; }
    broadcast('status', pollStatus());
  }
  scheduleNextPoll(delay);
}

// --------------------------------- 8. advisor engine (speculative, guarded)

// External mode: is a (fresh) recommendation wanted right now?
function externalNeedAdvice() {
  if (ADVISOR !== 'external') return false;
  const b = ST.board;
  if (!b || !b.mySlot || !ST.rankings.length) return false;
  // manual ↻ forces even outside the window and pre-draft (pre-bakes a round-1 rec)
  if (ST.adv.extForce && b.status !== 'complete') return true;
  if (b.status !== 'drafting') return false;
  if (b.picksUntilMine == null || b.picksUntilMine > SPECULATE_WITHIN) return false;
  return !(ST.adv.latest && ST.adv.latest.basedOn === b.pickCount);
}

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
  if (ADVISOR === 'external') {
    // External mode: advice arrives via POST /api/advisor/submit. Here we only
    // (a) surface the last submitted rec the moment my turn starts and
    // (b) broadcast a "working" state + timestamp the need so the watcher and
    //     latency log have something to key on. No requests to abort.
    const latest = ST.adv.latest;
    if (b.onClock && latest) {
      broadcast('advice', adviceEvent(latest));
      markVisible(latest.basedOn === b.pickCount ? 'precomputed' : 'stale-precomputed');
    }
    if (externalNeedAdvice()) {
      if (!ST.adv.extNeedSince) ST.adv.extNeedSince = Date.now();
      broadcast('advice', { phase: 'reasoning', external: true, seq: ST.adv.seq + 1, basedOn: b.pickCount, speculative: !b.onClock });
    } else if (!withinWindow) {
      ST.adv.extNeedSince = null;
      // clears a stuck "working…" spinner if a turn passed without a submission
      broadcast('advice', { phase: 'idle', external: true, seq: ST.adv.seq + 1, basedOn: b.pickCount });
    }
    return;
  }
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
    // Starvation guard: if picks land faster than requests complete, aborting on
    // every pick means NOTHING ever completes. A request that is already
    // streaming, or any request when our newest completed rec is missing/very
    // stale, runs to completion (then auto-refreshes); freshness only wins when
    // we already hold a recent rec to fall back on.
    const latestAge = latest ? b.pickCount - latest.basedOn : Infinity;
    if (inf.buffer || latestAge > 3) {
      inf.refreshAfter = true;
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
    external: rec.external || false,
    timings: rec.timings,
  };
}

function startAdvice(board) {
  if (ADVISOR === 'external') { advisorOnBoardChange(); return; }
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

  const ctx = ST.ctx;
  const run = MOCK_LLM ? mockAdvise(board, controller.signal, handlers) : callAnthropic(board, controller.signal, handlers);
  run.then((result) => {
    activate(ctx);
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
    // a kept-stale request finished: re-evaluate — if the board moved and we're
    // still in the window (or on the clock), the normal rules fire a fresh one.
    if (inf.refreshAfter && !ST.adv.inflight) advisorOnBoardChange();
  }).catch((e) => {
    activate(ctx);
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
      setTimeout(() => { activate(ctx); ST.adv.retryPending = false; const bb = ST.board; if (bb && bb.onClock && !ST.adv.inflight && !(ST.adv.latest && ST.adv.latest.basedOn === bb.pickCount)) startAdvice(bb); }, 2500);
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
async function prewarmCache() {
  if (MOCK_LLM || !process.env.ANTHROPIC_API_KEY) return;
  if (!ST.staticPrefix || ST.staticPrefix === ST.prewarmedPrefix) return;
  ST.prewarmedPrefix = ST.staticPrefix;
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
  const ctx = ST.ctx;
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
    const { done, value } = await reader.read(); activate(ctx);
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
  const ctx = ST.ctx;
  await sleep(MOCK_THINK_MS * (0.5 + Math.random())); activate(ctx);
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
    await sleep(25); activate(ctx);
    h.onText(full.slice(i, i + 12));
  }
  return { stopReason: 'end_turn' };
}

// ------------------------------------------------- 11. season poller
//
// Parallel to the draft poller: its own loop, cadence, and backoff. Base tick
// 60s; rosters/matchups/transactions every tick, trending+projections ~5min,
// state/league/users/players-refresh ~30min. Every iteration is wrapped;
// failures back off (cap 5min) and auto-recover; state is never dropped.

function seasonWeek() { return ST.season.nfl.week || 1; }
// Advice freshness token: week + adviceRev. adviceRev bumps only on changes
// that actually invalidate advice (rosters, week rollover, injury statuses) —
// NOT on noisy data like live scores or trending counts.
function seasonToken() { return `w${seasonWeek()}.r${ST.season.adviceRev || 0}`; }
function myRosterId() { return ST.session.my_roster_id != null ? Number(ST.session.my_roster_id) : null; }
function round1(x) { return x == null || !isFinite(x) ? null : Math.round(x * 10) / 10; }

function saveSeason() {
  const se = ST.season;
  saveJson('season.json', {
    league: se.league, users: se.users, rosters: se.rosters, nfl: se.nfl,
    matchups: se.matchups, transactions: se.transactions, trending: se.trending,
    proj: se.proj, stats: se.stats, adviceRev: se.adviceRev || 0,
    schedule: se.schedule, matchupHistory: se.matchupHistory, injSeen: se.injSeen, alerts: se.alerts,
  });
}

function loadSeasonFromDisk() {
  const d = loadJson(SEASON_FIXTURE ? 'season-fixture.json' : 'season.json', null);
  if (!d) return;
  const se = ST.season;
  for (const k of ['league', 'users', 'rosters', 'nfl', 'matchups', 'transactions', 'trending', 'proj', 'stats',
    'schedule', 'matchupHistory', 'injSeen', 'alerts']) {
    if (d[k] !== undefined && d[k] !== null) se[k] = d[k];
  }
  se.adviceRev = d.adviceRev || 0;
  se.nfl = se.nfl || { week: null, season: null, season_type: null };
  se.proj = se.proj || { week: null, byId: {}, fetchedAt: 0, degraded: true, count: 0 };
  se.stats = se.stats || { byWeek: {} };
  se.trending = se.trending || { add: [], drop: [], fetchedAt: 0 };
  if (SEASON_FIXTURE && d.injOverride) {          // fixture-only injury statuses (--injure)
    for (const [pid, status] of Object.entries(d.injOverride)) if (ST.players[pid]) ST.players[pid].inj = status;
  }
  computeSeason();
  if (SEASON_FIXTURE) log('SEASON FIXTURE loaded from data/season-fixture.json — season polling disabled');
  else if (se.league) log(`season state restored: ${se.league.name} week ${se.nfl.week || '?'}`);
}

// Positions this league actually starts (drives projections/stats queries).
const FLEX_ELIG = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['RB', 'WR'] };
function leaguePositions() {
  const rp = (ST.season.league && ST.season.league.roster_positions) || [];
  const set = new Set();
  for (const s of rp) {
    if (FLEX_ELIG[s]) FLEX_ELIG[s].forEach(p => set.add(p));
    else if (FANTASY_POS.has(s)) set.add(s);
  }
  return set.size ? [...set] : ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
}

function startSeasonPolling() {
  if (ST.season.poll.running || SEASON_FIXTURE) return;
  ST.season.poll.running = true;
  scheduleNextSeasonPoll(0);
  log(`season polling league ${ST.session.league_id} every ${SEASON_POLL_MS}ms`);
}

function scheduleNextSeasonPoll(delay) {
  const ctx = ST.ctx;
  if (!ST.leagues.has(ctx.id)) { ctx.season.poll.running = false; return; }   // league removed mid-fetch
  clearTimeout(ST.season.poll.timer);
  ST.season.poll.timer = setTimeout(() => { activate(ctx); seasonPollOnce().catch(e => warn('seasonPollOnce escaped:', e.message)); }, delay);
  ST.season.poll.timer.unref && ST.season.poll.timer.unref();
}

async function seasonPollOnce(force) {
  const ctx = ST.ctx;
  const A = (v) => { activate(ctx); return v; };        // re-activate this league after every await
  const lid = ST.session.league_id;
  const se = ST.season;
  if (!lid) { se.poll.running = false; return; }
  let delay = SEASON_POLL_MS;
  let changed = false, advChanged = false;
  const mark = (name, data) => {           // JSON-signature change detection
    const sig = JSON.stringify(data);
    if (se.sig[name] !== sig) { se.sig[name] = sig; changed = true; return true; }
    return false;
  };
  try {
    se.poll.tick++;
    const t = se.poll.tick;
    const slow = force || t === 1 || t % 30 === 0;   // ~30 min
    const mid = force || t === 1 || t % 5 === 0;     // ~5 min

    if (slow) {
      const st = A(await fetchJson(`${SLEEPER_REAL}/state/nfl`, {}, 10000));
      const week = Math.max(1, Number(st.leg || st.week) || 1);
      const prevWeek = se.nfl.week;
      se.nfl = { week, season: String(st.season), season_type: st.season_type };
      mark('nfl', se.nfl);
      if (prevWeek && prevWeek !== week) {
        log(`NFL week rollover: ${prevWeek} -> ${week}`);
        if (se.matchups && se.matchups.length) se.matchupHistory[prevWeek] = se.matchups;  // archive for recaps
        se.matchups = null; se.transactions = [];
        se.proj = { week: null, byId: {}, fetchedAt: 0, degraded: true, count: 0 };
        se.liveStats = { week: null, byId: {}, fetchedAt: 0 };
        broadcast('toast', { kind: 'info', msg: `Week ${week} — matchups and projections refreshing.` });
        advChanged = true;
      }
      se.league = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}`, {}, 10000));
      mark('league', { s: se.league.settings, n: se.league.name });
      se.users = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/users`, {}, 10000));
      mark('users', se.users.map(u => u.user_id + '|' + u.display_name));
      if (A(await maybeRefreshPlayers())) { changed = true; advChanged = true; }
      // league future pairings for the playoff-odds sim (fetch each remaining week once per week)
      try {
        const lastReg = (se.league.settings && se.league.settings.playoff_week_start || 15) - 1;
        for (let w = week + 1; w <= lastReg; w++) {
          if (se.leagueSchedule[w]) continue;
          const mus = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/matchups/${w}`, {}, 10000));
          se.leagueSchedule[w] = (mus || []).map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id }));
        }
      } catch (e) { warn('league schedule fetch failed (non-fatal):', e.message); }
    }
    if (!se.nfl.week) throw new Error('NFL week unknown (state fetch pending)');
    const wk = se.nfl.week;

    // NFL schedule (game statuses drive the live scoreboard + lock badges).
    // Fetched on the mid tier normally, every tick while any game is live.
    const fetchSchedule = async () => {
      const rows = A(await fetchJson(`${SLEEPER_STATS}/schedule/nfl/regular/${se.nfl.season}`, {}, 15000));
      const byWeek = {};
      for (const g of rows || []) {
        if (!g || !g.week || !g.home || !g.away) continue;
        (byWeek[g.week] = byWeek[g.week] || {})[normTeam(g.home)] = { status: g.status, date: g.date, opp: normTeam(g.away) };
        byWeek[g.week][normTeam(g.away)] = { status: g.status, date: g.date, opp: normTeam(g.home) };
      }
      se.schedule = { byWeek, fetchedAt: Date.now() };
      mark('schedule', Object.values(byWeek[wk] || {}).map(x => x.status));
    };
    const liveNow = Object.values((se.schedule.byWeek || {})[wk] || {})
      .some(g => g.status && g.status !== 'pre_game' && g.status !== 'complete');
    if (mid || liveNow || !se.schedule.fetchedAt) {
      try { A(await fetchSchedule()); } catch (e) { activate(ctx); warn('schedule fetch failed (non-fatal):', e.message); }
    }
    // current-week live stats: every tick during games, mid tier otherwise
    if (mid || liveNow) {
      try {
        const pos = leaguePositions().map(p => `position[]=${p}`).join('&');
        const rows = A(await fetchJson(`${SLEEPER_STATS}/stats/nfl/${se.nfl.season}/${wk}?season_type=regular&${pos}`, {}, 20000));
        const { byId } = parseStatRows(rows, se.league && se.league.scoring_settings);
        const pts = {}; for (const [pid, r] of Object.entries(byId)) if (r.pts != null) pts[pid] = r.pts;
        se.liveStats = { week: wk, byId: pts, fetchedAt: Date.now() };
        mark('livestats', Math.round(Object.values(pts).reduce((a, b) => a + b, 0)));
      } catch (e) { warn('live stats fetch failed (non-fatal):', e.message); }
    }

    if (mid) {
      try {
        const [add, drop] = A(await Promise.all([
          fetchJson(`${SLEEPER_REAL}/players/nfl/trending/add?lookback_hours=24&limit=75`, {}, 10000),
          fetchJson(`${SLEEPER_REAL}/players/nfl/trending/drop?lookback_hours=24&limit=75`, {}, 10000),
        ]));
        se.trending = { add, drop, fetchedAt: Date.now() };
        mark('trending', add.slice(0, 25).map(x => x.player_id));   // ids only; counts churn constantly
      } catch (e) { warn('trending fetch failed (non-fatal):', e.message); }
      try {
        const pos = leaguePositions().map(p => `position[]=${p}`).join('&');
        const rows = A(await fetchJson(`${SLEEPER_STATS}/projections/nfl/${se.nfl.season}/${wk}?season_type=regular&${pos}`, {}, 20000));
        const { byId, count } = parseStatRows(rows, se.league && se.league.scoring_settings);
        se.proj = { week: wk, byId, fetchedAt: Date.now(), degraded: count < 50, count };
        mark('proj', { week: wk, count });
      } catch (e) { warn('projections fetch failed (non-fatal):', e.message); se.proj.degraded = true; }
      // backfill one completed week of actuals per cycle (no bursts)
      let missingWeek = null;
      for (let w = 1; w < wk; w++) if (!se.stats.byWeek[w]) { missingWeek = w; break; }
      if (missingWeek) {
        try {
          const pos = leaguePositions().map(p => `position[]=${p}`).join('&');
          const rows = A(await fetchJson(`${SLEEPER_STATS}/stats/nfl/${se.nfl.season}/${missingWeek}?season_type=regular&${pos}`, {}, 20000));
          const { byId } = parseStatRows(rows, se.league && se.league.scoring_settings);
          const pts = {}; for (const [pid, r] of Object.entries(byId)) if (r.pts != null) pts[pid] = r.pts;
          se.stats.byWeek[missingWeek] = pts;
          changed = true;
          log(`week ${missingWeek} actuals cached (${Object.keys(pts).length} players)`);
        } catch (e) { warn('stats fetch failed (non-fatal):', e.message); }
      }
      // backfill one completed week of league matchup results (recap material)
      let missingMu = null;
      for (let w = 1; w < wk; w++) if (!se.matchupHistory[w]) { missingMu = w; break; }
      if (missingMu) {
        try {
          se.matchupHistory[missingMu] = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/matchups/${missingMu}`, {}, 10000));
          changed = true;
          log(`week ${missingMu} matchup results archived`);
        } catch (e) { warn('matchup history fetch failed (non-fatal):', e.message); }
      }
    }

    // every tick: rosters, matchups, transactions
    const rosters = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/rosters`, {}, 10000));
    if (ST.session.league_id !== lid) return scheduleNextSeasonPoll(SEASON_POLL_MS);  // league switched mid-fetch
    se.rosters = rosters;
    if (mark('rosters', rosters.map(r => [r.roster_id, r.players, r.starters, r.settings && r.settings.wins]))) advChanged = true;
    try {
      const mus = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/matchups/${wk}`, {}, 10000));
      se.matchups = mus;
      mark('matchups', (mus || []).map(m => [m.roster_id, m.matchup_id, m.points]));
    } catch (e) { warn('matchups fetch failed (non-fatal):', e.message); }
    try {
      const txs = A(await fetchJson(`${SLEEPER_REAL}/league/${lid}/transactions/${wk}`, {}, 10000));
      se.transactions = txs || [];
      mark('transactions', (txs || []).map(x => x.transaction_id + '|' + x.status));
    } catch (e) { warn('transactions fetch failed (non-fatal):', e.message); }

    if (checkInjuryAlerts()) { changed = true; advChanged = true; }

    if (se.poll.failures > 0) log(`season poll recovered after ${se.poll.failures} failure(s)`);
    se.poll.failures = 0; se.poll.degraded = false; se.poll.lastOkAt = Date.now();
    if (advChanged) se.adviceRev = (se.adviceRev || 0) + 1;
    if (changed || advChanged) {
      se.rev++;
      computeSeason();
      broadcast('season', se.view);
      saveSeason();
    }
  } catch (e) {
    activate(ctx);
    se.poll.failures++;
    se.poll.degraded = se.poll.failures >= 2;
    delay = Math.min(300000, SEASON_POLL_MS * 2 ** Math.min(se.poll.failures - 1, 3));
    warn(`season poll failure #${se.poll.failures}: ${e.message}; retry in ${delay}ms`);
    if (se.view) { se.view.degraded = se.poll.degraded; broadcast('season', se.view); }
  }
  scheduleNextSeasonPoll(delay);
}

// Injury / trending-drop alerts for MY players. First sighting of a player
// seeds injSeen silently (no boot-time flood); afterwards any status change
// becomes an alert. A my-player showing up in the league-wide trending-drop
// list is a "something happened" signal, alerted once per week.
function checkInjuryAlerts() {
  const se = ST.season;
  const myRid = myRosterId();
  const myR = myRid ? se.rosters.find(r => r.roster_id === myRid) : null;
  if (!myR) return false;
  let changed = false;
  const push = (a) => {
    se.alerts.unshift(a);
    if (se.alerts.length > 12) se.alerts.length = 12;
    changed = true;
    log(`alert: ${a.name} ${a.kind === 'inj' ? `${a.from || 'healthy'} -> ${a.to || 'healthy'}` : 'is trending as a DROP league-wide'}`);
  };
  const mine = new Set(myR.players || []);
  for (const pid of mine) {
    const pl = ST.players[pid]; if (!pl) continue;
    const now = pl.inj || '';
    const seen = se.injSeen[pid];
    if (seen === undefined) { se.injSeen[pid] = now; continue; }        // seed silently
    if (seen !== now) {
      push({ pid, name: pl.n, kind: 'inj', from: seen, to: now, at: Date.now(), week: seasonWeek() });
      se.injSeen[pid] = now;
    }
  }
  for (const pid of Object.keys(se.injSeen)) if (!mine.has(pid)) delete se.injSeen[pid];
  for (const t of (se.trending.drop || [])) {
    const pid = String(t.player_id);
    if (!mine.has(pid)) continue;
    if (se.alerts.some(a => a.pid === pid && a.kind === 'drop' && a.week === seasonWeek())) continue;
    push({ pid, name: (ST.players[pid] || {}).n || pid, kind: 'drop', from: null, to: null, at: Date.now(), week: seasonWeek() });
  }
  return changed;
}

// ------------------------------------------------- 12. season math (pure)

// Points for a stat row in this league's scoring (standard families only —
// this league is full PPR; custom stat-by-stat scoring is out of scope).
function projPoints(stats, scoring) {
  if (!stats) return null;
  const rec = scoring && typeof scoring.rec === 'number' ? scoring.rec : 1;
  const key = rec >= 1 ? 'pts_ppr' : rec >= 0.5 ? 'pts_half_ppr' : 'pts_std';
  const v = stats[key];
  return typeof v === 'number' ? v : null;
}

// Shared parser for the undocumented api.sleeper.com projections AND stats
// endpoints (verified same row shape). Defensive: skips anything malformed.
function parseStatRows(rows, scoring) {
  const byId = {}; let count = 0;
  if (!Array.isArray(rows)) return { byId, count };
  for (const r of rows) {
    if (!r || !r.player_id) continue;
    const pts = projPoints(r.stats, scoring);
    byId[r.player_id] = { pts, opp: r.opponent || null };
    if (pts != null) count++;
  }
  return { byId, count };
}

// Rest-of-season value per player: preseason draft-board curve blended with
// in-season PPG. Scale: rank 1 ≈ 100; a 25-PPG week-in-week-out stud ≈ 100.
// Early season trusts the draft board; by week 6 the games take over.
function buildValueIndex() {
  const se = ST.season;
  const map = new Map();
  const rankByPid = new Map(ST.rankings.filter(r => r.player_id).map(r => [r.player_id, r.rank]));
  const weeks = Object.keys(se.stats.byWeek);
  const blendW = Math.min(1, weeks.length / 6);
  const ids = new Set([...Object.keys(se.proj.byId), ...rankByPid.keys()]);
  for (const w of weeks) for (const pid of Object.keys(se.stats.byWeek[w])) ids.add(pid);
  for (const pid of ids) {
    const rank = rankByPid.get(pid);
    const pre = rank ? 1000 / (rank + 9) : 0;
    let sum = 0, n = 0;
    for (const w of weeks) { const p = se.stats.byWeek[w][pid]; if (p != null) { sum += p; n++; } }
    const ppg = n ? sum / n : null;
    const value = ppg != null ? (1 - blendW) * pre + blendW * ppg * 4 : pre;
    map.set(pid, { value, ppg: ppg != null ? round1(ppg) : null, pre: round1(pre) });
  }
  return map;
}

const HARD_OUT = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'COV', 'DNR']);

// Optimal starting lineup by projections. Greedy: highest effective projection
// first, dedicated slot before flex, most-restrictive eligible flex first —
// optimal under nested flex eligibility. getInfo(pid) -> {pos, proj, eff, out}.
// Hard-out players (Out/IR/...) score 0; Questionable/Doubtful keep their proj.
function optimalLineup(playerIds, rosterPositions, getInfo) {
  const slots = [];
  for (const s of rosterPositions) {
    if (s === 'BN' || s === 'IR' || s === 'TAXI') continue;
    slots.push({ slot: s, elig: new Set(FLEX_ELIG[s] || [s]), pid: null, proj: null, eff: 0 });
  }
  const ranked = playerIds.map(pid => {
    const g = getInfo(pid) || {};
    return { pid, pos: g.pos, proj: g.proj, out: !!g.out, eff: g.out ? 0 : (g.eff != null ? g.eff : (g.proj || 0)) };
  }).sort((a, b) => b.eff - a.eff);
  for (const p of ranked) {
    if (p.out) continue;                               // never start a hard-out player
    const open = slots.filter(s => !s.pid && s.elig.has(p.pos));
    if (!open.length) continue;
    open.sort((a, b) => a.elig.size - b.elig.size);
    open[0].pid = p.pid; open[0].proj = p.proj; open[0].eff = p.eff;
  }
  const total = slots.reduce((a, s) => a + (s.pid ? (s.proj || 0) : 0), 0);
  return { slots, total };
}

// Per-player lineup info closure used by lineup/trade math. Bye/no-game logic:
// a CSV bye matching this week, or a healthy projection feed with no row for
// the player, means he is not playing -> effective 0. A missing projection on
// a DEGRADED feed falls back to a pseudo-projection from blended value so
// early-week ordering stays sane (flagged noProj).
function lineupInfo(values) {
  const se = ST.season;
  const week = seasonWeek();
  const rowByPid = new Map(ST.rankings.filter(r => r.player_id).map(r => [r.player_id, r]));
  return (pid) => {
    const pl = ST.players[pid] || {};
    const e = se.proj.byId[pid];
    const proj = e && e.pts != null ? e.pts : null;
    const row = rowByPid.get(pid);
    const onBye = !!(row && row.bye != null && row.bye === week) || (!se.proj.degraded && !e);
    const v = values.get(pid);
    let eff;
    if (onBye) eff = 0;
    else if (proj != null) eff = proj;
    else eff = v && v.value ? Math.min(30, 3 + v.value * 0.22) : 0;
    return { pos: pl.p || '?', proj, eff, out: HARD_OUT.has(pl.inj), inj: pl.inj || '', onBye, noProj: proj == null };
  };
}

// Optimal-vs-current lineup diff for any roster (mine on the Lineup tab,
// opponent's in the matchup prompt).
function computeLineup(roster, rosterPositions, values) {
  const se = ST.season;
  const info = lineupInfo(values);
  const rowFor = (pid) => {
    const pl = ST.players[pid] || {}; const g = info(pid);
    const e = se.proj.byId[pid];
    return {
      pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', inj: pl.inj || '',
      proj: round1(g.proj), opp: e ? e.opp : null, onBye: g.onBye, noProj: g.noProj,
      value: round1((values.get(pid) || {}).value || 0),
    };
  };
  const opt = optimalLineup(roster.players || [], rosterPositions, info);
  const starterSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const curPids = (roster.starters || []).map(x => (x && x !== '0') ? x : null);
  const current = starterSlots.map((slot, i) => (curPids[i] ? { slot, ...rowFor(curPids[i]) } : { slot, empty: true }));
  const optimal = opt.slots.map(s => (s.pid ? { slot: s.slot, ...rowFor(s.pid) } : { slot: s.slot, empty: true }));
  const curSet = new Set(curPids.filter(Boolean));
  const optSet = new Set(opt.slots.map(s => s.pid).filter(Boolean));
  const swapIn = [...optSet].filter(p => !curSet.has(p)).map(rowFor);
  const swapOut = [...curSet].filter(p => !optSet.has(p)).map(rowFor);
  // current total counts Out/bye starters as 0 — that's the real cost of starting them
  const curTotal = curPids.reduce((a, pid) => {
    if (!pid) return a;
    const g = info(pid);
    return a + (g.out || g.onBye ? 0 : (g.proj || 0));
  }, 0);
  const flags = [];
  for (const pid of curSet) {
    const g = info(pid);
    if (g.out) flags.push({ ...rowFor(pid), reason: `starting a player who is ${g.inj}` });
    else if (g.onBye) flags.push({ ...rowFor(pid), reason: 'BYE / no game this week' });
    else if (g.inj) flags.push({ ...rowFor(pid), reason: g.inj });
    else if (g.noProj) flags.push({ ...rowFor(pid), reason: 'no projection' });
  }
  for (const c of current) if (c.empty) flags.push({ name: '(empty)', slot: c.slot, reason: 'EMPTY starting slot' });
  // Close calls: benched players within 2.5 proj of the weakest optimal starter
  // they could displace — the judgment calls Claude is for.
  const closeCalls = [];
  for (const pid of roster.players || []) {
    if (optSet.has(pid)) continue;
    const g = info(pid);
    if (g.eff <= 0) continue;
    const cands = opt.slots.filter(s => s.pid && s.elig.has(g.pos));
    if (!cands.length) continue;
    const weakest = cands.reduce((a, b) => ((a.eff || 0) <= (b.eff || 0) ? a : b));
    const margin = (weakest.eff || 0) - g.eff;
    if (margin < 2.5) closeCalls.push({ bench: rowFor(pid), starter: rowFor(weakest.pid), margin: round1(margin) });
  }
  closeCalls.sort((a, b) => a.margin - b.margin);
  return {
    current, optimal, swapIn, swapOut, flags, closeCalls: closeCalls.slice(0, 6),
    curTotal: round1(curTotal), optTotal: round1(opt.total), gain: round1(opt.total - curTotal),
    degraded: se.proj.degraded,
  };
}

// Starters needed per position for this league (flex apportioned like computeVorp).
function startersNeeded() {
  const rp = (ST.season.league && ST.season.league.roster_positions) || [];
  const ded = {}; let flex = 0, sflex = 0;
  for (const s of rp) {
    if (s === 'FLEX' || s === 'WRRB_FLEX' || s === 'REC_FLEX') flex++;
    else if (s === 'SUPER_FLEX') sflex++;
    else if (FANTASY_POS.has(s)) ded[s] = (ded[s] || 0) + 1;
  }
  return {
    QB: (ded.QB || 0) + sflex * 0.8, RB: (ded.RB || 0) + flex * 0.45,
    WR: (ded.WR || 0) + flex * 0.45, TE: (ded.TE || 0) + flex * 0.10,
    K: ded.K || 0, DEF: ded.DEF || 0,
  };
}

// My per-position strength vs the league median -> waiver need labels.
function computeNeedProfile(values) {
  const se = ST.season;
  const need = startersNeeded();
  const myRid = myRosterId();
  const strength = (roster, pos) => {
    const k = Math.max(1, Math.round(need[pos] || 1));
    return (roster.players || [])
      .filter(pid => ST.players[pid] && ST.players[pid].p === pos)
      .map(pid => (values.get(pid) || {}).value || 0)
      .sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + b, 0);
  };
  const needs = {}; const summary = [];
  const myR = se.rosters.find(r => r.roster_id === myRid);
  for (const pos of leaguePositions()) {
    if (!need[pos]) continue;
    const all = se.rosters.map(r => strength(r, pos)).sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)] || 0;
    const mine = myR ? strength(myR, pos) : 0;
    const ratio = median > 0 ? mine / median : 1;
    needs[pos] = ratio < 0.8 ? 'high' : ratio < 0.95 ? 'med' : 'low';
    summary.push({ pos, mine: round1(mine), median: round1(median), need: needs[pos] });
  }
  return { needs, summary };
}

// Waiver-wire candidates: (players with a projection ∪ trending adds) minus
// every rostered player, scored by a stated composite of value + this-week
// proj + trending heat + my positional need. Plus my droppable bench.
function computeWaivers(values) {
  const se = ST.season;
  if (!se.rosters.length) return null;
  const myRid = myRosterId();
  const rostered = new Set();
  for (const r of se.rosters) for (const pid of r.players || []) rostered.add(pid);
  const trendAdd = new Map((se.trending.add || []).map(t => [String(t.player_id), t.count]));
  const universe = new Set([...Object.keys(se.proj.byId), ...trendAdd.keys()]);
  const profile = computeNeedProfile(values);
  const cands = [];
  for (const pid of universe) {
    if (rostered.has(pid)) continue;
    const pl = ST.players[pid]; if (!pl) continue;
    const v = values.get(pid) || { value: 0, ppg: null };
    const proj = (se.proj.byId[pid] || {}).pts;
    const trend = trendAdd.get(pid) || 0;
    const needBoost = profile.needs[pl.p] === 'high' ? 8 : profile.needs[pl.p] === 'med' ? 3 : 0;
    const score = (v.value || 0) + (proj || 0) * 0.8 + Math.min(40, Math.sqrt(trend) / 12) + needBoost;
    cands.push({
      pid, name: pl.n, pos: pl.p, team: pl.t, inj: pl.inj || '',
      proj: proj != null ? round1(proj) : null, trend, value: round1(v.value || 0),
      ppg: v.ppg, need: profile.needs[pl.p] || 'low', score: round1(score),
    });
  }
  cands.sort((a, b) => b.score - a.score);
  let drops = [];
  const myR = myRid ? se.rosters.find(r => r.roster_id === myRid) : null;
  if (myR) {
    const starters = new Set((myR.starters || []).filter(x => x && x !== '0'));
    drops = (myR.players || []).filter(pid => !starters.has(pid)).map(pid => {
      const pl = ST.players[pid] || {}; const v = values.get(pid) || {};
      return {
        pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', inj: pl.inj || '',
        value: round1(v.value || 0), ppg: v.ppg != null ? v.ppg : null,
        proj: round1((se.proj.byId[pid] || {}).pts),
      };
    }).sort((a, b) => (a.value || 0) - (b.value || 0)).slice(0, 5);
  }
  return {
    candidates: cands.slice(0, 15), drops,
    myWaiverPos: myR && myR.settings ? myR.settings.waiver_position : null,
    needProfile: profile.summary,
  };
}

// Trade evaluation: value totals each way + optimal-lineup totals for BOTH
// rosters before and after the swap + resulting bench depth. All finished
// numbers; Claude judges fairness and fit on top.
function computeTradeEval(params) {
  const se = ST.season;
  const myRid = myRosterId();
  const partner = se.rosters.find(r => r.roster_id === Number(params.partner_roster_id));
  const myR = se.rosters.find(r => r.roster_id === myRid);
  if (!myR) return { error: 'league connected but your roster is not set — pick your team first' };
  if (!partner) return { error: 'unknown trade partner roster' };
  const give = (params.give || []).map(String), get = (params.get || []).map(String);
  if (!give.length && !get.length) return { error: 'empty trade' };
  const mySet = new Set(myR.players || []), theirSet = new Set(partner.players || []);
  const pname = (pid) => (ST.players[pid] || {}).n || pid;
  for (const pid of give) if (!mySet.has(pid)) return { error: `you don't roster ${pname(pid)}` };
  for (const pid of get) if (!theirSet.has(pid)) return { error: `partner doesn't roster ${pname(pid)}` };
  const values = buildValueIndex();
  const rp = se.league.roster_positions || [];
  const info = lineupInfo(values);
  const swap = (players, minus, plus) => players.filter(p => !minus.includes(p)).concat(plus);
  const evalSide = (roster, minus, plus) => {
    const before = optimalLineup(roster.players || [], rp, info).total;
    const after = optimalLineup(swap(roster.players || [], minus, plus), rp, info).total;
    return { before: round1(before), after: round1(after), delta: round1(after - before) };
  };
  const rowOf = (pid) => {
    const pl = ST.players[pid] || {}; const v = values.get(pid) || {};
    return {
      pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', inj: pl.inj || '',
      value: round1(v.value || 0), ppg: v.ppg != null ? v.ppg : null,
      proj: round1((se.proj.byId[pid] || {}).pts),
    };
  };
  const benchByPos = (players, starterPids) => {
    const out = {};
    for (const pid of players) {
      if (starterPids.has(pid)) continue;
      const pl = ST.players[pid]; if (!pl) continue;
      out[pl.p] = (out[pl.p] || 0) + 1;
    }
    return out;
  };
  const depth = (players) => {
    const opt = optimalLineup(players, rp, info);
    return benchByPos(players, new Set(opt.slots.map(s => s.pid).filter(Boolean)));
  };
  const sumVal = (pids) => round1(pids.reduce((a, pid) => a + ((values.get(pid) || {}).value || 0), 0));
  const dl = se.league.settings ? se.league.settings.trade_deadline : null;
  return {
    give: give.map(rowOf), get: get.map(rowOf),
    giveValue: sumVal(give), getValue: sumVal(get),
    myLineup: evalSide(myR, give, get),
    theirLineup: evalSide(partner, get, give),
    myDepthAfter: depth(swap(myR.players || [], give, get)),
    theirDepthAfter: depth(swap(partner.players || [], get, give)),
    partner: { roster_id: partner.roster_id },
    deadlinePassed: !!(dl && seasonWeek() > dl),
  };
}

// Trade scan: per-roster per-position surplus/deficit vs replacement value,
// and the 3 most complementary trade partners for my profile.
function computeTradeScan() {
  const se = ST.season;
  const values = buildValueIndex();
  const myRid = myRosterId();
  const need = startersNeeded();
  const byPos = {};
  for (const r of se.rosters) for (const pid of r.players || []) {
    const pl = ST.players[pid]; if (!pl) continue;
    (byPos[pl.p] = byPos[pl.p] || []).push((values.get(pid) || {}).value || 0);
  }
  const repl = {};
  for (const [pos, arr] of Object.entries(byPos)) {
    arr.sort((a, b) => b - a);
    const idx = Math.max(0, Math.round((need[pos] || 1) * se.rosters.length) - 1);
    repl[pos] = round1(arr[Math.min(idx, arr.length - 1)] || 0);
  }
  const matrix = se.rosters.map(r => {
    const row = { roster_id: r.roster_id, mine: r.roster_id === myRid, surplus: {} };
    for (const pos of Object.keys(need)) {
      if (!need[pos]) continue;
      const above = (r.players || []).filter(pid => {
        const pl = ST.players[pid];
        return pl && pl.p === pos && ((values.get(pid) || {}).value || 0) >= (repl[pos] || 0);
      }).length;
      row.surplus[pos] = round1(above - need[pos]);
    }
    return row;
  });
  const mine = matrix.find(m => m.mine);
  const partners = !mine ? [] : matrix.filter(m => !m.mine).map(m => {
    let score = 0;
    for (const pos of Object.keys(mine.surplus)) {
      score += Math.max(0, -mine.surplus[pos]) * Math.max(0, m.surplus[pos]);
      score += Math.max(0, mine.surplus[pos]) * Math.max(0, -m.surplus[pos]);
    }
    return { roster_id: m.roster_id, complement: round1(score) };
  }).sort((a, b) => b.complement - a.complement).slice(0, 3);
  return { matrix, partners, replacement: repl };
}

// Playoff odds: Monte Carlo over the remaining league schedule. Each team's
// weekly score ~ Normal(strength, 22) where strength blends projected lineup
// strength with actual scoring pace. Seeding = wins, then total points (the
// common Sleeper tiebreak). Cached by a key of everything that moves it.
function computePlayoffOdds(teams, opts = {}) {
  const se = ST.season;
  const wk = seasonWeek();
  const s = (se.league && se.league.settings) || {};
  const lastReg = (s.playoff_week_start || 15) - 1;
  const spots = s.playoff_teams || 6;
  const rng = opts.rng || Math.random;
  const sims = opts.sims || 3000;
  const strengths = {};
  for (const t of teams) {
    const games = t.wins + t.losses + t.ties;
    const pace = games ? t.fpts / games : null;
    strengths[t.roster_id] = pace != null ? 0.5 * (t.optProj || 100) + 0.5 * pace : (t.optProj || 100);
  }
  // remaining schedule: current week's live pairings + fetched future pairings
  const weeks = [];
  const cur = (se.matchups || []).map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id }));
  if (wk <= lastReg && cur.length) weeks.push(cur);
  for (let w = wk + 1; w <= lastReg; w++) if (se.leagueSchedule[w]) weeks.push(se.leagueSchedule[w]);
  if (!weeks.length && teams.every(t => t.wins + t.losses + t.ties === 0)) {
    // pre-season / no schedule yet: odds are meaningless
    if (!weeks.length) return null;
  }
  const key = JSON.stringify([wk, spots, teams.map(t => [t.roster_id, t.wins, t.ties, Math.round(t.fpts)]),
    Object.entries(strengths).map(([k, v]) => [k, Math.round(v)]), weeks.length]);
  if (!opts.rng && se.odds && se.odds.key === key) return se.odds.pct;
  const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const made = {}; for (const t of teams) made[t.roster_id] = 0;
  for (let i = 0; i < sims; i++) {
    const wins = {}, pts = {};
    for (const t of teams) { wins[t.roster_id] = t.wins + t.ties / 2; pts[t.roster_id] = t.fpts; }
    for (const pairings of weeks) {
      const byMu = {};
      for (const p of pairings) { if (p.matchup_id != null) (byMu[p.matchup_id] = byMu[p.matchup_id] || []).push(p.roster_id); }
      const scored = {};
      for (const p of pairings) { scored[p.roster_id] = strengths[p.roster_id] + gauss() * 22; pts[p.roster_id] += scored[p.roster_id]; }
      for (const pair of Object.values(byMu)) {
        if (pair.length !== 2) continue;
        wins[scored[pair[0]] >= scored[pair[1]] ? pair[0] : pair[1]] += 1;
      }
    }
    const order = teams.map(t => t.roster_id).sort((a, b) => (wins[b] - wins[a]) || (pts[b] - pts[a]));
    for (let j = 0; j < Math.min(spots, order.length); j++) made[order[j]]++;
  }
  const pct = {};
  for (const t of teams) pct[t.roster_id] = Math.round((made[t.roster_id] / sims) * 100);
  if (!opts.rng) se.odds = { key, pct };
  return pct;
}

// Bye-week planner: my roster's byes (rankings CSV column) grouped by week,
// flagged when 3+ meaningful players (value >= 8 or current starters) sit out.
function computeByePlan(values) {
  const se = ST.season;
  const myRid = myRosterId();
  const myR = myRid ? se.rosters.find(r => r.roster_id === myRid) : null;
  if (!myR) return null;
  const rowByPid = new Map(ST.rankings.filter(r => r.player_id).map(r => [r.player_id, r]));
  const starters = new Set((myR.starters || []).filter(x => x && x !== '0'));
  const byWeek = {};
  for (const pid of myR.players || []) {
    const row = rowByPid.get(pid);
    if (!row || row.bye == null) continue;
    const pl = ST.players[pid] || {};
    (byWeek[row.bye] = byWeek[row.bye] || []).push({
      pid, name: pl.n || pid, pos: pl.p || '?', starter: starters.has(pid),
      value: round1((values.get(pid) || {}).value || 0),
    });
  }
  return Object.entries(byWeek).map(([w, players]) => {
    const meaningful = players.filter(p => p.starter || (p.value || 0) >= 8).length;
    return { week: Number(w), players: players.sort((a, b) => (b.value || 0) - (a.value || 0)), crunch: meaningful >= 3, past: Number(w) < seasonWeek() };
  }).sort((a, b) => a.week - b.week);
}

// Week-in-review numbers for the recap advice kind: my result, the league's
// scores, and how many points my bench left on the table (optimal-with-
// hindsight vs what my archived starters actually scored). Uses the CURRENT
// roster for the hindsight lineup — close enough, and stated in the prompt.
function computeRecap(week) {
  const se = ST.season;
  const myRid = myRosterId();
  const mus = se.matchupHistory[week];
  const actuals = se.stats.byWeek[week];
  if (!mus || !mus.length || !actuals || !myRid) return null;
  const teamName = (rid) => {
    const t = (se.view && se.view.standings || []).find(x => x.roster_id === rid);
    return t ? t.name : 'roster ' + rid;
  };
  const rp = (se.league && se.league.roster_positions) || [];
  const results = [];
  const byMu = {};
  for (const m of mus) if (m.matchup_id != null) (byMu[m.matchup_id] = byMu[m.matchup_id] || []).push(m);
  for (const pair of Object.values(byMu)) {
    if (pair.length !== 2) continue;
    const [a, b] = pair.slice().sort((x, y) => (y.points || 0) - (x.points || 0));
    results.push({ winner: teamName(a.roster_id), wpts: round1(a.points || 0), loser: teamName(b.roster_id), lpts: round1(b.points || 0), mine: a.roster_id === myRid || b.roster_id === myRid });
  }
  const mine = mus.find(m => m.roster_id === myRid);
  const opp = mine && mine.matchup_id != null ? mus.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== myRid) : null;
  let benchRegret = null, myOptimal = null, myActual = null, best = [], worst = [];
  if (mine) {
    myActual = round1(mine.points || 0);
    const roster = se.rosters.find(r => r.roster_id === myRid);
    const players = (mine.players && mine.players.length ? mine.players : (roster ? roster.players : [])) || [];
    const info = (pid) => { const pl = ST.players[pid] || {}; const a = actuals[pid]; return { pos: pl.p || '?', proj: a != null ? a : 0, eff: a != null ? a : 0, out: false }; };
    const opt = optimalLineup(players, rp, info);
    myOptimal = round1(opt.total);
    benchRegret = round1(Math.max(0, opt.total - (mine.points || 0)));
    const scored = players.map(pid => ({ pid, name: (ST.players[pid] || {}).n || pid, pos: (ST.players[pid] || {}).p || '?', pts: round1(actuals[pid] != null ? actuals[pid] : 0), started: (mine.starters || []).includes(pid) }))
      .sort((a, b) => b.pts - a.pts);
    best = scored.slice(0, 3);
    worst = scored.filter(p => p.started).slice(-3).reverse();
  }
  const high = results.length ? results.reduce((a, r) => (r.wpts > a.wpts ? r : a)) : null;
  const low = results.length ? results.reduce((a, r) => (r.lpts < a.lpts ? r : a)) : null;
  return {
    week,
    my: mine ? {
      points: myActual, won: !!(opp && (mine.points || 0) > (opp.points || 0)),
      opp: opp ? teamName(opp.roster_id) : null, oppPoints: opp ? round1(opp.points || 0) : null,
      optimal: myOptimal, benchRegret, best, worst,
    } : null,
    results, high, low,
  };
}

// The whole season view: standings + power, my roster, matchup, lineup,
// waivers, transactions. Recomputed on any data change, shipped over SSE.
function computeSeason() {
  const se = ST.season;
  if (!se.league || !Array.isArray(se.rosters) || !se.rosters.length) { se.view = null; return null; }
  const myRid = myRosterId();
  const userById = new Map((se.users || []).map(u => [u.user_id, u]));
  const teamName = (r) => {
    const u = userById.get(r.owner_id);
    return (u && ((u.metadata && u.metadata.team_name) || u.display_name)) || `Roster ${r.roster_id}`;
  };
  const values = buildValueIndex();
  const info = lineupInfo(values);
  const rp = se.league.roster_positions || [];
  const fpts = (s, k) => (s ? (s[k] || 0) + (s[k + '_decimal'] || 0) / 100 : 0);
  const projOf = (pid) => { const e = se.proj.byId[pid]; return e && e.pts != null ? e.pts : null; };

  const teams = se.rosters.map(r => {
    const opt = optimalLineup(r.players || [], rp, info);
    const curProj = (r.starters || []).reduce((a, pid) => a + (pid && pid !== '0' ? (projOf(pid) || 0) : 0), 0);
    const s = r.settings || {};
    return {
      roster_id: r.roster_id, name: teamName(r), mine: r.roster_id === myRid,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      fpts: round1(fpts(s, 'fpts')), fptsAgainst: round1(fpts(s, 'fpts_against')),
      waiverPos: s.waiver_position != null ? s.waiver_position : null,
      optProj: round1(opt.total), curProj: round1(curProj),
      value: round1((r.players || []).reduce((a, pid) => a + ((values.get(pid) || {}).value || 0), 0)),
    };
  });
  // Power score: stated composite of win%, points-for, projected lineup
  // strength, and roster value — each min-max normalized across the league.
  const norm = (arr) => { const mx = Math.max(...arr), mn = Math.min(...arr); return arr.map(v => (mx > mn ? (v - mn) / (mx - mn) : 0.5)); };
  const wpct = teams.map(t => { const g = t.wins + t.losses + t.ties; return g ? (t.wins + t.ties / 2) / g : 0.5; });
  const nW = norm(wpct), nF = norm(teams.map(t => t.fpts)), nO = norm(teams.map(t => t.optProj)), nV = norm(teams.map(t => t.value));
  teams.forEach((t, i) => { t.power = round1(100 * (0.30 * nW[i] + 0.15 * nF[i] + 0.30 * nO[i] + 0.25 * nV[i])); });
  const oddsPct = computePlayoffOdds(teams);
  teams.forEach((t) => { t.odds = oddsPct ? oddsPct[t.roster_id] : null; });
  const standings = teams.slice().sort((a, b) => (b.wins - a.wins) || (b.fpts - a.fpts));
  standings.forEach((t, i) => { t.rank = i + 1; });
  const teamByRid = new Map(teams.map(t => [t.roster_id, t]));

  // game status + live points helpers (schedule statuses; live stats during games)
  const wkGames = (se.schedule.byWeek || {})[se.nfl.week] || {};
  const gsOf = (pid) => {
    const pl = ST.players[pid]; if (!pl || !pl.t) return null;
    const g = wkGames[pl.t]; if (!g) return 'bye';
    return g.status === 'pre_game' ? 'pre' : g.status === 'complete' ? 'final' : 'live';
  };
  const liveOf = (pid) => (se.liveStats.week === se.nfl.week && se.liveStats.byId[pid] != null) ? se.liveStats.byId[pid] : null;
  const liveNow = Object.values(wkGames).some(g => g.status && g.status !== 'pre_game' && g.status !== 'complete');

  let myRoster = null, matchup = null, lineup = null;
  const myR = myRid ? se.rosters.find(r => r.roster_id === myRid) : null;
  if (myR) {
    const starters = new Set((myR.starters || []).filter(x => x && x !== '0'));
    myRoster = {
      players: (myR.players || []).map(pid => {
        const pl = ST.players[pid] || {}; const e = se.proj.byId[pid]; const g = info(pid);
        return {
          pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', inj: pl.inj || '',
          proj: round1(projOf(pid)), opp: e ? e.opp : null, onBye: g.onBye,
          value: round1((values.get(pid) || {}).value || 0),
          ppg: (values.get(pid) || {}).ppg != null ? values.get(pid).ppg : null,
          starter: starters.has(pid),
        };
      }).sort((a, b) => (b.starter - a.starter) || ((b.proj || 0) - (a.proj || 0))),
    };
    lineup = computeLineup(myR, rp, values);
    const me = teamByRid.get(myRid);
    if (se.matchups && se.matchups.length && me) {
      const mine = se.matchups.find(m => m.roster_id === myRid);
      const opp = mine && mine.matchup_id != null
        ? se.matchups.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== myRid) : null;
      const oppTeam = opp ? teamByRid.get(opp.roster_id) : null;
      if (mine) {
        // per-starter scoreboard rows (live points + game status) for both sides
        const starterDetail = (mu) => (mu.starters || []).filter(x => x && x !== '0').map(pid => {
          const pl = ST.players[pid] || {}; const e = se.proj.byId[pid];
          return {
            pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', inj: pl.inj || '',
            opp: e ? e.opp : null, proj: round1(projOf(pid)), pts: round1(liveOf(pid)), gs: gsOf(pid),
          };
        });
        const yetToPlay = (rows) => rows.filter(r => r.gs === 'pre').length;
        const myRows = starterDetail(mine);
        const oppRows = opp ? starterDetail(opp) : [];
        matchup = {
          week: se.nfl.week, liveNow,
          my: {
            points: round1(mine.points || 0), proj: me.curProj, optProj: me.optProj,
            record: `${me.wins}-${me.losses}${me.ties ? '-' + me.ties : ''}`, rank: me.rank, power: me.power,
            starters: myRows, left: yetToPlay(myRows),
          },
          opp: oppTeam ? {
            roster_id: oppTeam.roster_id, name: oppTeam.name,
            points: round1(opp.points || 0), proj: oppTeam.curProj, optProj: oppTeam.optProj,
            record: `${oppTeam.wins}-${oppTeam.losses}${oppTeam.ties ? '-' + oppTeam.ties : ''}`, rank: oppTeam.rank, power: oppTeam.power,
            starters: oppRows, left: yetToPlay(oppRows),
          } : null,
        };
      }
    }
  }

  const nameOf = (pid) => (ST.players[pid] || {}).n || pid;
  const ridName = (rid) => { const t = teamByRid.get(rid); return t ? t.name : 'roster ' + rid; };
  const transactions = (se.transactions || []).slice()
    .sort((a, b) => (b.status_updated || b.created || 0) - (a.status_updated || a.created || 0))
    .slice(0, 20).map(tx => ({
      id: tx.transaction_id, type: tx.type, status: tx.status,
      at: tx.status_updated || tx.created || null,
      teams: (tx.roster_ids || []).map(ridName),
      adds: tx.adds ? Object.entries(tx.adds).map(([pid, rid]) => ({ name: nameOf(pid), pos: (ST.players[pid] || {}).p || '', to: ridName(rid) })) : [],
      drops: tx.drops ? Object.entries(tx.drops).map(([pid, rid]) => ({ name: nameOf(pid), pos: (ST.players[pid] || {}).p || '', from: ridName(rid) })) : [],
    }));

  const dl = se.league.settings ? se.league.settings.trade_deadline : null;
  se.view = {
    week: se.nfl.week, season: se.nfl.season, rev: se.rev, token: seasonToken(),
    leagueName: se.league.name, leagueId: ST.session.league_id, myRosterId: myRid,
    tradeDeadline: dl, tradeDeadlinePassed: !!(dl && se.nfl.week > dl),
    playoffWeekStart: se.league.settings ? se.league.settings.playoff_week_start : null,
    waiverType: se.league.settings ? se.league.settings.waiver_type : null,
    projDegraded: se.proj.degraded, projCount: se.proj.count,
    playersAgeH: ST.playersFetchedAt ? round1((Date.now() - ST.playersFetchedAt) / 3600e3) : null,
    degraded: se.poll.degraded, lastSyncAt: se.poll.lastOkAt, fixture: SEASON_FIXTURE,
    liveNow, alerts: se.alerts.slice(0, 8),
    byePlan: computeByePlan(values),
    recapWeek: (se.nfl.week > 1 && se.matchupHistory[se.nfl.week - 1] && se.stats.byWeek[se.nfl.week - 1]) ? se.nfl.week - 1 : null,
    standings, myRoster, matchup, lineup, transactions,
    waivers: computeWaivers(values),
    rosters: se.rosters.map(r => ({
      roster_id: r.roster_id, name: teamName(r), mine: r.roster_id === myRid,
      players: (r.players || []).map(pid => {
        const pl = ST.players[pid] || {};
        return { pid, name: pl.n || pid, pos: pl.p || '?', team: pl.t || '', value: round1((values.get(pid) || {}).value || 0) };
      }).sort((a, b) => (b.value || 0) - (a.value || 0)),
    })),
    advicePending: Object.keys(ST.adv.season.pending),
  };
  return se.view;
}

// ---------------------- 13. season prompts (external advisor, per kind)

const SEASON_KINDS = new Set(['lineup', 'waiver', 'trade', 'matchup', 'power', 'recap']);

function seasonNeedAdvice() {
  return Object.entries(ST.adv.season.pending)
    .sort((a, b) => a[1].since - b[1].since)
    .map(([kind, p]) => ({ kind, since: p.since, params: p.params || null, basedOn: seasonToken() }));
}

function seasonAdviceEvent(rec) {
  return {
    kind: rec.kind, seq: rec.seq, basedOn: rec.basedOn, phase: 'done',
    stale: rec.basedOn !== seasonToken(),
    text: rec.text, parsed: rec.parsed, adviceLine: rec.adviceLine,
    external: true, completedAt: rec.completedAt,
  };
}

function buildSeasonBriefing() {
  const se = ST.season;
  const L = se.league || {}; const s = L.settings || {}; const sc = L.scoring_settings || {};
  const v = se.view;
  const rp = (L.roster_positions || []).filter(x => x !== 'BN' && x !== 'IR' && x !== 'TAXI');
  const myTeam = v && v.standings ? v.standings.find(t => t.mine) : null;
  const scoring = sc.rec >= 1 ? 'full PPR' : sc.rec >= 0.5 ? 'half PPR' : 'standard';
  return [
    'You are the season-long analyst inside a fantasy football manager tool ("Season War Room"). The server computes every number (projections, blended values, optimal lineups, need profiles); you judge close calls and explain. Each request names its advice kind; answer ONLY in that kind\'s strict format.',
    '',
    '## League',
    `${L.name || 'league'} — ${(se.rosters || []).length || s.num_teams || '?'} teams · Scoring: ${scoring}`,
    `Starting lineup: ${rp.join(', ')}${rp.includes('K') ? '' : ' (NO kicker in this league)'}`,
    `Waivers: ${s.waiver_type === 2 ? `FAAB $${s.waiver_budget}` : 'rolling priority (a claim burns your position)'} · Trade deadline: week ${s.trade_deadline || '?'} · Playoffs start: week ${s.playoff_week_start || '?'}`,
    myTeam ? `My team: ${myTeam.name} (roster ${myTeam.roster_id}) — ${myTeam.wins}-${myTeam.losses}, ranked ${myTeam.rank} of ${v.standings.length}` : 'My team: (not yet selected)',
    '',
    '## How to read the numbers (all precomputed — trust them, do not recalculate)',
    '- proj = this-week projected points in league scoring. ppg = actual season points per game.',
    '- value = rest-of-season worth: preseason draft-board curve blended with season PPG (early season leans on the draft board — treat as approximate, and weigh recent role changes yourself). Scale: elite ≈ 90-100, solid starter ≈ 30-60, waiver fodder < 15.',
    '- Optimal lineups are server-computed (greedy over projections with flex eligibility). Your judgment adds what numbers miss: matchups, injury risk, usage trends, game scripts.',
    '- Injury statuses come from Sleeper and can lag; each request states data age. If a request is flagged DEGRADED (sparse projections), hedge accordingly and say so.',
    '',
    '## Hard rules',
    '- Only reference players and teams listed in the request. Never invent players, stats, or news.',
    '- Output format (STRICT — parsed by machine): first line `ADVICE: <one-line summary>`, then ONE fenced ```json block matching the kind\'s schema below, nothing after it.',
    '',
    '## JSON schema per kind',
    'lineup: {"changes":[{"slot":"","start":"","sit":"","why":"<=20 words"}],"confirm_optimal":true|false,"watch":["player — what to check before kickoff"],"summary":"<=40 words"}',
    'waiver: {"claims":[{"add":"","drop":"","worth_waiver_spot":true|false,"why":"<=25 words"}],"pass":["name"],"summary":"<=40 words"} — claims in priority order; worth_waiver_spot = worth burning my rolling-waiver position vs waiting for free agency.',
    'trade eval: {"verdict":"accept|reject|counter","delta":"who wins and why, <=25 words","counter":"counter-offer suggestion or null","why":"<=40 words"}',
    'trade scan: {"ideas":[{"team":"","give":["name"],"get":["name"],"why":"<=25 words"}],"summary":"<=40 words"}',
    'matchup: {"projected":"me <pts> — opp <pts>","win_read":"favored|coin-flip|underdog + one clause","their_threats":["name — why"],"my_edges":["..."],"keys":["..."],"summary":"<=50 words"}',
    'power: {"rankings":[{"rank":1,"team":"","comment":"<=15 words, punchy — trash talk welcome"}],"my_outlook":"<=40 words","summary":"<=30 words"}',
    'recap: {"headline":"<=12 words","my_week":"<=40 words","bench_regret":"<=25 words or null","league_notes":["<=20 words each, 2-4 items"],"look_ahead":"<=30 words","summary":"<=30 words"} — Monday-morning tone, honest about my mistakes, trash talk welcome.',
  ].join('\n');
}

function notesLines() {
  const notes = Object.entries(ST.session.notes || {}).filter(([, v]) => v);
  if (!notes.length) return [];
  return ['', '## My notes on players', ...notes.map(([pid, note]) => `- ${(ST.players[pid] || {}).n || pid}: ${note}`)];
}

function fmtPlayerLine(p) {
  const bits = [p.name, `${p.pos} ${p.team || 'FA'}`];
  if (p.opp) bits.push('vs ' + p.opp);
  if (p.proj != null) bits.push(`proj ${p.proj}`);
  if (p.ppg != null) bits.push(`ppg ${p.ppg}`);
  if (p.value != null) bits.push(`val ${p.value}`);
  if (p.inj) bits.push(`[${p.inj}]`);
  if (p.onBye) bits.push('[BYE/no game]');
  return bits.join(' | ');
}

function promptHeader(kind) {
  const v = ST.season.view;
  return [
    `# ${kind.toUpperCase()} advice request (kind=${kind}, basedOn=${seasonToken()})`,
    `Week ${v.week} · projections: ${v.projCount} players${v.projDegraded ? ' — DEGRADED (sparse; hedge accordingly)' : ''} · player data age ${v.playersAgeH != null ? v.playersAgeH + 'h' : '?'}${v.degraded ? ' · Sleeper sync DEGRADED' : ''}`,
    '',
  ];
}

function buildLineupPrompt() {
  const v = ST.season.view;
  if (!v || !v.lineup) return null;
  const L = v.lineup;
  const lines = promptHeader('lineup');
  lines.push('## Current starters (slot | player)');
  for (const c of L.current) lines.push(`${c.slot}: ${c.empty ? '(EMPTY)' : fmtPlayerLine(c)}`);
  lines.push('');
  lines.push(`## Server-computed optimal (proj total ${L.optTotal} vs current ${L.curTotal}, gain ${L.gain})`);
  for (const o of L.optimal) lines.push(`${o.slot}: ${o.empty ? '(none available)' : fmtPlayerLine(o)}`);
  if (L.swapIn.length || L.swapOut.length) {
    lines.push('');
    lines.push('## Suggested swaps');
    lines.push(`IN: ${L.swapIn.map(fmtPlayerLine).join(' ;; ') || '(none)'}`);
    lines.push(`OUT: ${L.swapOut.map(fmtPlayerLine).join(' ;; ') || '(none)'}`);
  }
  if (L.flags.length) {
    lines.push('');
    lines.push('## Flags');
    for (const f of L.flags) lines.push(`- ${f.name}${f.slot ? ` (${f.slot})` : ''}: ${f.reason}`);
  }
  if (L.closeCalls.length) {
    lines.push('');
    lines.push('## Close calls (the judgment calls — margins under 2.5 proj pts)');
    for (const c of L.closeCalls) lines.push(`- bench ${fmtPlayerLine(c.bench)} vs starter ${fmtPlayerLine(c.starter)} (margin ${c.margin})`);
  }
  const bench = v.myRoster ? v.myRoster.players.filter(p => !p.starter) : [];
  lines.push('');
  lines.push('## Full bench');
  for (const p of bench) lines.push('- ' + fmtPlayerLine(p));
  if (v.matchup && v.matchup.opp) {
    lines.push('');
    lines.push(`## Matchup context: vs ${v.matchup.opp.name} (${v.matchup.opp.record}, proj ${v.matchup.opp.proj})`);
  }
  const locked = v.matchup && v.matchup.my && v.matchup.my.starters
    ? v.matchup.my.starters.filter(s => s.gs === 'live' || s.gs === 'final') : [];
  lines.push(...notesLines());
  lines.push('');
  if (locked.length) lines.push(`LOCKED (game live or final — cannot be swapped): ${locked.map(s => s.name).join(', ')}. Only advise changes among unlocked players.`);
  else lines.push('No games have kicked off yet — every listed player is still swappable. Flag early-window players in "watch".');
  lines.push('Give lineup advice now in the strict lineup format.');
  return lines.join('\n');
}

function buildRecapPrompt() {
  const v = ST.season.view;
  if (!v || !v.recapWeek) return null;
  const r = computeRecap(v.recapWeek);
  if (!r || !r.my) return null;
  const lines = promptHeader('recap');
  lines.push(`## My week ${r.week}: ${r.my.won ? 'WIN' : 'LOSS'} ${r.my.points} — ${r.my.oppPoints} vs ${r.my.opp}`);
  lines.push(`Optimal-with-hindsight lineup would have scored ${r.my.optimal} (points left on bench: ${r.my.benchRegret}). Hindsight lineup uses my current roster — close enough, note if it matters.`);
  lines.push(`My top scorers: ${r.my.best.map(p => `${p.name} ${p.pts}${p.started ? '' : ' (BENCHED)'}`).join(', ')}`);
  lines.push(`My worst starters: ${r.my.worst.map(p => `${p.name} ${p.pts}`).join(', ')}`);
  lines.push('');
  lines.push('## League results');
  for (const res of r.results) lines.push(`- ${res.winner} ${res.wpts} def. ${res.loser} ${res.lpts}${res.mine ? ' [MY GAME]' : ''}`);
  if (r.high) lines.push(`Week high: ${r.high.winner} ${r.high.wpts}. Week low: ${r.low.loser} ${r.low.lpts}.`);
  lines.push('');
  lines.push('## Standings now');
  for (const t of v.standings) lines.push(`${t.rank}. ${t.name}${t.mine ? ' [ME]' : ''} ${t.wins}-${t.losses} (${t.fpts} PF${t.odds != null ? `, playoff odds ${t.odds}%` : ''})`);
  const advised = (ST.adv.season.history || []).filter(h => h.week === r.week && h.adviceLine);
  if (advised.length) {
    lines.push('');
    lines.push('## What I advised that week (grade yourself honestly)');
    for (const h of advised) lines.push(`- [${h.kind}] ${h.adviceLine}`);
  }
  lines.push('');
  lines.push('Write the Monday-morning recap now in the strict recap format.');
  return lines.join('\n');
}

function buildWaiverPrompt() {
  const v = ST.season.view;
  if (!v || !v.waivers) return null;
  const W = v.waivers;
  const lines = promptHeader('waiver');
  lines.push(`My rolling waiver position: ${W.myWaiverPos != null ? `${W.myWaiverPos} of ${v.standings.length}` : 'unknown'} (a successful claim sends me to the back of the line). Standing question per claim: worth burning that position, or wait and grab in free agency?`);
  lines.push('');
  lines.push('## My positional need profile (starter strength vs league median)');
  for (const n of W.needProfile) lines.push(`- ${n.pos}: mine ${n.mine} vs median ${n.median} -> need ${n.need}`);
  lines.push('');
  lines.push('## Top free agents (name | pos team | this-wk proj | 24h adds | ROS value | season ppg | my need)');
  for (const c of W.candidates) {
    lines.push(`- ${c.name} | ${c.pos} ${c.team || 'FA'} | ${c.proj != null ? c.proj : '-'} | +${c.trend} | ${c.value} | ${c.ppg != null ? c.ppg : '-'} | ${c.need}${c.inj ? ` | [${c.inj}]` : ''}`);
  }
  lines.push('');
  lines.push('## My droppable bench (lowest ROS value first)');
  for (const d of W.drops) lines.push('- ' + fmtPlayerLine(d));
  const txs = (v.transactions || []).filter(t => t.status === 'complete').slice(0, 8);
  if (txs.length) {
    lines.push('');
    lines.push('## Recent league moves (context on what managers are chasing)');
    for (const t of txs) {
      const bits = [...t.adds.map(a => `${a.to} added ${a.name} (${a.pos})`), ...t.drops.map(d => `${d.from} dropped ${d.name}`)];
      if (bits.length) lines.push('- ' + bits.join('; '));
    }
  }
  lines.push(...notesLines());
  lines.push('');
  lines.push('Give waiver advice now in the strict waiver format (claims in priority order; be honest when the right move is to pass).');
  return lines.join('\n');
}

function buildTradePrompt(params) {
  const v = ST.season.view;
  if (!v) return null;
  const lines = promptHeader('trade');
  if (params && params.mode === 'scan') {
    const scan = computeTradeScan();
    const nameOf = (rid) => { const t = v.standings.find(x => x.roster_id === rid); return t ? t.name : 'roster ' + rid; };
    lines.push('## League surplus/deficit matrix (players above replacement value minus starters needed; + = tradeable surplus, − = hole)');
    for (const m of scan.matrix) {
      lines.push(`- ${nameOf(m.roster_id)}${m.mine ? ' [ME]' : ''}: ${Object.entries(m.surplus).map(([p, s]) => `${p} ${s > 0 ? '+' : ''}${s}`).join(', ')}`);
    }
    lines.push('');
    lines.push(`## Most complementary partners for me: ${scan.partners.map(p => `${nameOf(p.roster_id)} (fit ${p.complement})`).join(', ') || '(none stand out)'}`);
    lines.push('');
    lines.push('## Rosters of the top partners (name | value), best first');
    for (const p of scan.partners) {
      const r = v.rosters.find(x => x.roster_id === p.roster_id);
      if (r) lines.push(`- ${r.name}: ${r.players.slice(0, 12).map(x => `${x.name} (${x.pos} ${x.value})`).join(', ')}`);
    }
    const mine = v.rosters.find(r => r.mine);
    if (mine) lines.push(`- MY ROSTER: ${mine.players.map(x => `${x.name} (${x.pos} ${x.value})`).join(', ')}`);
    lines.push('');
    lines.push(`Trade deadline: week ${v.tradeDeadline || '?'} (current week ${v.week}).`);
    lines.push('Suggest 2-3 realistic trade ideas now in the strict trade-scan format.');
    return lines.join('\n');
  }
  const ev = computeTradeEval(params || {});
  if (ev.error) return null;
  const partnerTeam = v.standings.find(t => t.roster_id === ev.partner.roster_id);
  lines.push(`## Proposed trade with ${partnerTeam ? partnerTeam.name : 'roster ' + ev.partner.roster_id}${partnerTeam ? ` (${partnerTeam.wins}-${partnerTeam.losses}, rank ${partnerTeam.rank})` : ''}`);
  lines.push(`I GIVE (total value ${ev.giveValue}):`);
  for (const p of ev.give) lines.push('- ' + fmtPlayerLine(p));
  lines.push(`I GET (total value ${ev.getValue}):`);
  for (const p of ev.get) lines.push('- ' + fmtPlayerLine(p));
  lines.push('');
  lines.push('## Server-computed weekly lineup impact (optimal-lineup proj totals)');
  lines.push(`- My lineup: ${ev.myLineup.before} -> ${ev.myLineup.after} (${ev.myLineup.delta >= 0 ? '+' : ''}${ev.myLineup.delta})`);
  lines.push(`- Their lineup: ${ev.theirLineup.before} -> ${ev.theirLineup.after} (${ev.theirLineup.delta >= 0 ? '+' : ''}${ev.theirLineup.delta})`);
  lines.push(`- My bench depth after: ${Object.entries(ev.myDepthAfter).map(([p, n]) => `${p}x${n}`).join(', ') || 'none'}`);
  const mine = v.rosters.find(r => r.mine);
  const theirs = v.rosters.find(r => r.roster_id === ev.partner.roster_id);
  if (mine) lines.push(`\n## My full roster: ${mine.players.map(x => `${x.name} (${x.pos} ${x.value})`).join(', ')}`);
  if (theirs) lines.push(`## Their full roster: ${theirs.players.map(x => `${x.name} (${x.pos} ${x.value})`).join(', ')}`);
  if (ev.deadlinePassed) lines.push('\nWARNING: the trade deadline has passed — this can only be advisory.');
  lines.push(...notesLines());
  lines.push('');
  lines.push('Judge this trade now in the strict trade-eval format.');
  return lines.join('\n');
}

function buildMatchupPrompt() {
  const v = ST.season.view;
  if (!v || !v.matchup || !v.matchup.opp) return null;
  const se = ST.season;
  const m = v.matchup;
  const lines = promptHeader('matchup');
  const me = v.standings.find(t => t.mine);
  lines.push(`## Week ${m.week}: ${me ? me.name : 'me'} (${m.my.record}, rank ${m.my.rank}, power ${m.my.power}) vs ${m.opp.name} (${m.opp.record}, rank ${m.opp.rank}, power ${m.opp.power})`);
  lines.push(`Projected starter totals: me ${m.my.proj} (optimal ${m.my.optProj}) — them ${m.opp.proj} (optimal ${m.opp.optProj})`);
  lines.push('');
  const values = buildValueIndex();
  const rp = se.league.roster_positions || [];
  const oppR = se.rosters.find(r => r.roster_id === m.opp.roster_id);
  if (v.lineup) {
    lines.push('## My current starters');
    for (const c of v.lineup.current) lines.push(`${c.slot}: ${c.empty ? '(EMPTY)' : fmtPlayerLine(c)}`);
    lines.push('');
  }
  if (oppR) {
    const oppLineup = computeLineup(oppR, rp, values);
    lines.push('## Their current starters');
    for (const c of oppLineup.current) lines.push(`${c.slot}: ${c.empty ? '(EMPTY)' : fmtPlayerLine(c)}`);
    if (oppLineup.flags.length) {
      lines.push('Their flags: ' + oppLineup.flags.map(f => `${f.name} (${f.reason})`).join('; '));
    }
    lines.push('');
  }
  lines.push('Write the scouting report now in the strict matchup format.');
  return lines.join('\n');
}

function buildPowerPrompt() {
  const v = ST.season.view;
  if (!v) return null;
  const lines = promptHeader('power');
  lines.push('## Standings + server-computed power score (win% 30, points-for 15, projected lineup strength 30, roster value 25)');
  lines.push('rank | team | W-L | PF | this-wk proj (optimal) | roster value | POWER');
  for (const t of v.standings) {
    lines.push(`${t.rank} | ${t.name}${t.mine ? ' [ME]' : ''} | ${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''} | ${t.fpts} | ${t.curProj} (${t.optProj}) | ${t.value} | ${t.power}`);
  }
  lines.push('');
  lines.push('## Each roster\'s top players (name pos value)');
  for (const r of v.rosters) {
    lines.push(`- ${r.name}${r.mine ? ' [ME]' : ''}: ${r.players.slice(0, 6).map(x => `${x.name} ${x.pos} ${x.value}`).join(', ')}`);
  }
  lines.push('');
  lines.push('Rank all teams 1-N with punchy comments now in the strict power format (order by YOUR judgment, not just the power score — explain where you diverge).');
  return lines.join('\n');
}

function buildSeasonPrompt(kind, params) {
  if (!ST.season.view) return null;
  switch (kind) {
    case 'lineup': return buildLineupPrompt();
    case 'waiver': return buildWaiverPrompt();
    case 'trade': return buildTradePrompt(params);
    case 'matchup': return buildMatchupPrompt();
    case 'power': return buildPowerPrompt();
    case 'recap': return buildRecapPrompt();
    default: return null;
  }
}

// -------------------------------------- 10. SSE hub + HTTP server / routes

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}

function broadcast(event, data) {           // to the ACTIVE league's viewers
  for (const res of ST.sse) sseWrite(res, event, data);
}
function broadcastAll(event, data) {        // to every viewer of every league
  for (const c of ST.leagues.values()) for (const res of c.sse) sseWrite(res, event, data);
}
function leaguesChanged() { broadcastAll('leagues', leaguesView()); }

setInterval(() => { broadcastAll('ping', { t: Date.now() }); leaguesChanged(); }, 15000).unref();

function snapshot() {
  const seasonAdvice = {};
  for (const [kind, rec] of Object.entries(ST.adv.season.latest)) seasonAdvice[kind] = seasonAdviceEvent(rec);
  return {
    league: leagueView(ST.ctx),
    leagues: leaguesView(),
    board: ST.board,
    session: sessionView(),
    rankingsMeta: ST.rankingsMeta,
    rankings: ST.rankings,
    advice: ST.adv.latest ? adviceEvent(ST.adv.latest) : null,
    adviceInflight: ST.adv.inflight ? { seq: ST.adv.inflight.seq, basedOn: ST.adv.inflight.basedOn, buffer: ST.adv.inflight.buffer, pickLine: ST.adv.inflight.pickLine } : null,
    status: pollStatus(),
    season: ST.season.view,
    seasonAdvice,
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
    const ctx = resolveCtx(url, req);      // which league this request is about
    activate(ctx);                         // (re-activated again after every await below)

    // ---- league registry ----
    if (p === '/api/leagues' && req.method === 'GET') return json(res, 200, leaguesView());
    if (p === '/api/leagues' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const c = createLeague(String(body.name || '').trim().slice(0, 60) || null);
      log(`league created: ${c.id}${c.name ? ` "${c.name}"` : ''}`);
      leaguesChanged();
      return json(res, 200, { ok: true, league: leagueView(c) });
    }
    if (p === '/api/leagues/rename' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const c = ST.leagues.get(String(body.id || ctx.id));
      if (!c) return json(res, 404, { error: 'no such league' });
      c.name = String(body.name || '').trim().slice(0, 60) || null;
      saveRegistry(); leaguesChanged();
      return json(res, 200, { ok: true, league: leagueView(c) });
    }
    if (p === '/api/leagues/active' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const id = String(body.id || ctx.id);
      if (!ST.leagues.has(id)) return json(res, 404, { error: 'no such league' });
      ST.registry.active = id; saveRegistry(); leaguesChanged();
      return json(res, 200, { ok: true, active: id });
    }
    if (p === '/api/leagues/remove' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const id = String(body.id || '');
      if (id === 'main') return json(res, 400, { error: 'the main league cannot be removed (reset it instead)' });
      if (!removeLeague(id)) return json(res, 404, { error: 'no such league' });
      log(`league removed: ${id}`);
      leaguesChanged();
      return json(res, 200, { ok: true });
    }

    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      ctx.sse.add(res);
      sseWrite(res, 'snapshot', snapshot());
      req.on('close', () => ctx.sse.delete(res));
      req.on('error', () => ctx.sse.delete(res));
      res.on('error', () => ctx.sse.delete(res));
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
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const meta = importRankings(body.csvText, body.name);
      computeBoard();
      broadcast('rankings', { meta, rankings: ST.rankings });
      broadcast('board', ST.board);
      prewarmCache();                       // fire-and-forget
      return json(res, 200, meta);
    }

    if (p === '/api/draft' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      if (body.source === 'espn') {
        const leagueId = String(body.league_id || '').trim();
        if (!/^\d{3,25}$/.test(leagueId)) return json(res, 400, { error: 'league_id must be the numeric ESPN league id (from the league URL: leagueId=…)' });
        const season = Number(body.season) || espnSeasonDefault();
        const prevEspn = ST.session.espn || {};
        // cookies: new values win; blank keeps whatever was stored (or env)
        const s2 = String(body.espn_s2 || '').trim() || prevEspn.espn_s2 || null;
        let swid = String(body.swid || '').trim() || prevEspn.swid || null;
        if (swid && !swid.startsWith('{')) swid = `{${swid.replace(/[{}]/g, '')}}`;
        ST.session.espn = { ...prevEspn, espn_s2: s2, swid };
        let raw;
        const headers = espnHeaders();
        try {
          await loadEspnPlayers(season); activate(ctx);
          raw = await fetchJson(espnLeagueUrl(leagueId, season), { headers }, 12000); activate(ctx);
        } catch (e) {
          activate(ctx);
          ST.session.espn = prevEspn;
          const hint = e.status === 401 || e.status === 403 ? ' — private league? paste espn_s2 + SWID cookies' : (e.status === 404 ? ' — check league id / season' : '');
          return json(res, 502, { error: `could not fetch ESPN league: ${e.message}${hint}` });
        }
        const teamId = body.team_id != null && body.team_id !== '' ? Number(body.team_id) : null;
        let conv = espnToDraft(raw, { teamId });
        if (conv.unknownIds.length) { try { await espnLookupIds(leagueId, season, conv.unknownIds, headers); activate(ctx); conv = espnToDraft(raw, { teamId }); } catch (e) { activate(ctx); warn('espn id lookup failed:', e.message); } }
        // validated: commit
        ST.session.source = 'espn';
        ST.session.draft_id = `espn:${leagueId}`;
        ST.session.espn = { ...ST.session.espn, league_id: leagueId, season, team_id: teamId };
        ST.session.my_slot = conv.mySlot || Number(body.my_slot) || null;
        saveJson('session.json', ST.session);
        ST.draft = { meta: conv.meta, picks: conv.picks, anomalies: [], status: conv.meta.status };
        ST.adv.latest = null; ST.adv.prevOnClock = false; ST.adv.extForce = false; ST.adv.extNeedSince = null; if (ST.adv.inflight) abortInflight('draft-changed');
        computeVorp(); rebuildStaticPrefix(); computeBoard();
        prewarmCache();
        startPolling(true);
        broadcast('board', ST.board);
        broadcast('status', pollStatus());
        broadcast('session', sessionView());
        leaguesChanged(); return json(res, 200, {
          ok: true, source: 'espn', status: ST.draft.status, league_name: conv.meta.metadata.name, order_set: conv.meta.order_set,
          meta: { teams: conv.meta.settings.teams, rounds: conv.meta.settings.rounds, type: conv.meta.type, scoring: conv.meta.metadata.scoring_type },
          teams: conv.teams, my_slot: ST.session.my_slot, picks: conv.picks.length, unknown: conv.unknownIds.length,
        });
      }
      const draftId = String(body.draft_id || '').trim();
      if (!/^\d{5,25}$/.test(draftId)) return json(res, 400, { error: 'draft_id must be the numeric Sleeper draft id' });
      let meta;
      try {
        meta = await fetchJson(`${SLEEPER_BASE}/draft/${draftId}`, {}, 10000); activate(ctx);
      } catch (e) { activate(ctx); return json(res, 502, { error: `could not fetch draft: ${e.message}` }); }
      // validated: now commit the session change
      ST.session.source = 'sleeper';
      ST.session.draft_id = draftId;
      ST.session.my_slot = Number(body.my_slot) || null;
      saveJson('session.json', ST.session);
      ST.draft = { meta, picks: [], anomalies: [], status: meta.status };
      ST.adv.latest = null; ST.adv.prevOnClock = false; ST.adv.extForce = false; ST.adv.extNeedSince = null; if (ST.adv.inflight) abortInflight('draft-changed');
      computeVorp(); rebuildStaticPrefix(); computeBoard();
      prewarmCache();                       // fire-and-forget
      startPolling(true);
      broadcast('board', ST.board);
      broadcast('status', pollStatus());
      leaguesChanged(); return json(res, 200, { ok: true, status: ST.draft.status, meta: { teams: ST.draft.meta.settings.teams, rounds: ST.draft.meta.settings.rounds, type: ST.draft.meta.type } });
    }

    if (p === '/api/slot' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      ST.session.my_slot = Number(body.my_slot) || null;
      if (ST.session.source === 'espn') {
        // ESPN: the slot select carries team ids when the order isn't set yet; keep team_id in sync either way
        const teams = (ST.draft.meta && ST.draft.meta.espn_teams) || [];
        let t = body.team_id != null && body.team_id !== '' ? teams.find(x => x.id === Number(body.team_id)) : null;
        if (!t && ST.session.my_slot) t = teams.find(x => x.slot === ST.session.my_slot) || null;
        ST.session.espn = { ...(ST.session.espn || {}), team_id: t ? t.id : (body.team_id != null && body.team_id !== '' ? Number(body.team_id) : null) };
        if (t && t.slot) ST.session.my_slot = t.slot;
      }
      saveJson('session.json', ST.session);
      broadcast('session', sessionView());
      computeBoard(); broadcast('board', ST.board);
      advisorOnBoardChange();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/mark' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      if (!body.player_id) return json(res, 400, { error: 'player_id required' });
      if (body.drafted) ST.session.manual[body.player_id] = true;
      else delete ST.session.manual[body.player_id];
      saveJson('session.json', ST.session);
      computeBoard(); broadcast('board', ST.board);
      broadcast('session', sessionView());
      return json(res, 200, { ok: true });
    }

    if (p === '/api/note' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      if (!body.player_id) return json(res, 400, { error: 'player_id required' });
      if (body.note) ST.session.notes[body.player_id] = String(body.note).slice(0, 300);
      else delete ST.session.notes[body.player_id];
      saveJson('session.json', ST.session);
      broadcast('session', sessionView());
      return json(res, 200, { ok: true });
    }

    if (p === '/api/advise/refresh' && req.method === 'POST') {
      if (ADVISOR === 'external') {
        // keep the last rec on screen (shown with an "updating" spinner) while
        // the external advisor redoes it — blanking the panel mid-draft is worse
        ST.adv.extForce = true;                 // watcher fires even outside the window
        ST.adv.extNeedSince = Date.now();
        if (ST.board) advisorOnBoardChange();
        return json(res, 200, { ok: true, external: true });
      }
      if (ST.adv.inflight) abortInflight('manual-refresh');
      ST.adv.latest = null;
      if (ST.board) startAdvice(ST.board);
      return json(res, 200, { ok: true });
    }

    // ---- external advisor (Claude Code session or manual paste) ----
    if (p === '/api/advisor/context') {
      const b = ST.board;
      const out = {
        advisor: ADVISOR,
        needAdvice: externalNeedAdvice(),
        status: b ? b.status : (ST.draft.status || null),
        draftId: ST.session.draft_id, mySlot: ST.session.my_slot,
        rankingsLoaded: ST.rankings.length,
        pickCount: b ? b.pickCount : null,
        currentPickNo: b ? b.currentPickNo : null,
        currentRound: b ? b.currentRound : null,
        picksUntilMine: b ? b.picksUntilMine : null,
        onClock: b ? b.onClock : false,
        myNextPickNo: b ? b.myNextPickNo : null,
        latestBasedOn: ST.adv.latest ? ST.adv.latest.basedOn : null,
        degraded: ST.poll.degraded,
      };
      // in-season block: pending questions for the season watcher (draft fields above are untouched)
      out.season = {
        connected: !!ST.session.league_id && !!ST.season.view,
        week: ST.season.nfl.week, token: seasonToken(),
        pending: seasonNeedAdvice(),
      };
      const kind = url.searchParams.get('kind');
      if (kind && SEASON_KINDS.has(kind)) {
        const pending = ST.adv.season.pending[kind];
        out.kind = kind;
        out.basedOn = seasonToken();
        out.params = pending ? pending.params || null : null;
        if (!out.params && url.searchParams.get('params')) {   // 📋 copy without a queued ask
          try { out.params = JSON.parse(url.searchParams.get('params')); } catch { /* ignore */ }
        }
        if (url.searchParams.get('prompt') === '1') out.prompt = buildSeasonPrompt(kind, out.params);
        if (url.searchParams.get('full') === '1') out.briefing = buildSeasonBriefing();
        return json(res, 200, out);
      }
      if (url.searchParams.get('prompt') === '1' && b && ST.rankings.length) out.prompt = buildDynamicMessage(b);
      if (url.searchParams.get('full') === '1') {
        if (!ST.staticPrefix) rebuildStaticPrefix();
        out.briefing = ST.staticPrefix;
      }
      return json(res, 200, out);
    }

    if (p === '/api/advisor/submit' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const text = String(body.text || '');
      if (!text.trim()) return json(res, 400, { error: 'text required' });
      // season kinds take their own path; absent/draft kind falls through to the draft path unchanged
      if (body.kind && SEASON_KINDS.has(body.kind)) {
        const kind = body.kind;
        const parsed = parseAdviceJson(text);
        const am = text.match(/ADVICE:\s*([^\n]+)/);
        const adviceLine = am ? am[1].trim() : null;
        if (!parsed && !adviceLine) return json(res, 400, { error: 'unrecognized format — need an "ADVICE: <summary>" line and/or the ```json block' });
        const basedOn = body.basedOn != null ? String(body.basedOn) : seasonToken();
        const seq = ++ST.adv.seq;
        const pending = ST.adv.season.pending[kind];
        const startedAt = pending ? pending.since : Date.now();
        const rec = { kind, seq, basedOn, text, parsed, adviceLine, external: true, completedAt: Date.now() };
        ST.adv.season.latest[kind] = rec;
        delete ST.adv.season.pending[kind];
        ST.adv.season.history.push({ kind, week: seasonWeek(), adviceLine, at: Date.now() });
        if (ST.adv.season.history.length > 120) ST.adv.season.history.splice(0, ST.adv.season.history.length - 120);
        saveJson('season-advice.json', { latest: ST.adv.season.latest, history: ST.adv.season.history });
        ST.adv.latency.push({ seq, basedOn, startedAt, ttfe: null, ttft: null, total: Date.now() - startedAt, aborted: null, error: null, cacheRead: null, cacheWrite: null, inputTokens: null, outputTokens: null, mock: false, external: true, kind });
        if (ST.adv.latency.length > 300) ST.adv.latency.splice(0, ST.adv.latency.length - 300);
        if (ST.season.view) { ST.season.view.advicePending = Object.keys(ST.adv.season.pending); broadcast('season', ST.season.view); }
        broadcast('season_advice', { kind, rec: seasonAdviceEvent(rec) });
        log(`season advice #${seq} submitted (kind=${kind}, basedOn=${basedOn}, now=${seasonToken()})`);
        return json(res, 200, { ok: true, seq, kind, basedOn, stale: basedOn !== seasonToken(), pending: seasonNeedAdvice().map(x => x.kind) });
      }
      const parsed = parseAdviceJson(text);
      const pm = text.match(/PICK:\s*([^\n]+)/);
      const pickLine = pm ? pm[1].trim() : null;
      if (!parsed && !pickLine) return json(res, 400, { error: 'unrecognized format — need a "PICK: Name (POS, TEAM)" line and/or the ```json block' });
      const b = ST.board;
      const basedOn = Number.isFinite(Number(body.basedOn)) ? Number(body.basedOn) : (b ? b.pickCount : 0);
      const seq = ++ST.adv.seq;
      const startedAt = ST.adv.extNeedSince || Date.now();
      const rec = {
        seq, basedOn, text, parsed, pickLine, external: true, completedAt: Date.now(),
        timings: { ttft: null, total: Date.now() - startedAt, cacheRead: null },
      };
      ST.adv.latest = rec;
      ST.adv.extNeedSince = null;
      ST.adv.extForce = false;
      ST.adv.latency.push({ seq, basedOn, startedAt, ttfe: null, ttft: null, total: rec.timings.total, aborted: null, error: null, cacheRead: null, cacheWrite: null, inputTokens: null, outputTokens: null, mock: false, external: true, speculative: !(b && b.onClock) });
      if (ST.adv.latency.length > 300) ST.adv.latency.splice(0, ST.adv.latency.length - 300);
      broadcast('advice', adviceEvent(rec));
      if (b && b.onClock) markVisible('external-submitted');
      log(`external advice #${seq} submitted (basedOn=${basedOn}${b ? `, board at ${b.pickCount}` : ''})`);
      return json(res, 200, { ok: true, seq, pickCount: b ? b.pickCount : null, stale: !!(b && basedOn < b.pickCount), needAdvice: externalNeedAdvice() });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      // draft reset must NOT disconnect the league — league fields carry over
      const keptEspn = ST.session.espn || {};
      ST.session = {
        draft_id: null, my_slot: null, manual: {}, notes: {}, source: 'sleeper',
        // ESPN cookies survive a draft reset (re-pasting them is the annoying part); league/team do not
        espn: { league_id: null, season: null, team_id: null, espn_s2: keptEspn.espn_s2 || null, swid: keptEspn.swid || null },
        league_id: ST.session.league_id, my_roster_id: ST.session.my_roster_id, my_user_id: ST.session.my_user_id,
      };
      saveJson('session.json', ST.session);
      ST.draft = { meta: null, picks: [], anomalies: [], status: null };
      ST.board = null; ST.adv.latest = null; ST.adv.prevOnClock = false; ST.adv.turn = null; ST.adv.extForce = false; ST.adv.extNeedSince = null;
      if (ST.adv.inflight) abortInflight('reset');
      clearTimeout(ST.poll.timer); ST.poll.running = false; ST.poll.failures = 0; ST.poll.degraded = false;
      broadcast('board', null); broadcast('status', pollStatus());
      return json(res, 200, { ok: true });
    }

    // ---- season routes ----
    if (p === '/api/league' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const leagueId = String(body.league_id || '').trim();
      if (!/^\d{5,25}$/.test(leagueId)) return json(res, 400, { error: 'league_id must be the numeric Sleeper league id' });
      let league, users, rosters;
      try {
        [league, users, rosters] = await Promise.all([
          fetchJson(`${SLEEPER_REAL}/league/${leagueId}`, {}, 10000),
          fetchJson(`${SLEEPER_REAL}/league/${leagueId}/users`, {}, 10000),
          fetchJson(`${SLEEPER_REAL}/league/${leagueId}/rosters`, {}, 10000),
        ]); activate(ctx);
      } catch (e) { activate(ctx); return json(res, 502, { error: `could not fetch league: ${e.message}` }); }
      // validated: commit
      ST.session.league_id = leagueId;
      saveJson('session.json', ST.session);
      const se = ST.season;
      se.league = league; se.users = users; se.rosters = rosters;
      se.poll.tick = 0; se.sig = {};    // force full refetch tiers on next poll
      const userById = new Map(users.map(u => [u.user_id, u]));
      const teams = rosters.map(r => {
        const u = userById.get(r.owner_id);
        return { roster_id: r.roster_id, name: (u && ((u.metadata && u.metadata.team_name) || u.display_name)) || `Roster ${r.roster_id}`, owner: u ? u.display_name : null };
      });
      // guess my roster from the completed draft's slot->roster mapping if available
      let guess = null;
      const dm = ST.draft.meta;
      if (dm && dm.league_id === leagueId && dm.slot_to_roster_id && ST.session.my_slot) {
        guess = dm.slot_to_roster_id[ST.session.my_slot] || null;
      }
      computeSeason();
      startSeasonPolling();
      broadcast('season', se.view);
      leaguesChanged(); return json(res, 200, { ok: true, name: league.name, teams, guess, week: se.nfl.week });
    }

    if (p === '/api/league/me' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const rid = Number(body.roster_id) || null;
      ST.session.my_roster_id = rid;
      const r = rid ? ST.season.rosters.find(x => x.roster_id === rid) : null;
      ST.session.my_user_id = r ? r.owner_id : null;
      saveJson('session.json', ST.session);
      computeSeason();
      broadcast('season', ST.season.view);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/season') return json(res, 200, ST.season.view || { error: 'no league connected' });

    if (p === '/api/season/refresh' && req.method === 'POST') {
      if (!ST.session.league_id) return json(res, 400, { error: 'no league connected' });
      if (SEASON_FIXTURE) { computeSeason(); broadcast('season', ST.season.view); return json(res, 200, { ok: true, fixture: true }); }
      clearTimeout(ST.season.poll.timer);
      seasonPollOnce(true).catch(e => warn('forced season poll failed:', e.message));
      return json(res, 200, { ok: true });
    }

    if (p === '/api/season/reset' && req.method === 'POST') {
      ST.session.league_id = null; ST.session.my_roster_id = null; ST.session.my_user_id = null;
      saveJson('session.json', ST.session);
      clearTimeout(ST.season.poll.timer); ST.season.poll.running = false; ST.season.poll.failures = 0; ST.season.poll.degraded = false;
      ST.season.league = null; ST.season.users = []; ST.season.rosters = []; ST.season.matchups = null;
      ST.season.transactions = []; ST.season.view = null; ST.season.sig = {};
      ST.adv.season.pending = {};
      broadcast('season', null);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/season/ask' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      const kind = String(body.kind || '');
      if (!SEASON_KINDS.has(kind)) return json(res, 400, { error: `kind must be one of: ${[...SEASON_KINDS].join(', ')}` });
      if (!ST.season.view) return json(res, 400, { error: 'no league connected' });
      if (kind === 'trade' && body.params && body.params.mode !== 'scan') {
        const ev = computeTradeEval(body.params || {});
        if (ev.error) return json(res, 400, { error: ev.error });
      }
      ST.adv.season.pending[kind] = { since: Date.now(), params: body.params || null };
      ST.season.view.advicePending = Object.keys(ST.adv.season.pending);
      broadcast('season', ST.season.view);
      broadcast('season_advice', { kind, phase: 'pending', basedOn: seasonToken() });
      log(`season advice requested: ${kind}${body.params ? ' ' + JSON.stringify(body.params).slice(0, 120) : ''}`);
      return json(res, 200, { ok: true, kind, basedOn: seasonToken(), pending: Object.keys(ST.adv.season.pending) });
    }

    if (p === '/api/season/alerts/clear' && req.method === 'POST') {
      ST.season.alerts = [];
      saveSeason();
      if (ST.season.view) { ST.season.view.alerts = []; broadcast('season', ST.season.view); }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/season/trade/eval' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)); activate(ctx);
      if (!ST.season.view) return json(res, 400, { error: 'no league connected' });
      const ev = computeTradeEval(body || {});
      if (ev.error) return json(res, 400, { error: ev.error });
      return json(res, 200, ev);
    }

    // debug endpoints — replay/test mode only
    if (p.startsWith('/api/debug/') && (REPLAY || MOCK_LLM || SEASON_FIXTURE)) {
      if (p === '/api/debug/kill-llm' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)); activate(ctx);
        ST.adv.killLLM = !!body.on;
        if (ST.adv.killLLM && ST.adv.inflight) abortInflight('killed');
        log(`debug: LLM kill switch ${ST.adv.killLLM ? 'ON' : 'OFF'}`);
        return json(res, 200, { killLLM: ST.adv.killLLM });
      }
      if (p === '/api/debug/stats') {
        return json(res, 200, { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, sseClients: ST.sse.size, uptime: process.uptime() });
      }
      if (p === '/api/debug/prompt') {
        const kind = url.searchParams.get('kind');
        if (kind && SEASON_KINDS.has(kind)) {
          return json(res, 200, { briefing: buildSeasonBriefing(), prompt: buildSeasonPrompt(kind, kind === 'trade' && url.searchParams.get('mode') === 'scan' ? { mode: 'scan' } : null) });
        }
        return json(res, 200, { staticPrefix: ST.staticPrefix, dynamic: ST.board ? buildDynamicMessage(ST.board) : null });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    warn('request error:', req.url, e.message);
    try { json(res, 500, { error: e.message }); } catch { /* headers sent */ }
  }
});

// Pure functions exported for tools/selftest.js; requiring this file does not
// start the server unless it is the entry point.
module.exports = {
  normName, normPos, normTeam, parseCsv, pickToSlot, rosterNeeds, draftSlots, lev, ST,
  resolvePlayer, buildNameIndex, COL_PATTERNS, externalNeedAdvice, parseAdviceJson, ADVISOR,
  espnToDraft, espnLeagueUrl, espnHeaders, espnSeasonDefault, fetchEspnLeague, loadEspnPlayers, espnLookupIds, espnPlayers, sessionView, fetchJson, loadPlayers,
  activate, withCtx, newCtx, createLeague, removeLeague, leagueName, leagueView, leaguesView,
  // season pure math (selftest + tools)
  optimalLineup, projPoints, parseStatRows, buildValueIndex, lineupInfo, computeLineup,
  computeWaivers, computeNeedProfile, computeTradeEval, computeTradeScan, computeSeason,
  seasonNeedAdvice, seasonToken, startersNeeded, leaguePositions, SEASON_KINDS,
  computePlayoffOdds, computeByePlan, computeRecap, checkInjuryAlerts,
};
if (require.main !== module) return;

process.on('uncaughtException', (e) => { warn('uncaughtException:', e.stack || e.message); });
process.on('unhandledRejection', (e) => { warn('unhandledRejection:', e && (e.stack || e.message || e)); });

(async () => {
  await loadPlayers();
  for (const c of ST.leagues.values()) bootCtx(c);
  log(`leagues: ${[...ST.leagues.values()].map(c => `${c.id}=${JSON.stringify(leagueName(c))}`).join(', ')} (default: ${ST.registry.active})`);
  server.listen(PORT, () => {
    log(`Draft War Room${PROFILE ? ` [profile: ${PROFILE}]` : ''} on http://localhost:${PORT}${REPLAY ? ` [REPLAY via :${REPLAY_PORT}]` : ''}${MOCK_LLM ? ' [MOCK_LLM]' : ''}${SEASON_FIXTURE ? ' [SEASON_FIXTURE]' : ''} effort=${EFFORT}`);
    if (ADVISOR === 'external') log('EXTERNAL ADVISOR mode — advice comes from a Claude session (tools/advisor-watch.js wakes it; POST /api/advisor/submit delivers; 📋 in the UI copies the prompt for manual paste)');
    else if (!process.env.ANTHROPIC_API_KEY && !MOCK_LLM) warn('ANTHROPIC_API_KEY is not set — advisor disabled, fallback board only');
    for (const c of ST.leagues.values()) resumeCtx(c);
  });
})();
