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

### Phase 2 — speed

Architecture decision: ALL orchestration moved server-side. The server polls
Sleeper itself, computes the board, runs the speculative advisor, and pushes
everything to the frontend over one SSE channel (`/api/events`). The frontend is a
pure renderer. This makes speculation survive page reloads (an in-flight
recommendation keeps streaming server-side and re-attaches on refresh).

- **Speculative advising**: when a pick lands and `picks_until_me <= 2`, a request
  fires immediately; the next pick aborts + re-fires it. When my turn starts:
  (a) a completed current rec re-broadcasts instantly; (b) a completed rec from
  1-2 picks ago renders instantly with the "based on board as of pick N" tag while
  a fresh request runs; (c) an in-flight request that has started producing text is
  KEPT and streamed (tagged), then auto-refreshed on the current board;
  (d) nothing yet -> fresh request + fallback board is already on screen.
- **Streaming**: raw-HTTP SSE from Anthropic relayed to the UI. The model's output
  contract puts `PICK: <name>` on line 1, so the pick name renders within the first
  few streamed tokens; the JSON card replaces the stream on completion. A
  "reasoning…" state shows until first text (thinking deltas not rendered).
- **Prompt caching**: static prefix (strategy briefing + league config + full
  rankings table with notes/VORP) is one byte-stable system block with
  `cache_control {ephemeral, ttl 1h}`; only the user message (board state) varies.
  The prefix is pre-warmed (max_tokens: 0 request) at CSV import / draft
  registration so even the first live call is a cache read.
- **Latency logging**: per request ttft/total/cache tokens; per MY TURN a
  visibility record (ms from on-clock to something rendered + how). `/api/latency`.
- **Deterministic fallback**: top-5 available with tier/need/survival notes is
  computed on every board update and shipped inside it — always on screen,
  labeled, before/without any model output.
- Mock run at 6s/pick: every turn so far visible in 0 ms (stale-precomputed path).

### Phase 3 — smarter advice

- Run prediction: per intervening team, roster gaps vs league slots (dedicated ->
  FLEX/SUPERFLEX spill -> bench-phase weights, K/DEF suppressed until the last 2
  rounds) produce normalized position-target weights; shown in UI and prompt.
- Survival: base (rank pressure: each team drafts from top-8 available with
  linearly decreasing appetite) and adjusted (base scaled by that team's positional
  need vs neutral), plus a "hungry teams" count. On the clock, the horizon shifts
  to my FOLLOWING pick ("can I defer X and gain a pick?").
- VORP: replacement = starters x teams per position with flex apportioned
  RB 45% / WR 45% / TE 10% (superflex -> +0.8 QB); computed only when >=80% of CSV
  rows carry projections, else skipped silently.
- Prompt rewritten for a repeat-call model: phase framework (early value /
  middle tier-cliffs+runs / late upside+handcuffs+stacks+K/DEF window), explicit
  "numbers are precomputed — don't recalculate", strict output contract (PICK line
  + JSON schema), candidates-only rule. Roster lines include NFL team for stack
  awareness.

### Phase 4 — hardening (built in from the start, then reviewed)

- Poll loop: setTimeout chain (no overlap), every iteration try/caught, exponential
  backoff 1s->2s->4s->8s->15s cap, degraded flag + banner, auto-recovery logged,
  state never dropped. Survives arbitrary Sleeper 500 windows.
- Refresh-safety: rankings/session/manual-marks/notes/draft-id persisted in data/
  (debounced atomic writes); SSE snapshot restores everything including an
  in-flight advice stream buffer. Server restart resumes polling automatically.
- Race guards: monotonic advice `seq` + `basedOn` pick-count tags server- and
  client-side; single inflight slot; aborted requests can't broadcast; poller
  discards responses if the draft id changed mid-fetch; one-shot on-clock retry.
- DST naming: Sleeper DEF ids are team codes; alias index covers full name,
  nickname, "X D/ST", "X DST", team-code forms. Position normalization DST/D->DEF,
  PK->K, "RB12"->RB; team aliases JAC->JAX etc.
- Players missing from CSV: shown in the pick feed as "not in CSV" (informational);
  players missing from Sleeper cache entirely -> red unmatched banner.
- Traded/skipped slots: every pick's draft_slot is checked against computed snake
  order (incl. reversal_round and linear); mismatches or pick_no gaps -> visible
  warning banner instead of silent miscounting. Auction drafts -> explicit warning.
- Status transitions: pre_draft (poll meta, waiting banner) -> drafting (toast) ->
  complete (toast, advisor stops, poll slows to 30s).

### Review Cycle 1 findings (all fixed)

1. **On-clock survival horizon was wrong**: survival was computed "to my next
   pick" which IS the current pick when on the clock -> all 100%. Now uses my
   following pick, which is what "should I defer?" actually needs.
2. **No stream watchdog**: a hung Anthropic connection would have left the UI in
   "reasoning…" forever with no error. Added 30s first-event and 150s total
   timeouts that route through the error path (fallback + retry).
3. **Turn-start invalidation destroyed the speculative request**: original logic
   aborted the in-flight request exactly when the turn started. Now kept +
   streamed + tagged, per spec, with auto-refresh after.
4. **Frontend hid the completed rec** when a refresh request entered "reasoning".
   Split state into lastDone + live; the card stays up with an "updating" tag.
5. **Draft-switch race**: a poll response for the old draft id could overwrite the
   new draft's state; responses are now discarded if the id changed mid-fetch.
   Same for /api/draft: validates the draft with Sleeper BEFORE committing state.
6. **available capped at 200** made deeper CSV rows render as (wrongly) drafted in
   search results. Now uncapped.
7. **Degraded indicator** read only board.degraded (stale between board pushes);
   now takes the live status event into account.
8. Inline onclick handlers broke on names with apostrophes (O'Brien) — replaced
   with event delegation + data attributes (also removes an HTML-injection vector).
9. Manual X on an UNRESOLVED CSV row did nothing (no player_id) — now marks via a
   csvrow pseudo-id; a banner lists all manual marks with per-item undo.
10. "A.J." vs "AJ" normalization mismatch — initials runs now collapse.
11. Recommended-player-already-taken (stale rec while board moved): detected
    server-side, red warning + alternatives emphasized, fresh request auto-fires.
12. SSE sockets: error listeners added so a dying client can't throw an
    unhandled 'error' event.
