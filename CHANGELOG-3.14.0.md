# CodeSpace 3.14.0 — Crash-resilient agent runs

## Agent execution recovery
- The built-in agent now saves a recoverable session snapshot when a run starts, after model responses, and after complete tool-result cycles.
- Saved snapshots include the current phase, model-round/tool counters, changed-file list, validation status and multi-agent mode.
- If CodeSpace or its renderer closes while a run is active, the next message in that chat receives a one-time continuation note explaining that the previous run was interrupted and should resume from saved work instead of restarting.
- Progress reports explicitly identify themselves as in-progress snapshots; they cannot be mistaken for a completed run.
- Final run state is persisted separately from the in-progress snapshot. Existing provider, permission, workspace and tool-call limits remain unchanged.

## Verification
- Added unit coverage for running snapshots, interrupted-run continuation and one-time consumption of recovery context.
- Run `npm test` and `npm run verify:all` to verify the release.
