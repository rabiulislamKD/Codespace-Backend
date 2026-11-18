# CHANGELOG 3.13.2 — Resizable Side Panel & VS Code Marketplace Extensions

Version: 3.13.2
Date: 2026-11-03
Based on: 3.13.1 (dot-timeline steps, icon-free chat, multi-file app)

## 1. Resizable side panel

- New drag strip between the sidebar and the editor (`#sideSplit`), styled like the existing chat-pane divider: transparent normally, accent while hovering/dragging.
- Drag to resize (clamped 170px – 55% of the window); **double-click resets** to the default 264px.
- Width persists in `localStorage` (`agent3.sidew`) and survives restarts. When the sidebar is closed (`nosidebar`) or on narrow/mobile layouts the resizer hides automatically (`.nosidebar` now zeroes `--sidew` with `!important` so an inline saved width can't keep a ghost column).

## 2. Add Extension page — rebuilt around the real VS Code Marketplace

Data source: the same public gallery API Visual Studio Code uses
(`https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`), proxied through the
local backend (the marketplace sends no CORS headers, so a browser-only fetch would be blocked).

The page now contains **exactly two sections — nothing else**, per request:

1. **"Search Extensions in Marketplace"** — one search box, VS Code-style live results as you type (350 ms debounce):
   extension icon (real marketplace icon), name, `publisher · version`, install count and ★ rating, and a blue **Install** button. **No descriptions, no category filters, no npm results, no manual-install fields, no manifest paste, no "Auto-add pack" button.**
2. **Installed** — the existing minimal MCP-extension cards plus downloaded marketplace packages (name, size, Uninstall).

### What "Install" does (honest download)

Marketplace extensions are VS Code extension packages, so Install downloads the **real `.vsix`**
(the same file VS Code itself serves) into `<data folder>/vscode-extensions/` and lists it under
Installed with its size. Nothing is executed; Uninstall deletes the file. The UI says exactly that
("Downloaded … — saved as a .vsix package in your CodeSpace data folder.").

### Server (agent-server.js)

- `POST /ext/marketplace/search` — gallery query (filterType 10 text + filterType 8
  `Microsoft.VisualStudio.Code`, flags 914), returns cleaned items `{id, name, displayName,
  publisher, version, icon, installs, rating, ratingCount, updated}`; 15s timeout; network-permission aware; rate-limited 40/min.
- `POST /ext/marketplace/install` — downloads the `Microsoft.VisualStudio.Services.VSIXPackage`
  asset, verifies the ZIP (`PK`) signature, saves to `DATA/vscode-extensions/<publisher>.<name>-<version>.vsix`; rate-limited 12/min; audit-logged.
- `POST /ext/marketplace/installed` / `POST /ext/marketplace/uninstall` — list/delete (path-sanitized to the VSIX folder).

### Client

- New marketplace module in `src-js/18-sidebar-connections.js` (`searchMarketplace`,
  `renderMktRows`, `installVsix`, `loadVsixList`) with stale-response guarding (sequence counter).
- Removed: `EXT_CATALOG`, auto-add pack, npm registry search UI, manual install + JSON manifest
  sections and their handlers (the server-side npm/MCP install API is retained for API users).
  The `installExt` approval flow is kept for future reuse. Old marketplace-card CSS replaced by
  compact `.ext-mkt-*` row styles.

## Verification

- All suites green: verify.cjs **161/161**, desktop 25/25, providers 25, models/thinking 28.
- Live end-to-end test (real backend + headless browser): marketplace search returned live
  results (e.g. "Python · ms-python · 243.9M installs · ★4.2"), Install downloaded
  `uguraktas.nanothemes-1.3.0.vsix` (1.0 MB) to the data folder and listed it under Installed,
  Uninstall removed it; side panel dragged 258→397px, persisted across reload, double-click reset works.
- Splash line: `v3.13.2 — Resizable Side Panel, VS Code Marketplace Extensions`; PWA cache version bumped.
