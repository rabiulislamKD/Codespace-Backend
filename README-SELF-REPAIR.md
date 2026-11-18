# CodeSpace self-repair workflow (3.13.24)

Ask the CodeSpace agent to fix a CodeSpace or project problem in ordinary language.

For host/agent/tool/provider/terminal/browser/integration failures, the agent should start with the read-only `codespace_runtime_check` tool. It gathers bridge/platform/runtime information, active terminal session errors, tracked Installed Tools, and OpenCode status.

For an opened project, the agent can then use the existing `project_health_check`, `get_diagnostics`, `workflow_diagnostics`, `run_tests`, code search, file tools, terminal, and browser tools to identify and repair the root cause.

Repair rules:
1. Diagnose before editing; distinguish a CodeSpace installation issue from a project issue.
2. Inspect Git status/diff and preserve pre-existing user changes.
3. Use focused edits and the existing approval/checkpoint controls.
4. Install missing tools only from reviewed official sources through `install_tool` and explicit approval.
5. Never search or edit outside the opened workspace. If CodeSpace's source is outside it, ask the user to open the source folder or provide the exact path and approve access.
6. Verify the actual fix with relevant tests/diagnostics; report what was and was not checked.

The runtime check is read-only. It does not start/stop processes, change configuration, or edit files.

## Find the CodeSpace install folder
Use `codespace_locate_installation` when the user asks where CodeSpace is installed or when CodeSpace itself needs source repair. It returns the exact active app root, launcher EXE, backend path, portable directory, resources directory, known source-file inventory and a read-only writable check. The locator uses paths passed by the running Electron process and does not search all drives or user folders. If the CodeSpace source folder is not the currently opened workspace, give the user the discovered `installRoot` and ask them to open that folder before editing; never bypass the workspace jail.
