# CodeSpace Bridge (Chrome extension)

Lets the CodeSpace AI agent use **your own Chrome** — your logins, your normal browser — to read pages, click and type.
Use this in web mode (running `agent-server.js` and opening the app in a browser). The desktop EXE already has its own embedded browser.

## Install (2 minutes)
1. Start the bridge with a fixed token so you only paste it once:
   `node agent-server.js --token my-long-secret-token`
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this `bridge-extension` folder.
3. Click the extension icon, paste the token, tick **Allow the agent to use Chrome**, press **Save**. The icon shows **ON** and the popup says *Connected*.
4. Ask the agent to open a site, read it, click or type. Log in yourself in the tab it opens (or press **Share this tab** on a tab you already use) and it continues from there.

## What the agent can do
`browser_open`, `browser_read` (text + clickable/typeable elements with selectors), `browser_click`, `browser_type` (optionally press Enter), `browser_scroll`, `browser_screenshot`, `browser_run_js`, `browser_console` (read the page console: logs, warnings, errors, unhandled rejections), `browser_tabs`.
CodeSpace asks you before it opens a site, clicks, types or runs JavaScript (your normal permission mode applies).

## Safety design
- Only tabs the agent opened, or tabs you press **Share this tab** on, can be controlled. Everything else in Chrome is untouchable.
- The extension has no cookies, history, downloads or debugger permission and never reads saved passwords; password field values are never returned.
- It only talks to `http://127.0.0.1` / `localhost` and sends the token nowhere else.
- It stops at Cloudflare/CAPTCHA/bot-check pages and asks you to complete them yourself.
- Page text is passed to the AI marked as untrusted website data.
- **Stop all** in the popup instantly removes every shared tab and turns the bridge off. Every command is also written to the CodeSpace audit log.

## Limits
- Clicks and typing use page events (not hardware input), which covers most sites but not every custom widget.
- Console messages are recorded from when the agent opens or you share a tab (very early page-load logs can be missed). Reading the console works on every controllable page.
- `browser_run_js` is blocked on sites whose Content-Security-Policy forbids `eval`.
- Screenshots need the agent's tab to be visible in a non-minimised window.
- Chrome-internal pages (`chrome://…`) and the Chrome Web Store cannot be controlled.
