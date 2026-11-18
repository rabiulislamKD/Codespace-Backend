'use strict';
/* Functional unit tests for agent-server.js unzipArchive() — the no-git GitHub
 * fallback extractor (3.13.4). The archive fixtures are REAL ZIP binaries built
 * in this file (stored + deflate entries, central directory + EOCD), so the
 * shipped extractor is tested against genuine archive bytes, not mocks.
 *
 * Covers what CHANGELOG-3.13.4 promised: deflate + stored + nested dirs extract;
 * `../`, `..\` and absolute zip-slip entries are skipped; symlink entries are
 * never created; corrupt archives throw; EOCD is still found with a trailing
 * ZIP comment.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { extractFunction, ROOT } = require('./helpers/load.cjs');

/* ---------- load the shipped extractor code (exact bodies from agent-server.js) ---------- */
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'agent-server.js'), 'utf8');
const limitsLine = SERVER_SRC.match(/const GH_ZIP_LIMITS = \{[^\n}]+\};/);
assert.ok(limitsLine, 'GH_ZIP_LIMITS not found in agent-server.js');
const code = [limitsLine[0], extractFunction(SERVER_SRC, 'zipFindEOCD'), extractFunction(SERVER_SRC, 'unzipArchive')]
  .join('\n') + '\n;return { zipFindEOCD, unzipArchive, GH_ZIP_LIMITS };';
const { zipFindEOCD, unzipArchive } = new vm.Script('(function(){\n' + code + '\n})()',
  { filename: 'agent-server[unzipArchive]' }).runInContext(vm.createContext({ fs, path, zlib, console }));

/* ---------- minimal ZIP fixture writer ---------- */
const E = (name, data, opts = {}) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data), ...opts });

function zipEntryParts(entry, offset) {
  const method = entry.method || 0;                       // 0 = stored, 8 = deflate
  const body = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
  const crc = zlib.crc32(entry.data);
  const nameBuf = Buffer.from(entry.name, 'utf8');
  const l = Buffer.alloc(30);
  l.writeUInt32LE(0x04034b50, 0);                         // local file header signature
  l.writeUInt16LE(20, 4);                                 // version needed
  l.writeUInt16LE(0, 6);                                  // flags
  l.writeUInt16LE(method, 8);
  l.writeUInt16LE(0, 10); l.writeUInt16LE(0x21, 12);      // time / date (arbitrary)
  l.writeUInt32LE(crc, 14);
  l.writeUInt32LE(body.length, 18);                       // compressed size
  l.writeUInt32LE(entry.data.length, 22);                 // uncompressed size
  l.writeUInt16LE(nameBuf.length, 26); l.writeUInt16LE(0, 28);
  const local = Buffer.concat([l, nameBuf, body]);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);                         // central directory signature
  c.writeUInt16LE(0x031e, 4);                             // made by: unix
  c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8);
  c.writeUInt16LE(method, 10);
  c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(body.length, 20);
  c.writeUInt32LE(entry.data.length, 24);
  c.writeUInt16LE(nameBuf.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
  c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
  c.writeUInt32LE(entry.attrs || 0, 38);                  // external attrs (dir / symlink bits)
  c.writeUInt32LE(offset, 42);                            // local header offset
  return { local, central: Buffer.concat([c, nameBuf]) };
}

function buildZip(entries, opts = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const parts = zipEntryParts(entry, offset);
    locals.push(parts.local); centrals.push(parts.central);
    offset += parts.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                      // EOCD signature
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);     // disk numbers
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);                      // central directory size
  eocd.writeUInt32LE(offset, 16);                         // central directory offset
  eocd.writeUInt16LE(Buffer.byteLength(opts.comment || ''), 20);
  const comment = opts.comment ? Buffer.from(opts.comment) : Buffer.alloc(0);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

const tmpExtract = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-zip-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/* ---------- happy path ---------- */
test('unzipArchive extracts stored + deflate entries through nested directories', t => {
  const dir = tmpExtract(t);
  const zip = buildZip([
    E('repo-abc/', '', { attrs: 0x10 }),
    E('repo-abc/SKILL.md', '# Skill\n\nBody text here\n', { method: 8 }),
    E('repo-abc/sub/', '', { attrs: 0x10 }),
    E('repo-abc/sub/data.bin', Buffer.from([0, 1, 2, 255, 0, 0, 7]), { method: 0 }),
  ]);
  assert.equal(unzipArchive(zip, dir), 2, 'counts files, not directory entries');
  assert.equal(fs.readFileSync(path.join(dir, 'repo-abc/SKILL.md'), 'utf8'), '# Skill\n\nBody text here\n');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'repo-abc/sub/data.bin')), Buffer.from([0, 1, 2, 255, 0, 0, 7]));
});

/* ---------- zip-slip guards ---------- */
test('unzipArchive skips ../, ..\\, absolute and mid-path traversal entries', t => {
  const dir = tmpExtract(t);
  const zip = buildZip([
    E('../evil.txt', 'x'),
    E('..\\evil2.txt', 'x'),
    E('/abs.txt', 'x'),
    E('a/../../evil3.txt', 'x'),
    E('ok.txt', 'fine'),
  ]);
  assert.equal(unzipArchive(zip, dir), 1, 'only the safe entry is extracted');
  assert.equal(fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'), 'fine');
  assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'evil2.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'abs.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'evil3.txt')), false);
});

test('unzipArchive never creates symlink entries', t => {
  const dir = tmpExtract(t);
  const zip = buildZip([
    E('link', '/etc/passwd', { attrs: 0xa1ff0000 }),        // S_IFLNK|0777 in the high bits
    E('real.txt', 'hello'),
  ]);
  assert.equal(unzipArchive(zip, dir), 1);
  assert.equal(fs.existsSync(path.join(dir, 'link')), false, 'symlink must be skipped, not created');
  assert.equal(fs.readFileSync(path.join(dir, 'real.txt'), 'utf8'), 'hello');
});

/* ---------- malformed archives ---------- */
test('unzipArchive throws on non-zip input', t => {
  const dir = tmpExtract(t);
  assert.throws(() => unzipArchive(Buffer.from('this is definitely not a zip archive...'), dir), /Unreadable archive/);
});

test('unzipArchive throws when the central directory offset points outside the buffer', t => {
  const dir = tmpExtract(t);
  const zip = buildZip([E('a.txt', 'A')]);
  zip.writeUInt32LE(0xffffff, zipFindEOCD(zip) + 16);      // corrupt cdOff in the EOCD
  assert.throws(() => unzipArchive(zip, dir), /bad central directory/);
});

test('unzipArchive rejects an archive with zero entries', t => {
  const dir = tmpExtract(t);
  assert.throws(() => unzipArchive(buildZip([]), dir), /entry count out of range/);
});

/* ---------- EOCD robustness ---------- */
test('zipFindEOCD finds the directory even with a trailing ZIP comment', () => {
  const zip = buildZip([E('a.txt', 'A')], { comment: 'installer appended note \u2014 still a valid zip' });
  assert.ok(zipFindEOCD(zip) > 0);
  assert.equal(zip.slice(zipFindEOCD(zip), zipFindEOCD(zip) + 4).readUInt32LE(0), 0x06054b50);
});

test('unzipArchive extracts correctly when a trailing comment follows the EOCD', t => {
  const dir = tmpExtract(t);
  const zip = buildZip([E('a.txt', 'A')], { comment: 'installer appended note' });
  assert.equal(unzipArchive(zip, dir), 1);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'A');
});
