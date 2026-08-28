#!/usr/bin/env node
'use strict';
/*
 * Replay harness: fetches a real COMPLETED Sleeper draft once (cached to
 * data/replay-data.json), then re-serves it through a mock Sleeper API that
 * releases one pick every --interval seconds, so the app experiences a live
 * draft. Run the main server with REPLAY=1 to point it here.
 *
 *   node tools/replay.js [--draft <id>] [--interval 15] [--port 3999]
 *                        [--start-delay 5] [--from-pick 0]
 *
 * Control endpoints (for tests):
 *   GET  /control/status                  -> {released, total, status}
 *   POST /control/fail    {"seconds": 30} -> respond 500 to draft endpoints for N s
 *   POST /control/pause / /control/resume
 *   POST /control/release {"n": 5}        -> release N picks immediately
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}

// Default: a real completed 2026 10-team 15-round snake draft found via the
// public API (league "Category 5 Tornado League").
const DRAFT_ID = String(arg('draft', '1394163684758032384'));
const INTERVAL_MS = Number(arg('interval', 15)) * 1000;
const PORT = Number(arg('port', 3999));
const START_DELAY_MS = Number(arg('start-delay', 5)) * 1000;
const FROM_PICK = Number(arg('from-pick', 0));
const DATA_FILE = path.join(__dirname, '..', 'data', 'replay-data.json');

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function loadDraft() {
  if (fs.existsSync(DATA_FILE)) {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (d.draft_id === DRAFT_ID) {
      console.log(`replay data cached: draft ${DRAFT_ID}, ${d.picks.length} picks`);
      return d;
    }
  }
  console.log(`fetching completed draft ${DRAFT_ID} from Sleeper...`);
  const meta = await fetchJson(`https://api.sleeper.app/v1/draft/${DRAFT_ID}`);
  if (meta.status !== 'complete') console.warn(`WARNING: draft status is "${meta.status}", not "complete"`);
  const picks = await fetchJson(`https://api.sleeper.app/v1/draft/${DRAFT_ID}/picks`);
  picks.sort((a, b) => a.pick_no - b.pick_no);
  const d = { draft_id: DRAFT_ID, fetchedAt: Date.now(), meta, picks };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(d));
  console.log(`cached ${picks.length} picks (${meta.settings.teams} teams x ${meta.settings.rounds} rounds, type=${meta.type})`);
  return d;
}

(async () => {
  const data = await loadDraft();
  const total = data.picks.length;
  let released = Math.max(0, Math.min(FROM_PICK, total));
  let paused = false;
  let failUntil = 0;
  let startedAt = null;      // when drafting began (after START_DELAY)
  const t0 = Date.now();

  function status() {
    if (Date.now() - t0 < START_DELAY_MS) return 'pre_draft';
    return released >= total ? 'complete' : 'drafting';
  }

  const timer = setInterval(() => {
    if (paused) return;
    if (Date.now() - t0 < START_DELAY_MS) return;
    if (startedAt === null) { startedAt = Date.now(); console.log('draft is live'); }
    if (released < total) {
      released++;
      const p = data.picks[released - 1];
      const md = p.metadata || {};
      console.log(`pick ${p.pick_no}/${total}  R${p.round} slot ${p.draft_slot}  ${md.first_name || ''} ${md.last_name || ''} (${md.position || '?'})`);
      if (released === total) console.log('replay complete');
    }
  }, Math.max(200, INTERVAL_MS));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (p.startsWith('/control/')) {
      if (p === '/control/status') return send(200, { released, total, status: status(), paused, failing: Date.now() < failUntil });
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* ignore */ }
        if (p === '/control/fail') { failUntil = Date.now() + (Number(j.seconds) || 30) * 1000; console.log(`CONTROL: failing draft endpoints for ${j.seconds || 30}s`); return send(200, { failUntil }); }
        if (p === '/control/pause') { paused = true; console.log('CONTROL: paused'); return send(200, { paused }); }
        if (p === '/control/resume') { paused = false; console.log('CONTROL: resumed'); return send(200, { paused }); }
        if (p === '/control/release') { const n = Number(j.n) || 1; released = Math.min(total, released + n); console.log(`CONTROL: released +${n} -> ${released}`); return send(200, { released }); }
        send(404, { error: 'unknown control' });
      });
      return;
    }

    if (Date.now() < failUntil && p.startsWith('/v1/draft')) {
      return send(500, { error: 'simulated Sleeper outage' });
    }

    if (p === `/v1/draft/${DRAFT_ID}`) {
      const meta = { ...data.meta, status: status(), start_time: t0 + START_DELAY_MS };
      return send(200, meta);
    }
    if (p === `/v1/draft/${DRAFT_ID}/picks`) {
      return send(200, data.picks.slice(0, released));
    }
    if (p === '/v1/state/nfl') {
      return send(200, { season: '2026', season_type: 'regular', week: 1 });
    }
    send(404, { error: `replay mock: unknown path ${p} (draft id must be ${DRAFT_ID})` });
  });

  server.listen(PORT, () => {
    console.log(`replay mock on http://127.0.0.1:${PORT}  draft=${DRAFT_ID}  interval=${INTERVAL_MS / 1000}s  start-delay=${START_DELAY_MS / 1000}s  from-pick=${released}`);
    console.log(`-> run:  $env:REPLAY="1"; node server.js   then enter draft id ${DRAFT_ID} in the UI`);
  });

  process.on('SIGINT', () => { clearInterval(timer); server.close(); process.exit(0); });
})();
