'use strict';
// Synthetic ESPN league document builder (shape of ?view=mDraftDetail&view=mSettings&view=mTeam).
// Used by tools/selftest.js (pure conversion checks) and tools/espn-mock.js (live rehearsal).

const DEFAULT_SLOTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1 };   // QB RB RB WR WR TE FLEX DST K BN×6 IR

function buildLeague(opts = {}) {
  const size = opts.teams || 10;
  const teams = Array.from({ length: size }, (_, i) => ({
    id: i + 1, abbrev: `T${i + 1}`, name: opts.teamNames ? opts.teamNames[i] : `Team ${i + 1}`,
    owners: [`{OWNER-${i + 1}}`], primaryOwner: `{OWNER-${i + 1}}`,
  }));
  const members = teams.map(t => ({ id: t.owners[0], displayName: `owner${t.id}`, firstName: 'O', lastName: String(t.id) }));
  const pickOrder = opts.pickOrder === null ? [] : (opts.pickOrder || teams.map(t => t.id).reverse());   // default: reversed ids so slot != id
  const picks = (opts.picks || []).map((pk, i) => {
    const overall = i + 1, round = Math.ceil(overall / size), idx = (overall - 1) % size;
    const rpn = idx + 1;
    const slot = round % 2 === 1 ? rpn : size - rpn + 1;
    const teamId = pickOrder.length ? pickOrder[slot - 1] : (opts.slotTeam ? opts.slotTeam[slot] : slot);
    return {
      autoDraftTypeId: 0, bidAmount: 0, id: overall, keeper: false, lineupSlotId: 20, memberId: `{OWNER-${teamId}}`,
      nominatingTeamId: 0, overallPickNumber: overall, playerId: pk.playerId, reservedForKeeper: false,
      roundId: round, roundPickNumber: rpn, teamId, tradeLocked: false,
    };
  });
  const total = size * Object.entries(opts.slots || DEFAULT_SLOTS).filter(([k]) => Number(k) !== 21).reduce((a, [, v]) => a + v, 0);
  return {
    id: opts.leagueId || 424242, seasonId: opts.season || 2026, scoringPeriodId: 1,
    draftDetail: { drafted: opts.drafted != null ? opts.drafted : picks.length >= total, inProgress: opts.inProgress != null ? opts.inProgress : (picks.length > 0 && picks.length < total), picks },
    members, teams,
    settings: {
      name: opts.name || 'Mock ESPN League', size, isPublic: false,
      draftSettings: { type: opts.type || 'SNAKE', pickOrder, date: opts.date || Date.now(), timePerSelection: 90, orderType: 'MANUAL' },
      rosterSettings: { lineupSlotCounts: opts.slots || DEFAULT_SLOTS },
      scoringSettings: { scoringItems: [{ statId: 53, points: opts.ppr != null ? opts.ppr : 1 }, { statId: 42, points: 0.1 }] },
    },
  };
}

// players_wl-style directory rows
function playerRow(id, fullName, defaultPositionId, proTeamId) {
  return { id, fullName, defaultPositionId, proTeamId, active: true, injured: false };
}

module.exports = { buildLeague, playerRow, DEFAULT_SLOTS };
