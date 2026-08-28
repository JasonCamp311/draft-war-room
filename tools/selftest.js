#!/usr/bin/env node
'use strict';
// Fast unit assertions over the pure math in server.js. Run: node tools/selftest.js
const S = require('../server.js');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`FAIL ${label}: got ${a}, want ${e}`); }
}

// ---- snake order
const snake10 = { type: 'snake', settings: { teams: 10, rounds: 15 } };
eq(S.pickToSlot(1, snake10).slot, 1, 'snake R1P1');
eq(S.pickToSlot(10, snake10).slot, 10, 'snake R1P10');
eq(S.pickToSlot(11, snake10).slot, 10, 'snake R2P11 (turn)');
eq(S.pickToSlot(20, snake10).slot, 1, 'snake R2P20');
eq(S.pickToSlot(21, snake10).slot, 1, 'snake R3P21');
eq(S.pickToSlot(25, snake10).slot, 5, 'snake R3 middle');
eq(S.pickToSlot(150, snake10), { round: 15, slot: 10 }, 'snake last pick (R15 is forward)');
eq(S.pickToSlot(141, snake10).slot, 1, 'snake R15 first');

// ---- 3rd-round reversal
const rev = { type: 'snake', settings: { teams: 10, rounds: 15, reversal_round: 3 } };
eq(S.pickToSlot(11, rev).slot, 10, 'rev R2 starts back');
eq(S.pickToSlot(21, rev).slot, 10, 'rev R3 stays back');
eq(S.pickToSlot(30, rev).slot, 1, 'rev R3 ends at 1');
eq(S.pickToSlot(31, rev).slot, 1, 'rev R4 forward');

// ---- linear
const lin = { type: 'linear', settings: { teams: 10, rounds: 4 } };
eq(S.pickToSlot(11, lin).slot, 1, 'linear R2 restarts at 1');
eq(S.pickToSlot(15, lin).slot, 5, 'linear R2 slot 5');

// ---- name normalization
eq(S.normName('A.J. Brown Jr.'), 'aj brown', 'initials + suffix');
eq(S.normName('AJ Brown'), 'aj brown', 'plain AJ');
eq(S.normName("Ja'Marr Chase"), 'jamarr chase', 'apostrophe');
eq(S.normName('Kenneth Walker III'), 'kenneth walker', 'roman suffix');
eq(S.normName('José Ramírez'), 'jose ramirez', 'diacritics');
eq(S.normPos('RB12'), 'RB', 'pos strips digits');
eq(S.normPos('D/ST'), 'DEF', 'DST -> DEF');
eq(S.normPos('PK'), 'K', 'PK -> K');
eq(S.normTeam('JAC'), 'JAX', 'team alias');

// ---- CSV parser
const rows = S.parseCsv('"a","b,c",""x""\r\nq,"line\nbreak",z\n');
eq(rows[0], ['a', 'b,c', 'x'], 'quoted fields');
eq(rows[1], ['q', 'line\nbreak', 'z'], 'embedded newline');

// ---- roster needs
const slots = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, FLEX: 2, SFLEX: 0, BN: 5 };
const empty = S.rosterNeeds({}, slots, 1, 15);
eq(empty.dedicated.RB, 2, 'empty roster needs 2 RB');
eq(empty.weights.K < 0.01, true, 'K suppressed early');
const full = S.rosterNeeds({ QB: 1, RB: 3, WR: 3, TE: 1, K: 1, DEF: 1 }, slots, 12, 15);
eq(Object.values(full.dedicated).every(v => v === 0), true, 'full starters no dedicated needs');
eq(full.flexOpen, 0, 'flex consumed by spill');
const late = S.rosterNeeds({ QB: 1, RB: 4, WR: 4, TE: 1 }, slots, 14, 15);
eq(late.weights.K > 0.2 && late.weights.DEF > 0.2, true, 'K/DEF urgent late');

// ---- levenshtein
eq(S.lev('mahomes', 'mahomes'), 0, 'lev exact');
eq(S.lev('mahomes', 'mahomez'), 1, 'lev 1');
eq(S.lev('abcdef', 'xyzuvw') > 2, true, 'lev far');

console.log(`\nselftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
