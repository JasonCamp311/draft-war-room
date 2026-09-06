#!/usr/bin/env node
'use strict';
// Prints the snippet that turns a logged-in ESPN browser tab into a relay: every
// few seconds it fetches the league document with the browser's own cookies
// (espn_s2 is HttpOnly, so nothing has to be copied out of DevTools) and POSTs it
// to the war room. Paste it into the DevTools console of any fantasy.espn.com
// tab and leave that tab open for the draft.
//   node tools/espn-relay.js --league 1730514844 [--season 2026] [--server http://localhost:8484] [--every 3]
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const league = arg('league'); if (!league) { console.error('usage: node tools/espn-relay.js --league <id> [--season YYYY] [--server URL] [--every SEC]'); process.exitCode = 2; return; }
const season = Number(arg('season', new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1));
const server = arg('server', 'http://localhost:8484');
const every = Math.max(2, Number(arg('every', 3)));
console.log(relaySnippet(league, season, server, every));
function relaySnippet(league, season, server, every) {
  return `(() => {
  const URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mDraftDetail&view=mSettings&view=mTeam';
  const TARGET = '${server}/api/espn/relay';
  if (window.__warRoomRelay) clearInterval(window.__warRoomRelay);
  window.__warRoomRelayStats = { ok: 0, fail: 0, last: null, lastErr: null, picks: null };
  const tick = async () => {
    const s = window.__warRoomRelayStats;
    try {
      const r = await fetch(URL, { credentials: 'include' });
      if (!r.ok) throw new Error('ESPN HTTP ' + r.status);
      const raw = await r.json();
      const w = await fetch(TARGET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league_id: '${league}', season: ${season}, raw }) });
      if (!w.ok) throw new Error('war room HTTP ' + w.status);
      const j = await w.json(); s.ok++; s.last = Date.now(); s.picks = j.picks; s.lastErr = null;
    } catch (e) { s.fail++; s.lastErr = e.message; }
  };
  tick();
  window.__warRoomRelay = setInterval(tick, ${every * 1000});
  return 'war room relay armed: league ${league} -> ${server} every ${every}s (stats in window.__warRoomRelayStats)';
})()`;
}
module.exports = { relaySnippet };
