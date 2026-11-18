'use strict';
/* Unit tests for src-js/10-model-adapters.js — provider detection, reasoning
 * ("Think") capability handling and the SSE response-stream parser.
 * Real fragment code in a vm sandbox. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFragments } = require('./helpers/load.cjs');

const { isOpenRouterProvider, normalizeModelReasoningInfo, buildReasoningFields, readSSE } =
  loadFragments(['01-core-helpers-state.js', '10-model-adapters.js'],
    ['isOpenRouterProvider', 'normalizeModelReasoningInfo', 'buildReasoningFields', 'readSSE']);

/* ---------- isOpenRouterProvider ---------- */
test('isOpenRouterProvider detects OpenRouter by base URL host', () => {
  assert.equal(isOpenRouterProvider({ base: 'https://openrouter.ai/api/v1' }), true);
  assert.equal(isOpenRouterProvider({ base: 'https://api.openrouter.ai/v1' }), true);
  assert.equal(isOpenRouterProvider({ base: 'https://openrouter.ai.evil.example' }), false);
  assert.equal(isOpenRouterProvider({ base: 'https://example.com/v1' }), false);
});
test('isOpenRouterProvider falls back to the provider id when base is missing/invalid', () => {
  assert.equal(isOpenRouterProvider({ id: 'openrouter' }), true);
  assert.equal(isOpenRouterProvider({}), false);
  assert.ok(!isOpenRouterProvider(null), 'null provider is not OpenRouter (returns falsy)');
});

/* ---------- normalizeModelReasoningInfo ---------- */
test('normalizeModelReasoningInfo returns unknown for missing/uncatalogued models', () => {
  const r = normalizeModelReasoningInfo(null, null);
  assert.equal(JSON.stringify(r), JSON.stringify({ catalogued: true, supported: null, efforts: null }));
});
test('normalizeModelReasoningInfo reads explicit flags in all spellings', () => {
  assert.equal(normalizeModelReasoningInfo({ supportsReasoning: true }).supported, true);
  assert.equal(normalizeModelReasoningInfo({ supports_reasoning: true }).supported, true);
  assert.equal(normalizeModelReasoningInfo({ reasoning_supported: false }).supported, false);
  assert.equal(normalizeModelReasoningInfo({ reasoning: false }).supported, false);
  assert.equal(normalizeModelReasoningInfo({ capabilities: { reasoning: true } }).supported, true);
});
test('normalizeModelReasoningInfo derives support from capability arrays and parameters', () => {
  assert.equal(normalizeModelReasoningInfo({ capabilities: ['reasoning', 'tools'] }).supported, true);
  assert.equal(normalizeModelReasoningInfo({ capabilities: ['tools'] }).supported, false,
    'a catalogued capabilities list without reasoning means definitively unsupported');
  assert.equal(normalizeModelReasoningInfo({ supported_parameters: ['tools', 'reasoning_effort'] }).supported, true);
});
test('normalizeModelReasoningInfo: OpenRouter models without metadata cannot reason', () => {
  const r = normalizeModelReasoningInfo({}, { base: 'https://openrouter.ai/api/v1' });
  assert.equal(r.supported, false, 'OpenRouter documents: no reasoning metadata = no controllable reasoning');
});
test('normalizeModelReasoningInfo extracts supported effort levels', () => {
  const r = normalizeModelReasoningInfo({ reasoning: { supported_efforts: ['low', 'high'] } });
  assert.equal(r.supported, true);
  assert.deepEqual(r.efforts, ['low', 'high']);
  const r2 = normalizeModelReasoningInfo({ supportedEfforts: ['medium'] });
  assert.deepEqual(r2.efforts, ['medium']);
});

/* ---------- buildReasoningFields ---------- */
const plain = { base: 'https://api.example.com/v1', model: 'model-x' };
const orouter = { base: 'https://openrouter.ai/api/v1', model: 'vendor/model-x' };

test('buildReasoningFields returns {} for off/invalid levels', () => {
  assert.deepEqual({ ...buildReasoningFields(plain, 'off') }, {});
  assert.deepEqual({ ...buildReasoningFields(plain, 'banana') }, {});
});
test('buildReasoningFields uses reasoning_effort for plain OpenAI-compatible providers', () => {
  const f = buildReasoningFields(plain, 'medium');
  assert.equal(JSON.stringify(f), '{"reasoning_effort":"medium"}');
});
test('buildReasoningFields uses the unified reasoning object for OpenRouter', () => {
  const f = buildReasoningFields(orouter, 'high');
  assert.equal(JSON.stringify(f), '{"reasoning":{"effort":"high"}}');
});
test('buildReasoningFields throws for models catalogued as non-reasoning', () => {
  const p = { ...plain, modelCapabilities: { 'model-x': { supported: false } } };
  assert.throws(() => buildReasoningFields(p, 'medium'), /not supported by the selected model/);
});
test('buildReasoningFields throws when the level is outside the advertised efforts', () => {
  const p = { ...plain, modelCapabilities: { 'model-x': { supported: true, efforts: ['low'] } } };
  assert.throws(() => buildReasoningFields(p, 'high'), /Supported levels: low/);
});
test('buildReasoningFields throws for OpenRouter free/auto dynamic routers', () => {
  const p = { base: 'https://openrouter.ai/api/v1', model: 'openrouter/free' };
  assert.throws(() => buildReasoningFields(p, 'low'), /dynamic router/);
});

/* ---------- readSSE — the response-stream parser used by every provider ---------- */
const enc = new TextEncoder();
function fakeStream(chunks, failAt) {
  let i = 0;
  return {
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        return {
          read: async () => {
            if (failAt != null && i === failAt) throw new Error('connection reset');
            return i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true };
          },
        };
      },
    },
  };
}

test('readSSE parses JSON data lines split across chunk boundaries', async () => {
  const got = [];
  await readSSE(fakeStream(['data: {"choices":[{"delta":{"con', 'tent":"Hi"}}]}\n\ndata: [DONE]\n\n']),
    j => got.push(j), undefined);
  assert.equal(got.length, 1);
  assert.equal(got[0].choices[0].delta.content, 'Hi');
});

test('readSSE skips comments, [DONE] and invalid JSON, and handles CRLF', async () => {
  const got = [];
  await readSSE(fakeStream(['event: ping\r\ndata: not json\r\ndata: {"j":1}\r\ndata: [DONE]\r\n']),
    j => got.push(j), undefined);
  assert.equal(got.length, 1);
  assert.equal(got[0].j, 1, 'vm-parsed objects are cross-realm, so compare primitives');
});

test('readSSE parses several events buffered in one chunk', async () => {
  const got = [];
  await readSSE(fakeStream(['data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\n']), j => got.push(j), undefined);
  assert.deepEqual(got.map(x => x.n), [1, 2, 3]);
});

test('readSSE tags mid-stream connection failures as retryable (inStream)', async () => {
  await assert.rejects(
    () => readSSE(fakeStream(['data: {"a":1}\n\n'], 1), () => {}, undefined),
    e => e.inStream === true && /connection reset/.test(e.message)
  );
});

test('readSSE throws AbortError when the signal aborted during the stream', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => readSSE(fakeStream(['data: {"a":1}\n\n']), () => {}, ctrl.signal),
    e => e.name === 'AbortError'
  );
});
