# Draft War Room

Live fantasy-football draft assistant. Tracks a Sleeper draft in real time and has
claude-fable-5 (extended thinking, streaming, prompt-cached) recommend picks.

## Architecture — hard constraints

- **Zero-dependency Node server** (`server.js`, Node 18+, built-in `http`/`fetch` only — no npm).
- **Single-file vanilla-JS frontend** (`public/index.html`). No build step, no framework.
- **Code computes, Claude judges.** All arithmetic (survival odds, VORP, roster gaps,
  snake-order math) happens in `server.js`; the prompt receives finished numbers.
  The frontend never invents player data — it renders what the server sends.
- Anthropic key lives in the `ANTHROPIC_API_KEY` env var. Sleeper needs no key.
- Draft-day reliability beats elegance.

## Layout

- `server.js` — everything server-side: static files, players cache, Sleeper poller,
  board computation, speculative advisor, Anthropic SSE client, latency log, persistence.
- `public/index.html` — the whole UI. One EventSource on `/api/events`; REST for actions.
- `tools/replay.js` — mock Sleeper API that re-serves a real completed draft one pick
  every N seconds. `REPLAY=1 node server.js` points the draft endpoints at it.
- `tools/make-sample-csv.js` — generates a test rankings CSV from the replay data.
- `tools/dresscheck.js` — headless client that runs a full replay and verifies the
  latency / matching / stability targets.
- `data/` (gitignored) — `players-cache.json` (24 h TTL), `rankings.json`,
  `session.json`, `replay-data.json`. Deleting `data/` is a full factory reset.

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

## Backlog

1. ~~Exact pick matching via player_id~~ (done — CSV rows resolve to Sleeper IDs at import).
2. Keeper-league support (keepers appear as pre-draft picks; currently just flagged
   as anomalies if pick_no sequence is odd).
3. Auction drafts (out of scope — snake/linear only).
