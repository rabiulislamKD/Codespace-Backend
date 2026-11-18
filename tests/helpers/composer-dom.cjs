'use strict';
/* Test helper: a minimal bubbling DOM + native-bridge stub, used to load the REAL src-js
 * fragments (all of manifest.core) into a vm and drive the actual chat-engine selector by
 * dispatching real pointerdown/click events on the real menu items.
 *
 * Why: unit-testing selectOpenCodeLocal() in isolation was insufficient (v41). This harness
 * exercises the exact event path the Android WebView uses: routeBtn click -> menu open ->
 * pointerdown+click on [data-route="opencode"] -> setRoute -> toggleOpenCode -> selection.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); this._sync(); }
  remove(...c) { c.forEach(x => this.set.delete(x)); this._sync(); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : !!force; if (on) this.set.add(c); else this.set.delete(c); this._sync(); return on; }
  contains(c) { return this.set.has(c); }
  _sync() { this.el._className = [...this.set].join(' '); }
}

class El {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.id = attrs.id || '';
    this.attrs = { ...attrs }; delete this.attrs.id;
    this.children = []; this.parentNode = null; this._listeners = {};
    this.onclick = null; this.oninput = null; this.onchange = null;
    this.dataset = {}; this.hidden = false; this.disabled = false;
    this.style = { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} };
    this.title = ''; this.value = ''; this._text = ''; this._className = '';
    this.classList = new ClassList(this);
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._text; }
  set innerHTML(v) { this._text = String(v); if (v === '') this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...ns) { ns.forEach(n => { if (n && typeof n === 'object') { n.parentNode = this; this.children.push(n); } }); }
  prepend(...ns) { ns.forEach(n => { if (n && typeof n === 'object') { n.parentNode = this; this.children.unshift(n); } }); }
  insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  replaceChildren() { this.children = []; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'class') { this._className = String(v); this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) {
    if (k === 'id') return this.id;
    if (k === 'class') return this.className;
    if (k in this.attrs) return this.attrs[k];
    if (k.startsWith('data-')) { const d = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()); return d in this.dataset ? this.dataset[d] : null; }
    return null;
  }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter(f => f !== fn); }
  querySelector(sel) { const r = this._all(sel)[0]; return r || getEl('__sink_' + String(sel).replace(/[^a-z0-9_.-]/gi, '')); }
  querySelectorAll(sel) { return this._all(sel); }
  _all(sel) { const out = []; const walk = n => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; }
  closest(sel) { let p = this; while (p) { if (matches(p, sel)) return p; p = p.parentNode; } return null; }
  focus() {} click() { dispatch(this, 'click', { bubbles: true }); }
  getBoundingClientRect() { return { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }; }
  insertAdjacentHTML() {}
  insertAdjacentElement(pos, el) { if (el && typeof el === 'object') { el.parentNode = this; this.children.push(el); } return el; }
  insertAdjacentText() {}
  getContext() { return null; }
  setSelectionRange() {} select() {} scrollIntoView() {} scrollTo() {}
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  cloneNode() { return new El(this.tagName); }
}

function matchesSimple(el, sel) {
  sel = String(sel).trim(); if (!sel) return false;
  let rest = sel;
  const tag = rest.match(/^([a-zA-Z0-9]+)/);
  if (tag) { if (el.tagName !== tag[1].toUpperCase()) return false; rest = rest.slice(tag[1].length); }
  while (rest.length) {
    if (rest.startsWith('#')) { const m = rest.match(/^#([\w-]+)/); if (!m || el.id !== m[1]) return false; rest = rest.slice(m[0].length); }
    else if (rest.startsWith('.')) { const m = rest.match(/^\.([\w-]+)/); if (!m || !el.classList.contains(m[1])) return false; rest = rest.slice(m[0].length); }
    else if (rest.startsWith('[')) { const end = rest.indexOf(']'); if (end < 0) return false; const inner = rest.slice(1, end).split('='); const name = inner[0]; if (inner.length === 1) { if (el.getAttribute(name) == null) return false; } else if (el.getAttribute(name) !== inner[1].replace(/^["']|["']$/g, '')) return false; rest = rest.slice(end + 1); }
    else if (rest.startsWith(':')) { const m = rest.match(/^:[\w-]+(\([^)]*\))?/); if (!m) return false; rest = rest.slice(m[0].length); }
    else break;
  }
  return true;
}
function matches(el, sel) {
  sel = String(sel).trim();
  if (sel.includes(' ') || sel.includes('>')) {
    const parts = sel.split(/\s*>\s*|\s+/).filter(Boolean);
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) { let found = false; while (n) { if (matchesSimple(n, parts[i])) { found = true; n = n.parentNode; break; } n = n.parentNode; } if (!found) return false; }
    return true;
  }
  return matchesSimple(el, sel);
}

const registry = new Map();
function reg(el) { if (el.id) registry.set(el.id, el); return el; }
function getEl(id) { if (!registry.has(id)) reg(new El('div', { id })); return registry.get(id); }

/* Build the composer DOM subset (mirrors my-chat-agent-v3.html) and load the real fragments. */
function buildComposer(opts = {}) {
  registry.clear();
  const documentListeners = {};
  const document = {
    getElementById: getEl,
    createElement: t => new El(t),
    createTextNode: t => ({ textContent: t }),
    addEventListener: (t, fn) => { (documentListeners[t] = documentListeners[t] || []).push(fn); },
    removeEventListener() {},
    querySelector: sel => getEl('__dsink_' + String(sel).replace(/[^a-z0-9_.-]/gi, '')),
    querySelectorAll: () => [],
    body: new El('body'), documentElement: new El('html'), hidden: false, title: ''
  };
  function dispatch(target, type, extra = {}) {
    const ev = Object.assign({ type, target, preventDefault() {}, stopPropagation() { this._stopped = true; }, defaultPrevented: false }, extra);
    const chain = []; let n = target; while (n) { chain.push(n); n = n.parentNode; }
    for (const node of chain) {
      const ls = node._listeners[type] || [];
      for (const fn of ls) { fn.call(node, ev); if (ev._stopped) return ev; }
      const prop = node['on' + type];
      if (typeof prop === 'function') { prop.call(node, ev); if (ev._stopped) return ev; }
    }
    for (const fn of (documentListeners[type] || [])) fn.call(document, ev);
    return ev;
  }

  /* composer DOM */
  const mainCol = reg(new El('div', { id: 'mainCol' }));
  mainCol.appendChild(reg(new El('div', { id: 'chat' })));
  const routeWrap = reg(new El('div', { id: 'routeWrap' }));
  const routeBtn = reg(new El('button', { id: 'routeBtn' }));
  const rtTxt = new El('span'); rtTxt.classList.add('rt-txt'); rtTxt.textContent = 'CodeSpace';
  routeBtn.appendChild(rtTxt);
  routeWrap.appendChild(routeBtn);
  const routeMenu = reg(new El('div', { id: 'routeMenu' }));
  routeMenu.hidden = true;
  const items = {};
  for (const r of ['codespace', 'opencode', 'zai']) {
    const b = new El('button'); b.setAttribute('data-route', r); b.setAttribute('aria-checked', r === 'codespace' ? 'true' : 'false');
    const copy = new El('span'); copy.classList.add('perm-option-copy');
    const small = new El('small'); small.textContent = 'x';
    copy.appendChild(small); b.appendChild(copy);
    routeMenu.appendChild(b); items[r] = b;
  }
  routeWrap.appendChild(routeMenu);

  /* configurable native status */
  const harness = { statusMode: opts.statusMode || 'OK', statusCalls: 0, nativeCalls: [], nativePayloads: [], remoteCalls: [], statusQueue: Array.isArray(opts.statusQueue) ? opts.statusQueue.slice() : null };
  function nativeStatus() {
    harness.statusCalls++;
    if (harness.statusQueue && harness.statusQueue.length) return harness.statusQueue.shift();
    if (harness.statusMode === 'COMMAND_ERROR') return { termuxState: 'COMMAND_ERROR', installed: false, runtimeKind: 'TERMUX', version: null, message: 'OpenCode CLI failed inside Termux' };
    if (harness.statusMode === 'FLAKY' && harness.statusCalls > 1) return { termuxState: 'EXTERNAL_COMMANDS_DISABLED_OR_NO_RESPONSE', installed: false, runtimeKind: 'TERMUX', version: null, message: 'Termux did not return a result' };
    return { termuxState: 'OK', installed: true, runtimeKind: 'TERMUX', version: '2.3.0', message: 'OpenCode CLI 2.3.0 is available via Termux.' };
  }
  const nativeWorkspaceState = opts.nativeWorkspaceState !== undefined
    ? opts.nativeWorkspaceState
    : { ok: true, available: true, platform: 'android', kind: 'saf', root: 'saf://x', posixPath: '/data/data/com.termux/files/home/.codespace/ws' };
  const nativeInfo = opts.nativeInfo !== undefined
    ? opts.nativeInfo
    : { platform: 'android', root: 'saf://x', fileProvider: 'android-native-bridge' };

  const ls = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() }; })();
  if (opts.seedState) { ls.setItem('agent3.state', JSON.stringify(opts.seedState)); }
  if (opts.seedLocal) { ls.setItem('agent3.local', JSON.stringify(opts.seedLocal)); }

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask,
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Set, Map, isNaN, parseInt, parseFloat,
    document, window: null, navigator: { userAgent: 'node' }, location: { href: 'http://x/' }, localStorage: ls,
    confirm: () => true, alert() {}, prompt: () => null,
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    requestAnimationFrame: cb => setTimeout(cb, 0), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    AbortController, URL, URLSearchParams, TextDecoder, DOMException,
    performance: { now: () => Date.now() },
    innerWidth: 400, innerHeight: 800, outerWidth: 400, outerHeight: 800, devicePixelRatio: 2,
    screen: { width: 400, height: 800 }, scrollY: 0, scrollX: 0,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    indexedDB: { open() { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } }
  };
  ctx.fetch = opts.fetchImpl || (async () => { throw new Error('network disabled in tests'); });
  ctx.window = ctx; ctx.globalThis = ctx;
  const bridgeUrl = opts.bridgeUrl || 'codespace-native://local';
  const nativeApi = {
    localApiCall: () => JSON.stringify({ status: 200, data: {} }),
    localApiCallAsync: (pathname, payload, id) => {
      harness.nativeCalls.push(pathname);
      harness.nativePayloads.push({ pathname, payload: (() => { try { return JSON.parse(payload); } catch { return payload; } })() });
      setTimeout(() => {
        let data = {};
        if (pathname === '/opencode/status') data = nativeStatus();
        else if (pathname === '/opencode/models') data = opts.modelsReply || { models: ['opencode/big-pickle'], configured: 'opencode/big-pickle', default: 'opencode/big-pickle' };
        else if (pathname === '/workspace/state') data = nativeWorkspaceState;
        else if (pathname === '/info') data = nativeInfo;
        else if (pathname === '/term/list') data = { terminals: [] };
        else if (pathname === '/opencode/run') data = opts.runReply || { ok: true, sessionId: 'ses_test', exited: true, code: 0 };
        else if (pathname === '/opencode/run/read') {
          if (Array.isArray(opts.runReadQueue) && opts.runReadQueue.length) data = opts.runReadQueue.shift();
          else data = opts.runReadReply || { data: '', next: 0, exited: true, code: 0 };
        }
        else if (pathname === '/opencode/run/cancel') data = { ok: true };
        else if (pathname === '/opencode/run/probe') data = opts.probeReply || { ok: true, alive: true, procState: 'S', wchan: 'do_wait', children: '', outSize: 0, errSize: 0, sinceOutputMs: 25000, elapsedMs: 26000 };
        else if (pathname === '/opencode/workspace/sync-out') data = opts.syncOutReply || { ok: true, written: 0, conflicts: [] };
        try { ctx.window.__csNativeCb(id, JSON.stringify({ status: 200, data })); } catch (e) {}
      }, 3);
    },
    hasLocalWorkspace: () => !!opts.nativeHasLocalWorkspace,
    setPermissionMode() {},
    sandboxMode: () => 'Local',
    bridgeConfig: () => JSON.stringify({ bridgeUrl, bridgeToken: opts.bridgeToken || 't' })
  };
  if (!opts.noNative) ctx.window.CodeSpaceNative = nativeApi;

  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-js', 'manifest.json'), 'utf8'));
  const core = man.core.map(f => fs.readFileSync(path.join(ROOT, 'src-js', f), 'utf8')).join('\n;\n');
  const tail = '\n;return { S, B, L, setRoute, toggleOpenCode, selectOpenCodeLocal, currentRoute, syncOpenCodeUI, refreshOpenCodeStatus, opencodeRuntimeAvailable, runOpenCodeChat, runOpenCodeAndroidLocal, runOpenCodeAndroidLocalOnce, bcall, refreshWorkspaceInfo, isAndroidFolderWorkspace, ocLocalCall, activeOpenCodeModel: () => (typeof currentOpenCodeModel === "function" ? currentOpenCodeModel() : null), syncModelBtn, activeWorkspaceStateRef: () => activeWorkspaceState, addNote, addErr, lastOpenCodeStatusRef: () => lastOpenCodeStatus, setStatus: (s) => { lastOpenCodeStatus = s; }, fillOpenCodeQuick, looksLikeQuotaFailure, isAccountWideQuotaFailure, formatProviderError, normalizeProviderError, isFreeOpenCodeModel, humanDuration, modelPickerItems, setCtrl: (c) => { ctrl = c; }, ctrlRef: () => ctrl };';
  const sandbox = vm.createContext(ctx);
  const api = new vm.Script('(function(){' + core + tail + '\n})()', { filename: 'composer-dom' }).runInContext(sandbox);

  return {
    api, ctx, els: { routeWrap, routeBtn, rtTxt, routeMenu, items }, document, localStorage: ls,
    harness,
    dispatch,
    // The composer's model button renders into a <span class="mb-txt">; the stub DOM records that
    // write on a sink element, so read it back here (module scope has getEl; the VM does not).
    modelLabel() { return getEl('__sink_' + '.mb-txt'.replace(/[^a-z0-9_.-]/gi, '')).textContent; },
    openMenu() { dispatch(routeBtn, 'pointerdown', { bubbles: true }); dispatch(routeBtn, 'click', { bubbles: true }); },
    tap(route) { const el = items[route]; dispatch(el, 'pointerdown', { bubbles: true }); dispatch(el, 'click', { bubbles: true }); },
    tapOpenCode() { this.tap('opencode'); },
    state() {
      return { openCodeCLI: api.S.openCodeCLI, chatZaiCLI: api.S.chatZaiCLI, route: api.currentRoute(), label: rtTxt.textContent, btnRoute: routeBtn.dataset.route, ariaOpenCode: items.opencode.getAttribute('aria-checked') };
    },
    persisted() { try { return JSON.parse(ls.getItem('agent3.state') || '{}'); } catch { return {}; } }
  };
}

module.exports = { buildComposer, El, getEl };
