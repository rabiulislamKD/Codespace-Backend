'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const z = require('../chat-zai-proxy.js');

test('tool results, tool calls, arrays and developer role are flattened to plain turns', () => {
  const m = z.normalizeMessages([
    { role: 'developer', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read_file', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file body' },
    { role: 'assistant', content: '   ' }
  ]);
  assert.deepEqual(m.map(x => x.role), ['system', 'user', 'assistant', 'user']);
  assert.match(m[1].content, /^hi\n\[image omitted/);
  assert.match(m[2].content, /read_file/);
  assert.match(m[3].content, /^\[Tool result\]\nfile body$/);
});
test('the latest user turn is the signed prompt', () => {
  const m = z.normalizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  assert.equal(z.promptFor(m), 'a');
  assert.equal(z.promptFor([]), '');
});
test('empty input yields no messages', () => {
  assert.deepEqual(z.normalizeMessages(null), []);
  assert.deepEqual(z.normalizeMessages([{ role: 'user', content: '' }]), []);
});
