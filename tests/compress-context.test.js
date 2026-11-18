'use strict';
/* Unit tests for src-js/11-compress-context.js — token-saver trimming and
 * validation-command classification. Real fragment code in a vm sandbox. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFragments } = require('./helpers/load.cjs');

const { S, isValidationCommand, prepared, formatAgentRunReport, buildContinuationNote } =
  loadFragments(['01-core-helpers-state.js', '11-compress-context.js'],
    ['S', 'isValidationCommand', 'prepared', 'formatAgentRunReport', 'buildContinuationNote']);

/* ---------- isValidationCommand ---------- */
test('isValidationCommand recognises test/build/lint commands across ecosystems', () => {
  for (const cmd of [
    'npm test', 'npm run build', 'npm run type-check', 'pnpm exec vitest',
    'npx jest', 'pytest', 'python3 -m pytest', 'cargo test', 'go test ./...',
    'node --check app.js', 'git diff --check', 'make check'
  ]) assert.equal(isValidationCommand(cmd), true, cmd);
});
test('isValidationCommand rejects ordinary (non-verification) commands', () => {
  for (const cmd of [
    'rm -rf /', 'ls -la', 'npm install left-pad', 'echo npm test',
    'curl https://example.com', 'git push origin main', 'python3 app.py'
  ]) assert.equal(isValidationCommand(cmd), false, cmd);
});
test('isValidationCommand is safe against empty and non-string input', () => {
  assert.equal(isValidationCommand(''), false);
  assert.equal(isValidationCommand(null), false);
});

/* ---------- prepared (token saver) ---------- */
const long = 'x'.repeat(900);
function historyFixture() {
  // 4 old messages (compressed), 8 recent (touched), per prepared(): recent = h.length - 8
  return [
    { role: 'tool', content: long, image: 'data:image/png;base64,AAAA' },
    { role: 'tool', content: short() },
    { role: 'assistant', toolCalls: [{ fn: 'write_file', args: { content: 'y'.repeat(500) } }] },
    { role: 'user', content: 'old question' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: 'recent ' + i }))
  ];
}
const short = () => 'short output';

test('prepared leaves history untouched when the token saver is off', () => {
  const h = historyFixture();
  S.tokenSaver = false;
  const out = prepared(h);
  assert.equal(out, h, 'must return the same array reference');
  assert.equal(out[0].content, long);
  assert.equal(out[0].image, 'data:image/png;base64,AAAA');
});

test('prepared trims old tool outputs and strips old images, recent messages untouched', () => {
  S.tokenSaver = true;
  const h = historyFixture();
  const out = prepared(h);
  // old tool message: trimmed, image stripped
  assert.ok(out[0].content.length < long.length, 'old long tool output must be trimmed');
  assert.match(out[0].content, /older output trimmed to save tokens/);
  assert.equal(out[0].image, undefined, 'old tool images must be dropped');
  // short tool output stays
  assert.equal(out[1].content, 'short output');
  // old assistant tool-call args trimmed
  const call = out[2].toolCalls[0];
  assert.match(String(call.args.content), /characters omitted to save tokens/);
  // recent 8 messages pass through verbatim
  for (let i = 4; i < 12; i++) assert.deepEqual(out[i], h[i], 'recent message ' + i + ' must be untouched');
});

/* ---------- formatAgentRunReport ---------- */
test('formatAgentRunReport renders stop reason, counters and changed files', () => {
  const run = {
    stopReason: 'completed', steps: 3, toolCalls: 2, toolIssues: 1,
    changedFiles: new Set(['src/a.js', 'src/b.js']),
    validations: [{ status: 'passed' }, { status: 'failed' }]
  };
  const out = formatAgentRunReport(run);
  assert.match(out, /Agent returned a final response/);
  assert.match(out, /3 model rounds/);
  assert.match(out, /2\/100 tool calls/);
  assert.match(out, /Files changed: src\/a\.js, src\/b\.js/);
});
test('formatAgentRunReport falls back to a generic label for unknown stop reasons', () => {
  const out = formatAgentRunReport({ stopReason: '???', steps: 0, toolCalls: 0, toolIssues: 0, changedFiles: new Set(), validations: [] });
  assert.match(out, /Run report: Stopped\./);
});

/* ---------- crash-resilient continuation ---------- */
test('formatAgentRunReport distinguishes a live progress snapshot from a completed run', () => {
  const out = formatAgentRunReport({ stopReason: 'running', steps: 2, toolCalls: 3, toolIssues: 0, changedFiles: new Set(['src/app.js']), validations: [] });
  assert.match(out, /still working/);
  assert.match(out, /saved progress snapshot, not a completion report/);
  assert.doesNotMatch(out, /returned a final response/);
});
test('buildContinuationNote explains an interrupted run and consumes the marker once', () => {
  const sess = { lastRunStop: 'interrupted', lastRunReport: 'Saved progress: 2 rounds, 4 tool calls.' };
  const h = [{ role: 'tool', name: 'run_tests', content: 'PASS 12 tests' }];
  const note = buildContinuationNote(sess, h);
  assert.match(note, /interrupted by an app reload/);
  assert.match(note, /Saved progress: 2 rounds, 4 tool calls/);
  assert.match(note, /run_tests/);
  assert.match(note, /continue that work from where it stopped/i);
  assert.equal(sess.lastRunStop, '', 'continuation state is consumed after injection');
  assert.equal(buildContinuationNote(sess, h), '', 'the same recovery note must not be injected twice');
});
test('completed runs do not generate an interrupted-run continuation note', () => {
  const sess = { lastRunStop: 'completed', lastRunReport: 'Finished.' };
  assert.equal(buildContinuationNote(sess, []), '');
});
