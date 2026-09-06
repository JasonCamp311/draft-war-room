#!/usr/bin/env node
'use strict';
/*
 * Delivers external-advisor output to the war-room server.
 *
 *   node tools/advisor-submit.js --based-on 63 --file advice.txt [--server ...]
 *   ... | node tools/advisor-submit.js --based-on 63
 *
 * SEASON kinds (lineup|waiver|trade|matchup|power):
 *   node tools/advisor-submit.js --kind lineup --based-on-token w3.r17 --file advice.txt
 * Season advice text: "ADVICE: <summary>" first line + the kind's ```json block.
 *
 * Draft advice text must follow the strict format from the briefing:
 * a "PICK: Name (POS, TEAM)" first line, then the ```json block.
 * Prints the server response; exit 0 on accept. A "stale": true response means
 * the board (or season data) moved while advising — fetch fresh context and
 * submit again.
 */

const fs = require('fs');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 ? args[i + 1] : d; };
const SERVER = arg('server', 'http://localhost:8484');
const FILE = arg('file', null);

(async () => {
  const text = FILE ? fs.readFileSync(FILE, 'utf8') : fs.readFileSync(0, 'utf8');
  const basedOnArg = arg('based-on', null);
  const body = { text };
  if (basedOnArg != null) body.basedOn = Number(basedOnArg);
  const kind = arg('kind', null);
  if (kind) body.kind = kind;
  const token = arg('based-on-token', null);
  if (token) body.basedOn = token;
  const r = await fetch(`${SERVER}/api/advisor/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  console.log(JSON.stringify(j));
  if (!r.ok) process.exitCode = 1;             // no process.exit(): see advisor-watch.js
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
