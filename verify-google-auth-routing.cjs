'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'my-chat-agent-v3.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const checks = [
  ['Integrated browser uses Electron WebContentsView', /new WebContentsView\(/.test(main) && /contentView\.addChildView\(browserView\)/.test(main)],
  ['Browser uses a persistent isolated Chromium session', /session\.fromPartition\(GUEST_PARTITION\)/.test(main) && /persist:codespace-browser/.test(main) && /contextIsolation: true/.test(main) && /sandbox: true/.test(main)],
  ['Google authentication is not intercepted or sent to system browser', !/handoffGoogleSignIn|isGoogleAuthUrl|GOOGLE_AUTH_HOST/.test(main) && !/Google sign-in opened in your browser/.test(main)],
  ['Native browser supports ordinary HTTPS navigation and OAuth redirects', /browser-nav/.test(main) && /guest\.on\('will-redirect'/.test(main) && /isHttp\(details\.url\)/.test(main)],
  ['Renderer accesses browser only through reviewed preload IPC', /browser-eval/.test(preload) && /browser-nav/.test(preload) && /codespace:browser-event/.test(preload) && !/ipcRenderer\.send\(/.test(preload)],
  ['Browser page is a native surface, not a webview or iframe', /id="bWebview"/.test(html) && !/<webview\b/.test(html) && /new WebContentsView/.test(main)],
  ['Browser bounds and visibility are synchronized from the editor panel', /codespace:browser-bounds/.test(main) && /syncNativeBrowserBounds/.test(app) && /setVisible\(visible\)/.test(app)],
  ['No browser identity spoofing or CAPTCHA bypass is introduced', !/setUserAgent|CLEAN_UA|stripBrand|navigator\.webdriver\s*=/.test(main + preload + app)]
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} Integrated Browser checks passed.`);
if (failed) process.exit(1);
