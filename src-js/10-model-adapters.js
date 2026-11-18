const isChatZaiProvider = p => !!(p && (p.chatZai === true || p.providerKey === 'chat-zai' || p.id === 'chat-zai' || p.id === 'chat-zai-local'));
const RELAY_HOSTS = new Set();
async function relayFetch(url, init) {
  const r = await fetch(L.bridgeUrl.replace(/\/+$/, '') + '/llm/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + L.bridgeToken }, body: JSON.stringify({ url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body != null ? String(init.body) : undefined }), signal: init && init.signal });
  if (r.headers.get('X-Codespace-Proxy-Error')) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'The bridge could not reach the provider.'); }
  return r;
}
async function nativeAndroidFetch(url, init) {
  const bridge = window.CodeSpaceNative;
  if (!bridge || typeof bridge.startNativeHttp !== 'function' || typeof ReadableStream !== 'function') return null;
  if (init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const id = 'native_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  const headers = {}; if (init.headers && typeof init.headers.forEach === 'function') init.headers.forEach((v, k) => { headers[k] = v; }); else Object.assign(headers, init.headers || {});
  let resolveHeaders, rejectHeaders, streamController, settled = false;
  const headerPromise = new Promise((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
  const responseStream = new ReadableStream({
    start(controller) { streamController = controller; },
    cancel() { try { bridge.cancelNativeHttp(id); } catch {} }
  });
  const onMessage = event => {
    const d = event && event.detail; if (!d || d.id !== id) return;
    if (d.type === 'headers') {
      settled = true;
      const h = new Headers(); Object.entries(d.headers || {}).forEach(([k,v]) => h.set(k, String(v)));
      resolveHeaders(new Response(responseStream, { status: Number(d.status) || 200, statusText: d.statusText || '', headers: h }));
    } else if (d.type === 'chunk') {
      try { const raw = atob(d.data || ''); const bytes = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) bytes[i] = raw.charCodeAt(i); streamController.enqueue(bytes); }
      catch (e) { try { streamController.error(e); } catch {} }
    } else if (d.type === 'done' || d.type === 'cancelled') {
      window.removeEventListener('codespace-native-http', onMessage);
      if (init.signal) init.signal.removeEventListener('abort', abort);
      try { streamController.close(); } catch {}
      if (!settled) { settled = true; rejectHeaders(new Error('Native request ended before response headers.')); }
    } else if (d.type === 'error') {
      window.removeEventListener('codespace-native-http', onMessage);
      if (init.signal) init.signal.removeEventListener('abort', abort);
      const error = new Error(d.message || 'Native network request failed');
      if (!settled) { settled = true; rejectHeaders(error); }
      try { streamController.error(error); } catch {}
    }
  };
  window.addEventListener('codespace-native-http', onMessage);
  const abort = () => { try { bridge.cancelNativeHttp(id); } catch {} window.removeEventListener('codespace-native-http', onMessage); const e = new DOMException('Aborted', 'AbortError'); if (!settled) { settled = true; rejectHeaders(e); } try { streamController.error(e); } catch {} };
  if (init.signal) { if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true }); }
  try { if (!(init.signal && init.signal.aborted)) bridge.startNativeHttp(id, String(url), JSON.stringify(headers), String(init.body || '')); }
  catch (e) { window.removeEventListener('codespace-native-http', onMessage); if (init.signal) init.signal.removeEventListener('abort', abort); if (!settled) { settled = true; rejectHeaders(e); } }
  return await headerPromise;
}
async function provFetch(url, init) {
  if (String(init && init.method || 'GET').toUpperCase() === 'POST' && window.CodeSpaceNative && typeof window.CodeSpaceNative.startNativeHttp === 'function') {
    const nativeResponse = await nativeAndroidFetch(url, init || {});
    if (nativeResponse) return nativeResponse;
  }
  let host = '', https = false; try { const u = new URL(url); host = u.host; https = u.protocol === 'https:'; } catch {}
  const canRelay = B.ok && https && !/^(localhost|127\.|\[::1\])/i.test(host);
  if (canRelay && RELAY_HOSTS.has(host)) return relayFetch(url, init);
  try { return await fetch(url, init); }
  catch (e) { if ((e && e.name === 'AbortError') || !canRelay) throw e; RELAY_HOSTS.add(host); return relayFetch(url, init); }
}
function buildHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.format === 'anthropic') { h['anthropic-version'] = '2023-06-01'; h['anthropic-dangerous-direct-browser-access'] = 'true'; if (p.key) h['x-api-key'] = p.key; }
  else if (p.key) { if (p.auth === 'bearer') h.Authorization = 'Bearer ' + p.key; else if (p.auth === 'x-api-key') h['x-api-key'] = p.key; else if (p.auth === 'header' && p.authHeader) h[p.authHeader] = p.key; }
  if (p.extra && p.extra.trim()) Object.assign(h, JSON.parse(p.extra));
  // Keep the local Chat Z.ai adapter bound to the current bridge token even if custom headers exist.
  if (isChatZaiProvider(p) && L.bridgeToken) h.Authorization = 'Bearer ' + L.bridgeToken;
  return h;
}
let lastThinkingStatus = { state: 'off', text: '' };
function setThinkingStatus(state, text, title) {
  lastThinkingStatus = { state: state || 'off', text: String(text || '') };
  const el = typeof $ === 'function' ? $('thinkState') : null;
  if (!el) return;
  // 3.18.3: the composer no longer shows status text. The detail lives in the Think selector's tooltip.
  el.hidden = true;
  el.dataset.state = state || 'off';
  el.textContent = String(text || '');
  el.title = title || String(text || '');
  const sel = $('thinkSel');
  if (sel) sel.title = text ? text + (title ? ' — ' + title : '') : 'Thinking level: how much the model reasons before answering. Deep is smartest but slowest.';
}
/* 3.18.3: does the active model support a thinking / reasoning mode? Drives whether the Think control is shown
   at all and whether a reasoning parameter is ever sent. Order: explicit catalog data, then provider type,
   then well-known reasoning model names. Anything else is treated as "no thinking mode". */
const REASONING_NAME_RE = /(^|[\/:_\-. ])(o[134](-|$)|gpt-5|gpt-oss|r1|reason|think|qwq|qwen3|gemini-(2\.5|3)|grok-[34]|glm-(4\.[5-9]|[5-9])|kimi-k2|magistral|deepseek-(r|v3\.[12]|v4)|minimax-m|hermes-4|sonar-reasoning)/i;
function thinkingSupported(p) {
  if (!p) return false;
  if (typeof S !== 'undefined' && S.openCodeCLI) return false;               // OpenCode handles its own reasoning
  if (isChatZaiProvider(p)) return true;                                       // Chat Z.ai has its own thinking switch
  if (p.format === 'anthropic') return true;                                   // extended thinking
  if (isOpenRouterProvider(p) && /^openrouter\/(?:free|auto)$/i.test(String(p.model || ''))) return false;
  const info = modelReasoningInfo(p);
  if (info) {
    if (info.supported === false) return false;
    if (info.supported === true || (Array.isArray(info.efforts) && info.efforts.length)) return true;
  }
  return REASONING_NAME_RE.test(String(p.model || ''));
}
function isOpenRouterProvider(p) {
  try { return /(^|\.)openrouter\.ai$/i.test(new URL(p.base || '').hostname); } catch { return p && p.id === 'openrouter'; }
}
function normalizeModelReasoningInfo(m, provider) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { catalogued: true, supported: null, efforts: null };
  const reasoning = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null;
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.map(String) : Array.isArray(m.supportedParameters) ? m.supportedParameters.map(String) : null;
  const explicit = typeof m.supportsReasoning === 'boolean' ? m.supportsReasoning
    : typeof m.supports_reasoning === 'boolean' ? m.supports_reasoning
    : typeof m.reasoning_supported === 'boolean' ? m.reasoning_supported
    : typeof m.reasoning === 'boolean' ? m.reasoning
    : (m.capabilities && typeof m.capabilities.reasoning === 'boolean') ? m.capabilities.reasoning
    : null;
  let supported = explicit;
  if (supported === null && Array.isArray(m.capabilities)) supported = m.capabilities.map(String).some(x => x.toLowerCase() === 'reasoning');
  if (supported === null && reasoning) supported = true;
  if (supported === null && params) supported = params.some(x => ['reasoning', 'reasoning_effort', 'thinking'].includes(x.toLowerCase()));
  // OpenRouter documents that models without a reasoning metadata object do not expose
  // controllable effort selection. Other compatible gateways may omit metadata entirely.
  if (supported === null && provider && isOpenRouterProvider(provider)) supported = false;
  const effortList = reasoning && (reasoning.supported_efforts || reasoning.supportedEfforts)
    || m.supported_efforts || m.supportedEfforts || m.supported_reasoning_efforts || m.supportedReasoningEfforts || m.reasoning_efforts || m.reasoningEfforts;
  const efforts = Array.isArray(effortList) ? effortList.map(String) : null;
  return { catalogued: true, supported, efforts };
}
function modelReasoningInfo(p) {
  const map = p && p.modelCapabilities && typeof p.modelCapabilities === 'object' ? p.modelCapabilities : {};
  return p && p.model ? map[p.model] || null : null;
}
function buildReasoningFields(p, level) {
  if (!['low', 'medium', 'high'].includes(level)) return {};
  const info = modelReasoningInfo(p);
  if (isOpenRouterProvider(p) && /^openrouter\/(?:free|auto)$/i.test(String(p.model || ''))) {
    setThinkingStatus('unsupported', 'Thinking not selectable for router', 'OpenRouter dynamic routers choose the underlying model per request and do not advertise a stable reasoning-effort capability.');
    throw new Error('Think: ' + level + ' cannot be controlled on the OpenRouter free/auto dynamic router. Select a specific reasoning-capable model or set Think to Off.');
  }
  if (info && info.supported === false) {
    setThinkingStatus('unsupported', 'Think: ' + level + ' not supported', 'The selected model catalog does not advertise reasoning-effort support.');
    throw new Error('Think: ' + level + ' is not supported by the selected model (' + p.model + '). Choose Think: Off or select a model that advertises reasoning support.');
  }
  if (info && Array.isArray(info.efforts) && !info.efforts.includes(level)) {
    setThinkingStatus('unsupported', 'Think: ' + level + ' not supported', 'Supported levels: ' + info.efforts.join(', '));
    throw new Error('The selected model does not support Think: ' + level + '. Supported levels: ' + info.efforts.join(', ') + '.');
  }
  // OpenRouter uses its unified `reasoning.effort` object on Chat Completions.
  // Other OpenAI-compatible providers receive the conventional reasoning_effort field.
  return isOpenRouterProvider(p) ? { reasoning: { effort: level } } : { reasoning_effort: level };
}
const newCallId = () => 'call_' + Math.random().toString(36).slice(2, 10);
/* 3.18.4 — some models (Qwen/GLM style, notably through the Chat Z.ai bridge, which has no native tool channel)
   write a tool call as plain text: <tool_call><function=name><parameter=key>value</parameter></function></tool_call>
   (or the Hermes JSON form <tool_call>{"name":…,"arguments":{…}}</tool_call>). It used to be shown as the answer and never ran.
   extractTextToolCalls() turns those blocks into real tool calls and removes them from the visible text. Only tools that
   were actually offered are accepted; parameter text is converted to the type the tool schema declares. */
function extractTextToolCalls(text, tools) {
  const src = String(text || '');
  if (!/<tool_call>|<function=|\[Called tool /i.test(src)) return { text: src, calls: [] };
  const byName = new Map((tools || []).filter(t => t && t.name).map(t => [t.name, t]));
  const accepts = name => !byName.size || byName.has(name);
  const coerce = (name, key, raw) => {
    const t = byName.get(name), spec = t && t.parameters && t.parameters.properties && t.parameters.properties[key];
    const type = spec && spec.type, v = String(raw);
    if (type === 'integer' || type === 'number') { const n = Number(v.trim()); return Number.isFinite(n) ? n : raw; }
    if (type === 'boolean') return /^\s*true\s*$/i.test(v) ? true : /^\s*false\s*$/i.test(v) ? false : raw;
    if (type === 'array' || type === 'object') { try { return JSON.parse(v); } catch { return raw; } }
    return raw;
  };
  const calls = [];
  let clean = src.replace(/(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/g, (whole, name, inner) => {
    if (!accepts(name)) return whole;
    const args = {}, pr = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let m; while ((m = pr.exec(inner))) args[m[1]] = coerce(name, m[1], m[2]);
    calls.push({ id: newCallId(), name, args });
    return '';
  });
  clean = clean.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (whole, json) => {
    try {
      const o = JSON.parse(json); if (!o || typeof o.name !== 'string' || !accepts(o.name)) return whole;
      let a = o.arguments !== undefined ? o.arguments : o.parameters; if (typeof a === 'string') a = JSON.parse(a);
      calls.push({ id: newCallId(), name: o.name, args: a && typeof a === 'object' ? a : {} });
      return '';
    } catch { return whole; }
  });
  // The Chat Z.ai bridge writes earlier tool calls into the prompt as `[Called tool NAME with {json}]`; models copy that form back.
  { const re = /\[Called tool ([A-Za-z0-9_.:-]+) with /g; let m, last = 0, out = '';
    while ((m = re.exec(clean))) {
      const name = m[1], at = m.index + m[0].length;
      if (clean[at] !== '{' || !accepts(name)) continue;
      let end = clean.indexOf('}]', at), parsed = null;
      while (end !== -1 && !parsed) { try { parsed = JSON.parse(clean.slice(at, end + 1)); } catch { end = clean.indexOf('}]', end + 1); } }
      if (!parsed || typeof parsed !== 'object') continue;
      calls.push({ id: newCallId(), name, args: parsed });
      out += clean.slice(last, m.index); last = end + 2; re.lastIndex = last;
    }
    if (last) clean = out + clean.slice(last); }
  return { text: calls.length ? clean.trim() : src, calls };
}
const sleepAbortable = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
async function postStream(p, url, body, signal) {
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await provFetch(url, { method: 'POST', headers: buildHeaders(p), body: JSON.stringify(body), signal }); }
    catch (e) { if (e.name === 'AbortError' || attempt >= (p._copilotSwitch ? 0 : 4)) throw e; $('ctxHint').textContent = 'Connection problem, retrying…'; await sleepAbortable(delay, signal); delay *= 2; continue; }
    if (res.ok) return res;
    const t = await res.text();
    const retryLimit = p._copilotSwitch ? 0 : 4; // CodeSpace Copilot switches model at once instead of waiting
    if ([429, 500, 502, 503, 504, 529].includes(res.status) && attempt < retryLimit) {
      const ra = Number(res.headers.get('retry-after')), wait = ra > 0 ? Math.min(ra * 1000, 20000) : delay;
      $('ctxHint').textContent = (res.status === 429 ? 'Rate limited' : 'Server busy') + ', retrying in ' + Math.round(wait / 1000) + ' s…';
      await sleepAbortable(wait, signal); delay *= 2; continue;
    }
    // Include a compact outline of the request so rejected payloads can be
    // diagnosed from the chat error alone (no adb/logcat needed).
    let outline = '';
    try {
      const msgs = Array.isArray(body && body.messages) ? body.messages : [];
      outline = msgs.map(m => {
        const c = m.content;
        const shape = Array.isArray(c)
          ? '[' + c.map(part => (part && part.type === 'text') ? 'text' : ((part && part.type) || '?')).join(',') + ']'
          : (c == null ? 'null' : typeof c);
        return m.role + '=' + shape;
      }).join(' ');
    } catch (err) { outline = ''; }
    const e = new Error('Server returned ' + res.status + ': ' + t.slice(0, 400) + (outline ? ' | request: ' + outline.slice(0, 600) : '')); e.status = res.status; e.body = t; throw e;
  }
}
async function readSSE(res, onData, signal) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        onData(j);
      }
    }
  } catch (e) {
    // A mid-stream connection drop (reader failure) is retryable like an in-stream provider
    // error: tag it so callModel's transient retry sees it instead of killing the turn.
    if (e && e.name !== 'AbortError') e.inStream = true;
    throw e;
  }
  // 3.12.7: some Chromium paths resolve the pending read with done=true when the fetch is
  // aborted mid-stream (Stop pressed), instead of rejecting with AbortError. Without this
  // check the partial answer was treated as a COMPLETED turn — Stop looked like success, the
  // activity said "Response complete", and the next "continue" lost the unfinished-work state.
  if (signal && signal.aborted) { const e = new DOMException('Aborted', 'AbortError'); throw e; }
}
const imageKeep = (h, p) => { const idx = []; h.forEach((m, i) => { if (m.role === 'tool' && m.image) idx.push(i); }); return new Set(p.vision ? idx.slice(-2) : []); };
const SUMMARY_PREFIX = '[Summary of the earlier conversation]\n';

async function callOpenAI(p, sys, h, tools, signal, on, opts) {
  const msgs = []; if (sys) msgs.push({ role: 'system', content: sys });
  const keep = imageKeep(h, p); let pend = [];
  const flush = () => { if (pend.length) { msgs.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot from the previous tool call:' }, ...pend.map(u => ({ type: 'image_url', image_url: { url: u } }))] }); pend = []; } };
  h.forEach((m, i) => {
    if (m.role !== 'tool') flush();
    if (m.role === 'user') {
      const imgs = p.vision && Array.isArray(m.images) ? m.images.filter(x => x && x.dataUrl) : [];
      msgs.push({ role: 'user', content: imgs.length ? [{ type: 'text', text: m.content || 'Please inspect the attached image(s).' }, ...imgs.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }))] : m.content });
    }
    else if (m.role === 'summary') msgs.push({ role: 'user', content: SUMMARY_PREFIX + m.content });
    else if (m.role === 'assistant') {
      const txt = stripThink(m.content), o = { role: 'assistant', content: txt || null };
      if (m.toolCalls && m.toolCalls.length) o.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      if (txt || o.tool_calls) msgs.push(o);
    } else {
      // Providers routed through strict OpenAI-compatible gateways (LiteLLM in
      // front of NVIDIA NIM) reject tool messages whose content is missing and
      // text parts whose text is undefined. Always send a string.
      msgs.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content == null ? '' : String(m.content) });
      if (keep.has(i)) pend.push(m.image);
    }
  });
  flush();
  // Normalise every text part so no gateway receives { type: 'text' } without text.
  msgs.forEach(m => {
    if (m.content == null) { if (m.role !== 'assistant') m.content = ''; return; }
    if (!Array.isArray(m.content)) { if (typeof m.content !== 'string') m.content = String(m.content); return; }
    m.content = m.content.map(part => part && part.type === 'text'
      ? Object.assign({}, part, { text: typeof part.text === 'string' ? part.text : String(part.text == null ? '' : part.text) })
      : part);
  });
  const body = { model: p.model, messages: msgs, temperature: Number(S.temp), stream: true, stream_options: { include_usage: true } };
  if (p.extraBody && p.extraBody.trim()) Object.assign(body, JSON.parse(p.extraBody));
  // The visible Think control is authoritative: custom extraBody must not silently
  // override the selected effort or leave reasoning enabled when the control is Off.
  const thinkLevel = !(opts && opts.maxTokens) && thinkingSupported(p) && ['low', 'medium', 'high'].includes(S.thinkLevel) ? S.thinkLevel : '';
  delete body.reasoning_effort;
  delete body.reasoning;
  if (isChatZaiProvider(p)) {
    delete body.reasoning_effort; delete body.reasoning;
    body.enable_thinking = !!thinkLevel; // Chat Z.ai's web endpoint uses its own thinking flag.
  } else if (thinkLevel) Object.assign(body, buildReasoningFields(p, thinkLevel));
  if (opts && opts.maxTokens) body.max_tokens = opts.maxTokens; // advisory calls: cap generation for lower latency
  if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: t }));
  const pathPart = p.path ? (p.path.startsWith('/') ? p.path : '/' + p.path) : '/chat/completions';
  const url = p.format === 'custom' ? p.base.trim() : p.base.replace(/\/+$/, '') + pathPart;
  let res;
  const throwReasoningRejection = e => {
    const detail = String(e && (e.body || e.message) || '');
    if (![400, 422].includes(Number(e && e.status)) || !(body.reasoning_effort || body.reasoning) || !/reasoning|thinking|unsupported parameter|unknown parameter/i.test(detail)) return false;
    const level = thinkLevel || 'selected';
    setThinkingStatus('unsupported', 'Think: ' + level + ' rejected', 'The provider rejected the thinking parameter. CodeSpace did not silently retry with thinking disabled.');
    const rejected = new Error('The selected provider/model rejected the Think: ' + level + ' parameter. Thinking was not applied. Choose Think: Off or a model that supports reasoning effort. Provider response: ' + detail.slice(0, 220));
    rejected.nonRetryable = true;
    throw rejected;
  };
  try { res = await postStream(p, url, body, signal); }
  catch (firstError) {
    let e = firstError;
    if (e.status === 400 && /stream_options/i.test(e.body || '')) {
      delete body.stream_options;
      try { res = await postStream(p, url, body, signal); }
      catch (retryError) { e = retryError; }
    }
    if (!res) {
      throwReasoningRejection(e);
      if (e.status === 400 && body.max_tokens && /max_tokens|max_completion_tokens|unsupported parameter|unknown parameter/i.test(e.body || '')) {
        delete body.max_tokens;
        try { res = await postStream(p, url, body, signal); }
        catch (retryError) { throwReasoningRejection(retryError); throw retryError; }
      } else throw e;
    }
  }
  const acc = { text: '', reasoning: '', reasoningSignal: false, tools: [], names: [], usage: null };
  const note = () => { acc.names = acc.tools.filter(t => t && t.name).map(t => t.name); };
  if (!(res.headers.get('content-type') || '').includes('event-stream')) { // the server answered without streaming
    const data = await res.json(), msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('Unexpected response: ' + JSON.stringify(data).slice(0, 300));
    acc.text = msg.content || ''; acc.reasoning = msg.reasoning_content || msg.reasoning || ''; acc.reasoningSignal = !!(acc.reasoning || msg.reasoning_details || (data.usage && ((data.usage.completion_tokens_details || data.usage.output_tokens_details || {}).reasoning_tokens > 0))); 
    (msg.tool_calls || []).forEach((c, i) => { acc.tools[i] = { id: c.id || '', name: c.function.name, args: c.function.arguments || '' }; });
    if (data.usage && (data.usage.prompt_tokens || data.usage.completion_tokens)) {
      const details = data.usage.completion_tokens_details || data.usage.output_tokens_details || {};
      acc.usage = { input: Number(data.usage.prompt_tokens) || 0, output: Number(data.usage.completion_tokens) || 0, cachedInput: Number(data.usage.prompt_tokens_details && data.usage.prompt_tokens_details.cached_tokens) || 0, reasoningTokens: Number(details.reasoning_tokens) || 0 };
    }
    note(); if (on) on(acc);
  } else {
    try {
      await readSSE(res, j => {
        if (j.error) {
          /* 3.13.21: gateways report the HTTP-like status as error.code (OpenRouter) and hide the real cause in
             error.metadata.raw. Both are read so "Provider returned error" (429 / 5xx) is recognised as a limit
             and CodeSpace Copilot can switch model instead of ending the turn. */
          const eo = j.error && typeof j.error === 'object' ? j.error : null;
          const raw = eo && eo.metadata ? String(typeof eo.metadata.raw === 'string' ? eo.metadata.raw : (eo.metadata.raw ? JSON.stringify(eo.metadata.raw) : '')).slice(0, 200) : '';
          const base = (eo ? (eo.message || '') : String(j.error)) || JSON.stringify(j.error).slice(0, 200);
          const er = new Error(raw && !base.includes(raw) ? base + ' — ' + raw : base);
          er.inStream = true;
          er.errType = eo ? String(eo.type || (typeof eo.code === 'string' ? eo.code : '') || '') : '';
          er.status = (eo ? [eo.status, eo.status_code, eo.code].map(Number).find(n => Number.isInteger(n) && n >= 100 && n < 600) : 0) || undefined;
          throw er;
        }
        if (j.usage && (j.usage.prompt_tokens || j.usage.completion_tokens)) {
          const details = j.usage.completion_tokens_details || j.usage.output_tokens_details || {};
          acc.usage = { input: Number(j.usage.prompt_tokens) || 0, output: Number(j.usage.completion_tokens) || 0, cachedInput: Number(j.usage.prompt_tokens_details && j.usage.prompt_tokens_details.cached_tokens) || 0, reasoningTokens: Number(details.reasoning_tokens) || 0 };
        }
        const d = j.choices && j.choices[0] && j.choices[0].delta; if (!d) return;
        if (d.content) acc.text += d.content;
        const r = d.reasoning_content || d.reasoning || d.thinking; if (typeof r === 'string' && r) { acc.reasoning += r; acc.reasoningSignal = true; } if (d.reasoning_details && (Array.isArray(d.reasoning_details) ? d.reasoning_details.length : true)) acc.reasoningSignal = true;
        (d.tool_calls || []).forEach(tc => {
          const i = tc.index ?? 0, t = acc.tools[i] || (acc.tools[i] = { id: '', name: '', args: '' });
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name) t.name = t.name ? (t.name === tc.function.name ? t.name : t.name + tc.function.name) : tc.function.name;
            if (tc.function.arguments) t.args += tc.function.arguments;
          }
        });
        note(); if (on) on(acc);
      }, signal);
    } catch (e) {
      // Gateways may accept HTTP 200 then reject an unsupported reasoning parameter
      // inside SSE. Surface this as a non-retryable configuration error, not a transient
      // stream failure, and never retry silently without the selected effort.
      if (thinkLevel && /reasoning|thinking|unsupported parameter|unknown parameter/i.test(String(e && e.message || ''))) {
        setThinkingStatus('unsupported', 'Think: ' + thinkLevel + ' rejected', 'The provider rejected the reasoning parameter in its streaming response. CodeSpace did not retry without thinking.');
        const rejected = new Error('The selected provider/model rejected Think: ' + thinkLevel + ' in its streaming response. Thinking was not applied. Choose Think: Off or a model that supports reasoning effort. Provider response: ' + String(e.message || '').slice(0, 220));
        rejected.nonRetryable = true;
        throw rejected;
      }
      throw e;
    }
  }
  const toolCalls = acc.tools.filter(t => t && t.name).map(t => { const pa = parseArgs(t.args); return { id: t.id || newCallId(), name: t.name, args: pa.args, argsError: pa.bad }; });
  if (!toolCalls.length && tools.length) { // 3.18.4: a tool call written as plain text becomes a real call instead of the visible answer
    const txt = extractTextToolCalls(acc.text, tools);
    if (txt.calls.length) { acc.text = txt.text; txt.calls.forEach(c => toolCalls.push({ id: c.id, name: c.name, args: c.args, argsError: undefined })); }
  }
  if (thinkLevel) {
    const confirmed = !!acc.reasoningSignal || !!acc.reasoning || !!(acc.usage && acc.usage.reasoningTokens > 0);
    setThinkingStatus(confirmed ? 'confirmed' : 'warning', confirmed ? 'Think: ' + thinkLevel + ' · reasoning returned' : 'Think: ' + thinkLevel + ' · not verified', confirmed ? 'The response included reasoning content, reasoning details, or reported reasoning tokens. This confirms reasoning data was returned, but the provider does not echo the exact effort level.' : 'The request completed, but the provider did not expose reasoning content, reasoning details, or reasoning-token usage. It may have applied the requested effort or ignored it; CodeSpace cannot confirm.');
  } else setThinkingStatus('off', '', 'Thinking is off.');
  return { text: acc.text, reasoning: acc.reasoning, toolCalls, usage: acc.usage };
}
async function callAnthropic(p, sys, h, tools, signal, on, opts) {
  const msgs = [], keep = imageKeep(h, p);
  const lvl = thinkingSupported(p) && ['low', 'medium', 'high'].includes(S.thinkLevel) ? S.thinkLevel : '';
  const lvlBudget = { low: 2048, medium: 8192, high: 16384 }[lvl];
  const think = !!p.think || !!lvlBudget;
  const budget = lvlBudget || Math.max(1024, Number(p.thinkBudget) || 4096);
  const pushUser = txt => { const l = msgs[msgs.length - 1]; if (l && l.role === 'user' && typeof l.content === 'string') l.content += '\n\n' + txt; else msgs.push({ role: 'user', content: txt }); };
  h.forEach((m, i) => {
    if (m.role === 'user') {
      const imgs = p.vision && Array.isArray(m.images) ? m.images.filter(x => x && x.dataUrl) : [];
      if (!imgs.length) pushUser(m.content);
      else {
        const blocks = [{ type: 'text', text: m.content || 'Please inspect the attached image(s).' }, ...imgs.map(im => { const match = String(im.dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/); return match ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } } : null; }).filter(Boolean)];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'user') { if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }]; last.content.push(...blocks); } else msgs.push({ role: 'user', content: blocks });
      }
    }
    else if (m.role === 'summary') pushUser(SUMMARY_PREFIX + m.content);
    else if (m.role === 'assistant') {
      const blocks = [], txt = stripThink(m.content);
      if (think && m.thinkingBlocks) m.thinkingBlocks.forEach(b => blocks.push(b.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: b.data } : { type: 'thinking', thinking: b.thinking, signature: b.signature }));
      if (txt) blocks.push({ type: 'text', text: txt });
      (m.toolCalls || []).forEach(c => blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }));
      if (blocks.length) msgs.push({ role: 'assistant', content: blocks });
    } else {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: keep.has(i) ? [{ type: 'text', text: m.content }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.image.split(',')[1] } }] : m.content };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block); else msgs.push({ role: 'user', content: [block] });
    }
  });
  // Advisory calls cap max_tokens and skip extended thinking so helper agents return fast.
  const capped = opts && opts.maxTokens ? Math.max(1024, opts.maxTokens) : 0;
  const body = { model: p.model, max_tokens: capped || (think ? budget + 4096 : 4096), messages: msgs, stream: true };
  if (think && !capped) body.thinking = { type: 'enabled', budget_tokens: budget };
  if (p.extraBody && p.extraBody.trim()) Object.assign(body, JSON.parse(p.extraBody));
  if (sys) body.system = p.promptCache ? [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }] : sys;
  if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const base = p.base.replace(/\/+$/, '');
  const res = await postStream(p, base + (/\/v1$/.test(base) ? '/messages' : '/v1/messages'), body, signal);
  const acc = { text: '', reasoning: '', blocks: [], names: [], usage: null };
  await readSSE(res, j => {
    if (j.type === 'error') { const er = new Error((j.error && j.error.message) || 'Stream error'); er.inStream = true; er.errType = j.error && j.error.type; throw er; }
    if (j.type === 'message_start' && j.message && j.message.usage) { const u = j.message.usage; acc.usage = { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: 0, cachedInput: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) }; }
    else if (j.type === 'message_delta' && j.usage) { if (!acc.usage) acc.usage = { input: 0, output: 0, cachedInput: 0 }; acc.usage.output = Number(j.usage.output_tokens) || 0; }
    else if (j.type === 'content_block_start') { const c = j.content_block || {}; acc.blocks[j.index] = { type: c.type, id: c.id, name: c.name, text: '', json: '', thinking: '', signature: '', data: c.data }; acc.names = acc.blocks.filter(b => b && b.type === 'tool_use').map(b => b.name); }
    else if (j.type === 'content_block_delta') {
      const b = acc.blocks[j.index], d = j.delta || {}; if (!b) return;
      if (d.type === 'text_delta') { b.text += d.text; acc.text += d.text; }
      else if (d.type === 'thinking_delta') { b.thinking += d.thinking; acc.reasoning += d.thinking; }
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') b.json += d.partial_json;
    }
    if (on) on(acc);
  }, signal);
  const bl = acc.blocks.filter(Boolean);
  const requestedAnthropicThinking = think;
  if (requestedAnthropicThinking) setThinkingStatus(acc.reasoning ? 'confirmed' : 'warning', acc.reasoning ? 'Thinking · block returned' : 'Thinking · accepted', acc.reasoning ? 'The Anthropic stream returned a thinking block.' : 'The request enabled native thinking, but no thinking block was returned in this response.');
  else setThinkingStatus('off', '', 'Thinking is off.');
  return {
    text: bl.filter(b => b.type === 'text').map(b => b.text).join('\n'), reasoning: acc.reasoning,
    toolCalls: bl.filter(b => b.type === 'tool_use').map(b => { const pa = parseArgs(b.json); return { id: b.id || newCallId(), name: b.name, args: pa.args, argsError: pa.bad }; }),
    thinkingBlocks: bl.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking').map(b => (b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: b.signature } : { type: 'redacted_thinking', data: b.data })),
    usage: acc.usage
  };
}
/* Phase 3T: providers/gateways (NVIDIA, OpenRouter, etc.) often report "overloaded" as an error event inside an HTTP 200 stream,
   which the HTTP-status retry in postStream never sees. 3.12.5: they also kill streams AFTER partial output with the same
   transient errors — that used to kill the whole turn (worst in multi-agent, where the implementer round is long). No call
   site commits partial output to the chat until the whole stream resolves (deltas only feed the live activity panel), so
   retrying after a partial stream is safe: the fresh attempt regenerates the answer instead of losing the turn. */
const TRANSIENT_RE = /overload|temporar|rate.?limit|too many requests|\bbusy\b|capacity|try again|unavailable|time(d)? ?out|gateway|\b(408|425|429|500|502|503|504|529)\b|failed to fetch|network error|load failed/i;
const TRANSIENT_STATUS = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529];
const isTransientModelError = e => !!e && !e.nonRetryable && e.name !== 'AbortError' && ((e.inStream && (TRANSIENT_RE.test(String(e.message || '')) || e.errType === 'overloaded_error' || e.errType === 'rate_limit_error')) || TRANSIENT_STATUS.includes(e.status));
/* CodeSpace Copilot: automatic model fallback with no waiting period and no time limit.
   When the active model fails (limit, overload, unavailable, stalled, empty answer, bad key on one provider ...)
   the next available model is tried at once (each model at most once per request).
   Pool = every FREE model of every configured provider (":free" IDs, local endpoints) plus Chat Z.ai models while the
   Chat Z.ai bridge is ON. Paid models are never added to the pool. */
let COPILOT_LAST_OK = ''; // in memory only, no timer: the model that answered last is tried first so a limited model is not re-hit every round
const COPILOT_STALL_MS = 60000; // no first token / no new data for this long = the model is stuck, switch
const copilotKey = p => String(p && p.id || '') + '::' + String(p && p.model || '');
const copilotEligibleModel = (provider, id) => !!provider && !!String(id || '').trim() && modelTier(provider, String(id).trim()) === 'free' && (!isChatZaiProvider(provider) || !!S.chatZaiCLI);
function copilotPool(active) {
  const seen = new Set(), out = [];
  const add = (provider, id) => {
    id = String(id || '').trim(); if (!id) return;
    const key = String(provider.id || '') + '::' + id; if (seen.has(key)) return; seen.add(key);
    out.push({ ...provider, model: id });
  };
  if (active && copilotEligibleModel(active, active.model)) add(active, active.model); // a paid active model is never part of the pool
  (S.providers || []).forEach(provider => {
    if (isChatZaiProvider(provider) && !S.chatZaiCLI) return;
    const ids = Array.isArray(provider.models) ? provider.models.slice() : [];
    if (provider.model) ids.unshift(provider.model);
    ids.forEach(id => { if (copilotEligibleModel(provider, id)) add(provider, id); });
  });
  const i = out.findIndex(c => copilotKey(c) === COPILOT_LAST_OK);
  if (i > 0) out.unshift(out.splice(i, 1)[0]);
  return out;
}
const COPILOT_LIMIT_RE = /quota|rate.?limit|too many requests|daily limit|usage limit|credit balance|insufficient credits|exceeded.*limit|limit.*exceeded|model.*(unavailable|not (found|available|a valid))|no endpoints found|overloaded|capacity|provider returned error|empty reply/i;
/* Used for a single free model chosen by hand (no pool): the narrower, limit-shaped test. */
function freeFallbackEligible(e) {
  if (!e || e.name === 'AbortError' || e.nonRetryable) return false;
  const status = Number(e.status), detail = String((e.body || '') + ' ' + (e.message || '') + ' ' + (e.errType || ''));
  if (status === 401) return false; // bad key: switching provider blindly would hide a setup problem
  if (TRANSIENT_STATUS.includes(status) || status === 402) return true;
  if (status === 404) return /model|endpoint/i.test(detail);
  if (status === 403) return COPILOT_LIMIT_RE.test(detail);
  return isTransientModelError(e) || COPILOT_LIMIT_RE.test(detail);
}
/* Inside a pool the rule is wider: anything except the user pressing Stop moves on to the next model.
   A model that rejects the key, the request shape (400/422) or the Think level may well work on the next one.
   If the whole pool fails, the error that explains it best is reported (see callModel). */
const copilotShouldSwitch = (e, signal) => !!e && e.name !== 'AbortError' && !(signal && signal.aborted);
/* Quota / credit exhaustion is per ACCOUNT, not per model: every other model of the same provider key will fail the same
   way, and it does not reset in a minute. Such a provider is skipped for the rest of the request. */
const QUOTA_EXHAUSTED_RE = /insufficient[_ ]quota|quota (exceeded|exhausted)|exceeded your (current )?quota|credit balance|insufficient (credits|balance|funds)|out of credits|usage limit|billing|payment required/i;
const isQuotaExhausted = e => !!e && (Number(e.status) === 402 || (Number(e.status) === 429 || !e.status) && QUOTA_EXHAUSTED_RE.test(String((e.body || '') + ' ' + (e.message || '') + ' ' + (e.errType || ''))));
const isEmptyModelReply = r => !!r && !String(r.text || '').trim() && !(r.toolCalls && r.toolCalls.length) && !String(r.reasoning || '').trim();
async function callModelSingle(p, sys, h, tools, signal, on, opts, allowRetries) {
  const fn = p.format === 'anthropic' ? callAnthropic : callOpenAI;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn(p, sys, h, tools, signal, on, opts);
      const known = new Set(allToolDefs().map(d => d.name));
      r.toolCalls = r.toolCalls.map(c => { const name = normalizeToolName(c.name, known); return { ...c, name, args: normalizeArgs(name, c.args) }; });
      r.providerUsed = p;
      return r;
    } catch (e) {
      const transient = isTransientModelError(e);
      if (transient) { e.transient = true; e.attempts = attempt; }
      if (!allowRetries || !transient || !e.inStream || attempt >= 4 || (signal && signal.aborted)) throw e;
      const wait = Math.min(2000 * 2 ** attempt, 20000) + Math.floor(Math.random() * 800);
      const msg = 'Model provider is busy (' + String(e.message).slice(0, 80) + '). Retrying in ' + Math.round(wait / 1000) + ' s (try ' + (attempt + 1) + ' of 4). Press Stop to cancel.';
      $('ctxHint').textContent = msg;
      if (maActivityState.visible) {
        const row = feedPush('Provider busy · retrying (try ' + (attempt + 1) + ' of 4)', { force: true });
        try { await sleepAbortable(wait, signal); } finally { feedEnd(row, 'skip'); }
      } else await sleepAbortable(wait, signal);
    }
  }
}
/* One pool candidate with a stall watchdog: a free model that accepts the request and then never answers must not
   freeze the turn. The watchdog aborts only this candidate (not the user's signal) and reports a timeout error. */
async function callCandidate(candidate, sys, h, tools, signal, on, opts) {
  const ac = new AbortController(); let stalled = false, timer = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort(); }, COPILOT_STALL_MS); };
  const relay = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', relay, { once: true }); }
  arm();
  try { return await callModelSingle(candidate, sys, h, tools, ac.signal, on ? a => { arm(); on(a); } : arm, opts, false); }
  catch (e) {
    if (stalled && !(signal && signal.aborted)) { const te = new Error('no response from ' + (candidate.model || 'the model') + ' for ' + Math.round(COPILOT_STALL_MS / 1000) + ' s (timed out)'); te.status = 408; throw te; }
    throw e;
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', relay); }
}
const callModel = async (p, sys, h, tools, signal, on, opts) => {
  // Automatic switching happens ONLY while the user has selected CodeSpace Copilot (S.copilotAuto).
  // A model picked by hand is always called as itself (normal retry/backoff), free or paid.
  // Even with Copilot selected, only FREE models can enter the pool: a paid model (e.g. a per-role model in
  // multi-agent mode) is always called as itself and is never tried as a fallback.
  if (!S.copilotAuto || !copilotEligibleModel(p, p && p.model)) return callModelSingle(p, sys, h, tools, signal, on, opts, true);
  const pool = copilotPool(p);
  if (pool.length < 2) return callModelSingle(pool[0] || p, sys, h, tools, signal, on, opts, true); // nothing to switch to: normal retry/backoff
  pool.forEach(c => { c._copilotSwitch = true; });
  const label = c => (c.name || 'provider') + ' · ' + c.model;
  const failures = [], quotaOut = new Map(); // provider id -> name
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[i];
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (quotaOut.has(String(candidate.id))) continue; // this account is out of quota: do not burn more requests on it
    if (i > 0) $('ctxHint').textContent = 'CodeSpace Copilot · Switching to ' + label(candidate) + '…';
    try {
      const result = await callCandidate(candidate, sys, h, tools, signal, on, opts);
      if (isEmptyModelReply(result)) { const ee = new Error('The model returned an empty reply.'); ee.status = 502; throw ee; }
      if (copilotKey(candidate) !== COPILOT_LAST_OK) {
        $('ctxHint').textContent = 'CodeSpace Copilot · Active: ' + label(candidate);
        if (failures.length && typeof addNote === 'function') { try { addNote('CodeSpace Copilot switched to ' + label(candidate) + ' (' + failures[failures.length - 1].why + ').'); } catch {} }
      }
      COPILOT_LAST_OK = copilotKey(candidate);
      return result;
    } catch (e) {
      if (!copilotShouldSwitch(e, signal)) throw e;
      if (isQuotaExhausted(e)) quotaOut.set(String(candidate.id), candidate.name || candidate.id);
      failures.push({ e, why: String(e.message || e.errType || 'unavailable').replace(/^Server returned \d+:\s*/, '').replace(/\s+/g, ' ').slice(0, 110), label: label(candidate) });
      if (COPILOT_LAST_OK === copilotKey(candidate)) COPILOT_LAST_OK = '';
    }
  }
  // Every model failed. Quota exhaustion is reported on its own: it is not a temporary outage.
  if (quotaOut.size && failures.every(f => isQuotaExhausted(f.e))) {
    const names = [...quotaOut.values()].join(', ');
    const qe = new Error('Quota exhausted for ' + names + '. The free models of one provider share one account limit, so switching models cannot help. Check that account\u2019s quota or credit balance and its reset date, or add another provider with free models. (' + String(failures[0].e.message || '').replace(/^Server returned \d+:\s*/, '').slice(0, 140) + ')');
    qe.status = Number(failures[0].e.status) || 429; qe.quotaExhausted = true; qe.transient = false; qe.providers = [...quotaOut.values()];
    throw qe;
  }
  // Otherwise prefer reporting a setup problem (bad key) over a plain limit so the user can fix it.
  const authFail = failures.find(f => Number(f.e.status) === 401);
  const lastError = (failures.every(f => Number(f.e.status) === 401) && authFail ? authFail.e : failures[failures.length - 1].e);
  lastError.transient = isTransientModelError(lastError);
  lastError.message = 'CodeSpace Copilot tried ' + failures.length + ' model' + (failures.length === 1 ? '' : 's') + ', but none is currently available. Last error: ' + String(lastError.message || 'provider limit reached') + (failures.length > 1 ? ' (tried: ' + failures.slice(0, 6).map(f => f.label).join(', ') + (failures.length > 6 ? ', …' : '') + ')' : '');
  throw lastError;
};

/* ================= compress context ================= */
