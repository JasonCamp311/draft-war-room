#!/usr/bin/env node
'use strict';
// Probe a real ESPN league before draft night: verifies the endpoint, cookies,
// settings/slot mapping, draft order, and that picks resolve to Sleeper ids.
//   node tools/espn-probe.js --league 12345678 [--season 2026] [--s2 <espn_s2>] [--swid {…}] [--team 3]
// Cookies fall back to ESPN_S2 / ESPN_SWID env vars, then data/session.json.
// Writes the raw document to data/espn-raw.json for inspection.
const fs = require('fs');
const path = require('path');
delete process.env.ANTHROPIC_API_KEY;
const S = require('../server.js');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const league = arg('--league'); const season = Number(arg('--season', S.espnSeasonDefault()));
if (!league) { console.error('usage: node tools/espn-probe.js --league <id> [--season YYYY] [--s2 ..] [--swid ..] [--team <teamId>]'); process.exitCode = 2; return; }
const s2 = arg('--s2'); const swid = arg('--swid'); const team = arg('--team');
if (s2) S.ST.session.espn.espn_s2 = s2;
if (swid) S.ST.session.espn.swid = swid.startsWith('{') ? swid : `{${swid}}`;

(async () => {
  await S.loadPlayers();
  console.log(`cookies: ${S.espnHeaders().cookie ? 'yes' : 'NO (public league only)'}`);
  console.log(`GET ${S.espnLeagueUrl(league, season)}`);
  let raw;
  try { raw = await S.fetchEspnLeague(league, season); }
  catch (e) { console.error(`FAILED: ${e.message}${e.status === 401 || e.status === 403 ? ' — private league: pass --s2/--swid' : ''}`); process.exitCode = 1; return; }
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'espn-raw.json'), JSON.stringify(raw, null, 1));
  await S.loadEspnPlayers(season);
  let conv = S.espnToDraft(raw, { teamId: team != null ? Number(team) : null });
  if (conv.unknownIds.length) { try { const n = await S.espnLookupIds(league, season, conv.unknownIds); console.log(`resolved ${n} unknown ids via kona_player_info`); conv = S.espnToDraft(raw, { teamId: team != null ? Number(team) : null }); } catch (e) { console.error('id lookup failed:', e.message); } }
  const m = conv.meta, s = m.settings;
  console.log(`\nleague: "${m.metadata.name}"  season ${season}  status=${m.status}  type=${m.type}  scoring=${m.metadata.scoring_type}`);
  console.log(`teams ${s.teams} · rounds ${s.rounds} · QB ${s.slots_qb} RB ${s.slots_rb} WR ${s.slots_wr} TE ${s.slots_te} FLEX ${s.slots_flex} SFLEX ${s.slots_super_flex} WR/RB ${s.slots_wr_rb} REC ${s.slots_rec_flex} K ${s.slots_k} DEF ${s.slots_def} BN ${s.slots_bn}`);
  console.log(`draft order ${m.order_set ? 'SET' : 'NOT SET yet'}${m.start_time ? ` · draft date ${new Date(m.start_time).toLocaleString()}` : ''}`);
  for (const t of conv.teams) console.log(`  slot ${t.slot != null ? String(t.slot).padStart(2) : ' ?'}  team ${String(t.id).padStart(2)}  ${t.name}${t.owner ? `  (${t.owner})` : ''}${team != null && t.id === Number(team) ? '   <-- YOU' : ''}`);
  if (team != null) console.log(`my slot: ${conv.mySlot || '(unknown until order is set)'}`);
  console.log(`\npicks so far: ${conv.picks.length}${conv.unknownIds.length ? ` · UNKNOWN espn ids: ${conv.unknownIds.join(',')}` : ''}`);
  const unresolved = conv.picks.filter(p => String(p.player_id).startsWith('espn:'));
  for (const p of conv.picks.slice(0, 5)) console.log(`  #${p.pick_no} R${p.round} slot ${p.draft_slot} team ${p.roster_id}: ${p.metadata.first_name} ${p.metadata.last_name} ${p.metadata.position} ${p.metadata.team} -> ${p.player_id}`);
  if (conv.picks.length > 5) console.log(`  … ${conv.picks.length - 5} more`);
  if (unresolved.length) console.log(`  ${unresolved.length} pick(s) not mapped to Sleeper ids (name fallback still clears them from the CSV): ${unresolved.map(p => p.metadata.first_name + ' ' + p.metadata.last_name).join(', ')}`);
  const raw0 = (raw.draftDetail && raw.draftDetail.picks && raw.draftDetail.picks[0]) || null;
  if (raw0) console.log(`\nraw pick[0] keys: ${Object.keys(raw0).join(', ')}`);
  console.log(`raw top-level keys: ${Object.keys(raw).join(', ')} · draftDetail: ${raw.draftDetail ? Object.keys(raw.draftDetail).join(', ') : 'MISSING'}`);
  console.log('raw saved to data/espn-raw.json');
})().catch(e => { console.error('probe error:', e.stack || e.message); process.exitCode = 1; });
