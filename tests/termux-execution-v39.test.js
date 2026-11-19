'use strict';
/* v39 regression tests: Termux RUN_COMMAND result parsing / env / correlation and chat CLI selection. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '..');
const RT = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'AndroidOpenCodeRuntime.kt'), 'utf8');
const MA = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
const WS = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'AndroidOpenCodeWorkspace.kt'), 'utf8');
const composer = fs.readFileSync(path.join(ROOT, 'src-js', '19-activitybar-composer.js'), 'utf8');
const state = fs.readFileSync(path.join(ROOT, 'src-js', '01-core-helpers-state.js'), 'utf8');

let pass = 0, fail = 0;
const ok = n => { pass++; console.log('PASS ' + n); };
const bad = (n, e) => { fail++; console.log('FAIL ' + n + (e ? ' — ' + e : '')); };
const check = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

/* ---------- Issue A: result parsing and execution ---------- */
check('reads official Termux result Bundle "result" with exitCode/stdout/stderr', () => {
  assert.ok(RT.includes('RESULT_BUNDLE = "result"'));
  assert.match(RT, /getBundleExtra\(RESULT_BUNDLE\)/);
  assert.match(RT, /bundle\?\.getInt\(RESULT_EXIT_CODE/);
  assert.match(RT, /bundle\?\.getString\(RESULT_STDOUT/);
  assert.match(RT, /bundle\?\.getString\(RESULT_STDERR/);
});
check('supports err/errmsg diagnostic fallbacks', () => {
  assert.ok(RT.includes('RESULT_ERRMSG = "errmsg"'));
  assert.match(RT, /getString\(RESULT_ERRMSG\)/);
});
check('result PendingIntent is MUTABLE so Termux can fill in results', () => {
  assert.match(RT, /PendingIntent\.FLAG_MUTABLE/);
  assert.doesNotMatch(RT, /RESULT_NONCE[\s\S]{0,200}FLAG_IMMUTABLE/);
});
check('EXTRA_SESSION_ACTION is passed as a String', () => {
  assert.match(RT, /putExtra\(EXTRA_SESSION_ACTION, "0"\)/);
});
check('per-request nonce correlation with dedicated callback/latch', () => {
  assert.match(RT, /pendingResults\.ConcurrentHashMap|ConcurrentHashMap<String, CommandResult>|private val pendingResults/);
  assert.match(RT, /CountDownLatch\(1\)/);
  assert.match(RT, /latch\.await\(timeoutMs/);
  assert.match(RT, /if \(n != nonce\) return/);
  assert.match(RT, /pendingResults\.remove\(nonce\)/);
});
check('probe initializes environment via Termux login shell with explicit binary path', () => {
  assert.match(RT, /val shell = "'\$TERMUX_OPCODE_PATH' --version 2>&1"/);
  assert.match(RT, /runTermuxCommand\(context, TERMUX_BASH_PATH, arrayOf\("-lc", shell\), TERMUX_HOME\)/);
});
check('distinct MISSING_RESULT and COMMAND_ERROR states exist', () => {
  assert.match(RT, /MISSING_RESULT/);
  assert.match(RT, /TermuxState\.COMMAND_ERROR/);
  assert.match(RT, /exit == -999/);
});
check('never reports success when exit code is non-zero or result missing', () => {
  assert.match(RT, /exit == 0 -> TermuxState\.OK/);
  assert.match(RT, /if \(version\.isBlank\(\)\)/);
  assert.match(RT, /Probe\(Kind\.TERMUX, false,/);
});
check('service start failure and timeout are distinct from command error', () => {
  assert.match(RT, /TermuxState\.SERVICE_UNAVAILABLE/);
  assert.match(RT, /TermuxState\.EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE/);
  assert.match(RT, /if \(!startRunCommandService\(context, intent\)\)/);
});
check('config + mirror live in Termux-readable shared staging dir', () => {
  assert.match(MA, /File\(AndroidOpenCodeRuntime\.stagingDir\(this\), "opencode-config\.json"\)/);
  assert.match(WS, /File\(AndroidOpenCodeRuntime\.stagingDir\(context\), "workspace"\)/);
  // v47: --standalone is inserted before --format json (private server, no managed service).
  assert.match(MA, /TERMUX_OPCODE_PATH\}' run --standalone --format json/);
  // v43.1: the installed OpenCode v2 CLI has no directory flag; the workspace is the cwd.
  const cmdLine = (MA.match(/val command = "[^"]*"/) || [''])[0];
  assert.ok(cmdLine, 'openCodeRun must build the Termux command');
  assert.doesNotMatch(cmdLine, /--dir/);
  assert.match(cmdLine, /OPENCODE_CONFIG=\$\{shQuote\(cfgFile\.absolutePath\)\}/);
  // v44: the command no longer embeds the `cd`. The runtime launches the shell in Termux home
  // (a directory Termux always validates) and enters the workspace with an explicit `cd`, whose
  // failure produces a distinct exit code instead of leaving the task stuck at STARTING.
  assert.doesNotMatch(cmdLine, /cd \$\{shQuote\(workDir\)\}/);
  assert.match(RT, /val processDir = TERMUX_HOME/);
  assert.match(RT, /append\("\( cd "\)\.append\(shQuote\(workDir\)\)/);
  assert.match(RT, /CODESPACE_WORKSPACE_UNREACHABLE/);
});

/* ---------- Issue B: chat CLI selection ---------- */
check('OpenCode CLI route option still exists in UI (no redesign)', () => {
  assert.match(composer, /currentRoute/);
  assert.match(composer, /ROUTE_LABEL/);
  assert.match(composer, /data-route/);
});
check('selection is populated from real runtime detection (status), not hardcoded true', () => {
  assert.match(composer, /(?:let|const) (?:status|s) = await bcall\('\/opencode\/status'/);
  assert.match(composer, /status\.installed/);
  assert.match(composer, /termuxState/);
});
check('selecting OpenCode CLI sets the execution mode (S.openCodeCLI)', () => {
  assert.match(composer, /S\.openCodeCLI = true/);
  assert.match(composer, /if \(!S\.openCodeCLI\) await toggleOpenCode\(\)/);
});
check('selection persists across reloads (no forced reset on native local)', () => {
  assert.doesNotMatch(state, /bridgeUrl === 'codespace-native:\/\/local' && S\.openCodeCLI/);
});
check('chat composer dispatches to local OpenCode runtime when selected', () => {
  assert.match(composer, /if \(S\.openCodeCLI\) await runOpenCodeChat/);
  assert.match(composer, /runOpenCodeAndroidLocal/);
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 2600);
  assert.match(fn, /nativeMode/);
});
check('no silent fallback to Zen / remote provider for Android workspace', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 2600);
  assert.match(fn, /isAndroidFolderWorkspace/);
  assert.match(fn, /activeWorkspaceState\.available/);
  assert.match(composer, /NOT silently switched/);
});
check('model/CLI selection logically distinct (models from OpenCode, runtime=CLI)', () => {
  assert.match(composer, /globalThis\.__opencodeModelIds = models\.slice/);
  assert.match(composer, /currentOpenCodeModel/);
  // Config (incl. OPENCODE_CONFIG) is written natively, never hardcoded in JS.
  assert.match(MA, /OPENCODE_CONFIG/);
});
check('ocRefresh syncs route UI so selection reflects current detection', () => {
  assert.match(composer, /if \(typeof syncOpenCodeUI === 'function'\) syncOpenCodeUI\(\)/);
});

console.log('\nTermux execution v39 verification: ' + pass + ' passed, ' + fail + ' failed, 0 skipped');
process.exit(fail ? 1 : 0);
