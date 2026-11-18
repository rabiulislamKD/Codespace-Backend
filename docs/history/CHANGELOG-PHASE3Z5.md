# Phase 3Z5 — Active Reply Auto-Follow

## Fix
- Active chat turns now auto-follow newly appended assistant replies and tool updates while the user remains at the latest-message position.
- The chat reserves a modest responsive space below the latest content, keeping the current reply and thin activity line slightly above the bottom edge instead of pressed against the composer.
- The same behavior applies to Single Agent, Multi-agent, and OpenCode CLI turns.
- Upward wheel/touch/keyboard navigation disables auto-follow, so the interface does not pull the user away from older messages. Scrolling back to the bottom during an active turn re-enables follow behavior.
- Active follow is finalized at the end of each run; the final response remains visible.
- PWA cache version bumped to `v3r-pwa-8-auto-follow-active-reply`.

## Validation
- `node --check agent-server.js` — passed.
- Inline JavaScript extracted from the HTML and checked with `node --check` — passed.
- `node verify.cjs` — 85/85 passed.
- `node verify-opencode-bridge.cjs` — 4/4 passed with mock CLI.
- ZIP integrity — checked after packaging.
- No live provider/browser end-to-end run was performed.
