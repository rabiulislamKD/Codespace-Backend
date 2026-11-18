# CodeSpace 3.12.5 — Live Detail Text for Every Engine + Multi-Agent Overload Survival

## What you reported

1. "I saw still detail text of live working not showing — fix for all agent, multi-agent and
   OpenCode." The activity bubble only ever showed a spinner and one status word ("Thinking" /
   "Working"), even though 3.12.3 built all the live detail (writing tail, tool labels,
   silence heartbeat, specialist stages).
2. "Check when I use multi-agent [and the] AI model stopped for overloaded cause." Multi-agent
   turns died whenever the provider reported "overloaded", and a finished multi-agent turn
   could still end with a false "Request failed" error.

## Root causes found (all proven in code and reproduced in a live browser E2E)

- **Detail text was deliberately thrown away.** `paintMultiAgentLine` — the one function that
  paints the activity line for every engine (single agent, multi-agent, OpenCode) — overwrote
  the stage's real detail with a single status word and blanked name/state/counter. All the
  detail was computed and stored; it just never reached the screen.
- **In-stream "overloaded" errors were retried only if nothing had streamed yet.** Reasoning
  models stream reasoning first; providers that die mid-stream with `overloaded_error` after
  that first token were never retried, so the whole turn (worst in multi-agent, where the
  implementer round is long) was lost. Post-3.12.4, no call site commits partial output before
  the stream resolves, so this guard was stricter than needed.
- **The independent QA review crashed before it could run.** `childSignal` was declared as a
  local const inside `runMultiAgentPreflight`, but `runMultiAgentFinalReview` also calls it —
  a `ReferenceError: childSignal is not defined` thrown *before* the review's try/catch. It
  escaped into the agent loop and turned every successfully finished multi-agent turn into
  "Request failed. Check the server, Base URL…" — and the QA review never actually executed.
  (The 3.12.4 runtime test missed this because it stubbed `childSignal` in its sandbox.)
- **Four provider requests fired in the same millisecond.** The preflight specialists launched
  simultaneously — a classic trigger for the very "overloaded"/rate-limit responses you saw.

## Fixes

- The activity line now paints the real live detail for every engine: "Editing src/app.js",
  "Searching public docs and sources", "Writing response · …", "Still thinking · N s elapsed",
  "Review complete · limited evidence". Still one calm line; the status word remains only as
  a fallback. Tooltip mirrors the detail.
- `callModel` now retries transient in-stream errors (overloaded, rate limit, timeouts, and
  mid-stream connection drops — the reader failure is now tagged retryable) even after partial
  output, up to 4 attempts with backoff. The retry is surfaced in the live feed as
  "Provider busy · retrying (try N of 4)" and in the context hint. Stop still cancels instantly.
- `childSignal` hoisted to module scope, shared by preflight and QA review. A finished
  multi-agent turn now ends with its answer plus a real "Independent QA Reviewer" stage.
- Preflight specialists now launch with a 350 ms stagger — still effectively parallel, but no
  longer a same-millisecond burst.

## Verification

- Live browser E2E (mock OpenAI-compatible provider):
  - Ask mode: request streams partial text, then dies with an in-stream `overloaded_error` →
    the turn auto-retried and completed; the feed showed the writing tail and the retry row;
    no partial text leaked into the chat.
  - Multi-agent mode: all 4 specialists + implementer + the QA review ran (7 provider
    requests), answer completed, no "Request failed", detail text visible throughout.
- `npm run verify:all` — **577/577 checks passed** (6 new: real detail painting, detail
  maintained for all engines, retry-after-partial-output, mid-stream drop tagging, retry
  surfaced in the feed, specialist launch stagger, plus the QA-review abort-helper scope check;
  the 3.12.4 runtime regression test no longer stubs `childSignal`, so this class of scope bug
  can never hide from it again).
- PWA cache bumped (`codespace-pwa-28-live-detail-overload-retry-3125`).

## Upgrade

Same portable flow: replace the folder, run `Start CodeSpace`.
