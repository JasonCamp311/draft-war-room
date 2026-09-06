#!/usr/bin/env node
'use strict';
// Long-lived advisor loop for a Claude Code session: runs advisor-watch.js over
// and over, printing ONE compact JSON line per wake on stdout (suitable for a
// Monitor / log tail), then waits until that league no longer needs advice
// (i.e. the session submitted) before re-arming — so an unanswered wake does not
// spam. Stderr carries chatter.
//   node tools/advisor-loop.js [--server URL] [--interval MS] [--season] [--league ID] [--max-wait-ms 180000]
const { spawn } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const SERVER = arg('server', 'http://localhost:8484');
const SEASON = args.includes('--season');
const MAX_WAIT = Number(arg('max-wait-ms', 180000));
const passthrough = args.filter((a, i) => !(a === '--max-wait-ms' || args[i - 1] === '--max-wait-ms'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function runWatcher() {
  return new Promise((resolve) => {
    const w = spawn(process.execPath, [path.join(__dirname, 'advisor-watch.js'), ...passthrough], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    w.stdout.on('data', d => out += d);
    w.on('exit', (code) => resolve({ code, out }));
  });
}

async function stillNeeds(league) {
  try {
    const r = await fetch(`${SERVER}/api/leagues`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const l = (d.leagues || []).find(x => x.id === league);
    if (!l) return false;
    return SEASON ? !!(l.seasonPending && l.seasonPending.length) : !!l.needAdvice;
  } catch { return false; }
}

(async () => {
  for (;;) {
    const { code, out } = await runWatcher();
    let wake = null;
    try { wake = JSON.parse(out.trim()); } catch { /* not json */ }
    if (!wake) {
      console.error(`advisor-loop: watcher exited ${code} without a wake; retrying in 5s`);
      await sleep(5000);
      continue;
    }
    if (wake.reason === 'server-down') { console.log(JSON.stringify({ reason: 'server-down', at: new Date().toISOString() })); await sleep(10000); continue; }
    console.log(JSON.stringify({ at: new Date().toISOString(), ...wake }));
    // wait for the session to answer (needAdvice clears on submit) before re-arming
    const t0 = Date.now();
    while (Date.now() - t0 < MAX_WAIT && await stillNeeds(wake.league)) await sleep(2000);
    if (Date.now() - t0 >= MAX_WAIT) console.error(`advisor-loop: ${wake.leagueName || wake.league} still unanswered after ${MAX_WAIT / 1000}s — re-arming anyway`);
  }
})();
