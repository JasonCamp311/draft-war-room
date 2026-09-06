#!/usr/bin/env node
'use strict';
// Multi-league dress rehearsal. Needs a running ESPN mock + a server pointed at it:
//   node tools/espn-mock.js --interval 2 --start-at 5
//   $env:ESPN_BASE="http://127.0.0.1:3998"; $env:PORT="8486"; node server.js
//   node tools/league-dresscheck.js --server http://localhost:8486
// Creates a second league, connects the mock ESPN draft in it, imports rankings,
// verifies the main league is untouched, waits for the multi-league watcher to
// wake for the new league, submits advice with --league, then removes the league.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const SERVER = arg('server', 'http://localhost:8486');
let pass = 0, fail = 0;
const ok = (cond, label, extra) => { if (cond) { pass++; console.log(`PASS ${label}`); } else { fail++; console.log(`FAIL ${label}${extra != null ? ' — ' + JSON.stringify(extra) : ''}`); } };
const get = async (p, league) => { const r = await fetch(`${SERVER}${p}${league ? (p.includes('?') ? '&' : '?') + 'league=' + league : ''}`); return r.json(); };
const post = async (p, body, league) => { const r = await fetch(`${SERVER}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(league ? { 'x-league': league } : {}) }, body: JSON.stringify(body || {}) }); return r.json(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const before = await get('/api/leagues');
  ok(before.leagues.some(l => l.id === 'main'), 'main league present');
  const mainBefore = await get('/api/state');

  const created = await post('/api/leagues', { name: 'Dresscheck ESPN' });
  const id = created.league && created.league.id;
  ok(!!id, 'league created', created);
  const conn = await post('/api/draft', { source: 'espn', league_id: '424242', season: new Date().getFullYear(), team_id: 4 }, id);
  ok(conn.ok && conn.status === 'drafting' && conn.my_slot === 7, 'ESPN connected in the new league (slot 7)', conn);

  const csv = fs.readFileSync(path.join(__dirname, 'sample-rankings.csv'), 'utf8');
  const imp = await post('/api/rankings', { csvText: csv, name: 'sample.csv' }, id);
  ok(imp.rows > 100, 'rankings imported into the new league', imp);

  const st = await get('/api/state', id);
  ok(st.league.id === id && st.board.source === 'espn' && st.board.status === 'drafting', 'new league state is the ESPN draft', st.league);
  ok(st.rankingsMeta && st.rankingsMeta.name === 'sample.csv', 'new league has its own rankings');
  const main = await get('/api/state');
  ok(main.league.id === 'main', 'default request still resolves main');
  ok(JSON.stringify(main.session) === JSON.stringify(mainBefore.session), 'main session untouched');
  ok((main.rankingsMeta && main.rankingsMeta.name) === (mainBefore.rankingsMeta && mainBefore.rankingsMeta.name), 'main rankings untouched');
  ok(main.board && main.board.source === (mainBefore.board && mainBefore.board.source), 'main board untouched');
  const list = await get('/api/leagues');
  const mine = list.leagues.find(l => l.id === id);
  ok(mine && mine.source === 'espn' && mine.draftStatus === 'drafting' && mine.name === 'Dresscheck ESPN', 'league list shows the new league', mine);

  // watcher: no --league -> it must find the new league on its own
  console.log('waiting for the multi-league watcher to wake (mock makes a pick every 2s)...');
  const wake = await new Promise((resolve) => {
    const w = spawn(process.execPath, [path.join(__dirname, 'advisor-watch.js'), '--server', SERVER, '--interval', '500']);
    let out = '';
    w.stdout.on('data', d => out += d);
    const t = setTimeout(() => { w.kill(); resolve(null); }, 90000);
    w.on('exit', () => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
  ok(wake && wake.reason === 'advice-needed' && wake.league === id, 'watcher woke for the new league', wake && { reason: wake.reason, league: wake.league });
  ok(wake && !!wake.prompt && wake.prompt.includes('CANDIDATES'), 'wake carries the prompt');

  if (wake) {
    const advice = `PICK: ${((wake.prompt.match(/CANDIDATES[\s\S]*?\n- ([^\n(]+)/) || [])[1] || 'Someone').trim()} (RB, DAL)\n\`\`\`json\n{"pick":"x","reason":"dresscheck"}\n\`\`\`\n`;
    const r = await fetch(`${SERVER}/api/advisor/submit?league=${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ basedOn: wake.pickCount, text: advice }) });
    const sub = await r.json();
    ok(sub.ok, 'advice submitted with ?league=', sub);
    const after = await get('/api/state', id);
    ok(after.advice && after.advice.basedOn === wake.pickCount, 'advice landed in the new league');
    const mainAfter = await get('/api/state');
    ok(JSON.stringify(mainAfter.advice) === JSON.stringify(mainBefore.advice), 'main advice untouched');
  }

  await sleep(2500);
  const st2 = await get('/api/state', id);
  ok(st2.board.pickCount > st.board.pickCount, 'new league keeps polling in the background', { before: st.board.pickCount, after: st2.board.pickCount });

  const rm = await post('/api/leagues/remove', { id });
  ok(rm.ok, 'league removed');
  const list2 = await get('/api/leagues');
  ok(!list2.leagues.some(l => l.id === id), 'removed league gone from the list');
  try { fs.rmSync(path.join(__dirname, '..', 'data', 'leagues', id), { recursive: true, force: true }); } catch { /* fine */ }
  console.log(`\nleague-dresscheck: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('dresscheck error:', e.stack || e.message); process.exitCode = 1; });
