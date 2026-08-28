#!/usr/bin/env node
'use strict';
/*
 * Dress-rehearsal checker: connects to the server's SSE feed like the real
 * frontend and verifies the draft-day guarantees end to end:
 *   - a recommendation (or explicit fallback signal) is VISIBLE within
 *     --target seconds (default 5) of every one of my on-clock turns
 *   - zero unmatched picks / unresolved CSV rows / anomalies
 *   - the advisor fails over cleanly when the LLM is killed mid-draft
 *     (--kill-at-round N kills it for --kill-secs, expects fallback signal)
 *   - memory stays stable (RSS sampled over the run)
 * Exits 0 on PASS, 1 on FAIL, prints a full report + latency summary.
 *
 *   node tools/dresscheck.js [--server http://localhost:8484] [--target 5]
 *                            [--kill-at-round 8] [--kill-secs 25]
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const SERVER = arg('server', 'http://localhost:8484');
const TARGET_MS = Number(arg('target', 5)) * 1000;
const KILL_ROUND = Number(arg('kill-at-round', 0));
const KILL_SECS = Number(arg('kill-secs', 25));

const turns = [];        // {pickNo, onClockAt, visibleAt, how, priorReady}
let curTurn = null;
let advice = null;       // latest advice event
let adviceSeq = -1;
let board = null;
let killFired = false, killObservedError = false, killRecovered = false;
const rssSamples = [];
const problems = [];

function now() { return Date.now(); }

function markVisible(how) {
  if (curTurn && curTurn.visibleAt == null) {
    curTurn.visibleAt = now();
    curTurn.how = how;
    const ms = curTurn.visibleAt - curTurn.onClockAt;
    console.log(`  turn @pick ${curTurn.pickNo}: advice visible in ${ms}ms (${how})`);
  }
}

function onBoard(b) {
  const prev = board; board = b;
  if (!b) return;
  const wasOnClock = prev && prev.onClock;
  if (b.onClock && !wasOnClock) {
    curTurn = { pickNo: b.currentPickNo, onClockAt: now(), visibleAt: null, how: null, priorReady: false };
    turns.push(curTurn);
    console.log(`ON THE CLOCK: pick #${b.currentPickNo} (round ${b.currentRound}) picks made=${b.pickCount}`);
    // A completed rec (even one tagged "as of pick N-1") renders instantly —
    // that is exactly what the UI shows, so it counts as visible.
    if (advice && advice.phase === 'done') {
      curTurn.priorReady = true;
      markVisible(advice.basedOn === b.pickCount ? 'speculative-precomputed' : 'stale-precomputed');
    } else if (advice && advice.phase === 'streaming' && advice.pickLine) {
      markVisible('speculative-streaming');
    }
    // fallback board always counts as *something* visible but we track it separately
    if (!b.fallback || !b.fallback.length) problems.push(`pick ${b.currentPickNo}: no fallback board available at turn start`);
  }
  if (!b.onClock && wasOnClock) curTurn = null;
  if (b.unmatchedPicks && b.unmatchedPicks.length) problems.push(`unmatched picks: ${JSON.stringify(b.unmatchedPicks)}`);
  if (b.unresolvedCsv > 0) problems.push(`unresolved CSV rows: ${b.unresolvedCsv}`);
  if (b.anomalies && b.anomalies.length) problems.push(`anomalies: ${b.anomalies.join('; ')}`);
  if (KILL_ROUND && !killFired && b.currentRound >= KILL_ROUND && b.status === 'drafting') {
    killFired = true;
    console.log(`KILLING LLM for ${KILL_SECS}s (round ${b.currentRound})...`);
    fetch(SERVER + '/api/debug/kill-llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}' })
      .then(() => setTimeout(() => {
        fetch(SERVER + '/api/debug/kill-llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":false}' })
          .then(() => console.log('LLM restored'));
      }, KILL_SECS * 1000)).catch((e) => problems.push('kill-llm failed: ' + e.message));
  }
}

function onAdvice(d) {
  if (d.seq !== undefined) { if (d.seq < adviceSeq) return; adviceSeq = d.seq; }
  advice = d;
  if (d.phase === 'error') {
    if (killFired && !killRecovered) { killObservedError = true; console.log(`  advisor error surfaced (expected during kill): ${d.error}`); }
    else problems.push(`unexpected advisor error: ${d.error}`);
    if (curTurn) markVisible('fallback-after-error');
  }
  if (d.phase === 'streaming' && d.pickLine && curTurn) markVisible('streaming-pickline');
  if (d.phase === 'done' && curTurn) {
    if (killFired && killObservedError) killRecovered = true;
    markVisible('completed');
  }
  if (d.phase === 'done' && killFired && killObservedError && !killRecovered) killRecovered = true;
}

async function sampleStats() {
  try {
    const r = await fetch(SERVER + '/api/debug/stats');
    if (r.ok) { const j = await r.json(); rssSamples.push(j.rss); }
  } catch { /* server may not expose debug outside replay */ }
}

async function main() {
  console.log(`dresscheck: ${SERVER}, target ${TARGET_MS}ms${KILL_ROUND ? `, LLM kill at round ${KILL_ROUND}` : ''}`);
  const res = await fetch(SERVER + '/api/events');
  if (!res.ok) { console.error('cannot connect to SSE'); process.exit(1); }
  const statsTimer = setInterval(sampleStats, 10000);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  while (!done) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message', data = null;
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (event === 'snapshot') { if (j.advice) onAdvice(j.advice); onBoard(j.board); }
      else if (event === 'board') onBoard(j);
      else if (event === 'advice') onAdvice(j);
      if (board && board.status === 'complete') { done = true; break; }
    }
  }
  clearInterval(statsTimer);
  report();
}

function report() {
  console.log('\n================ DRESSCHECK REPORT ================');
  const misses = turns.filter(t => t.visibleAt == null || (t.visibleAt - t.onClockAt) > TARGET_MS);
  const times = turns.filter(t => t.visibleAt != null).map(t => t.visibleAt - t.onClockAt);
  const precomputed = turns.filter(t => t.priorReady).length;
  console.log(`my turns: ${turns.length}; advice visible <= ${TARGET_MS}ms on ${turns.length - misses.length}/${turns.length}`);
  console.log(`  precomputed at turn start: ${precomputed}; visible-latency ms: [${times.join(', ')}]`);
  for (const m of misses) console.log(`  MISS pick #${m.pickNo}: ${m.visibleAt == null ? 'never visible' : (m.visibleAt - m.onClockAt) + 'ms'}`);
  if (KILL_ROUND) console.log(`LLM kill test: fired=${killFired} errorSurfaced=${killObservedError} recovered=${killRecovered}`);
  if (rssSamples.length > 1) {
    const mb = (x) => (x / 1048576).toFixed(1);
    console.log(`RSS: start ${mb(rssSamples[0])}MB -> end ${mb(rssSamples[rssSamples.length - 1])}MB (max ${mb(Math.max(...rssSamples))}MB)`);
  }
  const uniqProblems = [...new Set(problems)];
  if (uniqProblems.length) { console.log('PROBLEMS:'); uniqProblems.forEach(p => console.log('  - ' + p)); }

  fetch(SERVER + '/api/latency').then(r => r.json()).then((j) => {
    console.log(`latency: ${j.requests} requests, ${j.completed} completed, ${j.aborted} aborted, ${j.errors} errors`);
    console.log(`  ttft p50=${j.ttft_p50}ms p95=${j.ttft_p95}ms; total p50=${j.total_p50}ms p95=${j.total_p95}ms; cache hits=${j.cacheReads}`);
    const killProblems = KILL_ROUND ? (!killFired || !killObservedError || !killRecovered) : false;
    const pass = misses.length === 0 && uniqProblems.length === 0 && !killProblems;
    console.log(pass ? '\nPASS' : '\nFAIL');
    process.exit(pass ? 0 : 1);
  }).catch(() => process.exit(1));
}

main().catch((e) => { console.error('dresscheck stream ended abnormally:', e.message); problems.push('SSE stream died: ' + e.message); report(); });
