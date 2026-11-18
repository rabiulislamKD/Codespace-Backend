'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(x => typeof x === 'string' && x.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

// Only fixed, reviewed IPC operations are exposed. The page cannot send arbitrary IPC messages
// or reach Node/Electron APIs. The integrated browser is a narrow proxy to a main-owned WebContentsView.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => { try { callback(payload); } catch {} };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Expose the loopback bridge address and per-run bearer token needed by the UI.
contextBridge.exposeInMainWorld('myAgentDesktop', Object.freeze({
  bridgeUrl: argValue('my-agent-bridge-url'),
  bridgeToken: argValue('my-agent-bridge-token'),
  isDesktop: true,
  // Right-click > "Attach element to chat" in the embedded browser delivers its data here.
  onAttachFromBrowser: cb => subscribe('codespace:attach-from-browser', cb),
  // Ctrl+L inside a website focuses the Browser panel address bar.
  onFocusAddress: cb => subscribe('codespace:focus-address', cb),
  // Network activity of the embedded browser (method, address, status, timing only), delivered in small batches.
  onNetwork: cb => subscribe('codespace:net', cb),
  // Opens the operating system's own folder dialog and resolves to the selected path (or null on cancel).
  pickFolder: () => ipcRenderer.invoke('codespace:pick-folder'),
  // Explicit user action to open an http(s) URL in the system browser.
  openExternal: url => ipcRenderer.invoke('codespace:open-external', String(url || '')),
  browser: (() => {
    let state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
    let visible = false;
    const listeners = new Map();
    const emit = (type, payload) => {
      if (payload && payload.state) state = payload.state;
      const event = Object.freeze({ type, ...(payload || {}) });
      for (const fn of listeners.get(type) || []) { try { fn(event); } catch {} }
    };
    ipcRenderer.on('codespace:browser-event', (_e, payload) => { if (payload && typeof payload.type === 'string') emit(payload.type, payload); });
    const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
    const api = {
      addEventListener(type, fn) { if (typeof fn !== 'function') return; if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      ready: async () => { const s = await invoke('codespace:browser-ready'); if (s) state = s; return !!s; },
      getState: async () => { const s = await invoke('codespace:browser-ready'); if (s) state = s; return { ...state }; },
      getURL: () => state.url || '', getTitle: () => state.title || '', isLoading: () => !!state.loading,
      canGoBack: () => !!state.canGoBack, canGoForward: () => !!state.canGoForward,
      loadURL: async url => { const s = await invoke('codespace:browser-nav', String(url || '')); if (s) state = s; return s; },
      goBack: async () => { const s = await invoke('codespace:browser-action', 'back'); if (s) state = s; return s; },
      goForward: async () => { const s = await invoke('codespace:browser-action', 'forward'); if (s) state = s; return s; },
      reload: async () => { const s = await invoke('codespace:browser-action', 'reload'); if (s) state = s; return s; },
      focus: () => invoke('codespace:browser-action', 'focus'),
      clear: async () => { const s = await invoke('codespace:browser-action', 'blank'); if (s) state = s; return s; },
      executeJavaScript: source => invoke('codespace:browser-eval', String(source || '')),
      capturePage: async () => { const dataUrl = await invoke('codespace:browser-capture'); return Object.freeze({ toDataURL: () => dataUrl }); },
      sendInputEvent: input => invoke('codespace:browser-input', input),
      setBounds: bounds => invoke('codespace:browser-bounds', bounds),
      setVisible: value => { visible = !!value; return invoke('codespace:browser-visible', visible); },
      // 3.18.3: hide the native view for an overlay but resolve to a JPEG data URL of its last frame (or null).
      hideWithSnapshot: () => { visible = false; return invoke('codespace:browser-hide-snapshot'); },
      // 3.13.19 read-only diagnostics: what the main process actually applied to the native view.
      debug: () => invoke('codespace:browser-debug')
      /* 3.13.18 fix: the old `get/set hidden` accessor is deliberately gone. contextBridge
         passes accessor properties to the renderer as read-only snapshot values, so the app's
         `browser.hidden = …` assignments threw a TypeError that aborted the whole app bundle
         at startup (the window stayed on the splash page). The renderer must call setVisible()
         instead — never assign to properties of a contextBridge-exposed object. */
    };
    return Object.freeze(api);
  })()
}));
