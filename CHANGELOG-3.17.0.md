# CodeSpace 3.17.0 — Expanded VS Code Extension Hosts

## Added
- Added a dedicated Node.js extension host that runs each compatible Node extension in a separate child process.
- Added a conservative VSIX inspector for Node extensions: VS Code engine range, safe CommonJS entry point, package/dependency scan, supported VS Code API references, contribution-point allowlist, native-addon exclusion, network/process API exclusion, exact registry identity and safe archive extraction.
- Added a restricted Node-host VS Code API surface for commands, configuration, workspace documents/files, basic edits, notifications, output/progress/status, URI/range/edit helpers, extension metadata and basic persistent context storage.
- Routed extension workspace filesystem operations through the CodeSpace Agent Server so workspace boundaries and `fsEdit` / `destructive` permission settings are applied.
- Added lifecycle limits and controls: maximum eight active Node extension processes, 256 MB heap per host, activation and command timeouts, stop on uninstall/server shutdown, bounded logs and command allow-listing.
- Added defense-in-depth restrictions for child processes, worker threads, native add-ons, common network transports, process signalling and debug signalling.
- Updated the Extensions marketplace compatibility checks and the CodeSpace capability audit for both Web and Node extension hosts.

## Compatibility boundary
- Open VSX is the default discovery registry. Only results whose downloaded VSIX passes the matching CodeSpace compatibility checks are returned.
- Web-host extensions continue to use the restricted Web Worker runtime.
- Node-host extensions currently support CommonJS (`main`) packages and a limited VS Code API subset. ES modules, native add-ons, network access, child processes, worker threads, terminal/debugger/webview/language-server and other unsupported contribution/API points remain excluded.
- Static compatibility checks cannot guarantee that arbitrary extension code will activate or behave correctly. Runtime activation failures are reported.
- Node's Permission Model is a guardrail and is **not** a security boundary against malicious code. Node-host extensions must be treated as trusted publisher code. A hardened OS-level isolation layer is still required before running arbitrary/untrusted extension packages.

## Preserved
- The existing compact CodeSpace interface and Extensions page layout.
- Permission control location in the second composer row.
- Existing approval gates, workspace jail, checkpoints and file-history flow.

## Verification
- Node extension-host verification: 31/31 checks.
- Marketplace compatibility: 23/23.
- Marketplace Agent Server integration: 10/10.
- Main application verifier: 164/164.
- Unit tests: 95 passed.
- Existing security, provider, bridge, desktop, browser, tool manager, task center, repair and UI regression suites were run individually. See `CODESPACE-CAPABILITY-AUDIT-3.17.0.md` for the tested results and environment limitations.
