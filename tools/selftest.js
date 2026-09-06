#!/usr/bin/env node
'use strict';
// Fast unit assertions over the pure math in server.js. Run: node tools/selftest.js
delete process.env.ANTHROPIC_API_KEY;   // deterministic: always test external-advisor mode
delete process.env.MOCK_LLM;
delete process.env.ADVISOR;
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

// ---- CSV header detection (real-world header spellings must all hit)
const headerHits = (header) => {
  const found = {};
  for (const [k, re] of Object.entries(S.COL_PATTERNS)) if (re.test(header)) found[k] = true;
  return Object.keys(found);
};
eq(headerHits('PROJ. PTS'), ['proj'], 'FantasyPros "PROJ. PTS"');
eq(headerHits('FPTS'), ['proj'], 'FPTS');
eq(headerHits('PLAYER NAME'), ['name'], 'PLAYER NAME');
eq(headerHits('BYE WEEK'), ['bye'], 'BYE WEEK');
eq(headerHits('TIERS'), ['tier'], 'TIERS');
eq(headerHits('RK'), ['rank'], 'RK');
eq(headerHits('ECR'), ['rank'], 'ECR');

// ---- levenshtein
eq(S.lev('mahomes', 'mahomes'), 0, 'lev exact');
eq(S.lev('mahomes', 'mahomez'), 1, 'lev 1');
eq(S.lev('abcdef', 'xyzuvw') > 2, true, 'lev far');

// ---- external advisor gating (no key + no mock -> external mode)
eq(S.ADVISOR, 'external', 'no key -> external advisor mode');
S.ST.rankings = [{ rank: 1 }];
S.ST.board = { status: 'drafting', mySlot: 5, picksUntilMine: 2, pickCount: 40 };
eq(S.externalNeedAdvice(), true, 'need advice within window');
S.ST.adv.latest = { basedOn: 40 };
eq(S.externalNeedAdvice(), false, 'current rec suppresses need');
S.ST.adv.latest = { basedOn: 38 };
eq(S.externalNeedAdvice(), true, 'stale rec re-fires need');
S.ST.board.picksUntilMine = 5;
eq(S.externalNeedAdvice(), false, 'outside speculative window');
S.ST.adv.extForce = true;
eq(S.externalNeedAdvice(), true, 'manual refresh forces need');
S.ST.board = { status: 'pre_draft', mySlot: 5, picksUntilMine: 4, pickCount: 0 };
eq(S.externalNeedAdvice(), true, 'force works pre-draft (pre-baked round-1 rec)');
S.ST.adv.extForce = false;
eq(S.externalNeedAdvice(), false, 'pre-draft quiet without force');
S.ST.adv.extForce = true;
S.ST.board = { status: 'complete', mySlot: 5, picksUntilMine: 1, pickCount: 150 };
eq(S.externalNeedAdvice(), false, 'force ignored once draft complete');
S.ST.adv.extForce = false;
S.ST.board = { status: 'complete', mySlot: 5, picksUntilMine: 1, pickCount: 150 };
eq(S.externalNeedAdvice(), false, 'no need when not drafting');
S.ST.board = null; S.ST.rankings = []; S.ST.adv.latest = null;

// ---- advice format parsing (what /api/advisor/submit accepts)
eq(S.parseAdviceJson('PICK: X (RB, SF)\n```json\n{"pick":{"name":"X"}}\n```\n'), { pick: { name: 'X' } }, 'fenced json parses');
eq(S.parseAdviceJson('no json here'), null, 'garbage -> null');

// ==================== season math ====================

// ---- projPoints scoring-key selection
eq(S.projPoints({ pts_ppr: 20, pts_half_ppr: 17, pts_std: 14 }, { rec: 1 }), 20, 'full PPR -> pts_ppr');
eq(S.projPoints({ pts_ppr: 20, pts_half_ppr: 17, pts_std: 14 }, { rec: 0.5 }), 17, 'half PPR -> pts_half_ppr');
eq(S.projPoints({ pts_ppr: 20, pts_half_ppr: 17, pts_std: 14 }, { rec: 0 }), 14, 'standard -> pts_std');
eq(S.projPoints(null, { rec: 1 }), null, 'no stats -> null');
eq(S.projPoints({ pts_ppr: 'x' }, { rec: 1 }), null, 'non-numeric -> null');

// ---- parseStatRows (shared projections/stats parser, defensive)
const psr = S.parseStatRows([
  { player_id: '1', stats: { pts_ppr: 12.5 }, opponent: 'KC' },
  { player_id: '2', stats: {} }, { nope: true }, null,
], { rec: 1 });
eq(psr.count, 1, 'parseStatRows counts only numeric pts');
eq(psr.byId['1'], { pts: 12.5, opp: 'KC' }, 'parseStatRows row shape');
eq(psr.byId['2'], { pts: null, opp: null }, 'row without pts kept (opp null)');
eq(S.parseStatRows('garbage', {}).count, 0, 'non-array -> empty');

// ---- optimalLineup (this league's shape: QB RB RB WR WR TE FLEX FLEX DEF)
const RP = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'DEF', 'BN', 'BN'];
const mk = (defs) => (pid) => defs[pid];                    // getInfo from a table
const L1 = S.optimalLineup(['q1', 'r1', 'r2', 'r3', 'w1', 'w2', 'w3', 't1', 'd1'], RP, mk({
  q1: { pos: 'QB', proj: 20, eff: 20 },
  r1: { pos: 'RB', proj: 15, eff: 15 }, r2: { pos: 'RB', proj: 14, eff: 14 }, r3: { pos: 'RB', proj: 13, eff: 13 },
  w1: { pos: 'WR', proj: 16, eff: 16 }, w2: { pos: 'WR', proj: 12, eff: 12 }, w3: { pos: 'WR', proj: 5, eff: 5 },
  t1: { pos: 'TE', proj: 9, eff: 9 }, d1: { pos: 'DEF', proj: 8, eff: 8 },
}));
const slotPid = (L, slot, nth = 0) => L.slots.filter(s => s.slot === slot)[nth].pid;
eq(slotPid(L1, 'QB'), 'q1', 'QB slot filled');
eq(slotPid(L1, 'DEF'), 'd1', 'DEF slot filled');
eq(L1.slots.filter(s => s.slot === 'FLEX').map(s => s.pid).sort(), ['r3', 'w3'], 'overflow RB + WR take the FLEX slots');
eq(L1.total, 20 + 15 + 14 + 16 + 12 + 9 + 13 + 5 + 8, 'optimal total sums projections');

// hard-out starter displaced (out RB scores 0, bench RB steps in)
const L2 = S.optimalLineup(['r1', 'r2', 'r3'], ['RB', 'RB', 'BN'], mk({
  r1: { pos: 'RB', proj: 15, eff: 15, out: true },
  r2: { pos: 'RB', proj: 10, eff: 10 }, r3: { pos: 'RB', proj: 8, eff: 8 },
}));
eq(L2.slots.map(s => s.pid).sort(), ['r2', 'r3'], 'Out player displaced from optimal');
eq(L2.total, 18, 'Out player contributes nothing to the total');

// eff fallback: missing eff uses proj; missing both -> 0 (empty slot ok)
const L3 = S.optimalLineup(['a'], ['QB', 'TE'], mk({ a: { pos: 'QB', proj: 7 } }));
eq(slotPid(L3, 'QB'), 'a', 'eff defaults to proj');
eq(slotPid(L3, 'TE'), null, 'unfillable slot stays empty');

// ---- season state fixture for waiver/trade/need math
const players = {
  q1: { n: 'QB One', p: 'QB', t: 'AAA', sr: 1, inj: '' }, q2: { n: 'QB Two', p: 'QB', t: 'BBB', sr: 2, inj: '' },
  r1: { n: 'RB One', p: 'RB', t: 'AAA', sr: 3, inj: '' }, r2: { n: 'RB Two', p: 'RB', t: 'BBB', sr: 4, inj: '' },
  r3: { n: 'RB Three', p: 'RB', t: 'CCC', sr: 5, inj: 'Out' }, r4: { n: 'RB Four', p: 'RB', t: 'DDD', sr: 6, inj: '' },
  w1: { n: 'WR One', p: 'WR', t: 'AAA', sr: 7, inj: '' }, w2: { n: 'WR Two', p: 'WR', t: 'BBB', sr: 8, inj: '' },
  fa1: { n: 'FA Hot', p: 'RB', t: 'EEE', sr: 9, inj: '' }, fa2: { n: 'FA Cold', p: 'WR', t: 'FFF', sr: 10, inj: '' },
  fa3: { n: 'FA Trend', p: 'TE', t: 'GGG', sr: 11, inj: '' },
  b1: { n: 'Bench Guy', p: 'WR', t: 'HHH', sr: 12, inj: '' },
};
S.ST.players = players;
S.ST.rankings = [
  { rank: 1, player_id: 'q1', bye: 9 }, { rank: 2, player_id: 'r1', bye: 9 }, { rank: 3, player_id: 'w1', bye: 5 },
  { rank: 10, player_id: 'r2' }, { rank: 20, player_id: 'w2' }, { rank: 30, player_id: 'q2' },
  { rank: 40, player_id: 'r3' }, { rank: 60, player_id: 'r4' }, { rank: 80, player_id: 'fa1' },
].map(r => ({ tier: null, name: players[r.player_id].n, pos: players[r.player_id].p, team: '', proj: null, notes: '', match: 'exact', ...r }));
const RP2 = ['QB', 'RB', 'RB', 'WR', 'FLEX', 'BN', 'BN'];
S.ST.season.league = { name: 'Test League', roster_positions: RP2, scoring_settings: { rec: 1 }, settings: { trade_deadline: 11, playoff_week_start: 15, waiver_type: 0 } };
S.ST.season.nfl = { week: 3, season: '2026', season_type: 'regular' };
S.ST.season.rosters = [
  { roster_id: 1, owner_id: 'u1', players: ['q1', 'r1', 'r2', 'w1', 'r3', 'b1'], starters: ['q1', 'r1', 'r2', 'w1', 'r3'], settings: { wins: 2, losses: 0, fpts: 250, waiver_position: 12 } },
  { roster_id: 2, owner_id: 'u2', players: ['q2', 'r4', 'w2'], starters: ['q2', 'r4', 'w2', '0', '0'], settings: { wins: 0, losses: 2, fpts: 180, waiver_position: 1 } },
];
S.ST.season.users = [{ user_id: 'u1', display_name: 'Me' }, { user_id: 'u2', display_name: 'Them' }];
S.ST.season.matchups = [
  { roster_id: 1, matchup_id: 1, points: 0, starters: [] },
  { roster_id: 2, matchup_id: 1, points: 0, starters: [] },
];
S.ST.season.proj = {
  week: 3, fetchedAt: Date.now(), degraded: false, count: 100,
  byId: {
    q1: { pts: 22, opp: 'KC' }, q2: { pts: 18, opp: 'SF' }, r1: { pts: 17, opp: 'KC' }, r2: { pts: 14, opp: 'DAL' },
    r3: { pts: 12, opp: 'NYJ' }, r4: { pts: 11, opp: 'MIA' }, w1: { pts: 16, opp: 'KC' }, w2: { pts: 13, opp: 'DEN' },
    fa1: { pts: 15, opp: 'LAC' }, fa2: { pts: 6, opp: 'CHI' }, b1: { pts: 7, opp: 'GB' },
  },
};
S.ST.season.stats = { byWeek: { 1: { r1: 20, fa1: 18 }, 2: { r1: 10, fa1: 22 } } };
S.ST.season.trending = { add: [{ player_id: 'fa1', count: 50000 }, { player_id: 'fa3', count: 90000 }], drop: [], fetchedAt: Date.now() };
S.ST.session.league_id = '999'; S.ST.session.my_roster_id = 1;

// ---- value blending
const vals = S.buildValueIndex();
eq(vals.get('q1').pre, 100, 'rank 1 -> preseason value 100');
eq(vals.get('r1').ppg, 15, 'PPG averages completed weeks');
eq(Math.abs(vals.get('r1').value - ((2 / 3) * (1000 / 11) + (1 / 3) * 60)) < 0.01, true, 'value blends pre (rank 2) with ppg*4 at week weight 2/6');
eq(vals.get('fa2').value, 0, 'unranked, no games -> zero value');

// ---- needs + waivers
const profile = S.computeNeedProfile(vals);
eq(profile.needs.QB, 'low', 'stacked QB reads low need');
const wv = S.computeWaivers(vals);
eq(wv.candidates.some(c => c.pid === 'fa1'), true, 'FA with projection appears');
eq(wv.candidates.some(c => c.pid === 'fa3'), true, 'trending-only FA appears');
eq(wv.candidates.some(c => ['q1', 'r1', 'q2', 'r4'].includes(c.pid)), false, 'rostered players never claimable');
eq(wv.myWaiverPos, 12, 'my rolling waiver position surfaces');
eq(wv.drops.map(d => d.pid), ['b1'], 'drops come from non-starters only');

// ---- lineup (r3 is Out and started -> flagged + displaced in optimal)
const lu = S.computeLineup(S.ST.season.rosters[0], RP2, vals);
eq(lu.flags.some(f => f.pid === 'r3' && /Out/.test(f.reason)), true, 'Out starter flagged');
eq(lu.optimal.some(o => o.pid === 'r3'), false, 'Out starter not in optimal');
eq(lu.optTotal >= lu.curTotal, true, 'optimal never worse than current');

// ---- trade eval
const sym = S.computeTradeEval({ give: ['r2'], get: ['r4'], partner_roster_id: 2 });
eq(sym.error === undefined, true, 'trade eval runs');
eq(Math.abs(sym.myLineup.delta - (11 - 14)) < 0.01, true, 'lineup delta reflects the swap');
const bad = S.computeTradeEval({ give: ['r4'], get: ['r2'], partner_roster_id: 2 });
eq(!!bad.error, true, 'giving a player I do not roster errors');
const up = S.computeTradeEval({ give: [], get: ['r4'], partner_roster_id: 2 });
eq(up.myLineup.delta >= 0, true, 'pure gain never negative for me');

// ---- trade scan
const scan = S.computeTradeScan();
eq(scan.matrix.length, 2, 'scan covers every roster');
eq(scan.matrix.find(m => m.mine).roster_id, 1, 'scan marks my roster');

// ---- season view + token + advice gating
S.ST.season.adviceRev = 4;
eq(S.seasonToken(), 'w3.r4', 'token = week + adviceRev');
const view = S.computeSeason();
eq(view.standings[0].roster_id, 1, '2-0 team tops standings');
eq(view.standings[0].power >= view.standings[1].power, true, 'power score ordering sane');
eq(view.matchup.opp.roster_id, 2, 'matchup pairs by matchup_id');
eq(view.myRoster.players.length, 6, 'my roster resolves');
S.ST.adv.season.pending = { waiver: { since: 2, params: null }, lineup: { since: 1, params: null } };
const needs2 = S.seasonNeedAdvice();
eq(needs2.map(n => n.kind), ['lineup', 'waiver'], 'pending sorted oldest-first');
eq(needs2[0].basedOn, 'w3.r4', 'pending carries the freshness token');
S.ST.adv.season.pending = {};

// ---- bye planner (my roster byes from the CSV: q1/r1 wk9, w1 wk5)
const bp = S.computeByePlan(vals);
eq(bp.map(b => b.week), [5, 9], 'bye weeks sorted');
eq(bp.find(b => b.week === 9).players.length, 2, 'two players share the wk9 bye');
eq(bp.find(b => b.week === 5).past, false, 'wk5 bye is upcoming at wk3');
eq(bp.some(b => b.crunch), false, 'no 3+ crunch in this fixture');

// ---- playoff odds (seeded rng; stacked team must dominate)
S.ST.season.league.settings.playoff_week_start = 6;
S.ST.season.league.settings.playoff_teams = 1;
S.ST.season.leagueSchedule = { 4: [{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 1 }], 5: [{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 1 }] };
let seed = 42;
const lcg = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const oddsTeams = [
  { roster_id: 1, wins: 2, losses: 0, ties: 0, fpts: 250, optProj: 140 },
  { roster_id: 2, wins: 0, losses: 2, ties: 0, fpts: 180, optProj: 95 },
];
const odds = S.computePlayoffOdds(oddsTeams, { rng: lcg, sims: 500 });
eq(odds[1] > 95, true, '2-0 stronger team locks the single playoff spot');
eq(odds[1] + odds[2] >= 100, true, 'one of two teams always makes a 1-spot playoff');

// ---- recap math
S.ST.season.matchupHistory[2] = [
  { roster_id: 1, matchup_id: 1, points: 100, starters: ['q1', 'r1', 'r2', 'w1', 'r3'], players: ['q1', 'r1', 'r2', 'w1', 'r3', 'b1'] },
  { roster_id: 2, matchup_id: 1, points: 90, starters: ['q2', 'r4', 'w2'], players: ['q2', 'r4', 'w2'] },
];
S.ST.season.stats.byWeek[2] = { q1: 30, r1: 25, r2: 20, w1: 15, r3: 0, b1: 18, q2: 40, r4: 30, w2: 20 };
const recap = S.computeRecap(2);
eq(recap.my.won, true, 'recap sees the win');
eq(recap.my.points, 100, 'my points from archived matchup');
// hindsight optimal: q1 30 + best RB pair 25/20 + w1 15 + flex b1 18 = 108 -> regret 8
eq(recap.my.optimal, 108, 'hindsight optimal from actuals');
eq(recap.my.benchRegret, 8, 'bench regret = optimal - actual');
eq(recap.results.length, 1, 'league results paired');

// ---- injury alerts (seed silently, then alert on change; drops dedupe per week)
S.ST.season.alerts = []; S.ST.season.injSeen = {};
eq(S.checkInjuryAlerts(), false, 'first pass seeds without alerting');
S.ST.players.r1.inj = 'Questionable';
eq(S.checkInjuryAlerts(), true, 'status change alerts');
eq(S.ST.season.alerts[0].pid, 'r1', 'alert names the player');
eq(S.checkInjuryAlerts(), false, 'no duplicate alert for same status');
S.ST.players.r1.inj = '';

// ---- ESPN adapter (pure conversion of the league document into the Sleeper draft shape)
{
  const { buildLeague } = require('./espn-fixture.js');
  const dir = {
    101: { n: 'Ja\'Marr Chase', pos: 'WR', t: 'CIN' }, 102: { n: 'Bijan Robinson', pos: 'RB', t: 'ATL' },
    103: { n: 'Bills D/ST', pos: 'DEF', t: 'BUF' }, 104: { n: 'Josh Allen', pos: 'QB', t: 'BUF' },
  };
  const lookup = (id) => dir[id] || null;
  const resolve = (n, p, t) => (n === 'Bijan Robinson' ? { id: '9999' } : (p === 'DEF' ? { id: t } : null));
  const picksFor = (n) => Array.from({ length: n }, (_, i) => ({ playerId: [101, 102, 103, 104][i % 4] }));
  const raw = buildLeague({ teams: 10, picks: picksFor(12), pickOrder: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] });
  const c = S.espnToDraft(raw, { teamId: 8, lookup, resolve });
  eq(c.meta.settings.teams, 10, 'espn teams');
  eq(c.meta.settings.rounds, 15, 'espn rounds = roster minus IR');
  eq([c.meta.settings.slots_qb, c.meta.settings.slots_rb, c.meta.settings.slots_wr, c.meta.settings.slots_te, c.meta.settings.slots_flex, c.meta.settings.slots_def, c.meta.settings.slots_k, c.meta.settings.slots_bn], [1, 2, 2, 1, 1, 1, 1, 6], 'espn lineup slots');
  eq(c.meta.metadata.scoring_type, 'ppr', 'espn ppr from statId 53');
  eq(c.meta.type, 'snake', 'espn snake');
  eq(c.meta.status, 'drafting', 'espn in-progress -> drafting');
  eq(c.picks.length, 12, 'espn picks kept');
  eq(c.picks[0].pick_no, 1, 'espn pick_no');
  eq(c.picks[10].draft_slot, 10, 'espn R2P1 is slot 10 (snake)');
  eq(c.picks[11].draft_slot, 9, 'espn R2P2 is slot 9');
  eq(c.picks[10].round, 2, 'espn round');
  eq(c.picks[0].player_id, 'espn:101', 'unresolved keeps espn id');
  eq(c.picks[0].metadata, { first_name: "Ja'Marr", last_name: 'Chase', position: 'WR', team: 'CIN', espn_id: 101, keeper: false }, 'unresolved carries name metadata');
  eq(c.picks[1].player_id, '9999', 'resolved to sleeper id');
  eq(c.picks[2].player_id, 'BUF', 'DST resolves via team');
  eq(c.mySlot, 3, 'my slot from pickOrder (team 8 is 3rd)');
  eq(c.teams.find(t => t.id === 8).slot, 3, 'team slot exposed');
  eq(c.teams[0].id, 10, 'teams sorted by slot');
  eq(c.unknownIds, [], 'no unknown ids');
  eq(S.espnToDraft(buildLeague({ teams: 10, picks: [] }), { lookup, resolve }).meta.status, 'pre_draft', 'no picks -> pre_draft');
  eq(S.espnToDraft(buildLeague({ teams: 10, picks: picksFor(150) }), { lookup, resolve }).meta.status, 'complete', 'full board -> complete');
  eq(S.espnToDraft(buildLeague({ teams: 10, picks: picksFor(3), drafted: true }), { lookup, resolve }).meta.status, 'complete', 'drafted flag -> complete');
  // no pickOrder yet: slots inferred from round-1 picks; my slot unknown until my team picks
  const noOrder = S.espnToDraft(buildLeague({ teams: 10, picks: picksFor(4), pickOrder: null }), { teamId: 7, lookup, resolve });
  eq(noOrder.meta.order_set, false, 'order not set');
  eq(noOrder.picks[3].draft_slot, 4, 'positional slot without order');
  eq(noOrder.mySlot, null, 'my slot unknown before my first pick');
  eq(S.espnToDraft(buildLeague({ teams: 10, picks: picksFor(4), pickOrder: null }), { teamId: 2, lookup, resolve }).mySlot, 2, 'my slot inferred from my R1 pick');
  const unk = S.espnToDraft(buildLeague({ teams: 10, picks: [{ playerId: 555 }] }), { lookup, resolve });
  eq(unk.unknownIds, [555], 'unknown id reported');
  eq(unk.picks[0].player_id, 'espn:555', 'unknown pick keeps id');
  eq(S.espnToDraft(buildLeague({ teams: 12, picks: [], ppr: 0.5 }), { lookup, resolve }).meta.metadata.scoring_type, 'half_ppr', 'half ppr');
  // real ESPN pre-draft doc: every pick row exists with playerId -1 (seen live 2026-09-06, 8 teams x 16 = 128 rows)
  const pre = S.espnToDraft(buildLeague({ teams: 8, slots: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 7, 21: 1 }, picks: Array.from({ length: 128 }, () => ({ playerId: -1 })), pickOrder: [4, 6, 5, 1, 3, 7, 2, 8], drafted: false, inProgress: false }), { teamId: 7, lookup, resolve });
  eq(pre.picks.length, 0, 'placeholder -1 picks are not picks');
  eq(pre.meta.status, 'pre_draft', 'placeholder board is pre_draft');
  eq(pre.meta.settings.rounds, 16, 'rounds from real 8-team roster');
  eq(pre.mySlot, 6, 'team 7 drafts 6th in that order');
  const dstPick = S.espnToDraft(buildLeague({ teams: 8, picks: [{ playerId: 103 }] }), { lookup, resolve }).picks;
  eq(dstPick.length, 1, 'real picks still count');
  eq(S.espnToDraft(buildLeague({ teams: 12, picks: [], type: 'AUCTION' }), { lookup, resolve }).meta.type, 'auction', 'auction flagged');
  // the converted meta drives the existing snake math unchanged
  eq(S.pickToSlot(11, c.meta).slot, 10, 'pickToSlot on espn meta');
  eq(S.draftSlots(c.meta).FLEX, 1, 'draftSlots on espn meta');
  eq(S.sessionView().espn.hasCookies, false, 'session view hides cookies');
}

// ---- multi-league contexts: ST.<key> is an accessor onto the active league
{
  const main = S.ST.ctx;
  const other = S.newCtx('t1', require('path').join(__dirname, '..', 'data', 'leagues', '_selftest'), 'Test League');
  eq(S.leagueName(other), 'Test League', 'custom name');
  other.name = null;
  eq(S.leagueName(other), 'New league', 'auto name for an empty league');
  main.board = { status: 'drafting', mySlot: 1 };
  S.withCtx(other, () => { S.ST.board = { status: 'pre_draft', mySlot: 9 }; S.ST.session.draft_id = 'espn:1'; S.ST.session.source = 'espn'; S.ST.session.espn.league_id = '1'; });
  eq(S.ST.ctx, main, 'withCtx restores the previous league');
  eq(S.ST.board.mySlot, 1, 'main board untouched by the other league');
  eq(other.board.mySlot, 9, 'other league kept its own board');
  eq(S.leagueName(other), 'ESPN 1', 'auto name from the ESPN connection');
  S.activate(other);
  eq(S.ST.session.draft_id, 'espn:1', 'activate switches ST.session');
  S.activate(main);
  eq(S.ST.session.draft_id === 'espn:1', false, 'main session is its own');
  eq(S.leagueView(other).source, 'espn', 'league view reads the other league');
  eq(S.ST.ctx, main, 'leagueView leaves the active league alone');
  try { require('fs').rmSync(other.dir, { recursive: true, force: true }); } catch { /* fine */ }
}

console.log(`\nselftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
