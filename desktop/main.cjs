'use strict';
const { app, BrowserWindow, WebContentsView, dialog, Menu, clipboard, session, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');

app.setName('CodeSpace');
app.setAppUserModelId('com.codespace.desktop');

// VS Code-style integrated browser: a main-process-owned Chromium WebContentsView.
// Its persistent session stores cookies/logins independently from the CodeSpace app UI.
const GUEST_PARTITION = 'persist:codespace-browser';
const CH_BROWSER_EVENT = 'codespace:browser-event';
let browserView = null;
// Small, narrow startup window shown immediately; the full app window opens only once the workspace is ready.
const APP_ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'codespace.ico' : 'codespace.png');
const SPLASH_MIN_MS = 1800;
let splashWindow = null, splashShownAt = 0;
function showSplash() {
  try {
    splashWindow = new BrowserWindow({
      width: 320, height: 330, frame: false, transparent: true, resizable: false, movable: true, maximizable: false, minimizable: false,
      fullscreenable: false, center: true, show: false, alwaysOnTop: true, skipTaskbar: false, hasShadow: true, title: 'CodeSpace', icon: APP_ICON,
      backgroundColor: '#00000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    splashWindow.setMenu(null);
    splashWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    splashWindow.webContents.on('will-navigate', e => e.preventDefault());
    splashWindow.once('ready-to-show', () => { if (splashWindow && !splashWindow.isDestroyed()) { splashShownAt = Date.now(); splashWindow.show(); } });
    splashWindow.on('closed', () => { splashWindow = null; });
    splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => closeSplash());
  } catch { splashWindow = null; }
}
function closeSplash() { try { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy(); } catch {} splashWindow = null; }
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
let browserVisible = false;
let browserVisSeq = 0; // bumped on every setVisible request so an in-flight snapshot-hide can tell it was superseded
let browserAppliedVisible = false; // what browserSetBounds last passed to setVisible (View has no visible getter)

const CH_ATTACH = 'codespace:attach-from-browser';
const CH_FOCUS_ADDR = 'codespace:focus-address';
const CH_NET = 'codespace:net';

const PORT = 8787; // stable origin keeps chat history in the same local browser profile
const TOKEN = crypto.randomBytes(32).toString('hex');
let serverChild = null;
let mainWindow = null;
let shuttingDown = false;
let serverLogs = '';

// electron-builder's portable target sets PORTABLE_EXECUTABLE_DIR to the folder
// containing the single portable .exe. Keep app data beside it so the USB copy travels.
const portableDir = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : '';
const defaultUserData = app.getPath('userData');
const dataRoot = path.join(portableDir || defaultUserData, 'CodeSpaceData');
const browserProfile = path.join(dataRoot, 'BrowserProfile');
const serverData = path.join(dataRoot, 'Server');
try {
  fs.mkdirSync(browserProfile, { recursive: true });
  fs.mkdirSync(serverData, { recursive: true });
  app.setPath('userData', browserProfile);
  app.setPath('sessionData', browserProfile);
} catch (e) {
  dialog.showErrorBox('CodeSpace', 'Cannot create the portable data folder:\n' + dataRoot + '\n\n' + e.message);
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

function canBind(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function appendLog(chunk) {
  serverLogs = (serverLogs + String(chunk)).slice(-12000);
}

function startBackend() {
  const appRoot = app.getAppPath();
  const serverPath = path.join(appRoot, 'agent-server.js');
  const nodePath = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime', 'node.exe')
    : path.join(__dirname, '..', 'runtime', 'node.exe');
  if (!fs.existsSync(serverPath)) throw new Error('Backend not found: ' + serverPath);
  if (!fs.existsSync(nodePath)) throw new Error('Bundled Node runtime not found: ' + nodePath + '\nRun the portable build script first.');
  serverChild = spawn(nodePath, [serverPath, '--port', String(PORT), '--token', TOKEN], {
    cwd: appRoot,
    env: {
      ...process.env,
      MY_AGENT_DATA_DIR: serverData,
      MY_AGENT_DISABLE_EXTERNAL_BROWSER: '1',
      CODESPACE_APP_ROOT: appRoot,
      CODESPACE_LAUNCHER_PATH: process.execPath,
      CODESPACE_PORTABLE_DIR: portableDir,
      CODESPACE_RESOURCES_PATH: process.resourcesPath || '',
      CODESPACE_PACKAGED: app.isPackaged ? '1' : '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverChild.stdout.on('data', appendLog);
  serverChild.stderr.on('data', appendLog);
  serverChild.on('error', e => appendLog('\nSpawn error: ' + e.message));
  serverChild.on('exit', (code, signal) => {
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('CodeSpace backend stopped', 'The local backend exited (' + code + ', ' + signal + ').\n\n' + serverLogs.slice(-5000));
      app.quit();
    }
  });
}

async function waitForBackend() {
  const url = `http://127.0.0.1:${PORT}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (serverChild && serverChild.exitCode !== null) {
      throw new Error('The local backend exited before it was ready.\n\n' + serverLogs.slice(-5000));
    }
    try {
      const r = await fetch(url + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: '{}',
        signal: AbortSignal.timeout(800)
      });
      if (r.ok) return url;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  const occupied = !(await canBind(PORT));
  throw new Error(
    (occupied ? 'Port ' + PORT + ' is already in use. Close any separately running agent-server.js first.\n\n' : 'The local backend did not become ready.\n\n') + serverLogs.slice(-5000)
  );
}


function sendToHost(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const isHttp = u => /^https?:\/\//i.test(String(u || ''));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

function navHistory(g) {
  const h = g.navigationHistory;
  return h && typeof h.canGoBack === 'function' ? h : {
    canGoBack: () => g.canGoBack(), canGoForward: () => g.canGoForward(),
    goBack: () => g.goBack(), goForward: () => g.goForward()
  };
}

// Runs inside the website. Self-contained: it is serialized with toString().
function pageCaptureFn(x, y) {
  const MAX_TEXT = 3000, MAX_HTML = 8000;
  let el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, reason: 'No element at that position.' };
  for (let i = 0; i < 6 && el.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const uniqueId = n => !!n.id && document.querySelectorAll('#' + esc(n.id)).length === 1;
  const selectorOf = node => {
    const parts = [];
    for (let n = node, depth = 0; n && n.nodeType === 1 && depth < 30; n = n.parentElement, depth++) {
      if (uniqueId(n)) { parts.unshift('#' + esc(n.id)); break; }
      let q = n.tagName.toLowerCase();
      if (n === document.documentElement || n === document.body) { parts.unshift(q); if (n === document.documentElement) break; continue; }
      const p = n.parentElement;
      if (p) { const same = Array.prototype.filter.call(p.children, c => c.tagName === n.tagName); if (same.length > 1) q += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(q);
    }
    return parts.join(' > ');
  };
  const label = n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList && n.classList.length ? '.' + Array.prototype.slice.call(n.classList, 0, 2).join('.') : '');
  const attrs = {};
  Array.prototype.slice.call(el.attributes || [], 0, 24).forEach(a => {
    if (a.name === 'style' || /^on/i.test(a.name)) return;
    if (a.name === 'value' && /^(password|hidden)$/i.test(el.getAttribute('type') || '')) return;
    attrs[a.name] = String(a.value).slice(0, 300);
  });
  const clone = el.cloneNode(true);
  const strip = c => {
    if (!c.querySelectorAll) return;
    c.querySelectorAll('script,style,noscript,template').forEach(n => n.remove());
    c.querySelectorAll('input[type=password],input[type=hidden]').forEach(n => n.removeAttribute('value'));
  };
  strip(clone);
  if (clone.matches && clone.matches('input[type=password],input[type=hidden]')) clone.removeAttribute('value');
  const cs = getComputedStyle(el), styles = {};
  ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'width', 'height', 'margin', 'padding', 'border', 'border-radius', 'z-index', 'overflow', 'opacity'].forEach(k => { styles[k] = cs.getPropertyValue(k); });
  const anc = []; for (let n = el.parentElement; n && anc.length < 6; n = n.parentElement) anc.push(label(n));
  const r = el.getBoundingClientRect();
  const link = el.closest ? el.closest('a[href]') : null;
  const typed = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(password|hidden)$/i.test(el.getAttribute('type') || '');
  return {
    ok: true, tag: el.tagName.toLowerCase(), label: label(el), selector: selectorOf(el),
    text: String(el.innerText || el.textContent || '').trim().slice(0, MAX_TEXT),
    value: typed ? String(el.value || '').slice(0, 500) : '',
    html: String(clone.outerHTML || '').slice(0, MAX_HTML), htmlTruncated: String(clone.outerHTML || '').length > MAX_HTML,
    attrs, styles, ancestors: anc, href: link ? link.href : '',
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    viewport: { w: innerWidth, h: innerHeight }, scroll: { x: scrollX, y: scrollY },
    page: { url: location.href, title: document.title || '' }
  };
}

function clampCapture(d, image) {
  const o = obj => { const out = {}; Object.keys(obj || {}).slice(0, 40).forEach(k => { out[clip(k, 60)] = clip(obj[k], 300); }); return out; };
  return {
    kind: 'element', tag: clip(d.tag, 40), label: clip(d.label, 200), selector: clip(d.selector, 1200),
    text: clip(d.text, 3000), value: clip(d.value, 500), html: clip(d.html, 8000), htmlTruncated: !!d.htmlTruncated,
    attrs: o(d.attrs), styles: o(d.styles), ancestors: (Array.isArray(d.ancestors) ? d.ancestors : []).slice(0, 6).map(a => clip(a, 160)),
    href: clip(d.href, 1000),
    rect: { x: Math.round(+d.rect.x || 0), y: Math.round(+d.rect.y || 0), width: Math.round(+d.rect.width || 0), height: Math.round(+d.rect.height || 0) },
    page: { url: clip(d.page && d.page.url, 2000), title: clip(d.page && d.page.title, 300) },
    image: typeof image === 'string' && image.startsWith('data:image/') ? image : ''
  };
}

async function attachElementFromGuest(guest, x, y) {
  let data;
  try { data = await guest.executeJavaScript('(' + pageCaptureFn.toString() + ')(' + Math.round(x) + ',' + Math.round(y) + ')', true); }
  catch (e) { sendToHost(CH_ATTACH, { kind: 'error', message: 'Could not read that element: ' + clip(e && e.message, 200) }); return; }
  if (!data || !data.ok) { sendToHost(CH_ATTACH, { kind: 'error', message: (data && data.reason) || 'Could not read that element.' }); return; }
  let image = '';
  try {
    const r = data.rect, vw = data.viewport.w, vh = data.viewport.h;
    const cx = Math.max(0, Math.round(r.x)), cy = Math.max(0, Math.round(r.y));
    const cw = Math.min(Math.round(r.width), vw - cx), ch = Math.min(Math.round(r.height), vh - cy);
    if (cw >= 4 && ch >= 4) {
      let img = await guest.capturePage({ x: cx, y: cy, width: cw, height: ch });
      if (img.getSize().width > 900) img = img.resize({ width: 900 });
      image = 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64');
    }
  } catch {}
  sendToHost(CH_ATTACH, clampCapture(data, image));
  // brief highlight so the user can see which element was attached
  guest.executeJavaScript('(()=>{try{const el=document.querySelector(' + JSON.stringify(data.selector) + ');if(!el)return;const o=el.style.getPropertyValue("outline"),p=el.style.getPropertyPriority("outline");el.style.setProperty("outline","2px solid #4f8cff","important");setTimeout(()=>{o?el.style.setProperty("outline",o,p):el.style.removeProperty("outline")},800)}catch(e){}})()').catch(() => {});
}

function attachSelectionFromGuest(guest, text) {
  sendToHost(CH_ATTACH, { kind: 'selection', text: clip(text, 8000), page: { url: clip(guest.getURL(), 2000), title: clip(guest.getTitle(), 300) } });
}

function showGuestContextMenu(guest, p) {
  const nav = navHistory(guest), t = [];
  t.push({ label: 'Attach element to chat', click: () => { attachElementFromGuest(guest, p.x, p.y); } });
  if (String(p.selectionText || '').trim()) t.push({ label: 'Attach selected text to chat', click: () => attachSelectionFromGuest(guest, p.selectionText) });
  t.push({ type: 'separator' });
  if (p.isEditable) {
    t.push({ label: 'Cut', enabled: !!p.editFlags.canCut, click: () => guest.cut() });
    t.push({ label: 'Copy', enabled: !!p.editFlags.canCopy, click: () => guest.copy() });
    t.push({ label: 'Paste', enabled: !!p.editFlags.canPaste, click: () => guest.paste() });
    t.push({ label: 'Select all', click: () => guest.selectAll() });
    t.push({ type: 'separator' });
  } else if (String(p.selectionText || '').trim()) {
    t.push({ label: 'Copy', click: () => guest.copy() });
    t.push({ type: 'separator' });
  }
  if (isHttp(p.linkURL)) {
    t.push({ label: 'Open link in this tab', click: () => guest.loadURL(p.linkURL) });
    t.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    t.push({ type: 'separator' });
  }
  if (p.mediaType === 'image' && isHttp(p.srcURL)) {
    t.push({ label: 'Copy image', click: () => guest.copyImageAt(p.x, p.y) });
    t.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
    t.push({ label: 'Save image as…', click: () => guest.downloadURL(p.srcURL) });
    t.push({ type: 'separator' });
  }
  t.push({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() });
  t.push({ label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() });
  t.push({ label: 'Reload', click: () => guest.reload() });
  t.push({ type: 'separator' });
  t.push({ label: 'Inspect', click: () => { guest.openDevTools({ mode: 'detach' }); guest.inspectElement(p.x, p.y); } });
  Menu.buildFromTemplate(t).popup({ window: mainWindow || undefined });
}


// 3.13.7: right-click works everywhere in the app UI (chat box, editor, terminal, address bar,
// settings...). Electron shows no context menu by itself, so build the standard one here.
// Areas that already have their own menu (file explorer rows) call preventDefault() in the page,
// so Chromium never emits this event for them and their custom menu is unchanged.
function showHostContextMenu(wc, p) {
  const t = [];
  const sel = String(p.selectionText || '').trim();
  if (p.isEditable) {
    t.push({ label: 'Undo', enabled: !!p.editFlags.canUndo, click: () => wc.undo() });
    t.push({ label: 'Redo', enabled: !!p.editFlags.canRedo, click: () => wc.redo() });
    t.push({ type: 'separator' });
    t.push({ label: 'Cut', enabled: !!p.editFlags.canCut, click: () => wc.cut() });
    t.push({ label: 'Copy', enabled: !!p.editFlags.canCopy, click: () => wc.copy() });
    t.push({ label: 'Paste', enabled: !!p.editFlags.canPaste, click: () => wc.paste() });
    t.push({ label: 'Select all', enabled: !!p.editFlags.canSelectAll, click: () => wc.selectAll() });
  } else {
    if (sel) t.push({ label: 'Copy', click: () => wc.copy() });
    if (isHttp(p.linkURL)) t.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    t.push({ label: 'Select all', click: () => wc.selectAll() });
  }
  if (isHttp(p.linkURL)) {
    t.push({ type: 'separator' });
    t.push({ label: 'Open link in your default browser', click: () => { shell.openExternal(p.linkURL).catch(() => {}); } });
  }
  if (p.misspelledWord && Array.isArray(p.dictionarySuggestions) && p.dictionarySuggestions.length) {
    t.unshift({ type: 'separator' });
    p.dictionarySuggestions.slice(0, 5).reverse().forEach(w => t.unshift({ label: w, click: () => wc.replaceMisspelling(w) }));
  }
  t.push({ type: 'separator' });
  t.push({ label: 'Reload app', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() });
  t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(t).popup({ window: mainWindow || undefined });
}

// Native integrated browser. The renderer only receives a narrow IPC proxy; the main
// process owns the WebContentsView, its persistent session, navigation and permissions.
function browserSend(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH_BROWSER_EVENT, { type, ...payload });
}
function browserSetBounds(bounds) {
  if (!browserView || !mainWindow || mainWindow.isDestroyed()) return;
  const b = bounds && typeof bounds === 'object' ? bounds : {};
  const x = Math.max(0, Math.round(Number(b.x) || 0));
  const y = Math.max(0, Math.round(Number(b.y) || 0));
  const width = Math.max(0, Math.min(10000, Math.round(Number(b.width) || 0)));
  const height = Math.max(0, Math.min(10000, Math.round(Number(b.height) || 0)));
  browserBounds = { x, y, width, height };
  browserView.setBounds(browserBounds);
  browserAppliedVisible = browserVisible && width > 0 && height > 0;
  browserView.setVisible(browserAppliedVisible);
}
function browserState() {
  const wc = browserView && browserView.webContents;
  if (!wc || wc.isDestroyed()) return { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
  const h = navHistory(wc);
  return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: h.canGoBack(), canGoForward: h.canGoForward() };
}
function setupBrowserView() {
  if (browserView || !mainWindow) return;
  const ses = session.fromPartition(GUEST_PARTITION);
  browserView = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'user-gesture-required' }
  });
  mainWindow.contentView.addChildView(browserView);
  browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  browserView.setVisible(false);
  const wc = browserView.webContents;
  setupGuest(wc);
  wc.on('did-finish-load', () => browserSend('dom-ready', { state: browserState() }));
  wc.on('did-navigate', (_e, url) => browserSend('did-navigate', { url, state: browserState() }));
  wc.on('did-navigate-in-page', (_e, url) => browserSend('did-navigate-in-page', { url, state: browserState() }));
  wc.on('page-title-updated', (_e, title) => browserSend('page-title-updated', { title, state: browserState() }));
  wc.on('did-start-loading', () => browserSend('did-start-loading', { state: browserState() }));
  wc.on('did-stop-loading', () => browserSend('did-stop-loading', { state: browserState() }));
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) browserSend('did-fail-load', { errorCode, errorDescription, url: validatedURL, state: browserState() });
  });
  wc.on('console-message', (_e, level, message, line, sourceId) => browserSend('console-message', { level, message, line, sourceId }));
  wc.on('render-process-gone', () => browserSend('render-process-gone', { state: browserState() }));
  wc.setWindowOpenHandler(details => {
    const target = String(details.url || '');
    if (target === 'about:blank' || isHttp(target)) return {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, parent: mainWindow || undefined,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: GUEST_PARTITION } }
    };
    return { action: 'deny' };
  });
  wc.on('did-create-window', win => {
    try {
      const popup = win.webContents;
      setupGuest(popup);
      popup.on('did-navigate', (_e, url) => browserSend('popup-navigate', { url }));
    } catch {}
  });
  browserSend('dom-ready', { state: browserState() });
}
function setupGuest(guest) {
  // Popups remain in CodeSpace. Do not intercept or redirect Google OAuth: WebContentsView
  // is a full Chromium browsing context rather than the old iframe/webview-based Simple Browser.
  guest.setWindowOpenHandler(details => {
    const target = String(details.url || '');
    if (target === 'about:blank' || isHttp(target)) return {
      action: 'allow', overrideBrowserWindowOptions: {
        width: 520, height: 720, autoHideMenuBar: true, parent: mainWindow || undefined,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: GUEST_PARTITION }
      }
    };
    return { action: 'deny' };
  });
  guest.on('will-navigate', (event, targetUrl) => {
    if (!(targetUrl === 'about:blank' || isHttp(targetUrl))) event.preventDefault();
  });
  guest.on('will-redirect', (event, details) => {
    if (details && details.isMainFrame && !(details.url === 'about:blank' || isHttp(details.url))) event.preventDefault();
  });
  guest.on('context-menu', (_e, p) => { try { showGuestContextMenu(guest, p); } catch {} });
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase(), ctrl = input.control || input.meta;
    if (ctrl && !input.shift && !input.alt && key === 'l') { event.preventDefault(); sendToHost(CH_FOCUS_ADDR, true); }
    else if (key === 'f5' || (ctrl && !input.alt && key === 'r')) { event.preventDefault(); (input.shift ? guest.reloadIgnoringCache() : guest.reload()); }
    else if (input.alt && !ctrl && key === 'arrowleft') { const h = navHistory(guest); if (h.canGoBack()) { event.preventDefault(); h.goBack(); } }
    else if (input.alt && !ctrl && key === 'arrowright') { const h = navHistory(guest); if (h.canGoForward()) { event.preventDefault(); h.goForward(); } }
    else if (key === 'f12' || (ctrl && input.shift && key === 'i')) { event.preventDefault(); guest.openDevTools({ mode: 'detach' }); }
  });
}

// Permission prompts for the embedded browser, similar to a normal browser. Everything
// outside the small allow-list is asked once per origin and remembered for this run.
function setupGuestSession() {
  const ses = session.fromPartition(GUEST_PARTITION);
  // Network capture for the Browser panel's Network button and the agent's browser_network tool. Only the
  // method, address, resource type, status and timing are reported - never headers, cookies or bodies.
  // Events are batched so a busy page does not flood the UI.
  const netQueue = [];
  let netTimer = null;
  const netPush = ev => {
    netQueue.push(ev); if (netQueue.length > 2000) netQueue.splice(0, netQueue.length - 2000);
    if (!netTimer) netTimer = setTimeout(() => { netTimer = null; const batch = netQueue.splice(0); if (batch.length) sendToHost(CH_NET, batch); }, 150);
  };
  const NET_FILTER = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
  ses.webRequest.onBeforeRequest(NET_FILTER, (d, callback) => {
    try { netPush({ k: 's', id: d.id, m: d.method, u: String(d.url).slice(0, 1000), ty: d.resourceType, t: Date.now() }); } catch {}
    callback({});
  });
  ses.webRequest.onCompleted(NET_FILTER, d => { try { netPush({ k: 'e', id: d.id, st: d.statusCode, c: !!d.fromCache, t: Date.now() }); } catch {} });
  ses.webRequest.onErrorOccurred(NET_FILTER, d => { try { netPush({ k: 'x', id: d.id, er: String(d.error || 'failed').slice(0, 160), t: Date.now() }); } catch {} });
  const SILENT = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management']);
  const ASK = { media: 'use your camera or microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'read the clipboard', midi: 'use MIDI devices' };
  const decided = new Map();
  const originOf = d => { try { return new URL((d && d.requestingUrl) || '').origin; } catch { return ''; } };
  ses.setPermissionCheckHandler((_wc, permission, origin) => SILENT.has(permission) || decided.get(origin + '|' + permission) === true);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (SILENT.has(permission)) return callback(true);
    if (!ASK[permission]) return callback(false);
    const origin = originOf(details), key = origin + '|' + permission;
    if (decided.has(key)) return callback(decided.get(key));
    dialog.showMessageBox(mainWindow || undefined, { type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, title: 'Website permission', message: (origin || 'This website') + ' wants to ' + ASK[permission] + '.' })
      .then(r => { const ok = r.response === 0; decided.set(key, ok); callback(ok); })
      .catch(() => callback(false));
  });
}

async function createWindow(url) {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null); // the in-app menu bar replaces the default menu
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 940,
    minHeight: 640,
    title: 'CodeSpace',
    icon: APP_ICON,
    show: false, // stays hidden behind the small splash window until the workspace has loaded
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        '--my-agent-bridge-url=' + url,
        '--my-agent-bridge-token=' + TOKEN
      ]
    }
  });

  // Never forward app-originated website navigation to the Windows default browser.
  // The host UI itself must not open windows; website popups are handled per guest below.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Website pages are rendered by the separate, main-owned WebContentsView created below.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const devKey = input.key === 'F12' || (input.control && input.shift && String(input.key).toLowerCase() === 'i');
    if (devKey) { event.preventDefault(); mainWindow.webContents.toggleDevTools(); }
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target !== url && !target.startsWith(url + '/')) event.preventDefault();
  });
  mainWindow.webContents.on('context-menu', (_e, p) => { try { showHostContextMenu(mainWindow.webContents, p); } catch {} });
  mainWindow.on('closed', () => { mainWindow = null; });
  setupBrowserView();
  // 3.13.21: a renderer reload (Ctrl+R, crash recovery) used to leave the native browser floating over
  // the splash/welcome screen until the page asked for a new position. Hide it the moment loading starts.
  mainWindow.webContents.on('did-start-loading', () => {
    browserVisible = false; browserAppliedVisible = false;
    try { if (browserView) browserView.setVisible(false); } catch {}
  });
  await mainWindow.loadURL(url + '/');
  const wait = Math.max(0, SPLASH_MIN_MS - (splashShownAt ? Date.now() - splashShownAt : 0));
  await new Promise(r => setTimeout(r, wait));
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  closeSplash();
}

app.whenReady().then(async () => {
  try {
    // VS Code-style Integrated Browser IPC. Every call is restricted to the CodeSpace host.
    const fromHost = e => !!(mainWindow && e.sender === mainWindow.webContents && browserView && !browserView.webContents.isDestroyed());
    ipcMain.handle('codespace:browser-ready', e => fromHost(e) ? browserState() : null);
    ipcMain.handle('codespace:browser-bounds', (e, b) => { if (!fromHost(e)) return false; browserSetBounds(b); return true; });
    ipcMain.handle('codespace:browser-visible', (e, visible) => { if (!fromHost(e)) return false; browserVisSeq++; browserVisible = !!visible; browserSetBounds(browserBounds); return true; });
    // 3.18.3: a menu, dialog or splitter drag has to hide the native view (it always paints above the page's
    // DOM), which used to leave a blank white rectangle. Capture the current frame FIRST, then hide, and give
    // the frame back as a JPEG so the page can show it in the same spot until the overlay closes.
    ipcMain.handle('codespace:browser-hide-snapshot', async e => {
      if (!fromHost(e)) return null;
      const seq = ++browserVisSeq;
      let shot = null;
      try {
        if (browserAppliedVisible && browserBounds.width > 1 && browserBounds.height > 1) {
          const image = await browserView.webContents.capturePage();
          if (image && !image.isEmpty()) shot = 'data:image/jpeg;base64,' + image.toJPEG(72).toString('base64');
        }
      } catch {}
      if (seq === browserVisSeq) { browserVisible = false; browserSetBounds(browserBounds); }   // not superseded by a newer show/hide request
      return shot;
    });
    // 3.13.19 read-only diagnostics: lets the UI (and automated tests) confirm what the main process
    // actually applied to the native view. Returns no webContents reference and mutates nothing.
    ipcMain.handle('codespace:browser-debug', e => {
      if (!fromHost(e)) return null;
      return { applied: browserAppliedVisible, requested: browserVisible, bounds: { ...browserBounds } };
    });
    ipcMain.handle('codespace:browser-nav', async (e, target) => {
      if (!fromHost(e)) throw new Error('Browser access denied.');
      const u = String(target || '').trim();
      if (u !== 'about:blank' && !isHttp(u)) throw new Error('Only http(s) websites are supported.');
      await browserView.webContents.loadURL(u); return browserState();
    });
    ipcMain.handle('codespace:browser-action', (e, action) => {
      if (!fromHost(e)) return null;
      const wc = browserView.webContents, h = navHistory(wc);
      if (action === 'back' && h.canGoBack()) h.goBack();
      else if (action === 'forward' && h.canGoForward()) h.goForward();
      else if (action === 'reload') wc.reload();
      else if (action === 'focus') wc.focus();
      else if (action === 'blank') wc.loadURL('about:blank').catch(() => {});
      return browserState();
    });
    ipcMain.handle('codespace:browser-eval', async (e, source) => {
      if (!fromHost(e)) throw new Error('Browser access denied.');
      if (typeof source !== 'string' || source.length > 100000) throw new Error('Invalid browser script.');
      return browserView.webContents.executeJavaScript(source, true);
    });
    ipcMain.handle('codespace:browser-capture', async e => {
      if (!fromHost(e)) throw new Error('Browser access denied.');
      const image = await browserView.webContents.capturePage(); return image.toDataURL();
    });
    ipcMain.handle('codespace:browser-input', (e, input) => {
      if (!fromHost(e) || !input || typeof input !== 'object') return false;
      const allowed = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'keyDown', 'keyUp', 'char', 'mouseWheel']);
      if (!allowed.has(input.type)) return false;
      browserView.webContents.sendInputEvent(input); return true;
    });
    // 3.13.5: native OS folder picker for the explorer's "Open folder" button. The renderer asks
    // for it through the one invoke channel exposed by preload.cjs; nothing else is reachable.
    ipcMain.handle('codespace:pick-folder', () =>
      dialog.showOpenDialog(mainWindow, { title: 'Open folder', buttonLabel: 'Open folder', properties: ['openDirectory', 'dontAddToRecent'] })
        .then(r => (r && !r.canceled && r.filePaths && r.filePaths[0]) || null)
        .catch(() => null));
    // Explicit user-requested open-in-system-browser action.
    ipcMain.handle('codespace:open-external', (_e, u) => {
      const url = String(u || '').trim();
      if (!/^https?:\/\//i.test(url) || url.length > 4000) return false;
      return shell.openExternal(url).then(() => true).catch(() => false);
    });
    showSplash();
    const ok = await canBind(PORT);
    if (!ok) throw new Error('Port ' + PORT + ' is already in use. Close any separately running agent-server.js or another CodeSpace instance, then try again.');
    setupGuestSession();
    startBackend();
    const url = await waitForBackend();
    await createWindow(url);
  } catch (e) {
    shuttingDown = true;
    closeSplash();
    if (serverChild && !serverChild.killed) serverChild.kill();
    dialog.showErrorBox('CodeSpace could not start', e.message || String(e));
    app.quit();
  }
});

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && !shuttingDown) app.quit(); });
app.on('before-quit', () => {
  shuttingDown = true;
  try { if (browserView && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(browserView); } catch {}
  try { if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close(); } catch {}
  browserView = null;
  if (serverChild && serverChild.exitCode === null && !serverChild.killed) {
    try { serverChild.kill(); } catch {}
  }
});
app.on('window-all-closed', () => app.quit());
