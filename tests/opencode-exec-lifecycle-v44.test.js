'use strict';
/* v44 regression tests — Android-local OpenCode CLI EXECUTION LIFECYCLE.
 *
 * Root cause fixed here (confirmed from Termux's RunCommandService source): Termux validates the
 * RUN_COMMAND working directory with validateDirectoryFileExistenceAndPermissions() and calls
 * `return stopService()` — running NOTHING — when that directory is missing or not writable. v43
 * passed the shared-storage workspace as EXTRA_WORKDIR and had no launch confirmation, so the task
 * stayed at "Starting OpenCode CLI" forever. v44 launches the shell in Termux home (always
 * writable), `cd`s into the workspace inside the script, writes a start marker, and ALWAYS writes
 * the exit file; the native runtime adds a launch watchdog, a configurable timeout, real process
 * cancellation, and [OPENCODE_EXEC_V44] diagnostics.
 *
 * These tests EXECUTE the real command builder (extracted from MainActivity.kt) through the real
 * Termux wrapper shape, assert the native lifecycle implementation, and drive the REAL src-js chat
 * runner for the frontend lifecycle. The 12 required scenarios are marked [1]..[12].
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildComposer } = require('./helpers/composer-dom.cjs');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, '..');
const KT = path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android');
const MA = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
const RT = fs.readFileSync(path.join(KT, 'AndroidOpenCodeRuntime.kt'), 'utf8');
const COMPOSER = fs.readFileSync(path.join(CORE, 'src-js', '19-activitybar-composer.js'), 'utf8');
const REMOTE = 'https://render.example';

/* ---------- Extract the REAL Android command builder from Kotlin source ---------- */
function androidCommandBlock() {
  const start = MA.indexOf('val autoFlag =');
  assert.ok(start >= 0, 'MainActivity.openCodeRun must define the CLI flags');
  const cmdIdx = MA.indexOf('val command = "', start);
  assert.ok(cmdIdx >= 0, 'MainActivity.openCodeRun must build the command');
  return MA.slice(start, MA.indexOf('\n', cmdIdx));
}
function translateIf(line) {
  const m = line.match(/^(\s*let \w+ = )if \(/);
  if (!m) return line;
  const s = m[0].length; let depth = 1, i = s;
  while (i < line.length && depth > 0) { if (line[i] === '(') depth++; else if (line[i] === ')') depth--; i++; }
  const cond = line.slice(s, i - 1);
  const rest = line.slice(i);
  const em = rest.match(/^\s*(.*?) else (.*)$/);
  if (!em) return line;
  return m[1] + '(' + cond + ') ? ' + em[1] + ' : ' + em[2] + ';';
}
function kotlinBlockToJs(block) {
  let js = block.replace(/\bval\b/g, 'let');
  js = js.replace(/\.isNotBlank\(\)/g, '.trim().length > 0');
  js = js.replace(/\$\{([^}]*)\}/g, '" + ($1) + "');
  js = js.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '" + $1 + "');
  return js.split('\n').map(translateIf).join('\n');
}
const shQuote = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
function buildAndroidCommand({ workDir, configPath, binaryPath, model = '', sessionId = '', auto = false, prompt = '' }) {
  const fn = new Function(
    'shQuote', 'workDir', 'cfgFile', 'AndroidOpenCodeRuntime', 'model', 'sessionId', 'body', 'prompt',
    kotlinBlockToJs(androidCommandBlock()) + '\nreturn command;'
  );
  return fn(shQuote, workDir, { absolutePath: configPath }, { TERMUX_OPCODE_PATH: binaryPath }, model, sessionId, { optBoolean: () => auto }, prompt);
}

/* ---------- Run the command through the REAL v44 runtime wrapper shape ----------
 * Mirrors AndroidOpenCodeRuntime.startRun: shell starts in Termux home, writes a PID start marker,
 * `cd`s into the workspace (exit 78 if it cannot), redirects output, and ALWAYS writes the exit. */
function runtimeWrapper({ base, workDir, command }) {
  const start = path.join(base, 'start');
  const out = path.join(base, 'stdout');
  const err = path.join(base, 'stderr');
  const exit = path.join(base, 'exit');
  return "echo $$ > '" + start + "'; ( cd " + shQuote(workDir) + " || { echo CODESPACE_WORKSPACE_UNREACHABLE >&2; exit 78; } ; " + command + " ) > '" + out + "' 2> '" + err + "'; echo $? > '" + exit + "'";
}
function runWrapped(command, { base, workDir, env = {} }) {
  execFileSync('bash', ['-lc', runtimeWrapper({ base, workDir, command })], { cwd: base, env: { ...process.env, ...env } });
  const rd = f => { try { return fs.readFileSync(path.join(base, f), 'utf8'); } catch { return ''; } };
  return { start: rd('start'), exit: rd('exit').trim(), stdout: rd('stdout'), stderr: rd('stderr') };
}
function fixture(binBody) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-v44-'));
  const ws = path.join(base, 'ws dir', "it's here");
  fs.mkdirSync(ws, { recursive: true });
  const bin = path.join(base, 'opencode');
  fs.writeFileSync(bin, '#!/bin/bash\n' + binBody);
  fs.chmodSync(bin, 0o755);
  return { base, ws, bin, cfg: path.join(base, 'cfg.json'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function makeRemoteFetch(remoteCalls) {
  return async (url) => {
    const u = String(url); remoteCalls.push(u);
    const json = obj => ({ ok: true, status: 200, json: async () => obj });
    if (u.endsWith('/opencode/run')) return { ok: true, status: 200, json: async () => ({}), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    if (u.endsWith('/workspace/state')) return json({ ok: true, platform: 'linux', kind: 'remote', root: '/srv/project' });
    if (u.endsWith('/info')) return json({ platform: 'linux', root: '/srv/project' });
    if (u.endsWith('/term/list')) return json({ terminals: [] });
    if (u.endsWith('/ext/list')) return json({ extensions: [] });
    if (u.endsWith('/skills/list')) return json({ skills: [] });
    if (u.endsWith('/git/status')) return json({ branch: '', files: [], ahead: 0, behind: 0 });
    if (u.endsWith('/conn/status')) return json({});
    return json({});
  };
}
function androidComposer(opts = {}) {
  return buildComposer(Object.assign({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch([]),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/storage/emulated/0/proj' }
  }, opts));
}

/* ============================ native shell lifecycle ============================ */

/* [1] successful launch */
test('v44 [1]: a run writes a PID start marker and always writes an exit code', () => {
  const e = fixture('echo ok\n');
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: e.ws });
    assert.match(r.start.trim(), /^\d+$/, 'the shell must write its PID as the launch confirmation');
    assert.equal(r.exit, '0', 'the exit file must always be written');
    assert.match(r.stdout, /ok/);
  } finally { e.cleanup(); }
});

/* [2] first stdout chunk */
test('v44 [2]: the first stdout chunk is captured for streaming', () => {
  const e = fixture('echo \'{"type":"text","part":{"type":"text","text":"hello from cli"}}\'\nsleep 0.05\n');
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: e.ws });
    assert.equal(r.exit, '0');
    assert.match(r.stdout, /hello from cli/, 'stdout must be captured as it is produced');
  } finally { e.cleanup(); }
});

/* [3] stderr error */
test('v44 [3]: stderr is captured separately from stdout', () => {
  const e = fixture('echo "auth failed" >&2\nexit 1\n');
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: e.ws });
    assert.match(r.stderr, /auth failed/);
    assert.equal(r.stdout.trim(), '');
    assert.equal(r.exit, '1');
  } finally { e.cleanup(); }
});

/* [4] nonzero exit */
test('v44 [4]: a non-zero exit code is recorded verbatim', () => {
  const e = fixture('exit 3\n');
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: e.ws });
    assert.equal(r.exit, '3');
    assert.match(r.start.trim(), /^\d+$/, 'the process still started');
  } finally { e.cleanup(); }
});

/* [8] missing/revoked workspace */
test('v44 [8]: a missing workspace fails fast with exit 78 and a clear reason (no hang)', () => {
  const e = fixture('echo should-not-run\n');
  try {
    const missing = path.join(e.base, 'gone');
    const cmd = buildAndroidCommand({ workDir: missing, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: missing });
    assert.equal(r.exit, '78', 'an unreachable workspace must report a distinct exit code');
    assert.match(r.stderr, /CODESPACE_WORKSPACE_UNREACHABLE/);
    assert.doesNotMatch(r.stdout, /should-not-run/, 'the CLI must not run against an unreachable workspace');
  } finally { e.cleanup(); }
});

/* [9] invalid CLI args */
test('v44 [9]: invalid CLI arguments surface a non-zero exit instead of hanging', () => {
  const e = fixture('echo "Unrecognized flag: --dir in command opencode run" >&2\nexit 2\n');
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    const r = runWrapped(cmd, { base: e.base, workDir: e.ws });
    assert.equal(r.exit, '2');
    assert.match(r.stderr, /Unrecognized flag/);
  } finally { e.cleanup(); }
});

test('v44: the native runtime implements launch confirmation, watchdog, timeout, cancel, diagnostics', () => {
  assert.match(RT, /\[OPENCODE_EXEC_V44\]/);
  assert.match(RT, /val processDir = TERMUX_HOME/, 'the shell must start in a Termux-validated directory');
  assert.match(RT, /EXIT_LAUNCH_FAILED/, 'a launch failure has a distinct exit code');
  assert.match(RT, /EXIT_WORKSPACE_UNREACHABLE/, 'an unreachable workspace has a distinct exit code');
  assert.match(RT, /EXIT_TIMEOUT/, 'a timeout has a distinct exit code');
  assert.match(RT, /EXIT_CANCELLED/, 'cancellation has a distinct exit code');
  assert.match(RT, /LAUNCH_GRACE_MS/, 'a launch watchdog exists');
  assert.match(RT, /CODESPACE_LAUNCH_TIMEOUT/, 'the launch watchdog writes an actionable reason');
  assert.match(RT, /kill -TERM/, 'cancellation/timeout kills the REAL process');
  assert.match(RT, /fun workspaceAccessible/, 'the workspace is probed from Termux before a run');
  assert.match(RT, /ACTION_RESULT_GLOBAL/, 'run results are correlated back to the session');
  assert.match(RT, /PendingIntent\.FLAG_MUTABLE/, 'Termux can fill in the result extras');
  assert.match(RT, /STATE_TIMED_OUT/);
  assert.match(RT, /startFile\.length\(\) == 0L/, 'an abort is only recorded when the shell never started');
  assert.match(RT, /fun setRunTimeoutMs/, 'the timeout is configurable');
  // MainActivity: workspace probe + SAF mirror fallback + diagnostics + timeout endpoint.
  assert.match(MA, /AndroidOpenCodeRuntime\.workspaceAccessible\(this, workDir\)/);
  assert.match(MA, /AndroidOpenCodeWorkspace\.syncIn\(this, treeUri\)/);
  assert.match(MA, /mirrored = true/);
  assert.match(MA, /logDiag/);
  assert.match(MA, /"\/opencode\/run\/timeout"/);
});

/* ============================ frontend lifecycle ============================ */

/* [2]/[12] first chunk + final response rendered */
test('v44 [2][12]: launch -> running -> first chunk -> the final response is parsed', async () => {
  const ndjson = JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello world', messageID: 'm1', id: 'p1' } }) + '\n';
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_x', mirrored: false, state: 'STARTING', timeoutMs: 1800000 },
    runReadQueue: [
      { data: ndjson, next: ndjson.length, exited: false, started: true, state: 'RUNNING', pid: '4242' },
      { data: '', next: ndjson.length, exited: true, code: 0, state: 'COMPLETED', started: true, pid: '4242' }
    ]
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('hello', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.text, 'Hello world', 'the frontend must receive and parse the real CLI response');
  assert.equal(res.state, 'COMPLETED');
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/read'), 'the run must be polled');
});

/* [3] stderr surfaced to the user */
test('v44 [3]: a stderr error is returned to the caller', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_e', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 1, state: 'FAILED', stderr: 'auth failed: bad key' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /auth failed/);
});

/* [4] nonzero exit */
test('v44 [4]: a non-zero exit is surfaced with its code', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_z', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 2, state: 'FAILED', stderr: 'Unrecognized flag' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 2);
});

/* [5]/[6] process never returns / timeout recovery */
test('v44 [5][6]: a timed-out run is reported as TIMED_OUT (never left hanging)', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_t', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 124, state: 'TIMED_OUT', started: true, pid: '7', stderr: 'CODESPACE_TIMEOUT: OpenCode CLI exceeded the 1800s execution limit and was stopped.' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 124);
  assert.equal(res.timedOut, true);
  assert.equal(res.state, 'TIMED_OUT');
});

/* [5] launch never confirmed (Termux aborted) */
test('v44 [5]: a launch that never started is reported with exit 70, not a hang', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_l', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 70, state: 'FAILED', stderr: 'CODESPACE_LAUNCH_TIMEOUT: the OpenCode CLI process did not start within 45s.' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 70);
  assert.match(res.stderr, /CODESPACE_LAUNCH_TIMEOUT/);
});

/* [7] cancellation reaches the native layer (which kills the real process) */
test('v44 [7]: cancellation reaches the native adapter', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_c', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 0, state: 'COMPLETED' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  await h.api.ocLocalCall('/opencode/run/cancel', { sessionId: 'ses_c' });
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'));
});

/* [8] a lost session fails fast instead of polling forever */
test('v44 [8]: a lost session throws a clear error (no infinite poll)', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_lost', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { error: 'Unknown session', exited: true, state: 'FAILED', code: null }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  await assert.rejects(
    () => h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' }),
    /session was lost/
  );
});

/* [8] unavailable workspace -> actionable error, no CLI launch */
test('v44 [8]: an unreachable workspace is refused with an actionable error', async () => {
  const h = androidComposer({
    runReply: { ok: false, error: 'Termux cannot access the selected folder (/storage/emulated/0/x).' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const res = await h.api.runOpenCodeAndroidLocalOnce('x', { openCodeSessionId: '', title: 't' });
  assert.equal(res, null, 'a refused launch returns no result (the caller shows the error)');
});

/* [10] duplicate requests */
test('v44 [10]: a second Android-local run is never started while one is live', async () => {
  const h = androidComposer({
    runReply: { ok: true, sessionId: 'ses_dup', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 0, state: 'COMPLETED' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const sess = { openCodeSessionId: '', title: 't' };
  const p1 = h.api.runOpenCodeAndroidLocal('first', sess);
  const p2 = h.api.runOpenCodeAndroidLocal('second', sess);
  const r2 = await p2;
  const r1 = await p1;
  assert.equal(r2, null, 'the duplicate run must be suppressed');
  assert.ok(r1, 'the first run must complete');
  assert.equal(h.harness.nativeCalls.filter(c => c === '/opencode/run').length, 1, 'only one real run may be launched');
});

/* [11] Android-local without remote fallback */
test('v44 [11]: an Android workspace never falls back to the remote server', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'device', root: '/storage/emulated/0/proj', posixPath: '/storage/emulated/0/proj' },
    runReply: { ok: true, sessionId: 'ses_nf', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 0, state: 'COMPLETED' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  try { await h.api.runOpenCodeChat('do it', 'do it', ''); } catch (e) { /* DOM gaps are fine */ }
  assert.ok(h.harness.nativeCalls.includes('/opencode/run'), 'the native adapter must be used');
  assert.equal(remoteCalls.filter(u => u.endsWith('/opencode/run')).length, 0, 'the remote server must not be used');
});

/* Diagnostics prefix present in both layers. */
test('v44: [OPENCODE_EXEC_V44] diagnostics exist in JS and native code', () => {
  assert.match(COMPOSER, /\[OPENCODE_EXEC_V44\]/);
  assert.match(COMPOSER, /function ocExecLog/);
  assert.match(COMPOSER, /ocRunActive/);
  assert.match(RT, /DIAG_PREFIX = "\[OPENCODE_EXEC_V44\]"/);
  assert.match(RT, /opencode-exec-v44\.log/);
});
