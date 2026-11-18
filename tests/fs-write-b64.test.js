'use strict';
/* Regression tests for the 3.13.6 fsWrite b64 path (files dragged into the explorer
 * from outside CodeSpace travel as base64 so images/archives survive). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServerFunctions } = require('./helpers/load.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb64-'));
const inside = (base, target) => { const r = path.relative(base, target); return r === '' || (r.split(path.sep)[0] !== '..' && !path.isAbsolute(r)); };
const SERVER = loadServerFunctions(['safe', 'fsWrite'], {
  fs, Buffer, ROOT: tmp, inside,
  WORKSPACE_JAIL_MSG: p => 'jail: ' + p,
  pushFileHistory: () => {},
  invalidateCodeIndex: () => {}
});

test('fsWrite b64 decodes binary content byte-for-byte', () => {
  // PNG magic bytes as a fake binary upload
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, 0x42]);
  const r = SERVER.fsWrite({ path: 'img/icon.bin', b64: raw.toString('base64') });
  assert.deepEqual({ bytes: r.bytes, written: fs.readFileSync(path.join(tmp, 'img/icon.bin')) }, { bytes: raw.length, written: raw });
  assert.ok(fs.statSync(path.join(tmp, 'img')).isDirectory(), 'parent folders are created');
});

test('fsWrite b64 overwrites an existing file completely (no stale tail)', () => {
  const first = Buffer.alloc(64, 0xaa), second = Buffer.alloc(8, 0xbb);
  SERVER.fsWrite({ path: 'swap.bin', b64: first.toString('base64') });
  SERVER.fsWrite({ path: 'swap.bin', b64: second.toString('base64') });
  assert.equal(fs.statSync(path.join(tmp, 'swap.bin')).size, second.length, 'old content must not survive');
});

test('fsWrite b64 refuses junk that is not valid base64', () => {
  assert.throws(() => SERVER.fsWrite({ path: 'bad.bin', b64: '!!!!' }), /could not be decoded|bytes/);
});

test('fsWrite b64 enforces the same 5 MB limit as text writes', () => {
  const big = Buffer.alloc(5e6 + 1, 1).toString('base64');
  assert.throws(() => SERVER.fsWrite({ path: 'big.bin', b64: big }), /5 MB/);
});

test('fsWrite text path still records file history', () => {
  const seen = [];
  const S2 = loadServerFunctions(['safe', 'fsWrite'], {
    fs, Buffer, ROOT: tmp, inside,
    WORKSPACE_JAIL_MSG: p => 'jail: ' + p,
    pushFileHistory: (p, c) => seen.push([p, c]),
    invalidateCodeIndex: () => {}
  });
  S2.fsWrite({ path: 'note.txt', content: 'v1' });
  S2.fsWrite({ path: 'note.txt', content: 'v2' });
  assert.deepEqual(seen, [['note.txt', 'v1']], 'one history entry per overwrite, with the previous content');
  assert.equal(fs.readFileSync(path.join(tmp, 'note.txt'), 'utf8'), 'v2');
});
