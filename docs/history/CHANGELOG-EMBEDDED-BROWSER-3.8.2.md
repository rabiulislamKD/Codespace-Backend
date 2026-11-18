# CodeSpace 3.8.2 — Embedded Browser routing fix

## Fixes
- Desktop Browser mode now exposes only the embedded Chromium view; the separate Agent Chrome mode is removed from the Desktop selector.
- AI `browser_open`, `browser_read`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_scroll`, and `browser_run_js` operate on the same embedded webview.
- Desktop backend is launched with `MY_AGENT_DISABLE_EXTERNAL_BROWSER=1`; legacy CDP endpoints refuse to start a separate Chrome process.
- Desktop app popups/external navigations are denied instead of being forwarded to the OS default browser. The Browser panel's external-link icon copies the URL on Desktop.
- Viewport, diagnostics, preview reload, navigation controls and security-check messaging are adjusted so Desktop UI paths do not invoke legacy Chrome endpoints.
- Persistent guest partition remains `persist:codespace-browser`.
- Cloudflare/CAPTCHA checks are not bypassed. The user must complete any challenge manually inside the embedded panel.

## Validation
- `node --check agent-server.js` — passed.
- `node --check desktop/main.cjs` — passed.
- `node --check desktop/preload.cjs` — passed.
- Inline application script syntax — passed.
- `node verify.cjs` — 109/109 passed.
- `node verify-desktop.cjs` — 11/11 passed.
- Windows Electron runtime and live website/Cloudflare behavior were not executed in this environment.
