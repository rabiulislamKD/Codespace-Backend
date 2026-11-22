'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Android sources live next to this tree in the device build, and under android/ in the repo.
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const readAndroid = p => {
  for (const base of ['../app', 'android/app']) {
    const f = path.join(root, base, p);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return '';
};
const bridgeSrc = read('src-js/09-browser-bridge.js');
const serverSrc = read('agent-server.js');
const extSrc = read('bridge-extension/background.js');
const mainSrc = readAndroid('src/main/java/com/codespace/android/MainActivity.kt');
const cdpSrc = readAndroid('src/main/java/com/codespace/android/AndroidWebViewCdp.kt');
const manifestSrc = readAndroid('src/main/AndroidManifest.xml');
const toolsSrc = read('src-js/08-tools.js');
const clientSrc = read('src-js/03-bridge-client.js');
const stateSrc = read('src-js/01-core-helpers-state.js');
const watchSrc = read('src-js/18-sidebar-connections.js');
const editorSrc = read('src-js/15-editor.js');
const menuSrc = read('src-js/22-menubar.js');
const metersSrc = read('src-js/07-meters-approvals.js');

const bridgeRunSrc = bridgeSrc.slice(bridgeSrc.indexOf('async function bridgeRun('), bridgeSrc.indexOf('const BRIDGE_UNTRUSTED'));

function bridgeRunContext(replies, approvals = []) {
  const calls = [];
  const prompts = [];
  const context = {
    bcall: async (route, body) => {
      calls.push({ route, body });
      return replies[calls.length - 1] || replies[replies.length - 1];
    },
    approve: async () => { prompts.push(true); return approvals[prompts.length - 1] !== false; },
    permMeta: () => ({}),
    hostOf: () => 'example.com',
    lastUrl: 'https://example.com/'
  };
  vm.createContext(context);
  vm.runInContext(bridgeRunSrc + '\nthis.testBridgeRun = bridgeRun;', context);
  return { context, calls, prompts };
}

test('[1a] bridgeRun completes the server browser-permission handshake', async () => {
  const { context, calls, prompts } = bridgeRunContext([
    { needsApproval: true, permission: 'browser', preview: 'Browser bridge call: click', approvalToken: 'tok-1' },
    { ok: true, result: { ok: true, url: 'https://example.com/' } }
  ]);
  const out = await context.testBridgeRun('click', { selector: '#buy' }, undefined, 30000);
  assert.equal(out.ok, true);
  assert.equal(prompts.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.approvalToken, 'tok-1');
});

test('[1b] bridgeRun does not report success when the user denies the challenge', async () => {
  const { context, prompts } = bridgeRunContext([
    { needsApproval: true, permission: 'browser', preview: 'Browser bridge call: click', approvalToken: 'tok-1' }
  ], [false]);
  await assert.rejects(() => context.testBridgeRun('click', {}, undefined, 30000), /User denied the browser action/);
  assert.equal(prompts.length, 1);
});

test('[2a] server bridge accepts the browser navigation actions the tools dispatch', () => {
  const line = serverSrc.split('\n').find(x => x.startsWith('const BRIDGE_ACTIONS'));
  for (const action of ['back', 'forward', 'reload', 'open', 'read', 'screenshot']) {
    assert.match(line, new RegExp("'" + action + "'"), `missing ${action}`);
  }
});

test('[2b] Chrome extension implements back/forward/reload handlers', () => {
  for (const action of ['back', 'forward', 'reload']) {
    assert.match(extSrc, new RegExp('async ' + action + '\\('), `missing extension handler ${action}`);
  }
  assert.match(extSrc, /chrome\.tabs\.goBack\(/);
  assert.match(extSrc, /chrome\.tabs\.goForward\(/);
  assert.match(extSrc, /chrome\.tabs\.reload\(/);
});

test('[3] web_screenshot falls through to the native Android browser branch', () => {
  assert.match(bridgeSrc, /csDeviceBrowserActive\(\)\) \|\| ANDROID_NATIVE_BROWSER/);
  assert.match(bridgeSrc, /deviceBrowser && call\.name === 'web_screenshot'/);
  assert.match(bridgeSrc, /full-page capture is not available in the Android embedded browser/i);
});

test('[4] browser tools are advertised from device capability, not only remote /info', () => {
  assert.match(toolsSrc, /const browserCapable = !!\(\s*B\.info\.browser \|\|/);
  assert.match(toolsSrc, /group\('browser', browserCapable, BROWSER_TOOLS\)/);
});

test('[5] device-owned browser and terminal endpoints route to the native adapter in remote mode', () => {
  assert.match(clientSrc, /CS_DEVICE_BROWSER_EP = \/\^\\\/\(bridge\\\/\(status\|call\)/);
  assert.match(clientSrc, /csDeviceBrowserActive\(\) && CS_DEVICE_BROWSER_EP\.test\(pathname\)/);
  assert.match(clientSrc, /csDeviceCap\('terminal'\) && CS_DEVICE_TERMINAL_EP\.test\(pathname\)/);
  assert.match(stateSrc, /deviceCapabilities: \(cfg\.deviceCapabilities/);
  assert.match(mainSrc, /\.put\("deviceCapabilities", JSONObject\(\)/);
});

test('[6] a bridge that connects late refreshes capability info', () => {
  assert.match(watchSrc, /st\.connected && B\.ok && !\(typeof csDeviceBrowserActive/);
  assert.match(watchSrc, /bcall\('\/info', \{\}, undefined\)\.catch/);
});

test('[7] CDP avoids the app UI WebView and stays inside the UI-thread budget', t => {
  if (!cdpSrc) return t.skip('AndroidWebViewCdp.kt is not tracked in this repository checkout');
  assert.match(cdpSrc, /android_asset/);
  assert.match(cdpSrc, /exact\.firstOrNull\(\) \?: pageFallbacks\.firstOrNull\(\)/);
  assert.match(cdpSrc, /TimeUnit\.SECONDS\.toNanos\(3\)/);
  assert.match(cdpSrc, /minOf\(600L, remainingMs - 50L\)/);
  assert.match(mainSrc, /WebView DevTools did not expose the browser page/);
});

test('[8] Android native view occlusion covers touch menus, side drawer and visual viewport', () => {
  assert.match(editorSrc, /\.cs-touch-context:not\(\[hidden\]\)/);
  assert.match(editorSrc, /getComputedStyle\(side\)\.position === 'absolute'/);
  assert.match(editorSrc, /window\.visualViewport\.addEventListener\('resize', sync\)/);
});

test('[9] touch menus do not raise the soft keyboard and the app resizes for the IME', t => {
  if (!manifestSrc) return t.skip('AndroidManifest.xml is not tracked in this repository checkout');
  assert.match(manifestSrc, /android:windowSoftInputMode="adjustResize\|stateHidden"/);
  assert.match(menuSrc, /\(pointer: coarse\)/);
  assert.match(metersSrc, /Only desktop\/fine pointers get auto-focus/);
});
