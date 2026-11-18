'use strict';
/*
 * CodeSpace Chat Z.ai local adapter.
 * Approach follows the public xaoLiu1222/zai-openai-proxy idea, but since 3.13.20 the request
 * signature is computed natively from the algorithm used by the live chat.z.ai frontend
 * (deobfuscated from the prod-fe build). The bridge no longer imports any CDN signature chunk,
 * so a frontend update can no longer break the bridge silently.
 *
 * Signature algorithm (chat.z.ai, frontend >= 1.1.x):
 *   timestamp  = String(Date.now())
 *   requestId  = crypto.randomUUID()
 *   o          = { timestamp, requestId, user_id }            // user_id from /api/v1/auths/
 *   sorted     = Object.entries(o).sort(byKey).join(',')
 *   message    = sorted + '|' + base64(utf8(prompt)) + '|' + timestamp
 *   window     = floor(timestamp / 300000)                    // 5-minute window
 *   k1         = HMAC-SHA256(TEMPLATE_SECRET, window)         // hex
 *   signature  = HMAC-SHA256(k1, message)                     // hex
 * The request goes to /api/v2/chat/completions?<deviceQuery>&signature_timestamp=<timestamp>
 * with X-FE-Version and X-Signature headers; signature_prompt echoes the signed prompt.
 *
 * This service binds only to 127.0.0.1 and requires the CodeSpace bridge token.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.CODESPACE_CHAT_ZAI_PORT || 9876);
const TOKEN = String(process.env.CODESPACE_CHAT_ZAI_TOKEN || '');
const CHROME_PATH = String(process.env.CHROME_PATH || '');
const PROFILE_DIR = String(process.env.CODESPACE_CHAT_ZAI_PROFILE_DIR || '');
const LOGIN_WAIT_MS = Math.max(30000, Math.min(300000, Number(process.env.CODESPACE_CHAT_ZAI_LOGIN_WAIT_MS) || 180000));
/* 3.13.19: session token harvested from chat.z.ai inside CodeSpace's Integrated Browser. When set,
   it is seeded into this bridge profile so the Chrome process can run headless (invisible) and no
   external sign-in window is needed. */
const SESSION_TOKEN = String(process.env.CODESPACE_CHAT_ZAI_SESSION_TOKEN || '').trim();
const ZAI_BASE = 'https://chat.z.ai';
/* Last-known-good frontend version, used only when live discovery fails. */
const KNOWN_FE_VERSION = 'prod-fe-1.1.128';
/* Signing template secret from the site's own signer (constant across requests; the per-request
   material comes from the timestamp window). */
const SIGN_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const DETAILS_CLOSE = '</details>';

let puppeteer = null;
let browser = null;
let page = null;
let modelsCache = [];
let modelMeta = new Map();
let userId = '';
let feVersion = KNOWN_FE_VERSION;

const timingSafeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function authorized(req) {
  if (!TOKEN) return false;
  const h = String(req.headers.authorization || '');
  return timingSafeEqual(h.startsWith('Bearer ') ? h.slice(7) : '', TOKEN);
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Request body is too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON request body.')); }
    });
    req.on('error', reject);
  });
}

/* ===================== signing (pure, testable) ===================== */

const sha256Hmac = (key, message) =>
  crypto.createHmac('sha256', Buffer.from(String(key), 'utf8'))
    .update(Buffer.from(String(message), 'utf8')).digest('hex');

/* The site sorts {timestamp, requestId, user_id} entries by key and joins the flattened
   key/value list with commas — no "=" mapping. */
const sortedPayloadFor = o =>
  Object.entries(o).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).join(',');

function signRequest(sortedPayload, prompt, timestamp) {
  const ts = String(timestamp);
  const b64 = Buffer.from(String(prompt), 'utf8').toString('base64');
  const message = sortedPayload + '|' + b64 + '|' + ts;
  const window = Math.floor(Number(ts) / (5 * 60 * 1000));
  const k1 = sha256Hmac(SIGN_SECRET, String(window));
  return { signature: sha256Hmac(k1, message), timestamp: ts };
}

/* Text after the last closed reasoning-details block; null while a details block is still open
   or when the payload never contained one. */
function visibleAfterDetails(content) {
  const text = String(content || '');
  const open = text.lastIndexOf('<details');
  const close = text.lastIndexOf(DETAILS_CLOSE);
  if (open !== -1 && (close === -1 || close < open)) return null;
  if (close === -1) return null;
  return text.slice(close + DETAILS_CLOSE.length);
}

/* ===================== upstream stream consumer (pure, testable) ===================== */

/* Translates the chat.z.ai completion event stream into OpenAI-style deltas. Mirrors the site's
   own handler: delta_content appends, content is a full snapshot, edit_content splices at
   edit_index (site semantics) or appends the post-details part (legacy behaviour). Errors and
   usage are captured instead of being silently ignored.
   Two tracks are maintained: `answer` follows the phase-routed deltas (the long-proven path) and
   `content` mirrors the site's own message-content accumulation; the longer consistent text wins
   at finalize, so both legacy delta streams and full-snapshot streams produce the full reply. */
function createStreamConsumer(emit) {
  const state = {
    answer: '', reasoning: '', usage: null, tools: [],
    emittedAnswer: '', emittedReasoning: '',
    content: '',
    eventCount: 0, sawCompletion: false, upstreamError: '', lastEvent: '',
    finishReason: null
  };
  const emitAnswer = () => {
    if (state.answer.startsWith(state.emittedAnswer) && state.answer.length > state.emittedAnswer.length) {
      const part = state.answer.slice(state.emittedAnswer.length);
      state.emittedAnswer = state.answer;
      if (part) emit({ content: part });
    }
  };
  const emitReasoning = () => {
    if (state.reasoning.startsWith(state.emittedReasoning) && state.reasoning.length > state.emittedReasoning.length) {
      const part = state.reasoning.slice(state.emittedReasoning.length);
      state.emittedReasoning = state.reasoning;
      if (part) emit({ reasoning_content: part });
    }
  };
  const postDetails = s => {
    const at = String(s).lastIndexOf(DETAILS_CLOSE);
    return at === -1 ? String(s) : String(s).slice(at + DETAILS_CLOSE.length);
  };
  const consumeLine = raw => {
    if (!raw || !raw.startsWith('data:')) return;
    const text = raw.slice(5).trim();
    if (!text || text === '[DONE]') return;
    let parsed; try { parsed = JSON.parse(text); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    state.eventCount++;
    state.lastEvent = text;
    if (parsed.type === 'error' && parsed.data) return captureError(parsed.data);
    const data = parsed.type ? (parsed.data && typeof parsed.data === 'object' ? parsed.data : null) : parsed;
    if (!data) return;
    if (data.error) return captureError(data.error);
    if (parsed.type === 'chat:completion') state.sawCompletion = true;
    if (data.usage && typeof data.usage === 'object') {
      state.usage = {
        prompt_tokens: Number(data.usage.prompt_tokens) || 0,
        completion_tokens: Number(data.usage.completion_tokens) || 0,
        total_tokens: Number(data.usage.total_tokens) || (Number(data.usage.prompt_tokens) || 0) + (Number(data.usage.completion_tokens) || 0)
      };
    }
    if (data.tool_calls) {
      const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [data.tool_calls];
      for (const call of calls) {
        const item = { index: call.index ?? state.tools.length, id: call.id || 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20), type: 'function', function: { name: (call.function && call.function.name) || '', arguments: (call.function && call.function.arguments) || '' } };
        state.tools.push(item); emit({ tool_calls: [item] });
      }
    }
    if ((data.phase === 'search' || data.type === 'web_search' || parsed.type === 'source' || parsed.type === 'citation')) {
      const items = Array.isArray(data) ? data : (data.results || data.sources || data.citations || null);
      if (Array.isArray(items) && items.length) {
        const refs = '\n\n' + items.map((x, i) => '[' + (i + 1) + '] [' + (x.title || x.name || 'Source') + '](' + (x.url || x.link || '') + ')').join('\n');
        state.answer += refs; state.content += refs; emitAnswer();
        return;
      }
    }
    const phase = String(data.phase || '');
    const delta = typeof data.delta_content === 'string' ? data.delta_content : '';
    const edit = typeof data.edit_content === 'string' ? data.edit_content : null;
    const full = typeof data.content === 'string' ? data.content : null;
    /* Track B: site-faithful message-content accumulation. */
    if (delta) state.content += delta;
    if (edit != null) {
      if (data.edit_index != null && Number.isFinite(Number(data.edit_index))) {
        const idx = Math.max(0, Math.min(Number(data.edit_index), state.content.length));
        state.content = state.content.substring(0, idx) + edit;
      } else {
        const part = postDetails(edit);
        if (part.startsWith(state.content)) state.content = part;
        else if (!state.content.endsWith(part)) state.content += part;
      }
    }
    if (full != null) state.content = full;
    /* Track A: phase-routed reasoning/answer (legacy-proven). Events that carry edit_index
       address content-space coordinates — Track B resolves them; Track A skips those. */
    if (phase === 'thinking') {
      if (delta) { state.reasoning += delta; emitReasoning(); }
      return;
    }
    if (delta) { state.answer += delta; emitAnswer(); }
    if (edit != null && data.edit_index == null) {
      const part = postDetails(edit);
      if (part) {
        if (part.startsWith(state.answer)) state.answer = part;        // full rewrite of the answer
        else if (!state.answer.endsWith(part)) state.answer += part;   // legacy append
        emitAnswer();
      }
      return;
    }
    if (edit != null) return; // edit_index splice: owned by Track B, applied at finalize
    if (full != null) {
      const snapshot = visibleAfterDetails(full);
      const target = snapshot != null ? snapshot : full;
      if (target && (target.startsWith(state.answer) || target.length > state.answer.length)) state.answer = target;
      emitAnswer();
    }
  };
  function captureError(err) {
    let msg = '';
    try {
      msg = typeof err === 'string' ? err
        : err && typeof err === 'object' ? String(err.message || err.detail || err.content || err.msg || JSON.stringify(err))
        : String(err);
    } catch { msg = String(err); }
    if (msg && (!state.upstreamError || msg.length > state.upstreamError.length)) state.upstreamError = msg.slice(0, 600);
  }
  /* Final text: the site-faithful visible part wins when it is at least as long as the
     phase-routed answer (covers full-snapshot formats); reasoning falls back to the details
     blocks inside the mirrored content when the stream never sent thinking deltas. */
  const finalize = () => {
    let candidate = null;
    const vis = visibleAfterDetails(state.content);
    if (vis != null) candidate = vis;
    else if (!/<details[\s>]/i.test(state.content)) {
      // No details markup: when thinking deltas were captured the content is reasoning+answer
      // concatenated (legacy delta stream); otherwise the content itself is the answer.
      if (state.reasoning && state.content.startsWith(state.reasoning)) candidate = state.content.slice(state.reasoning.length);
      else candidate = state.content;
    }
    if (candidate && candidate.trim() && candidate.length >= state.answer.length) state.answer = candidate;
    if (!state.reasoning) {
      const blocks = String(state.content || '').match(/<details[^>]*type="reasoning"[^>]*>[\s\S]*?<\/details>/g);
      if (blocks && blocks.length) {
        state.reasoning = blocks.map(b => b.replace(/^<details[^>]*>/, '').replace(/<\/details>$/, '').replace(/<summary>[\s\S]*?<\/summary>/, '').trim()).filter(Boolean).join('\n\n');
      }
    }
    state.finishReason = state.tools.length ? 'tool_calls' : 'stop';
    return state;
  };
  return { consumeLine, finalize };
}

/* ===================== message normalisation (pure, testable) ===================== */

/* chat.z.ai's web endpoint understands plain system / user / assistant text turns. CodeSpace's agent
   sends OpenAI-style history that also contains `tool` results, assistant turns with `tool_calls` and
   null content, multi-part content arrays and `developer` messages. Sent as-is these produced empty
   or rejected completions. Everything is flattened into ordinary text turns here. */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'image_url' || part.type === 'image') return '[image omitted: this chat.z.ai bridge does not accept images]';
    }
    return '';
  }).filter(Boolean).join('\n');
  try { return JSON.stringify(content); } catch { return String(content); }
}
function normalizeMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    let role = String(m.role || 'user');
    let text = contentToText(m.content);
    if (role === 'developer') role = 'system';
    if (role === 'tool' || role === 'function') {
      role = 'user';
      text = '[Tool result' + (m.name ? ' from ' + m.name : '') + ']\n' + text;
    } else if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(c => '[Called tool ' + ((c && c.function && c.function.name) || 'unknown') + ' with ' + ((c && c.function && c.function.arguments) || '{}') + ']').join('\n');
      text = text ? text + '\n' + calls : calls;
    }
    if (role !== 'system' && role !== 'user' && role !== 'assistant') role = 'user';
    if (!String(text).trim()) continue;
    out.push({ role, content: text });
  }
  return out;
}
/* The prompt that gets signed is the latest user turn (tool results count as user turns). */
function promptFor(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  const last = messages[messages.length - 1];
  return last ? last.content : '';
}

/* ===================== page-driven parts ===================== */

async function discoverFeVersion() {
  try {
    const html = await page.evaluate(async base => {
      const r = await fetch(base + '/', { credentials: 'include' });
      return r.ok ? await r.text() : '';
    }, ZAI_BASE);
    const m = String(html || '').match(/prod-fe-\d+\.\d+\.\d+/);
    if (m) feVersion = m[0];
  } catch { /* keep the last known good version */ }
  return feVersion;
}

async function fetchUserId() {
  try {
    const id = await page.evaluate(async () => {
      const token = localStorage.getItem('token') || '';
      const r = await fetch('/api/v1/auths/', { headers: { Authorization: 'Bearer ' + token }, credentials: 'include' });
      if (!r.ok) return '';
      const u = await r.json().catch(() => null);
      return String((u && (u.id || (u.user && u.user.id) || (u.data && u.data.id))) || '');
    });
    if (id) userId = id;
  } catch { /* keep the cached value */ }
  return userId;
}

/* Builds the signed query context inside the logged-in page (real navigator/window/localStorage). */
async function buildQueryContext() {
  const token = await page.evaluate(() => localStorage.getItem('token') || '');
  const context = await page.evaluate((uid, version) => {
    const timestamp = String(Date.now());
    const requestId = crypto.randomUUID();
    const o = { timestamp, requestId, user_id: uid || '' };
    const sortedPayload = Object.entries(o).sort((a, b) => a[0].localeCompare(b[0])).join(',');
    const ua = navigator.userAgent || '';
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const browserName = /Edg\//.test(ua) ? 'Microsoft Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
    const osName = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
    const l = {
      version: '0.0.1', platform: 'web',
      token: localStorage.getItem('token') || '',
      user_agent: ua,
      language: navigator.language || '',
      languages: (navigator.languages || []).join(','),
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),
      cookie_enabled: String(navigator.cookieEnabled !== false),
      screen_width: String(window.screen.width),
      screen_height: String(window.screen.height),
      screen_resolution: window.screen.width + 'x' + window.screen.height,
      viewport_height: String(window.innerHeight),
      viewport_width: String(window.innerWidth),
      viewport_size: window.innerWidth + 'x' + window.innerHeight,
      color_depth: String(window.screen.colorDepth),
      pixel_ratio: String(window.devicePixelRatio),
      current_url: window.location.href,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      host: window.location.host,
      hostname: window.location.hostname,
      protocol: window.location.protocol,
      referrer: document.referrer || '',
      title: document.title || '',
      timezone_offset: String(new Date().getTimezoneOffset()),
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: String(isMobile),
      is_touch: String('ontouchstart' in window),
      max_touch_points: String(navigator.maxTouchPoints || 0),
      browser_name: browserName,
      os_name: osName
    };
    const u = new URLSearchParams();
    Object.entries({ ...o, ...l }).forEach(([k, v]) => u.append(k, String(v)));
    return { sortedPayload, urlParams: u.toString(), timestamp, feVersionHint: version };
  }, userId, feVersion);
  return { ...context, token };
}

async function getModels() {
  const items = await page.evaluate(async base => {
    const token = localStorage.getItem('token') || '';
    const response = await fetch(base + '/api/models', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    const text = await response.text();
    if (!response.ok) throw new Error('Chat Z.ai model list returned HTTP ' + response.status + ': ' + text.slice(0, 220));
    let payload; try { payload = JSON.parse(text); } catch { throw new Error('Chat Z.ai returned an invalid model list.'); }
    const list = Array.isArray(payload) ? payload : (payload.data || payload.models || []);
    return list.filter(Boolean);
  }, ZAI_BASE);
  modelMeta = new Map();
  const ids = [];
  for (const item of items) {
    const id = String(typeof item === 'string' ? item : (item && (item.id || item.name)) || '').trim();
    if (!id || modelMeta.has(id)) continue;
    modelMeta.set(id, {
      completionVersion: String((item && item.completion_version) || ''),
      reasoning: !!(item && item.info && item.info.meta && item.info.meta.capabilities && item.info.meta.capabilities.reasoning),
      raw: item && typeof item === 'object' ? item : null
    });
    ids.push(id);
  }
  modelsCache = ids;
  return ids;
}

async function initialize() {
  if (!CHROME_PATH) throw new Error('Chrome or Microsoft Edge was not detected. Install Chrome/Edge or set CHROME_PATH.');
  if (!TOKEN) throw new Error('The CodeSpace bridge token was not provided to the Chat Z.ai adapter.');
  if (!PROFILE_DIR) throw new Error('The persistent Chat Z.ai browser profile path was not configured.');
  puppeteer = require('puppeteer-core');
  require('node:fs').mkdirSync(PROFILE_DIR, { recursive: true });
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    // Dedicated persistent profile: sign in once without borrowing the user's everyday browser profile.
    userDataDir: PROFILE_DIR,
    headless: process.env.CODESPACE_CHAT_ZAI_HEADLESS === '1',
    // Chrome's sandbox stays ON; it is only disabled where Chrome cannot start otherwise (root on Linux).
    args: [...((process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) || process.env.CODESPACE_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []), '--disable-dev-shm-usage', '--disable-gpu']
  });
  page = await browser.newPage();
  await page.goto(ZAI_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
  // 3.13.19: seed the token harvested from CodeSpace's Integrated Browser into this profile and
  // reload, so the site boots with the session and no interactive sign-in window is required.
  if (SESSION_TOKEN) {
    await page.evaluate(t => { try { localStorage.setItem('token', t); } catch {} }, SESSION_TOKEN);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  // First launch: without a harvested token the web mode still opens a dedicated browser window
  // for a one-time sign-in; desktop mode runs headless and expects the Integrated Browser session.
  try {
    await page.waitForFunction(() => !!localStorage.getItem('token'), { timeout: LOGIN_WAIT_MS });
  } catch {
    throw new Error(SESSION_TOKEN
      ? 'The captured chat.z.ai session was rejected (expired or invalid). Open chat.z.ai in the CodeSpace Browser panel, sign in again — CodeSpace captures the fresh session automatically — then switch Chat Z.ai ON.'
      : 'No chat.z.ai session was found. In CodeSpace Desktop: open chat.z.ai in the Browser panel (Run menu > Open chat.z.ai), sign in, and the session is captured automatically — then switch Chat Z.ai ON. In web mode: sign in in the opened Chat Z.ai browser window, then switch Chat Z.ai ON again.');
  }
  await discoverFeVersion();
  await fetchUserId();
  await getModels();
  if (!modelsCache.length) throw new Error('Chat Z.ai did not return any available models.');
}

async function refreshSession() {
  if (!page) throw new Error('Chat Z.ai browser session is not initialized.');
  // Reload without deleting localStorage: clearing the token would log out the
  // user and silently replace an account session with a guest session.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'), { timeout: LOGIN_WAIT_MS });
  await discoverFeVersion();
  await fetchUserId();
  await getModels();
  if (!modelsCache.length) throw new Error('Chat Z.ai session refreshed, but no models were returned.');
}

function chunk(id, model, delta, finishReason) {
  const item = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }] };
  return 'data: ' + JSON.stringify(item) + '\n\n';
}

/* ===================== chat handling ===================== */

async function createSignedRequest(body) {
  const model = String(body.model || modelsCache[0] || '');
  const messages = normalizeMessages(body.messages);
  const prompt = promptFor(messages);
  const context = await buildQueryContext();
  const { signature, timestamp } = signRequest(context.sortedPayload, prompt, context.timestamp);
  const meta = modelMeta.get(model) || {};
  const useV1 = String(meta.completionVersion) === '1';
  const id = crypto.randomUUID();
  const chatBody = {
    model,
    messages,
    stream: true,
    signature_prompt: prompt,
    chat_id: crypto.randomUUID(),
    id,
    session_id: crypto.randomUUID(),
    params: {},
    extra: {},
    features: { image_generation: false, web_search: !!body.web_search, auto_web_search: !!body.web_search, preview_mode: true, flags: [], enable_thinking: body.enable_thinking !== false },
    variables: {}
  };
  if (useV1) {
    chatBody.model_item = meta.raw && typeof meta.raw === 'object' ? meta.raw : { id: model };
  } else {
    chatBody.current_user_message_id = id;
    chatBody.current_user_message_parent_id = null;
  }
  if (Array.isArray(body.tools) && body.tools.length) chatBody.tools = body.tools;
  if (body.tool_choice) chatBody.tool_choice = body.tool_choice;
  return {
    paths: useV1 ? ['/api/chat/completions', '/api/v2/chat/completions'] : ['/api/v2/chat/completions', '/api/chat/completions'],
    headers: {
      Authorization: 'Bearer ' + context.token,
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN',
      'X-FE-Version': feVersion,
      'X-Signature': signature,
      Origin: ZAI_BASE,
      Referer: ZAI_BASE + '/'
    },
    body: JSON.stringify(chatBody),
    query: context.urlParams + '&signature_timestamp=' + encodeURIComponent(timestamp)
  };
}

/* Opens the upstream completion stream. A rejected session (HTTP 401, or 403 mentioning the
   signature/token) refreshes the session ONCE and signs the request again; a path/version mismatch
   tries the alternate endpoint. */
async function openUpstream(body, signal) {
  let refreshed = false;
  for (let round = 0; round < 2; round++) {
    const signed = await createSignedRequest(body);
    let again = false;
    for (let attempt = 0; attempt < signed.paths.length; attempt++) {
      const pathPart = signed.paths[attempt];
      const candidate = await fetch(ZAI_BASE + pathPart + '?' + signed.query, { method: 'POST', headers: signed.headers, body: signed.body, signal });
      if (candidate.ok && candidate.body) return { upstream: candidate, path: pathPart };
      const detail = await candidate.text().catch(() => '');
      const authProblem = candidate.status === 401 || (candidate.status === 403 && /signature|token|auth|expired|login|session/i.test(detail));
      if (authProblem && !refreshed) { refreshed = true; again = true; await refreshSession().catch(() => {}); break; }
      const retryable = attempt < signed.paths.length - 1 && (candidate.status === 404 || (candidate.status === 400 && /completion.?version|endpoint|not found/i.test(detail)));
      if (!retryable) throw Object.assign(new Error('Chat Z.ai returned HTTP ' + candidate.status + ' (' + pathPart + '): ' + detail.slice(0, 500) + (authProblem ? ' — the session was refreshed but is still rejected; open chat.z.ai in the CodeSpace Browser panel and sign in again.' : '')), { status: candidate.status || 502 });
    }
    if (!again) break;
  }
  throw Object.assign(new Error('Chat Z.ai did not return a usable response body.'), { status: 502 });
}

const UPSTREAM_TOTAL_MS = 15 * 60 * 1000;
const UPSTREAM_IDLE_MS = Math.max(20000, Number(process.env.CODESPACE_CHAT_ZAI_IDLE_MS) || 120000);

async function handleChat(req, res) {
  const body = await readBody(req);
  let model = String(body.model || modelsCache[0] || '');
  if (!modelsCache.includes(model)) await getModels().catch(() => {}); // the site may have added the model since startup
  if (!modelsCache.includes(model)) throw Object.assign(new Error('Unknown Chat Z.ai model: ' + model + '. Refresh the model list in CodeSpace.'), { status: 400 });
  const messages = normalizeMessages(body.messages);
  if (!messages.length) throw Object.assign(new Error('At least one message is required.'), { status: 400 });

  // One controller covers: client disconnect (Stop), the overall time limit and the idle watchdog.
  const ac = new AbortController();
  let abortReason = '', idleTimer = 0;
  const abortWith = reason => { if (!abortReason) abortReason = reason; ac.abort(); };
  const totalTimer = setTimeout(() => abortWith('total'), UPSTREAM_TOTAL_MS);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abortWith('idle'), UPSTREAM_IDLE_MS); };
  const onClientClose = () => { if (!res.writableEnded) abortWith('client'); };
  res.once('close', onClientClose);
  const cleanup = () => { clearTimeout(totalTimer); clearTimeout(idleTimer); res.removeListener('close', onClientClose); };
  const explain = error => {
    if (abortReason === 'idle') return Object.assign(new Error('Chat Z.ai stopped sending data for ' + Math.round(UPSTREAM_IDLE_MS / 1000) + ' s (timed out).'), { status: 504 });
    if (abortReason === 'total') return Object.assign(new Error('Chat Z.ai took longer than ' + Math.round(UPSTREAM_TOTAL_MS / 60000) + ' minutes (timed out).'), { status: 504 });
    return error;
  };
  try {
    armIdle();
    let upstream;
    try { ({ upstream } = await openUpstream({ ...body, model, messages }, ac.signal)); }
    catch (error) { throw explain(error); }
    await streamUpstream(upstream, body, model, res, armIdle, () => abortReason, explain);
  } finally { cleanup(); }
}

async function streamUpstream(upstream, body, model, res, armIdle, getAbortReason, explain) {
  const streaming = body.stream !== false;
  const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const decoder = new TextDecoder();

  // 3.13.20: nothing is written to the client until the upstream stream proves usable. An empty
  // or error stream now surfaces as a real error instead of a silent empty reply.
  let headersSent = false;
  const beginStream = () => {
    if (headersSent || !streaming) return;
    headersSent = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'X-Accel-Buffering': 'no' });
    res.write(chunk(id, model, { role: 'assistant', content: '' }));
  };
  const consumer = createStreamConsumer(part => {
    beginStream();
    if (streaming) res.write(chunk(id, model, part));
  });

  let buffer = '', rawSample = '';
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      armIdle(); // data is flowing: restart the idle watchdog
      const text = decoder.decode(value, { stream: true });
      if (rawSample.length < 600) rawSample = (rawSample + text).slice(0, 600);
      buffer += text;
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) consumer.consumeLine(line.replace(/\r$/, ''));
    }
    if (buffer.trim()) consumer.consumeLine(buffer.trim());
  } catch (error) {
    const reason = getAbortReason();
    if (reason === 'client') { try { res.end(); } catch {} return; } // the user pressed Stop
    const failure = explain(error);
    if (headersSent) {
      // Tell the client the stream broke (instead of ending it as if complete) so it can retry / switch model.
      try { res.write('data: ' + JSON.stringify({ error: { message: 'Chat Z.ai stream interrupted: ' + (failure.message || failure), code: failure.status || 502, type: 'chat_zai_bridge_error' } }) + '\n\n'); res.end(); } catch {}
      return;
    }
    throw failure;
  }

  const state = consumer.finalize();
  if (!state.answer.trim() && !state.reasoning && !state.tools.length) {
    // Never ship an empty reply: surface what the upstream actually said so the failure is diagnosable.
    let detail = '';
    if (state.upstreamError) detail = 'Chat Z.ai reported: ' + state.upstreamError;
    else if (rawSample.trim()) {
      let hint = '';
      try { const j = JSON.parse(rawSample.trim().replace(/^data:\s*/, '')); hint = String((j && (j.detail || (j.error && j.error.message) || j.message)) || ''); } catch {}
      detail = hint ? 'Chat Z.ai reported: ' + hint : 'unrecognized stream payload: ' + rawSample.slice(0, 300);
    } else detail = 'the stream ended after ' + state.eventCount + ' event(s) with no completion content';
    throw Object.assign(new Error('Chat Z.ai returned no usable completion (' + detail + '). If this mentions the signature or session, open chat.z.ai in the CodeSpace Browser panel and sign in again — the fresh session is captured automatically.'), { status: 502 });
  }
  // Reconcile: make sure the client's accumulated text matches the final derived answer.
  if (streaming && headersSent && state.answer.startsWith(state.emittedAnswer) && state.answer.length > state.emittedAnswer.length) {
    res.write(chunk(id, model, { content: state.answer.slice(state.emittedAnswer.length) }));
  }
  const finishReason = state.finishReason || (state.tools.length ? 'tool_calls' : 'stop');
  if (streaming) {
    beginStream();
    const final = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (state.usage) final.usage = state.usage;
    res.write('data: ' + JSON.stringify(final) + '\n\n'); res.write('data: [DONE]\n\n'); res.end();
  } else {
    const message = { role: 'assistant', content: state.answer };
    if (state.reasoning) message.reasoning_content = state.reasoning;
    if (state.tools.length) message.tool_calls = state.tools;
    json(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finishReason }], usage: state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (!authorized(req)) return json(res, 401, { error: { message: 'Unauthorized CodeSpace Chat Z.ai bridge request.' } });
  const pathname = String(req.url || '/').split('?')[0];
  try {
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: !!page, ready: !!page && modelsCache.length > 0, session: !!page, persistentProfile: true, service: 'codespace-chat-zai', baseUrl: 'http://127.0.0.1:' + PORT + '/v1', models: modelsCache, frontendVersion: feVersion, signatureMode: 'native-3.13.21' });
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      if (!page) throw new Error('Chat Z.ai browser session is not ready.');
      if (!modelsCache.length) await getModels();
      return json(res, 200, { object: 'list', data: modelsCache.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'zhipu' })) });
    }
    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) return await handleChat(req, res);
    return json(res, 404, { error: { message: 'Not found. Use GET /v1/models or POST /v1/chat/completions.' } });
  } catch (error) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    return json(res, error.status || 500, { error: { message: error.message || String(error), type: 'chat_zai_bridge_error' } });
  }
});

server.on('error', error => {
  // e.g. EADDRINUSE when a previous bridge is still holding the port: report it instead of dying silently.
  const msg = error && error.code === 'EADDRINUSE'
    ? 'Port ' + PORT + ' is already in use (a previous Chat Z.ai bridge may still be running). Close it or restart CodeSpace.'
    : 'The Chat Z.ai bridge server failed: ' + (error && error.message || error);
  console.error('[Chat Z.ai] ' + msg);
  if (typeof process.send === 'function') process.send({ type: 'error', error: msg });
  process.exitCode = 1; setTimeout(() => process.exit(1), 200);
});
async function shutdown() {
  try { server.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
}

/* 3.13.19: live session handover. When the user signs in again inside CodeSpace's Integrated
   Browser while the bridge is already running, the agent-server forwards the fresh token here so
   the running bridge keeps working without a restart. */
async function applyLiveSessionToken(tok) {
  if (!page) return;
  await page.evaluate(t => { try { localStorage.setItem('token', t); } catch {} }, tok);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await discoverFeVersion();
  await fetchUserId();
  await getModels();
  console.log('[Chat Z.ai] session token updated from CodeSpace Browser (' + modelsCache.length + ' models, frontend ' + feVersion + ')');
}

async function main() {
  await initialize();
  server.listen(PORT, '127.0.0.1', () => {
    console.log('[Chat Z.ai] ready on http://127.0.0.1:' + PORT + '/v1 (' + modelsCache.length + ' models, frontend ' + feVersion + ', native signature)');
    if (typeof process.send === 'function') process.send({ type: 'ready', port: PORT, models: modelsCache });
  });
}

module.exports = { sha256Hmac, sortedPayloadFor, signRequest, visibleAfterDetails, createStreamConsumer, normalizeMessages, promptFor, KNOWN_FE_VERSION, SIGN_SECRET };

if (require.main === module) {
  process.on('unhandledRejection', error => console.error('[Chat Z.ai] unhandled rejection:', error && error.message || error));
  main().catch(error => {
    console.error('[Chat Z.ai] startup failed:', error.message || error);
    if (typeof process.send === 'function') process.send({ type: 'error', error: error.message || String(error) });
    process.exitCode = 1;
  });
  process.on('message', msg => {
    if (!msg || msg.type !== 'session-token' || !msg.token) return;
    applyLiveSessionToken(String(msg.token).trim()).catch(error => console.error('[Chat Z.ai] live session update failed:', error.message || error));
  });
  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
}
