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
  // Cadence comes from the server's SSE tick stream: Chrome throttles timers in
  // hidden tabs to once a minute, but events on an open stream are delivered
  // immediately. A slow setInterval remains as a fallback if the stream drops.
  return `(() => {
  const URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mDraftDetail&view=mSettings&view=mTeam';
  const BASE = '${server}';
  if (window.__warRoomRelay) clearInterval(window.__warRoomRelay);
  if (window.__warRoomTicks) window.__warRoomTicks.close();
  window.__warRoomRelayStats = { ok: 0, fail: 0, last: null, lastErr: null, picks: null, ticks: 0 };
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    const s = window.__warRoomRelayStats;
    try {
      const r = await fetch(URL, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('ESPN HTTP ' + r.status);
      const raw = await r.json();
      const w = await fetch(BASE + '/api/espn/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league_id: '${league}', season: ${season}, raw }), signal: AbortSignal.timeout(8000) });
      if (!w.ok) throw new Error('war room HTTP ' + w.status);
      const j = await w.json(); s.ok++; s.last = Date.now(); s.picks = j.picks; s.lastErr = null;
    } catch (e) { s.fail++; s.lastErr = e.message; }
    finally { busy = false; }
  };
  const es = new EventSource(BASE + '/api/espn/relay/ticks?every=${every * 1000}');
  es.addEventListener('tick', () => { window.__warRoomRelayStats.ticks++; tick(); });
  window.__warRoomTicks = es;
  window.__warRoomRelay = setInterval(tick, 20000);
  tick();
  return 'war room relay armed: league ${league} -> ${server} every ${every}s via tick stream (stats in window.__warRoomRelayStats)';
})()`;
}
module.exports = { relaySnippet };
