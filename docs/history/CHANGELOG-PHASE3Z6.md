# Phase 3Z6 — Activity Always Visible

## Fixes
- Start the same thin, monochrome activity line synchronously when Send is pressed, before asynchronous project-memory retrieval and attachment preparation.
- Keep the activity strip visible during preparation, then reattach it beneath the current user message when the regular Agent or OpenCode run starts.
- Guard against duplicate sends while request preparation is in progress.
- Keep the spinner in its active state for at least 650 ms on very fast responses; the final answer itself is not delayed.
- Retain the one-word status labels (`Thinking`, `Working`, `Reviewing`, `Done`, `Failed`, `Stopped`) and existing automatic hide behavior.
- Increment PWA cache version to `v3r-pwa-9-activity-always-visible`.

## Verification
- `node --check agent-server.js`: PASS
- Inline HTML JavaScript `node --check`: PASS
- `node verify.cjs`: 89/89 PASS
- `node verify-opencode-bridge.cjs`: 4/4 PASS (mock CLI only)
- Live provider/browser end-to-end test: not performed.
