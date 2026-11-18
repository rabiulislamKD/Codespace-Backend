'use strict';
/* v46 regression tests — Android-local OpenCode CLI JSONL ERROR HANDLING + provider-error lifecycle.
 *
 * Root cause addressed here: `opencode run --format json` emits STRUCTURED error events on stdout
 * (confirmed on device): {"type":"error","error":{"type":"provider.free-limit","message":"Free usage
 * limit reached.","status":429,"retryAfterMs":26922000}}. v45's parser only understood text/tool
 * events, so a terminal provider error produced NO assistant text and the run appeared to hang at
 * "Starting OpenCode CLI". v46 captures the structured error SEPARATELY from assistant text, stops
 * waiting for text, terminates only that session's process, waits for its exit, returns the
 * structured error, clears loading, and shows an actionable provider message — while never rotating
 * credentials for an account-wide free limit.
 *
 * These tests EXECUTE the real src-js parser + lifecycle (runOpenCodeAndroidLocalOnce /
 * runOpenCodeAndroidLocal / runOpenCodeChat) through the real DOM harness. Scenarios [1]..[15].
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, '..');
const RT = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'AndroidOpenCodeRuntime.kt'), 'utf8');
const MA = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
const REMOTE = 'https://render.example';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = obj => JSON.stringify(obj) + '\n';
const FREE_LIMIT = line({ type: 'error', error: { type: 'provider.free-limit', message: 'Free usage limit reached.', status: 429, retryAfterMs: 26922000 } });

function androidComposer(opts = {}) {
  return buildComposer(Object.assign({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: async () => { throw new Error('network disabled'); },
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/storage/emulated/0/proj' }
  }, opts));
}
function ready(h) { h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' }); }
function errors() { return getEl('chat').children.filter(c => c.classList && c.classList.contains('errmsg')).map(c => c.textContent); }
function notes() { return getEl('chat').children.filter(c => c.classList && c.classList.contains('note')).map(c => c.textContent); }
function runReply(sessionId) { return { ok: true, sessionId, state: 'STARTING', timeoutMs: 1800000 }; }
/* A live read followed by a terminal exit — the shape the native layer produces after v46 cancel. */
function errorQueue(payload) {
  return [
    { data: payload, next: payload.length, exited: false, started: true, state: 'RUNNING', pid: '4242' },
    { data: '', next: payload.length, exited: true, code: 130, state: 'CANCELLED', started: true, pid: '4242' }
  ];
}

/* ============================ structured parser ============================ */

test('v46 [1]: a provider.free-limit 429 event is parsed into a structured error (type/status/retry)', () => {
  const h = androidComposer();
  const pe = h.api.normalizeProviderError({ type: 'error', error: { type: 'provider.free-limit', message: 'Free usage limit reached.', status: 429, retryAfterMs: 26922000 } }, {});
  assert.equal(pe.type, 'provider.free-limit');
  assert.equal(pe.status, 429);
  assert.equal(pe.retryAfterMs, 26922000);
  assert.match(pe.message, /free usage limit/i);
});

test('v46 [2]: error.response.body and a part-shaped error are also understood', () => {
  const h = androidComposer();
  const a = h.api.normalizeProviderError({ type: 'error', error: { type: 'http_error', status: 500, response: { body: '{"detail":"upstream down"}' } } }, {});
  assert.match(a.body, /upstream down/);
  const b = h.api.normalizeProviderError({ type: 'error', part: { type: 'error', error: { type: 'model_not_found', message: 'no such model' } } }, { type: 'error', error: { type: 'model_not_found', message: 'no such model' } });
  assert.equal(b.type, 'model_not_found');
});

test('v46: looksLikeQuotaFailure inspects STRUCTURED errors, not only stderr/text', () => {
  const h = androidComposer();
  assert.equal(h.api.looksLikeQuotaFailure({ exitCode: -1, providerError: { type: 'provider.free-limit', status: 429 } }), true);
  assert.equal(h.api.looksLikeQuotaFailure({ exitCode: -1, providerError: { type: 'rate_limit', status: 429 } }), true);
  assert.equal(h.api.looksLikeQuotaFailure({ exitCode: -1, providerError: { type: 'billing', message: 'insufficient credits' } }), true);
  assert.equal(h.api.looksLikeQuotaFailure({ exitCode: 0 }), false);
  assert.equal(h.api.looksLikeQuotaFailure({ exitCode: 1, stderr: 'Unrecognized flag --dir' }), false);
});

test('v46: formatProviderError is actionable, preserves the exact type + retry delay, never raw JSON', () => {
  const h = androidComposer();
  const msg = h.api.formatProviderError({ type: 'provider.free-limit', message: 'Free usage limit reached.', status: 429, retryAfterMs: 26922000 });
  assert.match(msg, /free usage limit/i);
  assert.match(msg, /provider\.free-limit/);
  assert.match(msg, /7h 29m/, 'the retry delay must be preserved in human form');
  assert.doesNotMatch(msg, /^\s*\{/, 'the provider error JSON must not be shown verbatim');
  assert.equal(h.api.humanDuration(26922000), '7h 29m');
});

/* ============================ lifecycle: terminal provider errors ============================ */

test('v46 [1] free-limit: structured error is returned, text is never the error JSON, CLI is stopped', async () => {
  const h = androidComposer({ runReply: runReply('ses_fl'), runReadQueue: errorQueue(FREE_LIMIT) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.type, 'provider.free-limit');
  assert.equal(res.providerError.status, 429);
  assert.equal(res.providerError.retryAfterMs, 26922000);
  assert.equal(res.state, 'FAILED');
  assert.doesNotMatch(String(res.text || ''), /provider\.free-limit/, 'provider error JSON must never be rendered as the answer');
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'), 'a live CLI must be terminated for this session');
});

test('v46 [2] HTTP 429: captured and returned with the status', async () => {
  const payload = line({ type: 'error', error: { type: 'rate_limit', message: 'Too many requests', status: 429 } });
  const h = androidComposer({ runReply: runReply('ses_429'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.status, 429);
  assert.match(res.providerError.type, /rate_limit/);
});

test('v46 [3] auth error: captured and formatted as a credentials problem', async () => {
  const payload = line({ type: 'error', error: { type: 'auth_error', message: 'Invalid API key', status: 401 } });
  const h = androidComposer({ runReply: runReply('ses_auth'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.status, 401);
  assert.match(h.api.formatProviderError(res.providerError), /credentials/i);
});

test('v46 [4] model unavailable: captured and formatted as a model-availability problem', async () => {
  const payload = line({ type: 'error', error: { type: 'model_not_found', message: 'no such model', status: 404 } });
  const h = androidComposer({ runReply: runReply('ses_m404'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.status, 404);
  assert.match(h.api.formatProviderError(res.providerError), /not available/i);
});

test('v46 [5] network error: a plain error event (no status) is still captured', async () => {
  const payload = line({ type: 'error', error: { message: 'fetch failed: connection reset' } });
  const h = androidComposer({ runReply: runReply('ses_net'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.ok(res.providerError, 'a status-less error event must still be a terminal error');
  assert.match(res.providerError.message, /connection reset/);
});

test('v46 [6] normal text: no provider error is produced and the answer is parsed', async () => {
  const payload = line({ type: 'text', part: { type: 'text', text: 'Hello world', messageID: 'm1', id: 'p1' } });
  const h = androidComposer({
    runReply: runReply('ses_ok'),
    runReadQueue: [
      { data: payload, next: payload.length, exited: false, started: true, state: 'RUNNING', pid: '1' },
      { data: '', next: payload.length, exited: true, code: 0, state: 'COMPLETED', started: true, pid: '1' }
    ]
  });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError, null);
  assert.equal(res.text, 'Hello world');
  assert.equal(res.exitCode, 0);
});

test('v46 [7] tool event: ignored for text and does not create a provider error', async () => {
  const payload = line({ type: 'tool', part: { type: 'tool', tool: 'bash' } });
  const h = androidComposer({
    runReply: runReply('ses_tool'),
    runReadQueue: [
      { data: payload, next: payload.length, exited: false, started: true, state: 'RUNNING', pid: '1' },
      { data: '', next: payload.length, exited: true, code: 0, state: 'COMPLETED', started: true, pid: '1' }
    ]
  });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError, null);
  assert.equal(String(res.text || '').trim(), '');
  assert.equal(res.exitCode, 0);
});

test('v46 [8] mixed text + error: the error wins and is never rendered as the answer', async () => {
  const payload = line({ type: 'text', part: { type: 'text', text: 'partial', messageID: 'm1', id: 'p1' } }) + FREE_LIMIT;
  const h = androidComposer({ runReply: runReply('ses_mix'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.ok(res.providerError, 'the terminal error must be reported even after partial text');
  assert.doesNotMatch(String(res.text || ''), /free-limit/);
});

test('v46 [9] error + exit in the same read: no cancel is issued, the error is still returned', async () => {
  const h = androidComposer({
    runReply: runReply('ses_err_exit'),
    runReadReply: { data: FREE_LIMIT, next: FREE_LIMIT.length, exited: true, code: 1, state: 'FAILED', started: true, pid: '9' }
  });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.type, 'provider.free-limit');
  assert.ok(!h.harness.nativeCalls.includes('/opencode/run/cancel'), 'an already-exited CLI must not be cancelled again');
});

test('v46 [10] error while the CLI is alive: only this session is cancelled, then the exit is awaited', async () => {
  const payload = line({ type: 'error', error: { type: 'provider.error', message: 'boom' } });
  const h = androidComposer({ runReply: runReply('ses_alive'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'));
  assert.equal(res.providerError.type, 'provider.error');
  assert.equal(res.exitCode, 130, 'the awaited exit result is surfaced');
});

/* ============================ lifecycle: timeout, silence, cleanup ============================ */

test('v46 [11] user cancellation: Stop aborts the loop and cancels only this session', async () => {
  const h = androidComposer({
    runReply: runReply('ses_c'),
    runReadQueue: [
      { data: '', next: 0, exited: false, started: true, state: 'RUNNING', pid: '2' },
      { data: '', next: 0, exited: false, started: true, state: 'RUNNING', pid: '2' },
      { data: '', next: 0, exited: false, started: true, state: 'RUNNING', pid: '2' }
    ]
  });
  ready(h);
  const ac = new AbortController();
  h.api.setCtrl(ac);
  const p = h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  setTimeout(() => ac.abort(), 25);
  await assert.rejects(() => p, /Abort/i);
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'), 'Stop must reach the native cancel for this session');
});

test('v46 [12] timeout: a timed-out run is reported as TIMED_OUT (never left hanging)', async () => {
  const h = androidComposer({
    runReply: runReply('ses_to'),
    runReadReply: { data: '', next: 0, exited: true, code: 124, state: 'TIMED_OUT', started: true, pid: '7', stderr: 'CODESPACE_TIMEOUT: stopped.' }
  });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 124);
  assert.equal(res.timedOut, true);
  assert.equal(res.state, 'TIMED_OUT');
});

test('v46 [13] silent live run: empty chunks keep polling until the real exit (no hang, no fabricated text)', async () => {
  const h = androidComposer({
    runReply: runReply('ses_silent'),
    runReadQueue: [
      { data: '', next: 0, exited: false, started: true, state: 'RUNNING', pid: '5' },
      { data: '', next: 0, exited: false, started: true, state: 'RUNNING', pid: '5' },
      { data: '', next: 0, exited: true, code: 0, state: 'COMPLETED', started: true, pid: '5' }
    ]
  });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.exitCode, 0);
  assert.equal(String(res.text || '').trim(), '');
  assert.ok(h.harness.nativeCalls.filter(c => c === '/opencode/run/read').length >= 3, 'the run must keep being polled');
});

test('v46 [13] the native runtime exposes safe process/output diagnostics + per-run files + cleanup', () => {
  assert.match(RT, /fun probeSession/, 'a live-run probe exists for the zero-byte investigation');
  assert.match(RT, /wchan/, 'the probe reports the kernel wait channel');
  assert.match(RT, /task\/\$1\/children|task\/\$p\/children/, 'the process tree is enumerated');
  assert.match(RT, /sinceOutputMs/, 'time since the last output is reported');
  assert.match(RT, /val runId: String/, 'each run has its own id');
  assert.match(RT, /"\$runId\.out"/, 'run files are namespaced per run so an old run cannot overwrite a new one');
  assert.match(RT, /fun cleanupStaleRuns|cleanupStaleRuns\(/, 'stale run files are cleaned up');
  assert.match(RT, /fun cleanupRunFiles|cleanupRunFiles\(/, 'finished runs are cleaned up');
  assert.match(RT, /NO_OUTPUT_DIAG_MS/, 'a silent live run logs its real state');
  assert.match(MA, /"\/opencode\/run\/probe"/, 'MainActivity routes the probe endpoint');
  assert.match(MA, /fun probeSession|probeSession\(/, 'MainActivity can reach the probe');
});

/* ============================ account-wide quota: never rotate ============================ */

test('v46 [14] account-wide free limit: credentials are NOT rotated (a second key cannot restore quota)', async () => {
  const h = androidComposer({ runReply: runReply('ses_norot'), runReadQueue: errorQueue(FREE_LIMIT) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocal('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(res.providerError.type, 'provider.free-limit');
  assert.ok(!h.harness.nativeCalls.includes('/opencode/keys/rotate'), 'must not rotate keys for an account-wide free limit');
  assert.ok(errors().some(t => /account/i.test(t) && /not restore quota|no automatic key switch/i.test(t)), 'the user is told why no key switch happened');
  assert.equal(h.api.isAccountWideQuotaFailure(res), true);
});

test('v46 [14b] a per-key 429 (not account-wide) may still rotate once, then reports clearly', async () => {
  const payload = line({ type: 'error', error: { type: 'rate_limit', message: 'Too many requests', status: 429 } });
  const h = androidComposer({ runReply: runReply('ses_rot'), runReadQueue: errorQueue(payload) });
  ready(h);
  const res = await h.api.runOpenCodeAndroidLocal('hi', { openCodeSessionId: '', title: 't' });
  assert.equal(h.api.isAccountWideQuotaFailure(res), false);
  assert.ok(h.harness.nativeCalls.includes('/opencode/keys/rotate'), 'a non-account-wide rate limit may rotate to the next key');
  assert.ok(errors().length > 0, 'the outcome is reported to the user');
});

/* ============================ end-to-end chat UI ============================ */

test('v46 [15] the final provider error appears in the chat UI and loading is cleared', async () => {
  const h = androidComposer({ runReply: runReply('ses_ui'), runReadQueue: errorQueue(FREE_LIMIT) });
  ready(h);
  try { await h.api.runOpenCodeChat('do it', 'do it', ''); } catch (e) { /* DOM gaps are acceptable */ }
  await sleep(30);
  const es = errors();
  assert.ok(es.some(t => /provider error/i.test(t) && /free usage limit/i.test(t)), 'an actionable provider error must be shown in the chat');
  assert.ok(!h.harness.nativeCalls.includes('/opencode/keys/rotate'), 'the UI path must not rotate for an account-wide free limit');
});

/* ============================ diagnostics hygiene ============================ */

test('v46: no provider error event is ever merged into assistant text by the parser', () => {
  const src = fs.readFileSync(path.join(CORE, 'src-js', '19-activitybar-composer.js'), 'utf8');
  assert.match(src, /let providerError = null/);
  assert.match(src, /providerError = normalizeProviderError\(ev, part\)/);
  assert.match(src, /return;\n\s*\}\n\s*if \(typ === 'text'/);
  assert.match(src, /\[OPENCODE_EXEC_V44\]/);
});
