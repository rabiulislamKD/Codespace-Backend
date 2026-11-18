'use strict';
/* Regression tests for the 3.18.0 bug-fix pass.
 *  - Real Node extension host process driven through its IPC protocol (no mocks of the code under test)
 *  - server glob matcher used by workspace.findFiles (extracted from agent-server.js)
 *  - engine-range parser and API allow-list in vscode-extension-support.cjs
 *  - frontend source guard: stray keywords that parse fine but throw at boot
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(ROOT, 'vscode-node-extension-host.cjs');

/* ---------- drive the real host ---------- */
function runExtension(files, mainSource, { timeoutMs = 8000 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-host-'));
  const ext = path.join(base, 'ext'), ws = path.join(base, 'ws'), state = path.join(base, 'state');
  for (const d of [ext, ws, state]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(ext, 'main.js'), mainSource);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ws, name), text);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, ext, 'main.js', 'k', ws, state, 't.ext', '0'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const logs = []; let done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} err ? reject(err) : resolve({ logs, ws, readWs: n => fs.readFileSync(path.join(ws, n), 'utf8') }); };
    const timer = setTimeout(() => finish(new Error('extension host did not finish in time (hang). Logs: ' + logs.join(' | '))), timeoutMs);
    const reply = (requestId, body) => child.stdin.write(JSON.stringify({ type: 'rpcResult', requestId, ...body }) + '\n');
    readline.createInterface({ input: child.stdio[3] }).on('line', line => {
      const m = JSON.parse(line);
      if (m.type === 'log') { logs.push(m.message); if (m.message === 'DONE') finish(); }
      else if (m.type === 'activationError' || m.type === 'error') finish(new Error(m.error));
      else if (m.type === 'rpc') {
        const a = m.args || {};
        if (m.method === 'workspace.openTextDocument') reply(m.requestId, { result: { text: fs.readFileSync(a.uri.fsPath, 'utf8'), languageId: 'plaintext' } });
        else if (m.method === 'workspace.writeFile') { fs.writeFileSync(a.uri.fsPath, Buffer.from(a.base64, 'base64')); reply(m.requestId, { result: { ok: true } }); }
        else reply(m.requestId, { result: null });
      }
    });
  });
}
const wrap = body => `const vscode = require('vscode');\nexports.activate = async () => { try {\n${body}\n} catch (e) { console.log('THROWN ' + e.message); } console.log('DONE'); };`;
const out = r => r.logs.filter(x => x !== 'DONE');

test('Range accepts (startPosition, endPosition) as well as four numbers, and normalises order', async () => {
  const r = await runExtension({}, wrap(`
    const a = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(3, 4));
    const b = new vscode.Range(3, 4, 1, 2);
    console.log(JSON.stringify([a.start, a.end, b.start, b.end, a.isEmpty, a.isSingleLine]));`));
  assert.equal(out(r)[0], JSON.stringify([{ line: 1, character: 2 }, { line: 3, character: 4 }, { line: 1, character: 2 }, { line: 3, character: 4 }, false, false]));
});

test('getWordRangeAtPosition finds a later word and never hangs', async () => {
  const r = await runExtension({ 'b.txt': 'foo bar baz\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('b.txt');
    const w = d.getWordRangeAtPosition(new vscode.Position(0, 5));
    console.log(JSON.stringify([w.start.character, w.end.character, d.getWordRangeAtPosition(new vscode.Position(0, 100)) === undefined]));`));
  assert.equal(out(r)[0], '[4,7,true]');
});

test('lineAt accepts a Position', async () => {
  const r = await runExtension({ 'a.txt': 'one\ntwo\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('a.txt');
    console.log(d.lineAt(new vscode.Position(1, 0)).text + '|' + d.lineAt(0).text);`));
  assert.equal(out(r)[0], 'two|one');
});

test('applyEdit applies every edit to the same file, in original-text coordinates, and refreshes the document', async () => {
  const r = await runExtension({ 'a.txt': 'foo bar baz\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('a.txt');
    const we = new vscode.WorkspaceEdit();
    we.replace(d.uri, new vscode.Range(0, 4, 0, 7), 'BBB');
    we.replace(d.uri, new vscode.Range(0, 0, 0, 3), 'AAA');
    we.insert(d.uri, new vscode.Position(0, 11), '!');
    await vscode.workspace.applyEdit(we);
    console.log(JSON.stringify(d.getText()));`));
  assert.equal(out(r)[0], JSON.stringify('AAA BBB baz!\n'));
  assert.equal(r.readWs('a.txt'), 'AAA BBB baz!\n');
});

test('FileSystemError is its own class and the global Error is not modified', async () => {
  const r = await runExtension({}, wrap(`
    const e = vscode.FileSystemError.FileNotFound(vscode.Uri.file('/x/y'));
    console.log(JSON.stringify([typeof Error.FileNotFound, vscode.FileSystemError === Error, e instanceof Error, e instanceof vscode.FileSystemError, e.code, new Error('x') instanceof vscode.FileSystemError]));`));
  assert.equal(out(r)[0], JSON.stringify(['undefined', false, true, true, 'FileNotFound', false]));
});

test('languages.getDiagnostics(uri) returns what collections published for that URI', async () => {
  const r = await runExtension({ 'a.txt': 'x\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('a.txt');
    const c1 = vscode.languages.createDiagnosticCollection('one'), c2 = vscode.languages.createDiagnosticCollection('two');
    c1.set(d.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'm1', 0)]);
    c2.set(d.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'm2', 1)]);
    console.log(vscode.languages.getDiagnostics(d.uri).map(x => x.message).join(',') + '|' + vscode.languages.getDiagnostics().length);`));
  assert.equal(out(r)[0], 'm1,m2|1');
});

/* ---------- server glob matcher ---------- */
function loadGlob() {
  const src = fs.readFileSync(path.join(ROOT, 'agent-server.js'), 'utf8');
  const m = src.match(/function nodeHostGlobToRegExp[\s\S]*?\n}\n/);
  assert.ok(m, 'nodeHostGlobToRegExp must exist in agent-server.js');
  return new Function(m[0] + '; return nodeHostGlobToRegExp;')();
}
test('workspace.findFiles glob: ** matches zero or more folders, braces alternate, * stays in a folder', () => {
  const g = loadGlob();
  const cases = [['**/*', 'a.txt', true], ['**/*', 'src/a.txt', true], ['**/*.js', 'index.js', true], ['**/*.js', 'a/b/c.js', true], ['**/*.js', 'a.css', false],
    ['**/*.{ts,js}', 'src/a.ts', true], ['**/*.{ts,js}', 'a.js', true], ['**/*.{ts,js}', 'a.css', false], ['src/**/*.js', 'src/a.js', true], ['src/**/*.js', 'lib/a.js', false],
    ['*.md', 'README.md', true], ['*.md', 'docs/README.md', false], ['a.b', 'axb', false], ['**/node_modules/**', 'x/node_modules/y/z.js', true]];
  for (const [pattern, file, expected] of cases) assert.equal(g(pattern).test(file), expected, `${pattern} vs ${file}`);
});
test('workspace.findFiles glob: pathological patterns stay fast', () => {
  const g = loadGlob(), t = Date.now();
  g('**/'.repeat(80) + 'x').test('a/'.repeat(150));
  assert.ok(Date.now() - t < 500);
});

/* ---------- compatibility inspection ---------- */
test('engine ranges: spaced operators, x-ranges and caret/tilde', () => {
  const { engineCompatible } = require('../vscode-extension-support.cjs');
  for (const [range, expected] of [['>= 1.85.0', true], ['>=1.85.0 <2.0.0', true], ['>= 1.85.0 < 2.0.0', true], ['^1.85.0', true], ['^1.91.0', false], ['~1.89.0', false],
    ['1.90.x', true], ['1.89.x', false], ['1.x', true], ['2.x', false], ['*', true], ['', false]]) assert.equal(engineCompatible(range), expected, range);
});
test('node allow-list covers every provider/event the host implements (signature help, symbols, code lens, close/willSave, watcher)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'vscode-extension-support.cjs'), 'utf8');
  const host = fs.readFileSync(HOST, 'utf8');
  for (const api of ['languages.registerSignatureHelpProvider', 'languages.registerDocumentSymbolProvider', 'languages.registerCodeLensProvider', 'workspace.onDidCloseTextDocument', 'workspace.createFileSystemWatcher']) {
    assert.ok(src.includes("'" + api + "'"), api + ' missing from NODE_API_ALLOW');
    assert.ok(host.includes(api.split('.')[1]), api + ' is not implemented by the host');
  }
});

/* ---------- frontend source guard ---------- */
test('no source fragment contains a dangling keyword line (parses via ASI but throws at boot, e.g. a lone "async")', () => {
  const dir = path.join(ROOT, 'src-js');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!/^\s*(?:async|await|function|const|let|var|return|new|typeof)\s*$/.test(line), `${f}:${i + 1} has a dangling "${line.trim()}"`);
    });
  }
});

test('TextDocument.save persists synced editor changes, clears dirty state, and fires onDidSaveTextDocument', async () => {
  const r = await runExtension({ 'a.txt': 'before\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('a.txt');
    let saved = false;
    vscode.workspace.onDidSaveTextDocument(doc => { if (doc === d) saved = true; });
    console.log('initialDirty=' + d.isDirty);
    d._update('after from editor\\n', 2, 'plaintext', true);
    console.log('changedDirty=' + d.isDirty);
    await d.save();
    console.log(JSON.stringify({ dirty:d.isDirty, saved, text:d.getText() }));`));
  assert.deepEqual(out(r), ['initialDirty=false', 'changedDirty=true', JSON.stringify({ dirty:false, saved:true, text:'after from editor\n' })]);
  assert.equal(r.readWs('a.txt'), 'after from editor\n');
});

test('workspace.applyEdit leaves a persisted document clean', async () => {
  const r = await runExtension({ 'a.txt': 'before\n' }, wrap(`
    const d = await vscode.workspace.openTextDocument('a.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(d.uri, new vscode.Range(0,0,0,6), 'saved');
    await vscode.workspace.applyEdit(edit);
    console.log(JSON.stringify({ dirty:d.isDirty, text:d.getText() }));`));
  assert.equal(out(r)[0], JSON.stringify({ dirty:false, text:'saved\n' }));
});
