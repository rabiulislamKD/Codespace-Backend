# CodeSpace 3.16.0 — VS Code-compatible extension marketplace

## Extensions view
- Restored a searchable VS Code extension marketplace section inside Extensions.
- Uses Open VSX as the default vendor-neutral registry.
- Recommendations and normal search both pass through the same compatibility probe; incompatible/unverified results are omitted rather than shown as installable.
- The marketplace shows only VSIX packages whose manifest contains a compatible VS Code engine, a bundled browser entry point, supported contribution points and a supported VS Code API subset. Registry publisher, extension name and version must match the VSIX manifest exactly.

## Runtime and installation
- Added a conservative CodeSpace Web Extension Host in isolated Web Workers.
- Added command registration/execution, configuration reads/updates, notification messages and output channels.
- Network APIs, Node.js access, DOM access, external imports and extra script loading are blocked inside extension workers.
- Added safe VSIX inspection/extraction with zip-slip path checks, ZIP64 rejection, file-count and extracted-size limits, symlink rejection and per-entry bounds.
- Installed extensions are stored under the CodeSpace data directory and their browser entry assets are served only after local bridge-token validation.
- Install/search/uninstall remain behind the existing permission model.

## Compatibility boundary
This release does not claim complete VS Code desktop compatibility. Extensions requiring Node.js/local/remote extension hosts, workspace file APIs, terminals, debuggers, webviews, language-server APIs or unsupported VS Code API methods are excluded. Passing static checks is not a guarantee against every dynamic runtime failure; activation errors are reported in the Extensions view.

## Verification
- `node --check agent-server.js` — PASS
- `node --check src-js/24-vscode-marketplace.js` — PASS
- `node verify-vscode-marketplace.cjs` — 23/23 PASS (ZIP safety, registry identity, browser-entry rules, worker syntax and command execution mock)
- `node verify-vscode-marketplace-server.cjs` — 10/10 PASS (real server install/approval/asset-token/uninstall integration)
- `node tools/build-web.cjs` — PASS
