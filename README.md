# CodeSpace

A portable, local-first AI coding assistant. A chat UI in an Electron desktop app (or any
browser) backed by a small local Node server that gives the AI permission-gated access to a
workspace folder, a terminal, git, the web, a browser, and disposable sandbox environments.
Bring your own model keys (OpenAI-compatible endpoints, OpenRouter, …).

- **Portable:** builds to a single no-install Windows EXE; desktop settings, browser profile and project data live beside the EXE in `CodeSpaceData/`.
- **Local & private:** server binds `127.0.0.1` only; installed extensions run only in explicitly enabled, restricted Web or Node.js extension hosts.
- **Permission-gated:** server-side allow/ask/deny rules for files, terminal, network, git,
  extensions, sandboxes — independent of the UI.

## Quick start

**Development (no Electron):**

```bash
node agent-server.js            # prints http://127.0.0.1:8787 + token
# open the printed URL in a browser; pick a workspace folder with "Open folder"
```

**Desktop (Electron):**

```bash
npm install
npm run desktop                 # fetches the Node runtime and launches Electron
```

**Portable EXE (Windows build machine):** run `BUILD-PORTABLE-EXE.bat`
(needs Node 22+; output in `release/CodeSpace-Portable-<version>.exe`).

**Requirements:** Node 18+ for the base app; the Node.js VS Code Extension Host requires Node 22.15+ (the desktop runtime fetches the latest supported Node 22 build). Optional: git, Chrome/Edge (browser bridge),
`npm install mysql2` (MySQL tool), `node-pty` (rich terminals). No other npm packages are
required to run the server.


## Integrated Browser (3.13.11)

Desktop uses a dedicated Electron `WebContentsView`, following the architecture of the VS Code
Integrated Browser rather than the older iframe-based Simple Browser or `<webview>` element.
The main process owns the Chromium page and its persistent `persist:codespace-browser` session;
the renderer communicates through a narrow IPC proxy. Cookies, localStorage, cache and login
state persist in `CodeSpaceData/BrowserProfile`. Website navigation, popups, page permissions,
console events, screenshots and permission-gated agent interactions are supported. Google
sign-in is no longer automatically redirected to the system browser; whether a particular
Google flow accepts the embedded Chromium context must be verified against Google's current
sign-in policy and the target OAuth application's configuration. CodeSpace does not spoof
browser identity or bypass CAPTCHA/security checks.

## Editing the UI (source of truth)

`js/app.js` is **generated** — never edit it.

```
my-chat-agent-v3.html + css/*.css + src-js/*.js   →  node tools/build-web.cjs  →  js/app.js
```

The server auto-rebuilds when it detects newer fragments; `Ctrl+R` in the app refreshes.
Optional one-file export: `node tools/build-web.cjs --single`.

## Scripts

| Command | What it does |
|---|---|
| `npm run desktop` | Launch the Electron desktop app |
| `npm run dist:portable` | Build the portable Windows EXE |
| `npm test` | Unit tests (`node --test tests/`) — pure functions from the real `src-js` code |
| `npm run verify:all` | Integration verification suite (server, providers, sandbox, bridge, desktop) |
| `node tools/build-web.cjs` | Rebuild `js/app.js` from source |

## Project structure

```
├─ agent-server.js          local server: UI + JSON API + tools (the bridge)
├─ sandbox-manager.js       sandbox engine (Docker/OCI, Wasmtime, Windows Sandbox, WSL2, mock)
├─ desktop/                 Electron shell (main, preload, guest browser patch)
├─ my-chat-agent-v3.html    UI shell (source of truth)
├─ css/01…07-*.css          UI styles (source)
├─ src-js/01…21,99-*.js     UI modules (source) — see ARCHITECTURE.md for the module map
├─ js/app.js                GENERATED bundle (do not edit)
├─ tools/build-web.cjs      frontend builder (auto-runs via the server too)
├─ bridge-extension/        Chrome/Edge extension for the browser bridge
├─ pwa/                     manifest, service worker, icons
├─ assets/codespace.ico     app icon
├─ verify-*.cjs             integration verification scripts (npm run verify:*)
├─ tests/                   unit tests (node --test)
├─ docs/history/            changelogs, old READMEs, security audits
├─ BUILD-APP.bat            rebuild js/app.js (Windows double-click)
├─ BUILD-PORTABLE-EXE.bat   build the portable EXE (Windows)
└─ scripts/fetch-node-runtime.cjs   downloads + verifies the bundled node.exe for the EXE
```

## Everyday features worth knowing

- **Browser panel** — Desktop uses a native Integrated Chromium Browser tab with a persistent
  session. Web/PWA mode retains the legacy proxy and iframe previews.
- **Right-click** — works everywhere in the desktop app (cut/copy/paste/select all, links, inspect); the explorer and website pages keep their own richer menus.
- **Explorer** — right-click any file or folder to open, attach to chat, copy the path, rename,
  delete, or create new files/folders. Drag a tree row onto the chat box to attach it, or onto a
  folder to move it; files dragged from Windows Explorer/Finder drop onto the chat box too.
- **Open folder** — uses the operating system's own folder dialog (Electron dialog in the EXE,
  PowerShell/AppleScript/zenity when running in a plain browser), with the in-app dialog as
  fallback.

## Security notes

- The server prints a secret token at startup; anyone with that token can run commands on the
  machine — keep it private.
- The AI is jailed to the opened workspace folder; reaching outside asks first.
- The Browser panel's **Proxy mode** fetches websites through the local server so sites that
  refuse embedding (Google, Gmail) work. It is user-facing only — it cannot touch the workspace
  or run commands, and every real API still requires the token.
- Installed GitHub extensions are manifests only (extension.json / SKILL.md); cloned code is
  never executed automatically. Compatible VS Code `.vsix` packages can run in the CodeSpace
  Web or Node.js Extension Host. Node-host packages execute trusted publisher code; Node's
  Permission Model is only a guardrail, not a security boundary against malicious code. Do not
  activate Node-host extensions from untrusted publishers.
- Sandboxes (Docker/OCI, Wasmtime, Windows Sandbox) isolate risky work; exporting sandbox
  output to your workspace always asks and creates a checkpoint first.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full design: module map, endpoint groups,
permission model, data layout, and testing strategy. Historical changelogs live in
`docs/history/`.


## Chat Z.ai composer mode (3.13.8)

CodeSpace includes a Chat Z.ai ON/OFF switch in the chat composer. It launches a local loopback adapter (port 9876), discovers available guest models and routes normal CodeSpace chat requests through the selected Chat Z.ai model. Connect the Agent Bridge first; Chrome or Microsoft Edge must be installed. The build installs `puppeteer-core` with `npm install`.

This uses the undocumented `chat.z.ai` website flow, not the official Z.ai developer API. The site may change its frontend signature module, guest access or rate limits at any time. See `CHAT-ZAI-INTEGRATION.md` for details and limitations.


## VS Code extensions in CodeSpace 3.18.0

The Extensions view searches Open VSX and filters both recommendations and keyword results through CodeSpace compatibility checks before displaying a package. Compatible VSIX files install into CodeSpace and activate in one of two runtimes:

- **Web Extension Host:** browser-bundled extensions run in a dedicated Web Worker with a constrained VS Code Web API subset.
- **Node.js Extension Host:** CommonJS and ES-module extensions run in separate Node 22.15+ processes. Workspace file access is mediated by CodeSpace permissions.

The expanded Node host supports command registration/execution, configuration, workspace documents and file operations, managed child processes, integrated terminal creation/control, stdio language-server processes, selected language providers (completion, hover, definition, references, formatting, code actions and rename), stdio language-server clients, local stdio DAP adapters (basic initialize/launch/stop lifecycle), webview panels and webview-based contributed views, output/progress/status and basic extension context storage. Bundled native executables and `.node` add-ons require the separate **Native extension code** permission to be explicitly set to Allow.

Compatibility remains a subset, not full VS Code extension-host parity. Terminal profile contributions, TCP `DebugAdapterServer` transports, full debugger workbench features (breakpoint/stack/variables UI and adapter-specific requests), custom `TreeDataProvider` views, remote/network language-server transports, tasks, SCM providers, custom editors, authentication/secrets, arbitrary workbench contributions and all unimplemented API references remain excluded. Marketplace results are filtered against the implemented runtime/API/contribution allowlists; static inspection cannot guarantee that a package will activate or behave fully correctly.

**Security boundary:** Node's Permission Model is a guardrail, not a security boundary against malicious code. Native add-ons and native executable processes can run trusted publisher code with the current user's OS privileges. Only run extensions from publishers you trust; use Native extension code permission sparingly. OS-level sandboxing is still needed before treating arbitrary third-party packages as safely isolated.

Open VSX is the default registry; Microsoft Marketplace access remains subject to Microsoft's terms. CodeSpace checks downloaded VSIX metadata and package contents before showing candidates, but each package still needs real activation and use to confirm its practical compatibility.
