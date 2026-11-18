#!/usr/bin/env node
'use strict';
/* Deterministic tests for strict free-model classification and real thinking request behavior. */
const fs = require('fs');
const vm = require('vm');
/* 3.13.1: the app is split across the entry html + css/ + js/app.js — verify against all of it */
try { require(__dirname + '/tools/build-web.cjs').ensure(); } catch {}
const html = ['my-chat-agent-v3.html', ...fs.readdirSync(__dirname + '/css').sort().map(f => 'css/' + f), 'js/app.js'].map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');
let pass = 0, fail = 0;
const ok = (name, value, detail) => {
  if (value) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); }
};
function block(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Cannot find source block: ' + start + ' -> ' + end);
  return html.slice(a, b);
}
function makeElement(tag) {
  return { tag, children: [], dataset: {}, appendChild(x) { this.children.push(x); }, setAttribute() {}, classList: { toggle() {} } };
}

// Run the real selector functions against a tiny deterministic DOM.
const q = { innerHTML: '', value: '', children: [], appendChild(x) { this.children.push(x); } };
const thinkState = { hidden: true, dataset: {}, textContent: '', title: '' };
const dom = { createElement: makeElement };
const S = { activeId: 'cline', providers: [
  { id: 'cline', name: 'Cline', inputRate: 0, outputRate: 0, models: [
    'recursive/flint-v1.0:free', 'cline/paid-coder', 'model-free', 'model:free-preview', 'model:free:paid', 'UPPER:FREE'
  ], model: 'cline/paid-coder' },
  { id: 'openrouter', name: 'OpenRouter', inputRate: 0, outputRate: 0, models: ['meta/llama:free', 'openrouter/auto'], model: 'meta/llama:free' },
  { id: 'local', name: 'Local Ollama', inputRate: 0, outputRate: 0, models: ['qwen3:8b'], model: 'qwen3:8b' }
] };
const selectorCtx = { S, document: dom, $: id => id === 'provQuick' ? q : null, console };
vm.runInNewContext(block('/* Model selector. Two groups', '/* ---- grouped model menu') + '\nthis.__selector = { fillQuick, isFreeModelId, providerModelIds, modelTier };', selectorCtx);
selectorCtx.__selector.fillQuick();
const groups = Object.fromEntries(q.children.filter(g => g.label).map(g => [g.label.startsWith('Free') ? 'free' : 'paid', g.children.map(o => o.value)]));
ok('only IDs ending exactly in :free enter the Free group', groups.free.length === 3 && groups.free.every(v => /:free$/i.test(v.split('::').slice(1).join('::'))), JSON.stringify(groups));
ok('zero/missing prices do not promote Cline, local, or other models to Free', groups.paid.some(v => v === 'cline::cline/paid-coder') && groups.paid.some(v => v === 'local::qwen3:8b'), JSON.stringify(groups));
ok('the substring free and non-terminal :free variants stay in Paid/other', ['model-free', 'model:free-preview', 'model:free:paid'].every(id => groups.paid.some(v => v.endsWith('::' + id))), JSON.stringify(groups));
ok('active model selection is preserved after grouping', q.value === 'cline::cline/paid-coder', q.value);
ok('groups are labelled Free models / Paid models, with counts', q.children.some(g => g.label === 'Free models (3)') && q.children.some(g => /^Paid models \(\d+\)$/.test(g.label || '')), JSON.stringify(q.children.map(g => g.label)));
ok('CodeSpace Copilot is a single plain entry above the groups', q.children[0] && q.children[0].value === 'copilot::auto' && q.children[0].textContent === 'CodeSpace Copilot', JSON.stringify(q.children[0]));
ok('Chat Z.ai models are Free; a Chat Z.ai provider is not listed while its bridge is OFF', (() => { const z = { id: 'chat-zai-local', chatZai: true, name: 'Chat Z.ai', models: ['glm-4.6'], model: 'glm-4.6' }; return selectorCtx.__selector.modelTier(z, 'glm-4.6') === 'free'; })());
ok('the same rule applies to OpenRouter and other providers', groups.free.includes('openrouter::meta/llama:free') && groups.paid.includes('openrouter::openrouter/auto'), JSON.stringify(groups));

// Run the real reasoning helpers against representative model-catalog payloads.
const statusEl = { hidden: true, dataset: {}, textContent: '', title: '' };
const reasoningCtx = { URL, isChatZaiProvider: p => !!(p && p.chatZai), $: id => id === 'thinkState' ? statusEl : id === 'thinkSel' ? { title: '' } : null, console };
vm.runInNewContext(block('let lastThinkingStatus =', 'const newCallId ='), reasoningCtx);
const h = reasoningCtx;
const openrouter = { id: 'openrouter', base: 'https://openrouter.ai/api/v1', model: 'vendor/reasoner' };
const cline = { id: 'cline', base: 'https://api.cline.bot/api/v1', model: 'cline/reasoner' };
const orSupported = h.normalizeModelReasoningInfo({ id: openrouter.model, reasoning: { supported_efforts: ['low', 'medium', 'high'] } }, openrouter);
const orNoThinking = h.normalizeModelReasoningInfo({ id: 'vendor/chat', supported_parameters: ['temperature', 'max_tokens'] }, openrouter);
const clineUnknown = h.normalizeModelReasoningInfo({ id: cline.model, name: 'Cline model' }, cline);
const clineSupported = h.normalizeModelReasoningInfo({ id: cline.model, supportsReasoning: true }, cline);
ok('OpenRouter reasoning metadata is preserved', orSupported.supported === true && orSupported.efforts.includes('high'), JSON.stringify(orSupported));
ok('OpenRouter catalog without reasoning advertises unsupported effort control', orNoThinking.supported === false, JSON.stringify(orNoThinking));
ok('Cline catalog without capability metadata stays unknown, not falsely disabled', clineUnknown.supported === null, JSON.stringify(clineUnknown));
ok('Cline explicit reasoning capability metadata is recognized', clineSupported.supported === true, JSON.stringify(clineSupported));

// Verify the real model-catalog fetch retains reasoning metadata instead of reducing models to IDs.
const catalogBlock = block('async function listProviderModelCatalog(', '// Fetch and store a saved provider\'s model list');
const catalogCtx = {
  URL, isOpenRouterProvider: h.isOpenRouterProvider, normalizeModelReasoningInfo: h.normalizeModelReasoningInfo,
  buildHeaders: () => ({ 'Content-Type': 'application/json' }),
  provFetch: async () => ({ ok: true, json: async () => ({ data: [
    { id: 'vendor/reasoner', reasoning: { supported_efforts: ['low', 'medium', 'high'] } },
    { id: 'vendor/chat', supported_parameters: ['temperature', 'max_tokens'] }
  ] }) })
};
vm.runInNewContext(catalogBlock + '\nthis.__catalogFetch = listProviderModelCatalog;', catalogCtx);
let catalogResultPromise = catalogCtx.__catalogFetch(openrouter);

openrouter.modelCapabilities = { [openrouter.model]: orSupported };
cline.modelCapabilities = { [cline.model]: clineUnknown };
const orFields = h.buildReasoningFields(openrouter, 'high');
const clineFields = h.buildReasoningFields(cline, 'medium');
ok('OpenRouter receives unified reasoning.effort on Chat Completions', orFields.reasoning && orFields.reasoning.effort === 'high' && !('reasoning_effort' in orFields), JSON.stringify(orFields));
ok('Cline OpenAI-compatible provider receives reasoning_effort', clineFields.reasoning_effort === 'medium', JSON.stringify(clineFields));
let noEffortRejected = false;
try { h.buildReasoningFields({ ...openrouter, modelCapabilities: { [openrouter.model]: orNoThinking } }, 'high'); } catch (e) { noEffortRejected = /not supported/.test(e.message); }
ok('unsupported models are blocked before sending a thinking request', noEffortRejected && statusEl.dataset.state === 'unsupported', statusEl.textContent);
let unsupportedLevelRejected = false;
try { h.buildReasoningFields({ ...openrouter, modelCapabilities: { [openrouter.model]: { supported: true, efforts: ['low', 'medium'] } } }, 'high'); } catch (e) { unsupportedLevelRejected = /Supported levels: low, medium/.test(e.message); }
ok('model-specific supported effort levels are enforced', unsupportedLevelRejected);
let dynamicRouterRejected = false;
try { h.buildReasoningFields({ ...openrouter, model: 'openrouter/free' }, 'high'); } catch (e) { dynamicRouterRejected = /dynamic router/.test(e.message); }
ok('OpenRouter dynamic free router refuses unsupported effort selection', dynamicRouterRejected);

// Execute the real callOpenAI function with a mock transport to inspect requests and fallback behavior.
const callBlock = block('async function callOpenAI(', 'async function callAnthropic(');
async function runOpenAI({ provider, level = 'high', response, error, secondError, sseError, sseData, opts }) {
  let calls = 0, sentBody = null;
  const localStatus = { hidden: true, dataset: {}, textContent: '', title: '' };
  const ctx = {
    S: { temp: 0.2, thinkLevel: level },
    $: id => id === 'thinkState' ? localStatus : id === 'ctxHint' ? { textContent: '' } : null,
    imageKeep: () => new Set(), SUMMARY_PREFIX: '[Summary]\n', stripThink: x => x,
    buildReasoningFields: h.buildReasoningFields, thinkingSupported: h.thinkingSupported, isChatZaiProvider: () => false,
    readSSE: async (_res, onData) => { if (sseError) { const e = new Error(sseError); e.inStream = true; throw e; } onData(sseData || { choices: [{ delta: { content: 'streamed' } }] }); },
    setThinkingStatus: (state, text, title) => { localStatus.dataset.state = state; localStatus.textContent = text; localStatus.title = title || ''; },
    postStream: async (_p, _url, body) => { calls++; sentBody = JSON.parse(JSON.stringify(body)); const fault = calls === 1 ? error : secondError; if (fault) throw Object.assign(new Error(fault.message || 'bad request'), { status: fault.status || 400, body: fault.body || '' }); return response; },
    parseArgs: x => ({ args: {}, bad: false }), newCallId: () => 'call_test', console, URL
  };
  vm.runInNewContext(callBlock + '\nthis.__callOpenAI = callOpenAI;', ctx);
  let result = null, thrown = null;
  try { result = await ctx.__callOpenAI(provider, '', [{ role: 'user', content: 'test' }], [], null, null, opts || null); } catch (e) { thrown = e; }
  return { calls, sentBody, result, thrown, status: localStatus };
}
// 3.18.3: the Think control is shown only when the active model supports a thinking mode.
const ts = h.thinkingSupported;
ok('Think is shown for a model whose catalog advertises reasoning', ts({ ...openrouter, modelCapabilities: { [openrouter.model]: orSupported } }) === true);
ok('Think is hidden for a model whose catalog says it has no reasoning', ts({ ...openrouter, model: 'vendor/chat', modelCapabilities: { 'vendor/chat': orNoThinking } }) === false);
ok('Think is hidden for an unknown model whose name is not a known reasoning family', ts({ id: 'x', base: 'http://127.0.0.1:8080/v1', model: 'llama-3.1-8b-instruct' }) === false);
ok('Think is shown for well-known reasoning families when the catalog is silent', ['o3-mini', 'gpt-5', 'deepseek-r1', 'qwen3.8-flash', 'qwq-32b', 'gemini-2.5-pro', 'glm-4.6'].every(m => ts({ id: 'x', base: 'http://x/v1', model: m }) === true));
ok('Think is shown for Chat Z.ai and Anthropic-format providers', ts({ chatZai: true, model: 'any' }) === true && ts({ id: 'a', format: 'anthropic', model: 'claude-x' }) === true);
ok('Think is hidden for the OpenRouter dynamic routers', ts({ ...openrouter, model: 'openrouter/auto' }) === false);
ok('Think is hidden while OpenCode CLI answers', (() => { const c = { URL, isChatZaiProvider: () => false, console, $: () => null, S: { openCodeCLI: true } }; vm.runInNewContext(block('let lastThinkingStatus =', 'const newCallId =') + '\nthis.f = thinkingSupported;', c); return c.f({ id: 'x', model: 'o3' }) === false; })());
ok('the composer status span is never shown', (() => { const el = { hidden: false, dataset: {}, textContent: '', title: '' }; const c = { URL, isChatZaiProvider: () => false, console, $: id => id === 'thinkState' ? el : id === 'thinkSel' ? { title: '' } : null }; vm.runInNewContext(block('let lastThinkingStatus =', 'const newCallId =') + '\nthis.f = setThinkingStatus;', c); c.f('confirmed', 'Think: high · reasoning returned', 'x'); return el.hidden === true; })());
const jsonResponse = usage => ({ headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'ok', reasoning: 'reasoning-token-stream' } }], usage: usage || { prompt_tokens: 5, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } } }) });
(async () => {
  const catalogResult = await catalogResultPromise;
  ok('model catalogue fetch stores IDs and per-model thinking capabilities', catalogResult.ids.length === 2 && catalogResult.modelCapabilities['vendor/reasoner'].supported === true && catalogResult.modelCapabilities['vendor/chat'].supported === false, JSON.stringify(catalogResult));
  const orRun = await runOpenAI({ provider: { ...openrouter, modelCapabilities: { [openrouter.model]: orSupported }, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, response: jsonResponse() });
  ok('actual OpenRouter chat request carries reasoning.effort', orRun.sentBody && orRun.sentBody.reasoning && orRun.sentBody.reasoning.effort === 'high' && !orRun.sentBody.reasoning_effort, JSON.stringify(orRun.sentBody));
  ok('returned reasoning tokens/content are reported as confirmed', orRun.status.dataset.state === 'confirmed', JSON.stringify(orRun.status));
  const clRun = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, level: 'medium', response: jsonResponse() });
  ok('actual Cline provider request carries reasoning_effort', clRun.sentBody && clRun.sentBody.reasoning_effort === 'medium', JSON.stringify(clRun.sentBody));
  const overrideRun = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '{\"reasoning_effort\":\"low\"}' }, level: 'high', response: jsonResponse() });
  ok('selected Think level overrides conflicting extraBody fields', overrideRun.sentBody && overrideRun.sentBody.reasoning_effort === 'high');
  const clineStream = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, level: 'medium', response: { headers: { get: () => 'text/event-stream' }, body: {} }, sseData: { choices: [{ delta: { reasoning: 'reasoning returned by Cline', content: 'ok' } }] } });
  ok('Cline streamed delta.reasoning confirms reasoning data was returned', clineStream.status.dataset.state === 'confirmed' && /reasoning returned/.test(clineStream.status.textContent));
  const clineReasoningDetails = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, level: 'low', response: { headers: { get: () => 'text/event-stream' }, body: {} }, sseData: { choices: [{ delta: { reasoning_details: [{ type: 'encrypted', data: 'opaque' }], content: 'ok' } }] } });
  ok('Cline reasoning_details are recognized without exposing encrypted content', clineReasoningDetails.status.dataset.state === 'confirmed' && !String(clineReasoningDetails.result && clineReasoningDetails.result.reasoning).includes('opaque'));
  const offRun = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '{\"reasoning_effort\":\"low\",\"reasoning\":{\"effort\":\"low\"}}' }, level: 'off', response: jsonResponse({ prompt_tokens: 5, completion_tokens: 8 }) });
  ok('Think Off sends no reasoning-control field', offRun.sentBody && !('reasoning_effort' in offRun.sentBody) && !('reasoning' in offRun.sentBody));
  const rejected = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, error: { status: 400, body: 'reasoning_effort is not supported for this model' } });
  ok('provider rejection is surfaced and never silently retried without thinking', rejected.calls === 1 && !!rejected.thrown && /Thinking was not applied/.test(rejected.thrown.message) && rejected.status.dataset.state === 'unsupported', JSON.stringify({ calls: rejected.calls, error: rejected.thrown && rejected.thrown.message, state: rejected.status.dataset.state }));
  const combinedReject = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, error: { status: 400, body: 'stream_options is not supported' }, secondError: { status: 400, body: 'reasoning_effort is unsupported for this model' } });
  ok('reasoning rejection after stream_options compatibility retry is surfaced without another retry', combinedReject.calls === 2 && !!combinedReject.thrown && combinedReject.status.dataset.state === 'unsupported');
  const streamRejected = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, sseError: 'reasoning_effort is unsupported for this model', response: { headers: { get: () => 'text/event-stream' }, body: {} } });
  ok('HTTP 200 SSE reasoning-parameter rejection is non-retryable and clearly reported', !!streamRejected.thrown && streamRejected.thrown.nonRetryable && streamRejected.status.dataset.state === 'unsupported');
  const advisory = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, level: 'high', opts: { maxTokens: 800 }, response: jsonResponse({ prompt_tokens: 5, completion_tokens: 8 }) });
  ok('capped advisory calls skip extended thinking for lower latency', advisory.sentBody && !('reasoning_effort' in advisory.sentBody));
  const unverified = await runOpenAI({ provider: { ...cline, format: 'openai', path: '/chat/completions', key: 'test', auth: 'bearer', extra: '', extraBody: '' }, response: { headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 4 } }) } });
  ok('missing reasoning output is labelled unverified, not falsely confirmed', unverified.status.dataset.state === 'warning' && /not verified/.test(unverified.status.textContent));
  console.log(`\nModel/thinking verification: ${pass} passed, ${fail} failed.`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
