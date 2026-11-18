let lastUrl = '';
const tabs = []; let activeTab = null;
const exp = { open: new Set(['']), cache: new Map(), errors: new Map() };
const bp = $('bp');
let bTimer = null, bBusy = false, bView = { vw: 1280, vh: 800 };
let chromeNetCursor = 0;
let bStreamAbort = null, bStreamStarting = false, bLastPreviewInfo = { url: '', title: '', vw: 1280, vh: 800 }, bDiagMode = 'console';
const DESKTOP_EMBED = !!(window.myAgentDesktop && window.myAgentDesktop.isDesktop && window.myAgentDesktop.browser);
const ANDROID_NATIVE_BROWSER = !!(window.CodeSpaceNative && typeof window.CodeSpaceNative.setBrowserBounds === 'function');
const INTEGRATED_BROWSER = DESKTOP_EMBED || ANDROID_NATIVE_BROWSER;
let browserRenderMode = INTEGRATED_BROWSER ? 'embedded' : 'proxy', liveHistory = [], liveHistoryIndex = -1, liveFrameSerial = 0;
const normPath = p => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');

const activeFileTab = () => { const t = tabs.find(x => x.id === activeTab); return t && t.type === 'file' ? t : null; };
function fileUI(t) {
  $('filePath').textContent = t.path + (t.dirty ? ' (unsaved)' : '');
  $('fPrev').hidden = !/\.html?$/i.test(t.path);
  $('fSave').hidden = !!t.error; $('fSave').disabled = !t.dirty; $('fRevert').hidden = !t.dirty; $('fStale').hidden = !t.stale;
}
function syncScroll() { const ta = $('edTa'); $('edHl').scrollTop = ta.scrollTop; $('edHl').scrollLeft = ta.scrollLeft; $('edGutter').scrollTop = ta.scrollTop; }
function paintEditor() {
  const ta = $('edTa'), text = ta.value, n = text.split('\n').length;
  $('edGutter').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  const lang = n > 5000 ? 'plain' : langOf(ta.dataset.path || '');
  $('edHl').innerHTML = (lang === 'plain' ? esc(text) : highlightLines(text, lang).join('\n')) + '\n ';
  syncScroll();
}
function drawFile(t) {
  fileUI(t);
  const ta = $('edTa'), same = ta.dataset.path === t.path, keep = same ? [ta.scrollTop, ta.scrollLeft] : [0, 0];
  ta.dataset.path = t.path;
  if (t.error) { ta.value = ''; ta.disabled = true; $('edGutter').textContent = ''; $('edHl').innerHTML = '<span class="cerr">' + esc(t.error) + '</span>'; return; }
  ta.disabled = false; $('fState').textContent = same ? $('fState').textContent : '';
  if (ta.value !== (t.text || '') || !same) ta.value = t.text || '';
  paintEditor(); ta.scrollTop = keep[0]; ta.scrollLeft = keep[1]; syncScroll();
  if (typeof vscodeSyncEditorDocument === 'function') vscodeSyncEditorDocument('open', t);
}
let paintT = null, reloadT = null;
$('edTa').addEventListener('scroll', syncScroll);
$('edTa').addEventListener('input', () => {
  const t = activeFileTab(); if (!t) return;
  t.text = $('edTa').value; const was = t.dirty; t.dirty = t.text !== t.saved; fileUI(t); $('fState').textContent = '';
  if (was !== t.dirty) renderTabs();
  if (typeof vscodeSyncEditorDocument === 'function') vscodeSyncEditorDocument('change', t);
  if (t.text.length < 60000) paintEditor(); else { clearTimeout(paintT); paintT = setTimeout(paintEditor, 120); }
});
$('edTa').addEventListener('keydown', e => {
  const ta = e.target;
  if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); if (typeof vscodeRequestEditorCompletions === 'function') vscodeRequestEditorCompletions().catch(() => {}); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveTab(activeFileTab()); return; }
  if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); if (!document.execCommand('insertText', false, '  ')) ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); return; }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.isComposing) {
    const before = ta.value.slice(0, ta.selectionStart), line = before.slice(before.lastIndexOf('\n') + 1), indent = (line.match(/^\s*/) || [''])[0];
    e.preventDefault(); if (!document.execCommand('insertText', false, '\n' + indent)) ta.setRangeText('\n' + indent, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input'));
  }
});
async function saveTab(t) {
  if (!t || !t.dirty) return;
  try { await fsWrite(t.path, t.text); t.saved = t.text; t.dirty = false; t.stale = false; if (typeof vscodeSyncEditorDocument === 'function') vscodeSyncEditorDocument('save', t); fileUI(t); renderTabs(); $('fState').textContent = 'Saved'; reloadPreview(); gitRefresh(); }
  catch (e) { $('fState').textContent = 'Could not save: ' + e.message; }
}
function reloadPreview() {
  if (!tabs.some(t => t.id === 'preview')) return;
  if (browserRenderMode === 'live') {
    const url = $('bFrame').src;
    if (url && url !== 'about:blank') { clearTimeout(reloadT); reloadT = setTimeout(() => { try { $('bFrame').contentWindow.location.reload(); } catch { $('bFrame').src = url; } }, 300); }
    return;
  }
  if (INTEGRATED_BROWSER && browserRenderMode === 'embedded') { clearTimeout(reloadT); reloadT=setTimeout(()=>embeddedReload(),300); return; }
  if (!B.ok) return;
  setTimeout(() => { bApproved('/browser/nav', { action: 'reload' }, undefined, 'Reload the page (server permission)?', 'browser_nav').then(r => { if (r && !r.needsApproval) bPoll(); }).catch(() => {}); }, 300);
}
$('fSave').onclick = () => saveTab(activeFileTab());
$('fRevert').onclick = () => { const t = activeFileTab(); if (!t) return; t.text = t.saved; t.dirty = false; renderTabs(); drawFile(t); };
$('fReload').onclick = () => { const t = activeFileTab(); if (!t) return; t.text = t.saved = t.disk; t.dirty = false; t.stale = false; renderTabs(); drawFile(t); };
function applyDisk(t, text, error) {
  if (error) { t.error = error; return; }
  t.error = '';
  if (t.dirty) { if (text !== t.saved) { t.disk = text; t.stale = true; } } else { t.text = text; t.saved = text; t.stale = false; }
}
window.addEventListener('beforeunload', e => { if (tabs.some(t => t.dirty)) { e.preventDefault(); e.returnValue = ''; } });
function drawTable(t) {
  $('tblInfo').textContent = t.title + ' · ' + t.rows.length + ' rows' + (t.truncated ? ' (limited)' : '') + (t.sql ? ' · ' + t.sql.slice(0, 90) : '');
  const w = $('tblWrap');
  if (!t.columns.length) { w.innerHTML = '<div class="tnote">' + esc(t.message || 'No rows') + '</div>'; return; }
  let h = '<table class="grid"><thead><tr>' + t.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
  t.rows.slice(0, 500).forEach(r => { h += '<tr>' + r.map(v => (v === null ? '<td class="nul">NULL</td>' : '<td>' + esc(String(v)) + '</td>')).join('') + '</tr>'; });
  w.innerHTML = h + '</tbody></table>' + (t.rows.length > 500 ? '<div class="tnote">Showing the first 500 rows.</div>' : '');
}
function openTable(title, r, sql, focus = true) {
  const t = { id: 'tbl:' + uid(), type: 'table', title, columns: r.columns || [], rows: r.rows || [], truncated: r.truncated, message: r.message, sql };
  tabs.push(t); if (focus || !activeTab) activate(t.id); else renderTabs();
}
function tabLabel(t) { return t.type === 'file' ? t.path.split('/').pop() : t.type === 'preview' ? 'Preview' : t.title; }
function renderTabs() {
  const box = $('tabs'); box.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTab ? ' on' : '') + (t.flash ? ' flash' : '');
    el.setAttribute('role', 'tab'); el.tabIndex = 0; el.title = t.type === 'file' ? t.path : tabLabel(t);
    const label = document.createElement('span'); label.textContent = tabLabel(t);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = t.dirty ? '●' : '✕'; x.setAttribute('aria-label', t.dirty ? 'Close tab (unsaved changes)' : 'Close tab');
    x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    el.append(label, x); el.onclick = () => activate(t.id); el.onkeydown = e => { if (e.key === 'Enter') activate(t.id); };
    box.appendChild(el);
    if (t.flash) setTimeout(() => { t.flash = false; }, 1500);
  });
}
function activate(id) {
  activeTab = id || null;
  const t = tabs.find(x => x.id === activeTab) || null;
  renderTabs();
  $('fileView').hidden = !(t && t.type === 'file');
  $('tableView').hidden = !(t && t.type === 'table');
  $('diffView').hidden = !(t && t.type === 'diff');
  bp.hidden = !(t && t.type === 'preview');
  if (t && t.type === 'file') drawFile(t);
  if (t && t.type === 'table') drawTable(t);
  if (t && t.type === 'diff') drawDiffTab(t);
  if (t && t.type === 'preview') updateBrowserModeUI();
  if (!(t && t.type === 'preview') && document.documentElement.classList.contains('browser-fs')) setBrowserFullscreen(false);
  if (typeof syncDockState === 'function') syncDockState();
  syncPoll(); drawTree();
  if (INTEGRATED_BROWSER) syncIntegratedBrowserBounds();
}
function closeTab(id, quiet = false) {
  const i = tabs.findIndex(x => x.id === id); if (i < 0) return;
  if (tabs[i].dirty && !quiet && !confirm('Discard the unsaved changes to ' + tabs[i].path + '?')) return;
  const wasPreview = tabs[i].type === 'preview';
  if (tabs[i].type === 'file' && typeof vscodeSyncEditorDocument === 'function') vscodeSyncEditorDocument('close', tabs[i]);
  tabs.splice(i, 1);
  if (wasPreview) {
    bShow(null);
    try { if (ANDROID_NATIVE_BROWSER && typeof window.CodeSpaceNative.browserClose === 'function') window.CodeSpaceNative.browserClose(); else if (B.ok && !quiet) bcall('/browser/close').catch(() => {}); } catch {}
    lastUrl = '';
  }
  if (activeTab === id) activate(tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null);
  else renderTabs();
}
function showPanel(focus = true) {
  if (!tabs.some(t => t.id === 'preview')) {
    tabs.push({ id: 'preview', type: 'preview' });
    if (!focus && activeTab) { renderTabs(); return; }
    focus = true;
  }
  if (focus || !activeTab) activate('preview'); else renderTabs();
  // Open in the editor pane by default. The native Android browser is drawn above
  // the DOM, so auto-fullscreen used to cover the chat and toolbar; the ⛶ button
  // still gives the page the whole workspace when the user asks for it.
  if (typeof syncDockState === 'function') syncDockState();
}
/* Android browser panel: full-screen popup with minimize/restore, so the page
   gets the whole viewport instead of a thin strip above the chat. */
function setBrowserFullscreen(on) {
  const root = document.documentElement;
  const next = typeof on === 'boolean' ? on : !root.classList.contains('browser-fs');
  if (next === root.classList.contains('browser-fs')) { if (next) resync(); return; }
  root.classList.toggle('browser-fs', next);
  const btn = $('bMax');
  if (btn) {
    btn.textContent = next ? '⤡' : '⛶';
    btn.title = next ? 'Exit full screen' : 'Full screen browser';
    btn.setAttribute('aria-label', next ? 'Exit full screen browser' : 'Full screen browser');
  }
  resync();
  function resync() {
    requestAnimationFrame(() => { syncIntegratedBrowserBounds(); setTimeout(syncIntegratedBrowserBounds, 120); setTimeout(syncIntegratedBrowserBounds, 320); });
  }
}
if ($('bMax')) $('bMax').onclick = () => setBrowserFullscreen();
if ($('bMin')) $('bMin').onclick = () => {
  // Minimize without destroying the loaded page. Keep the preview tab so the
  // Browser dock button (or the Preview tab) can restore the same session.
  setBrowserFullscreen(false);
  const previous = tabs.filter(t => t.id !== 'preview').pop();
  if (previous) activate(previous.id); else activate(null);
  if (typeof syncDockState === 'function') syncDockState();
};
// The Android back button already dispatches Escape into the page; leave the
// full-screen browser before anything else consumes it.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !document.documentElement.classList.contains('browser-fs')) return;
  if (document.querySelector('dialog[open]')) return;
  setBrowserFullscreen(false);
});
async function openFile(path, opt = {}) {
  path = normPath(path); if (!path) return null;
  const focus = opt.focus !== false;
  let text = null, error = '';
  // opt.content reuses content the agent just read over the bridge instead of fetching it again.
  if (typeof opt.content === 'string') text = opt.content;
  else { try { text = await fsRead(path); } catch (e) { error = e && e.message ? e.message : String(e); } }
  if (error && !focus && activeTab) return null;
  let t = tabs.find(x => x.id === 'f:' + path);
  if (!t) {
    t = { id: 'f:' + path, type: 'file', path, text, saved: text, disk: text, dirty: false, stale: false, error };
    tabs.push(t);
  } else applyDisk(t, text, error);
  t.flash = !!opt.flash;
  if (focus || !activeTab) activate(t.id);
  else { renderTabs(); if (activeTab === t.id) drawFile(t); }
  return t;
}
async function refreshTabs() {
  await Promise.all(tabs.filter(t => t.type === 'file').map(async t => {
    try { applyDisk(t, await fsRead(t.path), ''); }
    catch (e) { applyDisk(t, null, e && e.message ? e.message : String(e)); }
  }));
  renderTabs(); const t = activeFileTab(); if (t) drawFile(t);
}
$('fCopy').onclick = async () => {
  const t = activeFileTab(); if (!t || t.text == null) return;
  try { await navigator.clipboard.writeText(t.text); $('fState').textContent = 'Copied'; }
  catch { $('fState').textContent = 'Clipboard access unavailable'; }
};
$('tblCsv').onclick = async () => {
  const t = tabs.find(x => x.id === activeTab); if (!t || t.type !== 'table') return;
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  try { await navigator.clipboard.writeText([t.columns.map(q).join(','), ...t.rows.map(r => r.map(q).join(','))].join('\n')); }
  catch { $('tblInfo').textContent += ' · Clipboard access unavailable'; }
};
$('fPrev').onclick = () => {
  const t = tabs.find(x => x.id === activeTab);
  if (!t || t.type !== 'file') return;
  if (!B.ok) { addErr('Previewing a workspace file needs the terminal bridge.'); return; }
  showPanel(true);
  if (DESKTOP_EMBED && B.info && B.info.root) {
    const root = String(B.info.root).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const furl = 'file:///' + root.split('/').map(encodeURIComponent).join('/') + '/' + String(t.path).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    if ($('bAddr')) $('bAddr').value = furl;
    navigateEmbedded(furl, true).catch(e => { $('bErr').textContent = e.message; });
    return;
  }
  if ($('bAddr')) { $('bAddr').value = t.path; }
  if ($('bGo')) $('bGo').click();
};

function syncPoll() {
  const on = activeTab === 'preview' && B.ok && browserRenderMode === 'chrome';
  if (on) {
    if (!bStreamAbort && !bStreamStarting) startPreviewStream();
  } else {
    if (bTimer) { clearInterval(bTimer); bTimer = null; }
    const ac = bStreamAbort; bStreamAbort = null;
    if (ac) ac.abort();
    if (B.ok) bcall('/browser/stream/stop').catch(() => {});
    $('bStreamStatus').textContent = browserRenderMode === 'live' ? 'Live webpage mode' : browserRenderMode === 'embedded' ? 'Integrated Chromium · persistent signed-in session' : 'Preview stream: idle';
  }
}
function normalizeLiveUrl(raw) {
  let text = String(raw || '').trim(); if (!text) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#]|$)/i.test(text)) text = 'http://' + text;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(text)) text = 'https://' + text;
  try { const url = new URL(text); if (url.protocol === 'http:' || url.protocol === 'https:') return url.href; } catch {}
  return null;
}
function updateBrowserModeUI() {
  if (INTEGRATED_BROWSER && browserRenderMode === 'chrome') browserRenderMode = 'embedded';
  if ($('bRenderMode')) $('bRenderMode').value = browserRenderMode;
  if ($('bview')) $('bview').dataset.mode = browserRenderMode;
  const isFrameMode = browserRenderMode === 'live' || browserRenderMode === 'proxy';
  const frameSrc = $('bFrame')?.getAttribute('src') || '';
  if ($('bFrame')) $('bFrame').hidden = !isFrameMode || !frameSrc || frameSrc === 'about:blank';
  const hasFrame = !!$('bImg')?.dataset.hasFrame;
  if ($('bImg')) $('bImg').hidden = browserRenderMode !== 'chrome' || !hasFrame;
  /* 3.13.18 fix: contextBridge exposes every property read-only, so the old `browser.hidden = …`
     assignment threw "Cannot assign to read only property 'hidden'" in the desktop app and
     aborted the whole app bundle at startup (the app stayed on the splash page). setVisible()
     is the bridge-safe equivalent. 3.13.19: visibility now goes through browserPanelVisible()
     — the render mode alone is not enough, otherwise calling updateBrowserModeUI while another
     panel is showing (agent tools do this via bShow) floats the website over that panel. */
  if (DESKTOP_EMBED) { try { window.myAgentDesktop.browser.setVisible(browserPanelVisible()); } catch {} }
  if (ANDROID_NATIVE_BROWSER) setTimeout(syncAndroidBrowserBounds, 0);
  if ($('bFrameHint')) $('bFrameHint').hidden = browserRenderMode !== 'live';
  if (browserRenderMode === 'embedded') $('bStreamStatus').textContent = 'Integrated Chromium · persistent signed-in session';
  else if (browserRenderMode === 'proxy') $('bStreamStatus').textContent = 'Legacy proxy mode';
  else if (browserRenderMode === 'live') $('bStreamStatus').textContent = 'Live webpage mode';
  else $('bStreamStatus').textContent = B.ok ? 'Connecting to Agent Chrome…' : 'Connect the bridge to use Agent Chrome';
  syncPoll();
  if (DESKTOP_EMBED) setTimeout(syncNativeBrowserBounds, 0);
}
function applyLiveViewport() { if ($('bViewport')) $('bview').dataset.viewport = $('bViewport').value || 'responsive'; }
function navigateLive(raw, remember = true) {
  const url = normalizeLiveUrl(raw);
  if (!url) {
    $('bErr').textContent = 'This looks like a workspace file or unsupported URL. Choose Agent Chrome to open workspace paths, file:// URLs, or browser-only destinations.';
    return false;
  }
  $('bErr').textContent = '';
  browserRenderMode = 'live'; updateBrowserModeUI(); applyLiveViewport();
  if (remember && (liveHistoryIndex < 0 || liveHistory[liveHistoryIndex] !== url)) {
    liveHistory = liveHistory.slice(0, liveHistoryIndex + 1); liveHistory.push(url); liveHistoryIndex = liveHistory.length - 1;
  }
  lastUrl = url; if ($('bAddr')) $('bAddr').value = url; if ($('bSecureIcon')) $('bSecureIcon').textContent = url.startsWith('https:') ? '🔒' : 'ⓘ';
  if ($('bTabTitle')) $('bTabTitle').textContent = (() => { try { return new URL(url).hostname; } catch { return 'Loading…'; } })();
  $('bInfo').textContent = 'Loading live webpage…'; $('bEmpty').hidden = true; $('bFrame').hidden = false; $('bImg').hidden = true;
  const serial = ++liveFrameSerial;
  const target = new URL(url, location.href);
  const sameOrigin = target.origin === location.origin;
  if ($('bFrame')) $('bFrame').setAttribute('sandbox', sameOrigin ? 'allow-scripts allow-forms allow-popups allow-downloads' : 'allow-scripts allow-forms allow-same-origin allow-popups allow-downloads');
  $('bFrame').src = url;
  updateAuthHint(url);
  $('bFrame').onload = () => {
    if (serial !== liveFrameSerial || browserRenderMode !== 'live') return;
    let title = '';
    try { title = $('bFrame').contentDocument && $('bFrame').contentDocument.title || ''; } catch {}
    $('bTabTitle').textContent = title || (() => { try { return new URL(url).hostname; } catch { return 'Website'; } })();
    $('bInfo').textContent = (title ? title + ' · ' : '') + url;
    $('bStreamStatus').textContent = 'Live webpage loaded · interactive';
  };
  return true;
}
/* 3.13.5: Proxy mode — the page loads through the server's /browse endpoint, which strips
   X-Frame-Options/CSP and rewrites URLs, so sites that refuse embedding (Google, Gmail) render
   and allow sign-in inside the panel. The iframe is same-origin, so the address bar can follow
   in-page navigation directly. */
function navigateProxy(raw, remember = true) {
  const url = normalizeLiveUrl(raw);
  if (!url) {
    $('bErr').textContent = 'Enter a website address or search text. Workspace files need the editor; file:// paths are not proxied.';
    return false;
  }
  $('bErr').textContent = '';
  browserRenderMode = 'proxy'; updateBrowserModeUI(); applyLiveViewport();
  if (remember && (liveHistoryIndex < 0 || liveHistory[liveHistoryIndex] !== url)) {
    liveHistory = liveHistory.slice(0, liveHistoryIndex + 1); liveHistory.push(url); liveHistoryIndex = liveHistory.length - 1;
  }
  lastUrl = url; if ($('bAddr')) $('bAddr').value = url; if ($('bSecureIcon')) $('bSecureIcon').textContent = url.startsWith('https:') ? '🔒' : 'ⓘ';
  if ($('bTabTitle')) $('bTabTitle').textContent = (() => { try { return new URL(url).hostname; } catch { return 'Loading…'; } })();
  $('bInfo').textContent = 'Loading through the CodeSpace proxy…'; $('bEmpty').hidden = true; $('bFrame').hidden = false; $('bImg').hidden = true;
  liveFrameSerial++;
  $('bFrame').setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-downloads allow-modals');
  $('bFrame').src = '/browse?url=' + encodeURIComponent(url);
  updateAuthHint(url);
  return true;
}
async function navigateEmbedded(raw, remember = true) {
  const url = embeddedTargetFor(raw);
  if (!url) return false;
  if (ANDROID_NATIVE_BROWSER) {
    if (!/^https?:\/\//i.test(url)) { $('bErr').textContent = 'Android Browser supports HTTP(S) pages. Open workspace files in the CodeSpace editor.'; return false; }
    $('bErr').textContent = ''; browserRenderMode = 'embedded'; updateBrowserModeUI();
    if (remember && (liveHistoryIndex < 0 || liveHistory[liveHistoryIndex] !== url)) { liveHistory = liveHistory.slice(0, liveHistoryIndex + 1); liveHistory.push(url); liveHistoryIndex = liveHistory.length - 1; }
    lastUrl = url; if ($('bAddr')) $('bAddr').value = url; if ($('bSecureIcon')) $('bSecureIcon').textContent = url.startsWith('https:') ? '🔒' : 'ⓘ';
    if ($('bTabTitle')) $('bTabTitle').textContent = (() => { try { return new URL(url).hostname; } catch { return 'Loading…'; } })();
    $('bInfo').textContent = 'Loading in CodeSpace Browser…'; $('bEmpty').hidden = true; $('bImg').hidden = true;
    try { window.CodeSpaceNative.browserNavigate(url); setTimeout(syncAndroidBrowserBounds, 120); $('bStreamStatus').textContent = 'Native Android browser · loading'; return true; }
    catch (e) { $('bErr').textContent = 'Browser navigation failed: ' + e.message; return false; }
  }
  if (!DESKTOP_EMBED) return false;
  const wv = window.myAgentDesktop.browser;
  let currentUrl = '', isLoading = false;
  try { currentUrl = wv.getURL() || ''; } catch {}
  try { isLoading = wv.isLoading(); } catch {}
  const norm = s => String(s || '').replace(/#.*$/, '').replace(/\/$/, '');
  if (!isLoading && currentUrl && norm(currentUrl) === norm(url)) {
    try {
      const info = await embeddedPageInfo();
      if (info && info.url && browserRenderMode === 'embedded') {
        lastUrl = info.url;
        if (document.activeElement !== $('bAddr') && $('bAddr')) $('bAddr').value = info.url;
        if ($('bTabTitle')) $('bTabTitle').textContent = info.title || (() => { try { return new URL(info.url).hostname; } catch { return 'Website'; } })();
        $('bInfo').textContent = (info.title ? info.title + ' · ' : '') + info.url;
        $('bStreamStatus').textContent = info.challenge ? 'Website verification required · complete it here' : 'Integrated Chromium · page loaded';
      }
    } catch {}
    return true;
  }
  $('bErr').textContent = ''; browserRenderMode = 'embedded'; updateBrowserModeUI();
  if (remember && (liveHistoryIndex < 0 || liveHistory[liveHistoryIndex] !== url)) { liveHistory = liveHistory.slice(0, liveHistoryIndex + 1); liveHistory.push(url); liveHistoryIndex = liveHistory.length - 1; }
  lastUrl = url; if ($('bAddr')) $('bAddr').value = url; if ($('bSecureIcon')) $('bSecureIcon').textContent = url.startsWith('https:') ? '🔒' : 'ⓘ';
  if ($('bTabTitle')) $('bTabTitle').textContent = (() => { try { return new URL(url).hostname; } catch { return 'Loading…'; } })();
  $('bInfo').textContent = 'Loading in CodeSpace Integrated Browser…'; $('bEmpty').hidden = true; $('bImg').hidden = true;
  try { wv.setVisible(true); } catch {}
  try {
    await embeddedReady();
    try { await wv.loadURL(url); } catch (e) { if (!/ERR_ABORTED|\(-3\)/.test(String(e && e.message))) throw e; }
    const info = await embeddedPageInfo();
    if (info && info.url && browserRenderMode === 'embedded') {
      lastUrl = info.url; if ($('bAddr')) $('bAddr').value = info.url; if ($('bTabTitle')) $('bTabTitle').textContent = info.title || new URL(info.url).hostname;
      $('bInfo').textContent = (info.title ? info.title + ' · ' : '') + info.url;
      $('bStreamStatus').textContent = info.challenge ? 'Website verification required · complete it here' : 'Integrated Chromium · page loaded';
    }
  } catch (e) { $('bErr').textContent = 'Embedded browser navigation failed: ' + e.message; return false; }
  return true;
}
let embeddedDomReady = false;
async function embeddedReady() {
  if (ANDROID_NATIVE_BROWSER) return true;
  if (!DESKTOP_EMBED) throw new Error('Integrated Browser is available only in CodeSpace.');
  const browser = window.myAgentDesktop.browser; try { browser.setVisible(true); } catch {}
  if (!await browser.ready()) throw new Error('The Integrated Browser did not initialize. Restart CodeSpace.');
  embeddedDomReady = true;
}
function embeddedTargetFor(raw) {
  const t = String(raw || '').trim(); if (!t) return null;
  const u = normalizeLiveUrl(t); if (u) return u;
  if (/^file:\/\//i.test(t)) return t;
  if (/^(?:javascript|data|blob|about|chrome|vbscript|file):/i.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t); // anything else behaves like a search, as in a normal browser address bar
}
/* Embedded browser console capture: everything the page writes to its console (including uncaught errors and the
   output of the agent's own browser_run_js code) is buffered here. The agent drains what is new on each browser tool
   call; the Console button in the Browser panel shows the full buffer. */
const EMB_CON = { buf: [], seq: 0, cursor: 0 };
function embPushConsole(level, message, source, line) {
  const lv = typeof level === 'number' ? ['debug', '', 'warn', 'error'][level] : String(level || '').toLowerCase();
  const label = lv === 'info' || lv === 'log' ? '' : (lv === 'warning' ? 'warn' : lv);
  const where = source && /^https?:|^file:/.test(source) && label === 'error' ? ' (' + String(source).replace(/^https?:\/\/[^/]+/, '').slice(0, 80) + (line ? ':' + line : '') + ')' : '';
  EMB_CON.buf.push({ s: ++EMB_CON.seq, t: (label ? label + ': ' : '') + String(message == null ? '' : message).slice(0, 600) + where });
  if (EMB_CON.buf.length > 300) EMB_CON.buf.shift();
}
async function embConsoleDrain(all, clear) {
  await sleep(80); // console events arrive from the webview asynchronously
  let rows = all ? EMB_CON.buf.slice() : EMB_CON.buf.filter(x => x.s > EMB_CON.cursor);
  const omitted = Math.max(0, rows.length - 100); rows = rows.slice(-100);
  EMB_CON.cursor = EMB_CON.seq;
  if (clear) EMB_CON.buf.length = 0;
  return (omitted ? ['(' + omitted + ' earlier message(s) omitted)'] : []).concat(rows.map(x => x.t));
}
async function withEmbConsole(r) { r = r || {}; r.console = await embConsoleDrain(); return r; }
/* Network capture shared by all three browser paths. Only method, address, status, type and timing are ever
   captured (no headers, cookies or bodies) and secrets in query strings are masked before anyone sees them. */
const NET_SECRET_PARAM = /(token|secret|passw|pwd|api[-_]?key|apikey|^key$|auth|signature|^sig$|session|^sid$|jwt|credential)/i;
function redactUrl(u) {
  u = String(u == null ? '' : u);
  try {
    const x = new URL(u); let changed = false;
    [...x.searchParams.keys()].forEach(k => { if (NET_SECRET_PARAM.test(k)) { x.searchParams.set(k, '***'); changed = true; } });
    if (x.username || x.password) { x.username = ''; x.password = ''; changed = true; }
    return (changed ? x.href : u).slice(0, 300);
  } catch { return u.slice(0, 300); }
}
const netLine = x => '[' + (x.err ? 'failed' : x.status == null ? 'pending' : x.status) + '] ' + (x.method || 'GET') + ' ' + redactUrl(x.url) + (x.type ? ' · ' + x.type : '') + (x.ms != null ? ' · ' + x.ms + ' ms' : '') + (x.err ? ' — ' + x.err : '');
function netSelect(rows, a) {
  const f = String((a && a.filter) || '').toLowerCase();
  if (f) rows = rows.filter(x => String(x.url || '').toLowerCase().includes(f));
  if (a && a.failed_only) rows = rows.filter(x => x.err || (x.status != null && x.status >= 400));
  const omitted = Math.max(0, rows.length - 100);
  return { rows: rows.slice(-100), omitted };
}
const netText = (head, sel, empty) => head + '\n' + (sel.omitted ? '(' + sel.omitted + ' earlier request(s) omitted)\n' : '') + (sel.rows.map(netLine).join('\n') || empty);
const EMB_NET = { rows: [], byId: new Map(), seq: 0, cursor: 0, doneSeq: 0, lastDone: 0 };
let embNetTimer = null;
function embNetEvents(batch) {
  if (!Array.isArray(batch)) return;
  for (const e of batch) {
    if (!e || typeof e !== 'object') continue;
    if (e.k === 's') {
      const row = { s: ++EMB_NET.seq, id: e.id, method: String(e.m || 'GET'), url: String(e.u || ''), type: String(e.ty || ''), t0: Number(e.t) || Date.now(), status: null, err: '', ms: null, doneAt: 0 };
      EMB_NET.rows.push(row); EMB_NET.byId.set(e.id, row);
      if (EMB_NET.rows.length > 500) { const old = EMB_NET.rows.shift(); EMB_NET.byId.delete(old.id); }
    } else {
      const row = EMB_NET.byId.get(e.id); if (!row) continue;
      row.doneAt = ++EMB_NET.doneSeq; row.ms = Math.max(0, (Number(e.t) || Date.now()) - row.t0);
      if (e.k === 'e') row.status = e.st; else if (e.k === 'x') row.err = String(e.er || 'failed');
    }
  }
  if (!embNetTimer) embNetTimer = setTimeout(() => { embNetTimer = null; if (!$('previewDiag').hidden && bDiagMode === 'network' && DESKTOP_EMBED && browserRenderMode === 'embedded') loadPreviewDiagnostics('network'); }, 400);
}
async function embNetDrain(a) {
  await sleep(200); // events arrive from the main process in small batches
  let rows = a.all ? EMB_NET.rows.slice() : EMB_NET.rows.filter(x => x.s > EMB_NET.cursor || (x.doneAt && x.doneAt > EMB_NET.lastDone));
  EMB_NET.cursor = EMB_NET.seq; EMB_NET.lastDone = EMB_NET.doneSeq;
  if (a.clear) { EMB_NET.rows.length = 0; EMB_NET.byId.clear(); }
  return netSelect(rows, a);
}
/* 3.13.19 occlusion fix: the native Integrated Browser is a floating WebContentsView that draws
   ABOVE every DOM layer of the window. It must therefore stay hidden whenever anything else of
   the app should be seen in its place: another editor tab, the welcome screen, a modal dialog,
   the command palette or an open menu dropdown. browserOverlayOpen() detects those overlays;
   browserPanelVisible() is the single source of truth for native-view visibility. */
/* 3.13.21: the overlay list was too short (only <dialog> and the menu bar), so the model menu, the
   permission menu, the explorer context menu, the context popover and any splitter drag were drawn
   BEHIND the native browser. Every floating element is now listed here, and a MutationObserver
   (installed below) re-evaluates visibility the moment one opens or closes instead of waiting for the
   400 ms audit tick. */
const BROWSER_OVERLAY_SELECTORS = ['dialog[open]', '#menuDrop:not([hidden])', '#provMenu:not([hidden])', '#permMenu:not([hidden])', '#routeMenu:not([hidden])', '#ctxPop:not([hidden])', '.ctxmenu:not([hidden])', '.mb-drop:not([hidden])', '#codespaceSplash:not([hidden])', '.pop:not([hidden])', '#sideSplit.dragging', '[data-occludes-browser]:not([hidden])'];
function browserOverlayOpen() {
  try {
    if (document.body && document.body.classList.contains('cs-dragging')) return true;
    for (const sel of BROWSER_OVERLAY_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (sel === '#codespaceSplash:not([hidden])') { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue; }
      return true;
    }
  } catch {}
  return false;
}
/* Would the native view be on screen if no menu/dialog were open? (everything except overlays) */
function browserPanelShown() {
  if (!INTEGRATED_BROWSER || browserRenderMode !== 'embedded') return false;
  if (activeTab !== 'preview' || $('bp').hidden) return false;
  const r = visibleBrowserRect($('bview'));
  return r.width > 1 && r.height > 1;
}
function browserPanelVisible() { return browserPanelShown() && !browserOverlayOpen(); }
/* 3.18.3: while an overlay (menu, dialog, splitter drag) hides the native view, the last frame of the
   page is shown in its place so the website no longer flashes to a blank white panel. */
function nativeSnapEl() {
  let el = $('bSnap');
  if (!el) { el = document.createElement('img'); el.id = 'bSnap'; el.alt = ''; el.hidden = true; el.draggable = false; $('bview').appendChild(el); }
  return el;
}
function showNativeSnapshot(src, rect) {
  const el = nativeSnapEl(), host = $('bview').getBoundingClientRect();
  const full = rect && Math.abs(rect.width - host.width) < 3 && Math.abs(rect.height - host.height) < 3;
  el.style.cssText = full ? '' : 'left:' + Math.round(rect.x - host.left) + 'px;top:' + Math.round(rect.y - host.top) + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
  el.src = src; el.hidden = false;
}
function clearNativeSnapshot() { const el = $('bSnap'); if (el && !el.hidden) { el.hidden = true; el.removeAttribute('src'); } }
/* The native view ignores DOM clipping, so the rectangle handed to it is intersected with the
   window and with every scrolling/clipping ancestor. Without this, a short window made the browser
   spill over the terminal panel, the status bar and the chat column. */
function visibleBrowserRect(el) {
  const r0 = el.getBoundingClientRect();
  let l = r0.left, t = r0.top, rt = r0.right, b = r0.bottom;
  const clip = (x0, y0, x1, y1) => { l = Math.max(l, x0); t = Math.max(t, y0); rt = Math.min(rt, x1); b = Math.min(b, y1); };
  clip(0, 0, window.innerWidth, window.innerHeight);
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.display === 'none') return { x: l, y: t, width: 0, height: 0 };
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const ar = a.getBoundingClientRect(); clip(ar.left, ar.top, ar.right, ar.bottom); }
  }
  return { x: l, y: t, width: Math.max(0, rt - l), height: Math.max(0, b - t), full: r0 };
}
let lastNativeSync = { x: -1, y: -1, width: -1, height: -1, visible: null };
function syncNativeBrowserBounds(force) {
  if (!DESKTOP_EMBED) return;
  const host = $('bview'); if (!host) return;
  const vr = visibleBrowserRect(host), r = vr.full || host.getBoundingClientRect();
  const shown = browserPanelShown(), overlay = shown && browserOverlayOpen(), visible = shown && !overlay;
  const wasVisible = lastNativeSync.visible === true;
  const dims = { phone: [390, 844], tablet: [820, 1180], desktop: [1280, 800] };
  let x = r.left, y = r.top, width = r.width, height = r.height;
  const mode = $('bViewport')?.value || 'responsive';
  if (mode !== 'responsive') { const d = dims[mode] || dims.desktop; width = Math.min(r.width, d[0]); height = Math.min(r.height, d[1]); x += (r.width - width) / 2; y += (r.height - height) / 2; }
  // clip the (possibly device-sized) rectangle to what is really visible on screen
  const x0 = Math.max(x, vr.x), y0 = Math.max(y, vr.y), x1 = Math.min(x + width, vr.x + vr.width), y1 = Math.min(y + height, vr.y + vr.height);
  const cur = { x: Math.round(x0), y: Math.round(y0), width: Math.max(0, Math.round(x1 - x0)), height: Math.max(0, Math.round(y1 - y0)), visible };
  if (!force && lastNativeSync.x === cur.x && lastNativeSync.y === cur.y && lastNativeSync.width === cur.width && lastNativeSync.height === cur.height && lastNativeSync.visible === cur.visible) return;
  lastNativeSync = cur;
  const browser = window.myAgentDesktop.browser;
  const bounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
  if (overlay && wasVisible && typeof browser.hideWithSnapshot === 'function') {
    // A menu / dialog / splitter drag just opened over the page: grab the current frame, then hide the native view.
    browser.hideWithSnapshot().then(shot => {
      if (shot && browserOverlayOpen()) showNativeSnapshot(shot, bounds);
      else if (!browserOverlayOpen()) { lastNativeSync.visible = null; syncNativeBrowserBounds(true); }   // overlay vanished while capturing
    }).catch(() => {});
    browser.setBounds(bounds).catch(() => {});
    return;
  }
  // Hide first, then move: an old position must never flash over a freshly opened menu.
  if (!visible) browser.setVisible(false).catch(() => {});
  browser.setBounds(bounds).catch(() => {});
  browser.setVisible(visible).then(() => { if (visible) requestAnimationFrame(clearNativeSnapshot); }).catch(() => {});
  if (!overlay) { if (!visible) clearNativeSnapshot(); }
}
function syncAndroidBrowserBounds() {
  if (!ANDROID_NATIVE_BROWSER) return;
  const host = $('bview'); if (!host) return;
  const vr = visibleBrowserRect(host), r = vr.full || host.getBoundingClientRect();
  const shown = browserPanelShown(), visible = shown && !browserOverlayOpen();
  const x = Math.max(r.left, vr.x), y = Math.max(r.top, vr.y);
  const right = Math.min(r.right, vr.x + vr.width), bottom = Math.min(r.bottom, vr.y + vr.height);
  const width = Math.max(0, right - x), height = Math.max(0, bottom - y);
  try { window.CodeSpaceNative.setBrowserBounds(Math.round(x), Math.round(y), Math.round(width), Math.round(height), visible && width > 1 && height > 1); } catch {}
}
function syncIntegratedBrowserBounds() {
  if (DESKTOP_EMBED) syncNativeBrowserBounds();
  else if (ANDROID_NATIVE_BROWSER) syncAndroidBrowserBounds();
}
function embeddedBack() { try { if (ANDROID_NATIVE_BROWSER) window.CodeSpaceNative.browserBack(); else { const wv=window.myAgentDesktop.browser; if (wv.canGoBack()) wv.goBack(); } } catch {} }
function embeddedForward() { try { if (ANDROID_NATIVE_BROWSER) window.CodeSpaceNative.browserForward(); else { const wv=window.myAgentDesktop.browser; if (wv.canGoForward()) wv.goForward(); } } catch {} }
function embeddedReload() { try { if (ANDROID_NATIVE_BROWSER) window.CodeSpaceNative.browserReload(); else window.myAgentDesktop.browser.reload(); } catch {} }
if (DESKTOP_EMBED) {
  const wv = window.myAgentDesktop.browser;
  wv.addEventListener('dom-ready', () => { embeddedDomReady = true; });
  wv.addEventListener('console-message', e => { try { embPushConsole(e.level, e.message, e.sourceId, e.line); } catch {} });
  wv.addEventListener('did-navigate', e => { try { embPushConsole('log', '— navigated to ' + String(e.url || '').slice(0, 200) + ' —'); } catch {} });
  wv.addEventListener('render-process-gone', () => { embeddedDomReady = false; if (browserRenderMode === 'embedded') $('bErr').textContent = 'The page crashed. Reload it or open another address.'; });
  wv.addEventListener('did-navigate', e => { if (browserRenderMode !== 'embedded') return; lastUrl=e.url; if ($('bAddr') && document.activeElement !== $('bAddr')) $('bAddr').value=e.url; if ($('bSecureIcon')) $('bSecureIcon').textContent=e.url.startsWith('https:')?'🔒':'ⓘ'; $('bInfo').textContent=e.url; });
  wv.addEventListener('did-navigate-in-page', e => { if (browserRenderMode === 'embedded') { lastUrl=e.url; if ($('bAddr') && document.activeElement !== $('bAddr')) $('bAddr').value=e.url; } });
  wv.addEventListener('page-title-updated', e => { if (browserRenderMode === 'embedded' && $('bTabTitle')) $('bTabTitle').textContent=e.title || 'Website'; });
  wv.addEventListener('did-start-loading', () => { if (browserRenderMode === 'embedded') $('bStreamStatus').textContent='Loading webpage…'; });
  wv.addEventListener('did-stop-loading', () => { if (browserRenderMode === 'embedded') $('bStreamStatus').textContent='Integrated Chromium · page loaded'; });
  wv.addEventListener('did-fail-load', e => { if (browserRenderMode === 'embedded' && e.errorCode !== -3) $('bErr').textContent='Could not load page: '+e.errorDescription+' ('+e.errorCode+')'; });
  const sync = () => syncNativeBrowserBounds();
  window.addEventListener('resize', sync); window.addEventListener('scroll', sync, true);
  if (window.ResizeObserver) { const ro = new ResizeObserver(sync); ro.observe($('bview')); ro.observe($('bp')); }
  // 3.13.19 occlusion fix: an audit tick catches every layout/overlay change that has no event of
  // its own (modal dialogs, menu dropdowns, palette, agent tool UI). sync() only sends IPC when
  // bounds or visibility actually changed, so this stays cheap.
  setInterval(sync, 400);
  setTimeout(sync, 0);
  // 3.13.21: react at once (next frame) when any floating element opens/closes or a splitter drags.
  let raf = 0; const soon = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  try { new MutationObserver(soon).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] }); new MutationObserver(soon).observe(document.body, { childList: true }); } catch {}
  document.addEventListener('pointerdown', soon, true); document.addEventListener('pointerup', soon, true);
}
if (ANDROID_NATIVE_BROWSER) {
  const sync = () => syncAndroidBrowserBounds();
  window.addEventListener('resize', sync); window.addEventListener('scroll', sync, true);
  if (window.ResizeObserver) { const ro = new ResizeObserver(sync); ro.observe($('bview')); ro.observe($('bp')); }
  let raf = 0; const soon = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  try { new MutationObserver(soon).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] }); new MutationObserver(soon).observe(document.body, { childList: true }); } catch {}
  document.addEventListener('pointerdown', soon, true); document.addEventListener('pointerup', soon, true);
  setInterval(sync, 450); setTimeout(sync, 0);
}
/* 3.13.19: chat.z.ai always opens inside the CodeSpace Integrated Browser (desktop) — never in an
   external window — so sign-in happens in place and the session is captured automatically. */
function openChatZaiInBrowser() {
  showPanel(true);
  if (INTEGRATED_BROWSER) { navigateEmbedded('https://chat.z.ai/', true).catch(e => { $('bErr').textContent = e.message; }); return; }
  window.open('https://chat.z.ai/', '_blank', 'noopener,noreferrer');
}
/* 3.13.19: automatic chat.z.ai session capture. While the Integrated Browser is on a z.ai page,
   read the site's own localStorage token (the same value the Chat Z.ai bridge needs) and hand it
   to the local agent-server once per new value. The token is never rendered, logged or stored in
   the chat transcript; it travels only over the authenticated loopback bridge. */
let zaiCapturedToken = '', zaiHarvestBusy = false;
async function zaiHarvestTick() {
  if (zaiHarvestBusy) return;
  zaiHarvestBusy = true;
  try {
    const wv = window.myAgentDesktop.browser;
    let url = ''; try { url = String(wv.getURL() || ''); } catch {}
    if (!/^https:\/\/([^/]*\.)?z\.ai\//i.test(url)) return;
    let tok = '';
    try { tok = String(await wv.executeJavaScript('(()=>{try{return String(localStorage.getItem("token")||"")}catch(e){return ""}})()') || ''); } catch {}
    if (tok && tok.length >= 20 && tok !== zaiCapturedToken) {
      zaiCapturedToken = tok;
      await bcall('/chat-zai/token', { token: tok });
      addNote('chat.z.ai session captured from the CodeSpace Browser panel. Chat Z.ai can now use it.');
    }
  } catch {}
  finally { zaiHarvestBusy = false; }
}
if (DESKTOP_EMBED) setInterval(zaiHarvestTick, 2500);
if (DESKTOP_EMBED) {
  // Links in chat, dev-server chips and docs open inside the CodeSpace browser, never the OS browser.
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || e.defaultPrevented || e.button > 1) return;
    const href = a.href || '';
    if (!/^https?:\/\//i.test(href)) return;
    if (a.origin === location.origin && !a.target) return;
    e.preventDefault(); showPanel(true); navigateEmbedded(href, true).catch(err => { $('bErr').textContent = err.message; });
  }, true);
}
async function embeddedEval(expression) {
  if (!DESKTOP_EMBED) throw new Error('Embedded browser is available only in the CodeSpace desktop app.');
  await embeddedReady();
  const wv = window.myAgentDesktop.browser; let cur = ''; try { cur = wv.getURL(); } catch {}
  if (!cur || cur === 'about:blank') throw new Error('Open a website in the CodeSpace browser first.');
  return await wv.executeJavaScript(expression, true);
}
async function embeddedPageInfo() {
  if (!DESKTOP_EMBED) return { url: '', title: '', challenge: false };
  try {
    return await embeddedEval(`(()=>{const t=(document.title+' '+(document.body?.innerText||'').slice(0,1600));return {url:location.href,title:document.title||'',challenge:/just a moment|verify you are human|checking your browser|security verification|unusual traffic|attention required/i.test(t)||!!document.querySelector('#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]')}})()`);
  } catch { const wv=window.myAgentDesktop.browser; return { url: wv?.getURL?.() || '', title: wv?.getTitle?.() || '', challenge: false }; }
}
async function embeddedReadPage() {
  const result = await embeddedEval(`(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};const selector=e=>{if(e.id)return '#'+(window.CSS&&CSS.escape?CSS.escape(e.id):e.id.replace(/[^a-zA-Z0-9_-]/g,'\\$&'));const a=[];for(let n=e;n&&n.nodeType===1&&a.length<5;n=n.parentElement){let q=n.tagName.toLowerCase();if(n.classList&&n.classList.length)q+='.'+[...n.classList].slice(0,2).map(c=>window.CSS&&CSS.escape?CSS.escape(c):c).join('.');else if(n.parentElement){const same=[...n.parentElement.children].filter(x=>x.tagName===n.tagName);if(same.length>1)q+=':nth-of-type('+(same.indexOf(n)+1)+')'}a.unshift(q);if(n.id)break}return a.join(' > ')};const els=[...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0,120).map(e=>({selector:selector(e),tag:e.tagName.toLowerCase(),type:e.getAttribute('type')||'',text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.value||'').trim().slice(0,180),href:e.href||''}));const txt=(document.body?.innerText||'').slice(0,18000);const all=(document.title+' '+txt.slice(0,1600));return {url:location.href,title:document.title||'',text:txt,elements:els,scrollY:scrollY,pageHeight:document.documentElement.scrollHeight,vw:innerWidth,vh:innerHeight,challenge:/just a moment|verify you are human|checking your browser|security verification|unusual traffic|attention required/i.test(all)||!!document.querySelector('#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]'),console:[]}})()`);
  const pageInfo = await embeddedPageInfo();
  return { ...result, ...pageInfo, url: result.url || pageInfo.url };
}
async function embeddedEnsureNoChallenge(action) {
  const info = await embeddedPageInfo();
  if (info.challenge) throw new Error('This page is showing a security verification or bot-check screen. Complete it manually in the CodeSpace browser first; the agent will not click or bypass the verification.');
  return info;
}
async function embeddedClickElement(a) {
  await embeddedEnsureNoChallenge('click');
  const selector = String(a.selector || '');
  const x = Number(a.x), y = Number(a.y);
  const find = `let el=${JSON.stringify(selector)}?document.querySelector(${JSON.stringify(selector)}):document.elementFromPoint(${Number.isFinite(x)?x:0},${Number.isFinite(y)?y:0});if(!el)return {ok:false,reason:'No element found for the supplied selector or coordinates.'};el.scrollIntoView({block:'center',behavior:'instant'});`;
  const loc = await embeddedEval(`(()=>{${find}const r=el.getBoundingClientRect(),cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);const top=document.elementFromPoint(cx,cy);const hit=r.width>0&&r.height>0&&!!top&&(top===el||el.contains(top)||top.contains(el));return {ok:true,hit,cx,cy,tag:el.tagName.toLowerCase(),text:(el.innerText||el.getAttribute('aria-label')||'').trim().slice(0,120)}})()`);
  if (!loc.ok) throw new Error(loc.reason);
  let native = false;
  if (loc.hit) {
    // A real mouse click (trusted events) works on sites that ignore synthetic el.click().
    try {
      const wv = window.myAgentDesktop.browser; wv.focus();
      await wv.sendInputEvent({ type: 'mouseMove', x: loc.cx, y: loc.cy });
      await wv.sendInputEvent({ type: 'mouseDown', x: loc.cx, y: loc.cy, button: 'left', clickCount: 1 });
      await wv.sendInputEvent({ type: 'mouseUp', x: loc.cx, y: loc.cy, button: 'left', clickCount: 1 });
      native = true;
    } catch {}
  }
  if (!native) {
    const r2 = await embeddedEval(`(()=>{${find}el.click();return {ok:true}})()`);
    if (!r2.ok) throw new Error(r2.reason);
  }
  await new Promise(resolve=>setTimeout(resolve,250));
  return await embeddedPageInfo();
}
async function embeddedTypeInto(a) {
  await embeddedEnsureNoChallenge('type');
  const selector = String(a.selector || ''), value = String(a.text || ''), clear = !!a.clear, submit = !!a.submit;
  const result = await embeddedEval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return {ok:false,reason:'No element matches selector: '+${JSON.stringify(selector)}};el.scrollIntoView({block:'center',behavior:'instant'});el.focus();const v=${JSON.stringify(value)};if(el.isContentEditable){el.textContent=${clear?'v':'el.textContent+v'}}else{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)return {ok:false,reason:'Target is not a typeable input.'};setter.call(el,${clear?'v':'el.value+v'})}el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v}));el.dispatchEvent(new Event('change',{bubbles:true}));if(${submit}){el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));if(el.form)el.form.requestSubmit()}return {ok:true}})()`);
  if (!result.ok) throw new Error(result.reason);
  return await embeddedPageInfo();
}
async function embeddedScrollPage(a) {
  await embeddedEnsureNoChallenge('scroll');
  const dy = Number(a.pixels) || 0, to = String(a.to || ''), selector = String(a.selector || '');
  if (selector.length > 1000) throw new Error('Scroll selector is too long.');
  const result = await embeddedEval(`(()=>{const selector=${JSON.stringify(selector)};const target=selector?document.querySelector(selector):document.scrollingElement;if(selector&&!target)return {ok:false,error:'No scroll container matches selector: '+selector};const max=Math.max(0,(target.scrollHeight||document.documentElement.scrollHeight)-(target.clientHeight||innerHeight));if(${JSON.stringify(to)}==='top'){if(selector)target.scrollTo({top:0,behavior:'smooth'});else scrollTo({top:0,behavior:'smooth'});}else if(${JSON.stringify(to)}==='bottom'){if(selector)target.scrollTo({top:max,behavior:'smooth'});else scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'});}else if(selector)target.scrollBy({top:${dy},behavior:'smooth'});else scrollBy({top:${dy},behavior:'smooth'});return {ok:true,scrollTop:target.scrollTop||window.scrollY};})()`);
  if (result && result.ok === false) throw new Error(result.error || 'Scroll failed.');
  await new Promise(resolve=>setTimeout(resolve,180));
  return await embeddedPageInfo();
}
async function embeddedRunPageJS(code) {
  await embeddedEnsureNoChallenge('run JavaScript');
  const src = String(code || '');
  return await embeddedEval(`(async()=>{const source=${JSON.stringify(src)};try{return await (new Function('return ('+source+')')).call(window)}catch(parseError){return await (new Function(source)).call(window)}})()`);
}
function bShow(r) {
  if (!r || r.running === false) {
    if (browserRenderMode === 'chrome') { $('bImg').hidden = true; $('bEmpty').hidden = false; }
    if (!lastUrl) $('bInfo').textContent = '';
    return;
  }
  bLastPreviewInfo = { ...bLastPreviewInfo, ...r }; delete bLastPreviewInfo.image; delete bLastPreviewInfo.running;
  const meta = r.metadata || {}; const image = r.image;
  if (r.challenge) {
    $('bErr').dataset.securityHint = '1';
    $('bErr').textContent = 'Security verification required. Complete it manually in the CodeSpace Browser panel. CodeSpace does not bypass Cloudflare or CAPTCHA checks.';
    $('bStreamStatus').textContent = 'Verification required · complete it in this panel';
  } else if ($('bErr').dataset.securityHint === '1') {
    $('bErr').textContent = ''; delete $('bErr').dataset.securityHint;
  }
  if (image) { $('bImg').src = image; $('bImg').dataset.hasFrame = '1'; }
  bView = { vw: Number(r.vw || meta.deviceWidth || bView.vw || 1280), vh: Number(r.vh || meta.deviceHeight || bView.vh || 800) };
  if (r.url) { lastUrl = r.url; if ($('bAddr') && document.activeElement !== $('bAddr')) $('bAddr').value = r.url === 'about:blank' ? '' : r.url; if ($('bSecureIcon')) $('bSecureIcon').textContent = /^https:/.test(r.url) ? '🔒' : 'ⓘ'; }
  const title = r.title || bLastPreviewInfo.title || '';
  if (title) $('bTabTitle').textContent = title;
  $('bInfo').textContent = title + ((r.url || bLastPreviewInfo.url) ? ' · ' + (r.url || bLastPreviewInfo.url) : '');
  $('bEmpty').hidden = true; updateBrowserModeUI();
}
function setAgentChromeMode() { browserRenderMode = INTEGRATED_BROWSER ? 'embedded' : 'chrome'; updateBrowserModeUI(); }
async function startPreviewStream() {
  if (browserRenderMode !== 'chrome' || bStreamAbort || bStreamStarting || !B.ok || bp.hidden || activeTab !== 'preview') return;
  bStreamStarting = true; let ac = null;
  try {
    const r = await bApproved('/browser/stream/start', {}, undefined, 'Start live browser streaming (server permission)?', 'browser_stream');
    if (r && r.needsApproval) throw new Error(String(r.note || 'Browser streaming needs approval'));
    if (!B.ok || bp.hidden || activeTab !== 'preview' || browserRenderMode !== 'chrome') { await bcall('/browser/stream/stop').catch(() => {}); return; }
    ac = new AbortController(); bStreamAbort = ac; $('bStreamStatus').textContent = 'Agent Chrome: live stream connected';
    await consumeSSE('/preview/stream', ac.signal, frame => {
      if (frame && frame.type === 'frame' && frame.image && browserRenderMode === 'chrome') bShow({ ...bLastPreviewInfo, image: frame.image, running: true, metadata: frame.metadata || {} });
    });
    if (!ac.signal.aborted) throw new Error('Preview stream ended');
  } catch (e) {
    if (!(ac && ac.signal.aborted) && B.ok && !bp.hidden && activeTab === 'preview' && browserRenderMode === 'chrome') {
      $('bStreamStatus').textContent = 'Agent Chrome stream unavailable; using screenshot fallback';
      if (!bTimer) { bTimer = setInterval(bPoll, 2500); bPoll(); }
    }
  } finally {
    if (ac && bStreamAbort === ac) bStreamAbort = null; bStreamStarting = false;
    if (B.ok && !bp.hidden && activeTab === 'preview' && browserRenderMode === 'chrome' && !bStreamAbort && !bTimer) {
      if (ac && ac.signal.aborted) setTimeout(() => syncPoll(), 120); else { bTimer = setInterval(bPoll, 2500); bPoll(); }
    }
  }
}
async function bPoll() {
  if (browserRenderMode !== 'chrome' || bBusy || !B.ok || bp.hidden) return;
  bBusy = true; try { bShow(await bcall('/browser/screenshot', { ifRunning: true, quality: 50 })); } catch {} finally { bBusy = false; }
}
async function bAct(pathname, body) {
  if (DESKTOP_EMBED) { browserRenderMode = 'embedded'; updateBrowserModeUI(); $('bErr').textContent = 'The separate Agent Chrome process is disabled in CodeSpace Desktop. Use the Embedded Browser mode.'; return; }
  $('bErr').textContent = ''; delete $('bErr').dataset.securityHint; $('bInfo').textContent = 'Working…'; setAgentChromeMode();
  try {
    const r = await bApproved(pathname, { ...body, human: S.humanize, visible: S.browserVisible, persist: S.browserPersist }, undefined, 'Use the browser (server permission)?', 'browser_panel');
    if (r && r.needsApproval) { $('bErr').textContent = String(r.note || 'The browser action needs your approval.'); return; }
    if (r && r.failed) {
      $('bErr').textContent = r.error || 'The browser could not load this website.';
      $('bInfo').textContent = 'Navigation failed';
    } else if (r && (r.url || r.title)) bShow({ ...r, running: true });
    if (r && r.challenge) {
      $('bErr').dataset.securityHint = '1';
      $('bErr').textContent = 'Security verification required. Complete it manually in the CodeSpace Browser panel. CodeSpace does not bypass Cloudflare or CAPTCHA checks.';
      $('bStreamStatus').textContent = 'Verification required · complete it in this panel';
    }
  } catch (e) { $('bErr').textContent = e.message; }
  bPoll();
}
if ($('bGo')) {
  $('bGo').onclick = () => {
    const raw = $('bAddr')?.value?.trim(); if (!raw) return;
    if (browserRenderMode === 'proxy') { if (!navigateProxy(raw, true)) { setAgentChromeMode(); bAct('/browser/open', { url: raw }); } }
    else if (INTEGRATED_BROWSER || browserRenderMode === 'embedded') { navigateEmbedded(raw, true).then(ok=>{if(!ok&&!$('bErr')?.textContent)$('bErr').textContent='Enter a valid website address or search text.'}).catch(e=>$('bErr').textContent=e.message); }
    else if (browserRenderMode === 'live') { if (!navigateLive(raw, true)) { setAgentChromeMode(); bAct('/browser/open', { url: raw }); } }
    else bAct('/browser/open', { url: raw });
  };
}
if ($('bAddr')) {
  $('bAddr').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('bGo')?.click(); } });
}
if ($('bBack')) {
  $('bBack').onclick = () => {
    if (browserRenderMode === 'proxy') { if (liveHistoryIndex > 0) { liveHistoryIndex--; navigateProxy(liveHistory[liveHistoryIndex], false); } }
    else if (browserRenderMode === 'embedded') embeddedBack();
    else if (browserRenderMode === 'live') { if (liveHistoryIndex > 0) { liveHistoryIndex--; navigateLive(liveHistory[liveHistoryIndex], false); } }
    else bAct('/browser/nav', { action: 'back' });
  };
}
if ($('bForward')) {
  $('bForward').onclick = () => {
    if (browserRenderMode === 'proxy') { if (liveHistoryIndex >= 0 && liveHistoryIndex < liveHistory.length - 1) { liveHistoryIndex++; navigateProxy(liveHistory[liveHistoryIndex], false); } }
    else if (browserRenderMode === 'embedded') embeddedForward();
    else if (browserRenderMode === 'live') { if (liveHistoryIndex >= 0 && liveHistoryIndex < liveHistory.length - 1) { liveHistoryIndex++; navigateLive(liveHistory[liveHistoryIndex], false); } }
    else bAct('/browser/nav', { action: 'forward' });
  };
}
if ($('bReload')) {
  $('bReload').onclick = () => {
    if (browserRenderMode === 'proxy') { const f = $('bFrame'); if (f.src && f.src !== 'about:blank') { try { f.contentWindow.location.reload(); } catch { f.src = f.src; } } }
    else if (browserRenderMode === 'embedded') embeddedReload();
    else if (browserRenderMode === 'live') { const f = $('bFrame'); if (f.src && f.src !== 'about:blank') { try { f.contentWindow.location.reload(); } catch { f.src = f.src; } } }
    else bAct('/browser/nav', { action: 'reload' });
  };
}
if ($('bViewport')) {
  $('bViewport').onchange = async () => {
    applyLiveViewport(); if (browserRenderMode === 'live' || browserRenderMode === 'proxy') return;
    if (INTEGRATED_BROWSER && browserRenderMode === 'embedded') { syncIntegratedBrowserBounds(); return; }
    if (!B.ok) { $('bErr').textContent = 'Connect the bridge first.'; return; }
    const preset = $('bViewport').value;
    const body = preset === 'responsive' ? { reset: true } : preset === 'phone' ? { width: 390, height: 844, mobile: true } : preset === 'tablet' ? { width: 820, height: 1180, mobile: true } : { width: 1280, height: 800, mobile: false };
    try { const r = await bApproved('/browser/viewport', body, undefined, 'Change the browser viewport (server permission)?', 'browser_viewport'); if (r && r.needsApproval) { $('bErr').textContent = String(r.note || 'Needs approval'); return; } bShow({ ...bLastPreviewInfo, ...r, running: true }); } catch (e) { $('bErr').textContent = e.message; }
  };
}
if ($('bRenderMode')) {
  $('bRenderMode').onchange = () => {
    if ($('bRenderMode').value === 'proxy') {
      const url = $('bAddr')?.value?.trim() || lastUrl;
      if (url && !normalizeLiveUrl(url)) { $('bRenderMode').value = browserRenderMode; $('bErr').textContent = 'Workspace paths and file:// URLs cannot go through the proxy.'; return; }
      navigateProxy(url, false);
    }
    else if (INTEGRATED_BROWSER || $('bRenderMode').value === 'embedded') { const url=$('bAddr')?.value?.trim() || lastUrl; browserRenderMode='embedded'; updateBrowserModeUI(); if(url) navigateEmbedded(url).catch(e=>$('bErr').textContent=e.message); }
    else if ($('bRenderMode').value === 'live') {
      const url = normalizeLiveUrl($('bAddr')?.value || lastUrl);
      if (!url) { $('bRenderMode').value = 'chrome'; $('bErr').textContent = 'Workspace paths and file:// URLs need Agent Chrome mode.'; return; }
      navigateLive(url, false);
    } else {
      if (DESKTOP_EMBED) { browserRenderMode='embedded'; updateBrowserModeUI(); $('bErr').textContent='Separate Chrome is disabled in CodeSpace Desktop.'; return; }
      setAgentChromeMode(); const url = $('bAddr')?.value?.trim() || lastUrl;
      if (url && url !== 'about:blank' && normalizeLiveUrl(url)) bAct('/browser/open', { url });
    }
  };
}
function updateAuthHint(_url) { const h = $('bAuthHint'); if (h) h.hidden = true; }
async function openExternalPage() {
  const url = normalizeLiveUrl($('bAddr').value.trim() || lastUrl);
  if (!url) { $('bErr').textContent = 'Enter an http(s) URL first.'; return; }
  if (ANDROID_NATIVE_BROWSER) { $('bInfo').textContent = 'This page is already open in the CodeSpace Browser.'; return; }
  if (DESKTOP_EMBED) {
    /* Optional explicit handoff when the user chooses the system-browser button. */
    let opened = false;
    try { if (typeof window.myAgentDesktop.openExternal === 'function') opened = await window.myAgentDesktop.openExternal(url); } catch {}
    if (opened) { $('bErr').textContent = ''; $('bInfo').textContent = 'Opened in your system browser: ' + url; return; }
    try { await navigator.clipboard.writeText(url); $('bInfo').textContent = 'Could not open the system browser automatically — address copied: ' + url; }
    catch { $('bErr').textContent = 'Could not open the system browser or copy the address.'; }
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
if ($('bExternal')) $('bExternal').onclick = openExternalPage;
if ($('bAuthOpen')) $('bAuthOpen').onclick = openExternalPage;
if ($('bNewTab') && $('bAddr')) $('bNewTab').onclick = () => { $('bAddr').focus(); $('bAddr').select(); };
if ($('bTabClose')) {
  $('bTabClose').onclick = () => {
    liveFrameSerial++; $('bFrame').src = 'about:blank'; $('bImg').hidden = true; delete $('bImg').dataset.hasFrame;
    $('bEmpty').hidden = false; $('bInfo').textContent = ''; if ($('bTabTitle')) $('bTabTitle').textContent = 'New Tab'; if ($('bAddr')) $('bAddr').value = ''; lastUrl = '';
    liveHistory = []; liveHistoryIndex = -1;
    if (browserRenderMode === 'chrome' && B.ok) bcall('/browser/close').catch(() => {});
    if (ANDROID_NATIVE_BROWSER) {
      try { if (typeof window.CodeSpaceNative.browserClose === 'function') window.CodeSpaceNative.browserClose(); else window.CodeSpaceNative.browserClear(); } catch {}
    } else { try { window.myAgentDesktop.browser.clear(); } catch {} }
    updateAuthHint('');
    browserRenderMode = INTEGRATED_BROWSER ? 'embedded' : 'proxy'; updateBrowserModeUI();
  };
}
$('bFrame').addEventListener('load', () => {
  if (browserRenderMode === 'proxy') {
    if (!$('bFrame').src || $('bFrame').src === 'about:blank') return;
    // same-origin proxy: the real address is in the ?url= parameter — keep the bar, title and info in sync
    let real = '';
    try { const iu = new URL($('bFrame').contentWindow.location.href); real = iu.searchParams.get('url') || ''; } catch {}
    let title = '';
    try { title = ($('bFrame').contentDocument && $('bFrame').contentDocument.title) || ''; } catch {}
    if (real) { lastUrl = real; if ($('bAddr') && document.activeElement !== $('bAddr')) $('bAddr').value = real; if ($('bSecureIcon')) $('bSecureIcon').textContent = real.startsWith('https:') ? '🔒' : 'ⓘ'; updateAuthHint(real); }
    if (title && $('bTabTitle')) $('bTabTitle').textContent = title;
    $('bEmpty').hidden = true; $('bStreamStatus').textContent = 'Proxied page loaded · interactive';
    if (real) $('bInfo').textContent = (title ? title + ' · ' : '') + real;
    return;
  }
  if (browserRenderMode !== 'live' || !$('bFrame').src || $('bFrame').src === 'about:blank') return;
  $('bEmpty').hidden = true; $('bStreamStatus').textContent = 'Live webpage loaded · interactive';
  try { const title = $('bFrame').contentDocument && $('bFrame').contentDocument.title; if (title && $('bTabTitle')) $('bTabTitle').textContent = title; } catch {}
});
applyLiveViewport(); updateBrowserModeUI();
async function loadPreviewDiagnostics(mode = bDiagMode) {
  bDiagMode = mode; $('previewDiag').hidden = false; syncDiagButtons(); $('previewDiagContent').textContent = 'Loading ' + mode + '…';
  if (DESKTOP_EMBED && browserRenderMode === 'embedded') {
    const box = $('previewDiagContent');
    if (mode === 'network') {
      box.textContent = '';
      if (!EMB_NET.rows.length) { box.textContent = 'No network requests captured yet. Load or reload a page in the Browser panel.'; return; }
      EMB_NET.rows.slice().reverse().forEach(x => { const row = document.createElement('div'); row.className = 'diagrow'; row.textContent = netLine(x); box.appendChild(row); });
      return;
    }
    box.textContent = '';
    if (!EMB_CON.buf.length) { box.textContent = 'No console messages captured yet.'; return; }
    EMB_CON.buf.slice().reverse().forEach(x => { const row = document.createElement('div'); row.className = 'diagrow'; row.textContent = x.t; box.appendChild(row); });
    return;
  }
  if (!B.ok) { $('previewDiagContent').textContent = 'Connect the terminal bridge first.'; return; }
  try {
    const r = await bcall('/browser/diagnostics', {}), box = $('previewDiagContent'); box.textContent = '';
    if (mode === 'network') {
      const rows = r.requests || [];
      if (!rows.length) { box.textContent = 'No network requests captured yet.'; return; }
      rows.slice().reverse().forEach(x => { const row = document.createElement('div'); row.className = 'diagrow'; row.textContent = netLine({ method: x.method, url: x.url, status: x.status, err: x.error, ms: x.durationMs, type: x.type }); box.appendChild(row); });
    } else {
      const rows = r.console || [];
      if (!rows.length) { box.textContent = 'No console messages captured yet.'; return; }
      rows.slice().reverse().forEach(x => { const row = document.createElement('div'); row.className = 'diagrow'; row.textContent = typeof x === 'string' ? x : String(x.text || JSON.stringify(x)); box.appendChild(row); });
    }
  } catch (e) { $('previewDiagContent').textContent = 'Could not load diagnostics: ' + e.message; }
}
/* Console / Network buttons: the first click opens the panel, a second click on the same button minimises it. */
function syncDiagButtons() {
  const open = !$('previewDiag').hidden;
  [['bConsoleBtn', 'console'], ['bNetworkBtn', 'network']].forEach(([id, m]) => { const on = open && bDiagMode === m; $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', String(on)); $(id).title = on ? 'Click again to minimise' : 'Show ' + m; });
}
function toggleDiag(mode) {
  if (!$('previewDiag').hidden && bDiagMode === mode) { $('previewDiag').hidden = true; syncDiagButtons(); return; }
  loadPreviewDiagnostics(mode);
}
$('bConsoleBtn').onclick = () => toggleDiag('console');
$('bNetworkBtn').onclick = () => toggleDiag('network');
syncDiagButtons();
$('bDiagRefresh').onclick = () => loadPreviewDiagnostics(bDiagMode);
$('bImg').addEventListener('click', e => { if (browserRenderMode !== 'chrome') return; $('bview').focus(); const r = e.target.getBoundingClientRect(); bAct('/browser/click', { x: (e.clientX - r.left) / r.width * bView.vw, y: (e.clientY - r.top) / r.height * bView.vh }); });
let wAcc = 0, wT = null, wPos = { x: 10, y: 10 };
$('bImg').addEventListener('wheel', e => {
  if (browserRenderMode !== 'chrome') return; e.preventDefault(); const r = e.target.getBoundingClientRect();
  wPos = { x: (e.clientX - r.left) / r.width * bView.vw, y: (e.clientY - r.top) / r.height * bView.vh }; wAcc += e.deltaY;
  clearTimeout(wT);
  wT = setTimeout(async () => { const dy = wAcc; wAcc = 0; try { await bcall('/browser/scroll', { ...wPos, dy, human: false }); } catch {} bPoll(); }, 80);
}, { passive: false });

let keyChain = Promise.resolve(), keyT = null;
function sendKey(body) { keyChain = keyChain.then(() => bcall('/browser/key', body).catch(() => {})); clearTimeout(keyT); keyT = setTimeout(bPoll, 250); }
const SPECIAL = ['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
$('bview').addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || browserRenderMode !== 'chrome' || $('bImg').hidden) return;
  let body = null; if (e.key.length === 1) body = { text: e.key }; else if (SPECIAL.includes(e.key)) body = { key: e.key };
  if (!body) return; e.preventDefault(); sendKey(body);
});
$('bview').addEventListener('paste', e => { const t = e.clipboardData && e.clipboardData.getData('text'); if (t && browserRenderMode === 'chrome' && !$('bImg').hidden) { e.preventDefault(); sendKey({ insert: t }); } });

/* ================= explorer ================= */
