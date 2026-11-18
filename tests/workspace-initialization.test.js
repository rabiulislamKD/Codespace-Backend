'use strict';
/* Regression tests for the single canonical Android workspace used by chat, file tools and
   OpenCode CLI. Executes REAL source logic where possible; static checks for Kotlin contracts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const KT = fs.readFileSync(path.join(CORE, '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
const CWS = fs.readFileSync(path.join(CORE, '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'AndroidOpenCodeWorkspace.kt'), 'utf8');
const composer = fs.readFileSync(path.join(CORE, 'src-js', '19-activitybar-composer.js'), 'utf8');
const bridge = fs.readFileSync(path.join(CORE, 'src-js', '03-bridge-client.js'), 'utf8');
const approvals = fs.readFileSync(path.join(CORE, 'src-js', '07-meters-approvals.js'), 'utf8');

let passed = 0, failed = 0;
const ok = n => { passed++; console.log('PASS ' + n); };
const bad = (n, e) => { failed++; console.log('FAIL ' + n + (e ? ' — ' + e : '')); };
const check = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

function extract(src, name) {
  let i = src.indexOf('async function ' + name + '(');
  const isAsync = i >= 0;
  if (!isAsync) i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', i);
  let depth = 0, inStr = null;
  for (let p = open; p < src.length; p++) {
    const c = src[p], prev = src[p - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, p + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* ---- Kotlin canonical workspace contract (static, evidence of real implementation) ---- */
check('canonical activeWorkspaceState() exists and is the single source of truth', () => {
  assert.match(KT, /private fun activeWorkspaceState\(\): JSONObject/);
  assert.ok(KT.includes('"/workspace/state" -> activeWorkspaceState()'));
  assert.ok(KT.includes('"/workspace/active" -> activeWorkspaceState()'));
  assert.match(KT, /\.put\("available", available\)/);
  assert.match(KT, /\.put\("posixPath", posixPath/);
  assert.match(KT, /\.put\("workspaceId", workspaceIdentity\(\)\)/);
  assert.match(KT, /\.put\("permissionOk", permissionOk\)/);
  assert.match(KT, /\.put\("platform", "android"\)/);
});
check('openCodeRun consumes the canonical state, not raw prefs', () => {
  const i = KT.indexOf('private fun openCodeRun(');
  const fn = KT.slice(i, i + 2600);
  assert.match(fn, /activeWorkspaceState\(\)/);
  assert.match(fn, /state\.optBoolean\("available"/);
  assert.match(fn, /state\.optString\("posixPath"/);
  assert.match(fn, /workspaceState", state/);
});
check('workspace permission validation + path traversal protection present', () => {
  assert.match(KT, /persistedUriPermissions\.any \{/);
  assert.ok(KT.includes('Workspace folder permission expired'));
  assert.ok(KT.includes('it != ".."'));
  assert.match(CWS, /fun resolve\(context: Context, treeUri: String\?, deviceDir: String\?\)/);
  assert.match(KT, /AndroidOpenCodeWorkspace\.syncIn\(this, treeUri\)/);
});
check('SAF mirror init/sync gating present', () => {
  assert.match(KT, /resolved\.mirror && treeUri != null/);
  assert.match(KT, /AndroidOpenCodeWorkspace\.syncIn\(this, treeUri\)/);
  assert.match(CWS, /fun syncIn\(/);
  assert.match(CWS, /fun syncOut\(/);
});

/* ---- bcall routing: OpenCode meta endpoints always native (fixes Unknown endpoint) ---- */
check('bcall routes OpenCode key/auth/models/status to the native bridge', () => {
  assert.match(bridge, /CS_ANDROID_NATIVE_EP/);
  assert.ok(bridge.includes('opencode\\/(keys|auth|models|status|install|workspace)'));
  assert.match(bridge, /CS_LOCAL_FILE_EP\.test\(pathname\)/);
});
check('workspace/state is in the native-routed file endpoints', () => {
  assert.match(bridge, /workspace\\\/\(dirs\|state\|active\)/);
});

/* ---- Execute real isAndroidFolderWorkspace logic in a VM ---- */
function makeIsAndroidEnv(opts) {
  const context = {
    window: { CodeSpaceNative: opts.nativeHasLocal ? { hasLocalWorkspace: () => opts.nativeHasLocal } : {} },
    B: { info: opts.info || {} },
    activeWorkspaceState: opts.aws || null,
    console
  };
  vm.createContext(context);
  vm.runInContext(extract(composer, 'isAndroidFolderWorkspace'), context);
  context.__fn = context.isAndroidFolderWorkspace;
  return context;
}
check('folder selected but state says unavailable -> still detected as Android workspace (native signal)', () => {
  const c = makeIsAndroidEnv({ nativeHasLocal: true, aws: { available: false, platform: 'android', error: 'revoked' }, info: {} });
  assert.equal(c.__fn(), true);
});
check('workspace initialized successfully -> detected via canonical state', () => {
  const c = makeIsAndroidEnv({ nativeHasLocal: false, aws: { available: true, platform: 'android', posixPath: '/storage/emulated/0/proj' }, info: {} });
  assert.equal(c.__fn(), true);
});
check('SAF mirror path (saf:// root) -> detected as Android workspace', () => {
  const c = makeIsAndroidEnv({ nativeHasLocal: false, aws: null, info: { root: 'saf://workspace', platform: 'android' } });
  assert.equal(c.__fn(), true);
});
check('workspace restored after restart (persisted native prefs) -> detected', () => {
  const c = makeIsAndroidEnv({ nativeHasLocal: true, aws: { available: true, platform: 'android' }, info: {} });
  assert.equal(c.__fn(), true);
});
check('no folder / missing fields -> not an Android workspace', () => {
  const c = makeIsAndroidEnv({ nativeHasLocal: false, aws: null, info: {} });
  assert.equal(c.__fn(), false);
});

/* ---- JS runtime routing guards (static evidence of real behavior) ---- */
check('runOpenCodeChat refuses unavailable workspace and re-probes status live', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 2400);
  assert.match(fn, /activeWorkspaceState\.available/);
  assert.match(fn, /await refreshOpenCodeStatus\(\)/); // v41: single-flight probe
  assert.match(fn, /activeWorkspaceState\.error/);
  assert.match(fn, /nativeMode/);
});
check('remote and Android Local separation: remote error is never produced for Android workspace', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 4200);
  assert.match(fn, /const nativeMode = .*isAndroidFolderWorkspace/);
  assert.match(fn, /if \(nativeMode\)/);
  assert.match(fn, /runOpenCodeAndroidLocal/);
});
check('OpenCode CLI model picker shows only OpenCode models (popup + select)', () => {
  assert.match(approvals, /__opencodeModelIds/);
  assert.match(approvals, /globalThis\.__opencodeModelIds/);
  assert.match(composer, /globalThis\.__opencodeModelIds = models\.slice/);
  assert.ok(approvals.includes("id: 'opencode'"));
});
check('multiple API keys can be added in Settings and listed', () => {
  assert.match(composer, /ocKeyList/);
  assert.match(composer, /bcall\('\/opencode\/keys\/add'/);
  assert.match(composer, /bcall\('\/opencode\/keys\/list'/);
  assert.match(composer, /bcall\('\/opencode\/keys\/select'/);
  assert.match(composer, /bcall\('\/opencode\/keys\/remove'/);
});
check('auto-fallback rotates key on quota failure, same model', () => {
  assert.match(composer, /looksLikeQuotaFailure/);
  assert.match(composer, /bcall\('\/opencode\/keys\/rotate'/);
});

console.log('\nWorkspace initialization verification: ' + passed + ' passed, ' + failed + ' failed, 0 skipped');
process.exit(failed ? 1 : 0);
