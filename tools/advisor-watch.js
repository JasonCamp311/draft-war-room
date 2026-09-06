#!/usr/bin/env node
'use strict';
/*
 * External-advisor watcher. Polls the war-room server until a recommendation
 * is wanted (within the speculative window with no current rec, or a manual ↻),
 * then prints the advisor context — including the ready-to-answer prompt — as
 * JSON on stdout and EXITS. Run it in the background from a Claude Code
 * session: the exit wakes the session, which generates advice and delivers it
 * with tools/advisor-submit.js, then restarts the watcher.
 *
 *   node tools/advisor-watch.js [--server http://localhost:8484] [--interval 1500]
 *
 * SEASON MODE (--season): watches for queued in-season questions instead of
 * draft picks. Wakes (prints JSON + exits 0) when any advice kind is pending
 * ("Ask Claude" in the UI / POST /api/season/ask); the printed object carries
 * reason 'season-advice-needed' plus kind, basedOn token, params, prompt and
 * briefing. Draft completion does NOT terminate a season watch.
 *
 * Exit 0: advice needed, or draft complete (see "reason" in the printed JSON).
 * Exit 2: server unreachable for >45s.
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const SERVER = arg('server', 'http://localhost:8484');
const SEASON = args.includes('--season');
const INTERVAL = Math.max(300, Number(arg('interval', SEASON ? 3000 : 1500)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let downSince = null;
  let announced = false;
  for (;;) {
    let ctx;
    try {
      const r = await fetch(`${SERVER}/api/advisor/context`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      ctx = await r.json();
      downSince = null;
    } catch (e) {
      downSince = downSince || Date.now();
      if (Date.now() - downSince > 45000) {
        console.log(JSON.stringify({ reason: 'server-down', server: SERVER, error: e.message }));
        process.exitCode = 2;                  // no process.exit(): racing live fetch
        return;                                // handles crashes libuv on Windows
      }
      await sleep(2000);
      continue;
    }
    if (!announced) {
      announced = true;
      if (SEASON) console.error(`watching ${SERVER} [SEASON] — league ${ctx.season && ctx.season.connected ? 'connected, week ' + ctx.season.week : '(not connected)'}, advisor=${ctx.advisor}`);
      else console.error(`watching ${SERVER} — draft ${ctx.draftId || '(not connected)'}, slot ${ctx.mySlot || '?'}, advisor=${ctx.advisor}, status=${ctx.status}`);
    }
    if (SEASON) {
      const pending = (ctx.season && ctx.season.pending) || [];
      if (pending.length) {
        const q = pending[0];                       // oldest first (server sorts by since)
        let full = { season: ctx.season };
        try {
          const r2 = await fetch(`${SERVER}/api/advisor/context?kind=${q.kind}&prompt=1&full=1`, { signal: AbortSignal.timeout(8000) });
          if (r2.ok) full = await r2.json();
        } catch { /* context without prompt is still actionable */ }
        console.log(JSON.stringify({
          reason: 'season-advice-needed', kind: q.kind, basedOn: q.basedOn, params: q.params,
          alsoPending: pending.slice(1).map(x => x.kind),
          prompt: full.prompt || null, briefing: full.briefing || null,
        }, null, 1));
        return;
      }
      await sleep(INTERVAL);
      continue;
    }
    if (ctx.status === 'complete') {
      console.log(JSON.stringify({ reason: 'draft-complete', ...ctx }));
      return;
    }
    if (ctx.needAdvice) {
      // second fetch grabs the prompt (kept off the cheap poll)
      try {
        const r2 = await fetch(`${SERVER}/api/advisor/context?prompt=1`, { signal: AbortSignal.timeout(5000) });
        if (r2.ok) ctx = await r2.json();
      } catch { /* context without prompt is still actionable */ }
      console.log(JSON.stringify({ reason: 'advice-needed', ...ctx }, null, 1));
      return;
    }
    await sleep(INTERVAL);
  }
})();
