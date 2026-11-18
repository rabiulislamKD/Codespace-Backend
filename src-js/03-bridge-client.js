// Async native-bridge callback dispatcher. The native side runs localApiCallAsync on a
// background executor and invokes window.__csNativeCb(id, replyJson) when it finishes.
// This keeps the WebView JS thread free while a tool runs, which is essential because
// browser tools inject JS via evaluateJavascript on that same thread. A synchronous
// @JavascriptInterface call would block the JS thread and deadlock those tools.
if (typeof window !== 'undefined' && !window.__csNativeCb) {
  window.__csNativePending = {};
  window.__csNativeCb = function (id, replyJson) {
    const entry = window.__csNativePending[id];
    if (!entry) return;
    delete window.__csNativePending[id];
    if (entry.timer) clearTimeout(entry.timer);
    let reply;
    try { reply = JSON.parse(replyJson); }
    catch (e) { entry.reject(new Error('Android Local API parse failed: ' + String(e.message || e))); return; }
    entry.resolve(reply);
  };
}

// Call the Android native workspace adapter (async, non-blocking). Shared by Local mode
// and by file/workspace operations in remote modes so the picked folder is visible everywhere.
async function csNativeCall(pathname, body, signal) {
  if (signal && signal.aborted) throw new Error('Request cancelled');
  if (!window.CodeSpaceNative || typeof window.CodeSpaceNative.localApiCall !== 'function') {
    throw new Error('The Android Local Agent adapter is unavailable.');
  }
  // Keep native file-approval behavior in sync with the UI permission mode.
  try { if (typeof window.CodeSpaceNative.setPermissionMode === 'function') window.CodeSpaceNative.setPermissionMode((typeof S !== 'undefined' && S.permMode) || 'smart'); } catch {}
  const payload = JSON.stringify(body || {});
  if (typeof window.CodeSpaceNative.localApiCallAsync === 'function') {
    const reply = await new Promise((resolve, reject) => {
      window.__csNativeSeq = (window.__csNativeSeq || 0) + 1;
      const id = 'cs' + window.__csNativeSeq;
      const entry = { resolve, reject, timer: null };
      window.__csNativePending[id] = entry;
      entry.timer = setTimeout(() => {
        if (window.__csNativePending[id]) { delete window.__csNativePending[id]; reject(new Error('Android Local API timed out')); }
      }, 180000);
      if (signal) {
        const onAbort = () => {
          if (window.__csNativePending[id]) { delete window.__csNativePending[id]; if (entry.timer) clearTimeout(entry.timer); reject(new Error('Request cancelled')); }
        };
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
      window.CodeSpaceNative.localApiCallAsync(pathname, payload, id);
    });
    if (!reply || reply.status < 200 || reply.status >= 300) throw new Error((reply && reply.error) || 'Local API error');
    return reply.data || {};
  }
  // Fallback for older app builds without the async bridge.
  let reply;
  try { reply = JSON.parse(window.CodeSpaceNative.localApiCall(pathname, payload)); }
  catch (e) { throw new Error('Android Local API failed: ' + String(e.message || e)); }
  if (!reply || reply.status < 200 || reply.status >= 300) throw new Error((reply && reply.error) || 'Local API error');
  return reply.data || {};
}

// File/workspace endpoints that must always operate on the folder the user picked,
// regardless of which sandbox (Local / Free server / GitHub) is selected.
const CS_LOCAL_FILE_EP = /^\/(info|workspace\/(dirs|state|active)|fs\/(list|read|write|create|mkdir|rename|delete|search|stat|metadata|stream|history|undo|redo))$/;
// OpenCode CLI is a device-local runtime on Android: its status/keys/models/workspace/run must
// NEVER be sent to the remote Render/Codespace server (which has no Android folder and no
// /opencode/keys/* endpoints -> "Unknown endpoint"). All of these are served by the native bridge.
const CS_ANDROID_NATIVE_EP = /^\/opencode\//;
// v43: OpenCode CLI EXECUTION endpoints. When the active workspace is a folder on the Android
// device these MUST run through the native adapter — the remote agent-server has no Android folder
// and rejects the run with "Open a workspace folder in My Chat Agent first." A genuine remote or
// desktop workspace (no Android folder selected) still uses the remote /opencode/run.
// (/opencode/workspace/sync-in|sync-out and the key/status/model endpoints are already covered by
//  the always-native metadata rule below.)
const CS_OPENCODE_RUN_EP = /^\/opencode\/(run|run\/read|run\/cancel)$/;
// True when a folder on the Android device is the active workspace. Prefers the canonical native
// signal (isAndroidFolderWorkspace) and falls back to the direct native hasLocalWorkspace() probe.
function csAndroidWorkspaceActive() {
  try {
    if (typeof isAndroidFolderWorkspace === 'function' && isAndroidFolderWorkspace()) return true;
  } catch {}
  try {
    if (window.CodeSpaceNative && typeof window.CodeSpaceNative.hasLocalWorkspace === 'function' &&
        window.CodeSpaceNative.hasLocalWorkspace()) return true;
  } catch {}
  return false;
}

async function bcall(pathname, body, signal) {
  // Android Local mode uses the app-private native workspace adapter; it never falls back
  // to the Render service. Only explicitly implemented endpoints are available locally.
  if (L.bridgeUrl === 'codespace-native://local') {
    return await csNativeCall(pathname, body, signal);
  }

  // OpenCode CLI key management (list/add/select/remove/rotate/auth/models/status) is always
  // device-local on Android — the remote server has none of these endpoints. A remote OpenCode
  // run is only meaningful with a genuine remote workspace; key management stays on the device.
  const opencodeMeta = /^\/opencode\/(keys|auth|models|status|install|workspace)/.test(pathname);
  if (opencodeMeta && window.CodeSpaceNative &&
      typeof window.CodeSpaceNative.localApiCall === 'function') {
    return await csNativeCall(pathname, body, signal);
  }

  // v43: OpenCode EXECUTION for an Android folder runs on the device, never on the remote server.
  if (CS_OPENCODE_RUN_EP.test(pathname) && window.CodeSpaceNative &&
      typeof window.CodeSpaceNative.localApiCall === 'function' && csAndroidWorkspaceActive()) {
    return await csNativeCall(pathname, body, signal);
  }

  // Unified folder access: in remote modes, file/workspace operations still target the
  // folder the user picked on the Android device when one is selected.
  if (CS_LOCAL_FILE_EP.test(pathname) && window.CodeSpaceNative &&
      typeof window.CodeSpaceNative.hasLocalWorkspace === 'function' &&
      window.CodeSpaceNative.hasLocalWorkspace()) {
    return await csNativeCall(pathname, body, signal);
  }

  // UWB WebSocket mode: bridgeUrl is a ws:// or wss:// URL
  if (L.bridgeUrl.startsWith('ws://') || L.bridgeUrl.startsWith('wss://')) {
    return await uwbCall(pathname, body, signal);
  }

  // 3.10: hard default timeout (11 min — above the bridge's 10 min command cap) so a hung
  // bridge request can never stall the agent loop forever. Caller signals still win.
  let sig = signal;
  if (typeof AbortSignal !== 'undefined' && AbortSignal.any && AbortSignal.timeout) {
    const t = AbortSignal.timeout(660000);
    sig = signal ? AbortSignal.any([signal, t]) : t;
  }
  const r = await fetch(L.bridgeUrl.replace(/\/+$/, '') + pathname, {
    method: 'POST', signal: sig, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + L.bridgeToken }, body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({ error: 'Bad response from the bridge' }));
  if (!r.ok) throw new Error(data.error || 'Bridge error ' + r.status);
  return data;
}

// UWB WebSocket bridge call
let uwbConnector = null;
let uwbConnectPromise = null;

async function uwbCall(pathname, body, signal) {
  // Initialize connector if needed
  if (!uwbConnector) {
    uwbConnector = window.UWBConnector || (await import('./uwb-connector.js')).default;
  }

  // Connect if not connected
  if (!uwbConnector.isConnected()) {
    if (!uwbConnectPromise) {
      uwbConnectPromise = (async () => {
        try {
          const wsUrl = L.bridgeUrl.replace(/\/+$/, '');
          const token = L.bridgeToken;
          await uwbConnector.connect(wsUrl, token);
          // Map UWB methods to bridge endpoints
          uwbConnector.onMessage((method, params) => {
            // Handle notifications (file_changed, etc.)
            console.log('UWB notification:', method, params);
          });
        } catch (e) {
          uwbConnectPromise = null;
          throw e;
        }
      })();
    }
    await uwbConnectPromise;
  }

  // Map bridge pathname to UWB method
  const methodMap = {
    '/fs/list': 'listFiles',
    '/fs/read': 'readFile',
    '/fs/write': 'writeFile',
    '/fs/create': 'createFile',
    '/fs/mkdir': 'createDirectory',
    '/fs/rename': 'renameFile',
    '/fs/delete': 'deleteFile',
    '/fs/search': 'searchFiles',
    '/fs/metadata': 'getFileMetadata',
    '/fs/stat': 'getFileMetadata',
    '/fs/stream': 'streamFile',
    '/info': 'getBridgeInfo',
    '/workspace/dirs': 'listFiles', // Special handling needed
  };

  const uwbMethod = methodMap[pathname];
  if (!uwbMethod) {
    throw new Error('UWB: Unsupported endpoint ' + pathname);
  }

  // Convert body to UWB params
  const params = { ...(body || {}) };

  // Handle abort signal
  if (signal) {
    const abortPromise = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request cancelled')));
    });
    return Promise.race([uwbConnector.call(uwbMethod, params), abortPromise]);
  }

  return uwbConnector.call(uwbMethod, params);
}
/* ---- 3.10: background task bar + completion watch ---- */
const taskWatch = { timer: null, lastStatus: new Map() };
function taskWatchStart() {
  const el = $('taskBar'); if (el) el.hidden = false;
  if (!taskWatch.timer) taskWatch.timer = setInterval(taskWatchTick, 4000);
  taskWatchTick();
}
function taskWatchStop() { if (taskWatch.timer) { clearInterval(taskWatch.timer); taskWatch.timer = null; } }
async function taskWatchTick() {
  if (!B.ok) { taskWatchStop(); const el = $('taskBar'); if (el) { el.hidden = true; el.innerHTML = ''; } return; }
  let data;
  try { data = await bcall('/task/list', {}); } catch { return; }
  renderTaskBar(data);
  const rows = (data.tasks || []).slice(0, 6);
  for (const t of rows) {
    const prev = taskWatch.lastStatus.get(t.id);
    if (prev && prev !== t.status) {
      if (t.status === 'done') feedPush('Task completed: ' + (t.label || t.id), { force: true });
      else if (t.status === 'error') feedPush('Task failed: ' + (t.label || t.id) + ' — ' + (t.error || 'see task_list'), { force: true });
      else if (t.status === 'cancelled') feedPush('Task cancelled: ' + (t.label || t.id), { force: true });
    }
    taskWatch.lastStatus.set(t.id, t.status);
  }
  if (!rows.some(t => t.status === 'running' || t.status === 'pending')) taskWatchStop();
}
function renderTaskBar(data) {
  const el = $('taskBar'); if (!el) return;
  const rows = (data.tasks || []).slice(0, 6);
  el.hidden = !rows.length;
  if (!rows.length) return;
  el.innerHTML = '';
  for (const t of rows) {
    const row = document.createElement('div'); row.className = 'taskrow'; row.dataset.status = t.status;
    const dot = document.createElement('span'); dot.className = 'taskdot'; dot.title = 'Status: ' + t.status;
    const label = document.createElement('span'); label.className = 'tasklabel'; label.textContent = t.label || t.kind; label.title = t.id + ' · ' + t.status + (t.error ? ' · ' + t.error : '');
    const st = document.createElement('span'); st.className = 'taskstatus'; st.textContent = t.status === 'running' ? ((t.progress && t.progress.message) ? t.progress.message.slice(0, 60) : 'running…') : t.status;
    row.append(dot, label, st);
    if (t.cancellable) { const c = document.createElement('button'); c.className = 'btn sm taskbtn'; c.type = 'button'; c.textContent = 'Cancel'; c.onclick = async () => { try { await bcall('/task/cancel', { id: t.id }); } catch {} taskWatchTick(); }; row.appendChild(c); }
    else if (t.retryable) { const c = document.createElement('button'); c.className = 'btn sm taskbtn'; c.type = 'button'; c.textContent = 'Retry'; c.onclick = async () => { try { const r = await bApproved('/task/retry', { id: t.id }, undefined, 'Retry background task ' + t.id + '?', 'task_retry'); if (r && r.needsApproval) feedPush('✕ Retry needs approval: ' + (r.note || 'approve it in the dialog'), { force: true }); else feedPush('↻ Task retry started: ' + t.id, { force: true }); } catch (e) { feedPush('✕ Retry failed: ' + (e.message || e), { force: true }); } taskWatchTick(); }; row.appendChild(c); }
    el.appendChild(row);
  }
}
/* ---- 3.12: compact sandbox status indicator (same visual conventions as the task bar) ---- */
const sandboxWatch = { timer: null, last: new Map() };
function sandboxWatchStart() {
  const el = $('sandboxBar'); if (el) el.hidden = false;
  if (!sandboxWatch.timer) sandboxWatch.timer = setInterval(sandboxWatchTick, 5000);
  sandboxWatchTick();
}
function sandboxWatchStop() { if (sandboxWatch.timer) { clearInterval(sandboxWatch.timer); sandboxWatch.timer = null; } }
async function sandboxWatchTick() {
  if (!B.ok) { sandboxWatchStop(); const el = $('sandboxBar'); if (el) { el.hidden = true; el.innerHTML = ''; } return; }
  let data;
  try { data = await bcall('/sandbox/list', {}); } catch { return; }
  const rows = (data.sandboxes || []).filter(s => !['destroyed', 'error'].includes(s.state)).slice(0, 4);
  for (const s of rows) {
    const prev = sandboxWatch.last.get(s.id);
    if (prev && prev !== s.state) {
      if (s.state === 'stopped') feedPush('📦 Sandbox stopped: ' + s.id, { force: true });
      else if (s.state === 'interrupted') feedPush('📦 Sandbox ' + s.id + ' was interrupted by a server restart — use the orphan cleanup or destroy it.', { force: true });
    }
    sandboxWatch.last.set(s.id, s.state);
  }
  if (!rows.length) { sandboxWatchStop(); const el = $('sandboxBar'); if (el) { el.hidden = true; el.innerHTML = ''; } return; }
  renderSandboxBar(rows, data.counts || {});
}
function renderSandboxBar(rows, counts) {
  const el = $('sandboxBar'); if (!el) return;
  el.innerHTML = '';
  for (const s of rows) {
    const row = document.createElement('div'); row.className = 'taskrow'; row.dataset.status = s.state;
    const dot = document.createElement('span'); dot.className = 'taskdot'; dot.title = 'Sandbox state: ' + s.state;
    const label = document.createElement('span'); label.className = 'tasklabel';
    label.textContent = 'Sandbox: ' + (s.profile || s.provider) + ' · ' + s.provider;
    label.title = s.id + ' · ' + s.state + ' · network ' + s.networkPolicy + ' · ' + JSON.stringify(s.resources || {});
    const st = document.createElement('span'); st.className = 'taskstatus';
    st.textContent = (s.state === 'running' ? 'running' : s.state) + ' · net ' + s.networkPolicy + ' · ' + (s.resources ? (s.resources.cpus + ' CPU / ' + (s.resources.memoryMb / 1024).toFixed(1) + ' GB') : '');
    row.append(dot, label, st);
    if (['running', 'busy', 'creating', 'awaiting-mount-approval'].includes(s.state)) {
      const c = document.createElement('button'); c.className = 'btn sm taskbtn'; c.type = 'button'; c.textContent = 'Stop';
      c.onclick = async () => { try { await bApproved('/sandbox/stop', { id: s.id }, undefined, 'Stop sandbox ' + s.id + '?', 'sandbox_stop'); } catch {} sandboxWatchTick(); };
      row.appendChild(c);
    }
    el.appendChild(row);
  }
  const meta = document.createElement('div'); meta.className = 'hint'; meta.style.padding = '2px 6px';
  meta.textContent = counts.active != null ? (counts.active + '/' + counts.max + ' concurrent sandbox slots used') : '';
  if (meta.textContent) el.appendChild(meta);
}
/* ---- 3.10: server-side permission editor (Settings > Bridge) ---- */
const PERM_MODES = [['allow', 'Allow'], ['ask', 'Ask'], ['deny', 'Deny']];
async function renderPermSettings() {
  const grid = $('permGrid'); if (!grid) return;
  grid.innerHTML = '';
  if (!B.ok) { grid.innerHTML = '<p class="hint">Connect the bridge to edit server-side permissions.</p>'; return; }
  let data;
  try { data = await bcall('/perm/get', {}); } catch (e) { grid.innerHTML = '<p class="hint">Could not load permissions: ' + String(e.message || e) + '</p>'; return; }
  for (const [key, def] of Object.entries(data.defs || {})) {
    const field = document.createElement('div'); field.className = 'ma-route-field';
    const label = document.createElement('label'); label.textContent = def.label; label.title = def.desc || '';
    const sel = document.createElement('select'); sel.dataset.perm = key;
    for (const [v, lbl] of PERM_MODES) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; sel.appendChild(o); }
    sel.value = (data.permissions || {})[key] || 'allow';
    field.append(label, sel); grid.appendChild(field);
  }
  const save = document.createElement('div'); save.className = 'row';
  const btn = document.createElement('button'); btn.className = 'btn'; btn.type = 'button'; btn.textContent = 'Save server permissions';
  btn.onclick = async () => {
    const permissions = {};
    grid.querySelectorAll('select[data-perm]').forEach(s => { permissions[s.dataset.perm] = s.value; });
    try { await bcall('/perm/set', { permissions }); logActivity({ name: 'update_server_permissions', args: permissions }, { st: 'ok' }); btn.textContent = 'Saved ✓'; setTimeout(() => { btn.textContent = 'Save server permissions'; }, 1600); }
    catch (e) { btn.textContent = 'Error: ' + String(e.message || e).slice(0, 60); }
  };
  save.appendChild(btn); grid.appendChild(save);
}
const refreshSkills = async () => { B.skills = (await bcall('/skills/list')).skills || []; };
const refreshExt = async () => { B.ext = (await bcall('/ext/list')).extensions || []; };
const refreshConn = async () => { B.conn = await bcall('/conn/status'); };
const extToolName = (e, t) => ('ext_' + e + '__' + t).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);


/* ================= workspace checkpoints ================= */
