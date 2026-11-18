# CodeSpace 3.12.3 — Live Details for Every Model + Safe Speedups

## 1. Live "working" details now work for ALL engines, not just OpenCode

You asked whether the live-details fix also covers Agent mode, Multi-agent mode and Ask mode with
any model. Partially it already did — the unified activity feed showed *Thinking* (with a live
reasoning snippet), *Preparing \<tool\>* and *Writing response* for every CodeSpace model. Two gaps
remained compared with the OpenCode live row, and both are closed now:

- **Writing tail**: while the answer streams, the activity row shows the last ~140 characters of
  the text being written ("Writing response · …the fix is applied in agent-server.js…"), exactly
  like OpenCode's live row — for Ask, Agent and Multi-agent alike.
- **Elapsed heartbeat**: when a model goes silent for 20+ seconds (long thinking, slow provider),
  the row now shows "Still thinking · 45 s elapsed" / "Still writing your answer · 60 s elapsed"
  every 5 seconds instead of freezing on one line. The timer is cleared when the round ends.

## 2. Speed — save time without ever affecting real work

Existing safeguards were already in place (parallel read-only tool batching, read-a-file-once
rules, provider retry with backoff and retry-after, parallel preflight agents, token saver).
On top of those, this release adds:

| Change | What it saves | Why real work is not affected |
| --- | --- | --- |
| **Soft 90 s deadline per advisory specialist** (Planning, Architecture, QA, Researcher) in Multi-agent preflight | One slow/hung specialist (e.g. a stuck web lookup) no longer stalls the start of your turn | Specialists are advisory only; the failure path already lets the implementer continue without that advice, and it is reported as "failed" in the activity panel, never hidden |
| **Soft 90 s deadline for the independent QA review** | A hung review can no longer block your finished answer | The review is an internal quality gate; on timeout it is recorded as "Review unavailable" with a warning, and your answer still arrives. Reviews that finish normally are untouched |
| **OpenCode pre-run check cache (5 min)** | Every message used to spawn an extra `opencode --version` process before starting; now the successful check is reused for 5 minutes | If OpenCode ever fails to start, the cache is invalidated immediately and the next run rechecks — the run itself stays fully supervised with the same 60-minute safety timeout |

Your Stop button still cancels everything instantly: user aborts propagate through the new child
abort signals, while the soft deadlines only fire for genuinely stuck specialist calls.

## Verification

- `npm run verify:all` — **567/567 checks passed** (7 new: writing tail, heartbeat, child signals,
  both soft deadlines, version-check cache, and a guard that provider retries + read-only batching
  are still intact), re-confirmed on a clean unzip of the release zip
- End-to-end browser test: OpenCode toggled through the real UI, two messages sent back-to-back
  (first run = fresh version check, second = cached path), both prompts reached the CLI with the
  full reporting requirement, and both structured reports rendered with no errors

## Upgrade

Same portable flow: replace the folder, run `Start CodeSpace`. PWA cache bumped
(`codespace-pwa-26-live-parity-speed-3123`).
