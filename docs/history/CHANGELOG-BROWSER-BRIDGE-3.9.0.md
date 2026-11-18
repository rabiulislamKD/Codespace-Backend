# CodeSpace 3.9.0 — Browser Bridge

## New
- **`bridge-extension/`** — Manifest V3 Chrome extension. The AI's `browser_*` tools can now drive your own signed-in Chrome (web mode). Read, click, type, scroll, screenshot, run JS, list/switch tabs.
- **Server:** `/bridge/status`, `/bridge/poll` (long-poll), `/bridge/result`, `/bridge/call`. Loopback + bearer token like every other endpoint; commands are audited.
- **Renderer:** in web mode the bridge is used automatically when the extension is connected; otherwise Agent Chrome as before. Desktop is unchanged (embedded browser). New tool `browser_tabs`.
- Browser tools are offered when only the bridge (or Desktop) provides a browser, even if no Chrome executable was found.

## Safety
Approval prompts for open/click/type/run-JS; only agent-opened or user-shared tabs; no cookies/debugger/history permissions; password values never read; loopback-only; stops at bot-check pages; page text marked untrusted; "Stop all" kill switch.

## Validation
`node verify-bridge.cjs` — 33/33 (real server + real extension code with a stubbed Chrome API and mock page, plus the renderer tool path). Mutation checks confirmed the loopback and bot-check tests fail when those safeguards are removed. `node verify.cjs` 109/109, `node verify-desktop.cjs` 25/25.
**Not run here:** real Chrome loading the extension, real websites. Load it unpacked and try it.
