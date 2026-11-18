'use strict';
/* Unit tests for server-side security/validity guards extracted from agent-server.js.
 * The extractor pulls the exact function bodies, so the tested code is the shipped code.
 *
 * Covered:
 *  - cpInside                    workspace-jail containment (path.relative guard)
 *  - cpRel                       checkpoint path validation (traversal + sensitive files)
 *  - cpIdValid                   checkpoint-id shape guard (before any path.join)
 *  - cpFileOnDisk                storage containment for files inside a checkpoint
 *  - cpAssertNoSymlinkComponents refuses restores that traverse symlinks
 *  - validManifest               extension.json validation before anything is registered
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServerFunctions, ROOT } = require('./helpers/load.cjs');

/* IGNORE comes from the server source itself, so the tests stay in sync with it */
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'agent-server.js'), 'utf8');
const IGNORE = new Set(
  (SERVER_SRC.match(/const IGNORE = new Set\(\[([^\]]+)\]\)/) || [])[1]
    .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
);
assert.ok(IGNORE.has('node_modules'), 'IGNORE extraction from agent-server.js failed');

const { cpInside, cpRel, cpIdValid, cpFileOnDisk, cpAssertNoSymlinkComponents, validManifest } =
  loadServerFunctions(['cpInside', 'cpRel', 'cpIdValid', 'cpFileOnDisk', 'cpAssertNoSymlinkComponents', 'validManifest'],
    { IGNORE, fs });

/* ---------- cpInside — the workspace-jail path guard used by checkpoints ---------- */
test('cpInside accepts the base folder itself', () => {
  assert.equal(cpInside('/workspace', '/workspace'), true);
  assert.equal(cpInside('/workspace/', '/workspace'), true);
});
test('cpInside accepts children of the base folder', () => {
  assert.equal(cpInside('/workspace', '/workspace/src/app.js'), true);
  assert.equal(cpInside('/workspace', '/workspace/sub'), true);
  assert.equal(cpInside('/workspace', '/workspace/sub/../x'), true);
});
test('cpInside REJECTS siblings that share a prefix (classic traversal bug)', () => {
  assert.equal(cpInside('/workspace', '/workspace2'), false);
  assert.equal(cpInside('/workspace', '/workspace-backup/x'), false);
});
test('cpInside REJECTS paths escaping the base', () => {
  assert.equal(cpInside('/workspace', '/etc/passwd'), false);
  assert.equal(cpInside('/workspace', '/workspace/../secrets'), false);
  assert.equal(cpInside('/a/b', '/a'), false);
});
test('cpInside REJECTS relative targets (no implicit cwd escape)', () => {
  assert.equal(cpInside('/workspace', 'sub/file.txt'), false);
});

/* ---------- cpRel — checkpoint path validation ---------- */
test('cpRel accepts ordinary workspace-relative paths', () => {
  for (const p of ['a.txt', 'src/app.js', 'deep/nested/folder/file.md']) assert.equal(cpRel(p), p);
});
test('cpRel rejects absolute, UNC and drive-letter paths', () => {
  for (const p of ['/etc/passwd', '\\\\server\\share\\f', 'C:\\Windows\\system32\\x', 'D:/data', '\\..\\x'])
    assert.throws(() => cpRel(p), /Invalid checkpoint file path/, p);
});
test('cpRel rejects traversal and empty/dot segments', () => {
  for (const p of ['', null, undefined, '..', 'a/../b', './x', 'a/./b', 'a//b', 'a/..'])
    assert.throws(() => cpRel(p), /Invalid checkpoint file path/, String(p));
});
test('cpRel refuses paths inside ignored directories', () => {
  for (const p of ['node_modules/pkg/index.js', '.git/config', '.venv/lib/py.py', 'dist/bundle.js', '.vscode/settings.json'])
    assert.throws(() => cpRel(p), /excluded directory/, p);
});
test('cpRel refuses sensitive files wherever they sit in the tree', () => {
  for (const p of ['.env', '.env.local', 'config/.env', '.npmrc', '.pypirc',
    'id_rsa', 'keys/id_ed25519.pub', 'credentials', 'credentials.json', 'secrets.yaml',
    'server.pem', 'deploy/key.pfx', 'cert.key'])
    assert.throws(() => cpRel(p), /Sensitive paths/, p);
});
test('cpRel allows lookalike files that are not on the sensitive list', () => {
  for (const p of ['npmrc', 'mycredentials.json', 'id_rsa_backup.txt', 'envs/production.json', 'src/keys.md'])
    assert.equal(cpRel(p), p, p);
});

/* ---------- cpIdValid — checkpoint-id shape guard ---------- */
test('cpIdValid accepts only the canonical checkpoint id shape', () => {
  assert.equal(cpIdValid('cp_1730000000000_0a1b2c3d'), true);
  assert.equal(cpIdValid('cp_1_abcdef12'), true);
  for (const bad of ['', 'cp', 'cp_1', 'cp_1_abc', 'CP_1_abcdef12', 'cp_1_abcdef1g',
    '../cp_1_abcdef12', 'cp_1_abcdef12/cp_2_11223344', 'cp_1_abcdef12extra'])
    assert.equal(cpIdValid(bad), false, bad);
});

/* ---------- cpFileOnDisk — storage containment inside a checkpoint ---------- */
test('cpFileOnDisk resolves stored files inside the checkpoint files dir', () => {
  const cp = { dir: path.join(os.tmpdir(), 'cp-fixture-cp_1_abcdef12') };
  const out = cpFileOnDisk(cp, 'src/app.js');
  assert.equal(out, path.join(cp.dir, 'files', 'src', 'app.js'));
});
test('cpFileOnDisk refuses anything that would escape storage', () => {
  const cp = { dir: path.join(os.tmpdir(), 'cp-fixture-cp_1_abcdef12') };
  for (const rel of ['../outside.txt', '/etc/passwd', 'a/../../b', '..\\escape'])
    assert.throws(() => cpFileOnDisk(cp, rel), /Invalid checkpoint file path/, rel);
});

/* ---------- cpAssertNoSymlinkComponents — no restores through symlinks ---------- */
test('cpAssertNoSymlinkComponents walks plain existing paths and stops at missing ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-guard-'));
  try {
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'a', 'f.txt'), 'x');
    assert.doesNotThrow(() => cpAssertNoSymlinkComponents(root, 'a/f.txt'));
    assert.doesNotThrow(() => cpAssertNoSymlinkComponents(root, 'a/missing.txt'), 'ENOENT stops the walk');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('cpAssertNoSymlinkComponents refuses symlink traversal and file-as-directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-guard-'));
  try {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'f.txt'), 'x');
    let linked = true;
    try { fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link')); }
    catch { linked = false; }   // symlink creation can be unprivileged-denied (some Windows setups)
    if (!linked) return t.skip('symlinks not available on this filesystem/user');
    assert.throws(() => cpAssertNoSymlinkComponents(root, 'link/f.txt'), /symbolic link/);
    assert.throws(() => cpAssertNoSymlinkComponents(root, 'real/f.txt/child'), /parent path is not a directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ---------- validManifest — extension.json validation before anything is registered ---------- */
test('validManifest accepts an MCP command manifest', () => {
  const m = { mcp: { command: 'npx -y some-mcp-server' } };
  assert.equal(validManifest(m), m);
});
test('validManifest accepts a declarative tools manifest', () => {
  const m = { tools: [{ name: 'ping', run: 'echo pong' }] };
  assert.equal(validManifest(m), m);
});
test('validManifest rejects manifests without mcp or tools', () => {
  assert.throws(() => validManifest({ name: 'nothing useful' }), /manifest needs/);
  assert.throws(() => validManifest({ tools: [{ name: 'missing run' }] }), /manifest needs/);
});
test('validManifest rejects non-object input', () => {
  assert.throws(() => validManifest(null), /must be a JSON object/);
  assert.throws(() => validManifest('string'), /must be a JSON object/);
});
