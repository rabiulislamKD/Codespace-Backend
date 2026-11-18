#!/usr/bin/env node
/* Regression checks for the Android NativeAgentBridge folder bridge.
   Static verification (no device required): confirms architecture contracts that the
   v28-v32 fixes were meant to guarantee. Run: node verify-android-folder-bridge.cjs */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const assert = require('assert/strict');
const ROOT = __dirname;
const KT = path.join(ROOT, '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt');
const kt = fs.readFileSync(KT, 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src-js', '03-bridge-client.js'), 'utf8');
const explorer = fs.readFileSync(path.join(ROOT, 'src-js', '16-explorer.js'), 'utf8');
const tools = fs.readFileSync(path.join(ROOT, 'src-js', '08-tools.js'), 'utf8');
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('PASS ' + n); };
const bad = (n, e) => { failed++; console.log('FAIL ' + n + (e ? ' — ' + e : '')); };
const test = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

// ---- NativeAgentBridge placement ----
test('NativeAgentBridge is registered as CodeSpaceNative', () => {
  assert.match(kt, /addJavascriptInterface\(NativeAgentBridge\(\), "CodeSpaceNative"\)/);
});
test('hasLocalWorkspace is declared exactly once and inside NativeAgentBridge', () => {
  assert.equal((kt.match(/fun hasLocalWorkspace\(/g) || []).length, 1);
  const bridge = kt.slice(kt.indexOf('inner class NativeAgentBridge'), kt.indexOf('// Non-PTY Android shell sessions') > 0 ? kt.length : kt.length);
  const clsStart = kt.indexOf('inner class NativeAgentBridge');
  const methodPos = kt.indexOf('fun hasLocalWorkspace(');
  assert.ok(methodPos > clsStart, 'method must appear after class start');
});
test('setPermissionMode is declared exactly once inside NativeAgentBridge', () => {
  assert.equal((kt.match(/fun setPermissionMode\(/g) || []).length, 1);
  const methodPos = kt.indexOf('fun setPermissionMode(');
  const clsStart = kt.indexOf('inner class NativeAgentBridge');
  assert.ok(methodPos > clsStart);
});
test('hasLocalWorkspace covers BOTH SAF and device-storage folders', () => {
  assert.match(kt, /hasLocalWorkspace\(\): Boolean = hasSafWorkspace\(\) \|\| usesDeviceStorageWorkspace\(\)/);
});
test('no duplicate @JavascriptInterface method names', () => {
  const names = (kt.match(/@JavascriptInterface fun (\w+)/g) || []).map(m => m.replace('@JavascriptInterface fun ', ''));
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dup, []);
});

// ---- File endpoints exist natively for both SAF and local ----
test('/fs/stat endpoint dispatches to SAF and local stat helpers', () => {
  assert.match(kt, /"\/fs\/stat" -> if \(hasSafWorkspace\(\)\) safFsStat\(.*\) else localFsStat\(/);
});
for (const ep of ['list', 'read', 'write', 'mkdir', 'delete', 'rename', 'search']) {
  test('/fs/' + ep + ' has SAF and local implementations', () => {
    assert.ok(kt.includes('safFs' + ep[0].toUpperCase() + ep.slice(1)));
    assert.ok(kt.includes('localFs' + ep[0].toUpperCase() + ep.slice(1)));
  });
}
test('/info exposes workspace identity (root, provider, workspaceId, fileProvider)', () => {
  const i = kt.slice(kt.indexOf('"/info" ->'), kt.indexOf('"/workspace/set"'));
  for (const f of ['root', 'provider', 'workspaceId', 'fileProvider', 'workspaceKind', 'safWorkspace']) {
    assert.ok(i.includes('"' + f + '"'), 'missing ' + f);
  }
});

// ---- SAF persistence + traversal safety ----
test('takePersistableUriPermission used for SAF folder selection', () => {
  assert.match(kt, /takePersistableUriPermission/);
});
test('workspace_tree_uri persisted and workspace_dir cleared on SAF pick', () => {
  assert.match(kt, /putString\("workspace_tree_uri", uri\.toString\(\)\)\.remove\("workspace_dir"\)/);
});
test('safeFile blocks directory traversal (canonical containment check)', () => {
  assert.match(kt, /f\.path == rootPath \|\| f\.path\.startsWith\(rootPath \+ File\.separator\)/);
});
test('safRelative rejects \'..\' and path escaping', () => {
  assert.match(kt, /it == "\.\."/);
});

// ---- WebView routing ----
test('bcall routes local file endpoints to native bridge', () => {
  assert.match(js, /L\.bridgeUrl === 'codespace-native:\/\/local'/);
  assert.match(js, /CS_LOCAL_FILE_EP\.test\(pathname\)/);
  assert.match(js, /window\.CodeSpaceNative\.hasLocalWorkspace/);
  assert.match(js, /csNativeCall\(pathname, body, signal\)/);
});
test('CS_LOCAL_FILE_EP includes /info and all /fs/* operations', () => {
  const m = js.match(/CS_LOCAL_FILE_EP = \/\^\\?\/(.*?)\$\//);
  assert.ok(m, 'regex not found');
  for (const ep of ['info', 'fs\\/(list|read|write', 'stat']) assert.ok(m[0].includes(ep), 'missing ' + ep);
});
test('folder-pick event refreshes /info and the explorer', () => {
  assert.match(explorer, /codespace-native-workspace-picked/);
  assert.match(explorer, /B\.info = await bcall\('\/info'\)/);
});
test('system prompt tells AI file ops are on Android and shell is remote', () => {
  assert.match(tools, /FILESYSTEM LOCATION/);
  assert.match(tools, /run_command \/ shell tools execute on the REMOTE sandbox server/);
});

// ---- OpenCode CLI vs Android folder (must redirect to OpenCode Zen) ----
const composer = fs.readFileSync(path.join(ROOT, 'src-js', '19-activitybar-composer.js'), 'utf8');
test('Android folder detection covers platform/fileProvider/safWorkspace/saf root', () => {
  assert.match(composer, /function isAndroidFolderWorkspace\(\)/);
  const fn = composer.slice(composer.indexOf('function isAndroidFolderWorkspace'), composer.indexOf('function redirectToOpenCodeZen'));
  for (const tok of ["i.platform === 'android'", "i.fileProvider === 'android-native-bridge'", 'i.safWorkspace === true', "saf:\\/\\/"]) {
    assert.ok(fn.includes(tok), 'missing ' + tok);
  }
});
test('OpenCode CLI toggle uses REAL local status and never silently redirects to Zen', () => {
  const i = composer.indexOf('async function toggleOpenCode');
  const section = composer.slice(i, composer.indexOf('async function setRoute', i));
  assert.match(section, /await bcall\('\/opencode\/status'\)/, 'must query real status');
  assert.match(section, /nativeMode/, 'must distinguish Android/remote workspace');
  assert.match(section, /if \(!status\.installed\)/, 'clear error when CLI unavailable');
  assert.doesNotMatch(section, /declineOpenCodeForAndroidFolder\(/, 'must NOT auto-redirect to Zen');
  assert.doesNotMatch(section, /redirectToOpenCodeZen\(/, 'must NOT auto-redirect to Zen');
  assert.match(composer, /function redirectToOpenCodeZen\(reason\)/, 'explicit Zen path still exists for user selection');
  assert.match(composer, /runOpenCodeAndroidLocal/, 'genuine local CLI execution path exists');
});
test('model and thinking-level selectors stay enabled in OpenCode CLI mode', () => {
  const i = composer.indexOf('function syncOpenCodeUI');
  const section = composer.slice(i, composer.indexOf('const syncMode', i));
  assert.match(section, /\$\('provQuick'\)\.disabled = false/, 'model selector must be enabled');
  assert.match(section, /ts\.disabled = false/, 'thinking-level selector must be enabled');
  assert.match(section, /Thinking effort passed to OpenCode CLI/);
});
test('OpenCode auto-fallback rotates to next API key on quota failure, keeping the same model', () => {
  assert.match(composer, /function looksLikeQuotaFailure\(r\)/, 'quota detection exists');
  assert.match(composer, /rate\.\?limit|quota|429|too many requests/i);
  const i = composer.indexOf('async function runOpenCodeAndroidLocal(text, sess)');
  const section = composer.slice(i, composer.indexOf('async function runOpenCodeChat', i));
  assert.match(section, /bcall\('\/opencode\/keys\/rotate'/, 'rotates key on quota failure');
  assert.match(section, /maxAttempts/, 'retry loop is bounded');
  assert.match(section, /same model|retrying with the same model/i);
});
test('OpenCode multi-key management endpoints are wired natively', () => {
  const kt = fs.readFileSync(path.join(ROOT, '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
  for (const ep of ['/opencode/keys/list', '/opencode/keys/add', '/opencode/keys/select', '/opencode/keys/remove', '/opencode/keys/rotate']) {
    assert.ok(kt.includes('"' + ep + '"'), 'missing native endpoint ' + ep);
  }
});
test('runOpenCodeChat refuses to run against an Android folder workspace', () => {
  const fn = composer.slice(composer.indexOf('async function runOpenCodeChat'));
  assert.match(fn, /isAndroidFolderWorkspace\(\)/);
  assert.match(fn, /S\.openCodeCLI = false/);
});

console.log('\nAndroid folder bridge verification: ' + passed + ' passed, ' + failed + ' failed, 0 skipped');
process.exit(failed ? 1 : 0);
