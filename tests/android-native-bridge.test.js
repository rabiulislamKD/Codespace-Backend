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

function makeContext(reply, signal) {
  const calls = [];
  const context = {
    L: { bridgeUrl: 'codespace-native://local', bridgeToken: 'android-local-native' },
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
      remote: true
    })
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.testNativeBridgeConfig())), {
    bridgeUrl: 'https://example-8787.app.github.dev',
    bridgeToken: 'remote-token'
  });
});

test('native bridge configuration is optional outside the Android shell', () => {
  const noApi = nativeConfigContext(null);
  assert.equal(noApi.testNativeBridgeConfig(), null);
  const badJson = nativeConfigContext({ bridgeConfig: () => 'not json' });
  assert.equal(badJson.testNativeBridgeConfig(), null);
});
