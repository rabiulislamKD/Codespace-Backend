# CodeSpace 3.8.1 — Embedded Browser

- Desktop CodeSpace now defaults to an embedded Chromium browser inside the existing Browser panel.
- The address bar, Back, Forward, Reload, page title and navigation status operate on the embedded view.
- Browser data uses the persistent Electron partition `persist:codespace-browser`, keeping cookies and website sessions across app restarts.
- The old Agent Chrome/CDP mode remains available as an explicit fallback; it can still launch a separate Chrome/Edge process.
- The web/PWA version retains its existing browser modes because Electron's embedded webview is only available in the desktop app.
- No Cloudflare, CAPTCHA, bot-check or regional restriction bypass is added. A site may still challenge or refuse Electron's Chromium; complete any allowed verification normally, or use the external Chrome fallback if the site requires Google Chrome specifically.

## Validation

Source checks: `node --check` for Electron main/preload and backend; `node verify.cjs`; `node verify-desktop.cjs`.
A live Cloudflare/site test and Windows EXE build were not run in this environment.
