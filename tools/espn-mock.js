#!/usr/bin/env node
'use strict';
// Mock ESPN fantasy API for a live-draft dress rehearsal without an ESPN league.
//   node tools/espn-mock.js --interval 12 [--teams 10] [--port 3998] [--start-at 0]
//   $env:ESPN_BASE = "http://127.0.0.1:3998"; node server.js
//   UI: source ESPN, league ID 424242, season <this year>, any slot -> Connect.
// Picks are made from the real Sleeper players cache (best search_rank first, with
// a little jitter) so name->Sleeper-id resolution is exercised for real. ESPN ids
// here are synthetic (100000 + n); D/ST rows use negative ids like ESPN does.
// Controls: POST /control/pause | /control/resume | /control/release {"n":1} | GET /control/status
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildLeague, playerRow } = require('./espn-fixture.js');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('--port', 3998));
const INTERVAL = Number(arg('--interval', 15)) * 1000;
const TEAMS = Number(arg('--teams', 10));
const START_AT = Number(arg('--start-at', 0));
const DST_TEAM = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };
const TEAM_ID = Object.fromEntries(Object.entries(DST_TEAM).map(([k, v]) => [v, Number(k)]));
const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DEF: 16 };

// player pool from the Sleeper cache
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'players-cache.json'), 'utf8'));
const pool = Object.entries(cache.players).filter(([, p]) => p.t && p.sr < 400 && p.p !== 'DEF').sort((a, b) => a[1].sr - b[1].sr);
const dsts = Object.entries(cache.players).filter(([, p]) => p.p === 'DEF');
const dir = [];   // players_wl rows
const order = [];  // draft order of espn ids
pool.forEach(([, p], i) => { const id = 100000 + i; dir.push(playerRow(id, p.n, POS_ID[p.p] || 3, TEAM_ID[p.t] || 0)); order.push(id); });
dsts.forEach(([code, p], i) => { const id = -16000 - i; const words = p.n.split(' '); dir.push(playerRow(id, `${words[words.length - 1]} D/ST`, 16, TEAM_ID[code] || 0)); });
// K/DEF late: rebuild order with light jitter, DSTs sprinkled into the tail
const jittered = order.map((id, i) => [id, i + Math.random() * 6]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
const dstIds = dir.filter(r => r.defaultPositionId === 16).map(r => r.id);
const kIds = jittered.filter(id => dir.find(r => r.id === id).defaultPositionId === 5);
const skill = jittered.filter(id => !kIds.includes(id));
const total = TEAMS * 15;
const late = [...dstIds, ...kIds].sort(() => Math.random() - 0.5);
const script = [...skill.slice(0, total - 2 * TEAMS), ...late].slice(0, total);

let made = Math.min(START_AT, script.length), paused = false;
const picks = () => script.slice(0, made).map(playerId => ({ playerId }));
const league = () => buildLeague({ teams: TEAMS, picks: picks(), leagueId: 424242, season: new Date().getFullYear(), name: 'Mock ESPN League' });

function tick() { if (!paused && made < total) { made++; console.log(`pick #${made}: ${dir.find(r => r.id === script[made - 1]).fullName}`); } setTimeout(tick, INTERVAL); }
setTimeout(tick, INTERVAL);

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (u.pathname === '/control/pause') { paused = true; return send(res, 200, { paused }); }
    if (u.pathname === '/control/resume') { paused = false; return send(res, 200, { paused }); }
    if (u.pathname === '/control/release') { const n = Number((body && JSON.parse(body).n) || 1); made = Math.min(total, made + n); return send(res, 200, { made }); }
    if (u.pathname === '/control/status') return send(res, 200, { made, total, paused });
    if (/\/seasons\/\d+\/players$/.test(u.pathname)) return send(res, 200, dir);
    if (/\/seasons\/\d+\/segments\/0\/leagues\/424242$/.test(u.pathname)) {
      if (u.searchParams.getAll('view').includes('kona_player_info')) {
        const f = JSON.parse(req.headers['x-fantasy-filter'] || '{}');
        const ids = ((f.players || {}).filterIds || {}).value || [];
        return send(res, 200, { players: dir.filter(r => ids.includes(r.id)).map(r => ({ id: r.id, player: r })) });
      }
      return send(res, 200, league());
    }
    if (/\/leagues\/\d+$/.test(u.pathname)) return send(res, 404, { messages: ['League not found'] });
    send(res, 404, { error: 'mock: unknown ' + u.pathname });
  });
}).listen(PORT, () => console.log(`ESPN mock on http://127.0.0.1:${PORT} — league 424242, ${TEAMS} teams, ${total} picks, one every ${INTERVAL / 1000}s (starting at ${made})`));
