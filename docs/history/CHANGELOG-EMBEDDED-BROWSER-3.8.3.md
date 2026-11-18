# CodeSpace 3.8.3 — Embedded browser that behaves like a browser, plus "Attach element to chat"

## Why 3.8.2 could still feel broken
- The `<webview>` had no `src`, and the code called `loadURL()` / `executeJavaScript()` straight away. Electron throws until the guest has fired `dom-ready`, so navigation and every `browser_*` tool could fail on a fresh start.
- Website popups and `target="_blank"` links were simply denied, so many links and every sign-in popup did nothing.
- The embedded Chromium still sent `Electron/x` and `codespace/x` in its user agent.
- Opening a workspace file preview in Desktop went through the legacy path.

## Fixes
- **Engine readiness:** webview starts at `about:blank`; `embeddedReady()` waits for `dom-ready` before `loadURL`, `executeJavaScript`, screenshots and page reads. `ERR_ABORTED` redirects are no longer reported as failures; a crashed page is reported and recovers on the next navigation.
- **Everything stays in CodeSpace:** plain new-tab links load in the current tab; script popups (OAuth/sign-in) open as sandboxed in-app child windows so `window.opener` works; links in chat and dev-server chips open in the Browser panel. Nothing is passed to the system browser, and the legacy CDP Chrome launcher is still refused on Desktop.
- **Chrome-like behaviour:** address bar searches when the text is not a URL (DuckDuckGo); Ctrl+L, F5, Ctrl+R, Ctrl+Shift+R, Alt+←/→, F12; right-click menu (back/forward/reload, open/copy link, copy/save image, cut/copy/paste, Inspect); camera/mic/location/notifications ask once per site; workspace file preview loads as a `file://` page in the embedded browser.
- **Honest user agent:** only the `Electron/…` and app-name tokens are removed, so the browser identifies as the Chromium it is. Nothing else is spoofed.
- **AI control:** `browser_click` now sends real mouse events (falls back to `el.click()` when the target is covered or has no size).

## New: right-click → Attach element to chat
Right-click any element in the Browser panel and choose **Attach element to chat** (or **Attach selected text to chat**). A chip appears in the composer. On send, the model receives the page URL/title, a unique CSS selector, tag, attributes, visible text, sanitized HTML (scripts/styles removed; password and hidden input values never captured), key computed styles, position, and an element screenshot when the model has vision. The agent can pass the selector straight to `browser_click` / `browser_type`.
- Captured content is wrapped in a `WEBSITE_CONTENT` fence and marked untrusted; the fence cannot be closed from page text.
- The preload exposes two fixed receive-only channels; it does not expose `ipcRenderer`.

## Limits
- Cloudflare / Turnstile / CAPTCHA are **not bypassed**. A cleaner user agent removes one common reason for blocks, but Cloudflare also uses TLS and behaviour signals, so a challenge can still appear. Complete it manually in the panel; the agent refuses to act on a challenge page.
- Elements inside cross-origin iframes are captured as the iframe element only.
- If you run the HTML in an ordinary browser with `agent-server.js` (not the EXE), the only real browser is Agent Chrome, which opens a separate Chrome by design. Use the desktop app for the embedded browser.

## Validation
- `node --check` on server, main, preload and the inline app script: passed.
- `node verify.cjs`: 109/109. `node verify-desktop.cjs`: 25/25.
- Behavioural tests against a stubbed Electron (popup policy, context menu, shortcuts, UA cleanup, element capture incl. password stripping and clamping) and renderer helpers (address-bar targets, search fallback, fence escaping): passed.
- **Not run here:** the real Windows Electron app, live websites, Cloudflare. Build and test on Windows.
