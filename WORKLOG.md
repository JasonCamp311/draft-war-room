# WORKLOG

(SUMMARY is added at the top when work completes — see bottom for chronological log.)

## Chronological log

### Session start — 2026-08-28 evening

**MAJOR FINDING: the Draft War Room codebase described in the task did not exist.**
Searched all of `C:\Users\jason` (home root, Projects, Documents, Desktop, Downloads,
OneDrive, Scripts, bin, Sync), all git repos on the machine, and the fedora box over
SSH. No CLAUDE.md, README.md, server.js, or public/index.html anywhere; no
Sleeper-related code at all. Decision (per "maximize draft-day reliability, don't
stop"): **rebuilt the entire app from scratch to the spec in the task prompt**, in
`C:\Users\jason\draft-war-room\`, then ran every phase as written. All architecture
constraints honored: zero-dependency Node server, single-file vanilla frontend,
claude-fable-5 + extended thinking + streaming + prompt caching, code computes /
Claude judges, key in ANTHROPIC_API_KEY.

**Second finding: ANTHROPIC_API_KEY is not set anywhere on this machine** (process /
user / machine env; no `ant` CLI profiles). The server reads the env var per spec, but
live-API latency could not be measured in this session. Mitigation: `MOCK_LLM=1` mode
simulates the Anthropic stream (configurable thinking delay + token trickle through
the identical pipeline: speculation, aborts, SSE streaming, parsing, latency log), so
every timing/race/failure path is fully exercised. **Before Saturday: set the key and
run one replay with the real API** (runbook step in README).

Claude Fable 5 API notes (verified against current API docs, not memory):
- thinking is ALWAYS on for claude-fable-5; the `thinking` param must be omitted
  (an explicit `budget_tokens` config is rejected with a 400). Depth is controlled via
  `output_config.effort` — using `high` (server env `EFFORT` can raise/lower it).
- Refusal fallbacks enabled by default (`fallbacks: "default"` +
  `anthropic-beta: server-side-fallback-2026-07-01`) so a rare safety decline
  re-runs on an Opus-tier model inside the same call instead of erroring.
- Prompt cache: static prefix as a `system` block with
  `cache_control: {type: "ephemeral", ttl: "1h"}`.

### Phase 0 — baseline + harness

- No baseline existed (see above); built server.js + public/index.html from scratch.
- Sleeper API verified live: season 2026, state OK. Found a real completed 2026 draft
  for the harness by snowball-searching public leagues via the API:
  **draft 1394163684758032384** ("Category 5 Tornado League", 10-team, 15-round
  snake, 150 picks incl. DEF picks). Also found 12/14-team alternates (in
  tools/replay.js comments if needed).
- tools/replay.js: caches the completed draft to data/replay-data.json, re-serves
  `/v1/draft/:id` + `/picks` releasing one pick per `--interval` seconds, with
  `pre_draft -> drafting -> complete` status transitions, plus control endpoints:
  `/control/fail {seconds}` (Sleeper 500s), pause/resume/release. `REPLAY=1` on the
  server points draft endpoints at it (players cache still comes from the real API).
- tools/make-sample-csv.js: sample rankings CSV built from the replay draft order +
  60 depth players by Sleeper search_rank, with deliberately mangled names
  (suffixes dropped, "A.J." -> "AJ", three DST name forms, FantasyPros-style "RB12"
  position strings) to stress matching. Synthetic tiers/byes/projections.
- First smoke test (replay at 3s/pick, MOCK_LLM): players cache 2,046 players
  (trimmed from ~5MB to the fantasy-relevant set), CSV import 210 rows = 209 exact +
  1 fallback + 0 unmatched, board math correct (availability, needs, survival,
  fallback annotations), no anomalies.

### Phase 1 — exact pick matching

- Players cache: fetched once on start, 24h TTL, persisted to data/players-cache.json;
  stale cache used (with warning) if Sleeper is down at startup. Trimmed to
  id -> {name, pos, team, search_rank}.
- CSV rows resolve to Sleeper player_ids at import time: normalized name
  (diacritics/punctuation/suffix stripped) + position (normalized: DST->DEF, "RB12"->RB)
  + team (normalized: JAC->JAX etc.), with fallback chain:
  exact name+pos -> name-any-pos -> last-name+first-initial+pos -> levenshtein<=2.
  DEF aliases generated from Sleeper data: "Chargers D/ST", "LAC DST", full name, etc.
- Live picks match by player_id first (pick.player_id -> CSV row). Name matching kept
  only as fallback for CSV rows that failed to resolve (they get linked at pick time
  and a warning banner shows if any unresolved rows exist).
- Manual X button kept (server-persisted manual marks); unmatched warnings kept
  (unresolved CSV rows highlighted; unknown pick ids -> red banner).
- Duplicate guard: two CSV rows resolving to the same player_id -> second is flagged.
