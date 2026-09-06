# Draft War Room (now Season War Room)

Fantasy-football assistant with two parallel subsystems sharing one server + one
single-file UI:
- **Draft mode** (original): tracks a Sleeper **or ESPN** draft in real time, Claude recommends
  picks. ESPN support is an adapter (`espnToDraft`, section 7b) that turns ESPN's league
  document into the Sleeper `{meta, picks}` shape, mapping ESPN player ids to Sleeper ids by
  name — everything downstream of the poller is source-agnostic. `session.source` picks the poller.
- **Season mode**: league dashboard, start/sit lineup advice, waiver-wire advice,
  trade eval/scan, weekly matchup previews, power rankings. Advice kinds:
  `lineup | waiver | trade | matchup | power`, requested on demand from the UI
  ("Ask Claude" per tab → `POST /api/season/ask`), delivered by the external
  advisor (a Claude Code session running `tools/advisor-watch.js --season`).

**Multi-league (2026-09-06):** one server holds many leagues. Everything
league-specific lives in a league CONTEXT (`newCtx()`, section 2b); `ST.session`,
`ST.draft`, `ST.board`, `ST.adv`, `ST.season`, `ST.rankings`, `ST.sse`, … are
accessors onto the ACTIVE context, so the whole codebase reads as single-league.
Invariants: every request handler / poll loop calls `activate(ctx)` at its top
AND after every `await` (see the `A(await …)` helper in `seasonPollOnce`);
timer/promise callbacks capture their ctx and activate it; `withCtx(ctx, fn)` for
sync work on another league. Requests pick their league via `?league=` or the
`x-league` header (default = registry `active`). `broadcast()` = viewers of the
active league; `broadcastAll()` = everyone (league list). Registry
`data/leagues.json`; the original league is `main` and owns `data/` itself,
others live in `data/leagues/<id>/`. Watcher scans all leagues unless `--league`.
Verify with `tools/league-dresscheck.js` against the ESPN mock (19 checks).

Three advisor sources (`ADVISOR` auto-detected, overridable):
- **external** (default when no API key): a Claude Code session is the advisor — it
  runs `tools/advisor-watch.js` in the background, gets woken when advice is wanted,
  and delivers via `POST /api/advisor/submit`. The UI 📋 button copies the full
  prompt for manual paste into any Claude chat as a backup.
- **api** (when `ANTHROPIC_API_KEY` is set): claude-fable-5 direct (extended
  thinking, streaming, prompt-cached, speculative).
- **mock** (`MOCK_LLM=1`): deterministic simulator for testing.

## Architecture — hard constraints

- **Zero-dependency Node server** (`server.js`, Node 18+, built-in `http`/`fetch` only — no npm).
- **Single-file vanilla-JS frontend** (`public/index.html`). No build step, no framework.
- **Code computes, Claude judges.** All arithmetic (survival odds, VORP, roster gaps,
  snake-order math) happens in `server.js`; the prompt receives finished numbers.
  The frontend never invents player data — it renders what the server sends.
- Anthropic key lives in the `ANTHROPIC_API_KEY` env var. Sleeper needs no key.
- Draft-day reliability beats elegance.

## Layout

- `server.js` — everything server-side: static files, players cache (v2: `{n,p,t,sr,inj,dpo}`),
  Sleeper draft poller, board computation, speculative advisor, Anthropic SSE client,
  latency log, persistence — plus season sections 11-13: season poller (60s base,
  5min/30min tiers, own backoff), season math (optimalLineup, blended ROS values,
  waivers, trade eval/scan, power scores, `computeSeason()` → the `season` SSE view),
  and per-kind season prompt builders.
- `public/index.html` — the whole UI, now tabbed: Dashboard | Lineup | Waivers | Trade | Draft.
  One EventSource on `/api/events` (`season` + `season_advice` events added); REST for actions.
- `tools/replay.js` — mock Sleeper API that re-serves a real completed draft one pick
  every N seconds. `REPLAY=1 node server.js` points the draft endpoints at it.
- `tools/advisor-watch.js` — external-mode waker: polls `/api/advisor/context`, prints
  the context + prompt as JSON and exits when advice is wanted (run it in the
  background from a Claude Code session; the exit wakes the session). `--season`
  watches the season pending-question queue instead (wakes with kind/prompt/briefing;
  draft completion does not terminate it).
- `tools/advisor-submit.js` — delivers external advice text (`--based-on N --file f`;
  season: `--kind lineup --based-on-token w3.r17`).
- `tools/season-snapshot.js` — captures live league state into `data/season-fixture.json`
  (`--week N --synth --records --injure pid=Out`); `SEASON_FIXTURE=1 node server.js`
  loads it and disables season polling — how season features are tested off-season.
- `tools/make-sample-csv.js` — generates a test rankings CSV from the replay data.
- `tools/espn-probe.js` — dumps + converts a real ESPN league (run before an ESPN draft night).
- `tools/league-dresscheck.js` — multi-league e2e against the ESPN mock: create league, connect,
  isolation from main, watcher wake with `league`, submit `--league`, background polling, remove.
- `tools/espn-mock.js` + `tools/espn-fixture.js` — synthetic ESPN API for rehearsals
  (`ESPN_BASE=http://127.0.0.1:3998 node server.js`); the fixture builder also feeds selftest.
- `tools/dresscheck.js` — headless client that runs a full replay and verifies the
  latency / matching / stability targets.
- `tools/selftest.js` — unit assertions over the pure math (snake/reversal order,
  normalization, CSV parsing, needs model). Run after any change to those.
- `data/` (gitignored) — `players-cache.json` (24 h TTL), `rankings.json`,
  `session.json`, `replay-data.json`. Deleting `data/` is a full factory reset.
  `--profile <name> --port N` (or PROFILE/PORT env) = one server per league: state
  under `data/profiles/<name>/`, player caches (`players-cache.json`, `espn-players-*`)
  shared from `data/` (SHARED_DIR). Tools take `--server http://localhost:N`.

## Run

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node server.js                     # real draft; UI at http://localhost:8484
node tools/replay.js --interval 15 # terminal 2: mock Sleeper
$env:REPLAY="1"; node server.js    # terminal 1: server in replay mode
```

See README.md for the draft-day runbook.

## Key invariants (do not break)

- The Sleeper poll loop must never die: every iteration is wrapped, failures back off
  exponentially (1s → 15s cap) and auto-recover; state is never dropped on failure.
- Only one Anthropic request in flight at a time; every request is tagged with the
  pick count it was based on (`basedOn`) and a monotonic `seq`. Stale results are
  discarded server-side; the frontend also ignores lower-seq events.
- The static prompt prefix (strategy + league config + rankings table + VORP) must be
  byte-stable between calls — it is a cached prompt block. Only the user message varies.
- Reloading the page (or restarting the server) restores everything from `data/`.
- The deterministic fallback (top-5 by rank + tier/need notes) is computed on every
  board update and shipped with it, so the UI can always show something instantly.
- External mode: `externalNeedAdvice()` is the single source of truth for "advice
  wanted" (window ∧ no current rec, or manual ↻ force). A submission whose `basedOn`
  is behind the live board is accepted but tagged stale, and need re-fires — same
  refresh semantics as the API path. `/api/advisor/*` must never call Anthropic.
- ESPN cookies (`session.espn.espn_s2/swid`) are secrets: only `sessionView()` goes to the
  browser/tools, and it strips them. ESPN player-directory caches are keyed by season and
  by real-vs-mock base URL so a rehearsal can never poison a real draft.
- Tools must not call `process.exit()` while fetch/timeout handles are live — it
  crashes libuv on Windows (assertion in async.c). Set `process.exitCode` and return.
- Season subsystem is PARALLEL to draft: `ST.season` + its own poll loop; draft code
  paths must stay byte-compatible (next season's draft reuses them). Season advice is
  manual-trigger only (`seasonNeedAdvice()` = the pending map; set only by user asks).
- Season freshness token `w{week}.r{adviceRev}`: `adviceRev` bumps ONLY on changes
  that invalidate advice (rosters, week rollover, injury refresh) — never on noisy
  data (live scores, trending counts), or every rec would go permanently stale.
- Projections/stats ride the UNDOCUMENTED `api.sleeper.com` host (shared defensive
  parser `parseStatRows`; `proj.degraded` when sparse; failures never kill the loop;
  sort server-side — its `order_by` is unreliable).
- `/api/reset` (draft) must preserve `league_id`/`my_roster_id`; `/api/season/reset`
  clears only league fields. There is no Sleeper write API: lineup/waiver advice is
  applied manually in the Sleeper app, and lineup locks are invisible to this tool.

## Backlog

1. ~~Exact pick matching via player_id~~ (done — CSV rows resolve to Sleeper IDs at import).
2. Keeper-league support (keepers appear as pre-draft picks; currently just flagged
   as anomalies if pick_no sequence is odd).
3. Auction drafts (out of scope — snake/linear only).
