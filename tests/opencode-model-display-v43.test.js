'use strict';
/* v43.1 regression tests — the OpenCode model chosen in the composer must appear as the selected
 * model in the chatbox.
 *
 * Reported issue: after selecting a model while OpenCode CLI mode is active, the composer still
 * showed the CodeSpace provider that merely remained active underneath, so the OpenCode selection
 * never appeared as the selected model. Root cause: syncModelBtn() always rendered S.activeId's
 * provider model and ignored the `opencode::<model>` value held by the real selector.
 *
 * These tests load the REAL src-js fragments and drive the REAL selection path (route tap ->
 * fillOpenCodeQuick -> provQuick change -> syncModelBtn), asserting on the produced composer label
 * and the model actually sent to the native OpenCode run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function enterOpenCode(opts = {}) {
  const h = buildComposer({ statusMode: 'OK', nativeHasLocalWorkspace: true, ...opts });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(80);
  return h;
}

/* Select a model exactly as the popup menu does: set the hidden select then fire its change. */
function choose(h, model) {
  const q = getEl('provQuick');
  q.value = 'opencode::' + model;
  q.onchange({ target: q });
}

test('v43.1: the composer shows the selected OpenCode model, not the CodeSpace provider', async () => {
  const h = await enterOpenCode();
  assert.equal(h.api.currentRoute(), 'opencode');
  assert.equal(h.api.activeOpenCodeModel(), 'opencode/big-pickle', 'the OpenCode model must be the active model');
  assert.equal(h.modelLabel(), 'opencode/big-pickle', 'the chatbox must show the OpenCode model');
});

test('v43.1: choosing another OpenCode model updates the composer label immediately', async () => {
  const h = await enterOpenCode();
  choose(h, 'anthropic/claude-sonnet-4');
  await sleep(20);
  assert.equal(h.api.activeOpenCodeModel(), 'anthropic/claude-sonnet-4');
  assert.equal(h.modelLabel(), 'anthropic/claude-sonnet-4');
});

test('v43.1: the chosen OpenCode model is passed to the native run', async () => {
  const h = await enterOpenCode({
    runReply: { ok: true, sessionId: 'ses_m', mirrored: false },
    runReadReply: { data: '', next: 0, exited: true, code: 0 }
  });
  choose(h, 'anthropic/claude-sonnet-4');
  await h.api.runOpenCodeAndroidLocalOnce('hello', { openCodeSessionId: '', title: 't' });
  const runCall = h.harness.nativePayloads.find(p => p.pathname === '/opencode/run');
  assert.ok(runCall, 'the native /opencode/run must be called');
  assert.equal(runCall.payload.model, 'anthropic/claude-sonnet-4', 'the selected model must reach the CLI');
});

test('v43.1: leaving OpenCode mode restores the CodeSpace provider label', async () => {
  const h = await enterOpenCode();
  assert.equal(h.modelLabel(), 'opencode/big-pickle');
  h.api.S.openCodeCLI = false;
  h.api.syncOpenCodeUI();
  await sleep(20);
  assert.notEqual(h.modelLabel(), 'opencode/big-pickle', 'the CodeSpace provider label must come back');
  assert.equal(h.api.activeOpenCodeModel(), '', 'no OpenCode model is active outside OpenCode mode');
});

test('v43.1: OpenCode mode publishes only OpenCode models to the picker', async () => {
  const h = await enterOpenCode();
  assert.deepEqual(h.ctx.__opencodeModelIds, ['opencode/big-pickle'], 'only OpenCode models may be offered');
  h.api.S.openCodeCLI = false;
  h.api.syncOpenCodeUI();
  await sleep(20);
  assert.equal(h.ctx.__opencodeModelIds, null, 'the OpenCode-only list must be cleared outside OpenCode mode');
});

test('v43.1: syncModelBtn keeps an explicit OpenCode-mode branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src-js', '07-meters-approvals.js'), 'utf8');
  assert.match(src, /S\.openCodeCLI[\s\S]{0,200}currentOpenCodeModel/, 'syncModelBtn must read the OpenCode selection');
  assert.match(src, /Select OpenCode model/);
});
