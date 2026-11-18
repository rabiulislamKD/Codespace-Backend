# CodeSpace 3.12.7 — "Continue" Now Picks Up the Previous Work Properly

## What you reported

"If AI stopped and I send continue, it likely does not get the previous work chat properly."
After a stopped turn, the model treated "continue" as a fresh request instead of resuming.

## Root causes found (both proven with an instrumented live browser E2E)

1. **Pressing Stop mid-answer did not actually register as a stop.** When you press Stop,
   Chromium can end the aborted stream *cleanly* — the pending `reader.read()` resolves with
   `done: true` instead of throwing `AbortError`. The stream reader treated that as a normal
   completion, so the partial answer was recorded as a **completed** turn: the activity panel
   said "Response complete", and the turn left no trace that anything was unfinished. (Repro:
   a slow streaming answer + Stop after a few chunks → run report said "Agent returned a final
   response".)
2. **The stopped turn's work state was diagnostics-only.** Every turn already writes a run
   report (stop reason, rounds, tool calls, files changed, validation results) — but it was
   only stored for diagnostics, never shown to the model. So the next "continue" reached the
   model as a bare word on top of raw, token-saver-trimmed history, with no signal about
   where the work stopped or what was already done.

## Fixes

- **Stop is now detected even when the aborted stream ends cleanly.** `readSSE` (both the
  OpenAI-compatible and Anthropic engines) re-checks the abort signal after the stream ends
  and re-raises `AbortError`, so a stopped turn is correctly recorded as *cancelled* with its
  partial output preserved — never as a fake success. The OpenCode SSE loop got the same
  guard (an interrupted OpenCode run is now "cancelled" instead of a generic failure).
- **Continuation context for every engine.** When a turn stops before finishing (Stop,
  provider error, tool-call limit, repeat limit, empty final), the next message — typically
  "continue" — now carries a private internal note to the model containing: how the previous
  turn stopped, the retained run report (files changed, validation results, warnings), and
  the most recent assistant/tool work items. It explicitly says: continue from where the
  work stopped, do not restart from scratch, verify uncertain state with tools, finish with a
  clear final answer — and to answer a genuinely different request normally instead.
- Injected exactly once, then cleared. It is private system context (never a chat bubble)
  and travels to every built-in engine (ask / agent / multi-agent share the same path) and
  to OpenCode prompts as well.

## Verification

- Instrumented live browser E2E (mock provider, real UI): slow streaming answer → Stop after
  17 chunks → turn recorded as **cancelled** (previously: "completed") → user sends
  "continue" → the mock provider confirms the request carried the continuation context, the
  run report ("Cancelled by the user") and the resume instruction → the answer completes with
  no "Request failed".
- Runtime regression tests for the new stream-abort detection (a clean stream end while the
  signal is aborted must throw `AbortError`) and for the continuation-note builder (stopped
  turns produce the note once; completed turns produce none; errored turns without a report
  still produce a usable note).
- `npm run verify:all` — **596/596 checks passed** (13 new).
- PWA cache bumped (`codespace-pwa-30-continue-context-3127`).

## Upgrade

Same portable flow: replace the folder, run `Start CodeSpace`.
