'use strict';
/* Unit tests for small pure helpers: stripAnsi (17-terminal) and strHash (20-git-permissions). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFragments } = require('./helpers/load.cjs');

const { stripAnsi } = loadFragments(['01-core-helpers-state.js', '17-terminal.js'], ['stripAnsi']);
const { strHash } = loadFragments(['01-core-helpers-state.js', '20-git-permissions.js'], ['strHash']);

/* ---------- stripAnsi ---------- */
test('stripAnsi removes SGR color sequences', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b[1;32mbold green\x1b[0m'), 'bold green');
});
test('stripAnsi removes OSC sequences (window title etc.)', () => {
  assert.equal(stripAnsi('\x1b]0;my title\x07after'), 'after');
});
test('stripAnsi normalizes CRLF and lone CR to LF', () => {
  assert.equal(stripAnsi('a\r\nb'), 'a\nb');
  assert.equal(stripAnsi('a\rb'), 'a\nb');
});
test('stripAnsi leaves plain text and coerces non-strings', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi(null), 'null'); // String(null) = "null" — no ANSI codes to strip
});

/* ---------- strHash (edit-change detection) ---------- */
test('strHash is deterministic for the same input', () => {
  assert.equal(strHash('hello world'), strHash('hello world'));
});
test('strHash differs for different inputs', () => {
  assert.notEqual(strHash('hello world'), strHash('hello worlds'));
  assert.notEqual(strHash('file-v1'), strHash('file-v2'));
});
test('strHash stays inside signed 32-bit range (Math.imul contract)', () => {
  for (const s of ['', 'a', 'the quick brown fox', 'x'.repeat(5000), '\u00e9\u4f60\u597d']) {
    const h = strHash(s);
    assert.ok(Number.isInteger(h), 'must be an integer');
    assert.ok(h >= -2147483648 && h <= 2147483647, 'out of int32 range: ' + h);
  }
});
