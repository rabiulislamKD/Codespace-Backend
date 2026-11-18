# Phase 3Z3 — Universal Working Animation & Auto-dismissed Task Plan

- Reused the inline animated circular activity bubble for ordinary single-agent runs, Multi-agent runs, and OpenCode CLI runs.
- Displayed short, temporary progress/status text below the animated circle; OpenCode streamed progress updates the same bubble.
- Status text describes task progress and tools, not private model chain-of-thought.
- Completed, failed, and cancelled activity uses a terminal icon/state and auto-hides after the existing transition delay.
- Kept detail text visible on narrow mobile layouts.
- Added `planCompletedForTurn` completion lock. When every plan step is completed, the panel and Plan button disappear; subsequent late plan updates cannot restore it in that turn. The lock resets on the next user message.
- Bumped the PWA cache version to `v3r-pwa-5-universal-working-indicator-plan-dismiss`.

## Validation
- `node --check agent-server.js` — PASS
- HTML inline JavaScript `node --check` — PASS
- `node verify.cjs` — 62/62 PASS
- `node verify-opencode-bridge.cjs` — 4/4 PASS (mock CLI)
- ZIP integrity — PASS

No live provider, browser UI E2E, or live OpenCode coding task was run.
