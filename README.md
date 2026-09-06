# Draft War Room

Live Sleeper draft tracker with Claude pick recommendations. Two advisor modes:

- **Claude Code mode (default, no API key)** — a Claude Code session running in
  this folder is the advisor. A background watcher wakes it when you're within
  2 picks of the clock; it reads the precomputed board and submits a
  recommendation that renders in the UI. The 📋 button copies the full prompt
  for manual paste into any Claude chat as a backup path.
- **API mode** — set `ANTHROPIC_API_KEY` and claude-fable-5 is called directly
  (extended thinking, streamed, prompt-cached, speculatively precomputed).

Zero-dependency Node server (`server.js`) + single-file vanilla-JS frontend
(`public/index.html`). No npm install, no build step.

---

## Running your own copy

Requirements: [Node.js](https://nodejs.org) 18 or newer and a Sleeper league.
Nothing else — no npm install, no accounts, no keys (unless you want API mode).

```powershell
git clone https://github.com/JasonCamp311/draft-war-room.git
cd draft-war-room
node server.js
# -> open http://localhost:8484
```

Then, in the UI:

- **Draft night (Sleeper)**: Import your rankings CSV, paste the Sleeper
  **draft ID** (from `sleeper.com/draft/nfl/<ID>`), pick your slot, Connect.
- **Draft night (ESPN)**: switch the source dropdown to **ESPN**, paste the
  **league ID** (the `leagueId=` number in any ESPN league URL), the season, and
  for a private league the `espn_s2` + `SWID` cookies (see below). Pick your team,
  Connect. Your draft slot fills in automatically once ESPN publishes the order.
- **In-season**: on the Dashboard tab paste your Sleeper **league ID** (from
  `sleeper.com/leagues/<ID>`) and pick your team.

Pick how you want the advice generated:

| Mode | How | Cost |
|---|---|---|
| **Claude Code** (default) | Open a Claude Code session in this folder and say *"run the advisor loop"* (draft) or *"help with my lineup"* (season). It reads `CLAUDE.md` and drives the watcher/submit tools. | Your Claude subscription |
| **API** | Set `ANTHROPIC_API_KEY` before `node server.js`. The server calls claude-fable-5 directly. | Pay per token |
| **None** | Just run the server. The deterministic fallback board, lineup optimizer, waiver ranking and trade evaluator all work without any model. The 📋 button copies the full prompt to paste into any chat. | Free |

Everything the app stores lives in `data/` (gitignored): player cache, your
rankings, league/draft connection, notes, advice history. Delete it for a
factory reset.

### Several leagues at once

One server holds **all your leagues**. The dropdown in the header switches
between them; **＋** adds one, **✎** renames it, **✕** removes it from the list
(its files stay on disk). Every league has its own draft/league connection,
rankings CSV, notes, manual marks and advice history, and every connected
league keeps polling in the background, so switching is instant and nothing is
missed while you're looking at another one. The dropdown shows each league's
live state (pre-draft / drafting · N until you / ⏰ ON THE CLOCK / season) and a
🧠 when it is waiting on advice.

Typical setup: your season-long Sleeper league in the first entry, then ＋ for
each draft you have coming up (Sleeper or ESPN), connected in advance. Names
fill in automatically from the platform once connected.

Under the hood the original league keeps `data/` itself (so existing installs
upgrade in place) and each added league lives under `data/leagues/<id>/`;
`data/leagues.json` is the registry. Every API call takes `?league=<id>` or an
`x-league` header; without one the server's **default** league is used (the one
`POST /api/leagues/active` names, initially the original). The advisor tools
follow suit: `tools/advisor-watch.js` with no `--league` scans **all** leagues
and wakes for whichever needs a pick first (its output carries `league`), and
`tools/advisor-submit.js --league <id>` delivers to that league. Pin a watcher to
one league with `--league <id>`.

Prefer separate servers anyway (different ports, different machines)? Profiles
still exist: `node server.js --profile bros --port 8486` keeps that server's
leagues under `data/profiles/bros/`. Sleeper's API is read-only, so nothing here can change your
league — lineup and waiver moves are still made in the Sleeper app.

---

## Draft-day runbook (Claude Code mode)

```powershell
# 1. Start the server (PowerShell, in this folder). No key needed.
cd draft-war-room
node server.js
# -> "Draft War Room on http://localhost:8484 ... EXTERNAL ADVISOR mode"
# First start of the day fetches the Sleeper players DB (~5 MB, cached 24 h in data/).

# 2. Open http://localhost:8484 in your browser
```

3. In a **Claude Code session in this folder**, say: *"the draft is starting —
   run the advisor loop"*. Claude starts `tools/advisor-watch.js` in the
   background; each time advice is wanted it wakes, reads the board context, and
   submits a recommendation (`tools/advisor-submit.js`) that appears in the UI
   tagged **CLAUDE**. It re-arms the watcher after every submission.
4. If the Claude session ever wedges: hit 📋 in the UI, paste into claude.ai,
   and read the answer there — or just draft off the always-live fallback board.

In the UI:
1. **Import CSV** — your rankings file. The import toast reports
   `N exact / N fallback / N unmatched`. Unmatched rows are highlighted with ⚠ in
   the board (they still work — they get name-matched or manually X'd).
2. Paste the **Sleeper draft ID** (draft lobby URL: `sleeper.com/draft/nfl/<ID>`),
   pick **your slot**, hit **Connect**.
3. That's it. The app polls Sleeper, precomputes recommendations before your turn,
   and streams them in. The **fallback board** (top-5 by rank with tier/need/survival
   notes) is always live under the recommendation — you can always draft off it.

During the draft:
- **✕** on a row = manually mark drafted (e.g., a keeper): banner shows undo.
- **Double-click a player name** = attach a note (goes into the prompt).
- **↻** = force a fresh recommendation.
- Reloading the page is always safe — everything (connection, rankings, notes,
  marks, even an in-flight recommendation stream) is restored from the server.
- If the server itself dies: rerun steps 1–2. It resumes the draft automatically.
- Yellow/red banners = warnings (Sleeper degraded, slot-math anomaly, unmatched
  rows). The status dot top-left blinks red while Sleeper is erroring; state is
  kept and it recovers by itself.

### Pre-draft checklist

- [ ] Rankings CSV is fresh, and a test import shows **0 unmatched** (or you know
      why each unmatched row is fine). Header must include a player-name column;
      recognized columns: RK/RANK, TIER(S), PLAYER NAME, TEAM, POS, BYE, PROJ/FPTS, NOTES.
- [ ] One replay passed in Claude Code mode: replay harness below + a Claude Code
      session running the advisor loop; confirm recs appear in the UI tagged CLAUDE.
- [ ] Quick browser pass: open the UI during that replay, watch one of your turns
      render, reload the page mid-draft, confirm everything comes back.
- [ ] Sleeper mock drafts work the same way as league drafts — join one and point
      the app at its draft ID for a fully live end-to-end test if you want.
- [ ] Reset via `POST /api/reset` (or delete `data/session.json`) after testing
      against a different draft, so the app doesn't resume the test draft.
- [ ] (API mode only) `$env:ANTHROPIC_API_KEY` set + one real-API replay,
      checking `http://localhost:8484/api/latency` p50 ttft.

---

## ESPN drafts

ESPN has no public API, but its league document
(`lm-api-reads.fantasy.espn.com/…/leagues/<id>?view=mDraftDetail&view=mSettings&view=mTeam`)
carries settings, teams, the draft order and every pick so far. The server polls
it every 3 s (`ESPN_POLL_MS`) and translates it into the same board the Sleeper
path produces: roster slots → starting-lineup counts, `statId 53` → PPR/half/std,
snake order from `pickOrder`, and each ESPN player id → the matching Sleeper id
by name/position/team (same matcher as the CSV import), so rankings, survival
math, prompts and the advisor loop are unchanged. Auction drafts are flagged, not
supported.

**Private leagues need two cookies.** Log in to fantasy.espn.com, open DevTools
→ Application → Cookies → `https://fantasy.espn.com`, copy `espn_s2` (long) and
`SWID` (a `{GUID}`). Paste them into the ESPN row in the UI once — they are saved
in `data/session.json` (gitignored, never sent to the browser) and survive
resets. Alternatively set `ESPN_S2` / `ESPN_SWID` env vars. They expire after
a long time but do re-copy them if Connect returns 401/403.

**No-cookie alternative: the browser relay.** `espn_s2` is an HttpOnly cookie,
so a page script can't read it — but a logged-in ESPN tab can fetch the league
document itself and hand it to the war room. Run
`node tools/espn-relay.js --league <leagueId>` and paste the printed snippet into
the DevTools console of an ESPN tab (the bare API URL
`lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<yr>/segments/0/leagues/<id>`
is the best host page — ESPN's real pages are heavy). It pushes the document to
`POST /api/espn/relay` every 3 s, paced by the server's `/api/espn/relay/ticks`
event stream (Chrome throttles timers in background tabs to once a minute, but
not events on an open stream); the server prefers a fresh relay copy over the
API and flags it stale if the tab dies. Chrome asks once whether the site may
access your local network (localhost) — click **Allow**. Leave that tab open for
the draft. Then connect the league in the UI as usual (cookie fields blank).

**Before draft night, probe the league** — this is the one part that can only be
verified against your real league:

```powershell
node tools/espn-probe.js --league <leagueId> --season 2026 --s2 "<espn_s2>" --swid "{...}" --team <yourTeamId>
```

It prints the league settings, every team with its slot, your slot, the picks
made so far and whether each mapped to a Sleeper player, and saves the raw
document to `data/espn-raw.json`. If the draft order isn't set yet, slots show
`?` — connect anyway and pick your team; the slot fills in on its own.

**Rehearsal without a league**: `node tools/espn-mock.js --interval 12` serves a
synthetic 10-team ESPN league (id 424242) that makes a pick every N seconds using
real player names; run the server with `$env:ESPN_BASE = "http://127.0.0.1:3998"`
and connect to it from the UI. Controls mirror the Sleeper replay harness
(`/control/pause|resume|release|status` on port 3998).

---

## Replay harness (testing)

Re-serves a real completed 2026 draft (10-team, 15-round snake) one pick every N
seconds so the app experiences a live draft:

```powershell
# terminal 1 — mock Sleeper API
node tools/replay.js --interval 12

# terminal 2 — server pointed at the mock
$env:REPLAY = "1"
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # or $env:MOCK_LLM="1" to run without a key
node server.js

# browser: import tools/sample-rankings.csv (generate once with
#   node tools/make-sample-csv.js), connect draft ID 1394163684758032384, pick a slot.

# terminal 3 — automated verification (connects like the frontend, measures
# time-to-visible-advice for every one of your turns, checks matching, and can
# kill the LLM mid-draft to prove the fallback works)
node tools/dresscheck.js --target 5 --kill-at-round 8
```

Replay controls: `POST 127.0.0.1:3999/control/fail {"seconds":30}` (Sleeper 500s),
`/control/pause`, `/control/resume`, `/control/release {"n":5}`, `GET /control/status`.
Debug (replay/mock only): `POST /api/debug/kill-llm {"on":true}`, `GET /api/debug/stats`,
`GET /api/debug/prompt`.

## External advisor protocol (Claude Code mode)

The server never calls Anthropic in this mode; it exposes the same precomputed
context the API prompt would get, and accepts finished advice:

- `GET /api/advisor/context` — cheap poll: `{needAdvice, pickCount, picksUntilMine,
  onClock, latestBasedOn, status, ...}`. Add `?prompt=1` for the dynamic board
  message, `?full=1` for the static briefing (strategy + league + full rankings —
  read it once per draft, it only changes on re-import).
- `POST /api/advisor/submit` `{basedOn, text}` — text in the strict format
  (`PICK:` line + ```json block). Response `stale:true` means the board moved
  mid-advice: fetch fresh context and submit again.
- `tools/advisor-watch.js` — polls context, prints it (with prompt) and exits
  when `needAdvice` flips true, when the draft completes, or after 45 s of server
  unreachability (exit 2). Designed to run via a background shell so the exit
  wakes the Claude session.
- `tools/advisor-submit.js --based-on N --file advice.txt` — submit helper.
- `needAdvice` = within `SPECULATE_WITHIN` picks of your turn with no rec for the
  current board, or ↻ was pressed (forces even outside the window).

The advisor loop a Claude session runs: background-start the watcher → on wake,
write advice from the printed prompt → submit → restart watcher. If a submission
comes back `stale:true`, immediately refetch `?prompt=1` and submit again.

## Season mode (in-season helper)

Connect the league once on the **Dashboard** tab (league ID + pick your team —
auto-guessed from the draft). The server then polls Sleeper league data on its own
loop (rosters/matchups/transactions every 60 s; trending + weekly projections
~5 min; NFL state/league/users + players-cache refresh ~30 min) and computes
everything the tabs show:

- **Dashboard** — my roster (projections, season PPG, blended ROS value, injury
  badges), this week's matchup, standings with power scores + **playoff odds**
  (Monte Carlo over the remaining league schedule), transaction feed, a
  **bye-week planner** (chips per week, ⚠ on 3+ crunches), and a **player
  alerts** strip (my players' injury-status changes + league-wide trending
  drops). 🔮 Preview = matchup scouting report; 📊 Power = league power
  rankings; 📰 Recap = Monday-morning week-in-review (enabled once a week has
  completed; includes bench-regret math and grades my own prior advice).
  During games the matchup panel becomes a **live scoreboard**: per-starter
  points for both sides colored by game state, "yet to play" counts (game
  statuses from the NFL schedule feed; polling tightens to every 60s while any
  game is live). Double-click a roster player to attach a note — notes ride
  into the waiver/trade/lineup prompts.
- **Lineup** — current vs server-computed optimal (flex-aware greedy over
  projections; hard-out players excluded), swap suggestions with point gains,
  flags (Out/bye/empty slots), close calls. 🧠 asks Claude to judge them.
- **Waivers** — free-agent pool ranked by a stated composite (ROS value +
  this-week proj + 24 h trending adds + my positional need vs league median),
  droppable bench, my rolling-waiver position.
- **Trade** — build a trade (my players vs a partner's), **Evaluate** shows value
  totals + before/after optimal-lineup deltas for BOTH teams; 🧠 has Claude
  judge it; 🔎 scans all 12 rosters for complementary partners and trade ideas.

**Season advisor protocol** (same external model as the draft): every "Ask
Claude"/🔮/📊/🔎 button queues a question (`POST /api/season/ask {kind, params}`).
A Claude session runs `node tools/advisor-watch.js --season` in the background;
it exits when a question is pending, printing `{kind, basedOn, params, prompt,
briefing}`. Write advice in the strict format (`ADVICE:` line + the kind's
```json block, schemas in the briefing) and deliver with
`node tools/advisor-submit.js --kind <kind> --based-on-token <w.r> --file f`,
then re-arm the watcher. Advice kinds: `lineup | waiver | trade | matchup |
power | recap`. Every tab's 📋 copies the full prompt for manual paste instead.

**Phone access (Tailscale)**: the server listens on all interfaces, so once
Windows Firewall allows inbound TCP 8484 (scoped to the tailnet:
`netsh advfirewall firewall add rule name="Season War Room (tailnet)" dir=in
action=allow protocol=TCP localport=8484 remoteip=100.64.0.0/10` in an
elevated shell, one time), the app is at **http://\<your-pc-name\>:8484** from any
tailnet device. The UI has a responsive phone layout (collapsed columns,
scrollable tabs, bigger touch targets).

**Testing without live games**: `node tools/season-snapshot.js --week 5 --synth
--records --injure <pid>=Out` writes `data/season-fixture.json`;
`SEASON_FIXTURE=1 node server.js` loads it with polling disabled.

Caveats: projections/stats come from an undocumented Sleeper endpoint (the UI
flags DEGRADED when sparse); Sleeper has no write API, so lineup changes are
applied by hand in the Sleeper app; lineup locks are not visible here.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | enables API mode (otherwise external/Claude Code mode) |
| `ADVISOR` | auto | force `api` / `mock` / `external` (auto: key→api, MOCK_LLM→mock, else external) |
| `PORT` | 8484 | UI/server port |
| `REPLAY` | — | `1` = draft endpoints served by tools/replay.js |
| `MOCK_LLM` | — | `1` = simulate the model (testing without a key) |
| `EFFORT` | `high` | claude-fable-5 `output_config.effort` (low…max) |
| `SPECULATE_WITHIN` | 2 | start precomputing when ≤ N picks from my turn |
| `ADVICE_TIMEOUT_MS` | 150000 | hard cap per advice request |
| `SEASON_POLL_MS` | 60000 | season poll base cadence |
| `SEASON_FIXTURE` | — | `1` = load data/season-fixture.json, disable season polling |
| `PLAYERS_REFRESH_MS` | 4h | in-season players-cache (injury) refresh age |
| `POLL_MS` | 2000 | Sleeper poll interval |
| `ESPN_POLL_MS` | 3000 | ESPN poll interval |
| `ESPN_S2` / `ESPN_SWID` | — | ESPN cookies for private leagues (or paste them in the UI) |
| `ESPN_BASE` | real API | override to `http://127.0.0.1:3998` for tools/espn-mock.js |

## How the speed works

1. When a pick lands and you're within 2 picks of the clock, a recommendation
   request fires immediately (extended thinking, full effort — never downgraded).
2. Each new pick invalidates and re-fires it; the last **completed** rec is kept.
3. When your turn starts: a completed rec renders in ~0 ms (tagged
   *"based on board as of pick N"* if the board moved); an in-flight request keeps
   streaming and then auto-refreshes; a cold request streams its `PICK:` line
   within the first tokens.
4. The prompt's static prefix (strategy + league + full rankings) is one cached
   block (1 h TTL, pre-warmed at import), so every call only pays for the small
   dynamic board state.
5. If the API errors or stalls (30 s no-response / 150 s total watchdogs), the
   error is shown and the deterministic fallback board — which is always on
   screen anyway — is what you draft from. One automatic retry fires on the clock.

See `CLAUDE.md` for architecture invariants and `WORKLOG.md` for the build log,
review findings, and measured latency numbers.
