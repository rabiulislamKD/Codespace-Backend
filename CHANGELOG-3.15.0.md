# CodeSpace 3.15.0 — Persistent Autonomous Task Center

## Task lifecycle
- Added a Task Center available from Run menu for queued, running, interrupted, completed, cancelled and failed engineering tasks.
- Every agent run now creates a session-linked task record and persists progress, phase, model rounds, tool counts, changed paths, validation evidence and final report metadata.
- Running tasks found after application startup are marked interrupted instead of being left in a misleading running state.
- Interrupted or incomplete tasks can be resumed in their original chat with an instruction to inspect current workspace state and continue without repeating completed work.
- Users can queue tasks and explicitly launch one with Run / Run next. Queued work never starts automatically.
- Task records are stored with session data in IndexedDB and the existing local fallback; history is bounded to 50 records per chat.

## Safety and scope
- Existing tool permissions, workspace guards, provider routing, tool-call limits, checkpoints and cancellation behavior are unchanged.
- Resume is a new agent turn with saved conversation context, not a replay of old tool calls. Side effects are inspected before continuing.
- No background execution is claimed: a running task interrupted by closing the app is recoverable, but it cannot continue while the app is closed.

## Verification
- Added `verify:tasks` with 15 structural checks.
- Run `npm test`, `npm run verify:agent-recovery`, `npm run verify:tasks` and the full `npm run verify:all` chain.
