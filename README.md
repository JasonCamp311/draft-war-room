# Draft War Room

Live Sleeper draft tracker with claude-fable-5 pick recommendations — extended
thinking on every call, streamed, prompt-cached, and speculatively precomputed so
advice is on screen within ~0–5 s of your pick starting.

Zero-dependency Node server (`server.js`) + single-file vanilla-JS frontend
(`public/index.html`). No npm install, no build step.

---

## Draft-day runbook (Saturday)

Open PowerShell in this folder (`cd C:\Users\jason\draft-war-room`).

```powershell
# 1. Set the key (session-scoped; do this in the same window that runs the server)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 2. Start the server
node server.js
# -> "Draft War Room on http://localhost:8484"
# First start of the day fetches the Sleeper players DB (~5 MB, cached 24 h in data/).

# 3. Open http://localhost:8484 in your browser
```

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

### Pre-draft checklist (do this Friday)

- [ ] `$env:ANTHROPIC_API_KEY` set and valid (`node server.js` must NOT print
      "ANTHROPIC_API_KEY is not set").
- [ ] Rankings CSV is fresh, and a test import shows **0 unmatched** (or you know
      why each unmatched row is fine). Header must include a player-name column;
      recognized columns: RK/RANK, TIER(S), PLAYER NAME, TEAM, POS, BYE, PROJ/FPTS, NOTES.
- [ ] One replay passed with the REAL API (not mock) to confirm key + latency:
      see "Replay harness" below — run it once with the key set and `MOCK_LLM` NOT set,
      and check `http://localhost:8484/api/latency` p50 ttft.
- [ ] Quick browser pass: open the UI during that replay, watch one of your turns
      render, reload the page mid-draft, confirm everything comes back.
- [ ] Sleeper mock drafts work the same way as league drafts — join one and point
      the app at its draft ID for a fully live end-to-end test if you want.
- [ ] Delete `data/session.json` (or use a Reset via `POST /api/reset`) if you
      tested against a different draft, so the app doesn't resume the test draft.
      Importing your real CSV again right before the draft is fine and re-warms
      the prompt cache.

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

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for the advisor |
| `PORT` | 8484 | UI/server port |
| `REPLAY` | — | `1` = draft endpoints served by tools/replay.js |
| `MOCK_LLM` | — | `1` = simulate the model (testing without a key) |
| `EFFORT` | `high` | claude-fable-5 `output_config.effort` (low…max) |
| `SPECULATE_WITHIN` | 2 | start precomputing when ≤ N picks from my turn |
| `ADVICE_TIMEOUT_MS` | 150000 | hard cap per advice request |
| `POLL_MS` | 2000 | Sleeper poll interval |

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
