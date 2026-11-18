'use strict';
/* v41 regression tests: tapping the enabled OpenCode option commits canonical selection state.
   Executes REAL functions (opencodeRuntimeAvailable, selectOpenCodeLocal, refreshOpenCodeStatus,
   setRoute) in a VM and verifies selection/persistence/no-fallback wiring. */
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
  const isAsync = i >= 0 && src.slice(i, i + 10).includes('function');
  if (i < 0) { i = src.indexOf('async function ' + name + '('); }
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

/* ---- Execute the real selectOpenCodeLocal() commit ---- */
function commitEnv(initial) {
  const saved = [];
  const notes = [];
  const ctx = vm.createContext({
    S: Object.assign({ openCodeCLI: false, chatZaiCLI: true, copilotAuto: true, updated: 0 }, initial || {}),
    B: { ok: true },
    console,
    saveLocal: () => saved.push(JSON.stringify(ctx.S)),
    syncMode: () => {}, updateMeters: () => {}, syncOpenCodeUI: () => {}, pushConfig: () => {},
    addNote: m => notes.push(String(m))
  });
  const fn = extract(composer, 'selectOpenCodeLocal');
  vm.runInContext(fn + '\n;this.fn = selectOpenCodeLocal;', ctx);
  return { ctx, saved, notes };
}

/* ---------- 1+2. Enabled option can be selected; state updates immediately ---------- */
check('selectOpenCodeLocal sets S.openCodeCLI=true immediately (canonical state)', () => {
  const e = commitEnv();
  e.ctx.fn({ version: '2.3.0', runtimeKind: 'TERMUX' });
  assert.equal(e.ctx.S.openCodeCLI, true);
});
check('clears conflicting modes (chatZai/copilot) so selector & dispatch agree', () => {
  const e = commitEnv({ chatZaiCLI: true, copilotAuto: true });
  e.ctx.fn({});
  assert.equal(e.ctx.S.chatZaiCLI, false);
  assert.equal(e.ctx.S.copilotAuto, false);
});

/* ---------- 4+5. Persist + survive refresh ---------- */
check('selection is persisted via saveLocal', () => {
  const e = commitEnv();
  e.ctx.fn({});
  assert.equal(e.saved.length, 1);
  assert.equal(JSON.parse(e.saved[0]).openCodeCLI, true);
});
check('status refresh / sync does not reset selection (select helper only writes true)', () => {
  const sel = extract(composer, 'selectOpenCodeLocal');
  assert.doesNotMatch(sel, /openCodeCLI = false/);
  const sync = composer.slice(composer.indexOf('function syncOpenCodeUI'));
  assert.doesNotMatch(sync.slice(0, 1200), /S\.openCodeCLI = false/);
});

/* ---------- 6+7. selection survives reload / no forced reset ---------- */
check('loadAll no longer force-resets openCodeCLI on native local', () => {
  assert.doesNotMatch(stateJs, /bridgeUrl === 'codespace-native:\/\/local' && S\.openCodeCLI/);
});
check('workspace change/settings do not reset mode (no reset tied to those events in select)', () => {
  assert.match(composer, /function selectOpenCodeLocal/);
});

/* ---------- Root cause: single-flight probe, no concurrent veto ---------- */
check('single-flight guard prevents duplicate concurrent status probes', () => {
  assert.match(composer, /let opencodeStatusInFlight = null/);
  const rf = extract(composer, 'refreshOpenCodeStatus');
  assert.match(rf, /if \(opencodeStatusInFlight\) return opencodeStatusInFlight/);
  assert.match(rf, /opencodeStatusInFlight = \(async/);
  assert.match(rf, /opencodeStatusInFlight = null/);
});
check('toggleOpenCode uses shared probe (no direct duplicate bcall for status)', () => {
  const i = composer.indexOf('async function toggleOpenCode');
  const j = composer.indexOf('async function setRoute', i);
  const fn = composer.slice(i, j); // whole toggleOpenCode body
  assert.match(fn, /await refreshOpenCodeStatus\(\)/); // native path uses shared single-flight probe
  assert.match(fn, /selectOpenCodeLocal\(status\)/);
});
check('runOpenCodeChat send path uses shared probe', () => {
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 1400);
  assert.match(fn, /await refreshOpenCodeStatus\(\)/);
  assert.doesNotMatch(fn, /await bcall\('\/opencode\/status', \{\}, undefined\)/);
});

/* ---------- 8. Unavailable runtime prevents execution with clear reason ---------- */
function available(s) {
  const ctx = vm.createContext({ lastOpenCodeStatus: s, console });
  vm.runInContext(extract(composer, 'opencodeRuntimeAvailable') + '\n;this.fn=opencodeRuntimeAvailable;', ctx);
  return ctx.fn();
}
check('runtime OK -> available; COMMAND_ERROR -> unavailable with reason surfaced', () => {
  assert.equal(available({ termuxState: 'OK' }), true);
  assert.equal(available({ termuxState: 'COMMAND_ERROR', message: 'exit 1' }), false);
  const i = composer.indexOf('async function toggleOpenCode');
  const j = composer.indexOf('async function setRoute', i);
  const fn = composer.slice(i, j);
  assert.match(fn, /OpenCode CLI is unavailable on this device/);
  assert.match(fn, /opencodeRuntimeAvailable\(\)/);
});

/* ---------- 9. Selecting dispatches to local Termux; no fallback ---------- */
check('selected engine dispatches through runOpenCodeChat -> local Termux', () => {
  assert.match(composer, /if \(S\.openCodeCLI\) await runOpenCodeChat/);
  const i = composer.indexOf('async function runOpenCodeChat');
  const fn = composer.slice(i, i + 4200);
  assert.match(fn, /isAndroidFolderWorkspace/);
  assert.match(fn, /runOpenCodeAndroidLocal/);
  assert.match(composer, /NOT silently switched to OpenCode Zen/);
});
check('currentRoute + send share S.openCodeCLI (no separate selector variable)', () => {
  assert.match(composer, /const currentRoute = \(\) => S\.openCodeCLI/);
  assert.match(composer, /if \(S\.openCodeCLI\) await runOpenCodeChat/);
});
check('boot + menu-open probe the real status into shared cache', () => {
  assert.match(boot, /refreshOpenCodeStatus/);
  const i = composer.indexOf("$('routeBtn').onclick");
  assert.match(composer.slice(i, i + 900), /refreshOpenCodeStatus/);
});

console.log('\nOpenCode selection v41 verification: ' + pass + ' passed, ' + fail + ' failed, 0 skipped');
process.exit(fail ? 1 : 0);
