'use strict';
/* Termux RUN_COMMAND integration regression tests.
   Verifies manifest declarations (source), Kotlin detection/permission/intent/result handling,
   the merged manifest after build, and the JS status/permission UI wiring. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPROOT = path.join(ROOT, '..');
const SRC_MANIFEST = fs.readFileSync(path.join(APPROOT, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const RT = fs.readFileSync(path.join(APPROOT, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'AndroidOpenCodeRuntime.kt'), 'utf8');
const MA = fs.readFileSync(path.join(APPROOT, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
const composer = fs.readFileSync(path.join(ROOT, 'src-js', '19-activitybar-composer.js'), 'utf8');

let pass = 0, fail = 0;
const ok = n => { pass++; console.log('PASS ' + n); };
const bad = (n, e) => { fail++; console.log('FAIL ' + n + (e ? ' — ' + e : '')); };
const check = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

/* ---------- 1+2. Source manifest declarations ---------- */
check('source manifest declares com.termux.permission.RUN_COMMAND', () => {
  assert.ok(SRC_MANIFEST.includes('com.termux.permission.RUN_COMMAND'));
});
check('source manifest declares <queries><package android:name="com.termux" /></queries>', () => {
  assert.ok(/<queries>[\s\S]*?com\.termux[\s\S]*?<\/queries>/.test(SRC_MANIFEST));
});

/* ---------- 3. Merged manifest (built artifact) ---------- */
const MERGED = path.join(APPROOT, 'app', 'build', 'intermediates', 'merged_manifest', 'debug', 'processDebugMainManifest', 'AndroidManifest.xml');
check('merged manifest contains the Termux permission', () => {
  assert.ok(fs.existsSync(MERGED), 'merged manifest not found — build first');
  const m = fs.readFileSync(MERGED, 'utf8');
  assert.ok(m.includes('com.termux.permission.RUN_COMMAND'));
});
check('merged manifest contains package visibility for com.termux', () => {
  const m = fs.readFileSync(MERGED, 'utf8');
  assert.ok(/<queries>[\s\S]*?com\.termux[\s\S]*?<\/queries>/.test(m));
});

/* ---------- 5. PackageManager-based detection ---------- */
check('detection uses PackageManager.getApplicationInfo with a queries-aware fallback', () => {
  assert.match(RT, /termuxInstalled\(context: Context\)/);
  assert.match(RT, /packageManager\.getApplicationInfo\(TERMUX_PACKAGE/);
  assert.match(RT, /queryIntentServices|queryIntentActivities/);
});
check('"not installed" is a distinct state, not conflated with permission', () => {
  assert.match(RT, /TermuxState\.NOT_INSTALLED/);
  assert.match(RT, /if \(!termuxInstalled\(context\)\)[\s\S]*?NOT_INSTALLED/);
});

/* ---------- 6. Permission request + check ---------- */
check('permission is checked separately via checkSelfPermission', () => {
  assert.match(RT, /termuxPermissionGranted\(context: Context\)/);
  assert.match(RT, /checkSelfPermission\(TERMUX_PERMISSION\)/);
});
check('permission is requested from the Activity with a request code', () => {
  assert.match(RT, /requestTermuxPermission\(activity: Activity\)/);
  assert.match(RT, /requestPermissions\(arrayOf\(TERMUX_PERMISSION\)/);
  assert.match(RT, /REQ_TERMUX_PERMISSION/);
});
check('permission-not-granted is a distinct state with actionable message', () => {
  assert.match(RT, /TermuxState\.PERMISSION_NOT_GRANTED/);
  assert.match(RT, /permission is not granted/);
});
check('MainActivity exposes a permission-request endpoint and handles the result', () => {
  assert.ok(MA.includes('"/opencode/termux/permission"'));
  assert.match(MA, /onRequestPermissionsResult/);
  assert.match(MA, /REQ_TERMUX_PERMISSION/);
});

/* ---------- 7. Explicit Intent with required component/path/args/workdir ---------- */
check('explicit Intent targets com.termux/com.termux.app.RunCommandService', () => {
  assert.ok(RT.includes('com.termux.app.RunCommandService'));
  assert.match(RT, /component = ComponentName\(TERMUX_PACKAGE, TERMUX_SERVICE_CLASS\)/);
  assert.match(RT, /ACTION_RUN_COMMAND = "com\.termux\.RUN_COMMAND"/);
});
check('version probe uses opencode binary path, --version args, Termux home workdir', () => {
  assert.ok(RT.includes('/data/data/com.termux/files/usr/bin/opencode'));
  assert.ok(RT.includes('/data/data/com.termux/files/home'));
  // v39: probe now runs through a Termux login shell to initialize PATH/runtime env; the
  // explicit binary path is still used inside the shell script.
  assert.match(RT, /val shell = "'\$TERMUX_OPCODE_PATH' --version 2>&1"/);
  assert.match(RT, /runTermuxCommand\(context, TERMUX_BASH_PATH, arrayOf\("-lc", shell\), TERMUX_HOME\)/);
});
check('RUN_COMMAND extras use the official API keys', () => {
  for (const k of ['com.termux.RUN_COMMAND_PATH', 'com.termux.RUN_COMMAND_ARGUMENTS',
                   'com.termux.RUN_COMMAND_WORKDIR', 'com.termux.RUN_COMMAND_BACKGROUND',
                   'com.termux.RUN_COMMAND_PENDING_INTENT']) {
    assert.ok(RT.includes(k), 'missing extra ' + k);
  }
});
check('service is started via startService/startForegroundService (not broadcast)', () => {
  assert.match(RT, /startRunCommandService/);
  assert.match(RT, /context\.startService\(intent\)/);
  assert.match(RT, /startForegroundService\(intent\)/);
  assert.doesNotMatch(RT, /context\.sendBroadcast\(intent\)/);
});

/* ---------- 8+9. Distinct states + supported result handling ---------- */
check('all distinct detection/execution states are defined', () => {
  for (const s of ['OK', 'NOT_INSTALLED', 'PERMISSION_NOT_GRANTED', 'SERVICE_UNAVAILABLE',
                   'EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE', 'COMMAND_ERROR', 'NOT_SUPPORTED']) {
    assert.ok(RT.includes(s), 'missing state ' + s);
  }
});
check('service-unavailable state is handled separately', () => {
  assert.match(RT, /startRunCommandService\(context, intent\)\)/);
  assert.match(RT, /TermuxState\.SERVICE_UNAVAILABLE/);
});
check('no-response and command-error states are handled separately', () => {
  assert.match(RT, /TermuxState\.EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE/);
  assert.match(RT, /TermuxState\.COMMAND_ERROR/);
  assert.match(RT, /RESULT_EXIT_CODE|com\.termux\.RUN_COMMAND_RESULT_EXIT_CODE/);
});
check('result uses PendingIntent with nonce + official result-bundle extras', () => {
  assert.match(RT, /PendingIntent\.getBroadcast/);
  // v39: MUTABLE is required so Termux can fill in the result intent.
  assert.match(RT, /FLAG_MUTABLE/);
  assert.match(RT, /RESULT_NONCE|cs_nonce/);
  assert.ok(RT.includes('RESULT_BUNDLE = "result"'));
  assert.match(RT, /getBundleExtra\(RESULT_BUNDLE\)/);
  assert.match(RT, /if \(n != nonce\) return/);
});
check('status reports detection and permission separately (never conflated)', () => {
  assert.match(RT, /\.put\("termuxInstalled", installed\)/);
  assert.match(RT, /\.put\("termuxPermissionGranted", granted\)/);
  assert.match(RT, /\.put\("termuxState", probe\.state\.name\)/);
});

/* ---------- 10. JS UI wiring ---------- */
check('settings shows distinct Termux states and requests permission', () => {
  assert.match(composer, /termuxPermissionGranted/);
  assert.match(composer, /termuxState/);
  assert.match(composer, /bcall\('\/opencode\/termux\/permission'/);
  assert.match(composer, /codespace-termux-permission/);
});
check('no silent remote/Zen fallback for Android workspace OpenCode', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 2600);
  assert.match(fn, /nativeMode/);
  assert.match(fn, /activeWorkspaceState\.available/);
  assert.match(fn, /isAndroidFolderWorkspace/);
});

console.log('\nTermux integration verification: ' + pass + ' passed, ' + fail + ' failed, 0 skipped');
process.exit(fail ? 1 : 0);
