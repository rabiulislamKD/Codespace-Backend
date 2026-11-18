# Phase 3Z7 — Live process feed under the spinner

## Added
- A temporary feed of background steps now appears under the animated spinner while the AI works: thinking rounds (with a live one-line reasoning snippet when the provider streams reasoning), "Writing response", every tool call (`Reading src/app.js`, `Running npm test`, `Editing …`, browser/GitHub/DB tools), memory/context lookups before send, multi-agent stage updates, and OpenCode CLI progress.
- Each line shows a pulsing dot while live, then ✓ / ! / – with the elapsed time when it took 1 s or more. The newest 6 lines are kept; older ones fade.
- When the run ends the feed collapses and the whole activity panel fades away (existing 1.5 s auto-hide). Nothing is added to the saved chat history.
- `ACTIVITY_SHOW_REASONING` (top of the activity code) can be set to `false` to show a plain "Thinking" line instead of a reasoning snippet.
- Spinner slightly larger/darker. PWA cache bumped to `v3r-pwa-10-activity-live-feed`.

## Verification
- Inline JS and `agent-server.js` `node --check`: PASS
- `node verify.cjs`: 92/92 PASS · `node verify-opencode-bridge.cjs`: 4/4 PASS
- Headless Chromium: rows appear, mark done/failed, feed collapses to 0 height and panel hides after completion; no page errors.
- Live provider end-to-end test: not performed.
