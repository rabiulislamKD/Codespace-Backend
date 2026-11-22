'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src-js', '03-bridge-client.js'), 'utf8');
/* Extract the REAL helper functions bcall() depends on. bcall() delegates Local-mode calls to
   csNativeCall(), so the test must run that real implementation (not a mock) to exercise the
   shipped logic. Slice from csNativeCall() through the end of bcall(), which also carries the
   CS_LOCAL_FILE_EP constant used for remote-mode routing. */
const fn = source.slice(source.indexOf('async function csNativeCall('), source.indexOf('\n/* ---- 3.10: background task bar'));
const coreSource = fs.readFileSync(path.join(__dirname, '..', 'src-js', '01-core-helpers-state.js'), 'utf8');
const nativeConfigFn = coreSource.slice(coreSource.indexOf('function nativeBridgeConfig()'), coreSource.indexOf('\nfunction loadAll()'));

function makeContext(reply, signal, localState) {
  const calls = [];
  const context = {
    L: localState || { bridgeUrl: 'codespace-native://local', bridgeToken: 'android-local-native' },
    window: { CodeSpaceNative: { localApiCall: (route, body) => { calls.push({ route, body }); return JSON.stringify(reply); } } },
    AbortSignal,
    setTimeout, clearTimeout,
    fetch: () => { throw new Error('Local mode must not call network fetch'); }
  };
  vm.createContext(context);
  vm.runInContext(fn + '\nthis.testBcall = bcall; this.testCsNativeCall = csNativeCall;', context);
  return { context, calls };
}

test('Android Local bridge sends supported API calls to the native adapter without network fetch', async () => {
  const { context, calls } = makeContext({ status: 200, data: { entries: ['main.kt'] } });
  const result = await context.testBcall('/fs/list', { path: 'src' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { entries: ['main.kt'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/fs/list');
  assert.deepEqual(JSON.parse(calls[0].body), { path: 'src' });
});

test('Android Local bridge reports unsupported native endpoints clearly', async () => {
  const { context } = makeContext({ status: 501, error: '/git/status is not implemented in the Android Local sandbox yet' });
  await assert.rejects(() => context.testBcall('/git/status', {}), /not implemented in the Android Local sandbox/);
});

test('Android Local bridge honours an already-aborted request signal', async () => {
  const { context, calls } = makeContext({ status: 200, data: {} });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => context.testBcall('/info', {}, controller.signal), /Request cancelled/);
  assert.equal(calls.length, 0);
});

function nativeConfigContext(api) {
  const context = { window: { CodeSpaceNative: api } };
  vm.createContext(context);
  vm.runInContext(nativeConfigFn + '\nthis.testNativeBridgeConfig = nativeBridgeConfig;', context);
  return context;
}

test('native bridge configuration is authoritative for the WebView', () => {
  const context = nativeConfigContext({
    bridgeConfig: () => JSON.stringify({
      bridgeUrl: 'https://example-8787.app.github.dev',
      bridgeToken: 'remote-token',
      sandboxMode: 'GitHub',
      remote: true,
      deviceCapabilities: { browser: true, terminal: true, localFiles: true }
    })
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.testNativeBridgeConfig())), {
    bridgeUrl: 'https://example-8787.app.github.dev',
    bridgeToken: 'remote-token',
    sandboxMode: 'GitHub',
    remote: true,
    deviceCapabilities: { browser: true, terminal: true, localFiles: true }
  });
});

test('remote sandbox config preserves device capabilities for local tool routing', async () => {
  const caps = { browser: true, terminal: true, localFiles: true };
  const { context, calls } = makeContext({ status: 200, data: { connected: true, mode: 'android-webview' } }, null, {
    bridgeUrl: 'https://example-8787.app.github.dev',
    bridgeToken: 'remote-token',
    deviceCapabilities: caps
  });
  const result = await context.testBcall('/bridge/status', {});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { connected: true, mode: 'android-webview' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/bridge/status');
});

test('remote sandbox routes browser calls to the device but keeps unrelated calls remote', async () => {
  const caps = { browser: true, terminal: true, localFiles: true };
  const local = makeContext({ status: 200, data: { ok: true, url: 'https://example.com' } }, null, {
    bridgeUrl: 'https://example-8787.app.github.dev', bridgeToken: 'remote-token', deviceCapabilities: caps
  });
  const got = await local.context.testBcall('/bridge/call', { action: 'screenshot', args: {} });
  assert.equal(got.ok, true);
  assert.equal(local.calls.length, 1);
  assert.equal(local.calls[0].route, '/bridge/call');

  const remoteCalls = [];
  const remote = {
    L: { bridgeUrl: 'https://example-8787.app.github.dev', bridgeToken: 't', deviceCapabilities: caps },
    window: { CodeSpaceNative: { localApiCall: () => { throw new Error('must not be called'); } } },
    AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, init) => { remoteCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, remote: true }) }; }
  };
  vm.createContext(remote);
  vm.runInContext(fn + '\nthis.testBcall = bcall;', remote);
  const out = await remote.testBcall('/sandbox/list', {});
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { ok: true, remote: true });
  assert.equal(remoteCalls.length, 1);
  assert.match(remoteCalls[0].url, /example-8787\.app\.github\.dev\/sandbox\/list/);
});

test('native bridge configuration is optional outside the Android shell', () => {
  const noApi = nativeConfigContext(null);
  assert.equal(noApi.testNativeBridgeConfig(), null);
  const badJson = nativeConfigContext({ bridgeConfig: () => 'not json' });
  assert.equal(badJson.testNativeBridgeConfig(), null);
});
