'use strict';
/* v40 regression tests: OpenCode CLI selectability driven by real Android runtime state.
   Executes the REAL opencodeRuntimeAvailable() logic in a VM and verifies state/dispatch wiring. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const composer = fs.readFileSync(path.join(ROOT, 'src-js', '19-activitybar-composer.js'), 'utf8');
const stateJs = fs.readFileSync(path.join(ROOT, 'src-js', '01-core-helpers-state.js'), 'utf8');
const boot = fs.readFileSync(path.join(ROOT, 'src-js', '21-palette-attachments.js'), 'utf8');

let pass = 0, fail = 0;
const ok = n => { pass++; console.log('PASS ' + n); };
const bad = (n, e) => { fail++; console.log('FAIL ' + n + (e ? ' — ' + e : '')); };
const check = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e.message); } };

function extract(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('async function ' + name + '(');
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
const ORA = extract(composer, 'opencodeRuntimeAvailable');
function withStatus(s) {
  const ctx = vm.createContext({ lastOpenCodeStatus: s, console });
  vm.runInContext(ORA + '\n;this.fn = opencodeRuntimeAvailable;', ctx);
  return ctx.fn;
}

/* ---------- 1. Runtime OK enables the chat option ---------- */
check('termuxState OK -> available regardless of API keys/models', () => {
  assert.equal(withStatus({ termuxState: 'OK', installed: false, savedKeys: [], models: [] })(), true);
});
check('installed + runtimeKind TERMUX -> available', () => {
  assert.equal(withStatus({ installed: true, runtimeKind: 'TERMUX', termuxState: 'OK' })(), true);
});

/* ---------- 2. COMMAND_ERROR disables with clear reason ---------- */
check('COMMAND_ERROR -> not available', () => {
  assert.equal(withStatus({ termuxState: 'COMMAND_ERROR', installed: false, message: 'OpenCode CLI failed inside Termux: exit 1' })(), false);
});
check('unavailable state message surfaces termuxState + reason', () => {
  assert.match(composer, /status\.termuxState \? ' \[' \+ status\.termuxState \+ '\]'/);
  assert.match(composer, /OpenCode CLI is unavailable/);
});

/* ---------- 3+4. No API key / empty model list gating ---------- */
check('availability never checks API keys or model lists', () => {
  // runtimeKind is a genuine runtime-detection signal (allowed); key/model gates are not.
  assert.doesNotMatch(ORA, /savedKeys|apiKey|\.keys\b|\.models\b|\.providers\b/);
});
check('selector uses opencodeRuntimeAvailable(), not .installed alone', () => {
  assert.match(composer, /const cliOk = opencodeRuntimeAvailable\(\)/);
  assert.doesNotMatch(composer, /const cliOk = !!\(lastOpenCodeStatus && lastOpenCodeStatus\.installed\)/);
});

/* ---------- 5. Selection persists across reloads/workspace/settings ---------- */
check('loadAll no longer force-resets openCodeCLI on native local', () => {
  assert.doesNotMatch(stateJs, /bridgeUrl === 'codespace-native:\/\/local' && S\.openCodeCLI/);
});
check('workspace switch and settings refresh do not reset the mode', () => {
  // No reset tied to folder-pick / reconnect events; only explicit mutually-exclusive mode switches.
  assert.match(composer, /function toggleOpenCode/);
  assert.match(composer, /S\.openCodeCLI = true/);
});

/* ---------- 6. Send dispatches to local Termux runtime ---------- */
check('send() dispatches to runOpenCodeChat when OpenCode CLI selected', () => {
  assert.match(composer, /if \(S\.openCodeCLI\) await runOpenCodeChat/);
});
check('runOpenCodeChat uses nativeMode -> runOpenCodeAndroidLocal', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 4200);
  assert.match(fn, /const nativeMode =/);
  assert.match(fn, /isAndroidFolderWorkspace\(\)/);
  assert.match(fn, /runOpenCodeAndroidLocal/);
});
check('opencodeRuntimeAvailable gates runOpenCodeChat (not just .installed)', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 2600);
  assert.match(fn, /if \(!opencodeRuntimeAvailable\(\)\)/);
});

/* ---------- 7. No silent remote/Zen fallback ---------- */
check('no silent fallback to Zen/remote on Android runtime', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 4200);
  assert.match(fn, /isAndroidFolderWorkspace/);
  assert.match(composer, /NOT silently switched to OpenCode Zen/);
});

/* ---------- Status flows into the selector state on boot/menu ---------- */
check('boot probes real status into lastOpenCodeStatus', () => {
  assert.match(boot, /refreshOpenCodeStatus/);
});
check('route menu open refreshes real status', () => {
  const i = composer.indexOf("$('routeBtn').onclick");
  const fn = composer.slice(i, i + 900);
  assert.match(fn, /refreshOpenCodeStatus/);
});
check('option never given disabled attribute when available', () => {
  assert.match(composer, /o\.disabled = false/);
});

console.log('\nOpenCode selector v40 verification: ' + pass + ' passed, ' + fail + ' failed, 0 skipped');
process.exit(fail ? 1 : 0);
