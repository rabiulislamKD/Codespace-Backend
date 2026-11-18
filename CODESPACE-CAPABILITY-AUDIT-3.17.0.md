# CodeSpace 3.17.0 — VS Code Extension Host Capability Audit

## Release scope

3.17.0 expands the 3.16.0 marketplace implementation with a separate Node.js extension process and a larger—but still deliberately limited—VS Code API compatibility layer. It does **not** claim complete VS Code extension API parity or guaranteed compatibility with every package in Open VSX / Microsoft's Marketplace.

## Runtime architecture

| Area | Capability in 3.17.0 | Boundary |
|---|---|---|
| Marketplace | Open VSX search and recommendations | Search candidates are downloaded and inspected before being returned; only compatibility-passing candidates are shown. |
| Web Extension Host | Bundled browser entry in a Web Worker | Only the limited CodeSpace web API allowlist and supported contributions pass. |
| Node.js Extension Host | Separate Node.js 22.13+ child process per extension | CommonJS `main` entry only; not a hardened OS sandbox. |
| VS Code API | Commands, configuration, workspace file/document API, basic text edits, notifications, output/progress/status, URI/range/edit types, limited environment/extension metadata and basic context state | Subset only; unknown APIs are rejected by static inspection. API methods may have simplified semantics. |
| Workspace file access | Server-mediated read/write/stat/directory/create/delete/rename/copy operations | Root jail and existing CodeSpace `fsEdit` / `destructive` permissions apply. Writes create file-history records where supported. |
| Process lifecycle | Activation, command execution, stop, uninstall, timeouts and bounded logs | Maximum 8 concurrent Node hosts; 256 MB heap per child; 20-second activation and 60-second command timeout. |
| Extension contributions | `commands` and `configuration` | Debuggers, terminal, webviews, language servers, tasks, SCM, themes, snippets, custom editors, tree views and other contribution points are not yet implemented by this Node host. |

## Node-host compatibility checks

- VSIX ZIP structure, local/central file headers, CRCs, path traversal and symlink protection are validated during extraction.
- Publisher, extension name and version must match the Open VSX listing.
- Manifest `engines.vscode` must satisfy the implemented CodeSpace API target range.
- Node packages require a safe `.js` or `.cjs` CommonJS `main` entry; `type: module`, native `.node` addons and unsupported contribution points are excluded.
- Bundled JS dependencies are scanned for unsupported module/network/process APIs before a candidate can appear in results.
- The Node host denies direct access outside its granted package/state paths under Node's Permission Model and mediates workspace access through the Agent Server.
- Additional guardrails block `child_process`, worker threads, common network modules/transports, native loading and process kill/debug signalling.

**Security caveat:** Node.js states that its Permission Model is a seat-belt mechanism, not a security guarantee against malicious code. Code already executing inside the Node process may bypass it. These controls reduce accidental access and known capability paths; they do not make an untrusted marketplace package safe. Only run Node-host extensions from publishers you trust. Before CodeSpace can safely advertise arbitrary third-party Node extensions, it needs OS-level isolation (for example a platform sandbox or container with an independently enforced identity/network/filesystem boundary).

## Files changed / added

- `vscode-node-extension-host.cjs` — Node child runner and VS Code API shim.
- `vscode-extension-support.cjs` — Node VSIX inspection and CodeSpace runtime compatibility selection.
- `agent-server.js` — host lifecycle, command/RPC routes, permission-gated workspace bridge and uninstall cleanup.
- `src-js/24-vscode-marketplace.js` and rebuilt `js/app.js` — marketplace and installed-extension lifecycle.
- `my-chat-agent-v3.html` — concise trust / compatibility tooltip.
- `pwa/sw.js` — bumped cache to `codespace-pwa-53-node-extension-host-31700`.
- `verify-vscode-node-host.cjs` — VSIX inspector, child process and real Agent Server integration tests.
- Updated package scripts and regression assertions for 3.17.0.

## Verification results

| Check | Result |
|---|---:|
| JavaScript syntax (`agent-server.js`, Node host, VSIX support, marketplace module and app bundle) | PASS |
| `tools/build-web.cjs` | PASS |
| Unit tests (`npm test`) | 95 passed |
| Main application verifier (`verify.cjs`) | 164/164 |
| Server hardening (`verify-server-hardening.cjs`) | 31 passed |
| Provider integration (`verify-providers.cjs`) | 25 passed |
| CodeSpace 3.11 security regression | 147 passed |
| CodeSpace 3.12.8 focused regression | 16 passed |
| Model / thinking regression | 30 passed |
| Chat Z.ai regression | 6 passed |
| Browser Bridge regression | 89/89 |
| Desktop packaging integration | 22/22 |
| Integrated Browser / Google auth routing | 8/8 |
| Tool installer | 14/14 |
| Tool manager | 12/12 |
| CodeSpace Copilot fallback | PASS |
| Menubar | 43/43 |
| Install-location discovery | 5/5 |
| Self-repair | 11/11 |
| One-click repair | 11/11 |
| Interrupted-agent recovery | 10/10 |
| Task Center | 15/15 |
| UI cleanup | 15/15 |
| VS Code Marketplace compatibility | 23/23 |
| VS Code Marketplace Agent Server integration | 10/10 |
| VS Code Node Extension Host, static + process + Agent Server integration | 31/31 |

The aggregate `npm run verify:all` did not finish within the execution window because its existing sandbox-provider stage takes a long time in this environment. The sandbox checks that require Docker/Podman could not be end-to-end confirmed because neither provider was available. Other listed suites were run separately. Some longer combined manual runs also reached the execution timeout; those suites were run independently earlier in the verification sequence.

## Not verified here

- Live Open VSX discovery and download of third-party packages: outbound DNS/network access was unavailable in the build environment. Marketplace install and lifecycle tests use a generated synthetic VSIX fixture.
- A real-world third-party extension corpus: no claim is made that static inspection proves runtime compatibility for every package.
- Full Windows Electron interactive UI testing.
- A newly built Windows portable EXE. This release is a source ZIP; the included build scripts can create the EXE on a Windows machine with dependencies installed.

## Next compatibility work

1. Add platform-enforced isolation for Node extension processes (separate restricted OS identity / AppContainer or container, filesystem policy, network denial and process/job limits).
2. Expand the Node API surface and event semantics, with independent compatibility tests per API.
3. Implement actual activation-event handling and extension enable/disable/update flows.
4. Add language-server support and then debugger/terminal/webview capabilities under explicit permission and sandbox models.
5. Run automated smoke tests against a curated real-world Open VSX corpus before widening marketplace filters.
