# WORKLOG

## SUMMARY — read this before Saturday

**The big one: the Draft War Room codebase this task described did not exist on
this machine (or the fedora box).** I searched everywhere, then rebuilt the whole
app from scratch to the spec, in `C:\Users\jason\draft-war-room\`, and ran every
phase against it (details at "Session start" below). If the real repo lives
somewhere else (another laptop?), this one is a complete, tested replacement.

**What you have now**
- Zero-dep Node server + single-file frontend. Server does everything: polls
  Sleeper (backoff, never dies), matches picks by player_id (CSV resolved to
  Sleeper ids at import; 210/210 exact in testing), computes needs/runs/survival/
  VORP, runs the speculative advisor, streams claude-fable-5 output over SSE.
  Frontend is a pure renderer and restores completely on reload.
- Speed design: recommendations are precomputed starting 2 picks before your
  turn, invalidated as picks land (with a starvation guard so *something* always
  completes even in rapid-fire pick bursts), and the last completed rec renders
  INSTANTLY at turn start with a "based on board as of pick N" tag while a fresh
  one streams in. Static prompt prefix is cached (1h TTL) and pre-warmed; only
  board state is paid per call. Fallback top-5 board is always on screen.

**Measured (final full-draft rehearsal, 6s/pick — harsher than your 60s clock):**
- Advice visible on **15/15 of my turns in 0-1 ms** (target was 5000 ms).
- Zero unmatched picks / anomalies / console-path errors; memory flat.
- 45s Anthropic outage mid-draft: banner + fallback + instant stale rec at my
  turn + auto-recovery. 30s Sleeper 500s: backoff, degraded dot, auto-recovery,
  no state loss.

**Numbers are from the mock LLM** (tuned to ~8-13s ttft). Real-API timing was
NOT testable here: **ANTHROPIC_API_KEY is not set anywhere on this machine.**
The design hides model latency, but you must do the Friday checklist in
README.md — one replay with the real key — to verify the key works and see true
cache-hit ttft. Everything else is push-button for Saturday (runbook in README).

**Know before drafting**
- Model: claude-fable-5, extended thinking always on (that's how Fable works —
  the old budget_tokens knob no longer exists; effort=high via `EFFORT` env),
  streaming, refusal-fallbacks enabled, prompt-cached. Never downgraded.
- If the recommendation panel ever errors, the fallback board right below it is
  computed locally and always current — draft off that.
- Keeper leagues / traded draft slots show a warning banner instead of silently
  miscounting. Auction drafts are not supported (warned explicitly).
- The replay draft ID for testing is 1394163684758032384 (real completed 2026
  10-team 15-round snake draft).

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

### Review Cycle 2 — dress rehearsal (12s/pick, full 15 rounds, mock LLM at
### realistic Fable-ish timing: ~4.5-13.5s thinking + streaming)

- **Sleeper outage test (live, mid-run)**: fired 30s of forced 500s via
  `/control/fail`. Result: PASS — backoff 1s/2s/4s/8s/15s, degraded indicator
  up, auto-recovery 30s later, no crash, no state loss. Note: picks released
  during the outage were absorbed in one catch-up poll (including one of my
  turns) — exactly the desired behavior.
- Frontend review pass (rendering path during my turn): advice events render
  directly (no full-page re-render); token deltas touch only the stream node;
  no requestAnimationFrame anywhere (hidden-tab throttling can't freeze the UI);
  all 25 DOM ids referenced by the script verified present; inline script
  syntax-checked with node. Known minor: the note editor uses prompt(), which
  blocks rendering while open (user-initiated only). Chrome extension was not
  connected this session, so the interactive browser pass is on the pre-draft
  checklist rather than done here.
- **Full 15-round run at 12s/pick** (150 picks, slot 5, kill test at round 8):
  - Server-side truth: **all 15 of my turns had advice visible in 0 ms** —
    a completed recommendation was already on screen at every turn start
    (speculative precompute), with a fresh current-board refresh streaming in
    behind it. Zero unmatched picks, zero anomalies, zero unresolved CSV rows.
  - Request stats (mock LLM tuned to Fable-ish timing, ttft ~8.5s p50 /
    ~10.7s p95, total ~10s p50): 46 requests, 29 completed, 14 aborted
    (invalidated by newer picks — by design), 3 errors (all from the deliberate
    kill test).
  - Kill test: fired=true, error surfaced to UI, fallback stayed live, advisor
    auto-recovered. Memory stable: RSS 59 -> 64 MB over the run.
  - The client-side checker initially reported 2/14 turns "late" — traced to a
    dresscheck bug, not an app bug: it tracked one advice variable, so a
    refresh request's "reasoning" event overwrote the completed card it should
    have kept counting as visible (the real frontend keeps the card via its
    lastDone/live split). Dresscheck rewritten to mirror the frontend exactly.
  - Prompt inspection mid-run caught a real bug: "PROJ. PTS" (dot) header
    missed by the projections column regex -> proj/VORP silently absent from
    the prompt. Fixed + header-detection selftests added; import now 210/210
    exact and VORP flows into candidates and the static table.
- **Confirmation run at 6s/pick** (STRICTER than draft-day 12s — less time for
  speculation between picks), full draft + kill test, with the fixed checker.
  This run exposed the best find of the whole exercise: **advisor starvation**.
  With picks landing (6s) faster than the model completes (~10-14s), the
  "invalidate and re-request on every pick" policy aborted every request
  forever — 1 of 47 requests completed all draft, so there was never a completed
  rec to render at turn start. That same failure mode can hit a real draft
  during rapid-fire pick bursts (autopick cascades, everyone insta-picking).
  **Fix: bounded-staleness policy** — a request that is already streaming always
  runs to completion (then auto-refreshes); a still-thinking request is only
  aborted for freshness when a completed rec no more than 3 picks old exists as
  a safety net. Guarantees forward progress at ANY pick rate while preferring
  freshness whenever it's affordable.
- **Final verification run (6s/pick, full 15 rounds, kill test round 8):**
  - **15/15 of my turns: advice visible in 0-1 ms** (all speculative
    precompute; server-side log agrees, worst case one turn at 1.3s via
    streaming when a completed rec was momentarily absent in an earlier run).
  - Zero unmatched picks, zero anomalies, zero unresolved CSV rows,
    210/210 CSV rows exact-matched to Sleeper player ids.
  - Kill test (45s simulated Anthropic outage mid-round-8, spanning my pick):
    errors surfaced as a banner, fallback board stayed live, my turn during the
    outage still had a rec visible at 0 ms (last completed, tagged stale),
    advisor auto-recovered after the outage.
  - Requests: ~45/run, 15 completed, rest deliberately invalidated; mock ttft
    p50 ~8s / p95 ~13s (tuned to plausible Fable-5 cache-hit timing).
    Memory stable: RSS 55 -> 67 MB across the full draft.
  - REAL-API latency was not measurable in this session (no ANTHROPIC_API_KEY
    on this machine — see session start). The speculation design makes
    time-to-visible independent of model latency in the common case; run the
    Friday checklist replay with the key set to confirm.
  - **Final clean run: PASS.** 15/15 turns visible at 0-1 ms (all precomputed),
    kill test fired/surfaced/recovered, zero problems, RSS 56 -> 67 MB,
    44 requests (16 completed / 23 invalidated-by-design / 5 from the kill).

## 2026-08-29 — external advisor mode (Claude Code session as the advisor)

**Why:** draft night is tonight and no ANTHROPIC_API_KEY exists on this machine;
user chose to use their Claude Code session (subscription) instead of API billing.

**Changes:**
- `ADVISOR` mode const: `api` (key set) / `mock` (MOCK_LLM=1) / `external`
  (default with no key; overridable via env). External mode never calls Anthropic.
- New endpoints: `GET /api/advisor/context` (needAdvice gate + `?prompt=1`
  dynamic board message + `?full=1` static briefing) and
  `POST /api/advisor/submit {basedOn, text}` (strict-format advice; 400 on
  unparseable; stale-tagged when basedOn < live pickCount, and need re-fires).
- `externalNeedAdvice()`: within SPECULATE_WITHIN of my pick with no
  current-board rec, or ↻ force (works pre-draft to pre-bake a round-1 rec;
  ignored after complete). External branch of advisorOnBoardChange broadcasts
  reasoning/idle phases + instant (stale-)precomputed recs at turn start.
- `tools/advisor-watch.js`: background waker (polls context, prints context+prompt
  JSON and exits when advice needed / draft complete; exit 2 after 45s server-down).
  `tools/advisor-submit.js`: delivery helper. Both avoid `process.exit()` — it
  races live fetch handles and crashes libuv on Windows (exit 127, async.c assert).
- UI: 📋 copy-prompt button (~14KB briefing+board, for manual claude.ai paste as
  backup), CLAUDE ADVISOR status bit, info banner, CLAUDE tag on external recs,
  external "working" label. `idle` phase clears a stuck spinner if a turn passes
  unadvised.
- selftest 40 → 52 assertions (need-gating matrix + format parsing).

**Dress rehearsal (replay 12s/pick, Claude Code session actually advising):**
- Wake→advise→submit loop verified end to end: watcher exit wakes the session,
  advice renders in the UI tagged CLAUDE; stale submissions re-fire need and the
  refresh loop converges; on-clock turns show the last rec at 0-1ms.
- 12s auto-picks outpace a ~30-45s advise round trip (expected: real clock is
  2 min); paused-replay turn confirmed clean in-window non-stale submission.
- Mid-draft server kill + restart: full recovery from data/ (draft, rankings,
  slot, polling). Accidental 30s Sleeper outage test: poller backed off and
  recovered per design.

## 2026-08-30 — Season mode: full-fledged fantasy helper

Expanded post-draft into a season-long assistant (plan: season subsystem PARALLEL
to draft; draft paths untouched except 4 backward-compatible seams).

- **Server** (+~900 lines, sections 11-13): season poller (60s base, 5min/30min
  tiers, own backoff, never dies), season math (optimalLineup greedy w/ flex
  eligibility + hard-out exclusion, blended ROS values pre-rank↔PPG, waivers
  composite, trade eval/scan, power scores, computeSeason view), per-kind prompts.
  Players cache v2 adds injury_status/depth-chart (+4h in-season refresh).
  Advisor generalized to kinds lineup|waiver|trade|matchup|power with freshness
  token w{week}.r{adviceRev} (adviceRev only bumps on advice-invalidating changes).
- **UI**: tabbed (Dashboard | Lineup | Waivers | Trade | Draft), season SSE events,
  per-kind advice cards, trade builder w/ instant server eval.
- **Tools**: advisor-watch --season (pending-question wake), advisor-submit --kind
  --based-on-token, new season-snapshot.js fixture builder (--week/--synth/
  --records/--injure) + SEASON_FIXTURE=1 server mode.
- **Verified**: selftest 95/95 (new season block caught 2 real bugs: Out players
  occupied optimal slots and leaked their proj into totals); live league connect
  (roster auto-guessed from draft slot_to_roster_id: slot 9 → roster 1); full
  ask→watch→submit loop; all 5 prompt builders; trade eval sane (CeeDee↔CMC
  +3.9/-4.7); week-5 synth fixture (injury override, bye flags, PPG blend);
  draft dresscheck regression PASS 15/15 turns w/ season poller running
  concurrently; browser check clean (no console errors).
- Stats endpoint verified same shape as projections (2025 wk17 probe) — shared
  parser. Restored real FantasyPros rankings (518 rows) after regression
  overwrote them with the sample CSV.

## 2026-08-31 — Season mode round 2: scoreboard, odds, alerts, recap, phone

- **Live scoreboard**: NFL schedule feed (api.sleeper.com/schedule, per-game
  status) verified + wired in; current-week live stats fetched every 60s while
  any game is live (mid-tier otherwise). Matchup view gains per-starter rows
  (pts/proj/status) + yet-to-play counts; UI renders a two-sided scoreboard.
  Lineup prompt now states LOCKED players (live/final games) instead of the
  "can't see locks" caveat.
- **Playoff odds**: Monte Carlo (3k sims, Normal(strength, 22), seed by wins
  then PF) over real remaining league pairings (fetched once per week per
  week). Cached by state key. Standings column + roster header pct.
- **Bye planner**: CSV byes grouped per week, crunch flag at 3+ meaningful
  players (chips on Dashboard; real data flagged W10·4⚠ immediately).
- **Injury/drop alerts**: injSeen diffing (silent first seed) + my-player in
  trending-drop list (dedup/week); alert strip + clear route; persisted.
  First boot flagged a real one: NE DEF trending drop.
- **Recap kind** (kind=recap, 📰 on League wire): matchupHistory archived at
  rollover + backfilled; computeRecap = result, bench regret via hindsight
  optimalLineup over actuals, best/benched scorers, league results; prompt
  includes my prior advice lines that week (adviceHistory now persisted).
- **Notes**: dblclick roster player -> note; notes ride into lineup/waiver/
  trade prompts.
- **Phone**: responsive pass (<=760px collapse, scrollable tabs, coarse-pointer
  targets, sun hidden on small screens). Server already binds 0.0.0.0; needs
  one-time elevated firewall rule (see README) then http://tars:8484 on tailnet.
- season-snapshot.js now synthesizes matchup history + captures the schedule so
  recap/scoreboard test off-season. Fixture drill verified recap prompt e2e.
- selftest: 110 assertions (adds bye plan, seeded playoff odds, recap math,
  alert seeding/dedupe).

## 2026-09-06 — ESPN draft support (draft tonight on ESPN)

- **Adapter, not a fork**: `espnToDraft(raw)` (server §7b) converts ESPN's league
  document (`?view=mDraftDetail&view=mSettings&view=mTeam`) into the Sleeper
  `{meta, picks}` shape. lineupSlotCounts -> slots_*, rounds = roster minus IR,
  statId 53 -> ppr/half/std, pickOrder -> slot per team (falls back to
  round-1 positional inference when the order isn't published yet), ESPN
  player id -> Sleeper id via the CSV resolver (unmapped picks keep `espn:<id>`
  + name metadata so the board's name-fallback still clears them).
- `pollEspnOnce()` mirrors the Sleeper poller (same backoff/recovery, 3s cadence,
  slows to 5s pre-draft / 30s complete). `session.source` selects the branch.
  Player directory (`players?view=players_wl`) cached per season 24h, unknown
  ids resolved on demand via `kona_player_info` filterIds.
- Cookies (`espn_s2`, `SWID`) stored only in data/session.json + env; `sessionView()`
  strips them from every broadcast/snapshot. Reset keeps cookies, drops league.
- UI: source dropdown (Sleeper/ESPN), ESPN row (season + cookie inputs, saved ✓
  hint), slot select shows team names; before the order is set it lists teams
  and the slot fills in automatically on the first poll that sees the order.
- Bug found in smoke: (re)connect didn't poll for up to 30s when the previous
  draft was complete (idle cadence). `startPolling(true)` now restarts the timer.
- Verified: selftest 143 (33 new ESPN conversion assertions); live rehearsal via
  `tools/espn-mock.js` (real player names from the Sleeper cache) — connect,
  slot mapping, 6/6 picks resolved to Sleeper ids + CSV rows, picks advanced
  each poll, on-clock + `needAdvice` fired at my turn. `tools/espn-probe.js`
  is the pre-draft check against the real league (field names confirmed only
  against the mock so far — run the probe before the draft).
