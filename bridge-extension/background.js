'use strict';
/* CodeSpace Bridge - background service worker.
   Long-polls the local CodeSpace bridge (127.0.0.1 only), runs the AI's browser commands on tabs the
   agent opened or the user shared, and posts results back. It never reads cookies or saved passwords,
   never touches tabs that were not opened/shared, and refuses to act on bot-check pages. */

const DEFAULT_URL = 'http://127.0.0.1:8787';
const CHALLENGE_MSG = 'This page is showing a security verification or bot-check. Complete it yourself in Chrome first; the agent will not click, type or bypass it.';
let looping = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getCfg = () => chrome.storage.local.get({ bridgeUrl: DEFAULT_URL, token: '', enabled: false });
const getState = () => chrome.storage.session.get({ allowed: [], owned: [], current: null });
const setState = v => chrome.storage.session.set(v);
function badge(text, color) { try { chrome.action.setBadgeText({ text }); if (color) chrome.action.setBadgeBackgroundColor({ color }); } catch {} }

function loopbackBase(cfg) {
  let u; try { u = new URL(cfg.bridgeUrl); } catch { throw new Error('Bridge address is not a valid URL'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('For safety the bridge address must be http://127.0.0.1:<port>');
  return u.origin;
}
async function api(cfg, path, body, timeout = 30000) {
  const r = await fetch(loopbackBase(cfg) + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeout) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

/* ---------- tab bookkeeping ---------- */
async function allow(tabId, { owned = false, makeCurrent = true } = {}) {
  const st = await getState();
  await setState({
    allowed: st.allowed.includes(tabId) ? st.allowed : [...st.allowed, tabId],
    owned: owned && !st.owned.includes(tabId) ? [...st.owned, tabId] : st.owned,
    current: makeCurrent ? tabId : st.current
  });
}
async function forget(tabId) {
  const st = await getState();
  await setState({ allowed: st.allowed.filter(x => x !== tabId), owned: st.owned.filter(x => x !== tabId), current: st.current === tabId ? null : st.current });
}
chrome.tabs.onRemoved.addListener(id => { forget(id).catch(() => {}); });

async function targetTab() {
  const st = await getState();
  let id = st.allowed.includes(st.current) ? st.current : st.allowed[st.allowed.length - 1];
  if (id == null) throw new Error("No tab is available to the agent. Use browser_open, or click the CodeSpace Bridge icon and press 'Share this tab'.");
  try { return await chrome.tabs.get(id); }
  catch { await forget(id); throw new Error('That tab was closed. Use browser_open to open a page.'); }
}

function waitForLoad(tabId, ms = 20000) {
  return new Promise(resolve => {
    let saw = false, done = false, t = null, quick = null;
    const fin = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); clearTimeout(quick); resolve(); };
    const on = (id, info) => { if (id !== tabId) return; if (info.status === 'loading') saw = true; if (info.status === 'complete' && saw) setTimeout(fin, 400); };
    t = setTimeout(fin, ms);
    quick = setTimeout(async () => { if (saw) return; try { const tab = await chrome.tabs.get(tabId); if (tab.status === 'complete') fin(); } catch { fin(); } }, 1500);
    chrome.tabs.onUpdated.addListener(on);
  });
}
async function settle(tabId) {
  await sleep(350);
  try { const t = await chrome.tabs.get(tabId); if (t.status === 'loading') await waitForLoad(tabId, 10000); } catch {}
}

async function inPage(tabId, func, args = [], world = 'ISOLATED') {
  let res;
  try { res = await chrome.scripting.executeScript({ target: { tabId }, func, args, world }); }
  catch (e) { throw new Error('Cannot access this page (' + String(e && e.message || e).slice(0, 160) + '). Browser-internal pages and the Chrome Web Store cannot be controlled.'); }
  return res && res[0] ? res[0].result : undefined;
}

/* ---------- functions that run inside the web page (must be self-contained) ---------- */
function pageInfo() {
  const t = document.title + ' ' + (document.body ? document.body.innerText : '').slice(0, 1600);
  return { url: location.href, title: document.title || '', console: [],
    challenge: /just a moment|verify you are human|checking your browser|security verification|unusual traffic|attention required/i.test(t) || !!document.querySelector('#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]') };
}
function pageChallenge() {
  const t = document.title + ' ' + (document.body ? document.body.innerText : '').slice(0, 1600);
  return /just a moment|verify you are human|checking your browser|security verification|unusual traffic|attention required/i.test(t) || !!document.querySelector('#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]');
}
function pageRead() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const selector = node => {
    const parts = [];
    for (let n = node, d = 0; n && n.nodeType === 1 && d < 30; n = n.parentElement, d++) {
      if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
      let q = n.tagName.toLowerCase();
      if (n === document.documentElement) { parts.unshift(q); break; }
      if (n !== document.body && n.parentElement) { const same = Array.prototype.filter.call(n.parentElement.children, c => c.tagName === n.tagName); if (same.length > 1) q += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(q);
    }
    return parts.join(' > ');
  };
  const isPw = e => String(e.getAttribute('type') || '').toLowerCase() === 'password';
  const els = Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]')).filter(visible).slice(0, 150).map(e => ({
    selector: selector(e), tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '',
    text: String(e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || (isPw(e) ? '' : e.value) || e.title || '').trim().slice(0, 180), href: e.href || '' }));
  const head = document.title + ' ' + (document.body ? document.body.innerText : '').slice(0, 1600);
  const info = { url: location.href, title: document.title || '', challenge: /just a moment|verify you are human|checking your browser|security verification|unusual traffic|attention required/i.test(head) || !!document.querySelector('#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]') };
  return { url: info.url, title: info.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), elements: els,
    scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, vw: innerWidth, vh: innerHeight, challenge: info.challenge, console: [] };
}
function pageClick(selector, x, y) {
  let el;
  try { el = selector ? document.querySelector(selector) : document.elementFromPoint(x || 0, y || 0); } catch (e) { return { ok: false, reason: 'Invalid selector: ' + selector }; }
  if (!el) return { ok: false, reason: 'No element found for the supplied selector or coordinates.' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  try { el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, o))); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', o));
  try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o))); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 120) };
}
function pageType(selector, value, clear, submit) {
  let el;
  try { el = document.querySelector(selector); } catch (e) { return { ok: false, reason: 'Invalid selector: ' + selector }; }
  if (!el) return { ok: false, reason: 'No element matches selector: ' + selector };
  el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus();
  const fire = (t, data) => el.dispatchEvent(new InputEvent(t, { bubbles: true, cancelable: true, inputType: 'insertText', data }));
  if (el.isContentEditable) {
    if (clear) { const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rg); document.execCommand('delete'); }
    if (!document.execCommand('insertText', false, value)) { el.textContent = (clear ? '' : el.textContent) + value; fire('input', value); }
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || !desc.set) return { ok: false, reason: 'Target is not a typeable input.' };
    fire('beforeinput', value); desc.set.call(el, clear ? value : el.value + value); fire('input', value); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (submit) {
    ['keydown', 'keypress', 'keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    if (el.form) { try { el.form.requestSubmit(); } catch (e) { el.form.submit(); } }
  }
  return { ok: true, tag: el.tagName.toLowerCase() };
}
function pageScroll(pixels, to) {
  const h = document.documentElement.scrollHeight;
  if (to === 'top') scrollTo({ top: 0, behavior: 'smooth' }); else if (to === 'bottom') scrollTo({ top: h, behavior: 'smooth' }); else scrollBy({ top: Number(pixels) || 0, behavior: 'smooth' });
  return true;
}
async function pageEval(src) {
  try {
    let fn; try { fn = new Function('return (' + src + ')'); } catch (e) { fn = new Function(src); }
    const v = await fn.call(window); let out;
    try { out = typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v, null, 2); } catch (e) { out = String(v); }
    return { ok: true, result: String(out).slice(0, 20000) };
  } catch (e) {
    const m = String(e && (e.message || e));
    return { ok: false, error: m.slice(0, 1000) + (/unsafe-eval|Content Security Policy/i.test(m) ? ' (this site blocks eval through its Content-Security-Policy)' : '') };
  }
}

/* ---------- commands ---------- */
/* Console capture: a tiny hook runs in the page's own (MAIN) world on tabs the agent may control. It records
   console.log/info/warn/error/debug, uncaught errors and unhandled promise rejections in a ring buffer inside the
   page. Each command drains what is new, so the agent sees messages that appeared between commands as well as
   output from its own browser_run_js code. Nothing leaves the page except through the agent's own command results. */
function pageConsoleHook() {
  try {
    if (window.__csConsole) return true;
    const MAX = 300, st = { buf: [], seq: 0, cursor: 0 };
    const one = x => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && typeof x.message === 'string' && typeof x.name === 'string') return String(x.stack || (x.name + ': ' + x.message)); // Error / DOMException, also from other realms
      try { const j = JSON.stringify(x); return j === undefined ? String(x) : j; } catch (e) { try { return String(x); } catch (e2) { return '[unprintable]'; } }
    };
    const push = (lvl, text) => { st.buf.push({ s: ++st.seq, t: (lvl === 'log' ? '' : lvl + ': ') + String(text).slice(0, 600) }); if (st.buf.length > MAX) st.buf.shift(); };
    Object.defineProperty(window, '__csConsole', { value: st, enumerable: false, configurable: true });
    ['log', 'info', 'warn', 'error', 'debug'].forEach(k => {
      const orig = console[k];
      console[k] = function () { try { push(k, Array.prototype.map.call(arguments, one).join(' ')); } catch (e) {} return orig.apply(this, arguments); };
    });
    window.addEventListener('error', e => { try { push('uncaught', (e.message || 'error') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')); } catch (x) {} });
    window.addEventListener('unhandledrejection', e => { try { push('unhandled rejection', one(e.reason)); } catch (x) {} });
    return true;
  } catch (e) { return false; }
}
function pageConsoleDrain(all, clear) {
  const st = window.__csConsole;
  if (!st) return { hooked: false, lines: [], omitted: 0 };
  let rows = all ? st.buf.slice() : st.buf.filter(x => x.s > st.cursor);
  const omitted = Math.max(0, rows.length - 100); rows = rows.slice(-100);
  st.cursor = st.seq;
  if (clear) st.buf.length = 0;
  return { hooked: true, lines: rows.map(x => x.t), omitted };
}
/* Network capture (no extra permission): like the console hook, a small script in the page's own world wraps
   fetch and XMLHttpRequest (method, address, status, timing, failures) and uses Resource Timing for scripts,
   images, styles and fonts. Headers, cookies and bodies are never read. Requests made before the hook was
   installed are only seen if they show up in Resource Timing. */
function pageNetHook() {
  try {
    if (window.__csNet) return true;
    const MAX = 300, st = { buf: [], seq: 0, cursor: 0 }, hookedAt = performance.now();
    const abs = u => { try { return new URL(String(u), location.href).href; } catch (e) { return String(u); } };
    const start = (kind, method, url) => { const r = { s: ++st.seq, k: kind, m: String(method || 'GET').toUpperCase(), u: abs(url).slice(0, 1000), st: null, er: '', t0: Date.now(), ms: null }; st.buf.push(r); if (st.buf.length > MAX) st.buf.shift(); return r; };
    const fin = (r, status, err) => { r.st = status == null ? null : status; r.er = err ? String(err).slice(0, 160) : ''; r.ms = Date.now() - r.t0; };
    Object.defineProperty(window, '__csNet', { value: st, enumerable: false, configurable: true });
    const ofetch = window.fetch;
    if (typeof ofetch === 'function') window.fetch = function (input, init) {
      let r = null;
      try { const url = typeof input === 'string' ? input : ((input && input.url) || String(input)); r = start('fetch', (init && init.method) || (input && input.method) || 'GET', url); } catch (e) {}
      const p = ofetch.apply(this, arguments);
      if (r) { try { p.then(resp => fin(r, resp.status), err => fin(r, null, (err && err.message) || 'failed')); } catch (e) {} }
      return p;
    };
    const OX = window.XMLHttpRequest;
    if (OX && OX.prototype) {
      const oopen = OX.prototype.open, osend = OX.prototype.send;
      OX.prototype.open = function (m, u) { try { this.__cs = { m, u }; } catch (e) {} return oopen.apply(this, arguments); };
      OX.prototype.send = function () {
        try { const i = this.__cs; if (i) { const r = start('xhr', i.m, i.u); this.addEventListener('loadend', () => fin(r, this.status || null, this.status ? '' : 'failed')); } } catch (e) {}
        return osend.apply(this, arguments);
      };
    }
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if ((e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && e.startTime >= hookedAt) continue; // already seen by the wrappers
          const r = start(e.initiatorType || 'resource', 'GET', e.name); fin(r, e.responseStatus || null); r.ms = Math.round(e.duration);
        }
      }).observe({ type: 'resource', buffered: true });
    } catch (e) {}
    window.addEventListener('error', ev => {
      try { const t = ev.target; if (t && t !== window && (t.src || t.href) && /^(IMG|SCRIPT|LINK|VIDEO|AUDIO|SOURCE)$/.test(t.tagName)) { const r = start(String(t.tagName).toLowerCase(), 'GET', t.src || t.href); fin(r, null, 'failed to load'); } } catch (e) {}
    }, true);
    return true;
  } catch (e) { return false; }
}
function pageNetDrain(all, clear, filter, failedOnly) {
  const st = window.__csNet;
  if (!st) return { hooked: false, rows: [], omitted: 0 };
  let rows = all ? st.buf.slice() : st.buf.filter(x => x.s > st.cursor);
  st.cursor = st.seq; if (clear) st.buf.length = 0;
  const f = String(filter || '').toLowerCase();
  if (f) rows = rows.filter(x => x.u.toLowerCase().indexOf(f) >= 0);
  if (failedOnly) rows = rows.filter(x => x.er || (x.st != null && x.st >= 400));
  const omitted = Math.max(0, rows.length - 100); rows = rows.slice(-100);
  return { hooked: true, omitted, rows: rows.map(x => ({ k: x.k, m: x.m, u: x.u, st: x.st, er: x.er, ms: x.ms })) };
}
async function drainNet(tabId, args) {
  try {
    await inPage(tabId, pageNetHook, [], 'MAIN');
    const r = await inPage(tabId, pageNetDrain, [!!args.all, !!args.clear, String(args.filter || '').slice(0, 200), !!args.failed_only], 'MAIN');
    return r || { hooked: false, rows: [], omitted: 0 };
  } catch (e) { return { hooked: false, rows: [], omitted: 0 }; }
}
async function ensureConsoleHook(tabId) { try { await inPage(tabId, pageConsoleHook, [], 'MAIN'); } catch (e) {} try { await inPage(tabId, pageNetHook, [], 'MAIN'); } catch (e) {} }
async function drainConsole(tabId, all, clear) {
  try {
    await inPage(tabId, pageConsoleHook, [], 'MAIN');
    const r = await inPage(tabId, pageConsoleDrain, [!!all, !!clear], 'MAIN');
    if (!r) return [];
    return (r.omitted ? ['(' + r.omitted + ' earlier message(s) omitted)'] : []).concat(r.lines || []);
  } catch (e) { return []; }
}
const readInfo = async tabId => { const i = await inPage(tabId, pageInfo); if (i) i.console = await drainConsole(tabId); return i; };
// Keep the hook installed after every navigation or reload on tabs the agent may control.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  try { const st = await getState(); if (st.allowed.includes(tabId)) { await chrome.scripting.executeScript({ target: { tabId }, func: pageConsoleHook, world: 'MAIN', injectImmediately: true }); await chrome.scripting.executeScript({ target: { tabId }, func: pageNetHook, world: 'MAIN', injectImmediately: true }); } } catch (e) {}
});
const refuseChallenge = async tabId => { if (await inPage(tabId, pageChallenge)) throw new Error(CHALLENGE_MSG); };
const HANDLERS = {
  async tabs(args) {
    let st = await getState();
    if (args.use != null) {
      const id = Number(args.use);
      if (!st.allowed.includes(id)) throw new Error('Tab ' + id + ' is not shared with the agent.');
      await setState({ current: id }); await chrome.tabs.update(id, { active: true }); st = await getState();
    }
    const tabs = [];
    for (const id of st.allowed) { try { const t = await chrome.tabs.get(id); tabs.push({ id, url: t.url || '', title: t.title || '', current: id === st.current }); } catch (e) {} }
    return { tabs };
  },
  async open(args) {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be opened.');
    const st = await getState(); let tab = null;
    if (!args.newTab && st.current != null && st.owned.includes(st.current)) { try { tab = await chrome.tabs.update(st.current, { url, active: true }); } catch (e) {} }
    if (!tab) tab = await chrome.tabs.create({ url, active: true });
    await allow(tab.id, { owned: true, makeCurrent: true });
    ensureConsoleHook(tab.id);
    await waitForLoad(tab.id);
    return await readInfo(tab.id);
  },
  async read() { const tab = await targetTab(); const r = await inPage(tab.id, pageRead); if (r) r.console = await drainConsole(tab.id); return r; },
  async console(args) {
    const tab = await targetTab(); const info = await inPage(tab.id, pageInfo);
    return { url: info.url, title: info.title, console: await drainConsole(tab.id, !!args.all, !!args.clear) };
  },
  async network(args) {
    const tab = await targetTab(); const info = await inPage(tab.id, pageInfo);
    const r = await drainNet(tab.id, args || {});
    return { url: info.url, title: info.title, hooked: !!r.hooked, omitted: r.omitted || 0, network: r.rows || [] };
  },
  async click(args) {
    const tab = await targetTab(); await refuseChallenge(tab.id);
    const r = await inPage(tab.id, pageClick, [String(args.selector || ''), Number(args.x) || 0, Number(args.y) || 0]);
    if (!r || !r.ok) throw new Error((r && r.reason) || 'Click failed.');
    await settle(tab.id); return await readInfo(tab.id);
  },
  async type(args) {
    const tab = await targetTab(); await refuseChallenge(tab.id);
    const r = await inPage(tab.id, pageType, [String(args.selector || ''), String(args.text == null ? '' : args.text), !!args.clear, !!args.submit]);
    if (!r || !r.ok) throw new Error((r && r.reason) || 'Typing failed.');
    await settle(tab.id); return await readInfo(tab.id);
  },
  async scroll(args) {
    const tab = await targetTab(); await refuseChallenge(tab.id);
    await inPage(tab.id, pageScroll, [Number(args.pixels) || 0, String(args.to || '')]);
    await sleep(300); return await readInfo(tab.id);
  },
  // v47.3: browser_back / browser_forward / browser_reload used to be sent by the frontend but
  // rejected here as an unsupported action. Implement them against the shared bridge tab.
  async back() {
    const tab = await targetTab();
    try { await chrome.tabs.goBack(tab.id); } catch (e) { throw new Error('Cannot go back: ' + (e && e.message || e)); }
    await settle(tab.id); return await readInfo(tab.id);
  },
  async forward() {
    const tab = await targetTab();
    try { await chrome.tabs.goForward(tab.id); } catch (e) { throw new Error('Cannot go forward: ' + (e && e.message || e)); }
    await settle(tab.id); return await readInfo(tab.id);
  },
  async reload() {
    const tab = await targetTab();
    try { await chrome.tabs.reload(tab.id); } catch (e) { throw new Error('Cannot reload: ' + (e && e.message || e)); }
    await settle(tab.id); return await readInfo(tab.id);
  },
  async screenshot() {
    const tab = await targetTab();
    await chrome.tabs.update(tab.id, { active: true }); await sleep(250);
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    const info = await readInfo(tab.id);
    return { image, url: info.url, title: info.title };
  },
  async eval(args) {
    const tab = await targetTab(); await refuseChallenge(tab.id);
    await ensureConsoleHook(tab.id);
    const r = await inPage(tab.id, pageEval, [String(args.code || '')], 'MAIN');
    await sleep(60);
    const con = await drainConsole(tab.id);
    if (!r || !r.ok) throw new Error(((r && r.error) || 'Script failed.') + (con.length ? '\n\nConsole:\n' + con.join('\n') : ''));
    return { result: r.result, console: con };
  },
  async close() {
    const st = await getState();
    for (const id of st.owned) { try { await chrome.tabs.remove(id); } catch (e) {} }
    await setState({ owned: [], allowed: st.allowed.filter(id => !st.owned.includes(id)), current: st.owned.includes(st.current) ? null : st.current });
    return { closed: st.owned.length };
  }
};

async function runCommand(cfg, cmd) {
  let out;
  try {
    const fn = Object.prototype.hasOwnProperty.call(HANDLERS, cmd.action) ? HANDLERS[cmd.action] : null;
    if (!fn) throw new Error('Unsupported action');
    out = { id: cmd.id, ok: true, result: await fn(cmd.args || {}) };
  } catch (e) { out = { id: cmd.id, ok: false, error: String(e && e.message || e) }; }
  try { await api(cfg, '/bridge/result', out, 30000); } catch (e) {}
}

async function loop() {
  if (looping) return; looping = true;
  try {
    for (;;) {
      const cfg = await getCfg();
      if (!cfg.enabled || !cfg.token) { badge('', ''); break; }
      try {
        const r = await api(cfg, '/bridge/poll', {}, 35000);
        badge('ON', '#188038');
        if (r && r.cmd) await runCommand(cfg, r.cmd);
      } catch (e) { badge('!', '#d93025'); await sleep(2500); }
    }
  } finally { looping = false; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    if (msg.type === 'share') { await allow(Number(msg.tabId), { owned: false, makeCurrent: true }); reply({ ok: true }); }
    else if (msg.type === 'unshare') { await forget(Number(msg.tabId)); reply({ ok: true }); }
    else if (msg.type === 'stopAll') { await setState({ allowed: [], owned: [], current: null }); await chrome.storage.local.set({ enabled: false }); badge('', ''); reply({ ok: true }); }
    else if (msg.type === 'wake') { loop(); reply({ ok: true }); }
    else if (msg.type === 'state') {
      const cfg = await getCfg(), st = await getState(), tabs = [];
      for (const id of st.allowed) { try { const t = await chrome.tabs.get(id); tabs.push({ id, title: t.title || '', url: t.url || '', current: id === st.current, owned: st.owned.includes(id) }); } catch (e) {} }
      let server = null; try { if (cfg.token) server = await api(cfg, '/bridge/status', {}, 4000); } catch (e) { server = { error: String(e.message || e) }; }
      reply({ enabled: cfg.enabled, bridgeUrl: cfg.bridgeUrl, hasToken: !!cfg.token, tabs, server });
    } else reply({ ok: false });
  })().catch(e => reply({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') loop(); });
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
chrome.alarms.create('codespace-bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => loop());
loop();
