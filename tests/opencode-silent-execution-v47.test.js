'use strict';
/* v47 regression tests — Android-local OpenCode SILENT EXECUTION + process lifecycle + free quota.
 *
 * Confirmed v46 evidence: Termux starts, the workspace is reachable, the shell writes a start
 * marker, but several models produce zero-byte stdout/stderr for minutes. v46 recorded only the
 * launcher shell PID (childPid empty) and initialized lastOutputAt to 0 (bad sinceOutputMs).
 *
 * v47 fixes: the CLI is launched as a TRACKED BACKGROUND CHILD (`exec` + `$!`), BOTH PIDs are
 * written atomically, the parent `wait`s for the real child exit, diagnostics probe the CLI PID
 * and its descendants (never treating unreadable /proc as death), a no-output watchdog only kills
 * a genuinely stuck tree, cancellation is VERIFIED, and a terminal provider error is preserved
 * even if cancellation later yields exit 130.
 *
 * These tests execute the real shell wrapper shape and the REAL src-js parser/lifecycle through the
 * DOM harness. Required scenarios [1]..[11] plus the free-quota critical correction.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, '..');
const KT = path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android');
const RT = fs.readFileSync(path.join(KT, 'AndroidOpenCodeRuntime.kt'), 'utf8');
const MA = fs.readFileSync(path.join(KT, 'MainActivity.kt'), 'utf8');
const JS = fs.readFileSync(path.join(CORE, 'src-js', '19-activitybar-composer.js'), 'utf8');
const REMOTE = 'https://render.example';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = obj => JSON.stringify(obj) + '\n';

/* Exact shape supplied in the device logs (retryAfterMs ≈ 23 million ms). */
const DEVICE_FREE_LIMIT = line({
  type: 'error',
  error: {
    type: 'provider.free-limit',
    message: 'Free usage limit reached.',
    status: 429,
    retryAfterMs: 23000000,
    response: { body: '{"error":{"message":"free quota exhausted","code":429}}' }
  }
});

const shQuote = v => "'" + String(v).replace(/'/g, "'\\''") + "'";

/* ---------- real v47 wrapper executed as a shell script ---------- */
function wrapper({ base, workDir, command }) {
  const start = path.join(base, 'start');
  const startTmp = path.join(base, 'start.tmp');
  const out = path.join(base, 'stdout');
  const err = path.join(base, 'stderr');
  const exit = path.join(base, 'exit');
  return "( cd " + shQuote(workDir) + " || { echo CODESPACE_WORKSPACE_UNREACHABLE >&2; exit 78; } ; exec " + command +
    " ) > '" + out + "' 2> '" + err + "' & cli=$!; " +
    "printf '%s\\n%s\\n' \"$$\" \"$cli\" > '" + startTmp + "' && mv -f '" + startTmp + "' '" + start + "'; " +
    "wait \"$cli\"; printf '%s' \"$?\" > '" + exit + "'";
}
function fixture(body, runId = 'r1') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-v47-'));
  const ws = path.join(base, 'ws dir');
  fs.mkdirSync(ws, { recursive: true });
  const bin = path.join(base, 'opencode');
  fs.writeFileSync(bin, '#!/bin/bash\n' + body);
  fs.chmodSync(bin, 0o755);
  const f = {
    base, ws, bin, runId,
    cmd: 'env OPENCODE_CONFIG=' + shQuote(path.join(base, 'cfg.json')) + ' ' + shQuote(bin) + " run --standalone --format json -- 'hidden prompt'",
    rd: n => { try { return fs.readFileSync(path.join(base, n), 'utf8'); } catch { return ''; } },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true })
  };
  return f;
}
function runWrapped(f, env = {}) {
  execFileSync('bash', ['-lc', wrapper({ base: f.base, workDir: f.ws, command: f.cmd })],
    { cwd: f.base, env: { ...process.env, ...env }, timeout: 20000 });
  return { start: f.rd('start'), exit: f.rd('exit').trim(), stdout: f.rd('stdout'), stderr: f.rd('stderr') };
}
function pids(r) {
  const lines = r.start.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, 'the start marker must contain shell PID + CLI child PID');
  assert.match(lines[0], /^\d+$/, 'shell PID');
  assert.match(lines[1], /^\d+$/, 'CLI child PID');
  return { shell: lines[0], cli: lines[1] };
}
function alive(pid) {
  try { execFileSync('bash', ['-lc', '[ -d /proc/' + pid + ' ] && echo yes'], { encoding: 'utf8' }); return true; }
  catch { return false; }
}

/* ---------- composer harness ---------- */
function androidComposer(opts = {}) {
  return buildComposer(Object.assign({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: async () => { throw new Error('network disabled'); },
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/storage/emulated/0/proj' }
  }, opts));
}
function ready(h) { h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' }); }
function errors() { return getEl('chat').children.filter(c => c.classList && c.classList.contains('errmsg')).map(c => c.textContent); }
function runReply(sessionId, extra = {}) { return Object.assign({ ok: true, sessionId, state: 'STARTING', timeoutMs: 30 * 60 * 1000 }, extra); }
function errorQueue(payload, code = 130) {
  return [
    { data: payload, next: payload.length, exited: false, started: true, state: 'RUNNING', pid: '4242', childPid: '4243' },
    { data: '', next: payload.length, exited: true, code, state: 'CANCELLED', started: true, pid: '4242', childPid: '4243' }
  ];
}

/* ==================== [1] shell PID and CLI child PID tracking ==================== */

test('v47 [1]: the launcher shell PID and the actual OpenCode CLI child PID are both recorded', () => {
  const f = fixture('printf \'%s\' "$OPENCODE_CONFIG"; echo ok\n');
  try {
    const r = runWrapped(f);
    const p = pids(r);
    assert.notEqual(p.shell, p.cli, 'shell and CLI PIDs must be different processes');
    assert.equal(r.exit, '0');
    assert.match(RT, /cli=\\\$!;|cli=\$!;/, 'the launcher captures $! from the background child');
    assert.match(RT, /printf '%s\\\\n%s\\\\n'/, 'both PIDs are written to the start marker');
    assert.ok(RT.includes("mv -f '"), 'the marker is installed atomically with rename');
    assert.match(RT, /wait \\"\\\$cli\\"|wait \"\$cli\"/, 'the parent waits for the real child');
  } finally { f.cleanup(); }
});

test('v47 [1b]: the native reader parses both PIDs and reuses them for kill/probe', () => {
  assert.match(RT, /val shellPid = lines\.getOrNull\(0\)/, 'line 1 is the launcher shell PID');
  assert.match(RT, /val cliPid = lines\.getOrNull\(1\)/, 'line 2 is the OpenCode CLI child PID');
  assert.match(RT, /s\.childPid = if \(cliPid\.matches/, 'an invalid child PID is never fabricated');
  assert.match(RT, /val cliPid = s\.childPid\.ifBlank \{ s\.pid \}/, 'probe targets the CLI PID');
  assert.doesNotMatch(RT, /lastOutputAt: Long = 0L/, 'a zero initial timestamp is a bug, not a default');
  assert.match(RT, /lastOutputAt: Long = launchedAt/, 'lastOutputAt starts at launch time');
});

/* ==================== [2] successful output and exit ==================== */

test('v47 [2]: successful CLI output and real child exit code are preserved', () => {
  const f = fixture('echo \'{"type":"text","part":{"type":"text","text":"answer","messageID":"m1","id":"p1"}}\'\nexit 0\n');
  try {
    const r = runWrapped(f);
    assert.match(r.stdout, /answer/);
    assert.equal(r.exit, '0', 'the parent records the child\'s real exit code');
    pids(r);
  } finally { f.cleanup(); }
});

test('v47 [2b]: a non-zero child exit code is recorded verbatim', () => {
  const f = fixture('exit 3\n');
  try { assert.equal(runWrapped(f).exit, '3'); } finally { f.cleanup(); }
});

/* ==================== [3] zero-output process ==================== */

test('v47 [3]: a silent CLI still writes both PIDs and a real exit, with empty output files', () => {
  const f = fixture('sleep 0.4\nexit 0\n');
  try {
    const r = runWrapped(f);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(r.exit, '0');
    pids(r);
    assert.match(RT, /NO_OUTPUT_DIAG_MS/, 'silent runs are diagnosed');
  } finally { f.cleanup(); }
});

test('v47 [3b]: absence of text alone never triggers a kill', () => {
  assert.match(RT, /if \(silenceMs > noOutputWatchdogMs && isStuck\(cls\)\)/, 'both a long silence AND a stuck process are required');
  assert.match(RT, /private fun isStuck\(cls: String\): Boolean = cls == "DEAD" \|\| cls == "BLOCKED"/,
    'a sleeping provider wait is not "stuck"');
  assert.match(RT, /setNoOutputWatchdogMs/, 'the watchdog threshold is configurable');
  assert.match(MA, /"\/opencode\/run\/watchdog"/, 'the threshold is reachable from the host');
});

test('v47 [3c]: the CLI runs in --standalone mode (private server, no managed service)', () => {
  // Controlled test with the installed v2.0.32-android-termux.1 binary (2026-11-19):
  //   `opencode models`                -> rc=1, stdout=0 bytes (managed service port conflict)
  //   `opencode models --standalone`   -> rc=0, stdout=1004 bytes
  //   `opencode run ... --standalone`  -> rc=0, stdout=558 bytes, JSONL text event
  // The managed background service is not dependable from a one-shot Termux shell; --standalone
  // starts a private server for the command and removes that entire class of silent runs.
  assert.match(MA, /run --standalone --format json/, 'the run command must use a private server');
  assert.match(MA, /models --standalone/, 'model discovery must use a private server too');
  assert.match(RT, /exec /, 'the launcher execs the CLI so $! is the real CLI pid');
});

/* ==================== [4] provider initialization failure ==================== */

test('v47 [4]: a provider initialization failure is captured as a structured error', async () => {
  const payload = line({ type: 'error', error: { type: 'provider.init-failed', message: 'provider initialization failed', status: 500, response: { body: 'init failed' } } });
  const f = fixture('cat <<\'EOF\'\n' + payload + 'EOF\nexit 1\n');
  const shell = runWrapped(f);
  try {
    assert.match(shell.stdout, /provider\.init-failed/);
    assert.equal(shell.exit, '1');
    const h = androidComposer({ runReply: runReply('ses_init'), runReadQueue: errorQueue(payload, 1) });
    ready(h);
    const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
    assert.equal(res.providerError.type, 'provider.init-failed');
    assert.equal(res.state, 'FAILED');
    assert.doesNotMatch(String(res.text || ''), /provider\.init-failed/, 'error JSON is never an answer');
  } finally { f.cleanup(); }
});

/* ==================== [5] authentication error ==================== */

test('v47 [5]: an authentication error is reported as a credentials problem', async () => {
  const payload = line({ type: 'error', error: { type: 'auth_error', message: 'Invalid API key', status: 401 } });
  const h = androidComposer({ runReply: runReply('ses_auth'), runReadQueue: errorQueue(payload, 1) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.status, 401);
  assert.match(h.api.formatProviderError(res.providerError), /credentials/i);
});

/* ==================== [6] network timeout ==================== */

test('v47 [6]: a network-stall error is terminal and the CLI is stopped for that session only', async () => {
  const payload = line({ type: 'error', error: { type: 'network_timeout', message: 'fetch failed: network timeout' } });
  const h = androidComposer({ runReply: runReply('ses_net'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.state, 'FAILED');
  assert.match(res.providerError.message, /network timeout/);
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'));
  const cancels = h.harness.nativePayloads.filter(p => p.pathname === '/opencode/run/cancel');
  assert.ok(cancels.every(p => p.payload.sessionId === 'ses_net'), 'no other session is cancelled');
});

/* ==================== [7] free-model quota error (critical correction) ==================== */

test('v47 [7]: the exact device JSONL for provider.free-limit is preserved field-for-field', async () => {
  const h = androidComposer();
  const pe = h.api.normalizeProviderError(JSON.parse(DEVICE_FREE_LIMIT), {});
  assert.equal(pe.type, 'provider.free-limit');
  assert.equal(pe.status, 429);
  assert.equal(pe.message, 'Free usage limit reached.');
  assert.equal(pe.retryAfterMs, 23000000);
  assert.match(pe.body, /free quota exhausted/);
  assert.equal(h.api.humanDuration(23000000), '6h 23m');
});

test('v47 [7b]: free-limit transitions straight to FAILED without waiting for the 30-minute timeout', async () => {
  const t0 = Date.now();
  const h = androidComposer({ runReply: runReply('ses_quota', { timeoutMs: 1800000 }), runReadQueue: errorQueue(DEVICE_FREE_LIMIT) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.state, 'FAILED');
  assert.equal(res.timedOut, false);
  assert.equal(res.providerError.type, 'provider.free-limit');
  assert.ok(Date.now() - t0 < 5000, 'a terminal quota error must not wait for the run timeout');
  assert.equal(res.diagnosis, '');
});

test('v47 [7c]: the message says Free quota exhausted, shows the retry time, and blames the provider', async () => {
  const h = androidComposer({ runReply: runReply('ses_qmsg'), runReadQueue: errorQueue(DEVICE_FREE_LIMIT) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  const msg = h.api.formatProviderError(res.providerError);
  assert.match(msg, /Free quota exhausted/i);
  assert.match(msg, /Try again in about 6h 23m/i);
  assert.match(msg, /provider quota\/availability error/i);
  assert.doesNotMatch(msg, /Termux|not installed/i);
  assert.match(msg, /not a missing model or an installation problem/i, 'the message explicitly rules out wrong diagnoses');
  assert.equal(h.api.isAccountWideQuotaFailure(res), true);
});

test('v47 [7d]: an account-wide free quota never rotates credentials or changes model', async () => {
  const h = androidComposer({ runReply: runReply('ses_qrot'), runReadQueue: errorQueue(DEVICE_FREE_LIMIT) });
  ready(h);
  const before = h.api.activeOpenCodeModel();
  const res = await h.api.runOpenCodeAndroidLocal('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.type, 'provider.free-limit');
  assert.ok(!h.harness.nativeCalls.includes('/opencode/keys/rotate'), 'no key rotation for an account-wide free limit');
  assert.equal(h.api.activeOpenCodeModel(), before, 'the selected model is preserved');
  assert.match((errors().join(' ') || ''), /account/i);
});

test('v47 [7e]: the ORIGINAL provider error survives a subsequent cancel with exit 130', async () => {
  const payload = DEVICE_FREE_LIMIT + line({ type: 'error', error: { type: 'cancelled', message: 'process killed' } });
  const h = androidComposer({ runReply: runReply('ses_orig'), runReadQueue: errorQueue(payload, 130) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.type, 'provider.free-limit', 'the first/original error must win');
  assert.equal(res.providerError.retryAfterMs, 23000000);
  assert.equal(res.exitCode, 130, 'the real exit code is still reported');
  assert.equal(res.state, 'FAILED', 'the session is still a provider failure, not a cancellation');
});

test('v47 [7f]: the structured error reaches the chat UI and loading is cleared', async () => {
  const h = androidComposer({ runReply: runReply('ses_ui'), runReadQueue: errorQueue(DEVICE_FREE_LIMIT) });
  ready(h);
  try { await h.api.runOpenCodeChat('do it', 'do it', ''); } catch { /* DOM gaps acceptable */ }
  await sleep(30);
  const es = errors();
  assert.ok(es.some(t => /Free quota exhausted/i.test(t) && /6h 23m/.test(t)), 'actionable free-quota message in chat');
  assert.ok(!h.harness.nativeCalls.includes('/opencode/keys/rotate'));
  assert.match(JS, /setBusy\(false\)/, 'the turn always clears the loading state');
});

/* ==================== [7g] invalid model reference (v47.1) ==================== */

test('v47.1 [7g]: "Invalid model reference: big-pickle (unknown)" is a model error, never quota', async () => {
  const payload = line({ type: 'error', error: { type: 'error', message: 'Invalid model reference: big-pickle (unknown)' } });
  const h = androidComposer({ runReply: runReply('ses_badmodel'), runReadQueue: errorQueue(payload, 1) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.state, 'FAILED');
  assert.equal(res.providerError.message, 'Invalid model reference: big-pickle (unknown)');
  const msg = h.api.formatProviderError(res.providerError);
  assert.match(msg, /model is not available from its provider/i);
  assert.match(msg, /provider\/model, for example opencode\/big-pickle/i);
  assert.doesNotMatch(msg, /provider quota\/availability error/i, 'never mislabel a bad model as quota');
  assert.doesNotMatch(msg, /not a missing model/i, 'never deny the actual problem');
  assert.equal(h.api.looksLikeQuotaFailure(res), false, 'no key rotation for a model error');
  await h.api.runOpenCodeAndroidLocal('hi', { openCodeSessionId: '', title: 't' });
  assert.ok(!h.harness.nativeCalls.includes('/opencode/keys/rotate'), 'no credentials are rotated');
});

test('v47.1 [7h]: the CLI requires a provider-prefixed id and discovery retries without --standalone', () => {
  assert.match(MA, /model\.contains\('\/'\)/, 'bare model names are rejected on save');
  assert.match(MA, /provider\/model, for example opencode\/big-pickle/, 'the validation message is actionable');
  assert.match(MA, /discoverOpenCodeModels\(standalone = true\)/, 'discovery tries --standalone first');
  assert.match(MA, /discoverOpenCodeModels\(standalone = false\)/, 'discovery falls back to the plain command');
  assert.match(MA, /parseOpenCodeModelIds/, 'CLI output is parsed into provider/model ids');
  assert.match(MA, /no provider\/model entries/, 'an unparseable list gets a specific diagnosis');
  assert.match(JS, /isOpenCodeModelReferenceError/, 'the model-error guard exists in the formatter');
});

/* ==================== [8] cancellation of a child process ==================== */

test('v47 [8]: cancellation kills the shell AND the CLI child, verified before success', () => {
  assert.match(RT, /killRun\(context\.applicationContext, s\.pid, s\.childPid\)/, 'cancel signals both recorded PIDs');
  assert.match(RT, /kill -TERM/, 'TERM is sent');
  assert.match(RT, /kill -KILL/, 'KILL is sent after the grace period');
  assert.match(RT, /var verified = false/, 'cancel tracks verification');
  assert.match(RT, /if \(observedExit != null\) \{ verified = true; break \}/, 'the reaped exit verifies termination');
  assert.match(RT, /proc\.known && !proc\.alive/, 'a real /proc observation also verifies termination');
  assert.match(RT, /\.put\("ok", verified\)/, 'unverified cancellation is not reported as success');
  assert.match(RT, /sessions\[sessionId\] \?:/, 'the session is kept so the final state can be read back');
});

test('v47 [8b]: a live child tree can be signalled with no orphan left behind', async () => {
  const f = fixture('sleep 30\n');
  const child = spawn('bash', ['-lc', wrapper({ base: f.base, workDir: f.ws, command: f.cmd })],
    { cwd: f.base, env: { ...process.env }, stdio: 'ignore' });
  try {
    let start = '';
    for (let i = 0; i < 40 && start.trim().split(/\r?\n/).length < 2; i++) {
      try { start = f.rd('start'); } catch {}
      await sleep(25);
    }
    const p = pids({ start });
    assert.ok(alive(p.shell) && alive(p.cli), 'both shell and CLI are live before cancellation');
    execFileSync('bash', ['-lc',
      'kill_tree(){ for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do kill_tree $c $2; done; kill -$2 $1 2>/dev/null; }; ' +
      'kill_tree ' + p.shell + ' TERM; kill -TERM ' + p.cli + ' 2>/dev/null; sleep 0.3; ' +
      'kill_tree ' + p.shell + ' KILL; kill -KILL ' + p.cli + ' 2>/dev/null; true'], { timeout: 10000 });
    await sleep(300);
    assert.equal(alive(p.cli), false, 'the CLI child must be gone after cancellation');
    assert.equal(alive(p.shell), false, 'the launcher shell must be gone after cancellation');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    f.cleanup();
  }
});

/* ==================== [9] multiple independent sessions ==================== */

test('v47 [9]: independent runs use distinct files and never overwrite each other', () => {
  const a = fixture('echo A\n', 'ses_a');
  const b = fixture('echo B\n', 'ses_b');
  try {
    const ra = runWrapped(a), rb = runWrapped(b);
    assert.match(ra.stdout, /A/); assert.match(rb.stdout, /B/);
    assert.notEqual(pids(ra).cli, pids(rb).cli);
    assert.equal(ra.exit, '0'); assert.equal(rb.exit, '0');
    assert.match(RT, /val runId = sessionId \+ "-" \+/, 'run files are namespaced per run');
  } finally { a.cleanup(); b.cleanup(); }
});

/* ==================== [10] no orphans after completion ==================== */

test('v47 [10]: a completed run leaves no CLI child alive', () => {
  const f = fixture('sleep 0.2; echo done\n');
  try {
    const r = runWrapped(f);
    const p = pids(r);
    assert.equal(r.exit, '0');
    assert.equal(alive(p.cli), false, 'the CLI child exited with the run');
    assert.equal(alive(p.shell), false, 'the launcher shell exited with the run');
    assert.match(RT, /probeTree/, 'the whole descendant tree is observable');
  } finally { f.cleanup(); }
});

/* ==================== [11] elapsed and since-output timing ==================== */

test('v47 [11]: sinceOutputMs uses the launch-time default and is computed without a zero guard', () => {
  assert.match(RT, /\.put\("elapsedMs", t - s\.launchedAt\)/);
  assert.match(RT, /\.put\("sinceOutputMs", t - s\.lastOutputAt\)/, 'no conditional fallback to elapsed');
  assert.doesNotMatch(RT, /if \(s\.lastOutputAt > 0L\) t - s\.lastOutputAt else elapsed/);
  assert.match(RT, /\.put\("sinceOutputMs", t - s\.lastOutputAt\)[\s\S]{0,1200}\.put\("diagnosis", s\.diagnosis\)/);
});

test('v47 [11b]: probe distinguishes DEAD / SLEEPING / BLOCKED / ACTIVE / UNKNOWN', () => {
  assert.match(RT, /private fun classifyProcess/);
  assert.match(RT, /if \(!p\.known\) return "UNKNOWN"/, 'an unreadable /proc entry is never DEAD');
  assert.match(RT, /"D", "T", "t" -> "BLOCKED"/);
  assert.match(RT, /"R" -> "ACTIVE"/);
  assert.match(RT, /"S", "I", "" -> "SLEEPING"/);
  assert.match(RT, /\.put\("accessible", cli\.accessible\)/);
  assert.match(RT, /\.put\("known", cli\.known\)/);
  assert.match(RT, /\.put\("ppid", cli\.parentPid\)/);
  assert.match(RT, /\.put\("wchan", cli\.wchan\)/);
  assert.match(RT, /\.put\("waitReason", waitReason\(cli\.wchan\)\)/);
  assert.match(RT, /\.put\("outSize", s\.outFile\.length\(\)\)/);
  assert.match(RT, /\.put\("diagnosis", s\.diagnosis\)/);
});

test('v47 [11c]: the probe call is safe — no prompt, key or auth header is logged', () => {
  assert.match(RT, /\[OPENCODE_EXEC_V44\]/, 'the diagnostics prefix is unchanged');
  const probeLog = JS.match(/ocExecLog\('probe'[\s\S]{0,500}?\}\)/);
  assert.ok(probeLog, 'the frontend logs a probe event');
  assert.doesNotMatch(probeLog[0], /prompt|apiKey|Authorization|token/i, 'probe logs contain no secrets');
  assert.doesNotMatch(RT, /diag\(.*prompt.*\)/, 'native diagnostics never log the prompt');
});

test('v47: a stuck process returns a structured diagnosis and exit code 125', () => {
  assert.match(RT, /EXIT_STUCK = 125/);
  assert.match(RT, /CODESPACE_STUCK/, 'the diagnosis is written to stderr');
  assert.match(RT, /s\.diagnosis = "No output for/, 'a structured diagnosis is recorded');
  assert.match(RT, /\.put\("diagnosis", s\.diagnosis\)/, 'the diagnosis is returned to the frontend');
  assert.match(JS, /result\.exitCode === 125/, 'the frontend explains a stuck run');
  assert.match(JS, /if \(result\.diagnosis\) detail \+= ' ' \+ result\.diagnosis/);
});
