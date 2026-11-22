'use strict';
/* ================= core: helpers, state ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 20000) => (s.length > n ? s.slice(0, n) + '\n…[truncated, ' + (s.length - n) + ' more characters]' : s);
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)));
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', '.idea', '.vscode']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|wasm|bin|class|jar)$/i;

const DEFAULT_CTX = 232000;
const PRESETS = {
  llama:      { name: 'llama.cpp',  format: 'openai',    base: 'http://localhost:8080/v1',       auth: 'none',      model: 'local',            ctx: DEFAULT_CTX },
  ollama:     { name: 'Ollama',     format: 'openai',    base: 'http://localhost:11434/v1',      auth: 'none',      model: 'llama3.1',         ctx: DEFAULT_CTX },
  lmstudio:   { name: 'LM Studio',  format: 'openai',    base: 'http://localhost:1234/v1',       auth: 'none',      model: 'local-model',      ctx: DEFAULT_CTX },
  vllm:       { name: 'vLLM',       format: 'openai',    base: 'http://localhost:8000/v1',       auth: 'none',      model: '',                 ctx: DEFAULT_CTX },
  together:   { name: 'Together AI', format: 'openai',   base: 'https://api.together.xyz/v1',    auth: 'bearer',    model: '',                 ctx: 128000 },
  deepseek:   { name: 'DeepSeek',   format: 'openai',    base: 'https://api.deepseek.com/v1',    auth: 'bearer',    model: 'deepseek-chat',    ctx: 64000 },
  mistral:    { name: 'Mistral',    format: 'openai',    base: 'https://api.mistral.ai/v1',      auth: 'bearer',    model: '',                 ctx: 128000 },
  openai:     { name: 'OpenAI',     format: 'openai',    base: 'https://api.openai.com/v1',      auth: 'bearer',    model: '',                 ctx: 128000, vision: true },
  openrouter: { name: 'OpenRouter', format: 'openai',    base: 'https://openrouter.ai/api/v1',   auth: 'bearer',    model: '',                 ctx: 128000 },
  groq:       { name: 'Groq',       format: 'openai',    base: 'https://api.groq.com/openai/v1', auth: 'bearer',    model: '',                 ctx: 128000 },
  anthropic:  { name: 'Claude',     format: 'anthropic', base: 'https://api.anthropic.com',      auth: 'x-api-key', model: 'claude-sonnet-5-5', ctx: 200000, vision: true }
};
const PROV_DEFAULT = { name: 'llama.cpp (local)', format: 'openai', base: 'http://localhost:8080/v1', path: '/chat/completions', model: 'local', key: '', auth: 'none', extra: '', vision: false, ctx: DEFAULT_CTX, think: false, thinkBudget: 4096, authHeader: '', extraBody: '' };

let S = { providers: [], activeId: '', sys: 'You are a helpful, honest coding assistant. Keep answers clear and concise.', temp: 0.7, agentOn: true, multiAgent: false, multiAgentModels: { planner: '', architect: '', researcher: '', test: '', implementer: '', debugger: '', reviewer: '' }, autoCompress: true, humanize: true, tokenSaver: true, autoCheckpoint: true, permMode: 'smart', smartTools: true, rules: [], browserVisible: true, browserPersist: true, openCodeCLI: false, openCodeAutoApprove: false, chatZaiCLI: false, copilotAuto: false, chatZaiPrevId: '', theme: 'auto', thinkLevel: 'off', updated: 0, v: 6 };
let L = { bridgeUrl: 'http://127.0.0.1:8787', bridgeToken: '' };
let sessions = [], curId = '';
let ctrl = null, dirHandle = null, compressing = false, saverSaved = 0;
const B = { ok: false, info: null, skills: [], ext: [], conn: {} };
const autoOk = new Set();
const blankSession = () => ({ id: uid() + uid(), title: 'New chat', updated: Date.now(), messages: [], usage: null, costEntries: [], plan: [], planExpanded: false });
function stripLegacyInjectedUserContext(content) {
  const s = String(content || '');
  const markers = [
    '[Relevant workspace project memory', '[Smart code retrieval:', '[Relevant project context:',
    '[Attached file:', '[Attached project file:', '[Attached editor selection]'
  ];
  let cut = -1;
  for (const marker of markers) {
    const at = s.indexOf(marker);
    if (at >= 0 && (cut < 0 || at < cut)) cut = at;
  }
  return cut < 0 ? s : s.slice(0, cut).trimEnd();
}
function cleanLegacyInjectedUserContext(list) {
  for (const session of list || []) for (const message of (session.messages || [])) {
    if (message && message.role === 'user' && typeof message.content === 'string') {
      message.content = stripLegacyInjectedUserContext(message.content);
    }
  }
}
function stripInternalContextDump(content, userPrompt = '') {
  const s = String(content || '').trim();
  if (!s) return '';
  // Only strip automatic context-dump banners; normal, user-requested code explanations remain intact.
  if (/(?:show|quote|print|explain|summari[sz]e)\b.{0,80}\b(?:retrieval context|context dump|specialist findings|project excerpts)\b/i.test(String(userPrompt || ''))) return s;
  const marker = /\[?\s*(?:Smart code retrieval:|Relevant project context:|Relevant workspace project memory\b|PRIVATE SPECIALIST FINDINGS\b|INDEPENDENT QA REVIEW\b)/i;
  const at = s.search(marker);
  return at < 0 ? s : s.slice(0, at).trim();
}
function isWorkspaceVisibilityQuestion(prompt) {
  const q = String(prompt || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  return /\b(did you see|can you see|do you see|are you able to see|can you access|do you have access to)\b.{0,55}\b(workspace|project|files?)\b/.test(q)
    || /\b(workspace|project)\b.{0,40}\b(visible|open|connected|available)\b/.test(q);
}
function workspaceVisibilityAnswer() {
  return B.ok && B.info && B.info.root ? 'Yes.' : 'No.';
}
const cur = () => sessions.find(x => x.id === curId);
const hist = () => cur().messages;
const P = () => S.providers.find(p => p.id === S.activeId) || S.providers[0];

function migrate(o) {
  if ((o.v || 0) < 4) { if (Number(o.steps) === 15) o.steps = 0; o.v = 4; }
  if (o.v < 5) { (o.providers || []).forEach(p => { if (!p.ctx || Number(p.ctx) === 8192) p.ctx = DEFAULT_CTX; }); o.v = 5; }
  // v6: prefer a visible, persistent full browser so iframe-only sites and manual security checks are usable.
  if ((o.v || 0) < 6) { o.browserVisible = true; o.browserPersist = true; o.v = 6; }
  return o;
}
function nativeBridgeConfig() {
  // Android passes the active bridge directly from native preferences. This is authoritative:
  // if localStorage is stale (for example after a sandbox switch or a WebView restore), the
  // page must still connect to the provider the user selected instead of silently using Local.
  try {
    const api = window.CodeSpaceNative;
    if (!api || typeof api.bridgeConfig !== 'function') return null;
    const cfg = JSON.parse(api.bridgeConfig() || '{}');
    if (!cfg || !cfg.bridgeUrl) return null;
    return {
      bridgeUrl: String(cfg.bridgeUrl),
      bridgeToken: String(cfg.bridgeToken || ''),
      sandboxMode: String(cfg.sandboxMode || ''),
      remote: !!cfg.remote,
      // v47.3: device-owned tool capabilities. Present even when the AI runs in a remote sandbox.
      deviceCapabilities: (cfg.deviceCapabilities && typeof cfg.deviceCapabilities === 'object') ? cfg.deviceCapabilities : null
    };
  } catch { return null; }
}
function loadAll() {
  try { const sv = JSON.parse(localStorage.getItem('agent3.state') || '{}'); Object.assign(S, sv); S.v = sv.v || 0; } catch {}
  migrate(S);
  // The old composer exposed Ask first / Smart / Auto-run. Map legacy Ask first to the new Default permissions mode.
  if (S.permMode === 'ask' || !['smart', 'auto', 'all'].includes(S.permMode)) S.permMode = 'smart';
  try { Object.assign(L, JSON.parse(localStorage.getItem('agent3.local') || '{}')); } catch {}
  const nativeBridge = nativeBridgeConfig();
  if (nativeBridge) {
    L.bridgeUrl = nativeBridge.bridgeUrl; L.bridgeToken = nativeBridge.bridgeToken;
    L.sandboxMode = nativeBridge.sandboxMode; L.remoteSandbox = nativeBridge.remote;
    L.deviceCapabilities = nativeBridge.deviceCapabilities;
  }
  // OpenCode CLI is a genuine Android-local runtime (Termux RUN_COMMAND). Preserve the user's
  // selection across WebView reloads; availability is validated live by toggleOpenCode() /
  // runOpenCodeChat() via the real /opencode/status probe, so a stale true can never dispatch to
  // a dead backend. Never silently switch to another provider.
  try { sessions = JSON.parse(localStorage.getItem('agent3.sessions') || '[]'); } catch { sessions = []; }
  curId = localStorage.getItem('agent3.cur') || '';
  if (!S.providers.length) { // bring over settings and the last chat from the previous version
    try {
      const o = JSON.parse(localStorage.getItem('agent2.state') || 'null');
      if (o && o.providers && o.providers.length) {
        S.providers = o.providers.map(p => ({ ctx: DEFAULT_CTX, ...p })); S.activeId = o.activeId;
        ['sys', 'temp', 'steps', 'agentOn'].forEach(k => { if (o[k] !== undefined) S[k] = o[k]; });
        // The native shell injects its bridge URL/token into agent3.local before the
        // page loads. Never let a legacy agent2 bridge setting overwrite Render or
        // the Android Local adapter.
        const injectedBridge = L.bridgeUrl === 'codespace-native://local' || /^https:\/\//i.test(L.bridgeUrl || '') || !!L.bridgeToken;
        if (!injectedBridge) { L.bridgeUrl = o.bridgeUrl || L.bridgeUrl; L.bridgeToken = o.bridgeToken || ''; }
        const h = JSON.parse(localStorage.getItem('agent2.history') || '[]');
        if (h.length && !sessions.length) sessions.push({ id: uid() + uid(), title: 'Imported chat', updated: Date.now(), messages: h, usage: null });
      }
    } catch {}
  }
  if (!S.providers.length) { const p = { ...PROV_DEFAULT, id: uid() }; S.providers = [p]; S.activeId = p.id; }
  if (!S.providers.some(p => p.id === S.activeId)) S.activeId = S.providers[0].id;
  if (!S.multiAgentModels || typeof S.multiAgentModels !== 'object') S.multiAgentModels = {};
  for (const role of ['planner', 'architect', 'researcher', 'test', 'implementer', 'debugger', 'reviewer']) if (typeof S.multiAgentModels[role] !== 'string') S.multiAgentModels[role] = '';
  S.providers.forEach(p => { if (!p.ctx) p.ctx = DEFAULT_CTX; p.inputRate = Math.max(0, Number(p.inputRate) || 0); p.outputRate = Math.max(0, Number(p.outputRate) || 0); p.promptCache = !!p.promptCache; });
  if (!sessions.length) sessions.push(blankSession());
  sessions.forEach(x => { if (!Array.isArray(x.plan)) x.plan = []; if (!Array.isArray(x.costEntries)) x.costEntries = []; if (!Array.isArray(x.tasks)) x.tasks = []; });
  if (typeof markRecoveredTasksInterrupted === 'function') markRecoveredTasksInterrupted();
  cleanLegacyInjectedUserContext(sessions);
  if (!sessions.some(x => x.id === curId)) curId = sessions[0].id;
}
function saveLocal() { try { localStorage.setItem('agent3.state', JSON.stringify(S)); localStorage.setItem('agent3.local', JSON.stringify(L)); } catch {} }
const stripSession = s => ({ ...s, messages: s.messages.map(m => { const o = { ...m }; delete o.image; delete o.images; return o; }) });
let sessionDbPromise = null, idbBooted = false, idbSaveQueued = false;
function openSessionDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (sessionDbPromise) return sessionDbPromise;
  sessionDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('my-chat-agent-v3', 1);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error || new Error('Could not open IndexedDB'));
  });
  return sessionDbPromise;
}
function idbCopySession(s) {
  return { ...s, messages: (s.messages || []).map(m => { const o = { ...m }; delete o.image; return o; }) };
}
async function persistSessionsIDB() {
  if (!idbBooted) { idbSaveQueued = true; return; }
  const db = await openSessionDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite'), store = tx.objectStore('sessions');
    sessions.forEach(s => store.put(idbCopySession(s)));
    const keep = new Set(sessions.map(s => s.id)); const keys = store.getAllKeys();
    keys.onsuccess = () => keys.result.forEach(k => { if (!keep.has(k)) store.delete(k); });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed')); tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}
async function hydrateSessionsIDB() {
  try {
    const db = await openSessionDB();
    const saved = await new Promise((resolve, reject) => { const req = db.transaction('sessions', 'readonly').objectStore('sessions').getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); });
    if (saved.length) {
      const byId = new Map(saved.map(x => [x.id, x]));
      sessions.forEach(x => { const old = byId.get(x.id); if (!old || Number(x.updated) > Number(old.updated)) byId.set(x.id, idbCopySession(x)); });
      sessions = [...byId.values()].sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0));
      cleanLegacyInjectedUserContext(sessions);
      if (typeof markRecoveredTasksInterrupted === 'function') markRecoveredTasksInterrupted();
      if (!sessions.some(x => x.id === curId)) curId = sessions[0] && sessions[0].id || '';
    }
    idbBooted = true; saveSessionsLocal();
    // 3.12.6: late IndexedDB hydration used to rebuild the chat even while a turn was running,
    // wiping transient notes (e.g. "Auto-resume 1 of 2") mid-run. Skip the rebuild during an
    // active turn — the hydrated session data is still merged above, only the DOM rebuild waits.
    if (ctrl) { renderSessions(); updateMeters(); }
    else { renderHistory(); renderSessions(); updateMeters(); }
  } catch { idbBooted = true; }
  if (idbSaveQueued) { idbSaveQueued = false; persistSessionsIDB().catch(() => {}); }
}
function saveSessionsLocal() {
  // IndexedDB is the full local store; localStorage is a compact migration/fallback copy.
  if (idbBooted) persistSessionsIDB().catch(() => {}); else idbSaveQueued = true;
  const list = sessions.slice().sort((a, b) => b.updated - a.updated).slice(0, 5).map(s => {
    const c = stripSession(s); c.messages = c.messages.slice(-32).map(m => { const o = { ...m }; if (typeof o.content === 'string' && o.content.length > 12000) o.content = o.content.slice(0, 6000) + '\n…[localStorage fallback trim]…\n' + o.content.slice(-2000); return o; });
    delete c.costEntries; return c;
  });
  try { localStorage.setItem('agent3.sessions', JSON.stringify(list)); localStorage.setItem('agent3.cur', curId); } catch {
    try { localStorage.setItem('agent3.sessions', JSON.stringify(list.slice(0, 2))); localStorage.setItem('agent3.cur', curId); } catch {}
  }
}
let pushT = null;
function persistSession() {
  saveSessionsLocal();
  if (!B.ok) return;
  clearTimeout(pushT);
  pushT = setTimeout(() => { const s = cur(); if (s && s.messages.length) bcall('/sessions/save', { id: s.id, session: stripSession(s) }).catch(() => {}); }, 800);
}
function applyTheme() { document.documentElement.setAttribute('data-theme', S.theme || 'auto'); }
function applyFontSizes() { document.documentElement.style.setProperty('--chat-font-size', (Math.max(12, Math.min(16, Number(S.chatFont)||13))) + 'px'); document.documentElement.style.setProperty('--editor-font-size', (Math.max(11, Math.min(18, Number(S.editorFont)||13))) + 'px'); }

/* ================= authenticated server-sent event streams ================= */
