'use strict';
// End-to-end check of the Browser Bridge: real agent-server.js + real bridge-extension/background.js
// (with a stubbed chrome.* API and a mock web page). No Chrome or network access needed.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const { spawn } = require('child_process');
const root = __dirname, PORT = 18700 + Math.floor(Math.random() * 200), TOKEN = 'test-token-' + Math.random().toString(16).slice(2);
let passed = 0; const ok = n => { passed++; console.log('PASS', n); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bridge-'));
  const srv = spawn(process.execPath, [path.join(root, 'agent-server.js'), '--port', String(PORT), '--token', TOKEN], { env: { ...process.env, MY_AGENT_DATA_DIR: data }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + PORT;
  const call = async (p, body, token = TOKEN) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await call('/info')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    // --- server-side behaviour before any extension connects
    assert.equal((await call('/bridge/status', {}, 'wrong')).status, 401); ok('bridge endpoints require the bearer token');
    assert.equal((await call('/bridge/status')).json.connected, false);
    const early = await call('/bridge/call', { action: 'read' });
    assert.ok(early.status >= 400 && /not connected/i.test(JSON.stringify(early.json))); ok('calls fail clearly when the extension is not connected');

    // --- stubbed Chrome + mock page, running the real background.js
    const store = { local: { bridgeUrl: base, token: TOKEN, enabled: true }, session: {} };
    const area = o => ({ get: async d => { const out = { ...d }; for (const k of Object.keys(d)) if (k in o) out[k] = o[k]; return out; }, set: async v => { Object.assign(o, v); } });
    const tabsDb = new Map(); let nextTab = 100; const updatedListeners = new Set();
    const page = { url: 'about:blank', title: '', body: '', challenge: false };
    const events = [], inputs = { q: { value: '' } };
    class Ev { constructor(t, o) { this.type = t; Object.assign(this, o); } }
    class HTMLInputElement { get value() { return this._v || ''; } set value(v) { this._v = v; } }
    class HTMLTextAreaElement {}
    const q = Object.assign(new HTMLInputElement(), { tagName: 'INPUT', id: 'q', nodeType: 1, form: { requestSubmit() { events.push('submit'); } }, isContentEditable: false, parentElement: null,
      scrollIntoView() {}, focus() {}, getAttribute: k => ({ type: 'text', placeholder: 'Search' })[k] || null, getBoundingClientRect: () => ({ width: 100, height: 20, left: 0, top: 0 }), dispatchEvent: e => { events.push('q:' + e.type); return true; }, click() {} });
    const go = { tagName: 'BUTTON', id: 'go', nodeType: 1, innerText: 'Go', parentElement: null, scrollIntoView() {}, focus() {}, getAttribute: () => null, getBoundingClientRect: () => ({ width: 50, height: 20, left: 1, top: 1 }), dispatchEvent: e => { events.push('go:' + e.type); return true; }, click() { events.push('go:click'); } };
    const doc = { get title() { return page.title; }, documentElement: { scrollHeight: 2000, tagName: 'HTML', nodeType: 1 }, get body() { return { innerText: page.body }; },
      querySelector(sel) { if (sel === '#go') return go; if (sel === '#q') return q; if (sel === '###') throw new SyntaxError('bad selector'); if (/cf-turnstile/.test(sel)) return page.challenge ? {} : null; return null; },
      querySelectorAll(sel) { return /^#(go|q)$/.test(sel) ? [sel === '#go' ? go : q] : sel.startsWith('a[href]') ? [go, q] : []; }, elementFromPoint: () => go };
    // persistent page-side globals so the console hook survives between executeScript calls (like a real page)
    const pageHandlers = {}, netErrHandlers = [];
    const pageWin = { addEventListener: (t, f, cap) => { if (cap === true) netErrHandlers.push(f); else pageHandlers[t] = f; } };
    // page-side network mocks, so the extension's network hook has something real to wrap
    const pageNet = { fetchCalls: [], perfCb: null };
    pageWin.fetch = async function (input, init) { const u = typeof input === 'string' ? input : input.url; pageNet.fetchCalls.push(u); if (/fail/.test(u)) throw new TypeError('Failed to fetch'); return { status: /404/.test(u) ? 404 : 200, marker: 'page-response' }; };
    pageWin.XMLHttpRequest = class XHR { constructor() { this._l = {}; this.status = 0; } open(m, u) { this._o = [m, u]; } addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } send() { this.status = /xhrfail/.test(this._o[1]) ? 0 : 201; (this._l.loadend || []).forEach(f => f()); } };
    class FakePerfObserver { constructor(cb) { pageNet.perfCb = cb; } observe() {} }
    const nativeLog = []; const pageCon = {}; ['log', 'info', 'warn', 'error', 'debug'].forEach(k => { pageCon[k] = (...a) => nativeLog.push(k + ':' + a.join(' ')); });
    const ctxFor = () => ({ document: doc, window: pageWin, console: pageCon, CSS: undefined, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), location: { get href() { return page.url; } }, scrollY: 0, innerWidth: 1000, innerHeight: 700,
      scrollTo() { events.push('scrollTo'); }, scrollBy(o) { events.push('scrollBy:' + o.top); }, getSelection() {}, HTMLInputElement, HTMLTextAreaElement, MouseEvent: Ev, PointerEvent: Ev, KeyboardEvent: Ev, InputEvent: Ev, Event: Ev, URL, performance: { now: () => 100 }, PerformanceObserver: FakePerfObserver });
    const chrome = {
      storage: { local: area(store.local), session: area(store.session), onChanged: { addListener() {} } },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      alarms: { create() {}, onAlarm: { addListener() {} } },
      runtime: { id: 'x', onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      tabs: {
        onRemoved: { addListener() {} }, onUpdated: { addListener: f => updatedListeners.add(f), removeListener: f => updatedListeners.delete(f) },
        async create({ url }) { const t = { id: nextTab++, url, status: 'loading', windowId: 1, title: 'T' }; tabsDb.set(t.id, t); page.url = url; page.title = 'Example'; setTimeout(() => { t.status = 'complete'; updatedListeners.forEach(f => f(t.id, { status: 'loading' })); updatedListeners.forEach(f => f(t.id, { status: 'complete' })); }, 20); return t; },
        async update(id, props) { const t = tabsDb.get(id); if (!t) throw new Error('no tab'); Object.assign(t, props); if (props.url) page.url = props.url; return t; },
        async get(id) { const t = tabsDb.get(id); if (!t) throw new Error('No tab with id'); return t; }, async remove(id) { tabsDb.delete(id); }, async captureVisibleTab() { return 'data:image/jpeg;base64,AAAA'; }
      },
      scripting: { async executeScript({ target, func, args, world }) { assert.ok(tabsDb.has(target.tabId)); const r = await vm.runInNewContext('(' + func.toString() + ').apply(null, __args)', Object.assign(ctxFor(), { __args: args || [] })); return [{ result: r }]; } }
    };
    const bg = fs.readFileSync(path.join(root, 'bridge-extension/background.js'), 'utf8');
    const fetched = []; const rfetch = (u, o) => { fetched.push(String(u)); return fetch(u, o); };
    vm.runInNewContext(bg, { chrome, fetch: rfetch, AbortSignal, URL, setTimeout, clearTimeout, console, Promise, Object, JSON, String, Number, Array, Error }, { filename: 'background.js' });
    for (let i = 0; i < 40 && !(await call('/bridge/status')).json.connected; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await call('/bridge/status')).json.connected, true); ok('extension connects to the bridge and polls');

    const run = async (action, args) => (await call('/bridge/call', { action, args, timeoutMs: 8000 })).json;
    let r = await run('read', {}); assert.equal(r.ok, false); assert.match(r.error, /No tab is available/); ok('no tab is controllable until the agent opens one or the user shares one');
    r = await run('open', { url: 'javascript:alert(1)' }); assert.equal(r.ok, false); assert.match(r.error, /Only http/); ok('non-http(s) URLs are refused');
    page.body = 'Hello world'; r = await run('open', { url: 'https://example.com/' });
    assert.equal(r.ok, true); assert.equal(r.result.url, 'https://example.com/'); ok('open: creates and tracks an agent tab, waits for load');
    r = await run('read', {}); assert.equal(r.ok, true); assert.equal(r.result.text, 'Hello world'); assert.ok(r.result.elements.some(e => e.selector === '#go' && e.text === 'Go')); ok('read: returns text and interactive elements with selectors');
    r = await run('click', { selector: '#go' }); assert.equal(r.ok, true); assert.ok(events.includes('go:click') && events.includes('go:mousedown') && events.includes('go:mouseup')); ok('click: pointer/mouse sequence plus click');
    r = await run('click', { selector: '###' }); assert.equal(r.ok, false); assert.match(r.error, /Invalid selector/); ok('click: invalid selector reports a clear error');
    r = await run('type', { selector: '#q', text: 'hello', clear: true, submit: true }); assert.equal(r.ok, true); assert.equal(q.value, 'hello'); assert.ok(events.includes('submit') && events.includes('q:input')); ok('type: sets value with input events and submits');
    r = await run('type', { selector: '#q', text: ' more' }); assert.equal(q.value, 'hello more'); ok('type: appends when clear is false');
    r = await run('scroll', { pixels: 300 }); assert.equal(r.ok, true); assert.ok(events.includes('scrollBy:300')); ok('scroll');
    r = await run('eval', { code: '1+2' }); assert.equal(r.ok, true); assert.equal(r.result.result, '3'); ok('eval: expression result');
    r = await run('eval', { code: 'const a = 4; return a * 2' }); assert.equal(r.result.result, '8'); ok('eval: statements with return');
    r = await run('screenshot', {}); assert.equal(r.ok, true); assert.match(r.result.image, /^data:image\/jpeg/); ok('screenshot');
    r = await run('tabs', {}); assert.equal(r.result.tabs.length, 1); assert.equal(r.result.tabs[0].current, true); ok('tabs lists only controllable tabs');
    r = await run('tabs', { use: 999 }); assert.equal(r.ok, false); assert.match(r.error, /not shared/); ok('tabs: cannot switch to a tab that was never opened or shared');

    // ---- console capture (read side) and write side
    pageCon.log('page says hi', { a: 1 }); pageCon.warn('careful'); pageHandlers.error({ message: 'boom', filename: 'app.js', lineno: 7 }); pageHandlers.unhandledrejection({ reason: new Error('nope') });
    r = await run('console', {}); assert.equal(r.ok, true);
    const cl = r.result.console.join('\n');
    assert.match(cl, /page says hi \{"a":1\}/); assert.match(cl, /warn: careful/); assert.match(cl, /uncaught: boom \(app\.js:7\)/); assert.match(cl, /unhandled rejection: Error: nope/);
    ok('console: page logs, warnings, uncaught errors and rejections are captured');
    assert.ok(nativeLog.some(l => l === 'log:page says hi [object Object]'), 'original console still runs'); ok('console: the page still receives its own console calls');
    r = await run('console', {}); assert.deepEqual(r.result.console, []); ok('console: only new messages are returned the second time');
    pageCon.error('later'); r = await run('read', {}); assert.deepEqual(r.result.console, ['error: later']); ok('read: includes console messages that appeared since the last command');
    r = await run('console', { all: true }); assert.ok(r.result.console.length >= 5 && r.result.console.includes('warn: careful')); ok('console: all=true returns the whole buffer');
    r = await run('eval', { code: 'console.log("from agent"); console.error("agent err"); return 5' });
    assert.equal(r.ok, true); assert.equal(r.result.result, '5'); assert.deepEqual(r.result.console, ['from agent', 'error: agent err']); ok('eval: console output written by the agent code comes back with the result');
    r = await run('eval', { code: 'null.x' }); assert.equal(r.ok, false); assert.match(r.error, /Cannot read properties of null|null/); ok('eval: errors are reported');
    for (let i = 0; i < 350; i++) pageCon.log('spam ' + i);
    r = await run('console', {}); assert.equal(r.result.console[0], '(200 earlier message(s) omitted)'); assert.equal(r.result.console.length, 101); assert.equal(r.result.console[100], 'spam 349'); ok('console: ring buffer is capped and the reply is bounded');
    pageCon.error('after-click-error'); r = await run('click', { selector: '#go' }); assert.equal(r.ok, true); assert.deepEqual(r.result.console, ['error: after-click-error']); ok('click: console messages caused by the action come back with the page info');
    pageCon.log('after-scroll'); r = await run('scroll', { pixels: 5 }); assert.deepEqual(r.result.console, ['after-scroll']); ok('scroll: includes new console messages');
    r = await run('console', { all: true, clear: true }); r = await run('console', { all: true }); assert.deepEqual(r.result.console, []); ok('console: clear=true empties the buffer');

    // ---- network capture (read side): fetch / XHR wrappers, Resource Timing, failed element loads
    r = await run('network', {}); assert.equal(r.ok, true); assert.equal(r.result.hooked, true); assert.deepEqual(r.result.network, []); ok('network: hook installs on the agent tab with no extra permission');
    const pr = await pageWin.fetch('https://api.example.com/data?token=abc'); assert.equal(pr.marker, 'page-response'); ok('network: the page still receives its own fetch response');
    await pageWin.fetch('https://api.example.com/save', { method: 'post' });
    await assert.rejects(() => pageWin.fetch('https://api.example.com/fail'), /Failed to fetch/); ok('network: the page still receives its own fetch errors');
    await pageWin.fetch('https://api.example.com/missing404');
    const xhr = new pageWin.XMLHttpRequest(); xhr.open('PUT', '/api/xhr'); xhr.send();
    const xhr2 = new pageWin.XMLHttpRequest(); xhr2.open('GET', 'https://api.example.com/xhrfail'); xhr2.send();
    pageNet.perfCb({ getEntries: () => [{ initiatorType: 'img', name: 'https://cdn.example.com/a.png', responseStatus: 200, duration: 12.4, startTime: 500 }, { initiatorType: 'fetch', name: 'https://api.example.com/late', responseStatus: 200, duration: 3, startTime: 900 }, { initiatorType: 'script', name: 'https://cdn.example.com/app.js', responseStatus: 0, duration: 40, startTime: 20 }] });
    netErrHandlers.forEach(f => f({ target: { tagName: 'IMG', src: 'https://cdn.example.com/broken.png' } }));
    netErrHandlers.forEach(f => f({ target: { tagName: 'DIV' } }));
    r = await run('network', {}); assert.equal(r.ok, true);
    const nr = r.result.network, by = u => nr.find(x => x.u === u);
    assert.equal(by('https://api.example.com/data?token=abc').m, 'GET'); assert.equal(by('https://api.example.com/data?token=abc').st, 200); ok('network: fetch is captured with method, address and status');
    assert.equal(by('https://api.example.com/save').m, 'POST'); ok('network: the request method is captured and normalised');
    assert.equal(by('https://api.example.com/fail').st, null); assert.match(by('https://api.example.com/fail').er, /Failed to fetch/); ok('network: failed requests carry the error');
    assert.equal(by('https://api.example.com/missing404').st, 404); ok('network: HTTP error statuses are captured');
    assert.ok(nr.some(x => x.u === 'https://example.com/api/xhr' && x.k === 'xhr' && x.m === 'PUT' && x.st === 201)); ok('network: XMLHttpRequest is captured (relative URLs resolved)');
    assert.match(by('https://api.example.com/xhrfail').er, /failed/); ok('network: failed XHR is reported');
    assert.equal(by('https://cdn.example.com/a.png').k, 'img'); assert.equal(by('https://cdn.example.com/a.png').ms, 12); ok('network: images, scripts and styles come from Resource Timing');
    assert.ok(by('https://api.example.com/late') === undefined); ok('network: fetch entries already seen by the wrapper are not duplicated');
    assert.ok(nr.some(x => x.u === 'https://cdn.example.com/broken.png' && /failed to load/.test(x.er))); assert.ok(!nr.some(x => /DIV/.test(JSON.stringify(x)))); ok('network: failed image/script loads are reported, other elements ignored');
    assert.ok(!JSON.stringify(nr).includes('hunter2'));
    r = await run('network', {}); assert.deepEqual(r.result.network, []); ok('network: only new requests are returned the second time');
    r = await run('network', { all: true }); assert.ok(r.result.network.length >= 8); ok('network: all=true returns the whole buffer');
    r = await run('network', { all: true, filter: 'API.EXAMPLE.COM/sa' }); assert.deepEqual(r.result.network.map(x => x.u), ['https://api.example.com/save']); ok('network: filter keeps matching addresses (case-insensitive)');
    r = await run('network', { all: true, failed_only: true }); assert.ok(r.result.network.length >= 4 && r.result.network.every(x => x.er || x.st >= 400)); ok('network: failed_only keeps errors and HTTP 4xx/5xx');
    for (let i = 0; i < 350; i++) await pageWin.fetch('https://api.example.com/spam' + i);
    r = await run('network', {}); assert.equal(r.result.network.length, 100); assert.equal(r.result.omitted, 200); assert.equal(r.result.network[99].u, 'https://api.example.com/spam349'); ok('network: ring buffer is capped (300) and the reply is bounded (100)');
    r = await run('network', { all: true, clear: true }); r = await run('network', { all: true }); assert.deepEqual(r.result.network, []); ok('network: clear=true empties the buffer');
    await pageWin.fetch('https://api.example.com/after'); r = await run('network', {}); assert.equal(r.result.network.length, 1); ok('network: capture keeps working after a clear');

    page.challenge = true; page.body = 'Just a moment...';
    for (const a of [['click', { selector: '#go' }], ['type', { selector: '#q', text: 'x' }], ['scroll', { pixels: 10 }], ['eval', { code: '1' }]]) { r = await run(a[0], a[1]); assert.equal(r.ok, false, a[0]); assert.match(r.error, /bot-check|verification/i); }
    ok('click/type/scroll/eval refuse to act on a bot-check page');
    r = await run('read', {}); assert.equal(r.ok, true); assert.equal(r.result.challenge, true); ok('read still reports the challenge so the agent can ask the user');
    page.challenge = false; page.body = 'ok';

    r = await run('close', {}); assert.equal(r.ok, true); assert.equal(tabsDb.size, 0); r = await run('read', {}); assert.equal(r.ok, false); ok('close removes only agent-opened tabs');

    store.local.bridgeUrl = 'http://evil.example:8787';
    fetched.length = 0;
    r = await run('tabs', {}); assert.equal(r.ok, true);          // consumes the in-flight poll; the next loop iteration re-reads the config
    await new Promise(res => setTimeout(res, 600));
    assert.ok(!fetched.some(u => /evil\.example/.test(u)), 'token must never be sent to a non-loopback host: ' + fetched.join(', '));
    assert.ok(/loopbackBase/.test(bg)); ok('extension refuses to send the token to a non-loopback address (observed behaviour)');
    store.local.bridgeUrl = base;


    // ---- renderer: tool routing and execBrowserBridge against the live bridge
    /* 3.13.1: the app is split across the entry html + css/ + js/app.js — verify against all of it */
    try { require(path.join(root, 'tools/build-web.cjs')).ensure(); } catch {}
    const html = ['my-chat-agent-v3.html', ...fs.readdirSync(path.join(root, 'css')).sort().map(f => 'css/' + f), 'js/app.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
    const between = (a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, a); const j = html.indexOf(b, i + 1); assert.ok(j > i, b); return html.slice(i, j); };
    const disp = between("if (call.name.startsWith('browser_')) {", 'setAgentChromeMode();\n    switch (call.name)');
    assert.ok(disp.indexOf('bridgeIsUp(sig)') > 0 && disp.indexOf('bridgeIsUp(sig)') < disp.indexOf("if (DESKTOP_EMBED) {\n      browserRenderMode")); ok('web mode prefers the bridge, Desktop keeps the embedded browser');
    assert.match(html, /name: 'browser_tabs'/); assert.match(html, /'browser_read', 'browser_tabs'/); ok('browser_tabs tool is registered');
    const code = [between('function fmtPage(label, r)', 'function fmtTable'), between('async function bridgeIsUp', 'async function execBridge(call, sig)')].join('\n');
    const lines = []; const approvals = [];
    const rctx = { bcall: async (p, b) => { const x = await call(p, b); if (x.status >= 400) throw new Error(x.json.error || 'HTTP ' + x.status); return x.json; }, approve: async (t, pv) => { approvals.push(t + ' :: ' + pv); return true; },
      normalizeLiveUrl: u => { try { return new URL(u).href; } catch { return null; } }, permMeta: () => ({}), hostOf: u => { try { return new URL(u).host; } catch { return u; } }, DENIED: t => ({ text: t, st: 'err' }),
      P: () => ({ vision: true }), clip: x => x, BOT_NOTE: 'BOT ', lastUrl: '', $: () => ({ textContent: '' }), URL, JSON, String, Number, Promise, Object, Error };
    vm.createContext(rctx); vm.runInContext(code + ';this.run=execBrowserBridge;this.up=bridgeIsUp;', rctx);
    assert.equal(await rctx.up(), true);
    let t = await rctx.run({ name: 'browser_open' }, { url: 'https://example.com/a' }); assert.match(t, /^Opened in your Chrome: https:\/\/example\.com\/a/); ok('renderer: browser_open through the bridge');
    t = await rctx.run({ name: 'browser_read' }, {}); assert.match(t, /untrusted website data/); assert.match(t, /#go \| button \| Go/); ok('renderer: browser_read marks content untrusted and lists selectors');
    t = await rctx.run({ name: 'browser_click' }, { selector: '#go' }); assert.match(t, /^Clicked in your Chrome/); ok('renderer: browser_click');
    t = await rctx.run({ name: 'browser_type' }, { selector: '#q', text: 'secret-text-123', clear: true }); assert.match(t, /^Typed in your Chrome/); assert.ok(approvals.some(a => /Type in your Chrome/.test(a) && /secret-text-123/.test(a))); ok('renderer: browser_type asks approval and shows what will be typed');
    t = await rctx.run({ name: 'browser_run_js' }, { code: '6*7' }); assert.match(t, /Result:\n42/); ok('renderer: browser_run_js');
    pageCon.log('render-test-msg');
    t = await rctx.run({ name: 'browser_console' }, {}); assert.match(t, /untrusted website data/); assert.match(t, /Console of https:\/\/example\.com\/a:\n[\s\S]*render-test-msg/); ok('renderer: browser_console (bridge) returns messages, marked untrusted');
    t = await rctx.run({ name: 'browser_run_js' }, { code: 'console.warn("js-warn"); return 1' }); assert.match(t, /Result:\n1/); assert.match(t, /Console:\nwarn: js-warn/); ok('renderer: browser_run_js returns what the code logged');
    t = await rctx.run({ name: 'browser_screenshot' }, {}); assert.ok(t && t.image && /^data:image/.test(t.image)); ok('renderer: browser_screenshot returns an image for vision models');
    t = await rctx.run({ name: 'browser_tabs' }, {}); assert.match(t, /^\* id \d+ \| /); ok('renderer: browser_tabs');
    rctx.approve = async () => false; t = await rctx.run({ name: 'browser_click' }, { selector: '#go' }); assert.equal(t.st, 'err'); ok('renderer: a denied approval stops the action');
    await run('close', {});

    // ---- embedded browser (Desktop): console buffer functions from the real renderer, run against a stub
    const ectx = { sleep: async () => {}, Math, String, Number, Array, Object, URL, Map, Date, setTimeout: () => 0, $: () => ({ hidden: true }), DESKTOP_EMBED: true, browserRenderMode: 'embedded', bDiagMode: 'console', loadPreviewDiagnostics() {} };
    vm.createContext(ectx); vm.runInContext(between('const EMB_CON = ', 'function embeddedBack()') + ';this.push=embPushConsole;this.drain=embConsoleDrain;this.wrap=withEmbConsole;this.buf=EMB_CON;this.netEv=embNetEvents;this.netDrain=embNetDrain;this.net=EMB_NET;this.redact=redactUrl;this.netLine=netLine;this.netText=netText;this.netSelect=netSelect;', ectx);
    ectx.push(1, 'plain log'); ectx.push(2, 'a warning'); ectx.push(3, 'it broke', 'http://localhost:3000/app.js', 12); ectx.push(0, 'dbg'); ectx.push('warning', 'str-level');
    let el = await ectx.drain(); assert.deepEqual(Array.from(el), ['plain log', 'warn: a warning', 'error: it broke (/app.js:12)', 'debug: dbg', 'warn: str-level']); ok('embedded: console-message levels map to log/warn/error/debug');
    assert.deepEqual(Array.from(await ectx.drain()), []); ok('embedded: only new messages are returned on the next call');
    assert.equal(Array.from(await ectx.drain(true)).length, 5); ok('embedded: all=true returns the buffer');
    for (let i = 0; i < 400; i++) ectx.push(1, 'm' + i);
    el = Array.from(await ectx.drain()); assert.equal(el.length, 101); assert.match(el[0], /earlier message/); assert.equal(ectx.buf.buf.length, 300); ok('embedded: buffer capped at 300, reply at 100');
    await ectx.drain(true, true); assert.equal(ectx.buf.buf.length, 0); ok('embedded: clear=true empties the buffer');
    ectx.push(3, 'x'); const wr = await ectx.wrap({ url: 'u' }); assert.deepEqual(Array.from(wr.console), ['error: x']); ok('embedded: withEmbConsole attaches console to a page result');
    assert.match(html, /wv\.addEventListener\('console-message'/); assert.match(html, /case 'browser_console'/); assert.match(html, /name: 'browser_console'/); assert.match(html, /'browser_tabs', 'browser_console'/); ok('embedded: webview console listener and browser_console tool are wired up');
    const embRun = between("showPanel(true); let result, failure = '';", "case 'browser_console': {\n          showPanel(true);"); assert.match(embRun, /embConsoleDrain\(\)/); ok('embedded: browser_run_js returns console output');

    // ---- embedded browser network buffer + shared helpers (real renderer code)
    assert.equal(ectx.redact('https://x.test/a?token=SECRET1&q=hi&api_key=K2&page=2'), 'https://x.test/a?token=***&q=hi&api_key=***&page=2'); ok('network: secrets in query strings are masked');
    assert.equal(ectx.redact('https://user:pw@x.test/p'), 'https://x.test/p'); ok('network: credentials inside the URL are removed');
    assert.equal(ectx.redact('not a url?token=1'), 'not a url?token=1'); ok('network: unparseable addresses are passed through safely');
    ectx.netEv([{ k: 's', id: 1, m: 'GET', u: 'https://x.test/api/a?key=SECRET', ty: 'xhr', t: 1000 }, { k: 's', id: 2, m: 'POST', u: 'https://x.test/api/b', ty: 'xhr', t: 1005 }, { k: 's', id: 3, m: 'GET', u: 'https://x.test/img.png', ty: 'image', t: 1010 }]);
    ectx.netEv([{ k: 'e', id: 1, st: 200, c: false, t: 1050 }, { k: 'x', id: 2, er: 'net::ERR_CONNECTION_REFUSED', t: 1060 }]);
    let nd = await ectx.netDrain({}); assert.equal(nd.rows.length, 3);
    const netLines = Array.from(nd.rows.map(ectx.netLine));
    assert.equal(netLines[0], '[200] GET https://x.test/api/a?key=*** · xhr · 50 ms'); assert.match(netLines[1], /^\[failed\] POST https:\/\/x\.test\/api\/b · xhr · 55 ms — net::ERR_CONNECTION_REFUSED$/); assert.match(netLines[2], /^\[pending\] GET .*img\.png · image$/); ok('embedded network: requests, statuses, failures and pending requests are formatted');
    ectx.netEv([{ k: 'e', id: 3, st: 304, c: true, t: 1100 }]);
    nd = await ectx.netDrain({}); assert.equal(nd.rows.length, 1); assert.match(ectx.netLine(nd.rows[0]), /^\[304\] GET .*img\.png/); ok('embedded network: a request that finished after the last look is reported again with its result');
    nd = await ectx.netDrain({}); assert.equal(nd.rows.length, 0); ok('embedded network: nothing is repeated when nothing changed');
    nd = await ectx.netDrain({ all: true, failed_only: true }); assert.equal(nd.rows.length, 1); assert.equal(nd.rows[0].err, 'net::ERR_CONNECTION_REFUSED'); ok('embedded network: failed_only');
    nd = await ectx.netDrain({ all: true, filter: 'IMG.PNG' }); assert.equal(nd.rows.length, 1); ok('embedded network: filter');
    for (let i = 0; i < 700; i++) ectx.netEv([{ k: 's', id: 100 + i, m: 'GET', u: 'https://x.test/n' + i, ty: 'xhr', t: 2000 + i }]);
    assert.equal(ectx.net.rows.length, 500); assert.equal(ectx.net.byId.size, 500); nd = await ectx.netDrain({}); assert.equal(nd.rows.length, 100); assert.equal(nd.omitted, 400); ok('embedded network: buffer capped at 500, reply at 100');
    await ectx.netDrain({ all: true, clear: true }); assert.equal(ectx.net.rows.length, 0); assert.equal(ectx.net.byId.size, 0); ok('embedded network: clear=true empties the buffer');
    assert.match(ectx.netText('Network of u:', { rows: [], omitted: 0 }, '(no requests)'), /\(no requests\)$/); ok('embedded network: empty result is explicit');
    assert.match(html, /onNetwork\(embNetEvents\)/); assert.match(html, /name: 'browser_network'/); assert.match(html, /'browser_console', 'browser_network'/); ok('network: tool is registered, read-only (no approval) and wired for Desktop, bridge and Agent Chrome');
    assert.equal((html.match(/case 'browser_network': \{/g) || []).length, 3); ok('network: all three browser paths implement browser_network');
    const mainSrc = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8'), preSrc = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
    assert.match(mainSrc, /webRequest\.onBeforeRequest\(NET_FILTER[\s\S]*?callback\(\{\}\)/); assert.match(mainSrc, /onCompleted\(NET_FILTER/); assert.match(mainSrc, /onErrorOccurred\(NET_FILTER/); ok('Desktop: main process reports embedded-browser requests (start, completion, failure)');
    assert.doesNotMatch(mainSrc.slice(mainSrc.indexOf('const netPush'), mainSrc.indexOf("const SILENT")), /requestHeaders|responseHeaders|uploadData|cookie/i); ok('Desktop: only method, address, type, status and timing leave the main process (no headers, cookies, bodies)');
    assert.match(preSrc, /onNetwork: cb => subscribe\('codespace:net', cb\)/); assert.doesNotMatch(preSrc, /ipcRenderer\.send\s*\(/); assert.match(preSrc, /function subscribe\(channel, callback\)[\s\S]*?ipcRenderer\.on\(channel, handler\)[\s\S]*?ipcRenderer\.removeListener\(channel, handler\)/); ok('Desktop: network event subscription is receive-only (request/response invoke APIs are tested separately)');

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bridge-extension/manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, '1.2.0'); assert.ok(!manifest.permissions.some(p => /cookies|debugger|history|webRequest|nativeMessaging|downloads/.test(p))); ok('manifest requests no cookies/debugger/history/webRequest permissions');
    const audit = fs.existsSync(path.join(data, 'audit.jsonl')) ? fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8') : '';
    assert.ok(/bridge\/call/.test(audit) && !/hunter2/.test(audit)); ok('bridge calls are written to the audit log');
    console.log(`\nBrowser Bridge checks: ${passed}/${passed} passed`);
    process.exitCode = 0;
  } catch (e) { console.error('FAIL', e && e.stack || e); process.exitCode = 1; }
  finally { srv.kill('SIGKILL'); setTimeout(() => process.exit(process.exitCode), 50); }
})();
