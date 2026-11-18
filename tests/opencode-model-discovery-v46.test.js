'use strict';
/* v46 regression tests — DYNAMIC OpenCode model discovery + Free/Paid grouping.
 *
 * The model list must come from the real installed CLI (native `/opencode/models`, which runs
 * `opencode models`), not a hardcoded list. Free = the model ID ends with "-free" (case-insensitive),
 * applied to the model ID itself — never to a provider label. These tests drive the REAL
 * fillOpenCodeQuick()/modelPickerItems() through the real DOM harness and assert the exact model id
 * that is sent to the native `/opencode/run`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function androidComposer(opts = {}) {
  return buildComposer(Object.assign({
    statusMode: 'OK', bridgeUrl: 'codespace-native://local', fetchImpl: async () => { throw new Error('network disabled'); },
    nativeHasLocalWorkspace: true,
    nativeWorkspaceState: { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/storage/emulated/0/proj' }
  }, opts));
}
/* Build the harness and let any pending provider refresh settle, so a late fillQuick() cannot
 * interleave with the OpenCode model assertions. */
async function setup(opts = {}) { const h = androidComposer(opts); await sleep(60); return h; }
function ready(h) { h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' }); }
function errors() { return getEl('chat').children.filter(c => c.classList && c.classList.contains('errmsg')).map(c => c.textContent); }
function notes() { return getEl('chat').children.filter(c => c.classList && c.classList.contains('note')).map(c => c.textContent); }
function selectGroups() {
  const q = getEl('provQuick');
  return q.children.map(g => ({ label: g.label || '', values: (g.children || []).map(o => o.value) }));
}
function selectValues() {
  const q = getEl('provQuick');
  const out = [];
  for (const c of q.children) {
    if (String(c.tagName).toUpperCase() === 'OPTION') out.push(c.value);
    else for (const o of (c.children || [])) out.push(o.value);
  }
  return out;
}
function reply(models, configured) {
  return { ok: true, models, free: [], paid: [], configured: configured || (models[0] || ''), default: configured || (models[0] || '') };
}

test('v46 model: the -free suffix on the model ID decides Free (case-insensitive); no suffix is Paid', () => {
  const h = androidComposer();
  assert.equal(h.api.isFreeOpenCodeModel('cline/dots-3-note-free'), true);
  assert.equal(h.api.isFreeOpenCodeModel('cline/flint-v1.0-Free'), true);
  assert.equal(h.api.isFreeOpenCodeModel('opencode/model-FREE'), true, 'the -free suffix is case-insensitive');
  assert.equal(h.api.isFreeOpenCodeModel('opencode/big-pickle'), false);
  assert.equal(h.api.isFreeOpenCodeModel('fallback/auto'), false);
  assert.equal(h.api.isFreeOpenCodeModel('free-provider/paid-model'), false, 'a provider named free must not make the model Free');
  assert.equal(h.api.isFreeOpenCodeModel('paid-provider/model-free'), true, 'the id suffix decides, not the provider');
});

test('v46 model: fillOpenCodeQuick groups the discovered list into Free/Paid optgroups by model ID', async () => {
  const h = await setup({ modelsReply: reply(['cline/dots-3-note-free', 'opencode/big-pickle', 'cline/flint-v1.0-Free', 'gizmo/aion-2.0'], 'opencode/big-pickle') });
  await h.api.fillOpenCodeQuick();
  const gs = selectGroups();
  const free = gs.find(g => /^Free models/.test(g.label));
  const paid = gs.find(g => /^Paid models/.test(g.label));
  assert.ok(free, 'a Free models group must exist');
  assert.ok(paid, 'a Paid models group must exist');
  assert.deepEqual(free.values.slice().sort(), ['opencode::cline/dots-3-note-free', 'opencode::cline/flint-v1.0-Free'].sort());
  assert.deepEqual(paid.values.slice().sort(), ['opencode::gizmo/aion-2.0', 'opencode::opencode/big-pickle'].sort());
  assert.equal(h.api.activeOpenCodeModel(), 'opencode/big-pickle', 'the configured model stays selected');
});

test('v46 model: multiple providers with duplicate display names are all listed by exact provider/model id', async () => {
  const h = await setup({ modelsReply: reply(['cline/claude-sonnet-5.5', 'cline-pass/cline-pass/deepseek-v4-pro', 'acme/claude-sonnet-5.5'], 'cline/claude-sonnet-5.5') });
  await h.api.fillOpenCodeQuick();
  const all = selectGroups().flatMap(g => g.values);
  assert.ok(all.includes('opencode::cline/claude-sonnet-5.5'));
  assert.ok(all.includes('opencode::acme/claude-sonnet-5.5'), 'same display name, different provider must both be listed');
  assert.ok(all.includes('opencode::cline-pass/cline-pass/deepseek-v4-pro'));
});

test('v46 model: the popup model picker groups OpenCode models Free/Paid too', async () => {
  const h = await setup({ modelsReply: reply(['cline/dots-3-note-free', 'opencode/big-pickle'], 'opencode/big-pickle') });
  await h.api.fillOpenCodeQuick();
  const items = h.api.modelPickerItems();
  assert.equal(items.free.map(i => i.id).join('|'), 'cline/dots-3-note-free');
  assert.equal(items.paid.map(i => i.id).join('|'), 'opencode/big-pickle');
});

test('v46 model: an empty discovered list reports clearly and does not crash the selector', async () => {
  const h = await setup({ modelsReply: { ok: true, models: [], free: [], paid: [], configured: '', default: '' } });
  await h.api.fillOpenCodeQuick();
  assert.ok(notes().some(t => /no models/i.test(t)), 'an empty list must be reported');
});

test('v46 model: a discovery failure keeps the previously loaded options and reports the error', async () => {
  const shared = reply(['opencode/big-pickle', 'cline/dots-3-note-free'], 'opencode/big-pickle');
  const h = await setup({ modelsReply: shared });
  await h.api.fillOpenCodeQuick();
  const before = selectValues().length;
  assert.ok(before > 0);
  // Simulate the CLI/provider failing on refresh.
  shared.ok = false; shared.error = 'OpenCode CLI is not installed'; shared.models = [];
  await h.api.fillOpenCodeQuick(true);
  assert.ok(notes().some(t => /could not be loaded/i.test(t)), 'the refresh failure must be reported');
  assert.equal(selectValues().length, before, 'the previously loaded models must be kept');
});

test('v46 model: a selected model that disappears is reported and NOT silently replaced', async () => {
  const shared = reply(['opencode/big-pickle', 'cline/dots-3-note-free'], 'opencode/big-pickle');
  const h = await setup({ modelsReply: shared });
  await h.api.fillOpenCodeQuick();
  const q = getEl('provQuick');
  q.value = 'opencode::cline/dots-3-note-free'; // the user picks a model
  shared.models = ['opencode/big-pickle'];        // a refresh no longer returns it
  await h.api.fillOpenCodeQuick(true);
  assert.equal(q.value, 'opencode::cline/dots-3-note-free', 'the selection must not silently switch');
  assert.ok(selectValues().includes('opencode::cline/dots-3-note-free'), 'the stale id is shown as unavailable');
  assert.ok(errors().some(t => /no longer available/i.test(t)), 'the user is told to pick again');
});

test('v46 model: the EXACT selected model id is passed to the native run', async () => {
  const h = await setup({
    modelsReply: reply(['cline-pass/cline-pass/deepseek-v4-pro', 'cline/dots-3-note-free'], 'cline/dots-3-note-free'),
    runReply: { ok: true, sessionId: 'ses_m', state: 'STARTING', timeoutMs: 1800000 },
    runReadReply: { data: '', next: 0, exited: true, code: 0, state: 'COMPLETED' }
  });
  ready(h);
  await h.api.fillOpenCodeQuick();
  getEl('provQuick').value = 'opencode::cline-pass/cline-pass/deepseek-v4-pro';
  await h.api.runOpenCodeAndroidLocalOnce('hi', { openCodeSessionId: '', title: 't' });
  const sent = h.harness.nativePayloads.find(p => p.pathname === '/opencode/run');
  assert.ok(sent, 'a native run must be dispatched');
  assert.equal(sent.payload.model, 'cline-pass/cline-pass/deepseek-v4-pro', 'the exact provider/model id must be sent, not a label');
});

test('v46 model: refresh requests the native endpoint with refresh=true and restores the persisted selection', async () => {
  const shared = reply(['opencode/big-pickle', 'cline/dots-3-note-free'], 'cline/dots-3-note-free');
  const h = await setup({ modelsReply: shared });
  await h.api.fillOpenCodeQuick();
  assert.equal(h.api.activeOpenCodeModel(), 'cline/dots-3-note-free');
  await h.api.fillOpenCodeQuick(true);
  const refreshCalls = h.harness.nativePayloads.filter(p => p.pathname === '/opencode/models' && p.payload && p.payload.refresh);
  assert.ok(refreshCalls.length >= 1, 'a forced refresh must ask the native layer to re-run discovery');
  assert.equal(h.api.activeOpenCodeModel(), 'cline/dots-3-note-free', 'the selection survives a refresh');
});
