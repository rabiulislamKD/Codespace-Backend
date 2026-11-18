'use strict';
// Checks the provider gallery data and the page's direct-call-then-relay logic (real code taken from the page).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
/* 3.13.1: the app is split across the entry html + css/ + js/app.js — verify against all of it */
try { require(path.join(__dirname, 'tools/build-web.cjs')).ensure(); } catch {}
const html = ['my-chat-agent-v3.html', ...fs.readdirSync(path.join(__dirname, 'css')).sort().map(f => 'css/' + f), 'js/app.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marker missing: ' + a); return html.slice(i, j); };
let passed = 0; const ok = n => { passed++; console.log('PASS', n); };

const cardsSrc = between('const PROVIDER_CARDS = [', 'let pgFilter');
const cx = vm.createContext({ DEFAULT_CTX: 8192 });
vm.runInContext(cardsSrc + ';this.cards = PROVIDER_CARDS;', cx);
const cards = cx.cards;
assert.ok(cards.length >= 15); ok('gallery has ' + cards.length + ' providers');
assert.equal(new Set(cards.map(c => c.id)).size, cards.length); ok('card ids are unique');
assert.equal(new Set(cards.map(c => c.name)).size, cards.length); ok('card names are unique');
for (const c of cards) {
  assert.ok(['free', 'paid', 'local'].includes(c.tag), c.id); assert.ok(['openai', 'anthropic'].includes(c.format), c.id);
  assert.ok(['bearer', 'x-api-key', 'none'].includes(c.auth), c.id); assert.ok(c.blurb && c.blurb.length < 90, c.id + ' blurb');
  if (c.id === 'chat-zai') { assert.equal(c.tag, 'free'); assert.match(c.base, /^http:\/\/127\.0\.0\.1:9876\/v1$/, c.id); assert.equal(c.auth, 'none'); assert.equal(c.keyUrl, undefined); }
  else if (c.tag === 'local') { assert.match(c.base, /^http:\/\/localhost:\d+\/v1$/, c.id); assert.equal(c.auth, 'none'); assert.equal(c.keyUrl, undefined); }
  else { assert.match(c.base, /^https:\/\//, c.id + ' must use https'); assert.notEqual(c.auth, 'none', c.id); assert.match(c.keyUrl, /^https:\/\//, c.id + ' keyUrl'); }
  assert.doesNotMatch(c.base, /\/chat\/completions\/?$/, c.id + ' base must not include the chat path'); assert.doesNotMatch(c.base, /\/$/, c.id + ' no trailing slash');
}
ok('every card is well formed (https for hosted, no key for local, key page for hosted, no chat path in base)');
const byId = id => cards.find(c => c.id === id);
for (const id of ['gemini', 'openai', 'cline', 'openrouter', 'groq']) assert.ok(byId(id), id);
assert.equal(byId('gemini').google, true); assert.match(byId('gemini').keyUrl, /aistudio\.google\.com/); assert.equal(byId('gemini').tag, 'free'); ok('Gemini, OpenAI and Cline cards exist; Gemini has the Google sign-in path and is marked free');
assert.ok(cards.filter(c => c.tag === 'free').length >= 8); ok('at least 8 free-tier providers are listed');
assert.equal(byId('cline').verify, true); ok('the Cline address is flagged as untested in the UI');

// ---- relay logic
const relaySrc = between('const RELAY_HOSTS = new Set();', 'function buildHeaders(p) {');
function world({ bridge = true, direct = 'ok', relay = 'ok' } = {}) {
  const calls = []; const w = { URL, JSON, Set, Error, Promise, String, window: { CodeSpaceNative: null }, B: { ok: bridge }, L: { bridgeUrl: 'http://127.0.0.1:8787/', bridgeToken: 'tok' } };
  w.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/llm/proxy')) { if (relay === 'proxyerr') return { headers: { get: h => h === 'X-Codespace-Proxy-Error' ? '1' : null }, json: async () => ({ error: 'Could not reach x' }) }; return { ok: true, status: 200, via: 'relay', headers: { get: () => null } }; }
    if (direct === 'cors') throw new TypeError('Failed to fetch'); if (direct === 'abort') { const e = new Error('x'); e.name = 'AbortError'; throw e; }
    return { ok: true, status: 200, via: 'direct', headers: { get: () => null } };
  };
  const c = vm.createContext(w); vm.runInContext(relaySrc + ';this.provFetch = provFetch; this.hosts = RELAY_HOSTS;', c); return { c, calls };
}
(async () => {
  let w = world(); let r = await w.c.provFetch('https://api.example.com/v1/models', { method: 'GET', headers: {} });
  assert.equal(r.via, 'direct'); assert.equal(w.calls.length, 1); ok('relay: a working direct call is used as is');
  w = world({ direct: 'cors' }); r = await w.c.provFetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{"a":1}' });
  assert.equal(r.via, 'relay'); assert.equal(w.calls.length, 2); const rel = w.calls[1]; assert.equal(rel.url, 'http://127.0.0.1:8787/llm/proxy'); assert.equal(rel.init.headers.Authorization, 'Bearer tok');
  const sent = JSON.parse(rel.init.body); assert.equal(sent.url, 'https://api.groq.com/openai/v1/chat/completions'); assert.equal(sent.method, 'POST'); assert.equal(sent.headers.Authorization, 'Bearer k'); assert.equal(sent.body, '{"a":1}'); ok('relay: a blocked call is retried through the bridge with the same method, headers and body');
  r = await w.c.provFetch('https://api.groq.com/openai/v1/models', {}); assert.equal(w.calls.length, 3); assert.equal(r.via, 'relay'); ok('relay: the host is remembered, so later calls skip the failing direct attempt');
  w = world({ direct: 'cors', bridge: false }); await assert.rejects(() => w.c.provFetch('https://api.groq.com/x', {}), /Failed to fetch/); assert.equal(w.calls.length, 1); ok('relay: without the bridge the original error is shown');
  w = world({ direct: 'abort' }); await assert.rejects(() => w.c.provFetch('https://api.groq.com/x', {}), e => e.name === 'AbortError'); assert.equal(w.calls.length, 1); ok('relay: a user cancel is never retried');
  w = world({ direct: 'cors' }); await assert.rejects(() => w.c.provFetch('http://localhost:11434/v1/models', {}), /Failed to fetch/); assert.equal(w.calls.length, 1); ok('relay: local servers are never relayed');
  w = world({ direct: 'cors' }); await assert.rejects(() => w.c.provFetch('http://api.example.com/v1/models', {}), /Failed to fetch/); assert.equal(w.calls.length, 1); ok('relay: plain http to a hosted address is never relayed');
  w = world({ direct: 'cors', relay: 'proxyerr' }); await assert.rejects(() => w.c.provFetch('https://api.example.com/x', {}), /Could not reach x/); ok('relay: a relay failure shows the bridge\u2019s reason');
  assert.match(html, /relayFetch/); assert.match(html, /provFetch\(url, \{ method: 'POST', headers: buildHeaders\(p\)/); assert.match(html, /provFetch\(url, \{ headers: h, signal \}\)/); ok('chat requests and model listing both go through provFetch');
  assert.match(html, /DESKTOP_EMBED\) \{\s*pdDraft = cardFill\(c\)/); { const m = fs.readFileSync(path.join(__dirname, 'desktop/main.cjs'), 'utf8'); assert.doesNotMatch(m.slice(m.indexOf('function setupGuest('), m.indexOf('function setupGuestSession(')), /openExternal/); } ok('desktop: key pages open in the built-in Browser panel (website popups never use openExternal)');

  // ---- gallery UI behaviour against a tiny fake DOM (real code from the page)
  const galSrc = between('const PROVIDER_CARDS = [', 'function openProvEditor(p) {');
  class El { constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.hidden = false; this.value = ''; this.textContent = ''; this.className = ''; this.checked = false; }
    set innerHTML(v) { this.children = []; } get innerHTML() { return ''; }
    append(...n) { this.children.push(...n); } appendChild(n) { this.children.push(n); return n; } setAttribute(k, v) { this.attrs[k] = v; } focus() { this.focused = true; } addEventListener() {} showModal() {} close() { this.closed = true; } }
  const ids = {}; const $ = id => ids[id] || (ids[id] = new El(id));
  const filled = []; let navigated = null, notes = [], panel = 0;
  const gw = { $, DEFAULT_CTX: 8192, document: { createElement: t => new El(t) }, pdFill: p => filled.push(p), showPanel: () => panel++, navigateEmbedded: async u => { navigated = u; return true; }, addNote: n => notes.push(n), window: { open: (...a) => { gw.opened = a; } }, navigator: { clipboard: { writeText: async () => {} } }, DESKTOP_EMBED: false };
  const gx = vm.createContext(gw); vm.runInContext(galSrc + ';this.render = renderGallery; this.pick = pickCard; this.setFilter = f => { pgFilter = f; }; this.draft = () => pdDraft; this.guess = () => pdModelGuess;', gx);
  gx.render(); assert.equal($('pgGrid').children.length, cards.length); ok('gallery UI: renders one card per provider');
  gx.setFilter('free'); gx.render(); assert.equal($('pgGrid').children.length, cards.filter(c => c.tag === 'free').length); gx.setFilter('local'); gx.render(); assert.equal($('pgGrid').children.length, 3); gx.setFilter('all'); ok('gallery UI: Free / Local filters work');
  $('pgSearch').value = 'gem'; gx.render(); assert.equal($('pgGrid').children.length, 1); $('pgSearch').value = 'zzzz-none'; gx.render(); assert.equal($('pgGrid').children.length, 1); assert.match($('pgGrid').children[0].textContent, /Custom endpoint/); $('pgSearch').value = ''; ok('gallery UI: search narrows the list and an empty result points to Custom endpoint');
  gx.pick('gemini'); const f = filled[filled.length - 1]; assert.equal(f.base, 'https://generativelanguage.googleapis.com/v1beta/openai'); assert.equal(f.key, ''); assert.equal($('pdConnect').hidden, false); assert.match($('pcTitle').textContent, /Gemini/);
  assert.equal($('pcActions').children.length, 2); assert.match($('pcActions').children[0].textContent, /Google/); assert.equal($('pdKey').focused, true); assert.equal(gx.guess(), true); ok('gallery UI: picking Gemini fills the form, offers "Sign in with Google" + "Copy link", and focuses the key field');
  $('pcActions').children[0].onclick(); assert.equal(gw.opened[0], 'https://aistudio.google.com/apikey'); assert.match(gw.opened[2], /noopener/); ok('gallery UI (web): the key page opens in a new tab with noopener');
  gx.pick('ollama'); assert.equal($('pcActions').children.length, 0); assert.match($('pcTitle').textContent, /no key needed/); ok('gallery UI: local providers show no key buttons');
  gx.pick('cline'); assert.match($('pcTitle').title, /not tested/); ok('gallery UI: the untested Cline address is called out to the user');
  gw.DESKTOP_EMBED = true; gx.pick('gemini'); $('pcActions').children[0].onclick(); await new Promise(r => setTimeout(r, 5));
  assert.equal(navigated, 'https://aistudio.google.com/apikey'); assert.equal(panel, 1); assert.equal($('provDlg').closed, true); assert.equal(gx.draft().base, 'https://generativelanguage.googleapis.com/v1beta/openai'); assert.ok(notes.some(n => /Browser panel/.test(n))); ok('gallery UI (desktop): the key page opens in the Browser panel and the half-filled form is kept for next time');
  console.log('\nproviders: ' + passed + ' checks passed');
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
