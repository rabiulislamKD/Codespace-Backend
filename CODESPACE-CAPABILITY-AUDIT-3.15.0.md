# CodeSpace capability audit — 3.15.0

Base: the saved CodeSpace 3.14.0 Crash-Resilient Agent archive. This release extends its foreground agent runtime with a persistent, user-controlled task ledger; it does not introduce an always-on cloud worker.

| System | Status in 3.15.0 | Evidence / boundary |
|---|---|---|
| Autonomous Agent Core | Improved | Existing plan/tool/test/repair loop now writes a session-linked task record with progress and final status. Resume uses saved chat context and inspects current workspace state; it does not replay old tool calls. |
| Task management | Present | Run > Task Center lists queued, running, interrupted, completed and failed/incomplete tasks across chats. Tasks can be queued, run individually, resumed or removed while queued. Queue execution is explicit, not automatic. |
| Crash recovery | Improved | A task still marked running at startup becomes interrupted and can be resumed. The in-flight provider request itself is not restored. |
| Multi-agent orchestration | Present | Planner, architect, researcher, QA/test strategy, implementer and independent reviewer stages remain available. |
| Universal AI engine | Present | Existing provider adapters, model routing and CodeSpace Copilot free-model fallback remain unchanged. |
| Computer control | Partial | Workspace filesystem, terminal and supported browser controls exist; this is not unrestricted desktop-wide control. |
| Self-diagnosis and repair | Present | Repair CodeSpace, runtime diagnostics, project health checks and Installed Tools remain available. |
| Universal app builder | Partial | Generic project tools support multiple stacks; there is not yet a complete platform-specific guided generator for every app type. |
| Browser and visual agent | Present, capability-dependent | Integrated Chromium, DOM/accessibility inspection, browser interaction and screenshots remain; model vision support and website bot checks limit capability. |
| Recovery and rollback | Present | Checkpoints, file history, undo/redo and Git diff remain, with existing permission gates. |
| Tools and skills ecosystem | Present | Tool manager, skills, MCP/declarative tools and Marketplace VSIX storage remain. |
| Persistent project intelligence | Partial | Existing sessions, project memory and code index remain; automatic memory curation and freshness need further work. |

## 3.15.0 implementation

- Added `src-js/23-task-center.js` and the Task Center dialog.
- Each normal built-in agent run creates or claims a task record and persists progress/final state.
- Running tasks discovered at startup are marked interrupted.
- Resume preserves task identity and original prompt; it creates a new turn with instructions to inspect existing changes and continue from unfinished work.
- Queue is explicit: Run / Run next launches one queued item; no background or automatic queue execution.
- Task history is bounded to 50 records per chat and stored with existing session persistence.
- Existing permission checks, workspace restrictions, checkpoint behavior, tool limits and stop/cancel controls were not weakened.

## Verification status

- `npm test`: 95 passed, 0 failed.
- Task Center structural checks: 15/15 passed.
- Crash-recovery checks: 10/10 passed.
- One-click repair: 11/11 passed.
- Self-repair: 11/11 passed.
- Core existing verification also passed: 162/162, security 147/147, browser bridge 89/89, desktop 22/22, menu 43/43, provider 25, model/thinking 30, Google/browser routing 8/8, and focused tool-manager/installer/CodeSpace Copilot checks.
- The full `npm run verify:all` chain did not finish within the sandbox execution window; its sandbox integration stage stalled after the mock-execution checks. Therefore the full chain is not reported as passed.

## Known limitations

- Tasks cannot continue while CodeSpace is closed; they become resumable after restart.
- Resume is not exactly-once execution. It asks the model to inspect current state before repeating side effects; users should review consequential changes.
- Queue launch is user-controlled and one task at a time. No automatic background scheduling is included.
