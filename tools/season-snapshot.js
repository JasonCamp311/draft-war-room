#!/usr/bin/env node
'use strict';
/*
 * Season fixture builder: captures the live Sleeper season endpoints once and
 * writes data/season-fixture.json so everything season-mode can be tested
 * before (or without) real games. Run the server with SEASON_FIXTURE=1 to load
 * it (season polling is disabled in fixture mode).
 *
 *   node tools/season-snapshot.js [--league <id>] [--week N] [--synth]
 *                                 [--records] [--injure pid=Out,pid=Questionable]
 *
 *   --league   league id (default: league_id from data/session.json)
 *   --week     pretend it is week N (weeks 1..N-1 get synthesized actuals)
 *   --synth    fill missing weekly projections from the preseason rank curve
 *              (data/rankings.json), so week-1-sparse projections don't block dev
 *   --records  synthesize W/L records + points onto the rosters
 *   --injure   force injury statuses onto players (edits the fixture's copy only
 *              via an "injuries" map the server applies at load — see server.js)
 *
 * NOTE: --injure writes an "injOverride" map into the fixture; the players
 * cache itself is not touched (it is shared with draft mode).
 */

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const session = JSON.parse(fs.readFileSync(path.join(DATA, 'session.json'), 'utf8'));
const LEAGUE = arg('league', session.league_id);
const WEEK = Number(arg('week', 0)) || null;

if (!LEAGUE) { console.error('no league id: pass --league or connect one in the UI first'); process.exitCode = 1; }

async function j(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// deterministic pseudo-random from a string (stable fixtures between runs)
function seedRand(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

(async () => {
  if (!LEAGUE) return;
  const V1 = 'https://api.sleeper.app/v1';
  const state = await j(`${V1}/state/nfl`);
  const week = WEEK || Math.max(1, Number(state.leg || state.week) || 1);
  const season = String(state.season);
  console.error(`capturing league ${LEAGUE}, season ${season}, week ${week}${WEEK ? ' (forced)' : ''}...`);

  const [league, users, rosters] = await Promise.all([
    j(`${V1}/league/${LEAGUE}`), j(`${V1}/league/${LEAGUE}/users`), j(`${V1}/league/${LEAGUE}/rosters`),
  ]);
  let matchups = [];
  try { matchups = await j(`${V1}/league/${LEAGUE}/matchups/${week}`); } catch (e) { console.error('matchups:', e.message); }
  let transactions = [];
  try { transactions = await j(`${V1}/league/${LEAGUE}/transactions/${week}`); } catch (e) { console.error('transactions:', e.message); }
  const [trendAdd, trendDrop] = await Promise.all([
    j(`${V1}/players/nfl/trending/add?lookback_hours=24&limit=75`).catch(() => []),
    j(`${V1}/players/nfl/trending/drop?lookback_hours=24&limit=75`).catch(() => []),
  ]);

  // projections for the (possibly forced) week — fetched for the REAL current
  // week when forcing, since future weeks may be empty; good enough for testing
  const projWeek = WEEK ? Math.max(1, Number(state.leg || state.week) || 1) : week;
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => `position[]=${p}`).join('&');
  let projRows = [];
  try { projRows = await j(`https://api.sleeper.com/projections/nfl/${season}/${projWeek}?season_type=regular&${pos}`); } catch (e) { console.error('projections:', e.message); }
  const rec = (league.scoring_settings && league.scoring_settings.rec) || 0;
  const key = rec >= 1 ? 'pts_ppr' : rec >= 0.5 ? 'pts_half_ppr' : 'pts_std';
  const byId = {}; let count = 0;
  for (const r of projRows) {
    if (!r || !r.player_id) continue;
    const pts = r.stats && typeof r.stats[key] === 'number' ? r.stats[key] : null;
    byId[r.player_id] = { pts, opp: r.opponent || null };
    if (pts != null) count++;
  }

  // --synth: fill missing projections from the preseason rank curve
  if (has('synth')) {
    let rankings = { rows: [] };
    try { rankings = JSON.parse(fs.readFileSync(path.join(DATA, 'rankings.json'), 'utf8')); } catch { /* none */ }
    const rand = seedRand('synth' + week);
    let filled = 0;
    for (const row of rankings.rows || []) {
      if (!row.player_id) continue;
      const e = byId[row.player_id];
      if (e && e.pts != null) continue;
      // rough weekly points from overall rank, with stable jitter
      const base = Math.max(2, 24 - Math.log2(row.rank + 1) * 2.6);
      byId[row.player_id] = { pts: Math.round((base * (0.85 + rand() * 0.3)) * 10) / 10, opp: (e && e.opp) || 'SYN' };
      filled++; count++;
    }
    console.error(`--synth: filled ${filled} projections from rank curve`);
  }

  // --records: synthesize W/L + points onto roster settings
  if (has('records')) {
    const rand = seedRand('records' + week);
    const played = Math.max(0, week - 1);
    for (const r of rosters) {
      const wins = Math.round(rand() * played);
      r.settings = r.settings || {};
      r.settings.wins = wins; r.settings.losses = played - wins; r.settings.ties = 0;
      r.settings.fpts = Math.round(played * (95 + rand() * 40));
      r.settings.fpts_decimal = Math.round(rand() * 99);
      r.settings.fpts_against = Math.round(played * (95 + rand() * 40));
    }
    console.error(`--records: synthesized ${played}-game records`);
  }

  // synthesized actuals for completed weeks (so PPG/value blending has data)
  const statsByWeek = {};
  const matchupHistory = {};
  if (WEEK && WEEK > 1 && has('synth')) {
    const rand = seedRand('stats');
    for (let w = 1; w < WEEK; w++) {
      const pts = {};
      for (const [pid, e] of Object.entries(byId)) {
        if (e.pts == null) continue;
        pts[pid] = Math.max(0, Math.round((e.pts * (0.5 + rand())) * 10) / 10);
      }
      statsByWeek[w] = pts;
      // synthesized matchup results for those weeks (recap material): pair
      // rosters 1-2, 3-4, ... and score each team's actual starters
      matchupHistory[w] = rosters.map((r, i) => ({
        roster_id: r.roster_id,
        matchup_id: Math.floor(i / 2) + 1,
        starters: r.starters || [],
        players: r.players || [],
        points: Math.round((r.starters || []).reduce((a, pid) => a + (pts[pid] || 0), 0) * 100) / 100,
      }));
    }
    console.error(`synthesized actuals + matchup results for weeks 1..${WEEK - 1}`);
  }

  // --injure pid=Status,...
  const injOverride = {};
  const injArg = arg('injure', null);
  if (injArg) for (const pair of injArg.split(',')) {
    const [pid, status] = pair.split('=');
    if (pid && status) injOverride[pid.trim()] = status.trim();
  }

  let schedule = { byWeek: {}, fetchedAt: Date.now() };
  try {
    const games = await j(`https://api.sleeper.com/schedule/nfl/regular/${season}`);
    for (const g of games || []) {
      if (!g || !g.week || !g.home) continue;
      (schedule.byWeek[g.week] = schedule.byWeek[g.week] || {})[g.home] = { status: g.status, date: g.date, opp: g.away };
      schedule.byWeek[g.week][g.away] = { status: g.status, date: g.date, opp: g.home };
    }
  } catch (e) { console.error('schedule:', e.message); }

  const fixture = {
    capturedAt: new Date().toISOString(),
    league, users, rosters, matchups, transactions,
    nfl: { week, season, season_type: 'regular' },
    proj: { week, byId, fetchedAt: Date.now(), degraded: count < 50, count },
    stats: { byWeek: statsByWeek },
    matchupHistory, schedule,
    trending: { add: trendAdd, drop: trendDrop, fetchedAt: Date.now() },
    injOverride,
    adviceRev: 0,
  };
  fs.writeFileSync(path.join(DATA, 'season-fixture.json'), JSON.stringify(fixture));
  console.log(`wrote data/season-fixture.json — week ${week}, ${count} projections, ${rosters.length} rosters${Object.keys(injOverride).length ? ', ' + Object.keys(injOverride).length + ' injury overrides' : ''}`);
  console.log('run:  SEASON_FIXTURE=1 node server.js   (PowerShell: $env:SEASON_FIXTURE="1"; node server.js)');
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
