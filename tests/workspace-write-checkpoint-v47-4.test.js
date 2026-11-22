'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const readAndroid = p => {
  for (const base of ['../app', 'android/app']) {
    const f = path.join(root, base, p);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return '';
};
const clientSrc = read('src-js/03-bridge-client.js');
const cpSrc = read('src-js/04-checkpoints.js');
const bridgeSrc = read('src-js/09-browser-bridge.js');
const mainSrc = readAndroid('src/main/java/com/codespace/android/MainActivity.kt');

const cpFn = cpSrc.slice(cpSrc.indexOf('async function ensureTurnCheckpoint('), cpSrc.indexOf('function cpButton('));

function checkpointContext(bcallImpl) {
  const messages = [];
  const context = {
    S: { autoCheckpoint: true },
    B: { ok: true, info: { root: 'saf://workspace' } },
    CP: { items: [], busy: false, lastPreview: null },
    bcall: bcallImpl,
    cpSay: (msg, bad) => messages.push({ msg, bad }),
    $: () => null,
    renderCheckpoints: () => {}
  };
  vm.createContext(context);
  vm.runInContext("let turnCheckpointId = null, turnCheckpointPromise = null;\n" + cpFn + '\nthis.testEnsure = ensureTurnCheckpoint;', context);
  return { context, messages };
}

test('[1] checkpoint and batch-edit endpoints follow the active Android workspace', () => {
  const line = clientSrc.split('\n').find(x => x.startsWith('const CS_LOCAL_FILE_EP'));
  for (const ep of ['checkpoints\\/(create|list|compare|restore|delete)', 'fs\\/(list|read|write|create|mkdir|rename|delete|search|stat|metadata|stream|history|undo|redo|editbatch)', 'index\\/(status|rebuild|search|symbols|references|related|map|rename)']) {
    assert.ok(line.includes(ep), `missing ${ep}`);
  }
});

test('[2] a checkpoint backend failure never blocks the write', async () => {
  const { context, messages } = checkpointContext(async () => {
    throw new Error('No folder is open. Open a workspace before using checkpoints.');
  });
  const out = await context.testEnsure('write file: products-data.js');
  assert.equal(out, null);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].bad, true);
  assert.match(messages[0].msg, /Checkpoint unavailable/);
});

test('[3] a successful checkpoint still reports its id', async () => {
  const { context, messages } = checkpointContext(async () => ({ id: 'cp123', complete: true, fileCount: 9 }));
  const out = await context.testEnsure('write file: data.js');
  assert.equal(out.id, 'cp123');
  assert.ok(messages.some(m => /Automatic checkpoint created/.test(m.msg)));
});

test('[4] native adapter implements batch edits and symbol rename', () => {
  assert.match(mainSrc, /"\/fs\/editbatch" -> localFsEditBatch\(body\)/);
  assert.match(mainSrc, /"\/index\/rename" -> localIndexRename\(body\)/);
  assert.match(mainSrc, /private fun localFsEditBatch\(body: JSONObject\): JSONObject/);
  assert.match(mainSrc, /private fun localIndexRename\(body: JSONObject\): JSONObject/);
  assert.match(mainSrc, /private fun localWorkspaceWrite\(rel: String, content: String\)/);
});

test('[5] rename_symbol creates a checkpoint before touching files', () => {
  const caseText = bridgeSrc.slice(bridgeSrc.indexOf("case 'rename_symbol': {"), bridgeSrc.indexOf("case 'undo_file'"));
  assert.match(caseText, /await ensureTurnCheckpoint\('rename symbol: '/);
});
