'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'src-js/10-model-adapters.js'), 'utf8');
const kotlin = fs.readFileSync(path.join(root, '..', 'app/src/main/java/com/codespace/android/MainActivity.kt'), 'utf8');

test('Android provider POST requests use native streaming transport while other platforms retain fetch', () => {
  assert.match(js, /async function nativeAndroidFetch\(url, init\)/);
  assert.match(js, /String\(init && init\.method \|\| 'GET'\)\.toUpperCase\(\) === 'POST'/);
  assert.ok(js.includes('nativeAndroidFetch(url, init || {})'));
  assert.match(js, /return await fetch\(url, init\)/);
});

test('native stream transport delivers response headers and incremental byte chunks', () => {
  assert.match(kotlin, /emitNativeHttp\(id, "headers"/);
  assert.match(kotlin, /emitNativeHttp\(id, "chunk"/);
  assert.match(kotlin, /Base64\.encodeToString\(bytes, Base64\.NO_WRAP\)/);
  assert.match(js, /new ReadableStream/);
  assert.match(js, /streamController\.enqueue\(bytes\)/);
});

test('native stream transport supports cancellation and restricts cleartext to loopback', () => {
  assert.match(kotlin, /cancelNativeHttp\(id: String\)/);
  assert.match(kotlin, /protocol == "https" \|\| \(protocol == "http"/);
  assert.match(kotlin, /target\.host\.equals\("localhost", true\)/);
  assert.match(js, /init\.signal\.addEventListener\('abort', abort/);
  assert.match(js, /bridge\.cancelNativeHttp\(id\)/);
});
