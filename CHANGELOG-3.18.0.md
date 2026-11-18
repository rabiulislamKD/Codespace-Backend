# CodeSpace 3.18.0 — Advanced VS Code Extension APIs

## Added
- Extended the Node.js VS Code Extension Host to support both CommonJS and ES-module (`type: module` / `.mjs`) extension entry points, including named imports from the CodeSpace `vscode` API shim.
- Added a managed `child_process` bridge for asynchronous `spawn` and `execFile`; extension processes cannot use shell execution, synchronous process APIs or `fork`.
- Added detection and permission gating for bundled native executables and `.node` native add-ons. The separate **Native extension code** permission must be explicitly set to Allow before activation or native execution.
- Added managed terminal creation/control through the existing CodeSpace terminal manager. Terminal permission must be Allow.
- Added stdio language-server process support and document lifecycle synchronization, alongside selected completion, hover, definition, references, formatting, code-action, rename, signature-help, symbol, code-lens and diagnostics providers.
- Added local stdio Debug Adapter Protocol lifecycle support: adapter startup, initialize/launch/configurationDone, stop events and an installed-extension **Stop debug** control.
- Added webview panel and webview-based contributed-view support using a sandboxed iframe, message relay and content security policy.
- Added an extension-manager control to stop active DAP sessions and metadata indicating when an installed package needs Native extension code permission.
- Tightened marketplace filtering: unsupported terminal-profile contributions and TCP `DebugAdapterServer` transports do not appear as compatible. Unsupported API references and contribution points continue to be excluded before recommendations/search results are displayed.
- Bumped the PWA cache version and rebuilt `js/app.js` from `src-js/`.

## Compatibility boundary
- The Web Extension Host remains limited to bundled browser extensions and its implemented Web API subset.
- The Node Extension Host requires Node.js 22.15 or newer.
- Native `.node` add-ons and native executables are powerful code. The permission gate is explicit, but native code can bypass JavaScript-level restrictions and may run with the current user's operating-system privileges.
- Debugging currently supports local stdio adapters and a basic session lifecycle. Full breakpoint, stack-frame, variables, evaluation, terminal-request and adapter-specific workbench behavior is not implemented.
- Language servers are supported through managed stdio processes and the implemented language-provider/document APIs. TCP/network LSP transports are blocked. A broad corpus of real third-party language-server extensions has not been validated.
- Webview panels and webview-based contributed views are rendered in CodeSpace's sandboxed iframe. This is not exact VS Code webview/workbench parity.
- Terminal profile contributions, custom `TreeDataProvider` views, TCP `DebugAdapterServer`, tasks, SCM, custom editors, authentication/secrets, remote/network transports and all other unimplemented APIs remain excluded from Marketplace results.
- Static compatibility inspection cannot guarantee activation or full behavior. A package can still fail at runtime due to hidden dependencies, dynamic behavior or undocumented APIs.
- Node's Permission Model is a guardrail, not a malicious-code sandbox. OS-level isolation is still required before treating arbitrary marketplace extensions as safe.

## Preserved
- Open VSX discovery and the compatibility filter shared by recommendations and keyword searches.
- Existing compact CodeSpace UI, clean Extensions page and permission shield in the second composer row.
- Existing extension install/uninstall approval, workspace jail, file permissions, terminal permissions and destructive-action permissions.
- Existing agent, model/provider, browser, task, repair and portable desktop source architecture.

## Verification
- Unit tests: 95/95 passed.
- Main application verifier: 164/164 passed.
- UI cleanup / permission layout: 15/15 passed.
- Marketplace compatibility: 23/23 passed.
- Marketplace Agent Server integration: 10/10 passed.
- Node Extension Host verification: 58/58 passed (including real local Agent Server integration).
- Task Center: 15/15 passed.
- Interrupted-agent recovery: 10/10 passed.
- One-click repair: 11/11 passed.
- Server hardening: 31 checks passed.
- Provider integration: 25 checks passed.

See `CODESPACE-CAPABILITY-AUDIT-3.18.0.md` for scope, verification method and remaining limitations.

## Bug-fix pass (post-release)
- **Boot crash:** a stray `async` token in `src-js/24-vscode-marketplace.js` parsed via automatic semicolon insertion but threw `ReferenceError: async is not defined` while the app loaded, so everything after it in the bundle (webview message relay, dialog close handlers, document sync, PWA installer) never ran. Removed; `js/app.js` rebuilt; service-worker cache bumped to `codespace-pwa-55-extension-host-bugfix-31801` so installed clients drop the broken cached bundle.
- **Extension host `vscode.Range` / `Selection`:** `new Range(startPosition, endPosition)` produced an end of (0,0). Both constructor forms now work, start/end are normalised, and `Position`/`Range` gained the common helper methods.
- **`getWordRangeAtPosition`:** looped forever (hanging the host) when the position was not inside the first word on the line.
- **`workspace.applyEdit`:** with several edits to one file only the last survived (each edit re-read stale text), and the cached document was never refreshed. Edits are now grouped per file, resolved against the original text, applied back-to-front and written once.
- **`vscode.FileSystemError`:** was `Object.assign(Error, …)`, which mutated the global `Error`. Now a real class with the standard static factories.
- **`languages.getDiagnostics(uri)`:** always returned `[]`; `doc.lineAt(position)` ignored a `Position`; `onDidChangeConfiguration.affectsConfiguration` only matched exact keys; managed-process stdout/stderr never ended.
- **`workspace.findFiles`:** `**/*` and `**/*.js` skipped files in the workspace root, `src/**/*.js` skipped `src/a.js`, and `{ts,js}` alternation never matched. New glob converter (ReDoS-safe); `RelativePattern`-style objects are accepted.
- **Server RPC:** `workspace.delete` tied `force` to `useTrash`; `rename`/`copy` silently overwrote an existing destination; managed-process env could set `LD_*`, `DYLD_*`, `NODE_*` and `ELECTRON_*` (preload/loader injection); a process that failed to spawn kept its slot (limit 8); a single unhandled rejection in a running extension marked the host failed and orphaned its process on restart; `diagnosticsClear` used a different default collection key than `diagnostics`.
- **Compatibility inspector:** engine ranges with spaces (`>= 1.85.0`) and `1.90.x` were rejected / mis-compared, and the Node API allow-list omitted providers and events the host implements and this changelog advertises (signature help, document symbols, code lens, `onDidCloseTextDocument`, `onWillSaveTextDocument`, `createFileSystemWatcher`, `window.terminals`, quick pick, input box, `env.clipboard`).
- **Tests:** `tests/extension-host-regressions.test.js` (11 tests, drives the real host process); `verify-chat-zai.cjs` no longer pins a stale cache-version string. Unit tests: 106/106.
