'use strict';
/* v43.1 regression tests — OpenCode CLI compatibility: the installed OpenCode v2 CLI has no
 * `--dir` flag. Reported on-device error: "Unrecognized flag: --dir in command opencode run".
 *
 * These tests do NOT merely grep source text. They extract the REAL Android command builder from
 * MainActivity.kt (openCodeRun) and the REAL argv builder from agent-server.js (openCodeRun), then
 * EXECUTE the produced command through bash with a fake `opencode` binary that records its working
 * directory and argv. They also drive the REAL src-js chat runner to prove Android-local execution
 * still streams, cancels, and never falls back to the remote server or Zen.
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
const MA = fs.readFileSync(path.join(APP, 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'), 'utf8');
const SERVER = fs.readFileSync(path.join(CORE, 'agent-server.js'), 'utf8');
const REMOTE = 'https://render.example';

/* ---------- Extract the REAL Android command builder from Kotlin source ---------- */

function androidCommandBlock() {
  const start = MA.indexOf('val autoFlag =');
  assert.ok(start >= 0, 'MainActivity.openCodeRun must define the CLI flags');
  const cmdIdx = MA.indexOf('val command = "', start);
  assert.ok(cmdIdx >= 0, 'MainActivity.openCodeRun must build the command');
  return MA.slice(start, MA.indexOf('\n', cmdIdx));
}

/* Translate the tiny Kotlin subset (val / if-else / ${} interpolation) into executable JS so the
 * tests run the ACTUAL builder expression, not a hand-written copy of it. */
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

/* POSIX single-quote escaping — mirrors MainActivity.shQuote (Kotlin String.replace is global). */
const shQuote = v => "'" + String(v).replace(/'/g, "'\\''") + "'";

function buildAndroidCommand({ workDir, configPath, binaryPath, model = '', sessionId = '', auto = false, prompt = '' }) {
  const fn = new Function(
    'shQuote', 'workDir', 'cfgFile', 'AndroidOpenCodeRuntime', 'model', 'sessionId', 'body', 'prompt',
    kotlinBlockToJs(androidCommandBlock()) + '\nreturn command;'
  );
  return fn(shQuote, workDir, { absolutePath: configPath }, { TERMUX_OPCODE_PATH: binaryPath }, model, sessionId, { optBoolean: () => auto }, prompt);
}

/* Run the exact Termux wrapper the app uses. Mirrors AndroidOpenCodeRuntime.startRun v44: the
 * shell starts in Termux home, writes a start marker with its PID, `cd`s into the workspace
 * (reporting exit 78 when it cannot), redirects the command output, and ALWAYS writes the exit
 * code — so a failed launch can never leave the task polling forever. */
function runInTermux(command, { base, workDir, env = {} }) {
  const start = path.join(base, 'start');
  const out = path.join(base, 'stdout');
  const err = path.join(base, 'stderr');
  const exit = path.join(base, 'exit');
  const wrapped = "echo $$ > '" + start + "'; ( cd " + shQuote(workDir) + " || { echo CODESPACE_WORKSPACE_UNREACHABLE >&2; exit 78; } ; " + command + " ) > '" + out + "' 2> '" + err + "'; echo $? > '" + exit + "'";
  execFileSync('bash', ['-lc', wrapped], { cwd: base, env: { ...process.env, ...env } });
  return {
    exit: fs.readFileSync(exit, 'utf8').trim(),
    stdout: fs.readFileSync(out, 'utf8'),
    stderr: fs.readFileSync(err, 'utf8')
  };
}

function fakeOpencodeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nodir-'));
  const ws = path.join(base, 'ws dir', "it's here");
  fs.mkdirSync(ws, { recursive: true });
  const bin = path.join(base, 'opencode');
  fs.writeFileSync(bin, '#!/bin/bash\n{ echo "CWD=$PWD"; i=0; for a in "$@"; do echo "ARG$i=$a"; i=$((i+1)); done; } > "$OC_TEST_OUT"\n');
  fs.chmodSync(bin, 0o755);
  return { base, ws, bin, outFile: path.join(base, 'out.txt'), cfg: path.join(base, 'cfg.json'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function parseFake(out) {
  const lines = out.split('\n').filter(Boolean);
  const cwd = (lines.find(l => l.startsWith('CWD=')) || '').slice(4);
  const argv = lines.filter(l => l.startsWith('ARG')).map(l => l.slice(l.indexOf('=') + 1));
  return { cwd, argv };
}

function makeRemoteFetch(remoteCalls) {
  return async (url) => {
    const u = String(url);
    remoteCalls.push(u);
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

/* ---------- 1. No OpenCode invocation contains "--dir" ---------- */
test('v43.1: no OpenCode invocation passes --dir (desktop, Android, bundled JS, src-js)', () => {
  const at = SERVER.indexOf('function openCodeRun(');
  const runSlice = SERVER.slice(at, at + 3000);
  assert.ok(!/'--dir'/.test(runSlice), 'agent-server openCodeRun must not pass --dir');
  const block = androidCommandBlock();
  const cmdLine = (block.match(/val command = "[^"]*"/) || [''])[0];
  assert.ok(cmdLine, 'the Android command line must be present');
  assert.ok(!/--dir/.test(cmdLine), 'the Android command must not pass --dir');
  for (const rel of ['js/app.js', path.join('..', 'app', 'src', 'main', 'assets', 'codespace-web', 'js', 'app.js')]) {
    const f = path.join(CORE, rel);
    if (fs.existsSync(f)) assert.ok(!/--dir/.test(fs.readFileSync(f, 'utf8')), rel + ' must not contain --dir');
  }
  const srcDir = path.join(CORE, 'src-js');
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    assert.ok(!/opencode[^\n]*--dir/.test(fs.readFileSync(path.join(srcDir, f), 'utf8')), f + ' must not pass --dir to opencode');
  }
});

/* ---------- 2. Android execution uses the selected workspace as its working directory ---------- */
test('v43.1: Android execution runs OpenCode with the selected workspace as its working directory', () => {
  const e = fakeOpencodeEnv();
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'list files' });
    assert.ok(!cmd.includes('--dir'), 'the built command must not contain --dir');
    const res = runInTermux(cmd, { base: e.base, workDir: e.ws, env: { OC_TEST_OUT: e.outFile } });
    assert.equal(res.exit, '0', 'the Termux command must succeed');
    const seen = parseFake(fs.readFileSync(e.outFile, 'utf8'));
    assert.equal(seen.cwd, e.ws, 'OpenCode must start in the selected workspace');
  } finally { e.cleanup(); }
});

/* ---------- 3. Desktop execution still uses its selected workspace ---------- */
test('v43.1: desktop (agent-server) execution still uses its selected workspace via cwd', () => {
  const m = SERVER.match(/const args = (\[[^\]]*\]);/);
  assert.ok(m, 'agent-server openCodeRun must build an argv array');
  const args = new Function('binary', 'const args = ' + m[1] + '; return args;')({ prefix: [] });
  assert.deepEqual(args, ['run', '--format', 'json'], 'desktop argv must be run --format json with no workspace flag');
  assert.ok(!args.includes('--dir'));
  assert.match(SERVER, /spawn\(binary\.command, args, \{ cwd: ROOT,/);
  assert.match(SERVER, /say\('Starting OpenCode CLI in ' \+ ROOT/);
});

/* ---------- 4. Model, session and prompt are preserved ---------- */
test('v43.1: model, session and prompt arguments are preserved for Android execution', () => {
  const e = fakeOpencodeEnv();
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, model: 'anthropic/claude#high', sessionId: 'ses_abc123', auto: true, prompt: 'fix the bug' });
    const res = runInTermux(cmd, { base: e.base, workDir: e.ws, env: { OC_TEST_OUT: e.outFile } });
    assert.equal(res.exit, '0');
    const { argv } = parseFake(fs.readFileSync(e.outFile, 'utf8'));
    assert.deepEqual(argv, ['run', '--format', 'json', '--model', 'anthropic/claude#high', '--session', 'ses_abc123', '--auto', '--', 'fix the bug']);
  } finally { e.cleanup(); }
});

test('v43.1: empty model, session and auto flags are omitted', () => {
  const e = fakeOpencodeEnv();
  try {
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'hi' });
    runInTermux(cmd, { base: e.base, workDir: e.ws, env: { OC_TEST_OUT: e.outFile } });
    const { argv } = parseFake(fs.readFileSync(e.outFile, 'utf8'));
    assert.deepEqual(argv, ['run', '--format', 'json', '--', 'hi']);
  } finally { e.cleanup(); }
});

/* ---------- 5. Paths containing spaces and quotes work ---------- */
test('v43.1: workspace paths containing spaces and quotes are used correctly', () => {
  const e = fakeOpencodeEnv();
  try {
    assert.match(e.ws, / /, 'the fixture path must contain a space');
    assert.match(e.ws, /'/, 'the fixture path must contain a single quote');
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, prompt: 'p' });
    const res = runInTermux(cmd, { base: e.base, workDir: e.ws, env: { OC_TEST_OUT: e.outFile } });
    assert.equal(res.exit, '0', 'a quoted path with spaces/quotes must still run');
    const seen = parseFake(fs.readFileSync(e.outFile, 'utf8'));
    assert.equal(seen.cwd, e.ws);
  } finally { e.cleanup(); }
});

/* ---------- 6. No shell injection ---------- */
test('v43.1: prompts and model values cannot inject shell commands', () => {
  const e = fakeOpencodeEnv();
  const pwned = path.join(e.base, 'PWNED');
  const pwned2 = path.join(e.base, 'PWNED2');
  const pwned3 = path.join(e.base, 'PWNED3');
  try {
    const prompt = 'run $(touch ' + pwned + ') `touch ' + pwned2 + '` ; touch ' + pwned3 + ' && echo done';
    const cmd = buildAndroidCommand({ workDir: e.ws, configPath: e.cfg, binaryPath: e.bin, model: "mo'del", prompt });
    runInTermux(cmd, { base: e.base, workDir: e.ws, env: { OC_TEST_OUT: e.outFile } });
    const { argv } = parseFake(fs.readFileSync(e.outFile, 'utf8'));
    assert.equal(argv[argv.length - 1], prompt, 'the prompt must arrive verbatim as one argument');
    assert.ok(!fs.existsSync(pwned) && !fs.existsSync(pwned2) && !fs.existsSync(pwned3), 'no injected command may execute');
  } finally { e.cleanup(); }
});

/* ---------- 7. Streaming and cancellation still work ---------- */
test('v43.1: Android-local streaming (run/read) and cancellation still work', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/storage/emulated/0/proj' },
    runReply: { ok: true, sessionId: 'ses_x', mirrored: false },
    runReadReply: { data: 'partial output', next: 14, exited: true, code: 0 }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  await h.api.runOpenCodeAndroidLocalOnce('hello', { openCodeSessionId: '', title: 't' });
  assert.ok(h.harness.nativeCalls.includes('/opencode/run'), 'run must start on-device');
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/read'), 'streaming must poll /opencode/run/read');
  await h.api.ocLocalCall('/opencode/run/cancel', { sessionId: 'ses_x' });
  assert.ok(h.harness.nativeCalls.includes('/opencode/run/cancel'), 'cancellation must reach the native adapter');
  assert.equal(remoteCalls.filter(u => /\/opencode\/(run|run\/read|run\/cancel)/.test(u)).length, 0, 'no run/read/cancel may reach the remote server');
  // The desktop runner keeps its cancellation wiring.
  assert.match(SERVER, /res\.on\('close', \(\) => \{ if \(!done && child\) killTree\(child, true\); \}\)/);
  assert.match(SERVER, /req\.on\('aborted', \(\) => \{ if \(!done && child\) killTree\(child, true\); \}\)/);
});

/* ---------- 8. No remote or Zen fallback for Android-local execution ---------- */
test('v43.1: an Android workspace never falls back to remote OpenCode or Zen', async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'device', root: '/storage/emulated/0/proj', posixPath: '/storage/emulated/0/proj' },
    runReply: { ok: true, sessionId: 'ses_y', mirrored: false },
    runReadReply: { data: '', next: 0, exited: true, code: 0 }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  // Select OpenCode through the REAL tap path, then send a message.
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true, 'OpenCode must be selectable for this device');
  try { await h.api.runOpenCodeChat('do it', 'do it', ''); } catch (e) { /* DOM/stream gaps are fine */ }
  assert.ok(h.harness.nativeCalls.includes('/opencode/run'), 'Android-local execution must use the native adapter');
  assert.equal(remoteCalls.filter(u => u.endsWith('/opencode/run')).length, 0, 'must not use the remote agent-server');
  assert.notEqual(h.api.currentRoute(), 'zai', 'must not silently switch to Zen');
  assert.equal(h.api.S.openCodeCLI, true, 'the OpenCode selection must be preserved');
});
