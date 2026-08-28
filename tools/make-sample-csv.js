#!/usr/bin/env node
'use strict';
/*
 * Generates tools/sample-rankings.csv for harness testing.
 * Ranks = the replay draft's actual pick order (so it behaves like real ADP),
 * padded with extra players from the Sleeper players cache by search_rank.
 * Names are deliberately mangled the way real rankings sites mangle them
 * (suffixes dropped, DST forms, "RB12"-style positions) to stress matching.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const replay = JSON.parse(fs.readFileSync(path.join(dataDir, 'replay-data.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'players-cache.json'), 'utf8'));
const players = cache.players;

const rows = [];
const used = new Set();
const posCounter = {};

function displayName(pl, i) {
  let name = pl.n;
  if (pl.p === 'DEF') {
    // vary DST naming across sources
    const nick = name.split(' ').pop();
    const forms = [`${nick} D/ST`, name, `${nick} DST`];
    return forms[i % forms.length];
  }
  if (i % 5 === 1) name = name.replace(/\s+(Jr\.?|Sr\.?|III|II|IV)$/i, '');   // drop suffix
  if (i % 11 === 3) name = name.replace(/\./g, '');                            // "A.J." -> "AJ"
  return name;
}

for (const p of replay.picks) {
  const pl = players[p.player_id];
  const md = p.metadata || {};
  const pos = pl ? pl.p : md.position;
  const team = pl ? pl.t : (md.team || '');
  const name = pl ? displayName(pl, rows.length) : `${md.first_name} ${md.last_name}`;
  if (used.has(p.player_id)) continue;
  used.add(p.player_id);
  posCounter[pos] = (posCounter[pos] || 0) + 1;
  rows.push({ name, pos, posN: posCounter[pos], team });
}

// pad with next-best unpicked players so the late board has depth
const extras = Object.entries(players)
  .filter(([id, pl]) => !used.has(id) && pl.sr < 500 && pl.p !== 'DEF')
  .sort((a, b) => a[1].sr - b[1].sr)
  .slice(0, 60);
for (const [id, pl] of extras) {
  used.add(id);
  posCounter[pl.p] = (posCounter[pl.p] || 0) + 1;
  rows.push({ name: displayName(pl, rows.length), pos: pl.p, posN: posCounter[pl.p], team: pl.t });
}

// synthetic projections: smooth positional decay curves (points, PPR-ish)
const base = { QB: 380, RB: 340, WR: 330, TE: 250, K: 155, DEF: 150 };
const decay = { QB: 0.055, RB: 0.075, WR: 0.065, TE: 0.11, K: 0.03, DEF: 0.03 };

const lines = ['"RK","TIERS","PLAYER NAME","TEAM","POS","BYE WEEK","PROJ. PTS","NOTES"'];
rows.forEach((r, i) => {
  const rk = i + 1;
  const tier = Math.min(14, Math.floor(i / 10) + 1);
  const bye = 4 + ((i * 7) % 11);
  const proj = Math.round(base[r.pos] * Math.exp(-decay[r.pos] * (r.posN - 1)) * 10) / 10;
  const notes = i % 9 === 0 ? 'Upside play, volatile week-to-week' : (i % 13 === 5 ? 'Safe floor, low ceiling' : '');
  // FantasyPros-style positional pos field: "RB12"
  lines.push(`"${rk}","${tier}","${r.name}","${r.team}","${r.pos}${r.posN}","${bye}","${proj}","${notes}"`);
});

const out = path.join(__dirname, 'sample-rankings.csv');
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${out}: ${rows.length} rows`);
