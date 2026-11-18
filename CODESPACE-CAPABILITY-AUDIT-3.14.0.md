# CodeSpace capability audit — 3.14.0

This audit checks source and wiring in the 3.13.25 archive used as the 3.14.0 starting point. “Present” means the subsystem has code and app wiring; it does not mean every external provider, operating-system capability or optional dependency is installed on every machine.

| System | Status | Evidence / boundary |
|---|---|---|
| Autonomous Agent Core | Partial → improved in 3.14.0 | `src-js/13-multi-agent-orchestration.js` contains a model/tool execution loop, up to 100 tool calls per turn, duplicate-result loop protection, two auto-resume attempts, planning, validation tracking and progress reporting. 3.14.0 persists run snapshots and continuation state. This is still an interactive foreground agent, not an always-running cloud agent. |
| Multi-agent orchestration | Present | `src-js/13-multi-agent-orchestration.js` provides planner, architect, researcher, QA/test strategy, implementer and independent reviewer stages. Delegated specialists have a read-only tool allow-list; they do not edit files. |
| Universal AI engine | Present | `src-js/10-model-adapters.js` contains provider adapters and reasoning/SSE handling. CodeSpace Copilot free-model fallback is in the same module and covered by `verify-copilot-fallback.cjs`; automatic fallback is opt-in and does not silently replace a manually selected paid model. |
| Computer control | Partial | Workspace filesystem, terminal and browser control are available through `agent-server.js`, `src-js/09-browser-bridge.js` and `bridge-extension/`. This is not general operating-system desktop control or arbitrary mouse/keyboard control outside supported browser/terminal tools. |
| Self-diagnosis and repair | Present | `src-js/22-menubar.js` exposes Repair CodeSpace. `src-js/08-tools.js` defines runtime inspection tools; server routes include runtime/install-location, project health, diagnostics and installed-tools operations. |
| Universal app builder | Partial | Generic file, terminal, code-index, test, package-inspection and tool-install capabilities support many project stacks. There is not yet a full guided app generator with maintained templates and build/deploy recipes for every platform. |
| Browser and visual agent | Present, capability-dependent | Embedded Chromium, browser proxy, browser bridge extension, DOM/accessibility inspection, browser interactions and screenshots exist. Screenshot interpretation depends on the selected model's vision capability. Bot checks are not bypassed. |
| Recovery and rollback | Present | Checkpoints, comparison/restore, file history, undo/redo and Git diff are implemented. Checkpoint restore and destructive actions remain permission-gated. |
| Tools and skills ecosystem | Present | The tool catalogue contains 85 definitions in this archive. Installed Tools, tool installation, skills, declarative/MCP extensions and Marketplace VSIX download/storage are implemented. Marketplace packages are stored, not executed. |
| Persistent project intelligence | Partial | Sessions are saved locally, project memory is stored under workspace `.agent/project-memory.json`, and the code index supports symbol/search relations. Memory drafting is conservative and needs improved automatic curation and freshness handling. |

## 3.14.0 changes

The agent saves an in-progress snapshot when a run starts, after model responses and after complete tool-result cycles. Snapshots include phase, model rounds, tool counts, changed paths and validation statuses. On the next message in that chat, an interrupted run receives a one-time internal continuation note. In-progress reports explicitly say they are not completion reports. Final state is saved separately.

Recovery is best-effort: the most recent completed save point is restored, not the in-flight model request itself. A tool or command that had already begun may have side effects; the resumed agent must inspect the current workspace and verify state before repeating it.

## Next engineering priorities

1. Make run history and explicit Resume/Discard controls visible, with idempotency protection for in-flight side effects.
2. Add a provider-neutral, persistent task contract before introducing true unattended/background AI runs.
3. Improve project memory with explicit source paths, freshness and user-approved updates.
4. Add platform-specific app templates and build/preview/deploy recipes.
5. Extend computer control only through explicit capabilities and permission gates.
