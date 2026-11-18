'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS', name); }
const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
function appSource() {
  try { require(path.join(root, 'tools/build-web.cjs')).ensure(); } catch {}
  const parts = ['my-chat-agent-v3.html', ...fs.readdirSync(path.join(root, 'css')).sort().map(f => 'css/' + f), 'js/app.js'];
  return parts.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
}
const html = appSource();
check('Electron main entry and isolated preload exist', () => { assert.ok(main.length); assert.ok(preload.length); });
check('portable build target and bundled runtime are configured', () => { const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')); assert.equal(pkg.build.productName,'CodeSpace'); assert.match(pkg.build.portable.artifactName,/CodeSpace-Portable/); assert.ok(JSON.stringify(pkg.build.extraResources).includes('runtime/node.exe')); });
check('Electron creates a native WebContentsView owned by the main process', () => { assert.ok(main.includes('new WebContentsView(')); assert.ok(main.includes('contentView.addChildView(browserView)')); });
check('browser session persists and is sandboxed', () => { assert.ok(main.includes('persist:codespace-browser')); assert.ok(main.includes('session.fromPartition(GUEST_PARTITION)')); assert.ok(main.includes('contextIsolation: true')); assert.ok(main.includes('sandbox: true')); assert.ok(main.includes('nodeIntegration: false')); });
check('Google authentication is not intercepted or redirected to system browser', () => { assert.ok(!main.includes('handoffGoogleSignIn')); assert.ok(!main.includes('isGoogleAuthUrl')); assert.ok(main.includes("guest.on('will-redirect'")); });
check('browser IPC exposes only validated browser operations', () => { for (const c of ['browser-ready','browser-bounds','browser-visible','browser-debug','browser-nav','browser-action','browser-eval','browser-capture','browser-input']) assert.ok(main.includes('codespace:'+c)); assert.ok(preload.includes('codespace:browser-event')); assert.ok(!preload.includes('ipcRenderer.send(')); });
check('website navigation accepts only http(s) and about:blank', () => { assert.ok(main.includes("u !== 'about:blank' && !isHttp(u)")); assert.ok(main.includes("target === 'about:blank' || isHttp(target)")); });
check('browser layout follows the preview editor bounds and active tab', () => { assert.ok(html.includes('syncNativeBrowserBounds')); assert.ok(html.includes('browser.setBounds')); assert.ok(html.includes('browser.setVisible(visible)')); });
check('browser is not implemented with iframe or webview on Desktop', () => { assert.ok(html.includes('id="bWebview"')); assert.ok(!/<webview\b/.test(html)); });
check('native folder picker wired end to end', () => { assert.ok(main.includes('codespace:pick-folder')); assert.ok(preload.includes('pickFolder')); assert.ok(html.includes('myAgentDesktop.pickFolder')); });
check('explicit open-in-system-browser action is still available', () => { assert.ok(main.includes('codespace:open-external')); assert.ok(preload.includes('openExternal')); });
check('backend starts with external browser process disabled', () => assert.ok(main.includes("MY_AGENT_DISABLE_EXTERNAL_BROWSER: '1'")));
check('agent browser tools use the Integrated Browser proxy', () => { for (const fn of ['embeddedReadPage','embeddedClickElement','embeddedTypeInto','embeddedScrollPage','embeddedRunPageJS']) assert.ok(html.includes(fn)); assert.ok(html.includes('executeJavaScript(expression') || html.includes('browser-eval')); });
check('website content remains marked untrusted for the agent', () => assert.ok(html.includes('WEBSITE_CONTENT>>>')));
// 3.13.18 regression guard: contextBridge passes every property to the renderer as a READ-ONLY
// snapshot (accessors are flattened). Assigning to any myAgentDesktop property throws a TypeError
// at bundle top level, which aborted the whole app at startup and left the splash page up forever.
check('renderer never assigns to contextBridge-exposed properties (splash-stuck bug)', () => {
  assert.ok(!/\bmyAgentDesktop\b[^;\n]*[^=\w]\.[A-Za-z_$][\w$]*\s*=[^=]/.test(html), 'found an assignment to a myAgentDesktop property');
  for (const fn of ['browser.setVisible(true)', 'setVisible(browserPanelVisible())']) assert.ok(html.includes(fn), 'missing bridge-safe call: ' + fn);
  assert.ok(!preload.includes('get hidden'), 'preload must not re-introduce the hidden accessor trap');
});
// 3.13.19 regression guards: the native WebContentsView floats above every DOM layer, so its
// visibility must account for the whole app state (panel, tab, rect and overlays), not just the
// render mode — otherwise the website keeps drawing over other panels (occlusion bug).
check('native browser visibility is panel- and overlay-aware (occlusion bug)', () => {
  assert.ok(html.includes('function browserPanelVisible()'), 'missing browserPanelVisible()');
  assert.ok(html.includes('function browserOverlayOpen()'), 'missing browserOverlayOpen()');
  assert.ok(html.includes("'dialog[open]'"), 'overlay check must cover open dialogs');
  assert.ok(html.includes("'#menuDrop:not([hidden])'"), 'overlay check must cover menu dropdowns');
  // 3.13.21: every floating element must hide the native view
  for (const sel of ['#provMenu', '#permMenu', '#ctxPop', '.ctxmenu']) assert.ok(html.includes("'" + sel + ":not([hidden])'"), 'overlay check must cover ' + sel);
  assert.ok(html.includes('function visibleBrowserRect('), 'native bounds must be clipped to scrolling ancestors and the window');
  assert.ok(html.includes("classList.contains('cs-dragging')"), 'splitter drags must hide the native view');
  assert.ok(html.includes('new MutationObserver(soon)'), 'overlay changes must be picked up immediately');
  assert.ok(html.includes('activeTab !== \'preview\' || $(\'bp\').hidden'), 'visibility must respect the active tab and panel');
  assert.ok(html.includes('setInterval(sync, 400)'), 'missing periodic bounds/overlay audit');
  assert.ok(html.includes('lastNativeSync'), 'bounds sync must skip redundant IPC via change detection');
});
check('chat.z.ai opens in the Integrated Browser with automatic session capture', () => {
  assert.ok(html.includes('function openChatZaiInBrowser()'), 'missing openChatZaiInBrowser()');
  assert.ok(html.includes("navigateEmbedded('https://chat.z.ai/'"), 'chat.z.ai must open via the Integrated Browser');
  assert.ok(html.includes('async function zaiHarvestTick()'), 'missing session harvester');
  assert.ok(html.includes("bcall('/chat-zai/token'"), 'harvester must push the token to the agent-server');
  assert.ok(html.includes("if (DESKTOP_EMBED) setInterval(zaiHarvestTick, 2500)"), 'harvester must run on a timer in desktop mode');
});
check('agent-server accepts and forwards the harvested chat.z.ai session token', () => {
  const server = fs.readFileSync(path.join(root, 'agent-server.js'), 'utf8');
  assert.ok(server.includes("case '/chat-zai/token'"), 'missing /chat-zai/token endpoint');
  assert.ok(server.includes('chatZaiSetToken(b.token)'), 'endpoint must validate through chatZaiSetToken');
  assert.ok(server.includes('CODESPACE_CHAT_ZAI_SESSION_TOKEN: chatZaiToken'), 'token must reach the bridge process env');
  assert.ok(server.includes("chatZaiChild.send({ type: 'session-token', token: tok })"), 'running bridge must receive fresh tokens via IPC');
  assert.ok(server.includes('sessionCaptured: !!chatZaiToken'), 'status must expose capture state without the value');
  assert.ok(!/console\.(log|error)\(.*chatZaiToken/.test(server), 'token must never be logged');
});
check('Chat Z.ai bridge runs headless with the harvested token (no external window on desktop)', () => {
  const server = fs.readFileSync(path.join(root, 'agent-server.js'), 'utf8');
  const proxy = fs.readFileSync(path.join(root, 'chat-zai-proxy.js'), 'utf8');
  assert.ok(proxy.includes('CODESPACE_CHAT_ZAI_SESSION_TOKEN'), 'proxy must read the harvested token');
  assert.ok(proxy.includes("localStorage.setItem('token', t)"), 'proxy must seed the token into its profile');
  assert.ok(proxy.includes("msg.type !== 'session-token'"), 'proxy must accept live session updates');
  assert.ok(server.includes("DESKTOP_HOST && !process.env.CODESPACE_CHAT_ZAI_HEADLESS"), 'desktop must default the bridge to headless');
});
// 3.13.20 regression guard: the bridge signs with the natively re-implemented live-site algorithm.
// Importing a pinned CDN chunk (prod-fe-1.0.252 / CAm9rDEa.js) silently produced HTTP 200 streams
// with a rejected signature, which the renderer reported only as "The model returned an empty
// reply." These checks keep the native signer, the dynamic frontend version, the full stream
// parser and the empty-stream diagnostics in place.
check('Chat Z.ai bridge signs natively (no pinned CDN signature chunk)', () => {
  const proxy = fs.readFileSync(path.join(root, 'chat-zai-proxy.js'), 'utf8');
  assert.ok(!proxy.includes('CAm9rDEa.js'), 'the stale pinned signature chunk must be gone');
  assert.ok(!proxy.includes('_app/immutable/chunks/'), 'no immutable chunk import may remain');
  assert.ok(!/__codespaceZaiSignRequest/.test(proxy), 'the old module-hook signer must be gone');
  assert.ok(proxy.includes("crypto.createHmac('sha256'"), 'signing must use node crypto HMAC-SHA256');
  assert.ok(proxy.includes('key-@@@@)))()((9))-xxxx&&&%%%%%'), 'the site signing secret template must be present');
  assert.ok(proxy.includes('5 * 60 * 1000'), 'the 5-minute signature window must be applied');
  assert.ok(proxy.includes('sortedPayloadFor'), 'sortedPayload must follow the site construction');
});
check('Chat Z.ai bridge discovers the frontend version instead of pinning one', () => {
  const proxy = fs.readFileSync(path.join(root, 'chat-zai-proxy.js'), 'utf8');
  assert.ok(proxy.includes('discoverFeVersion'), 'frontend version must be discovered at runtime');
  assert.ok(proxy.match(/prod-fe-\d+\.\d+\.\d+/), 'a last-known-good fallback version must be kept');
  assert.ok(proxy.includes("'X-FE-Version': feVersion"), 'requests must send the discovered version');
});
check('Chat Z.ai bridge parses full-snapshot streams and never ships silent empty replies', () => {
  const proxy = fs.readFileSync(path.join(root, 'chat-zai-proxy.js'), 'utf8');
  assert.ok(proxy.includes('createStreamConsumer'), 'the stream consumer must be factored out');
  assert.ok(proxy.includes('delta_content'), 'legacy delta events must be handled');
  assert.ok(proxy.includes('edit_content') && proxy.includes('edit_index'), 'edit events must be handled (site splice semantics)');
  assert.ok(proxy.includes('data.error') || proxy.includes('captureError'), 'in-stream error events must be captured');
  assert.ok(proxy.includes('returned no usable completion'), 'empty streams must surface a real diagnostic error');
  assert.ok(proxy.includes('signature_prompt'), 'the signed prompt must be echoed to the server');
  assert.ok(proxy.includes('refreshSession'), '401 must trigger a session refresh');
});
console.log(`\nDesktop packaging checks: ${passed}/${passed} passed`);
