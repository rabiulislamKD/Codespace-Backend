'use strict';
/* Unit tests for src-js/05-markdown-diff.js (+ esc from 01-core-helpers-state.js).
 * Runs the REAL fragment code in a vm sandbox (see tests/helpers/load.cjs). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFragments } = require('./helpers/load.cjs');

const { esc, langOf, highlightLines, stripThink, splitThink, codeBlock, inlineMd, mdText, md, diffOps, compactDiff, renderDiff } =
  loadFragments(['01-core-helpers-state.js', '05-markdown-diff.js'],
    ['esc', 'langOf', 'highlightLines', 'stripThink', 'splitThink', 'codeBlock', 'inlineMd', 'mdText', 'md', 'diffOps', 'compactDiff', 'renderDiff']);

/* ---------- esc ---------- */
test('esc escapes HTML-significant characters', () => {
  assert.equal(esc('<a "b" \'c\' & d>'), '&lt;a &quot;b&quot; &#39;c&#39; &amp; d&gt;');
});
test('esc passes safe text through and coerces non-strings', () => {
  assert.equal(esc('plain text'), 'plain text');
  assert.equal(esc(42), '42');
  assert.equal(esc(null), 'null'); // String(null) = "null" — no special chars to escape
});

/* ---------- langOf ---------- */
test('langOf maps file extensions to language ids', () => {
  assert.equal(langOf('app.js'), 'js');
  assert.equal(langOf('x.TS'), 'js');
  assert.equal(langOf('data.json'), 'json');
  assert.equal(langOf('s.py'), 'py');
  assert.equal(langOf('index.html'), 'markup');
  assert.equal(langOf('style.css'), 'css');
  assert.equal(langOf('run.sh'), 'hash');
  assert.equal(langOf('notes.txt'), 'plain');
  assert.equal(langOf('noextension'), 'plain');
});

/* ---------- highlightLines ---------- */
test('highlightLines wraps JS keywords and strings in t-* spans', () => {
  const out = highlightLines('const x = "hi";', 'js').join('\n');
  assert.match(out, /class="t-k"/);   // keyword: const
  assert.match(out, /class="t-s"/);   // string: "hi"
});
test('highlightLines leaves plain prose untagged', () => {
  const out = highlightLines('hello dear prose reader', 'js').join('\n');
  assert.ok(!out.includes('<span'), 'expected no spans, got: ' + out);
});

/* ---------- <think> handling ---------- */
test('stripThink removes closed and unterminated think blocks and trims', () => {
  assert.equal(stripThink('  a<think>hidden</think>b  '), 'ab');
  assert.equal(stripThink('a<think>never closed'), 'a');
  assert.equal(stripThink(null), '');
});
test('splitThink separates thinking from answer', () => {
  const r = splitThink('<think>A</think>answer');
  assert.equal(r.think, 'A');
  assert.equal(r.text, 'answer');
  const multi = splitThink('<think>one</think>mid<think>two</think>end');
  assert.equal(multi.think, 'one\n\ntwo');
  assert.equal(multi.text, 'midend');
  const none = splitThink('just text');
  assert.equal(none.think, '');
  assert.equal(none.text, 'just text');
});

/* ---------- codeBlock ---------- */
test('codeBlock wraps code with header and copy button', () => {
  const out = codeBlock('const a = 1;', 'js');
  assert.ok(out.startsWith('<div class="cb">'));
  assert.match(out, /<span>js<\/span>/);
  assert.match(out, /class="btn sm copy"/);
  assert.match(out, /t-k/);
});
test('codeBlock escapes unknown languages as plain text', () => {
  const out = codeBlock('<b>hi</b>', '');
  assert.ok(!out.includes('<b>hi'), 'raw HTML must be escaped');
  assert.match(out, /<span>text<\/span>/);
});

/* ---------- inline markdown ---------- */
test('inlineMd renders bold, code and links with safe attributes', () => {
  assert.match(inlineMd('**bold**'), /<strong>bold<\/strong>/);
  assert.match(inlineMd('`code`'), /<code>code<\/code>/);
  assert.match(inlineMd('[x](https://a.b)'), /<a href="https:\/\/a\.b" target="_blank" rel="noopener noreferrer">x<\/a>/);
});
test('inlineMd escapes raw HTML before applying markup', () => {
  assert.ok(!inlineMd('<script>alert(1)</script>').includes('<script>'));
});
test('inlineMd does not link javascript: URLs', () => {
  const out = inlineMd('[x](javascript:alert(1))');
  assert.ok(!out.includes('<a '), 'javascript: URLs must not become links');
});

/* ---------- block markdown ---------- */
test('mdText renders headings, lists and paragraphs', () => {
  assert.equal(mdText('# Title'), '<h4>Title</h4>');
  assert.equal(mdText('### Deep'), '<h5>Deep</h5>');
  assert.equal(mdText('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(mdText('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(mdText('line one\nline two'), '<p>line one<br>line two</p>');
});
test('mdText separates blocks on blank lines', () => {
  const out = mdText('para\n\n- item');
  assert.match(out, /^<p>para<\/p><ul>/);
});

/* ---------- md (fenced code) ---------- */
test('md renders fenced code through codeBlock and text through mdText', () => {
  const out = md('before\n```js\nconst a = 1;\n```\nafter');
  assert.match(out, /^<p>before<\/p>/);
  assert.match(out, /class="cbh"/);
  assert.match(out, /t-k/); // highlighted keyword inside the fence
  assert.match(out, /<p>after<\/p>$/);
});

/* ---------- diff pipeline ---------- */
test('diffOps finds the changed middle while keeping common prefix/suffix', () => {
  const ops = diffOps(['x', 'y', 'z'], ['x', 'q', 'z']);
  assert.equal(ops[0][0] + ops[0][1], ' x');
  const last = ops[ops.length - 1];
  assert.equal(last[0] + last[1], ' z');
  assert.ok(ops.some(o => o[0] === '-' && o[1] === 'y'), 'removed line must appear');
  assert.ok(ops.some(o => o[0] === '+' && o[1] === 'q'), 'added line must appear');
});
test('diffOps handles pure insertion and deletion', () => {
  const ins = diffOps(['a', 'c'], ['a', 'b', 'c']);
  assert.ok(ins.some(o => o[0] === '+' && o[1] === 'b'));
  const del = diffOps(['a', 'b', 'c'], ['a', 'c']);
  assert.ok(del.some(o => o[0] === '-' && o[1] === 'b'));
});
test('compactDiff counts +/- and collapses far context into ~ gaps', () => {
  const ops = diffOps(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], ['a', 'b', 'c', 'd', 'e', 'X', 'g', 'h', 'i', 'j']);
  const d = compactDiff(ops, 1);
  assert.equal(d.add, 1);
  assert.equal(d.del, 1);
  assert.ok(d.lines.includes('~'), 'distant unchanged lines collapse to a gap marker');
  assert.ok(d.lines.length < ops.length, 'compact output must be shorter than full ops');
  const changed = d.lines.filter(l => l !== '~');
  assert.ok(changed.some(l => l.startsWith('+') && l.includes('X')));
  assert.ok(changed.some(l => l.startsWith('-') && l.includes('f')), 'removed original line is f');
});
test('renderDiff produces add/del/gap rows inside a diff container', () => {
  const d = { add: 1, del: 1, lines: [' old', '-gone', '+new', '~'] };
  const out = renderDiff(d);
  assert.ok(out.startsWith('<div class="diff">'));
  assert.match(out, /class="dl add">\+ new</);   // marker + space + content, by design
  assert.match(out, /class="dl del">- gone</);
  assert.match(out, /class="dl gap">⋯</);
});
