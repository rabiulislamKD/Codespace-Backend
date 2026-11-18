'use strict';
/* Regression tests for OpenCode routing against Android folder workspaces.
   Loads the REAL helper/entry-point functions from 19-activitybar-composer.js into a vm
   sandbox (only browser/native globals are stubbed) and executes them — these tests assert on
   real behavior (which branches run), not on source-code string presence. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src-js', '19-activitybar-composer.js');
const src = fs.readFileSync(SRC, 'utf8');

/* Extract a top-level `function name(...){...}` or `async function name(...){...}` by braces. */
function extract(name) {
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

const HELPERS = ['opencodeRuntimeAvailable', 'refreshOpenCodeStatus', 'awaitOpenCodeStatusIfInFlight', 'selectOpenCodeLocal', 'isAndroidFolderWorkspace', 'refreshWorkspaceInfo', 'declineOpenCodeForAndroidFolder', 'redirectToOpenCodeZen', 'toggleOpenCode', 'runOpenCodeChat'];

function makeEnv(opts) {
  opts = opts || {};
  const state = {
    notes: [], errors: [], calls: [], openedViews: [], pickedCards: [],
    B: opts.B || { ok: true, info: { platform: 'linux', root: '/srv/project' } },
    S: Object.assign({ openCodeCLI: false, chatZaiCLI: false, providers: [], updated: 0 }, opts.S || {}),
    L: { bridgeUrl: opts.bridgeUrl || 'https://sandbox.example', bridgeToken: 'tok' }
  };
  const native = opts.nativeHasLocalWorkspace;
  const context = {
    console,
    B: state.B, S: state.S, L: state.L,
    lastOpenCodeStatus: opts.lastOpenCodeStatus || null,
    opencodeStatusInFlight: null,
    activeWorkspaceState: opts.activeWorkspaceState || null,
    window: {
      CodeSpaceNative: (typeof native === 'function')
        ? { hasLocalWorkspace: native }
        : (native === undefined ? {} : { hasLocalWorkspace: () => native })
    },
    addNote: m => state.notes.push(String(m)),
    addErr: m => state.errors.push(String(m)),
    bcall: async (route) => {
      state.calls.push(route);
      if (route === '/info') return opts.infoReply !== undefined ? opts.infoReply : { platform: 'linux', root: '/srv/project' };
      if (route === '/opencode/status') return opts.statusReply !== undefined ? opts.statusReply : { installed: true, canInstall: false, workspace: '/srv/project', version: '1.19.6' };
      return {};
    },
    saveLocal() {}, syncMode() {}, updateMeters() {}, pushConfig() {}, syncOpenCodeUI() {},
    ocLog() {},
    currentRoute: () => (state.S.openCodeCLI ? 'opencode' : state.S.chatZaiCLI ? 'zai' : 'codespace'),
    openView: v => state.openedViews.push(v), showView: v => state.openedViews.push(v),
    pickCard: c => state.pickedCards.push(c),
    confirm: () => true,
    $: () => ({ disabled: false, title: '', querySelector: () => null }),
    setTimeout, clearTimeout
  };
  vm.createContext(context);
  const code = HELPERS.map(extract).join('\n') + '\n;this.fn = { ' + HELPERS.join(', ') + ' };';
  vm.runInContext(code, context);
  return { context, state, fn: context.fn };
}

test('isAndroidFolderWorkspace uses the authoritative native signal first', async () => {
  // Native says yes even though B.info is stale (linux) -> must still detect Android folder.
  const e = makeEnv({ B: { ok: true, info: { platform: 'linux', root: '/stale' } }, nativeHasLocalWorkspace: () => true });
  assert.equal(e.fn.isAndroidFolderWorkspace(), true);
});
test('isAndroidFolderWorkspace falls back to cached /info indicators safely', async () => {
  const e = makeEnv({ nativeHasLocalWorkspace: undefined, B: { ok: true, info: { platform: 'android', root: 'saf://workspace' } } });
  assert.equal(e.fn.isAndroidFolderWorkspace(), true);
  const e2 = makeEnv({ nativeHasLocalWorkspace: undefined, B: { ok: true, info: { fileProvider: 'android-native-bridge' } } });
  assert.equal(e2.fn.isAndroidFolderWorkspace(), true);
  const e3 = makeEnv({ nativeHasLocalWorkspace: undefined, B: { ok: false, info: null } });
  assert.equal(e3.fn.isAndroidFolderWorkspace(), false); // missing fields handled safely
});

test('toggleOpenCode queries REAL local status for an Android folder and shows setup error when unavailable (no Zen redirect)', async () => {
  const e = makeEnv({
    B: { ok: true, info: { root: null } },
    nativeHasLocalWorkspace: () => true,
    infoReply: { platform: 'android', root: 'saf://workspace', fileProvider: 'android-native-bridge' },
    statusReply: { installed: false, canInstall: true, runtimeKind: 'NONE', termuxInstalled: false, message: 'No usable OpenCode CLI runtime found.' }
  });
  await e.fn.toggleOpenCode();
  assert.ok(e.state.calls.includes('/info'), 'workspace info must be refreshed first');
  assert.ok(e.state.calls.includes('/opencode/status'), 'must query real local OpenCode status');
  assert.ok(!e.state.pickedCards.includes('opencodezen'), 'must NOT silently switch to OpenCode Zen');
  assert.ok(e.state.errors.some(m => /unavailable|not installed|not executable|setup|recheck/i.test(m)), 'must show a clear setup error');
  assert.equal(e.state.S.openCodeCLI, false, 'CLI mode must stay off when CLI unavailable');
});

test('toggleOpenCode enables REAL local CLI for an Android folder when the probe succeeds', async () => {
  const e = makeEnv({
    B: { ok: true, info: { root: null } },
    nativeHasLocalWorkspace: () => true,
    infoReply: { platform: 'android', root: 'saf://workspace', fileProvider: 'android-native-bridge' },
    statusReply: { installed: true, canInstall: false, runtimeKind: 'TERMUX', version: '1.19.6', message: 'available' }
  });
  await e.fn.toggleOpenCode();
  assert.equal(e.state.S.openCodeCLI, true, 'real local CLI must be enabled');
  assert.ok(!e.state.pickedCards.includes('opencodezen'), 'must not redirect to Zen');
  assert.ok(e.state.notes.some(m => /Android Local/.test(m)));
});

test('toggleOpenCode toggling OFF a stale OpenCode CLI mode on an Android folder clears it', async () => {
  // When OpenCode CLI mode is already on (e.g. persisted from an earlier desktop session),
  // tapping the route toggle disables it. This must work even with a stale Android workspace.
  const e = makeEnv({
    B: { ok: true, info: { root: null } },
    S: { openCodeCLI: true },
    nativeHasLocalWorkspace: () => true,
    infoReply: { platform: 'android', root: 'saf://workspace' }
  });
  await e.fn.toggleOpenCode();
  assert.equal(e.state.S.openCodeCLI, false);
});

test('toggleOpenCode continues normal validation for a non-Android workspace', async () => {
  const e = makeEnv({ nativeHasLocalWorkspace: () => false, B: { ok: true, info: { platform: 'linux', root: '/srv/project' } } });
  await e.fn.toggleOpenCode();
  assert.ok(e.state.calls.includes('/opencode/status'), 'non-Android path queries remote status');
  assert.equal(e.state.S.openCodeCLI, true, 'non-Android path can enable OpenCode CLI');
  assert.equal(e.state.pickedCards.length, 0);
});

test('runOpenCodeChat refuses Android folder when real status unavailable, no Zen redirect', async () => {
  const e = makeEnv({ S: { openCodeCLI: true }, nativeHasLocalWorkspace: () => true, infoReply: { platform: 'android', root: 'saf://workspace' }, statusReply: { installed: false, message: 'not installed' } });
  // lastOpenCodeStatus starts null in a fresh env -> must report setup error
  await e.fn.runOpenCodeChat('hello');
  assert.equal(e.state.S.openCodeCLI, false);
  assert.ok(e.state.errors.some(m => /not installed|not executable|setup|Settings/i.test(m)));
  assert.ok(!e.state.pickedCards.includes('opencodezen'), 'must not silently switch provider');
});
