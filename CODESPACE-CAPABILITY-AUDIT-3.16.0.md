# CodeSpace 3.16.0 — VS Code Extension Marketplace Capability Audit

## Release scope

This release adds a first executable VS Code Web Extension compatibility layer to the existing CodeSpace 3.15.1 source. It does **not** claim complete desktop VS Code extension compatibility.

## Implemented

- Extensions page contains a searchable **VS Code Extension Marketplace** backed by Open VSX.
- Recommendation and keyword search use the same compatibility-probing path. Results are omitted unless their VSIX package passes CodeSpace checks.
- Candidate checks include ZIP safety and CRC validation, size/file-count limits, zip-slip and symlink rejection, matching local/central ZIP headers, compatible VS Code engine range, exact publisher/name/version match with the registry record, a safe bundled `.js` browser entry point, supported contribution points, and the supported API allowlist.
- Install, installed listing, and uninstall are connected to the real Agent Server and protected by the existing permission model.
- Installed browser entry assets are served only from the CodeSpace extension directory and only when the local bridge token is supplied.
- Compatible browser code runs in a dedicated Web Worker with a deliberately small VS Code API implementation: command registration/listing, configuration access, notifications, output channels, URI helpers and environment metadata.
- Worker activation errors and command results are surfaced in the Extensions view.
- CodeSpace UI preferences remain intact, including the compact Extensions page, question-mark help marker, and permission control in the second composer row.

## Explicit compatibility boundary

Only web extensions that satisfy the CodeSpace Web Extension Host's implemented runtime and API subset are listed as installable. Node.js/desktop/remote extensions, native binary extensions, extensions using workspace file APIs, terminal/debugger/webview/language-server APIs, unsupported VS Code APIs, external imports, or unsupported manifest contributions are excluded.

This is a restricted compatibility implementation, not the full VS Code Extension API. Static checks cannot prove every runtime behavior; a candidate can still fail on activation if it uses dynamic or undocumented behavior. Such failures are shown in CodeSpace. Open VSX is used as the registry; no claim is made that Microsoft Marketplace services are unrestricted for third-party clients.

## Verification performed

- `node --check agent-server.js` — PASS
- `node --check vscode-extension-support.cjs` — PASS
- `node --check src-js/24-vscode-marketplace.js` — PASS
- `node --check js/app.js` — PASS
- `node tools/build-web.cjs` — PASS
- `node verify-vscode-marketplace.cjs` — 23/23 PASS
- `node verify-vscode-marketplace-server.cjs` — 10/10 PASS against a real Agent Server process and a synthetic VSIX fixture
- `node verify.cjs` — 164/164 PASS
- `node verify-ui-cleanup.cjs` — 15/15 PASS
- `node verify-chat-zai.cjs` — 6/6 PASS
- `node verify-bridge.cjs` — 89/89 PASS
- `node verify-desktop.cjs` — 22/22 PASS
- `node verify-google-auth-routing.cjs` — 8/8 PASS
- `node verify-tool-installer.cjs` — 14/14 PASS
- `node verify-tool-manager.cjs` — 12/12 PASS
- `node verify-3.12.8.cjs` — 16/16 PASS
- `node verify-models-thinking.cjs` — 30/30 PASS
- `node verify-copilot-fallback.cjs` — PASS
- `node verify-menubar.cjs` — 43/43 PASS
- `node verify-install-location.cjs` — 5/5 PASS
- `node verify-self-repair.cjs` — 11/11 PASS
- `node verify-one-click-repair.cjs` — 11/11 PASS
- `node verify-agent-recovery.cjs` — 10/10 PASS
- `node verify-task-center.cjs` — 15/15 PASS

The aggregate `npm run verify:all` command was attempted but exceeded the execution window while running the pre-existing sandbox verification stage. The individual checks listed above were executed separately. Docker/Podman end-to-end availability depends on the host and was not established here.

## Not verified in this environment

- Live Open VSX network search and real registry VSIX downloads: outbound DNS/network access was unavailable in the build container.
- Full Electron visual testing on Windows.
- Compatibility with every extension in Open VSX or the Microsoft Marketplace.
