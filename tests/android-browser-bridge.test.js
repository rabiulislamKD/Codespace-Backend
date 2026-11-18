'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { loadFragments } = require('./helpers/load.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'src-js', '09-browser-bridge.js'), 'utf8');

function makeBridgeContext() {
  const calls = [];
  const shown = [];
  const replies = {
    open: { ok: true, url: 'https://example.com/', title: 'Example' },
    back: { ok: true, url: 'https://example.com/previous', title: 'Previous' },
    forward: { ok: true, url: 'https://example.com/next', title: 'Next' },
    reload: { ok: true, url: 'https://example.com/', title: 'Example' },
    read: { ok: true, url: 'https://example.com/', title: 'Example', text: 'hello' },
    tabs: { tabs: [{ id: '0', title: 'Example', url: 'https://example.com/', current: true }] },
    hover: { ok: true, tag: 'DIV', text: 'menu' },
    wait: { found: true, selector: '', text: 'Welcome' },
    network: { ok: true, url: 'https://example.com/', network: [{ method: 'GET', url: 'https://example.com/api', status: 200 }] },
    console: { ok: true, url: 'https://example.com/', console: [{ level: 'error', message: 'boom' }] },
    screenshot: { ok: true, url: 'https://example.com/', title: 'Example', image: 'data:image/jpeg;base64,AA==' },
    click: { ok: true, url: 'https://example.com/', title: 'Example' },
    type: { ok: true, url: 'https://example.com/', title: 'Example' },
    scroll: { ok: true, url: 'https://example.com/' },
    eval: { ok: true, result: 42 }
  };
  const context = {
    L: { bridgeUrl: 'codespace-native://local', bridgeToken: 'android-local-native' },
    S: { humanize: true },
    B: {},
    P: () => ({ vision: false }),
    DESKTOP_EMBED: false,
    INTEGRATED_BROWSER: false,
    ANDROID_NATIVE_BROWSER: true,
    lastUrl: '',
    approve: async () => true,
    DENIED: value => 'DENIED: ' + value,
    permMeta: () => ({}),
    hostOf: () => 'example.com',
    normalizeLiveUrl: value => value,
    showPanel: value => { shown.push(value); },
    syncAndroidBrowserBounds: () => {},
    fmtPage: (label, result) => 'PAGE ' + label + ' ' + JSON.stringify(result),
    fmtRead: result => 'READ ' + result.url,
    clip: value => value,
    netSelect: () => ({ rows: [], omitted: 0 }),
    netText: label => 'NET ' + label,
    redactUrl: value => value,
    setTimeout: (fn) => { fn(); return 0; },
    bcall: async (route, body) => {
      if (route === '/bridge/status') return { connected: true };
      calls.push({ route, body });
      return { ok: true, result: replies[body.action] || { ok: true } };
    },
    bApproved: async () => ({})
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source + '\nthis.execBridge = execBridge;', context);
  return { context, calls, shown };
}

test('browser tools stay available to the model even with smart tool groups enabled', () => {
  const loaded = loadFragments(['01-core-helpers-state.js', '08-tools.js'], ['toolDefs', 'wantGroup', 'B', 'S']);
  loaded.S.smartTools = true;
  assert.equal(loaded.wantGroup('browser'), true);
  loaded.S.agentOn = true;
  loaded.S.smartTools = false;
  loaded.B.ok = true;
  loaded.B.info = { root: '/workspace', browser: true };
  loaded.B.skills = [];
  loaded.B.ext = [];
  loaded.B.conn = {};
  const names = loaded.toolDefs().map(tool => tool.name);
  for (const required of ['browser_open', 'browser_back', 'browser_forward', 'browser_reload', 'browser_read', 'browser_click', 'browser_type', 'browser_network', 'browser_console', 'browser_tabs', 'browser_hover', 'browser_wait', 'browser_devtools']) {
    assert.ok(names.includes(required), 'missing ' + required);
  }
});

test('Android Local browser_open uses the local branch, shows the panel and records the URL', async () => {
  const { context, calls, shown } = makeBridgeContext();
  const result = await context.execBridge({ name: 'browser_open', args: { url: 'https://example.com' } }, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.action, 'open');
  assert.deepEqual(shown, [true]);
  assert.match(result, /PAGE Opened/);
});

test('Android Local browser page actions reach the native bridge instead of the extension fallback', async () => {
  const { context, calls } = makeBridgeContext();
  const signal = new AbortController().signal;
  await context.execBridge({ name: 'browser_read', args: {} }, signal);
  await context.execBridge({ name: 'browser_back', args: {} }, signal);
  await context.execBridge({ name: 'browser_forward', args: {} }, signal);
  await context.execBridge({ name: 'browser_reload', args: {} }, signal);
  await context.execBridge({ name: 'browser_click', args: { selector: 'a' } }, signal);
  await context.execBridge({ name: 'browser_type', args: { selector: 'input', text: 'hello' } }, signal);
  await context.execBridge({ name: 'browser_scroll', args: { pixels: 300 } }, signal);
  await context.execBridge({ name: 'browser_network', args: { filter: 'api' } }, signal);
  await context.execBridge({ name: 'browser_console', args: {} }, signal);
  assert.deepEqual(calls.map(call => call.body.action), ['read', 'back', 'forward', 'reload', 'click', 'type', 'scroll', 'network', 'console']);
});

test('Android Local browser_tabs lists the native tabs and hover coordinates are forwarded', async () => {
  const { context, calls } = makeBridgeContext();
  const signal = new AbortController().signal;
  const tabs = await context.execBridge({ name: 'browser_tabs', args: {} }, signal);
  assert.match(tabs, /id 0/);
  await context.execBridge({ name: 'browser_hover', args: { x: 42, y: 24 } }, signal);
  const hover = calls.find(call => call.body.action === 'hover');
  assert.deepEqual(JSON.parse(JSON.stringify(hover.body.args)), { selector: '', x: 42, y: 24 });
});

test('Android Local browser_wait accepts visible text and browser results are marked untrusted', async () => {
  const { context, calls } = makeBridgeContext();
  const signal = new AbortController().signal;
  const waited = await context.execBridge({ name: 'browser_wait', args: { text: 'Welcome' } }, signal);
  assert.match(waited, /Appeared: Welcome/);
  assert.equal(calls.find(call => call.body.action === 'wait').body.args.text, 'Welcome');
  const read = await context.execBridge({ name: 'browser_read', args: {} }, signal);
  assert.match(read, /untrusted website data/i);
});

test('Android native bridge implements navigation, page-load waits and text/coordinate input', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
  assert.match(main, /require\(action in setOf\("open", "back", "forward", "reload"/);
  assert.match(main, /"back" -> return browserHistoryAction\("back"\)/);
  assert.match(main, /"forward" -> return browserHistoryAction\("forward"\)/);
  assert.match(main, /"reload" -> return browserHistoryAction\("reload"\)/);
  assert.match(main, /private fun waitForBrowserLoad/);
  assert.match(main, /browserWaitForNavigation\(generation/);
  assert.match(main, /val text=args\.optString\("text"/);
  assert.match(main, /val hx=args\.optInt\("x"/);
});
