# CodeSpace 3.18.0 — VS Code Extension Compatibility Audit

## Release scope

3.18.0 expands the 3.17 Node.js extension host. It adds a broader set of usable extension APIs and runtime classes; it does **not** claim complete VS Code extension-host parity or guarantee that every package in Open VSX or Microsoft's Marketplace will work.

## Runtime and feature matrix

| Capability | 3.18.0 implementation | Tested boundary |
|---|---|---|
| Marketplace | Open VSX search and recommendations | Each candidate is downloaded and inspected before it is returned; only compatibility-passing packages are displayed. Live registry access was not verified in this build environment. |
| Web Extension Host | Browser-bundled `browser` entry in a Web Worker | Limited browser VS Code API subset; no Node.js APIs. |
| Node Extension Host | Separate Node.js child process per extension | Requires Node 22.15+ for `Module.registerHooks()` ESM mapping. Not an OS security sandbox. |
| CommonJS / ESM | `main` JS/CJS/MJS and `type: module`; named/default `vscode` imports | CommonJS and ESM fixture activation passed. |
| Managed child processes | `child_process.spawn` and `execFile` bridge to Agent Server | Shell execution, sync process methods and `fork` are blocked. `terminal` permission required; native executable also requires `nativeCode=allow`. |
| Native executables | Package-contained `.exe`, `.dll`, `.so`, `.dylib` and `.bin` assets detected and permission-gated | Linux `/bin/echo`-style fixture process passed. A real publisher executable on Windows was not tested. |
| Native Node add-ons | `.node` assets detected; runner adds `--allow-addons` only after explicit Native extension code permission | Activation is denied until permission is Allow. A real native `.node` binary was not loaded in this test environment. Node itself emits a warning that `--allow-addons` requires extreme caution. |
| Terminal | `window.createTerminal`, terminal process ID, show/hide, sendText and dispose through CodeSpace's terminal manager | Managed terminal creation was tested. `contributes.terminal` profile providers are deliberately excluded because `registerTerminalProfileProvider` is not implemented. |
| Language features | Completion, hover, definition, references, document/range formatting, code actions, rename, signature help, symbols, code lens and diagnostics providers | Completion request/response and diagnostics were tested. Provider methods have a limited API/data implementation. |
| Language servers | Managed stdio process lifecycle, document sync and LSP Content-Length framing | Synthetic LSP `initialize` handshake passed. The actual `vscode-languageclient/node` package and a broad real extension corpus were not tested. TCP/network transports are blocked. |
| Debug adapters | Local stdio DAP adapter via `DebugAdapterExecutable`; initialize, launch, configurationDone, session lifecycle and stop | Synthetic DAP adapter integration passed. TCP `DebugAdapterServer`, full breakpoint/stack/variable/evaluate UI and adapter-specific server requests are not implemented. |
| Webviews | `createWebviewPanel`, `registerWebviewViewProvider`, HTML updates, postMessage relay and iframe sandbox/CSP | Panel and contributed-view render paths were tested. CodeSpace presents contributed views in its own webview UI rather than replicating every VS Code container behavior. |
| Workspace / documents | Workspace file operations through the Agent Server, text document lifecycle sync and selected language providers | Existing workspace jail and `fsEdit` / `destructive` permission checks remain active. |

## Marketplace compatibility filter

Marketplace recommendations and keyword results use the same static compatibility inspector. It validates VSIX archive structure and entry points, publisher/name/version identity against the registry, VS Code engine range, operating-system/CPU declarations, native asset metadata, supported API references and contribution-point allowlists.

Current Node contribution allowlist includes commands, configuration, debuggers and webview-based views / view containers. `contributes.terminal` is rejected until terminal profile providers are implemented. Custom tree providers, TCP debugger descriptors and unimplemented API references are excluded. This is intentionally conservative but cannot prove arbitrary extension behavior; dynamic imports and runtime-discovered capabilities can still cause activation failure.

## Permission and security model

- Extension install/activation continues to use CodeSpace's extension permission gate.
- Workspace file operations continue through Agent Server RPC and CodeSpace workspace permission checks.
- Child processes and terminals require Terminal permission set to Allow.
- Bundled native executables and in-process `.node` add-ons require Native extension code permission set to Allow.
- Extension API networking and raw sockets remain blocked; stdio subprocess communication is the supported LSP/DAP transport.
- Per-extension Node processes use Node's Permission Model with narrow file grants, heap limits and bounded lifecycle/process counts.

**Critical limitation:** Node documents its Permission Model as a seat-belt mechanism rather than a security guarantee against malicious code. In particular, native add-ons can execute arbitrary native code in the process, while native executables run under the current user's OS identity. The current implementation is intended for trusted publishers only. It must not be represented as a hardened sandbox for arbitrary third-party packages. A separate OS-enforced identity/filesystem/network boundary is still needed for that.

## Verification results

| Suite | Result |
|---|---:|
| JavaScript syntax checks for server, support inspector, Node host, marketplace module and generated app bundle | PASS |
| `npm test` | 95 passed, 0 failed |
| `node verify.cjs` | 164/164 |
| `node verify-ui-cleanup.cjs` | 15/15 |
| `node verify-vscode-marketplace.cjs` | 23/23 |
| `node verify-vscode-marketplace-server.cjs` | 10/10 |
| `node verify-vscode-node-host.cjs` | 58/58 |
| Task Center | 15/15 |
| Interrupted-agent recovery | 10/10 |
| One-click repair | 11/11 |
| Server hardening | 31 passed |
| Provider integration | 25 passed |

## Not verified in this environment

- Live Open VSX registry search/download against the public service.
- A corpus of third-party packages that exercise real `vscode-languageclient/node` clients and multiple LSP server implementations.
- A real native `.node` publisher module or signed Windows native extension executable. The tests validate detection and explicit gating; the native executable process test uses a local system fixture.
- Full Windows Electron visual interaction testing.
- A newly compiled Windows portable EXE. This is a source ZIP; use the included Windows build scripts on a Windows machine with the required dependencies.
- Full `npm run verify:all`: previous full-suite attempts exceeded the available test window during the existing sandbox-provider checks; Docker/Podman end-to-end provider tests are unavailable in the current build container.
