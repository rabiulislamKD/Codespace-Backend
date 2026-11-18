'use strict';
/* v42 regression tests — the chat-engine SELECTION bug.
 *
 * These tests drive the REAL event path (routeBtn click -> menu -> pointerdown+click on the real
 * [data-route="opencode"] item -> setRoute -> toggleOpenCode -> selectOpenCodeLocal) by loading the
 * actual src-js fragments into a bubbling DOM. They do NOT test selectOpenCodeLocal() in isolation.
 *
 * Root cause under test: the tap launched a SECOND /opencode/status Termux probe. If that probe
 * transiently failed it overwrote the valid cached OK status and opencodeRuntimeAvailable() vetoed
 * the selection, leaving CodeSpace selected even though the menu showed the CLI as ready.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComposer, getEl } = require('./helpers/composer-dom.cjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function errorTexts() {
  const chat = getEl('chat');
  return chat.children.filter(c => c.classList && c.classList.contains('errmsg')).map(c => c.textContent);
}
function noteTexts() {
  const chat = getEl('chat');
  return chat.children.filter(c => c.classList && c.classList.contains('note')).map(c => c.textContent);
}

test('v42: tapping the enabled OpenCode item reaches the handler and selects OpenCode', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  assert.equal(h.api.S.openCodeCLI, false);
  h.openMenu();
  await sleep(40);            // let the menu-open probe resolve
  h.tapOpenCode();
  await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true, 'canonical state must become OpenCode');
  assert.equal(h.state().route, 'opencode');
});

test('v42: selected state updates immediately (state, button route, label, aria-checked)', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  const s = h.state();
  assert.equal(s.openCodeCLI, true);
  assert.equal(s.chatZaiCLI, false, 'conflicting Chat Z.ai flag cleared');
  assert.equal(s.btnRoute, 'opencode', 'route button reflects OpenCode');
  assert.equal(s.label, 'OpenCode', 'visible engine label changed from CodeSpace to OpenCode');
  assert.equal(s.ariaOpenCode, 'true', 'menu item marked selected');
});

test('v42: selection is persisted with the existing mechanism (agent3.state)', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.persisted().openCodeCLI, true, 'saveLocal must persist openCodeCLI=true');
});

test('v42: reopening the selector still shows OpenCode selected', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  // close + reopen
  h.openMenu(); await sleep(10); h.openMenu(); await sleep(10);
  assert.equal(h.state().ariaOpenCode, 'true');
  assert.equal(h.state().label, 'OpenCode');
});

test('v42: reloading the app restores OpenCode from persistence', async () => {
  const h1 = buildComposer({ statusMode: 'OK' });
  h1.openMenu(); await sleep(40);
  h1.tapOpenCode(); await sleep(60);
  const saved = h1.persisted();
  assert.equal(saved.openCodeCLI, true);

  // Simulate a WebView reload: fresh harness seeded with the persisted state.
  const h2 = buildComposer({ statusMode: 'OK', seedState: saved });
  await sleep(10);
  assert.equal(h2.api.S.openCodeCLI, true, 'restored selection');
  assert.equal(h2.state().route, 'opencode');
  assert.equal(h2.state().label, 'OpenCode');
});

test('v42: status refresh does NOT reset the selection', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true);
  // A refresh that returns a transient failure must not clear the user's selection.
  h.harness.statusMode = 'COMMAND_ERROR';
  await h.api.refreshOpenCodeStatus();
  assert.equal(h.api.S.openCodeCLI, true, 'selection survives a status refresh');
  assert.equal(h.state().route, 'opencode');
});

test('v42: a cached OK status selects immediately without launching any probe', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.api.setStatus({ termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' });
  const before = h.harness.statusCalls;
  h.tapOpenCode(); await sleep(40);
  assert.equal(h.api.S.openCodeCLI, true, 'selects from the cached authoritative status');
  assert.equal(h.harness.statusCalls, before, 'no Termux probe is launched when a valid status is cached');
});

test('v42: REGRESSION — a flaky second probe no longer vetoes the tap (the reported bug)', async () => {  // Menu-open probe OK, any later probe fails. Before v42 this left CodeSpace selected.
  const h = buildComposer({ statusQueue: [
    { termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0' },
    { termuxState: 'EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE', installed: false, runtimeKind: 'TERMUX', version: null, message: 'no response' }
  ] });
  h.openMenu(); await sleep(50);
  const probesAfterMenu = h.harness.statusCalls;
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true, 'selection must succeed using the cached OK status');
  assert.equal(h.harness.statusCalls, probesAfterMenu, 'the tap must NOT launch a redundant probe');
});

test('v42: unavailable Termux prevents selection and shows a clear reason (no fallback)', async () => {
  const h = buildComposer({ statusMode: 'COMMAND_ERROR' });
  await sleep(10);
  // cold cache: no menu-open probe -> tap must run exactly one real probe and block
  h.tapOpenCode(); await sleep(80);
  assert.equal(h.api.S.openCodeCLI, false, 'must not select when runtime is unavailable');
  assert.equal(h.state().route, 'codespace');
  const errs = errorTexts().join('\n');
  assert.match(errs, /unavailable/i);
  assert.match(errs, /NOT silently switched to OpenCode Zen/i, 'no silent fallback');
});

test('v42: selecting OpenCode dispatches through the local Termux route (/opencode/run)', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true);
  try { await h.api.runOpenCodeChat('hello from test', 'hello from test', ''); } catch (e) { /* DOM gaps are fine; we assert routing */ }
  assert.ok(h.harness.nativeCalls.includes('/opencode/run'), 'message dispatch must hit the native local run endpoint');
});

test('v42: send-time unavailability refuses dispatch with a clear reason and no Zen fallback', async () => {
  const h = buildComposer({ statusMode: 'OK' });
  h.openMenu(); await sleep(40);
  h.tapOpenCode(); await sleep(60);
  assert.equal(h.api.S.openCodeCLI, true);
  // Runtime genuinely dies before the send: a cold cache plus a failing probe must refuse the
  // dispatch loudly (never silently route to CodeSpace/Zen), and turn the dead mode off.
  h.harness.statusMode = 'COMMAND_ERROR';
  h.api.setStatus(null);
  const before = h.harness.nativeCalls.filter(p => p === '/opencode/run').length;
  try { await h.api.runOpenCodeChat('second', 'second', ''); } catch (e) {}
  const after = h.harness.nativeCalls.filter(p => p === '/opencode/run').length;
  assert.equal(after, before, 'must not dispatch to a dead runtime');
  assert.equal(h.api.S.openCodeCLI, false, 'dead runtime disables the mode instead of falling back');
  const errs = errorTexts().join('\n');
  assert.match(errs, /unavailable/i);
  assert.match(errs, /NOT silently switched to OpenCode Zen/i, 'no silent fallback');
});

test('v42: diagnostics use the [OPENCODE_SELECT_V42] prefix', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src-js', '19-activitybar-composer.js'), 'utf8');
  assert.match(src, /\[OPENCODE_SELECT_V42\]/);
  for (const marker of ['setRoute:enter', 'menu:click', 'toggleOpenCode:enter', 'availability:cached', 'selectOpenCodeLocal:enter', 'selectOpenCodeLocal:after-ui-sync', 'syncOpenCodeUI:render']) {
    assert.ok(src.includes(marker), 'missing diagnostic marker: ' + marker);
  }
});
