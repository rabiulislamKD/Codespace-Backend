'use strict';
/* Test helper: load the REAL frontend code (src-js fragments) and server functions
 * into a vm sandbox so unit tests run the exact shipped logic — no copies, no mocks of
 * the code under test, only stubbed browser globals.
 *
 * Why: js/app.js is assembled by tools/build-web.cjs from src-js/*.js wrapped in ONE IIFE.
 * Here we concatenate the same fragments WITHOUT the wrapper, so top-level functions become
 * reachable, then return the requested ones.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

/* ---------- browser stubs ---------- */
function fakeElement() {
  const el = {
    style: {}, dataset: {}, hidden: false, title: '', textContent: '', innerHTML: '',
    value: '', className: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, insertAdjacentHTML() {}, remove() {}, focus() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    firstChild: null, parentNode: null
  };
  return el;
}
const BROWSER_STUBS = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, // window.addEventListener etc.
  document: {
    getElementById: () => fakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
    createTextNode: t => ({ textContent: t }),
    body: fakeElement(),
    documentElement: fakeElement(),
    addEventListener() {}, title: ''
  },
  window: {},
  navigator: { userAgent: 'node-test', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:8787/', protocol: 'http:', origin: 'http://127.0.0.1:8787' },
  localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() }; })(),
  sessionStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })(),
  history: { pushState() {}, replaceState() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask,
  AbortController, fetch: async () => { throw new Error('network disabled in tests'); },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  confirm: () => true, alert() {}, prompt: () => null,
  requestAnimationFrame: cb => setTimeout(cb, 0),
  getSelection: () => ({ toString: () => '', removeAllRanges() {} })
};
BROWSER_STUBS.window = BROWSER_STUBS; // self-reference like a real window

/* ---------- frontend loader ---------- */
/* loadFragments(['01-core-helpers-state.js', '05-markdown-diff.js'], ['esc', 'md']) */
function loadFragments(files, names) {
  const code = files.map(f => fs.readFileSync(path.join(ROOT, 'src-js', f), 'utf8')).join('\n;\n');
  const tail = '\n;return { ' + names.join(', ') + ' };';
  /* TextDecoder/DOMException: used by readSSE() in 10-model-adapters.js (SSE parsing + abort paths) */
  const ctx = vm.createContext(Object.assign({}, BROWSER_STUBS, { console, URL, URLSearchParams, TextDecoder, DOMException }));
  /* script text already self-invokes the IIFE — runInContext returns the exports object directly */
  return new vm.Script('(function(){\n' + code + tail + '\n})()', { filename: 'src-js[' + files.join('+') + ']' }).runInContext(ctx);
}

/* ---------- server function extraction ---------- */
/* Pull a single `function name(...) {...}` out of agent-server.js by brace counting,
 * then evaluate it in a sandbox that provides what it needs (e.g. path). */
function extractFunction(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found');
  const open = source.indexOf('{', i);
  let depth = 0, inStr = null;
  for (let p = open; p < source.length; p++) {
    const c = source[p], prev = source[p - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return source.slice(i, p + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
function loadServerFunctions(names, extraGlobals) {
  const src = fs.readFileSync(path.join(ROOT, 'agent-server.js'), 'utf8');
  const code = names.map(n => extractFunction(src, n)).join('\n') + '\n;return { ' + names.join(', ') + ' };';
  const ctx = vm.createContext(Object.assign({ path: require('path'), console }, extraGlobals || {}));
  return new vm.Script('(function(){\n' + code + '\n})()', { filename: 'agent-server[' + names.join('+') + ']' }).runInContext(ctx);
}

module.exports = { loadFragments, loadServerFunctions, extractFunction, fakeElement, ROOT };
