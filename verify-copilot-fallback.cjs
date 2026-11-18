'use strict';
/* CodeSpace Copilot: automatic model fallback. No cooldown / no time limit: on a limit the next model is tried at once. */
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const src = fs.readFileSync('src-js/10-model-adapters.js', 'utf8');
const start = src.indexOf('const TRANSIENT_RE ='), end = src.indexOf('/* ================= compress context ================= */', start);
assert.ok(start >= 0 && end > start, 'fallback implementation block exists');
let block = src.slice(start, end);
/* real tier classification from the model-selector source */
const sel = fs.readFileSync('src-js/07-meters-approvals.js', 'utf8');
const tierSrc = sel.slice(sel.indexOf('const FREE_MODEL_ID'), sel.indexOf('function providerModelIds'));
assert.ok(tierSrc.includes('function modelTier'), 'modelTier exists in the model selector');
block = block.replace('const COPILOT_STALL_MS = 60000;', 'const COPILOT_STALL_MS = 40;'); // fast stall test
assert.ok(!/COOLDOWN|cooldown/.test(block), 'no cooldown / time limit remains in the fallback code');

function world(providers, behavior, extraState) {
  const ui = { textContent: '' }, calls = [], sleeps = [];
  const w = {
    S: Object.assign({ providers, copilotAuto: true }, extraState || {}), // tests run with CodeSpace Copilot selected unless a test says otherwise
    Date, Map, Set, String, Number, Error, DOMException, Math, setTimeout, clearTimeout,
    URL, AbortController, JSON, Array, Object, Promise, RegExp, notes: [],
    addNote: t => w.notes.push(t),
    isChatZaiProvider: p => !!(p && (p.chatZai === true || p.providerKey === 'chat-zai' || p.id === 'chat-zai' || p.id === 'chat-zai-local')),
    allToolDefs: () => [], normalizeToolName: n => n, normalizeArgs: (_n, a) => a,
    maActivityState: { visible: false }, $: () => ui, feedPush: () => null, feedEnd: () => {},
    sleepAbortable: async ms => { sleeps.push(ms); },
    callOpenAI: async (p, _s, _h, _t, signal) => { calls.push(p.model); return behavior(p, calls, signal); },
    callAnthropic: async p => { calls.push(p.model); return { text: 'OK from ' + p.model, toolCalls: [] }; }
  };
  const ctx = vm.createContext(w);
  vm.runInContext(tierSrc + '\n' + block + '\nthis.api = { callModel, copilotPool, freeFallbackEligible, reset: () => { COPILOT_LAST_OK = ""; }, last: () => COPILOT_LAST_OK };', ctx);
  return { api: ctx.api, w, ui, calls, sleeps };
}
const ok = p => ({ text: 'OK from ' + p.model, toolCalls: [], usage: { input: 1, output: 1 } });
const fail = (message, status, inStream) => { const e = new Error(message); if (status) e.status = status; if (inStream) e.inStream = true; return e; };
const prov = () => [
  { id: 'p1', name: 'OpenRouter', format: 'openai', model: 'v/one:free', models: ['v/one:free', 'v/two:free', 'v/paid'] },
  { id: 'p2', name: 'Groq', format: 'openai', model: 'v/three:free', models: ['v/three:free'] },
  { id: 'p3', name: 'Paid', format: 'openai', model: 'v/four', models: ['v/four:freeish'] },
  { id: 'chat-zai-local', name: 'Chat Z.ai (local bridge)', format: 'openai', chatZai: true, model: 'glm-x', models: ['glm-x'] }
];
const run = (t, p) => t.api.callModel(p || t.w.S.providers[0], '', [], [], null, null, null);

(async () => {
  let t = world(prov(), ok);
  assert.deepEqual(Array.from(t.api.copilotPool(t.w.S.providers[0]), c => c.model), ['v/one:free', 'v/two:free', 'v/three:free']);
  t = world(prov(), ok, { chatZaiCLI: true });
  assert.deepEqual(Array.from(t.api.copilotPool(t.w.S.providers[0]), c => c.model), ['v/one:free', 'v/two:free', 'v/three:free', 'glm-x']);
  console.log('PASS pool = :free models of every provider (+ Chat Z.ai only while its bridge is ON); paid and :freeish excluded');

  const el = t.api.freeFallbackEligible;
  assert.equal(el({ status: 429, message: 'rate limited' }), true);
  assert.equal(el({ status: 402, message: 'quota exceeded' }), true);
  assert.equal(el({ status: 403, message: 'daily quota exceeded' }), true);
  assert.equal(el({ status: 404, message: 'model not found' }), true);
  assert.equal(el({ status: 500, message: 'server error' }), true);
  assert.equal(el({ message: 'server busy, please try again', inStream: true }), true);
  assert.equal(el({ message: 'network error', inStream: true }), true);
  assert.equal(el({ status: 401, message: 'invalid API key' }), false);
  assert.equal(el({ status: 403, message: 'forbidden: invalid API key' }), false);
  assert.equal(el({ name: 'AbortError', status: 429 }), false);
  assert.equal(el({ status: 429, nonRetryable: true, message: 'x' }), false);
  console.log('PASS limit/overload/unavailable errors switch model; auth errors, non-retryable errors and Stop do not');

  // immediate switch, no waiting
  t = world(prov(), (p, calls) => { if (p.model === 'v/one:free') throw fail('rate limit', 429); return ok(p); });
  let r = await run(t);
  assert.equal(r.text, 'OK from v/two:free'); assert.equal(r.providerUsed.model, 'v/two:free');
  assert.equal(t.sleeps.length, 0, 'no waiting before switching');
  assert.match(t.ui.textContent, /CodeSpace Copilot · Active: OpenRouter · v\/two:free/);
  console.log('PASS limit reached -> next available model is used immediately (zero waiting), actual model reported');

  // no time limit: the limited model is not locked out, and the working one is tried first next time without any timer
  t.calls.length = 0; r = await run(t);
  assert.equal(t.calls[0], 'v/two:free'); assert.equal(r.text, 'OK from v/two:free');
  t.w.S.providers[0].behaviorFixed = true; t.api.reset();
  t = world(prov(), ok);
  r = await run(t); assert.equal(t.calls[0], 'v/one:free', 'recovered model is used again as soon as it is selected, no cooldown');
  console.log('PASS no cooldown/time limit anywhere; the last working model is tried first, a reset model is used again at once');

  // every model limited -> clear error, and no lockout afterwards
  let limited = true;
  t = world(prov(), p => { if (limited) throw fail('rate limit hit', 429); return ok(p); });
  await assert.rejects(() => run(t), /CodeSpace Copilot tried 3 models/);
  assert.equal(t.calls.length, 3, 'each model tried exactly once');
  limited = false; t.calls.length = 0; t.api.reset();
  r = await run(t); assert.equal(r.text, 'OK from v/one:free'); assert.equal(t.calls.length, 1);
  console.log('PASS all models limited -> clear error; next request works at once when a model recovers (no lockout)');

  // single free model: never locked out, normal retry path
  const single = [{ id: 'a', name: 'OR', format: 'openai', model: 'x/one:free', models: ['x/one:free'] }];
  let n = 0;
  t = world(single, p => { n++; if (n === 1) throw fail('overloaded, try again', 0, true); return ok(p); });
  r = await run(t); assert.equal(r.text, 'OK from x/one:free'); assert.equal(t.sleeps.length, 1);
  n = 0; t = world(single, p => { n++; throw fail('rate limit', 429); });
  await assert.rejects(() => run(t)); const first = t.calls.length;
  await assert.rejects(() => run(t)); assert.ok(t.calls.length > first, 'second request still reaches the provider');
  console.log('PASS single free model: in-stream errors retry with backoff; a 429 never causes a lockout');

  // in-stream transient errors on free models switch model
  for (const msg of ['server busy, please try again', 'network error', 'request timed out']) {
    t = world(prov(), (p, c) => { if (c.length === 1) throw fail(msg, 0, true); return ok(p); });
    r = await run(t); assert.equal(r.text, 'OK from v/two:free', msg);
  }
  console.log('PASS in-stream busy / network / timeout errors switch to the next model');

  // paid model selected, not in auto mode: no fallback (never silently switches paid <-> free)
  t = world([{ id: 'a', name: 'OR', format: 'openai', model: 'x/paid', models: ['x/paid', 'x/two:free'] }], p => { throw fail('rate limit', 429); });
  await assert.rejects(() => run(t)); assert.deepEqual(t.calls.filter(x => x === 'x/two:free'), []);
  // auth failure on one provider moves on (an unconfigured provider must not kill the pool); if every model
  // rejects the key, the key problem itself is what gets reported
  t = world(prov(), p => { throw fail('invalid API key', 401); });
  await assert.rejects(() => run(t), /invalid API key/); assert.equal(t.calls.length, 3);
  t = world(prov(), p => { if (p.id === 'p1') throw fail('invalid API key', 401); return ok(p); });
  r = await run(t); assert.equal(r.text, 'OK from v/three:free');
  console.log('PASS paid model selected -> no automatic switch; bad key on one provider -> next provider; all bad -> key error reported');

  // CodeSpace Copilot (auto) selected from the model list
  t = world(prov(), (p, c) => { if (p.model === 'v/one:free') throw fail('rate limit', 429); return ok(p); }, { copilotAuto: true });
  r = await run(t, t.w.S.providers[0]); assert.equal(r.text, 'OK from v/two:free');
  console.log('PASS CodeSpace Copilot selected -> switches across available models');

  // 3.13.21 regressions ------------------------------------------------------------
  // gateway in-stream error with the status in error.code only and a generic message
  t = world(prov(), (p, c) => { if (c.length === 1) { const e = new Error('Provider returned error'); e.inStream = true; throw e; } return ok(p); });
  r = await run(t); assert.equal(r.text, 'OK from v/two:free');
  // empty (HTTP 200) reply switches instead of ending the turn
  t = world(prov(), (p, c) => c.length === 1 ? { text: '', toolCalls: [], reasoning: '' } : ok(p));
  r = await run(t); assert.equal(r.text, 'OK from v/two:free');
  // a model that never answers is abandoned after the stall limit
  t = world(prov(), (p, c, signal) => c.length === 1 ? new Promise((_res, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) : ok(p));
  r = await run(t); assert.equal(r.text, 'OK from v/two:free');
  // 400 (request shape / unsupported tools on one free model) also moves on
  t = world(prov(), (p, c) => { if (c.length === 1) throw fail('Server returned 400: tools are not supported', 400); return ok(p); });
  r = await run(t); assert.equal(r.text, 'OK from v/two:free');
  // switching is announced once in the chat
  assert.ok(t.w.notes.some(n => /CodeSpace Copilot switched to OpenRouter · v\/two:free/.test(n)));
  // auto mode with a PAID active model: the paid model is not part of the pool
  t = world([{ id: 'a', name: 'P', format: 'openai', model: 'x/paid', models: ['x/paid', 'x/a:free', 'x/b:free'] }], ok, { copilotAuto: true });
  assert.deepEqual(Array.from(t.api.copilotPool(t.w.S.providers[0]), c => c.model), ['x/a:free', 'x/b:free']);
  // local endpoints are NOT free by ID (3.12.9 rule) and never enter the pool
  t = world([{ id: 'l', name: 'Ollama', format: 'openai', base: 'http://localhost:11434/v1', model: 'llama3', models: ['llama3'] }, { id: 'a', name: 'OR', format: 'openai', base: 'https://openrouter.ai/api/v1', model: 'x/a:free', models: ['x/a:free'] }], ok);
  assert.deepEqual(Array.from(t.api.copilotPool(t.w.S.providers[1]), c => c.model), ['x/a:free']);
  console.log('PASS in-stream gateway errors, empty replies, stalls and 400s switch model; paid active excluded; local models stay out');

  // quota exhaustion: skip the rest of that provider, move to another provider, report separately when all are out
  const quota = () => fail('Quota exceeded {"error":{"code":"insufficient_quota"}}', 429);
  t = world(prov(), p => { if (p.id === 'p1') throw quota(); return ok(p); });
  r = await run(t); assert.equal(r.text, 'OK from v/three:free'); assert.deepEqual(t.calls, ['v/one:free', 'v/three:free'], 'second model of the exhausted provider is skipped');
  t = world([{ id: 'w', name: 'WUSROUTER', format: 'openai', model: 'a:free', models: ['a:free', 'b:free', 'c:free'] }], () => { throw quota(); });
  await assert.rejects(() => run(t), e => e.quotaExhausted === true && /Quota exhausted for WUSROUTER/.test(e.message) && e.transient === false);
  assert.equal(t.calls.length, 1, 'one request, not one per model');
  console.log('PASS quota exhaustion skips that provider, switches provider, and is reported as quota (not "temporarily unavailable")');

  // 3.13.22: a model picked by hand never switches; only the explicit CodeSpace Copilot choice does
  t = world(prov(), (p, c) => { throw fail('rate limit', 429); }, { copilotAuto: false });
  await assert.rejects(() => run(t), /rate limit/);
  assert.deepEqual(t.calls.filter(x => x !== 'v/one:free'), [], 'hand-picked free model: no other model is ever tried');
  t = world(prov(), ok, { copilotAuto: false });
  r = await run(t); assert.equal(r.text, 'OK from v/one:free'); assert.deepEqual(t.calls, ['v/one:free']);
  assert.ok(!t.w.notes.some(n => /Copilot/.test(n)), 'no Copilot note while Copilot is not selected');
  // Copilot selected: paid models are never tried, not even as a last resort
  t = world([{ id: 'a', name: 'P', format: 'openai', model: 'x/a:free', models: ['x/paid1', 'x/a:free', 'x/paid2', 'x/b:free'] }], () => { throw fail('rate limit', 429); });
  await assert.rejects(() => run(t));
  assert.deepEqual(t.calls.sort(), ['x/a:free', 'x/b:free'], 'only free models are tried');
  console.log('PASS Copilot works only when selected; a hand-picked model is never swapped; paid models are never tried as fallback');

  // Stop is never a fallback event
  const ab = new Error('stop'); ab.name = 'AbortError'; ab.status = 429;
  t = world(prov(), () => { throw ab; });
  await assert.rejects(() => run(t)); assert.equal(t.calls.length, 1);
  console.log('PASS user cancellation never triggers a switch');
  console.log('\nCodeSpace Copilot fallback: checks passed');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
