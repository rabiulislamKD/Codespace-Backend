# CodeSpace 3.13.23 — self-repair diagnostics

## CodeSpace runtime self-repair
- Added the read-only `codespace_runtime_check` agent tool. It inspects the local bridge/runtime, workspace, recent terminal sessions and error lines, Installed Tools records, and OpenCode status in one call.
- The tool is available whenever the local bridge is connected, even when no project folder is open.
- Added explicit agent workflow guidance to distinguish CodeSpace-host problems from project problems, gather evidence first, request the correct CodeSpace source folder when necessary, then repair with checkpoints/permissions and verify.
- Preserves the workspace jail: the agent must not guess or search outside the opened workspace. Source edits to CodeSpace itself require opening its source folder first.
- Runtime check is read-only; edits, commands, installs, and destructive operations continue to use existing approval and permission gates.

## Verification
- See `verify-self-repair.cjs` and `npm test` results for the checks actually run on this build.
