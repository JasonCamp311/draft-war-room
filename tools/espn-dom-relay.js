#!/usr/bin/env node
'use strict';
// ESPN's league document does NOT list picks while a draft is live, and the draft
// room allows only ONE connection per account — so the feed has to come from the
// user's own draft-room tab. This prints a snippet to paste into that tab's
// DevTools console: it scrapes picks from the page (the Activity feed on the
// right, which is visible on every tab, plus the Pick History table when open),
// merges them into the league document fetched with the tab's own cookies, and
// POSTs it to the war room on the server's tick stream.
//   node tools/espn-dom-relay.js --league 1730514844 [--season 2026] [--server http://localhost:8484]
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const league = arg('league'); if (!league) { console.error('usage: node tools/espn-dom-relay.js --league <id> [--season YYYY] [--server URL]'); process.exitCode = 2; return; }
const season = Number(arg('season', new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1));
const server = arg('server', 'http://localhost:8484');
console.log(domRelaySnippet(league, season, server));
function domRelaySnippet(league, season, server) {
  return `(async () => {
  const API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league}?view=mDraftDetail&view=mSettings&view=mTeam';
  const BASE = '${server}';
  if (window.__wrDom) clearInterval(window.__wrDom);
  if (window.__wrDomTicks) window.__wrDomTicks.close();
  window.__wrDomStats = { ok: 0, fail: 0, last: null, lastErr: null, picks: null, ticks: 0 };
  let doc = null, docAt = 0, busy = false;
  const teamIdByName = new Map();
  const scrape = (size) => {
    const byN = new Map();
    // 1) Activity feed entries: "Name / TEAM POS" over "R3, P1 - Team Name" (visible on every tab)
    for (const el of document.querySelectorAll('div, span, p, li')) {
      if (el.children.length) continue;
      const m = (el.textContent || '').trim().match(/^R(\\d+),\\s*P(\\d+)\\s*-\\s*(.+)$/);
      if (!m) continue;
      let box = el; for (let i = 0; i < 5 && box && !/\\//.test((box.innerText || '').split('\\n')[0]); i++) box = box.parentElement;
      const first = box ? (box.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || '' : '';
      const pm = first.match(/^(.+?)\\s*\\/\\s*([A-Za-z]{2,3})\\s+([A-Za-z\\/]+)$/);
      if (!pm) continue;
      const n = (Number(m[1]) - 1) * size + Number(m[2]);
      byN.set(n, { n, name: pm[1].trim(), proTeam: pm[2].toUpperCase(), position: pm[3].toUpperCase(), teamName: m[3].trim() });
    }
    // 2) Pick History table rows (when that tab is open): pick | Name/TEAM/POS | Team
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const td = [...tr.querySelectorAll('td')];
      if (td.length < 3) continue;
      const n = Number(td[0].innerText.trim());
      if (!Number.isInteger(n) || n < 1 || n > 400) continue;
      const lines = td[1].innerText.split('\\n').map(s => s.trim()).filter(Boolean).filter(s => !/^(Q|O|D|IR|SSPD|P|NA)$/.test(s));
      const teamName = td[2].innerText.trim();
      if (lines.length < 3 || !teamIdByName.has(teamName)) continue;
      byN.set(n, { n, name: lines[0], proTeam: lines[1], position: lines[2], teamName });
    }
    return [...byN.values()].sort((a, b) => a.n - b.n);
  };
  const tick = async () => {
    if (busy) return; busy = true;
    const s = window.__wrDomStats;
    try {
      if (!doc || Date.now() - docAt > 120000) {
        const r = await fetch(API, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('ESPN HTTP ' + r.status);
        doc = await r.json(); docAt = Date.now();
        teamIdByName.clear();
        for (const t of doc.teams || []) teamIdByName.set((t.name || ((t.location || '') + ' ' + (t.nickname || ''))).trim(), t.id);
      }
      const size = (doc.settings && doc.settings.size) || 8;
      const picks = scrape(size).map(p => ({ overallPickNumber: p.n, roundId: Math.ceil(p.n / size), roundPickNumber: ((p.n - 1) % size) + 1, teamId: teamIdByName.get(p.teamName) || 0, playerId: 'dom:' + p.n, playerName: p.name, position: p.position, proTeam: p.proTeam, keeper: false }));
      const drafted = !!(doc.draftDetail && doc.draftDetail.drafted);
      const raw = { ...doc, draftDetail: { ...(doc.draftDetail || {}), inProgress: !drafted, picks } };
      const w = await fetch(BASE + '/api/espn/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league_id: '${league}', season: ${season}, raw }), signal: AbortSignal.timeout(8000) });
      if (!w.ok) throw new Error('war room HTTP ' + w.status);
      const j = await w.json(); s.ok++; s.last = Date.now(); s.picks = j.picks; s.lastErr = null;
    } catch (e) { s.fail++; s.lastErr = e.message; }
    finally { busy = false; }
  };
  const es = new EventSource(BASE + '/api/espn/relay/ticks');
  es.addEventListener('tick', () => { window.__wrDomStats.ticks++; tick(); });
  window.__wrDomTicks = es;
  window.__wrDom = setInterval(tick, 15000);
  await tick();
  return 'war room draft-room relay armed: ' + (window.__wrDomStats.picks ?? '?') + ' picks seen' + (window.__wrDomStats.lastErr ? ' (error: ' + window.__wrDomStats.lastErr + ')' : '');
})()`;
}
module.exports = { domRelaySnippet };
