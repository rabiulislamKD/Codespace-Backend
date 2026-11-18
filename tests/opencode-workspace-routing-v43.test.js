'use strict';
/* v43 regression tests — Android workspace detection + OpenCode local routing.
 *
 * Reported device failure: with an Android folder selected and OpenCode CLI on, sending a message
 * produced "OpenCode CLI request failed: Open a workspace folder in My Chat Agent first." That
 * string comes from the REMOTE agent-server.js /opencode/run handler (no server-side ROOT).
 *
 * Root cause under test: bcall() never routed the OpenCode EXECUTION endpoints
 * (/opencode/run, /opencode/run/read, /opencode/run/cancel) to the Android native adapter. So even
 * when runOpenCodeChat() correctly chose runOpenCodeAndroidLocal(), its bcall('/opencode/run') went
 * to the remote server. Secondary: workspace detection reached the native /workspace/state and
 * /info only through the hasLocalWorkspace() gate, so a stale/remote /info could hide a selected
 * Android folder.
 *
 * These tests load the REAL src-js fragments and drive the REAL functions (runOpenCodeChat,
 * runOpenCodeAndroidLocal, bcall, refreshWorkspaceInfo, isAndroidFolderWorkspace) — they assert on
 * the execution branch and the actual endpoint reached, not on source-code string presence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const REMOTE = 'https://render.example';

function errorTexts() {
  const chat = getEl('chat');
  return chat.children.filter(c => c.classList && c.classList.contains('errmsg')).map(c => c.textContent);
}

/* A remote-bridge fetch stub that records every URL it is asked for. */
function makeRemoteFetch(remoteCalls) {
  return async (url) => {
    const u = String(url);
    remoteCalls.push(u);
    const json = obj => ({ ok: true, status: 200, json: async () => obj });
    if (u.endsWith('/opencode/run')) {
      return { ok: true, status: 200, json: async () => ({}), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    }
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

/* Drive one real send through the selected OpenCode engine. */
async function sendOnce(h, text = 'do the thing') {
  try { await h.api.runOpenCodeChat(text, text, ''); } catch (e) { /* DOM/stream gaps are fine */ }
}

/* ---------- 1 + 2. Android workspace kinds route to the local Termux runtime ---------- */
for (const kind of ['saf', 'device']) {
  test(`v43: Android ${kind} workspace + Termux OK + remote bridge -> local /opencode/run`, async () => {
    const remoteCalls = [];
    const h = buildComposer({
      statusMode: 'OK',
      bridgeUrl: REMOTE,
      fetchImpl: makeRemoteFetch(remoteCalls),
      nativeHasLocalWorkspace: true,
      nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind, root: kind === 'saf' ? 'saf://workspace' : '/storage/emulated/0/proj', posixPath: '/storage/emulated/0/proj' }
    });
    h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
    assert.equal(h.api.isAndroidFolderWorkspace(), true, `${kind} folder must be detected`);
    await sendOnce(h);
    assert.ok(h.harness.nativeCalls.includes('/opencode/run'), `local ${kind} run must hit the native adapter`);
    assert.ok(!remoteCalls.some(u => u.endsWith('/opencode/run')), `the remote /opencode/run must NOT be used for an Android ${kind} folder`);
  });
}

/* ---------- 3. Remote bridge selected but an Android folder is active -> still local ---------- */
test('v43: remote bridge selected + Android workspace active -> still local OpenCode execution', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://workspace' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  assert.equal(h.api.L.bridgeUrl, REMOTE);
  await sendOnce(h);
  assert.ok(h.harness.nativeCalls.includes('/opencode/run'), 'must run on the device');
  assert.equal(remoteCalls.filter(u => u.endsWith('/opencode/run')).length, 0, 'never the remote agent-server');
});

/* ---------- 4. A stale remote /info cannot override valid native workspace state ---------- */
test('v43: stale remote /info cannot override valid native workspace state', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://workspace' },
    nativeInfo: { platform: 'android', root: 'saf://workspace', fileProvider: 'android-native-bridge' }
  });
  await h.api.refreshWorkspaceInfo();
  assert.equal(h.api.activeWorkspaceStateRef().platform, 'android');
  assert.equal(h.api.isAndroidFolderWorkspace(), true, 'native Android state must win over the remote /info');
  assert.equal(h.api.B.info.platform, 'android', 'B.info must come from the device, not the remote');
  assert.equal(remoteCalls.filter(u => u.endsWith('/info')).length, 0, 'a stale remote /info must not even be consulted while an Android folder is active');
});

/* ---------- 5. Missing/revoked Android folder -> clear error, no remote, no Zen ---------- */
test('v43: revoked Android folder -> clear error and no remote dispatch', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: false, platform: 'android', kind: 'saf', root: 'saf://workspace', permissionOk: false, error: "The selected folder's permission was revoked. Open Folder and select it again." }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  assert.equal(h.api.isAndroidFolderWorkspace(), true, 'a revoked folder is still an Android workspace (must not fall through to remote)');
  await sendOnce(h);
  const errs = errorTexts().join('\n');
  assert.match(errs, /cannot start/i);
  assert.match(errs, /revoked/i);
  assert.equal(remoteCalls.filter(u => u.endsWith('/opencode/run')).length, 0, 'never silently fall back to the remote server');
});

/* ---------- 6. Genuine desktop/remote workspace -> remote OpenCode remains supported ---------- */
test('v43: genuine remote workspace (no native adapter) -> remote /opencode/run', async () => {
  const remoteCalls = [];
  const h = buildComposer({ statusMode: 'OK', bridgeUrl: REMOTE, noNative: true, fetchImpl: makeRemoteFetch(remoteCalls) });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  assert.equal(h.api.isAndroidFolderWorkspace(), false);
  await sendOnce(h);
  assert.ok(remoteCalls.some(u => u.endsWith('/opencode/run')), 'a desktop workspace must still use the remote OpenCode bridge');
  assert.equal(h.harness.nativeCalls.filter(p => p === '/opencode/run').length, 0);
});

/* ---------- 7. run / read / cancel / sync-out share the SAME native adapter ---------- */
test('v43: local run/read/cancel/sync-out all use the native adapter', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls),
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://workspace' },
    runReply: { ok: true, sessionId: 'ses_test', mirrored: true },
    runReadReply: { data: '', next: 0, exited: true, code: 0 }
  });
  // Drive the real runner (mirrored -> exercises sync-out too).
  await h.api.runOpenCodeAndroidLocalOnce('hello', { openCodeSessionId: '', title: 't' });
  // Cancel shares the same adapter.
  await h.api.ocLocalCall('/opencode/run/cancel', { sessionId: 'ses_test' });
  for (const ep of ['/opencode/run', '/opencode/run/read', '/opencode/run/cancel', '/opencode/workspace/sync-out']) {
    assert.ok(h.harness.nativeCalls.includes(ep), 'native adapter must serve ' + ep);
  }
  assert.equal(remoteCalls.filter(u => /\/opencode\/(run|run\/read|run\/cancel|workspace\/sync-out)/.test(u)).length, 0, 'none of the run endpoints may reach the remote server');
});

/* ---------- 8. No Android-workspace task reaches the remote /opencode/run ---------- */
test('v43: bcall routes /opencode/run to native for an Android folder and to remote otherwise', async () => {
  const remoteCalls = [];
  const android = buildComposer({
    bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls), nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'device', root: '/storage/emulated/0/proj' }
  });
  await android.api.refreshWorkspaceInfo();
  await android.api.bcall('/opencode/run', {});
  assert.ok(android.harness.nativeCalls.includes('/opencode/run'), 'Android folder -> native adapter');
  assert.equal(remoteCalls.filter(u => u.endsWith('/opencode/run')).length, 0);

  const desktop = buildComposer({ bridgeUrl: REMOTE, noNative: true, fetchImpl: makeRemoteFetch(remoteCalls) });
  await desktop.api.bcall('/opencode/run', {});
  assert.ok(remoteCalls.some(u => u.endsWith('/opencode/run')), 'no Android folder -> remote bridge');
});

/* ---------- Diagnostics ---------- */
test('v43: workspace diagnostics use the [OPENCODE_WORKSPACE_V43] prefix and reach the device log', async () => {
  const remoteCalls = [];
  const h = buildComposer({
    statusMode: 'OK', bridgeUrl: REMOTE, fetchImpl: makeRemoteFetch(remoteCalls), nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://workspace' }
  });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  await sendOnce(h);
  assert.ok(h.harness.nativeCalls.includes('/diag/log'), 'workspace diagnostics must be written to the on-device diagnostics file');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src-js', '19-activitybar-composer.js'), 'utf8');
  assert.match(src, /\[OPENCODE_WORKSPACE_V43\]/);
  for (const marker of ['refreshWorkspaceInfo', 'runOpenCodeChat:route', 'endpoint', 'nativeMode', 'isAndroidFolderWorkspace', 'bridgeUrl', 'workspaceState']) {
    assert.ok(src.includes(marker), 'missing v43 diagnostic field: ' + marker);
  }
});
