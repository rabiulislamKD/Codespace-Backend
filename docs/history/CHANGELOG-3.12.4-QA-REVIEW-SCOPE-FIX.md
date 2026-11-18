# CodeSpace 3.12.4 — Full-Project Bug Scan: Multi-Agent QA Review Fix

## What happened

A full-project bug scan was requested ("scan whole project find and fix bug"). Every hot path was
audited: the whole agent loop, the streaming parsers (OpenAI + Anthropic SSE), retry/backoff
logic, the multi-agent orchestration, the OpenCode path on both sides (frontend + server), the
sandbox manager, the Electron desktop layer, the bridge extension and the service worker.

**One real, high-impact bug was found and fixed.**

## The bug

In Multi-agent mode, the **independent QA review** that runs after the implementer finishes had a
scope error: its 90-second soft deadline and abort signal were declared *inside* the `try` block,
but the `catch` block referenced them. Concretely, whenever the QA review failed for any normal
reason (provider error, rate limit, empty reply), the catch handler itself crashed with
`ReferenceError: deadline is not defined` before it could do its job.

Result: the ReferenceError escaped into the main agent loop, so a **successfully completed
multi-agent turn was reported as "Request failed. Check the server, Base URL, model name and key
in Settings…"** — a misleading error after all the real work had already been done. The intended
soft-failure behavior (record "Review unavailable" as a warning, keep the finished answer) never
ran, and the 90-second timer leaked on that path.

## The fix

- `ac` and `deadline` are now declared **outside** the `try` in `runMultiAgentFinalReview`, so the
  catch can always clear the timer and inspect the signal. A failing QA review is again a soft
  failure: the answer you already got stays, the stage is recorded as failed, and an internal
  warning is added. User Stop still cancels the turn as before.

## What the scan confirmed as clean (no changes needed)

- Live "working" details cover every model: all non-OpenCode traffic (Ask, Agent, Multi-agent)
  flows through one round feed with the writing tail + elapsed heartbeat, and OpenCode has its own
  live row + 45 s heartbeat; all timers are cleared on every exit path (success, error, Stop).
- SSE parsing handles chunk boundaries, `[DONE]`, CRLF and leftover buffers on all four stream
  consumers; in-stream retry only fires before anything has streamed, so no duplicated output.
- Provider retry/backoff (including retry-after and 200-stream overload errors) intact.
- The OpenCode server path: supervised spawn with 60-minute timeout, kill on client disconnect,
  cache invalidation when the binary breaks, guarded SSE writes.
- Sandbox manager: capture timeouts, path-traversal guards, checkpoint copy loop, orphan sweep.
- Bridge extension: loopback-only API, challenge refusal, tab bookkeeping, service-worker loop.

## Verification

- `npm run verify:all` — **571/571 checks passed** (4 new: declaration-order check plus a runtime
  regression test that actually executes the QA-review function in a sandbox — before the fix it
  crashed with the ReferenceError, after the fix it degrades softly; and a test that user Stop
  during the review still cancels the turn).
- Inline script syntax re-validated after the edit.

## Upgrade

Same portable flow: replace the folder, run `Start CodeSpace`. PWA cache bumped
(`codespace-pwa-27-qa-review-scope-fix-3124`).
