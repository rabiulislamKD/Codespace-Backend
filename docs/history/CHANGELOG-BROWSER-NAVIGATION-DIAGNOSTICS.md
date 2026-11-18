# Browser navigation diagnostics

- Improved Agent Chrome navigation diagnostics when Chromium falls back to `chrome-error://chromewebdata/`.
- Captures recent failed network requests and displays their Chromium error text in the existing browser error area.
- Keeps the existing Chrome DevTools Protocol browser, profile, UI, and navigation flow; no second browser was added.
- Does not bypass Cloudflare, CAPTCHA, or regional restrictions.

Validation: `node --check agent-server.js`, `node --check desktop/main.cjs`, `node verify.cjs` (102 checks), and `node verify-desktop.cjs` (11 checks) passed. A live test against market-qx.info in the user's Windows browser was not possible in this environment.
