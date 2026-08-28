# Draft War Room

Live Sleeper draft tracker with claude-fable-5 pick recommendations.
Zero-dependency Node server + single-file vanilla-JS frontend.

(Full draft-day runbook is added at the end of the hardening pass — see below.)

## Quick start

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node server.js
# open http://localhost:8484, import your rankings CSV, enter the draft ID + your slot
```

## Test with the replay harness

```powershell
node tools/replay.js --interval 15        # terminal 1: mock Sleeper
$env:REPLAY="1"; node server.js           # terminal 2 (add $env:MOCK_LLM="1" if no key)
node tools/make-sample-csv.js             # once, to create tools/sample-rankings.csv
node tools/dresscheck.js --target 5       # terminal 3: automated verification
```
