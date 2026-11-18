# CodeSpace — Architecture

A portable, local-first AI coding assistant: an Electron desktop shell around a small local
server (`agent-server.js`) that serves a single-page chat UI and gives the AI safe, permission-gated
access to a workspace folder, a terminal, the web, and a browser.

```
┌──────────────────────────────  Windows / Linux / macOS  ─────────────────────────────┐
│                                                                                      │
│  ┌───────────────┐   spawns / loads    ┌──────────────────────────────────────────┐  │
│  │ CodeSpace.exe │ ──────────────────► │ CodeSpace.exe = Electron shell            │  │
│  │ (portable)    │                     │ desktop/main.cjs  (+ preload.cjs bridge)  │  │
│  └───────────────┘                     └──────────────┬───────────────────────────┘  │
│                                          loadURL('/') │  http://127.0.0.1:8787/?t=…  │
│                                                       ▼                              │
│  ┌───────────────────────────────────────────────────────────────────────────────┐   │
│  │ agent-server.js  (Node ≥18, zero required npm deps)                           │   │
│  │  • serves the UI (auto-rebuilds js/app.js via tools/build-web.cjs ensure())   │   │
│  │  • 120+ JSON endpoints (fs, git, term, browser, web, index, checkpoints,      │   │
│  │    extensions, skills, sandbox, sessions, …)                                  │   │
│  │  • token auth (prints at start), listens on 127.0.0.1 only                    │   │
│  │  • server-side permission gate (permissions.json)                             │   │
│  └───┬──────────────┬───────────────┬──────────────┬─────────────────────────────┘   │
│      │              │               │              │                                 │
│      ▼              ▼               ▼              ▼                                 │
│  workspace    sandbox-manager   ~/.my-agent    bridge-extension (Chrome/Edge MV3)    │
│  folder       (Docker/OCI,      (config,       the user's real browser is driven     │
│  (the jail —  Wasmtime, Win     sessions,      through this extension + a local      │
│  'outside'    Sandbox, WSL2,    skills,        native-messaging host in main.cjs)    │
│  perms gate)  Hyper-V, Mock)    extensions)                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 1. Runtime pieces

| Piece | File(s) | Role |
|---|---|---|
| Desktop shell | `desktop/main.cjs`, `desktop/preload.cjs`, `desktop/guest-patch.cjs` | Electron entry (`package.json → main`). Boots the server, opens the UI, hosts the embedded browser (guest WebContents get a plain-Chrome `userAgentData` at document_start so Google/Gmail sign-ins work) and exposes one argument-less IPC (`codespace:pick-folder`) for the native OS folder dialog. |
| Local server | `agent-server.js` | The bridge: static UI + JSON API + tool execution. Runs standalone with `node agent-server.js` or inside Electron. |
| Sandbox engine | `sandbox-manager.js` | `createSandboxManager(ctx)` factory. Providers: Docker/OCI, Wasmtime (WASI), Windows Sandbox, Hyper-V, WSL2 (detection only), **Mock (tests only, opt-in via `MY_AGENT_SANDBOX_MOCK=1`)**. |
| Web app | `my-chat-agent-v3.html` + `css/` + `src-js/` → `js/app.js` | The whole UI. See build chain below. |
| Browser bridge | `bridge-extension/` | Chrome/Edge extension the user installs so the agent can drive their real browser. |
| PWA | `pwa/` | manifest + service worker + icons, served at `/manifest.webmanifest`, `/sw.js`, `/icons/*`. |

## 2. Frontend build chain

```
SOURCE OF TRUTH (edit these)                 BUILT ARTIFACT (never edit)
my-chat-agent-v3.html  (HTML shell)   ─┐
css/01…07-*.css                       ─┼─ tools/build-web.cjs ─►  js/app.js   (IIFE bundle)
src-js/01…21,99-*.js (21 modules)     ─┘        (manifest.json)   (served to the browser)
```

- Rebuild manually: `node tools/build-web.cjs` (or `BUILD-APP.bat`).
- Optional single-file export (HTML with CSS+JS inlined): `node tools/build-web.cjs --single`
  → `CodeSpace-single-file.html`. Regenerable, not kept in the repo.
- **Auto-rebuild:** `agent-server.js` calls `build-web.cjs ensure()` before serving — a build is
  only produced when a `src-js/` fragment is newer than `js/app.js`. A syntax error in a fragment
  fails the build loudly instead of shipping broken code.
- The bundle is one IIFE: fragments share scope, order comes from `src-js/manifest.json`
  (`core` array → `pwa` entry, wrapped in `(() => { … })()`).

### src-js module map

| Module | Lines | Responsibility |
|---|---|---|
| `01-core-helpers-state.js` | 181 | `esc`, `$`, `clip`, formatters, global app state `S`, session persistence helpers |
| `02-sse-streams.js` | 21 | `consumeSSE` — streaming chat transport |
| `03-bridge-client.js` | 137 | `bcall` / `bApproved` — bridge HTTP client with hard timeouts + approval flow |
| `04-checkpoints.js` | 123 | Checkpoint UI state, per-turn checkpoint creation/restore |
| `05-markdown-diff.js` | 114 | Markdown/inline renderer, syntax highlighter (`t-*` classes), `diffOps`/`compactDiff`/`renderDiff`, `<think>` handling |
| `06-chat-render.js` | 317 | Chat DOM: turns, working steps (dot timeline), badges, undo/keep buttons, Copy actions |
| `07-meters-approvals.js` | 256 | Context-size meters, token estimates, approval prompts |
| `08-tools.js` | 333 | Tool schemas (`CODE_TOOLS`) sent to the model + client-side tool plumbing |
| `09-browser-bridge.js` | 704 | Browser automation actions (nav/click/type/screenshot/…), embedded + external browser |
| `10-model-adapters.js` | 336 | Provider adapters (OpenAI-compatible, OpenRouter…), SSE parsing, reasoning/thinking fields |
| `11-compress-context.js` | 185 | Context compression, turn activity, run reports, continuation notes |
| `12-live-activity-ui.js` | 379 | Live activity panel (roles, status orb, activity feed) |
| `13-multi-agent-orchestration.js` | 392 | Sub-agent roles (planner/architect/researcher/test), delegation + implementer note |
| `14-sessions.js` | 34 | Session list rendering |
| `15-editor.js` | 712 | File editor tabs, table view, code view; Browser panel modes (embedded Chromium, 3.13.5 `/browse` proxy, live iframe, Agent Chrome) |
| `16-explorer.js` | 200 | Workspace file tree; right-click menu (open/attach/rename/delete/new), drag & drop (tree → chat attach, tree → folder move), native OS folder picker |
| `17-terminal.js` | 338 | xterm.js terminals, `stripAnsi`, terminal lifecycle |
| `18-sidebar-connections.js` | 721 | Providers/keys UI, model catalogs, skills, CodeSpace tools, MySQL |
| `24-vscode-marketplace.js` | — | Open VSX marketplace, CodeSpace compatibility filter, isolated Web Extension Host |
| `19-activitybar-composer.js` | 442 | Activity bar, view switching, composer |
| `20-git-permissions.js` | 274 | Git panel actions, edit undo/keep (`undoMany`), permission modes/rules UI, activity log view |
| `21-palette-attachments.js` | 131 | Command palette, attachments (files, images, tree drag drops) |
| `99-pwa-install.js` | 22 | PWA install button (https only) |

## 3. Server (agent-server.js)

- **Transport:** all POST JSON to `/…` endpoints; responses are JSON. The token is required
  (`?t=` / header, printed at startup); the server binds `127.0.0.1` only.
- **Exception — `/browse` (3.13.5):** the Browser panel's Proxy mode loads websites through this
  endpoint (GET/POST) before the token gate, because iframe navigations carry no header. It is a
  plain user-facing website fetcher: framing headers stripped, URLs rewritten, upstream cookies
  kept in an in-memory jar. No agent tool routes through it; every real API stays token-gated.
- **Static files:** `/` → `my-chat-agent-v3.html`, `/js/app.js`, `/css/*`, PWA assets.
- **Auto-builds** the frontend on demand (see build chain).
- **Rate limits** per endpoint (`RATE_LIMITS`, e.g. `/ext/install` 8/min, `/skills/install` 10/min).
- **Audit log** of requests in the data folder.

### Endpoint groups

| Group | Endpoints (examples) | Purpose |
|---|---|---|
| info/config | `/info`, `/config/get|set` | Server capabilities, settings |
| workspace | `/workspace/set|dirs|close` | Choose the working folder (the jail root) |
| fs | `/fs/list|read|write|editbatch|delete|search|undo|redo|history` | File operations (workspace-relative) |
| git | `/git/status|diff|stage|commit|push|pull|branches|checkout|discard|init|log|unstage` | Git UI + agent git tools |
| term | `/term/start|read|write|resize|close|kill|list` | PTY terminals (node-pty optional) |
| run | `/run` | Run a shell command (AI tool) |
| browser | `/browser/nav|click|type|screenshot|tabs|…` | Browser automation (bridge/embedded/external) |
| bridge | `/bridge/status|call|poll|result` | Chrome extension bridge transport |
| web | `/web/search|fetch|extract|find|crawl|screenshot` | Web research tools |
| http | `/http/request|inspect|collection` | Raw HTTP tool |
| index | `/index/rebuild|search|map|symbols|references|related|rename|status` | Local code index for the workspace |
| checkpoints | `/checkpoints/create|list|restore|compare|delete` | File snapshots per turn |
| sessions | `/sessions/list|get|save|delete` | Chat sessions |
| skills | `/skills/list|get|install|remove` | SKILL.md-based skills (git clone or paste) |
| ext | `/ext/list|install|remove|toggle|call`, `/ext/catalog/search`, `/ext/package/inspect` | extension.json/MCP extensions |
| marketplace | `/ext/marketplace/search|install|installed|uninstall` | Open VSX search; validates and installs bundled browser extensions compatible with CodeSpace Web Extension Host; packages requiring Node/desktop APIs are filtered out |
| extension assets | `GET /extension-host/assets/:key/:path?token=...` | Serves only installed extension JavaScript after local bridge-token verification; path is confined to the installed extension folder |
| db | `/db/tables|describe|query` | MySQL (optional `mysql2`) |
| conn | `/conn/github|vercel|set|status|remove` | Saved service connections |
| opencode | `/opencode/install|run|status|auth/*` | Optional OpenCode CLI integration |
| task | `/task/create|list|get|retry|cancel|delete` | Long-running task tracking |
| sandbox | `/sandbox/create|exec|export|export/apply` (+ lifecycle) | Sandbox engine routes |
| dev | `/dev/tests|lint|format|diagnostics|deps|health|tooling|unused` | QA/dev tool runner |
| workflow | `/workflow/status|diagnostics` | Multi-agent workflow state |
| llm | `/llm/proxy` | Relay/proxy for model requests |
| perm/audit | `/perm/get|set`, `/audit/list` | Permission settings + audit trail |

### Permission model (server-side gate)

`PERM_DEFS` (16 categories) × 3 modes — stored in `~/.my-agent/permissions.json`:

| Category | New-install default |
|---|---|
| `fsEdit`, `terminal`, `network`, `browser` | `allow` |
| `outside` (reach beyond the opened folder) | `ask` |
| `ext`, `mcp`, `destructive`, `git` | `ask` |
| `sandboxCreate/Exec/Network/Mount/Export/Destroy` | `ask` |
| `sandboxProfiles` | `allow` |

Flow when a guarded endpoint is called in `ask` mode:
`permGuard()` → responds `{ needsApproval: true, challenge }` → the page shows a dialog →
caller resends with `approved: true` (+ fresh approval token) → server verifies and proceeds.
`deny` refuses even if the page approved. `allow` skips the dialog.

## 4. Data layout (`~/.my-agent/`)

```
~/.my-agent/
├── config.json            settings (providers/keys live here or in secrets)
├── permissions.json       permission modes (survives restarts)
├── sessions/…             chat sessions
├── skills/                installed skills (SKILL.md)
├── extensions/            installed extension.json/MCP extensions
├── vscode-extensions/     downloaded .vsix packages (stored only, never run)
├── checkpoints/           workspace snapshots
└── audit log
```

## 5. Security model (summary)

1. Binds `127.0.0.1` only; every request needs the startup token.
2. Workspace jail: file/command access is rooted at the chosen folder; reaching outside
   needs the `outside` permission (`ask` by default).
3. Server-side permission gate independent of the UI dialog; audited.
4. Extension installs never execute cloned code — extensions are manifests (`extension.json`
   with `mcp` command or declarative `tools`); MCP servers only start when explicitly called.
5. VS Code Marketplace `.vsix` downloads are stored packages, never executed.
6. Sandboxes (Docker/OCI, Wasmtime, Windows Sandbox) isolate risky runs; export to the real
   workspace is permission-gated and always creates a checkpoint first.

## 6. Testing & verification

| Layer | Tool | Scope |
|---|---|---|
| Unit tests | `npm test` (`node --test tests/`) — 90 tests | Pure functions loaded from `src-js/` fragments in a `vm` sandbox (markdown/diff renderer, model-adapter reasoning + SSE parsing, token-saver/agent-run reporting) + extracted server guards (`cpInside`, `cpRel`, `cpIdValid`, `cpFileOnDisk`, `cpAssertNoSymlinkComponents`, `validManifest`) — see `tests/helpers/load.cjs` |
| Integration harness | `npm run verify:all` (11 `verify*.cjs` scripts) | Server hardening, providers, sandbox, bridge, desktop, version features |
| Sandbox test provider | `MY_AGENT_SANDBOX_MOCK=1` | Non-isolated mock for test suites only, never auto-selected |

Fragment-loading trick used by the unit tests: the build wraps fragments in one IIFE, but the
loader concatenates the same fragments **without** the wrapper inside a `vm` context with DOM
stubs, then returns the named functions — so the *exact shipped code* is tested, not a copy.

## 7. Packaging

- `BUILD-PORTABLE-EXE.bat` → `npm install` → `npm run runtime:fetch` (downloads+verifies
  `runtime/node.exe`) → `electron-builder --win portable --x64` → `release/CodeSpace-Portable-<version>.exe`.
- `package.json → build.files` excludes docs, tests, verify scripts and runtime from the app bundle.

## 8. Crash-resilient agent run recovery (3.14.0)

The built-in agent persists an in-progress recovery snapshot at run start, after model responses and after complete tool-result cycles. The session records the last known phase, counters, changed paths and validation results. `lastRunStop = interrupted` is a recovery marker; the next message in that chat receives a one-time continuation instruction. This restores the most recent saved conversation/tool state, not the in-flight provider request. Before repeating a potentially side-effecting operation, the agent must inspect current state.

## 9. Persistent autonomous task center (3.15.0)

Each built-in agent run claims a session-linked task record. The record contains the original task prompt, lifecycle status, timestamps, current phase, model/tool counters, changed paths, bounded validation evidence and a bounded final report. Session persistence stores these records with the existing IndexedDB session data and the localStorage fallback. The task ledger is bounded to 50 records per chat.

The Run > Task Center surface aggregates tasks across chats. Users can queue work, explicitly run one queued item, resume interrupted/incomplete tasks in their original chat, open the source chat, and remove queued items. Queued tasks do not execute automatically. A run found in `running` state after app startup is relabelled `interrupted`.

Resume creates a new agent turn using the saved task prompt and conversation state; it does not replay old tool calls. The agent is instructed to inspect current workspace state before repeating side effects. Existing tool permissions, workspace boundaries, checkpoints, cancellation and execution limits remain authoritative. This release does not claim execution while the app is closed or unattended cloud execution.
