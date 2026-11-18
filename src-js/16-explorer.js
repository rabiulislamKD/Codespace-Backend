async function loadDir(p) {
  try {
    const items = (await fsList(p, false)).map(n => ({ name: n.replace(/\/$/, ''), dir: n.endsWith('/') }));
    items.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
    exp.cache.set(p, items); exp.errors.delete(p);
  } catch (e) {
    exp.cache.set(p, []); exp.errors.set(p, (e && e.message) ? e.message : String(e));
  }
}
function workspaceLabel(root) {
  if (!root) return 'Explorer';
  if (root === '/storage/emulated/0') return 'Internal storage';
  if (root.startsWith('saf://')) return 'Selected folder';
  const parts = String(root).split(/[\\/]/).filter(Boolean);
  return parts.pop() || root;
}
function drawTree() {
  const box = $('tree'); box.innerHTML = '';
  if (!B.ok && !dirHandle) { box.innerHTML = '<div class="emptytree">Connect the terminal bridge in Settings, or open a folder with your browser (Chrome or Edge).<br><button id="emptyOpen" class="btn primary" type="button">Open folder</button></div>'; $('emptyOpen').onclick = () => openFolder(); $('expTitle').textContent = 'Explorer'; return; }
  if (B.ok && (!B.info || !B.info.root)) { box.innerHTML = '<div class="emptytree">No folder is open.<br>Open the folder you want the agent to work in.<br><button id="emptyOpen" class="btn primary" type="button">Open folder</button></div>'; $('emptyOpen').onclick = () => openFolder(); $('expTitle').textContent = 'Explorer'; return; }
  $('expTitle').textContent = B.ok ? workspaceLabel(B.info.root) : dirHandle.name;
  $('expTitle').title = B.ok && B.info ? B.info.root : (dirHandle ? dirHandle.name : '');
  const err = exp.errors.get('');
  if (err) {
    const d = document.createElement('div'); d.className = 'emptytree';
    d.innerHTML = '<b>Could not list this folder.</b><br>' + esc(err) +
      '<br><br>If you picked device storage, allow <b>All files access</b> for CodeSpace in Android Settings, then reopen the folder.' +
      '<br><button id="treeRetry" class="btn primary" type="button">Retry</button> <button id="treeReopen" class="btn" type="button">Open folder…</button>';
    box.appendChild(d);
    const retry = d.querySelector('#treeRetry'); if (retry) retry.onclick = () => refreshExplorer();
    const re = d.querySelector('#treeReopen'); if (re) re.onclick = () => openFolder();
    return;
  }
  const build = (dirPath, depth) => {
    for (const it of exp.cache.get(dirPath) || []) {
      const full = dirPath ? dirPath + '/' + it.name : it.name;
      const row = document.createElement('div');
      row.className = 'trow' + (!it.dir && activeTab === 'f:' + full ? ' sel' : '');
      row.style.paddingLeft = (10 + depth * 12) + 'px'; row.setAttribute('role', 'treeitem'); row.tabIndex = 0; row.title = full;
      row.textContent = (it.dir ? (exp.open.has(full) ? '▾ ' : '▸ ') : '\u00a0\u00a0') + it.name;
      row.draggable = true; row.dataset.path = full; row.dataset.dir = it.dir ? '1' : '';   // 3.13.5: right-click menu + drag & drop
      const gs = gitMark(full); if (gs) { const gsp = document.createElement('span'); gsp.className = 'gst'; gsp.dataset.g = gs; gsp.textContent = gs; row.appendChild(gsp); }
      const act = async () => { if (it.dir) { if (exp.open.has(full)) exp.open.delete(full); else { exp.open.add(full); await loadDir(full); } drawTree(); } else openFile(full); };
      row.onclick = act; row.onkeydown = e => { if (e.key === 'Enter') act(); };
      box.appendChild(row);
      if (it.dir && exp.open.has(full)) build(full, depth + 1);
    }
  };
  build('', 0);
  // A successful listing that contains nothing must still say something: otherwise
  // an empty (or silently filtered) device folder looks like the explorer is broken.
  if (!(exp.cache.get('') || []).length) {
    const d = document.createElement('div'); d.className = 'emptytree';
    d.innerHTML = '<b>This folder is empty.</b><br>' + esc(B.ok && B.info ? B.info.root : (dirHandle ? dirHandle.name : '')) +
      '<br><br>If the folder does contain files, Android may be hiding them. Allow <b>All files access</b> for CodeSpace in Settings, then reopen the folder.' +
      '<br><button id="treeRetry" class="btn primary" type="button">Retry</button> <button id="treeReopen2" class="btn" type="button">Open folder…</button>';
    box.appendChild(d);
    const retry = d.querySelector('#treeRetry'); if (retry) retry.onclick = () => refreshExplorer();
    const re = d.querySelector('#treeReopen2'); if (re) re.onclick = () => openFolder();
  }
}
/* The sidebar starts collapsed on phones and the activity bar is hidden there, so
   picking a folder must also reveal the Explorer or the freshly loaded tree stays invisible. */
function revealExplorer() {
  try {
    const app = $('app');
    if (!app) return;
    if (curView !== 'explorer' || app.classList.contains('nosidebar')) showView('explorer');
  } catch {}
}
async function refreshExplorer() {
  if ((!B.ok && !dirHandle) || (B.ok && (!B.info || !B.info.root))) { drawTree(); return; }
  await Promise.all([...exp.open].map(loadDir)); drawTree();
}
$('expRefresh').onclick = refreshExplorer;
$('expOpen').onclick = () => openFolder();

/* ============ 3.13.5: right-click menu + drag & drop in the explorer ============ */
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctxmenu'; ctxMenu.hidden = true; ctxMenu.setAttribute('role', 'menu');
document.body.appendChild(ctxMenu);
function ctxClose() { ctxMenu.hidden = true; }
document.addEventListener('click', ctxClose);
document.addEventListener('keydown', e => { if (e.key === 'Escape') ctxClose(); });
window.addEventListener('blur', ctxClose);
window.addEventListener('scroll', ctxClose, true);
function ctxItem(label, fn, cls) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ctxitem' + (cls ? ' ' + cls : ''); b.setAttribute('role', 'menuitem'); b.textContent = label; b.onclick = e => { e.stopPropagation(); ctxClose(); try { fn(); } catch (err) { addErr(err.message); } }; ctxMenu.appendChild(b); }
function ctxSep() { const s = document.createElement('div'); s.className = 'ctxsep'; ctxMenu.appendChild(s); }
/* 3.13.6: one-line input dialog. window.prompt() is not supported in Electron (it throws
   "prompt() is and will not be supported"), so rename and new-file/folder use this small
   modal instead — it behaves the same in the desktop app and in the browser. */
function ctxAsk(title, value, secret = false) {
  return new Promise(res => {
    const d = $('ctxDlg'), inp = $('ctxDlgInput'), oldType = inp.type;
    $('ctxDlgTitle').textContent = title; $('ctxDlgMsg').textContent = ''; inp.value = value || ''; inp.type = secret ? 'password' : oldType; inp.autocomplete = secret ? 'off' : 'on';
    const onClose = () => {
      const answer = d.returnValue === 'ok' ? inp.value : null;
      if (secret) inp.value = '';
      inp.type = oldType; inp.autocomplete = 'on';
      d.removeEventListener('close', onClose); inp.removeEventListener('keydown', onKey); res(answer);
    };
    const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); d.returnValue = 'ok'; d.close(); } };
    $('ctxDlgOk').onclick = () => { d.returnValue = 'ok'; d.close(); };
    $('ctxDlgCancel').onclick = () => { d.returnValue = ''; d.close(); };
    inp.addEventListener('keydown', onKey);
    d.addEventListener('close', onClose);
    d.returnValue = '';
    d.showModal();
    inp.focus(); inp.select();
  });
}
/* Workspace mutations go through the same approval flow the agent uses: the server answers
   needsApproval for ask-permissions and the UI shows the approve dialog (bApproved). */
async function fsMutate(ep, body, what) {
  let r;
  try { r = await bApproved(ep, body, undefined, what, 'fsui_' + ep.replace(/\W+/g, '_')); }
  catch (e) { addErr(e.message); return false; }
  // 3.13.6: denied or failed mutations used to disappear silently. bApproved answers with
  // {text, st:'err'} when the user says no, and the endpoints answer {error} on failure.
  if (r && (r.denied || r.st === 'err')) { addErr(r.text || r.note || 'That change was not approved.'); return false; }
  if (r && r.error) { addErr(String(r.error)); return false; }
  refreshExplorer();
  return true;
}
const ctxValidName = n => !!n && !/[\\/]/.test(n) && n !== '.' && n !== '..';
function ctxJoin(dir, name) { return dir ? dir + '/' + name : name; }
async function ctxRename(full, isDir) {
  const name = full.split('/').pop();
  const nn = await ctxAsk(isDir ? 'Rename folder' : 'Rename file', name);
  if (nn == null) return;
  const clean = nn.trim();
  if (!clean || clean === name) return;
  if (!ctxValidName(clean)) { $('ctxDlgMsg').textContent = 'Names cannot contain slashes or be "." / "..".'; return; }
  const to = full.includes('/') ? full.slice(0, full.lastIndexOf('/') + 1) + clean : clean;
  fsMutate('/fs/rename', { path: full, to }, 'Rename "' + name + '" to "' + clean + '"?');
}
async function ctxNewFile(dir) {
  const n = await ctxAsk('New file name' + (dir ? ' (inside ' + dir + ')' : ''), '');
  if (n == null) return;
  const clean = n.trim();
  if (!clean) return;
  if (!ctxValidName(clean)) { $('ctxDlgMsg').textContent = 'Names cannot contain slashes or be "." / "..".'; return; }
  fsMutate('/fs/write', { path: ctxJoin(dir, clean), content: '' }, 'Create file "' + clean + '"?');
}
async function ctxNewFolder(dir) {
  const n = await ctxAsk('New folder name' + (dir ? ' (inside ' + dir + ')' : ''), '');
  if (n == null) return;
  const clean = n.trim();
  if (!clean) return;
  if (!ctxValidName(clean)) { $('ctxDlgMsg').textContent = 'Names cannot contain slashes or be "." / "..".'; return; }
  fsMutate('/fs/mkdir', { path: ctxJoin(dir, clean) }, 'Create folder "' + clean + '"?');
}
$('tree').addEventListener('contextmenu', e => {
  const row = e.target.closest ? e.target.closest('.trow') : null;
  e.preventDefault();
  ctxMenu.innerHTML = '';
  const base = row ? row.dataset.path : '';
  const isDir = row ? row.dataset.dir === '1' : false;
  if (row) {
    if (isDir) ctxItem(exp.open.has(base) ? 'Collapse' : 'Expand', () => { ctxClose(); row.click(); });
    else ctxItem('Open', () => { ctxClose(); row.click(); });
    if (!isDir) ctxItem('Attach to chat', () => { if (!pendingFilePaths.includes(base)) pendingFilePaths.push(base); renderAttachTray(); $('input').focus(); });
    ctxItem('Copy path', () => { try { navigator.clipboard.writeText(base).catch(() => {}); } catch {} });
    ctxSep();
    ctxItem('Rename…', () => ctxRename(base, isDir));
    ctxItem('Delete', () => {
      if (!confirm('Delete "' + base + (isDir ? '" and everything inside it' : '') + '? This cannot be undone.')) return;
      fsMutate('/fs/delete', { path: base, recursive: isDir }, 'Delete ' + (isDir ? 'folder' : 'file') + ' "' + base + '"?');
    }, 'danger');
    if (isDir) { ctxSep(); ctxItem('New file…', () => ctxNewFile(base)); ctxItem('New folder…', () => ctxNewFolder(base)); }
  } else {
    ctxItem('New file…', () => ctxNewFile(''));
    ctxItem('New folder…', () => ctxNewFolder(''));
    ctxSep();
    ctxItem('Refresh', () => { ctxClose(); refreshExplorer(); });
  }
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth || 190, mh = ctxMenu.offsetHeight || 220;
  ctxMenu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - mw - 8)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - mh - 8)) + 'px';
});
/* Drag a file/folder out of the tree: onto the chat composer it becomes an attachment; onto a
   folder row it moves (rename). External files dropped into the tree are ignored on purpose —
   uploading into the workspace goes through the composer's file flow. */
$('tree').addEventListener('dragstart', e => {
  const row = e.target.closest ? e.target.closest('.trow') : null;
  if (!row || !row.dataset.path) return;
  e.dataTransfer.setData('text/plain', row.dataset.path);
  try { e.dataTransfer.setData('application/x-codespace-path', row.dataset.path); } catch {}
  e.dataTransfer.effectAllowed = 'copyMove';
  row.classList.add('dragging');
});
$('tree').addEventListener('dragend', e => { const row = e.target.closest ? e.target.closest('.trow') : null; if (row) row.classList.remove('dragging'); ctxClose(); });
$('tree').addEventListener('dragover', e => {
  const row = e.target.closest ? e.target.closest('.trow') : null;
  const types = e.dataTransfer && e.dataTransfer.types;
  const hasFiles = types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  const hasInternal = types && Array.prototype.indexOf.call(types, 'application/x-codespace-path') >= 0;
  if (hasFiles) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (row) row.classList.add('droptarget'); return; }
  if (!row || row.dataset.dir !== '1') return;
  if (hasInternal) {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    row.classList.add('droptarget');
  }
});
$('tree').addEventListener('dragleave', e => { const row = e.target.closest ? e.target.closest('.trow') : null; if (row) row.classList.remove('droptarget'); });
/* Files dragged in from outside CodeSpace (Explorer / Finder / the desktop) are copied into
   the workspace folder they are dropped on; rows dragged inside CodeSpace move (rename). */
$('tree').addEventListener('drop', e => {
  const row = e.target.closest ? e.target.closest('.trow') : null;
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  let src = '';
  try { src = e.dataTransfer.getData('application/x-codespace-path'); } catch {}
  if (!files.length && !src) return;
  e.preventDefault();
  if (row) row.classList.remove('droptarget');
  if (files.length) {
    // a drop on a file row uploads next to it; on a folder row (or the empty tree) it lands there
    const dir = row ? (row.dataset.dir === '1' ? row.dataset.path : (row.dataset.path.includes('/') ? row.dataset.path.slice(0, row.dataset.path.lastIndexOf('/')) : '')) : '';
    uploadDropped(files, dir);
    return;
  }
  if (!row || row.dataset.dir !== '1') return;
  const dir = row.dataset.path;
  if (src === dir || dir.startsWith(src + '/')) { addErr('A folder cannot be moved into itself.'); return; }
  const to = ctxJoin(dir, src.split('/').pop());
  fsMutate('/fs/rename', { path: src, to }, 'Move "' + src + '" into "' + dir + '"?');
});
/* 3.13.6: dropping real files from outside CodeSpace copies them into the workspace. Binary
   files travel as base64 so images/archives survive; text files are written as text. The
   server enforces the same 5 MB per-file limit as every other write. */
const BINARY_HINT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|apk|aab|aar|dex|odex|vdex|exe|dll|so|dylib|msi|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|mov|avi|mkv|webm|sqlite|db|jar|class|wasm|bin)$/i;
async function uploadOne(file, dir) {
  if (file.size > 8 * 1024 * 1024) { addErr('"' + file.name + '" is larger than the 8 MB Android upload limit.'); return false; }
  const p = ctxJoin(dir, file.name);
  const buf = new Uint8Array(await file.arrayBuffer());
  let body;
  if (BINARY_HINT.test(file.name)) {
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    body = { path: p, b64: btoa(bin) };
  } else {
    body = { path: p, content: new TextDecoder().decode(buf) };
  }
  return fsMutate('/fs/write', body, 'Add dropped file "' + (dir ? dir + '/' : '') + file.name + '" to the workspace?');
}
async function uploadDropped(files, dir) {
  let ok = 0;
  for (const f of files) { try { if (await uploadOne(f, dir)) ok++; } catch (e) { addErr(f.name + ': ' + e.message); } }
  if (ok) updateMeters();
}
async function browserPickFolder() {
  if (!window.showDirectoryPicker) { addErr('Opening a folder with the browser needs Chrome or Edge on a computer. Or connect the terminal bridge in Settings, which lets you pick any folder.'); return; }
  try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); exp.open = new Set(['']); exp.cache.clear(); refreshExplorer(); updateMeters(); } catch {}
}
const fp = { path: '', parent: null, sep: '/' };
function fpJoin(base, name) { return base.endsWith(fp.sep) ? base + name : base + fp.sep + name; }
async function fpLoad(path) {
  $('fpMsg').textContent = '';
  try {
    const r = await bcall('/workspace/dirs', { path });
    fp.path = r.path; fp.parent = r.parent; fp.sep = r.sep || '/'; $('fpPath').value = r.path; $('fpUp').disabled = !r.parent;
    const pl = $('fpPlaces'); pl.innerHTML = '';
    r.places.forEach(x => pl.appendChild(mkBtn(x.name, '', () => fpLoad(x.path))));
    (r.recent || []).slice(0, 4).forEach(x => { const b = mkBtn('↺ ' + x.split(/[\\/]/).filter(Boolean).pop(), '', () => fpLoad(x)); b.title = x; pl.appendChild(b); });
    const list = $('fpList'); list.innerHTML = '';
    if (!r.dirs.length) list.innerHTML = '<div class="tnote">No folders in here. You can still open this one.</div>';
    r.dirs.forEach(name => { const row = document.createElement('div'); row.className = 'trow'; row.tabIndex = 0; row.textContent = '▸ ' + name; const go = () => fpLoad(fpJoin(r.path, name)); row.onclick = go; row.onkeydown = e => { if (e.key === 'Enter') go(); }; list.appendChild(row); });
    if (r.truncated) { const n = document.createElement('div'); n.className = 'tnote'; n.textContent = 'Only the first 500 folders are shown. Type a path above to go deeper.'; list.appendChild(n); }
  } catch (e) { $('fpMsg').textContent = e.message; }
}
function openFolderPicker() { $('fpClose').hidden = !(B.info && B.info.root); $('fpDlg').showModal(); fpLoad((B.info && B.info.root) || ''); }
function onFolderChanged() {
  tabs.filter(t => t.type !== 'preview').map(t => t.id).forEach(id => closeTab(id, true)); // their paths belong to the old folder
  exp.open = new Set(['']); exp.cache.clear(); if (exp.errors) exp.errors.clear(); const refreshed = refreshExplorer(); updateMeters(); gitRefresh();
  revealExplorer();
  if (curView === 'checkpoints') refreshCheckpoints();
  if (curView === 'codebase') refreshCodeIndexStatus();
  $('sbBridge').textContent = bridgeLabel();
  if (B.ok) refreshSkills().then(renderSkills).catch(() => {});
  return refreshed.then(() => {
    try {
      const root = B.ok && B.info ? B.info.root : (dirHandle ? dirHandle.name : '');
      const err = exp.errors ? (exp.errors.get('') || '') : '';
      if (typeof bcall === 'function') bcall('/diag/log', { msg: 'explorer root=' + root + ' entries=' + (exp.cache.get('') || []).length + (err ? ' err=' + err : '') }).catch(() => {});
    } catch {}
  });
}
$('fpUp').onclick = () => { if (fp.parent) fpLoad(fp.parent); };
$('fpGo').onclick = () => fpLoad($('fpPath').value.trim());
$('fpPath').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('fpGo').click(); } });
$('fpCancel').onclick = () => $('fpDlg').close();
async function changeFolder(call) {
  if (tabs.some(t => t.dirty) && !confirm('Discard the unsaved changes in open files?')) return;
  try { B.info = await bcall(call.path, call.body); $('fpDlg').close(); onFolderChanged(); } catch (e) { $('fpMsg').textContent = e.message; }
}
$('fpSelect').onclick = () => changeFolder({ path: '/workspace/set', body: { path: fp.path } });
$('fpClose').onclick = () => changeFolder({ path: '/workspace/close', body: {} });
/* 3.18.3: single "Open Folder" entry point (File > Open Folder…, the Explorer's empty state and the
   command palette all call openFolder()). The old Explorer-header button is gone. It uses the operating
   system's own folder dialog: the desktop app answers through Electron's dialog, the local bridge offers
   the platform picker (PowerShell / AppleScript / zenity), the in-app dialog stays only as a last resort
   when no native picker exists, and without the bridge the browser's own directory picker is used.
   Cancelling the native dialog stays silent on purpose. */
let openFolderBusy = false;
async function openFolder() {
  if (openFolderBusy) return;           // a dialog is already open: never stack a second one
  openFolderBusy = true;
  let nativePending = false;
  try {
    // Android app: use the built-in device-storage browser (no system DocumentsUI).
    if (window.CodeSpaceNative && typeof window.CodeSpaceNative.pickWorkspaceFolder === 'function') {
      try { window.CodeSpaceNative.pickWorkspaceFolder(); nativePending = true; } catch { nativePending = false; }
      if (nativePending) return;        // the native picker reports back through codespace-native-workspace-picked
    }
    if (!B.ok) return await browserPickFolder();
    let picked = null, note = '';
    if (window.myAgentDesktop && typeof window.myAgentDesktop.pickFolder === 'function') {
      try { picked = await window.myAgentDesktop.pickFolder(); } catch { picked = null; }
      if (picked == null) return;   // user cancelled the OS dialog — do nothing
    } else {
      try { const r = await bcall('/workspace/native-pick', {}); if (r && r.path) picked = r.path; else if (r && r.note) note = String(r.note); } catch (e) { note = e.message; }
      if (!picked) {
        if (note) { addErr(note); openFolderPicker(); }   // no native picker on this machine → the in-app dialog
        return;                                           // otherwise the user cancelled — respect that
      }
    }
    return await changeFolder({ path: '/workspace/set', body: { path: picked } });
  } finally { if (!nativePending) openFolderBusy = false; }
}

/* The Android shell asks for a folder with its own storage browser and announces the result here. */
window.addEventListener('codespace-native-workspace-picked', async ev => {
  openFolderBusy = false;
  let d = {};
  try { d = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : (ev.detail || {}); } catch { d = {}; }
  if (d.cancelled) return;
  if (!d.ok) { if (d.error) addErr(String(d.error)); return; }
  if (tabs.some(t => t.dirty) && !confirm('Discard the unsaved changes in open files?')) return;
  try {
    B.info = await bcall('/info');
    if (!B.info || !B.info.root) throw new Error('The app did not report an open workspace.');
  } catch (e) {
    addErr('Could not refresh the workspace: ' + (e && e.message ? e.message : e));
  }
  exp.open = new Set(['']); exp.cache.clear(); exp.errors.clear();
  onFolderChanged();
  const label = d.name || workspaceLabel(d.path);
  addNote('Folder opened: ' + label + (B.info && B.info.root ? ' (' + B.info.root + ')' : ''));
});

/* ================= terminal ================= */
