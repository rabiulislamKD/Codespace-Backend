function listRow(title, sub, extra) {
  const row = document.createElement('div'); row.className = 'li';
  const info = document.createElement('div'); info.className = 'info';
  const b = document.createElement('b'); b.textContent = title; const sp = document.createElement('span'); sp.textContent = sub || '';
  info.append(b, sp); row.appendChild(info); (extra || []).forEach(x => row.appendChild(x)); return row;
}
function skMsg(t, bad) { $('skMsg').textContent = t || ''; $('skMsg').style.color = bad ? 'var(--err)' : ''; }
function renderSkills() {
  const box = $('skList'); box.innerHTML = '';
  if (!B.ok) { skMsg('Connect the terminal bridge in Settings first. Skills are stored on your computer by the bridge.', true); return; }
  skMsg(B.skills.length ? '' : 'No skills installed yet.');
  B.skills.forEach(k => box.appendChild(listRow(k.name + (k.scope === 'project' ? ' (project)' : ''), k.description || '(no description)', [mkBtn('Remove', 'danger', async () => { try { await bcall('/skills/remove', { name: k.name }); await refreshSkills(); renderSkills(); } catch (e) { skMsg(e.message, true); } })])));
}
$('skInstall').onclick = async () => {
  const source = $('skSrc').value.trim(); if (!source) { skMsg('Enter a repo or SKILL.md link.', true); return; }
  if (!B.ok) { skMsg('Connect the bridge first.', true); return; }
  skMsg('Installing…');
  try { const r = await bApproved('/skills/install', { source, name: $('skOnly').value.trim() || undefined }, undefined, 'Install this skill (server permission)?', 'skill_install', permMeta('skill', source || 'skill')); if (r && r.needsApproval) { skMsg(String(r.note || 'Approval needed.'), true); return; } await refreshSkills(); renderSkills(); skMsg('Installed: ' + r.installed.join(', ')); $('skSrc').value = ''; } catch (e) { skMsg(e.message, true); }
};
$('skSave').onclick = async () => {
  const name = $('skName').value.trim(), content = $('skContent').value;
  if (!B.ok) { skMsg('Connect the bridge first.', true); return; }
  if (!name || !content.trim()) { skMsg('Enter a name and the SKILL.md contents.', true); return; }
  try { const r = await bApproved('/skills/install', { name, content }, undefined, 'Save this skill (server permission)?', 'skill_install', permMeta('skill', name || 'skill')); if (r && r.needsApproval) { skMsg(String(r.note || 'Approval needed.'), true); return; } await refreshSkills(); renderSkills(); skMsg('Saved: ' + name); $('skName').value = ''; $('skContent').value = ''; } catch (e) { skMsg(e.message, true); }
};

let extTries = 0;
function extMsg(t, bad) { const el = $('extMsg'); if (el) { el.textContent = t || ''; el.style.color = bad ? 'var(--err)' : ''; } }
const mkBtn = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + (cls || ''); b.textContent = label; b.onclick = fn; return b; };
function renderExt() {
  const box = $('extList'); box.innerHTML = '';
  if (!B.ok) { extMsg(''); return; }
  B.ext.forEach(e => {
    const card = document.createElement('div'); card.className = 'ext-installed-card';
    const name = document.createElement('span'); name.className = 'ext-installed-name'; name.textContent = e.name;
    const version = document.createElement('span'); version.className = 'tool-version'; version.textContent = e.version ? 'v' + e.version : '';
    card.append(name, version);
    card.appendChild(mkBtn('Uninstall', 'danger', async () => {
      if (!confirm('Uninstall ' + e.name + '?')) return;
      try { const r = await bApproved('/ext/remove', { name: e.name }, undefined, 'Uninstall extension?', 'ext_remove'); if (r && r.needsApproval) return; await refreshExtUI(); }
      catch (er) { extMsg(er.message, true); }
    }));
    box.appendChild(card);
  });
}
async function refreshExtUI() {
  if (!B.ok) { renderExt(); return; }
  try { await refreshExt(); } catch (e) { extMsg(e.message, true); }
  renderExt(); updateMeters();
  if (B.ext.some(e => e.status === 'stopped' || e.status === 'starting') && extTries++ < 10) setTimeout(refreshExtUI, 3000);
}
$('extRefresh').onclick = () => { extTries = 0; refreshExtUI(); };
$('extGitExt').onclick = async () => {
  const src = $('extGitSrc').value.trim();
  if (!src) { extMsg('Enter a GitHub repository.', true); return; }
  if (!B.ok) { extMsg('Connect the terminal bridge first.', true); return; }
  await installExt({ source: src }, 'Install CodeSpace extension from ' + src);
  $('extGitSrc').value = '';
};
async function installExt(body, what) {
  if (!B.ok) { extMsg(''); return; }
  if (!await approve('Install extension?', what, 'ext_install', permMeta('ext', String(body.source || 'extension')))) return;
  extMsg('');
  try {
    const r = await bApproved('/ext/install', body, undefined, 'Approve extension installation?', 'ext_install', permMeta('ext', String(body.source || 'extension')));
    if (r && r.needsApproval) return;
    if (r && r.st === 'err' && r.text) { extMsg(r.text, true); return; }
    extTries = 0; await refreshExtUI();
  } catch (e) { extMsg(e.message, true); }
}

function toolVersion(text) {
  const m = String(text || '').match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);
  return m ? m[0].replace(/^v/, '') : String(text || 'Unknown').trim().slice(0, 100) || 'Unknown';
}
function toolHistoryLabel(h) {
  const when = h.at ? new Date(h.at).toLocaleString() : '';
  return h.name + ' · ' + h.action + (h.version && h.version !== 'Unknown' ? ' · v' + h.version : '') + (h.latestVersion ? ' → v' + h.latestVersion : '') + (when ? ' · ' + when : '');
}
async function renderTools() {
  const box = $('toolsList'), hist = $('toolsHistory');
  if (!box || !hist) return;
  box.innerHTML = ''; hist.innerHTML = '';
  if (!B.ok) return;
  try {
    const data = await bcall('/tools/installed', {});
    (data.items || []).forEach(item => {
      const row = document.createElement('div'); row.className = 'tool-manager-row';
      const main = document.createElement('div'); main.className = 'tool-manager-main';
      const name = document.createElement('div'); name.className = 'tool-manager-name'; name.textContent = item.name;
      const ver = document.createElement('div'); ver.className = 'tool-manager-version'; ver.textContent = item.version && item.version !== 'Unknown' ? 'v' + toolVersion(item.version) : 'Version unknown';
      main.append(name, ver);
      const status = document.createElement('span'); status.className = 'tool-update-state';
      status.textContent = item.updateAvailable === true ? 'Update available' : item.updateAvailable === false ? 'Up to date' : 'Not checked';
      if (item.updateAvailable === true) status.classList.add('available');
      const actions = document.createElement('div'); actions.className = 'tool-manager-actions';
      if (item.updateCheckCommand) actions.appendChild(mkBtn('Check updates', '', async () => {
        try {
          const r = await bApproved('/run', { command: item.updateCheckCommand, cwd: item.cwd, timeout: 90 }, undefined, 'Check for updates to ' + item.name + '?', 'tool_update_check', permMeta('command', item.updateCheckCommand));
          if (r && r.needsApproval) return;
          if (r.exitCode !== 0 || r.timedOut) throw new Error(r.stderr || 'Update check failed');
          const latest = toolVersion(r.stdout || r.stderr || '');
          const current = toolVersion(item.version || '');
          const available = latest !== 'Unknown' && current !== 'Unknown' && latest !== current;
          await bcall('/tools/update-status', { id: item.id, updateAvailable: available, latestVersion: latest });
          renderTools();
        } catch (e) { status.textContent = 'Check failed'; status.title = e.message; }
      }));
      if (item.updateAvailable === true && item.updateCommand) actions.appendChild(mkBtn('Update', 'primary', async () => {
        try {
          const r = await bApproved('/run', { command: item.updateCommand, cwd: item.cwd, timeout: 600 }, undefined, 'Update ' + item.name + ' to ' + (item.latestVersion || 'the latest version') + '?', 'tool_update', permMeta('command', item.updateCommand));
          if (r && r.needsApproval) return;
          if (r.exitCode !== 0 || r.timedOut) throw new Error(r.stderr || 'Update failed');
          await bcall('/tools/update-status', { id: item.id, updateAvailable: false, latestVersion: item.latestVersion || item.version, updated: true });
          renderTools();
        } catch (e) { status.textContent = 'Update failed'; status.title = e.message; }
      }));
      actions.appendChild(mkBtn('Uninstall', 'danger', async () => {
        if (!item.uninstallCommand) { status.textContent = 'No safe uninstall command saved'; return; }
        try {
          const r = await bApproved('/run', { command: item.uninstallCommand, cwd: item.cwd, timeout: 300 }, undefined, 'Uninstall ' + item.name + '?', 'tool_uninstall', permMeta('command', item.uninstallCommand));
          if (r && r.needsApproval) return;
          if (r.exitCode !== 0 || r.timedOut) throw new Error(r.stderr || 'Uninstall failed');
          await bcall('/tools/remove-record', { id: item.id }); renderTools();
        } catch (e) { status.textContent = 'Uninstall failed'; status.title = e.message; }
      }));
      row.append(main, status, actions); box.appendChild(row);
    });
    if (!(data.items || []).length) { const empty = document.createElement('div'); empty.className = 'tools-empty'; empty.textContent = 'No AI-installed tools yet'; box.appendChild(empty); }
    (data.history || []).slice(0, 100).forEach(h => { const el = document.createElement('div'); el.className = 'tools-history-row'; el.textContent = toolHistoryLabel(h); hist.appendChild(el); });
  } catch (e) { const err = document.createElement('div'); err.className = 'tools-empty'; err.textContent = e.message; box.appendChild(err); }
}
$('toolsRefresh').onclick = renderTools;
function connMsg(t, bad) { $('connMsg').textContent = t || ''; $('connMsg').style.color = bad ? 'var(--err)' : ''; }
function updateConnUI() {
  const c = B.conn || {};
  const set = (svc, dot, state, text) => { $(dot).className = 'dot ' + (c[svc] && c[svc].connected ? 'ok' : ''); $(state).textContent = text; };
  set('github', 'ghDot', 'ghState', c.github && c.github.connected ? 'Connected as ' + c.github.user : 'Not connected');
  set('vercel', 'vcDot', 'vcState', c.vercel && c.vercel.connected ? 'Connected' + (c.vercel.user ? ' as ' + c.vercel.user : '') : 'Not connected');
  const m = c.mysql; set('mysql', 'dbDot', 'dbState', m && m.connected ? 'Connected to ' + m.host + ':' + m.port + (m.database ? ' / ' + m.database : '') + (m.readOnly ? ' (read-only)' : '') : 'Not connected');
  if (c.github && c.github.connected) $('ghExpose').checked = !!c.github.expose;
  if (c.vercel && c.vercel.connected) { $('vcExpose').checked = !!c.vercel.expose; $('vcTeam').value = c.vercel.teamId || ''; }
  if (m && m.connected) { $('dbHost').value = m.host; $('dbPort').value = m.port; $('dbUser').value = m.user; $('dbName').value = m.database; $('dbSsl').checked = m.ssl; $('dbRO').checked = m.readOnly; }
  if (!B.ok) connMsg('Connect the terminal bridge in Settings first. Tokens and passwords are stored by the bridge on your computer, never sent to the AI model.', true); else connMsg('Tokens and passwords are stored on your computer by the bridge and are never sent to the AI model.');
}
async function refreshConnUI() { if (B.ok) { try { await refreshConn(); } catch {} } updateConnUI(); updateMeters(); }
async function connect(body, clear) {
  if (!B.ok) { connMsg('Connect the bridge first.', true); return; }
  connMsg('Connecting…');
  try { B.conn = await bcall('/conn/set', body); clear.forEach(id => { $(id).value = ''; }); updateConnUI(); updateMeters(); } catch (e) { connMsg(e.message, true); }
}
async function disconnect(name) { try { B.conn = await bcall('/conn/remove', { name }); } catch (e) { connMsg(e.message, true); } updateConnUI(); updateMeters(); }
$('ghConnect').onclick = () => connect({ name: 'github', token: $('ghToken').value, expose: $('ghExpose').checked }, ['ghToken']);
$('ghOff').onclick = () => disconnect('github');
$('vcConnect').onclick = () => connect({ name: 'vercel', token: $('vcToken').value, teamId: $('vcTeam').value, expose: $('vcExpose').checked }, ['vcToken']);
$('vcOff').onclick = () => disconnect('vercel');
$('dbConnect').onclick = () => connect({ name: 'mysql', host: $('dbHost').value, port: $('dbPort').value, user: $('dbUser').value, password: $('dbPass').value, database: $('dbName').value, ssl: $('dbSsl').checked, readOnly: $('dbRO').checked }, ['dbPass']);
$('dbOff').onclick = () => disconnect('mysql');
$('ghRepos').onclick = async () => {
  const box = $('ghList'); box.innerHTML = '';
  try {
    const r = await bcall('/conn/github', { path: '/user/repos?per_page=30&sort=updated' });
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('GitHub answered ' + r.status);
    r.data.forEach(repo => box.appendChild(listRow(repo.full_name, (repo.private ? 'private · ' : '') + (repo.description || ''), [mkBtn('Clone', '', async () => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) return;
      connMsg('Cloning ' + repo.full_name + '…');
      try { const x = await bcall('/run', { command: 'git clone https://github.com/' + repo.full_name + '.git', useConnections: true, timeout: 300 }); connMsg(x.exitCode === 0 ? 'Cloned ' + repo.full_name + ' into the workspace.' : 'git clone failed: ' + (x.stderr || x.stdout).slice(0, 200), x.exitCode !== 0); refreshExplorer(); } catch (e) { connMsg(e.message, true); }
    })])));
  } catch (e) { connMsg(e.message, true); }
};
$('vcProjects').onclick = async () => {
  const box = $('vcList'); box.innerHTML = '';
  try {
    const r = await bcall('/conn/vercel', { path: '/v9/projects?limit=20' });
    if (r.status !== 200 || !r.data.projects) throw new Error('Vercel answered ' + r.status);
    r.data.projects.forEach(p => { const d = p.latestDeployments && p.latestDeployments[0]; box.appendChild(listRow(p.name, (p.framework || '') + (d ? ' · https://' + d.url : ''), [])); });
    if (!r.data.projects.length) box.innerHTML = '<div class="tnote">No projects.</div>';
  } catch (e) { connMsg(e.message, true); }
};
$('vcDeploy').onclick = async () => {
  if (!B.ok) { connMsg('Connect the bridge first.', true); return; }
  if (!await approve('Deploy the workspace to Vercel?', 'Runs in the workspace folder:\n  npx vercel deploy --yes\n\nusing your connected Vercel token.', 'vercel_deploy', permMeta('vercel', 'POST /deploy'))) return;
  try { const r = await bcall('/run', { command: 'npx vercel deploy --yes', background: true, useConnections: true, name: 'vercel deploy', wait: 4000 }); await refreshTerms(); showTerminal(r.terminalId); } catch (e) { connMsg(e.message, true); }
};
async function runSql(sql, title) {
  try {
    const r = await bApproved('/db/query', { sql, maxRows: 500 }, undefined, 'Run SQL that changes data?', 'mysql_write', permMeta('sql', sql));
    if (r) openTable(title || 'Query', r, sql, true);
  } catch (e) { connMsg(e.message, true); }
}
$('dbTables').onclick = async () => {
  const box = $('dbList'); box.innerHTML = '';
  try {
    const r = await bcall('/db/tables');
    r.rows.forEach(row => { const name = String(row[0]); const el = document.createElement('div'); el.className = 'trow'; el.textContent = '▦ ' + name; el.tabIndex = 0; const go = () => runSql('SELECT * FROM `' + name.replace(/`/g, '') + '` LIMIT 100', name); el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter') go(); }; box.appendChild(el); });
    if (!r.rows.length) box.innerHTML = '<div class="tnote">No tables.</div>';
  } catch (e) { connMsg(e.message, true); }
};
$('dbRun').onclick = () => { const sql = $('dbSql').value.trim(); if (sql) runSql(sql, 'Query'); };

/* ================= settings ================= */
const dlg = $('dlg');
const touchS = () => { S.updated = Date.now(); saveLocal(); fillQuick(); updateMeters(); if (B.ok) pushConfig(); };
const MULTI_AGENT_ROUTE_SELECTS = { planner: 'maPlannerProvider', architect: 'maArchitectProvider', researcher: 'maResearcherProvider', test: 'maTestProvider', implementer: 'maImplementerProvider', debugger: 'maDebuggerProvider', reviewer: 'maReviewerProvider' };
function fillMultiAgentRouteSelectors() {
  for (const [role, id] of Object.entries(MULTI_AGENT_ROUTE_SELECTS)) {
    const sel = $(id); if (!sel) continue;
    const saved = (S.multiAgentModels && S.multiAgentModels[role]) || '';
    sel.innerHTML = '';
    const fallback = document.createElement('option'); fallback.value = ''; fallback.textContent = 'Use selected model'; sel.appendChild(fallback);
    S.providers.forEach(provider => { const o = document.createElement('option'); o.value = provider.id; o.textContent = (provider.name || 'Provider') + (provider.model ? ' · ' + provider.model : ''); sel.appendChild(o); });
    sel.value = S.providers.some(provider => provider.id === saved) ? saved : '';
  }
}
function readMultiAgentRouteSelectors() {
  const out = {};
  for (const [role, id] of Object.entries(MULTI_AGENT_ROUTE_SELECTS)) out[role] = $(id) ? $(id).value : '';
  return out;
}
function openSettings() {
  if (typeof ocRefresh === 'function') ocRefresh();
  $('sys').value = S.sys; $('temp').value = S.temp; $('agentOn').checked = S.agentOn; $('openCodeAutoApprove').checked = !!S.openCodeAutoApprove; $('autoCompress').checked = S.autoCompress; $('tokenSaver').checked = S.tokenSaver !== false; $('smartTools').checked = S.smartTools !== false; $('humanize').checked = S.humanize;
  $('browserVisible').checked = !!S.browserVisible; $('browserPersist').checked = !!S.browserPersist; $('theme').value = S.theme || 'auto'; $('chatFont').value = String(S.chatFont || 13); $('editorFont').value = String(S.editorFont || 13);
  $('bUrl').value = L.bridgeUrl; $('bTok').value = L.bridgeToken; $('bMsg').textContent = ''; $('settingsErr').textContent = '';
  $('cfgPath').textContent = B.ok ? 'Settings are also saved to this file on your computer: ' + B.info.configFile : 'Settings are saved in this browser. Connect the bridge to also save them to a file on your computer.';
  fillMultiAgentRouteSelectors();
  renderPermSettings();
  renderSandboxSettings();
  dlg.showModal();
}
/* ---- 3.12: sandbox settings block (provider availability + health) ---- */
async function renderSandboxSettings(refresh) {
  const box = $('sandboxCap'); if (!box) return;
  if (!B.ok) { box.textContent = 'Connect the bridge to detect sandbox providers.'; return; }
  box.textContent = 'Detecting sandbox providers…';
  try {
    const r = await bcall('/sandbox/capabilities', { refresh: !!refresh });
    const rows = Object.entries(r.providers || {}).map(([k, v]) => {
      const state = v.available ? (v.healthy === false ? '⚠ unhealthy' : '✔ available' + (v.testOnly ? ' (test-only, NON-isolated)' : '')) : '✖ unavailable';
      return state + ' ' + k + (v.available && v.serverVersion ? ' (server ' + v.serverVersion + (v.rootless ? ', rootless' : '') + ')' : '') + (v.reason ? ' — ' + v.reason.slice(0, 120) : '');
    });
    box.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = r.platform + '/' + r.architecture + ' · ' + r.hostCpus + ' CPU · ' + r.hostMemoryMb + ' MB RAM · max ' + r.maxConcurrent + ' concurrent sandbox(es) · network disabled by default';
    head.style.marginBottom = '4px';
    box.appendChild(head);
    for (const line of rows) { const d = document.createElement('div'); d.textContent = line; box.appendChild(d); }
    if ($('sandboxMsg')) $('sandboxMsg').textContent = '';
  } catch (e) { box.textContent = 'Could not detect providers: ' + String(e.message || e); }
}
if (typeof $ === 'function' && $('sandboxRefresh')) $('sandboxRefresh').onclick = () => renderSandboxSettings(true);

const openView = v => { if (!(curView === v && !$('app').classList.contains('nosidebar'))) showView(v); };
$('settingsBtn').onclick = openSettings; $('sbBridge').onclick = openSettings; $('sbModel').onclick = () => openView('models');
$('openModels').onclick = () => { dlg.close(); openView('models'); };
$('cancelSettings').onclick = () => dlg.close();
$('bTest').onclick = async () => {
  const url = $('bUrl').value.trim().replace(/\/+$/, ''), tok = $('bTok').value.trim(); $('bMsg').textContent = 'Testing…';
  const ver = v => (v && typeof v === 'object') ? (v.version || v.path || (v.available === false ? 'not found' : 'ready')) : v;
  try {
    let d;
    if (url === 'codespace-native://local') {
      // Android Local mode: no HTTP server exists; ask the native adapter directly.
      if (!window.CodeSpaceNative || typeof window.CodeSpaceNative.localApiCall !== 'function') throw new Error('The Android Local Agent adapter is unavailable.');
      const reply = JSON.parse(window.CodeSpaceNative.localApiCall('/info', '{}'));
      if (!reply || reply.status < 200 || reply.status >= 300) throw new Error((reply && reply.error) || 'Local API error');
      d = reply.data || {};
    } else if (window.CodeSpaceNative && typeof window.CodeSpaceNative.testRemoteBridge === 'function') {
      // The Android page origin is file://, so remote fetch can fail with "Failed to fetch"
      // because of CORS even when the server is healthy. Use the native HTTPS client instead.
      const native = JSON.parse(window.CodeSpaceNative.testRemoteBridge(url, tok) || '{}');
      if (!native.ok) throw new Error(native.error || 'Connection failed');
      d = native.info || {};
    } else {
      const r = await fetch(url + '/info', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' });
      d = await r.json(); if (!r.ok) throw new Error(d.error || r.status);
    }
    $('bMsg').textContent = 'Connected. Workspace: ' + d.root + ' · ' + d.platform + ' · Node ' + (ver(d.node) || 'not found') + ' · ' + (ver(d.python) ? 'Python ' + ver(d.python) : 'Python not found') + ' · shells: ' + (d.shells || []).map(x => x.label).join(', ');
  } catch (e) {
    const local = url === 'codespace-native://local';
    $('bMsg').textContent = 'Could not connect (' + e.message + ').' + (local ? ' Android Local mode needs no server.' : ' Is the bridge/Render server running, and are the URL and token right? On Android use https:// or switch to Local mode.');
  }
};
$('saveSettings').onclick = () => {
  Object.assign(S, { multiAgentModels: readMultiAgentRouteSelectors(), sys: $('sys').value, temp: $('temp').value === '' ? 0.7 : $('temp').value, agentOn: $('agentOn').checked, multiAgent: $('agentOn').checked ? !!S.multiAgent : false, autoCompress: $('autoCompress').checked, tokenSaver: $('tokenSaver').checked, smartTools: $('smartTools').checked, humanize: $('humanize').checked, browserVisible: $('browserVisible').checked, browserPersist: $('browserPersist').checked, openCodeAutoApprove: $('openCodeAutoApprove').checked, theme: $('theme').value, chatFont: Math.max(12, Math.min(16, Number($('chatFont').value)||13)), editorFont: Math.max(11, Math.min(18, Number($('editorFont').value)||13)), updated: Date.now() });
  const rawUrl = $('bUrl').value.trim();
  const nextUrl = rawUrl || (window.CodeSpaceNative ? 'codespace-native://local' : 'http://127.0.0.1:8787');
  L.bridgeUrl = nextUrl; L.bridgeToken = $('bTok').value.trim();
  saveLocal(); applyTheme(); applyFontSizes(); fillQuick(); syncMode(); updateMeters(); setBusy(false);
  if (window.CodeSpaceNative && typeof window.CodeSpaceNative.setRemoteBridge === 'function') {
    let switched = {};
    try { switched = JSON.parse(window.CodeSpaceNative.setRemoteBridge(nextUrl, L.bridgeToken) || '{}'); }
    catch (e) { switched = { ok: false, error: String((e && e.message) || e) }; }
    if (!switched.ok) { $('bMsg').textContent = switched.error || 'Could not switch the bridge.'; return; }
    // The native side applies the sandbox mode and reloads the page with the new bridge.
    dlg.close();
    return;
  }
  dlg.close();
  connectBridge().then(() => { if (B.ok) pushConfig(); });
};

/* ================= model providers ================= */
const TYPE_LABEL = { openai: 'OpenAI-compatible', anthropic: 'Anthropic', custom: 'Custom endpoint' };
const TYPE_HINT = {
  openai: 'Works with any server that speaks the OpenAI chat API: llama.cpp, Ollama, LM Studio, vLLM, OpenRouter, Groq, Together, DeepSeek, Mistral and more. Enter the address ending in /v1. The chat path is added for you.',
  anthropic: 'Claude models through the Anthropic Messages API. The API key is sent as x-api-key.',
  custom: 'Use this when the chat address is different from the usual one. Paste the complete URL. An OpenAI-style chat request is sent to exactly that address. For Azure OpenAI, paste the whole deployment URL (with ?api-version=…) and send the key in a header named api-key.'
};
const hostOf = u => { try { return new URL(u).host; } catch { return u || '?'; } };
function renderProviders() {
  const box = $('provList'); box.innerHTML = '';
  S.providers.forEach(p => {
    const inUse = p.id === S.activeId;
    const row = document.createElement('div'); row.className = 'li prov click' + (inUse ? ' cur' : ''); row.tabIndex = 0;
    const dot = document.createElement('span'); dot.className = 'dot ' + (inUse ? 'ok' : ''); dot.title = inUse ? 'In use' : '';
    const info = document.createElement('div'); info.className = 'info';
    const b = document.createElement('b'); b.textContent = p.name;
    info.append(b);
    // Details are available on hover instead of being printed on every card.
    const details = (TYPE_LABEL[p.format] || p.format) + ' · ' + (p.model || 'no model set') + (p.models && p.models.length ? ' (' + p.models.length + ' models listed)' : (p.modelsErr ? ' (model list failed: ' + p.modelsErr + ')' : '')) + ' · ' + hostOf(p.base) + ' · ' + fmtTok(p.ctx || DEFAULT_CTX) + ' context · $' + (Number(p.inputRate)||0) + '/M in · $' + (Number(p.outputRate)||0) + '/M out' + (p.promptCache ? ' · prompt cache on' : '') + (inUse ? ' · in use' : ' · click the card to use it');
    row.title = details; row.append(dot, info);
    row.append(mkBtn('Edit', '', e => { e.stopPropagation(); openProvEditor(p); }));
    const del = mkBtn('Delete', 'danger', e => { e.stopPropagation(); deleteProvider(p); }); del.disabled = S.providers.length <= 1; del.title = 'Remove this provider'; row.append(del);
    const use = () => { S.activeId = p.id; S.copilotAuto = false; COPILOT_LAST_OK = ''; touchS(); renderProviders(); if (typeof fillQuick === 'function') fillQuick(); updateMeters(); };
    row.onclick = use; row.onkeydown = e => { if (e.key === 'Enter' && e.target === row) use(); };
    box.appendChild(row);
  });
}
function deleteProvider(p) {
  if (S.providers.length <= 1 || !confirm('Remove the provider "' + p.name + '"?')) return;
  S.providers = S.providers.filter(x => x.id !== p.id); if (S.activeId === p.id) { S.activeId = S.providers[0].id; S.copilotAuto = false; COPILOT_LAST_OK = ''; }
  touchS(); renderProviders();
}
let pdId = null;
const pdMsg = (t, bad) => { $('pdMsg').textContent = t || ''; $('pdMsg').style.color = bad ? 'var(--err)' : ''; };
function pdSync() {
  const t = $('pdType').value;
  { const tl = document.querySelector('label[for="pdType"]'); if (tl) tl.title = TYPE_HINT[t]; }
  $('pdBaseLabel').textContent = t === 'custom' ? 'Full endpoint URL' : 'Base URL';
  $('pdBase').placeholder = t === 'custom' ? 'https://example.com/api/chat/completions' : t === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:8080/v1';
  $('pdPathWrap').hidden = t !== 'openai'; $('pdThinkWrap').hidden = t !== 'anthropic'; $('pdAuthWrap').hidden = false;
  $('pdAuth').querySelector('option[value="header"]').hidden = t === 'anthropic';
  if (t === 'anthropic' && ($('pdAuth').value === 'header' || $('pdAuth').value === 'bearer')) $('pdAuth').value = 'x-api-key';
  $('pdHeaderWrap').hidden = $('pdAuth').value !== 'header';
}
function pdFill(p) {
  $('pdName').value = p.name || ''; $('pdType').value = p.format || 'openai'; $('pdBase').value = p.base || ''; $('pdPath').value = p.path || '/chat/completions';
  $('pdModel').value = p.model || ''; $('pdKey').value = p.key || ''; $('pdAuth').value = p.auth || 'none'; $('pdAuthHeader').value = p.authHeader || '';
  $('pdExtra').value = p.extra || ''; $('pdBody').value = p.extraBody || ''; $('pdCtx').value = p.ctx || DEFAULT_CTX; $('pdVision').checked = !!p.vision;
  $('pdInputRate').value = Number(p.inputRate) || 0; $('pdOutputRate').value = Number(p.outputRate) || 0; $('pdPromptCache').checked = !!p.promptCache;
  $('pdThink').checked = !!p.think; $('pdBudget').value = p.thinkBudget || 4096; $('pdPreset').value = ''; $('pdModels').innerHTML = ''; pdFetched = null; pdFetchedCapabilities = null; (p.models || []).forEach(id => { const o = document.createElement('option'); o.value = id; $('pdModels').appendChild(o); }); pdMsg(''); pdSync();
}
/* ================= Provider gallery ================= */
// Cards fill the same form as the presets. "free" means the provider has a free tier or free models; limits,
// models and prices change often, so each card links to the page where you get your key and check the terms.
// verify:true = the address comes from my memory of the provider's docs and was not tested: use "Fetch models" to confirm it.
const PROVIDER_CARDS = [
  { id: 'gemini', name: 'Google Gemini', tag: 'free', blurb: 'Free tier with your Google account. Long context, images.', format: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'bearer', model: 'gemini-2.5-flash', ctx: 1000000, vision: true, keyUrl: 'https://aistudio.google.com/apikey', google: true, keyHelp: 'Sign in with your Google account on the page that opens, press "Create API key", and paste it below.' },
  { id: 'openai', name: 'OpenAI', tag: 'paid', blurb: 'GPT models. Pay as you go.', format: 'openai', base: 'https://api.openai.com/v1', auth: 'bearer', model: '', ctx: 128000, vision: true, keyUrl: 'https://platform.openai.com/api-keys', keyHelp: 'Create a secret key on the page that opens and paste it below.' },
  { id: 'anthropic', name: 'Claude (Anthropic)', tag: 'paid', blurb: 'Claude models. Pay as you go.', format: 'anthropic', base: 'https://api.anthropic.com', auth: 'x-api-key', model: 'claude-sonnet-5-5', ctx: 200000, vision: true, keyUrl: 'https://console.anthropic.com/settings/keys', keyHelp: 'Create an API key in the Anthropic console and paste it below.' },
  { id: 'cline', name: 'Cline', tag: 'free', verify: true, blurb: 'Cline account models, including free promotional ones.', format: 'openai', base: 'https://api.cline.bot/api/v1', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://app.cline.bot', keyHelp: 'Sign in to Cline, create an API key in your account, and paste it below.' },
  { id: 'openrouter', name: 'OpenRouter', tag: 'free', blurb: 'Hundreds of models; many are marked ":free" and need no card.', format: 'openai', base: 'https://openrouter.ai/api/v1', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://openrouter.ai/keys', keyHelp: 'Create a key, then choose a model whose name ends in ":free" in the model selector.' },
  { id: 'groq', name: 'Groq', tag: 'free', blurb: 'Very fast open models with a free tier.', format: 'openai', base: 'https://api.groq.com/openai/v1', auth: 'bearer', model: 'llama-3.3-70b-versatile', ctx: 128000, keyUrl: 'https://console.groq.com/keys' },
  { id: 'cerebras', name: 'Cerebras', tag: 'free', blurb: 'Very fast inference with a free tier.', format: 'openai', base: 'https://api.cerebras.ai/v1', auth: 'bearer', model: '', ctx: 64000, keyUrl: 'https://cloud.cerebras.ai' },
  { id: 'mistral', name: 'Mistral', tag: 'free', blurb: 'Free "Experiment" plan for testing.', format: 'openai', base: 'https://api.mistral.ai/v1', auth: 'bearer', model: 'mistral-small-latest', ctx: 128000, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'github', name: 'GitHub Models', tag: 'free', blurb: 'Free, rate-limited access to many models with a GitHub token.', format: 'openai', base: 'https://models.github.ai/inference', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://github.com/settings/personal-access-tokens', keyHelp: 'Create a fine-grained token that has the "Models" permission and paste it below.' },
  { id: 'nvidia', name: 'NVIDIA NIM', tag: 'free', blurb: 'Free hosted open models for development.', format: 'openai', base: 'https://integrate.api.nvidia.com/v1', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://build.nvidia.com/settings/api-keys' },
  { id: 'sambanova', name: 'SambaNova', tag: 'free', blurb: 'Fast open models with a free tier.', format: 'openai', base: 'https://api.sambanova.ai/v1', auth: 'bearer', model: '', ctx: 64000, keyUrl: 'https://cloud.sambanova.ai/apis' },
  { id: 'huggingface', name: 'Hugging Face', tag: 'free', blurb: 'Inference providers router; monthly free credit.', format: 'openai', base: 'https://router.huggingface.co/v1', auth: 'bearer', model: '', ctx: 64000, keyUrl: 'https://huggingface.co/settings/tokens', keyHelp: 'Create a token with permission to call Inference Providers and paste it below.' },
  { id: 'opencodezen', name: 'OpenCode Zen', tag: 'free', verify: true, blurb: 'OpenCode\u2019s curated models; some are free.', format: 'openai', base: 'https://opencode.ai/zen/v1', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://opencode.ai/zen' },
  { id: 'zai', name: 'Z.ai (GLM)', tag: 'free', verify: true, blurb: 'GLM models; some are free to use.', format: 'openai', base: 'https://api.z.ai/api/paas/v4', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'chat-zai', name: 'Chat Z.ai (local bridge)', tag: 'free', blurb: 'Chat Z.ai guest models through CodeSpace’s local browser bridge; no developer API key.', format: 'openai', base: 'http://127.0.0.1:9876/v1', auth: 'none', model: '', ctx: 128000, keyHelp: 'CodeSpace can start its local Chat Z.ai bridge from the chat composer. Chrome or Edge must be installed. The chat.z.ai web API is unofficial and can change.' },
  { id: 'together', name: 'Together AI', tag: 'paid', blurb: 'Open models, pay as you go.', format: 'openai', base: 'https://api.together.xyz/v1', auth: 'bearer', model: '', ctx: 128000, keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', tag: 'paid', blurb: 'Low-cost reasoning and chat models.', format: 'openai', base: 'https://api.deepseek.com/v1', auth: 'bearer', model: 'deepseek-chat', ctx: 64000, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'ollama', name: 'Ollama', tag: 'local', blurb: 'Models running on this computer. No key.', format: 'openai', base: 'http://localhost:11434/v1', auth: 'none', model: '', ctx: DEFAULT_CTX },
  { id: 'lmstudio', name: 'LM Studio', tag: 'local', blurb: 'Models running in LM Studio. No key.', format: 'openai', base: 'http://localhost:1234/v1', auth: 'none', model: '', ctx: DEFAULT_CTX },
  { id: 'llamacpp', name: 'llama.cpp', tag: 'local', blurb: 'Your own llama.cpp server. No key.', format: 'openai', base: 'http://localhost:8080/v1', auth: 'none', model: 'local', ctx: DEFAULT_CTX }
];
let pgFilter = 'all', pgPicked = '', pdModelGuess = false, pdDraft = null;
const pgMatches = c => (pgFilter === 'all' || c.tag === pgFilter) && (!$('pgSearch').value.trim() || (c.name + ' ' + c.blurb + ' ' + c.tag).toLowerCase().includes($('pgSearch').value.trim().toLowerCase()));
function renderGallery() {
  const chips = $('pgChips'); chips.innerHTML = '';
  [['all', 'All'], ['free', 'Free'], ['local', 'Local'], ['paid', 'Paid']].forEach(([id, label]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm' + (pgFilter === id ? ' on' : ''); b.textContent = label; b.setAttribute('aria-pressed', String(pgFilter === id)); b.onclick = () => { pgFilter = id; renderGallery(); }; chips.appendChild(b); });
  const grid = $('pgGrid'); grid.innerHTML = '';
  const list = PROVIDER_CARDS.filter(pgMatches);
  list.forEach(c => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pg-card'; b.setAttribute('aria-pressed', String(pgPicked === c.id));
    const t = document.createElement('span'); t.className = 'pg-tag ' + c.tag; t.textContent = c.tag === 'free' ? 'Free tier' : c.tag === 'local' ? 'On this computer' : 'Paid';
    const n = document.createElement('b'); n.textContent = c.name;
    const head = document.createElement('span'); head.className = 'pgn'; head.append(n);
    b.title = c.blurb; b.append(head, t); b.onclick = () => pickCard(c.id); grid.appendChild(b);
  });
  if (!list.length) { const e = document.createElement('div'); e.className = 'hint'; e.textContent = 'No match. Use "Custom endpoint" in the list below for any other provider.'; grid.appendChild(e); }
}
function cardFill(c) { return { name: c.name, format: c.format, base: c.base, path: '/chat/completions', model: c.model || '', key: '', auth: c.auth, ctx: c.ctx || DEFAULT_CTX, vision: !!c.vision }; }
function pickCard(id) {
  const c = PROVIDER_CARDS.find(x => x.id === id); if (!c) return;
  pgPicked = id; pdFill(cardFill(c)); pdModelGuess = !!c.model; renderGallery();
  const box = $('pdConnect'), acts = $('pcActions'); box.hidden = false; acts.innerHTML = '';
  $('pcTitle').textContent = c.tag === 'local' ? c.name + ' (no key needed)' : 'Connect ' + c.name;
  const pcHelpText = (c.keyHelp || (c.keyUrl ? 'Get an API key from the provider, then paste it into "API key" below.' : 'Start the server, then press "Fetch models".'))
    + (c.tag === 'free' ? ' Free-tier limits and models change, so check the provider\u2019s page.' : '')
    + (c.verify ? ' This address comes from the provider\u2019s docs as remembered and was not tested: press "Fetch models" to confirm it works.' : '');
  $('pcTitle').title = pcHelpText;
  if (c.keyUrl) {
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn sm primary';
    open.textContent = c.google ? 'Sign in with Google to get a key' : 'Get API key';
    open.onclick = () => openKeyPage(c);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn sm'; copy.textContent = 'Copy link';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(c.keyUrl); copy.textContent = 'Copied'; } catch { copy.textContent = c.keyUrl; } };
    acts.append(open, copy);
  }
  if (c.keyUrl) $('pdKey').focus();
}
// Web: opens a new tab. Desktop app: external links are blocked on purpose, so the page opens in the built-in Browser panel
// (the form is kept and comes back next time you press "Add provider"). "Copy link" always works.
function pickCardKeepForm(id) { const keep = { ...cardFill(PROVIDER_CARDS.find(x => x.id === id) || {}) }; pickCard(id); if (keep.name) $('pdName').value = keep.name; }
function openKeyPage(c) {
  if (typeof DESKTOP_EMBED !== 'undefined' && DESKTOP_EMBED) {
    pdDraft = cardFill(c); pdDraft.__card = c.id; $('provDlg').close(); showPanel(true);
    navigateEmbedded(c.keyUrl, true).then(ok => addNote(ok ? 'Opened ' + c.name + ' in the Browser panel. Create your key, copy it, then press "Add provider" to continue.' : 'Could not open the page. Use "Copy link" and open it in your normal browser.'));
  } else window.open(c.keyUrl, '_blank', 'noopener,noreferrer');
}
$('pgSearch').oninput = renderGallery;
$('pdModel').addEventListener('input', () => { pdModelGuess = false; });
renderGallery();

function openProvEditor(p) {
  pdId = p ? p.id : null; $('pdTitle').textContent = p ? 'Edit provider' : 'Add provider';
  const draft = !p && pdDraft ? pdDraft : null; pdDraft = null;
  pdFill(p || draft || { name: '', format: 'openai', base: '', path: '/chat/completions', model: '', key: '', auth: 'bearer', ctx: DEFAULT_CTX });
  $('pgWrap').hidden = !!p; pgPicked = draft ? (draft.__card || '') : ''; pdModelGuess = !!(draft && draft.model);
  if (!p) { $('pdConnect').hidden = true; if (draft && draft.__card) pickCardKeepForm(draft.__card); else renderGallery(); }
  $('provDlg').showModal();
}
function pdRead() {
  const t = $('pdType').value, g = id => $(id).value.trim();
  const p = { id: pdId || uid(), name: g('pdName') || 'Provider', format: t, base: g('pdBase'), path: g('pdPath') || '/chat/completions', model: g('pdModel'), key: g('pdKey'), auth: $('pdAuth').value, authHeader: g('pdAuthHeader'),
    extra: g('pdExtra'), extraBody: g('pdBody'), ctx: Math.max(1024, Number($('pdCtx').value) || DEFAULT_CTX), vision: $('pdVision').checked, inputRate: Math.max(0, Number($('pdInputRate').value) || 0), outputRate: Math.max(0, Number($('pdOutputRate').value) || 0), promptCache: $('pdPromptCache').checked, think: t === 'anthropic' && $('pdThink').checked, thinkBudget: Math.max(1024, Number($('pdBudget').value) || 4096) };
  p.modelGuess = pdModelGuess && !!p.model;
  if (!p.base) throw new Error(t === 'custom' ? 'Enter the full endpoint URL.' : 'Enter the base URL.');
  if (!/^https?:\/\//i.test(p.base)) throw new Error('The URL must start with http:// or https://');
  if (p.auth === 'header' && !p.authHeader) throw new Error('Enter the header name that should carry the key.');
  for (const k of ['extra', 'extraBody']) {
    if (p[k]) { let v; try { v = JSON.parse(p[k]); } catch { v = null; } if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error((k === 'extra' ? 'Extra headers' : 'Extra request fields') + ' must be a JSON object, like {"name": "value"}.'); }
  }
  return p;
}
const netHint = e => (/Failed to fetch|NetworkError|Load failed/i.test(e.message) ? e.message + '. Check the address, that the server is running, and that it allows requests from this page (CORS). Hosted providers that block browser calls work once the terminal bridge is connected (Settings > Bridge): CodeSpace then relays the request for you.' : e.message);
$('pdType').onchange = pdSync; $('pdAuth').onchange = pdSync;
$('pdPreset').onchange = e => {
  const v = e.target.value; if (!v) return;
  if (v === 'custom') { $('pdType').value = 'custom'; $('pdAuth').value = 'bearer'; pdSync(); return; }
  const pr = PRESETS[v]; if (!pr) return;
  $('pdName').value = pr.name; $('pdType').value = pr.format; $('pdBase').value = pr.base; $('pdAuth').value = pr.auth; $('pdPath').value = '/chat/completions';
  if (pr.model) $('pdModel').value = pr.model; $('pdCtx').value = pr.ctx; $('pdVision').checked = !!pr.vision; pdSync();
};
async function listProviderModelCatalog(p, signal) {
  const base = p.base.replace(/\/+$/, '');
  let url = p.format === 'anthropic' ? base + (/\/v1$/.test(base) ? '' : '/v1') + '/models?limit=1000' : p.format === 'custom' ? base.replace(/\/(chat\/)?completions(\?.*)?$/, '/models') : base + '/models';
  const h = buildHeaders(p); delete h['Content-Type'];
  const r = await provFetch(url, { headers: h, signal }); if (!r.ok) throw new Error('The server answered ' + r.status + ' for ' + url);
  const j = await r.json(), list = Array.isArray(j) ? j : (j.data || j.models || []);
  const ids = [], modelCapabilities = {};
  list.forEach(m => {
    const id = (typeof m === 'string' ? m : m && (m.id || m.name));
    if (!id) return;
    const cleanId = String(id).replace(/^models\//, '');
    if (!ids.includes(cleanId)) ids.push(cleanId);
    if (m && typeof m === 'object') modelCapabilities[cleanId] = normalizeModelReasoningInfo(m, p);
    else if (isOpenRouterProvider(p)) modelCapabilities[cleanId] = { catalogued: true, supported: false, efforts: null };
  });
  ids.sort((a, b) => a.localeCompare(b));
  if (!ids.length) throw new Error('The server did not list any models.');
  return { ids, modelCapabilities };
}
// Fetch and store a saved provider's model list (used after saving a key and on start-up).
async function refreshProviderModels(id, quiet) {
  const p = S.providers.find(x => x.id === id); if (!p || !p.base) return 0;
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);
  try {
    const catalog = await listProviderModelCatalog(p, ac.signal);
    p.models = catalog.ids; p.modelCapabilities = catalog.modelCapabilities; p.modelsAt = Date.now(); p.modelCapabilitiesAt = Date.now(); delete p.modelsErr;
    if (!p.model || (p.modelGuess && !catalog.ids.includes(p.model))) p.model = catalog.ids.find(x => /flash|instruct|chat|versatile|small|mini/i.test(x)) || catalog.ids[0];
    delete p.modelGuess;
    touchS(); return catalog.ids.length;
  } catch (e) {
    p.modelsErr = (e.name === 'AbortError' ? 'timed out' : e.message).slice(0, 160); p.modelsAt = Date.now(); saveLocal();
    if (!quiet) addNote('Could not list the models of ' + p.name + ': ' + p.modelsErr);
    return 0;
  } finally { clearTimeout(to); }
}
let modelRefreshBusy = false;
async function refreshAllModels(force) {
  if (modelRefreshBusy) return; modelRefreshBusy = true;
  try {
    for (const p of S.providers.slice()) {
      const stale = !p.modelsAt || Date.now() - p.modelsAt > 6 * 3600e3 || !(p.models && p.models.length) || !p.modelCapabilitiesAt;
      if ((force || stale) && p.base && (p.key || p.auth === 'none' || /^https?:\/\/(localhost|127\.|\[::1\])/i.test(p.base))) await refreshProviderModels(p.id, !force);
    }
  } finally { modelRefreshBusy = false; renderProviders(); }
}
let pdFetched = null, pdFetchedCapabilities = null;
$('pdFetch').onclick = async () => {
  let p; try { p = pdRead(); } catch (e) { pdMsg(e.message, true); return; }
  pdMsg('Looking for models…');
  try {
    const catalog = await listProviderModelCatalog(p); const ids = catalog.ids; pdFetched = ids; pdFetchedCapabilities = catalog.modelCapabilities;
    $('pdModels').innerHTML = ''; ids.forEach(id => { const o = document.createElement('option'); o.value = id; $('pdModels').appendChild(o); });
    if (!$('pdModel').value.trim()) $('pdModel').value = ids[0];
    pdMsg('Found ' + ids.length + ' model' + (ids.length === 1 ? '' : 's') + '. They will all appear in the chat model selector, grouped under this provider. Examples: ' + ids.slice(0, 6).join(', ') + (ids.length > 6 ? ', …' : ''));
  } catch (e) { pdMsg(netHint(e), true); }
};
$('pdTest').onclick = async () => {
  let p; try { p = pdRead(); } catch (e) { pdMsg(e.message, true); return; }
  pdMsg('Testing…'); const t0 = Date.now(), ac = new AbortController(), to = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await callModelSingle(p, 'You are a connection test. Answer with one word.', [{ role: 'user', content: 'Reply with the word ok.' }], [], ac.signal, null, null, true); // the provider under test itself, never a Copilot substitute
    clearTimeout(to); pdMsg('Works. The model answered "' + (stripThink(r.text).slice(0, 60) || '(empty)') + '" in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.');
  } catch (e) { clearTimeout(to); pdMsg(e.name === 'AbortError' ? 'No answer after 30 seconds.' : netHint(e), true); }
};
$('pdCancel').onclick = () => $('provDlg').close();
$('pdSave').onclick = () => {
  let p; try { p = pdRead(); } catch (e) { pdMsg(e.message, true); return; }
  const i = S.providers.findIndex(x => x.id === p.id), old = i >= 0 ? S.providers[i] : null;
  if (old && old.models && old.base === p.base && old.key === p.key) { p.models = old.models; p.modelCapabilities = old.modelCapabilities || {}; p.modelsAt = old.modelsAt; p.modelCapabilitiesAt = old.modelCapabilitiesAt || 0; }
  if (pdFetched) { p.models = pdFetched; p.modelCapabilities = pdFetchedCapabilities || {}; p.modelsAt = Date.now(); p.modelCapabilitiesAt = Date.now(); }
  if (i >= 0) S.providers[i] = p; else { S.providers.push(p); S.activeId = p.id; S.copilotAuto = false; COPILOT_LAST_OK = ''; }
  touchS(); renderProviders(); $('provDlg').close();
  // With a new or changed key/address, list the provider's models now so the chat selector shows all of them.
  if (!pdFetched && (!old || old.base !== p.base || old.key !== p.key || !(p.models && p.models.length))) {
    refreshProviderModels(p.id, false).then(n => { if (n) addNote(p.name + ': ' + n + ' models are now in the model selector.'); renderProviders(); });
  }
};
$('provAdd').onclick = () => openProvEditor(null);
$('provRefresh').onclick = async () => { const b = $('provRefresh'); b.disabled = true; b.textContent = 'Refreshing…'; try { await refreshAllModels(true); addNote('Model lists refreshed.'); } finally { b.disabled = false; b.textContent = 'Refresh models'; } };

const pushConfig = () => bcall('/config/set', { app: S }).catch(() => {});
$('cfgExport').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: S }, null, 2)], { type: 'application/json' }));
  a.download = 'my-agent-settings.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('cfgImport').onclick = () => $('cfgFile').click();
$('cfgFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const o = JSON.parse(await f.text()), app = o.app || o;
    if (!Array.isArray(app.providers) || !app.providers.length) throw new Error('No providers found in that file');
    app.providers.forEach(p => { if (!p.id) p.id = uid(); if (!p.ctx) p.ctx = DEFAULT_CTX; });
    S = migrate({ ...S, ...app, v: app.v || 0, updated: Date.now() }); if (!S.providers.some(p => p.id === S.activeId)) S.activeId = S.providers[0].id;
    saveLocal(); pushConfig(); applyTheme(); fillQuick(); syncMode(); updateMeters(); renderProviders(); dlg.close(); addNote('Settings imported');
  } catch (er) { $('settingsErr').textContent = 'Could not import: ' + er.message; }
};

/* ================= bridge connect + sync ================= */
async function syncConfig() {
  const r = await bcall('/config/get');
  if (r.app && Array.isArray(r.app.providers) && r.app.providers.length && (r.app.updated || 0) > (S.updated || 0)) {
    S = migrate({ ...S, ...r.app, v: r.app.v || 0 }); if (!S.providers.some(p => p.id === S.activeId)) S.activeId = S.providers[0].id;
    S.providers.forEach(p => { if (!p.ctx) p.ctx = DEFAULT_CTX; }); saveLocal(); applyTheme();
  } else if (!r.app || (S.updated || 0) > (r.app.updated || 0)) { if (S.updated) pushConfig(); }
}
async function syncSessions() {
  const remote = (await bcall('/sessions/list')).sessions || [];
  for (const rs of remote) {
    const loc = sessions.find(x => x.id === rs.id);
    if (!loc || rs.updated > loc.updated) {
      try { const full = (await bcall('/sessions/get', { id: rs.id })).session; if (!loc) sessions.push({ ...full, id: rs.id, messages: full.messages || [], usage: full.usage || null, plan: full.plan || [], costEntries: full.costEntries || [] }); else Object.assign(loc, full, { id: rs.id, plan: full.plan || loc.plan || [], costEntries: full.costEntries || loc.costEntries || [] }); } catch {}
    }
  }
  const have = new Set(remote.map(r => r.id));
  sessions.filter(s => s.messages.length && !have.has(s.id)).slice(0, 30).forEach(s => bcall('/sessions/save', { id: s.id, session: stripSession(s) }).catch(() => {}));
  if (!ctrl) { renderHistory(); saveSessionsLocal(); }
}
const bridgeLabel = () => (B.ok ? '● Bridge: ' + (B.info.root ? B.info.root.split(/[\\/]/).filter(Boolean).pop() : 'no folder open') : '○ Bridge: not connected');

/* ---- Bridge auto-reconnect ------------------------------------------------------------
   Remote providers (Render free instances, Codespaces) restart or sleep, and mobile networks
   drop. Previously the bridge connected only at boot / settings-save, so any later drop left
   it stuck until the user reconnected by hand. This watcher checks a lightweight remote-only
   endpoint and re-runs connectBridge() with backoff whenever the link is lost. */
const bridgeWatch = { timer: 0, tries: 0, busy: false, nextAt: 0 };
const BRIDGE_WATCH_MS = 8000;
function startBridgeWatch() {
  if (bridgeWatch.timer) return;
  bridgeWatch.timer = setInterval(bridgeWatchTick, BRIDGE_WATCH_MS);
}
async function bridgeWatchTick() {
  // Local mode has no server connection to lose; UWB WebSocket mode has its own reconnect.
  if (!L.bridgeToken || L.bridgeUrl === 'codespace-native://local' ||
      L.bridgeUrl.startsWith('ws://') || L.bridgeUrl.startsWith('wss://')) return;
  // Never fight an in-flight connect or an active agent task.
  if (bridgeWatch.busy || (typeof ctrl !== 'undefined' && ctrl)) return;
  if (document.hidden) return; // no need to churn while the app is backgrounded

  if (B.ok) {
    // /bridge/status is not a local-routed file endpoint, so this always checks the remote.
    try {
      const st = await bcall('/bridge/status', {}, undefined);
      if (st) { bridgeWatch.tries = 0; bridgeWatch.nextAt = 0; return; } // healthy
    } catch {
      B.ok = false; B.info = null; B.skills = []; B.ext = []; B.conn = {};
      bridgeWatch.nextAt = 0; afterBridge();
    }
  }

  // Lost (or never connected): reconnect, spacing retries with capped exponential backoff.
  if (Date.now() < bridgeWatch.nextAt) return;
  bridgeWatch.busy = true;
  try {
    const ok = await connectBridge();
    if (ok) { bridgeWatch.tries = 0; bridgeWatch.nextAt = 0; }
    else {
      const delay = Math.min(BRIDGE_WATCH_MS * Math.pow(2, bridgeWatch.tries), 120000);
      bridgeWatch.tries = Math.min(bridgeWatch.tries + 1, 8);
      bridgeWatch.nextAt = Date.now() + delay;
    }
  } catch {
    const delay = Math.min(BRIDGE_WATCH_MS * Math.pow(2, bridgeWatch.tries), 120000);
    bridgeWatch.tries = Math.min(bridgeWatch.tries + 1, 8);
    bridgeWatch.nextAt = Date.now() + delay;
  } finally {
    bridgeWatch.busy = false;
  }
}

function afterBridge() {
  $('sbBridge').textContent = bridgeLabel();
  if (!B.ok) { closeTab('preview', true); hideTerminal(); }
  exp.open = new Set(['']); refreshExplorer(); fillTermShells(); renderSkills(); renderExt(); updateConnUI(); fillQuick(); renderSessions(); updateMeters();
  gitRefresh();
  if ($('cpAuto')) $('cpAuto').checked = S.autoCheckpoint !== false;
  if (curView === 'checkpoints') refreshCheckpoints();
  if (B.ok) { refreshTerms(); if (B.ext.some(e => e.status === 'stopped' || e.status === 'starting')) { extTries = 0; setTimeout(refreshExtUI, 3000); } }
  syncOpenCodeUI();
  if (B.ok && S.chatZaiCLI && typeof resumeChatZaiMode === 'function') resumeChatZaiMode().catch(e => { console.warn('Chat Z.ai resume failed:', e); });
}
async function connectBridge() {
  // Keep the watcher alive for the whole session so a later drop can self-heal.
  startBridgeWatch();
  if (!L.bridgeToken) { B.ok = false; B.info = null; B.skills = []; B.ext = []; B.conn = {}; afterBridge(); return false; }
  try { B.info = await bcall('/info'); B.ok = true; } catch { B.ok = false; B.info = null; }
  if (B.ok) await Promise.allSettled([syncConfig(), syncSessions(), refreshSkills(), refreshExt(), refreshConn()]);
  else { B.skills = []; B.ext = []; B.conn = {}; }
  afterBridge(); return B.ok;
}

/* ================= codebase index panel ================= */
function codeStatusText(r) {
  if (!B.ok || !B.info || !B.info.root) return 'Connect the bridge and open a workspace to index code.';
  if (!r || !r.indexed) return 'No index yet. Build the source index to find symbols and dependencies.';
  const s = r.stats || {};
  return (r.stale ? 'Index stale — rebuild recommended. ' : 'Index ready. ') + (s.fileCount || 0) + ' files · ' + (s.symbolCount || 0) + ' symbols · ' + (s.resolvedImportCount || 0) + '/' + (s.importCount || 0) + ' imports resolved' + (s.complete ? '' : ' · partial index') + (r.staleReason ? ' · ' + r.staleReason : '');
}
async function refreshCodeIndexStatus() {
  if (!B.ok || !B.info || !B.info.root) { $('codeIndexStatus').textContent = codeStatusText(null); return; }
  $('codeIndexStatus').textContent = 'Checking code index…';
  try { const r = await bcall('/index/status'); $('codeIndexStatus').textContent = codeStatusText(r); }
  catch (e) { $('codeIndexStatus').textContent = 'Could not read index status: ' + e.message; }
}
async function rebuildCodeIndex() {
  if (!B.ok || !B.info || !B.info.root) { $('codeIndexStatus').textContent = 'Connect the bridge and open a workspace first.'; return; }
  const btn = $('codeIndexBuild'); btn.disabled = true; btn.textContent = 'Indexing…'; $('codeIndexStatus').textContent = 'Scanning supported source files. Large projects may take a moment…';
  try {
    const r = await bcall('/index/rebuild'); const s = r.stats || {};
    $('codeIndexStatus').textContent = 'Indexed ' + (s.fileCount || 0) + ' files, ' + (s.symbolCount || 0) + ' symbols, ' + (s.resolvedImportCount || 0) + '/' + (s.importCount || 0) + ' resolved imports.' + (s.complete ? '' : ' WARNING: partial index; see skipped file/size limits.') + ' Sensitive files and dependency/build folders were excluded.';
  } catch (e) { $('codeIndexStatus').textContent = 'Index build failed: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Index / Rebuild project'; }
}
function renderCodeResults(items, heading) {
  const box = $('codeResults'); box.innerHTML = '';
  const title = document.createElement('h4'); title.textContent = heading; box.appendChild(title);
  if (!items || !items.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No results found. Try a symbol name, a different concept, or rebuild the index.'; box.appendChild(p); return; }
  for (const item of items) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'li'; row.style.width = '100%'; row.style.textAlign = 'left'; row.style.background = 'transparent'; row.style.color = 'inherit'; row.style.borderLeft = '0'; row.style.borderRight = '0';
    row.style.cursor = 'pointer';
    const wrap = document.createElement('div'); wrap.style.minWidth = '0'; wrap.style.width = '100%';
    const head = document.createElement('b'); head.textContent = (item.path || '') + (item.line ? ':' + item.line : '') + (item.kind ? ' · ' + item.kind : '') + (item.score !== undefined ? ' · score ' + item.score : ''); head.style.display = 'block'; head.style.fontSize = '11px'; head.style.overflowWrap = 'anywhere';
    const snippet = document.createElement('span'); snippet.textContent = item.text || item.name || ''; snippet.style.display = 'block'; snippet.style.fontSize = '12px'; snippet.style.color = 'var(--muted)'; snippet.style.whiteSpace = 'normal'; snippet.style.overflowWrap = 'anywhere';
    wrap.append(head, snippet); row.appendChild(wrap);
    row.onclick = async () => {
      if (item.kind === 'directory') { $('codeSearchStatus').textContent = item.path + ' contains ' + (String(item.text || '').match(/\d+/) || ['0'])[0] + ' indexed source file(s). Use a concept or symbol query to inspect code in this directory.'; return; }
      try { await openFile(item.path, { focus: true }); } catch (e) { $('codeSearchStatus').textContent = e.message; }
    };
    box.appendChild(row);
  }
}
async function searchCodeIndex() {
  const query = $('codeQuery').value.trim();
  if (!query) { $('codeSearchStatus').textContent = 'Enter a search concept or symbol name.'; return; }
  if (!B.ok || !B.info || !B.info.root) { $('codeSearchStatus').textContent = 'Connect the bridge and open a workspace first.'; return; }
  $('codeSearchBtn').disabled = true; $('codeSearchStatus').textContent = 'Searching indexed code…';
  try { const r = await bcall('/index/search', { query, limit: 15 }); $('codeSearchStatus').textContent = r.results.length + ' result(s). ' + (r.indexed.complete ? 'Index is complete within configured limits.' : 'Index is partial; rebuild or inspect limits.'); renderCodeResults(r.results, 'Search results'); await refreshCodeIndexStatus(); }
  catch (e) { $('codeSearchStatus').textContent = e.message; }
  finally { $('codeSearchBtn').disabled = false; }
}
async function showCodeProjectMap() {
  if (!B.ok || !B.info || !B.info.root) { $('codeSearchStatus').textContent = 'Connect the bridge and open a workspace first.'; return; }
  $('codeMapBtn').disabled = true; $('codeSearchStatus').textContent = 'Building project map…';
  try {
    const r = await bcall('/index/map'); const items = (r.topDirectories || []).map(d => ({ path: d.path, text: d.count + ' indexed source files in directory', kind: 'directory' })).concat((r.symbols || []).slice(0, 25).map(s => ({ path: s.path, line: s.line, name: s.name, text: s.text, kind: s.kind })));
    $('codeSearchStatus').textContent = (r.stats.fileCount || 0) + ' files · ' + (r.stats.symbolCount || 0) + ' symbols · ' + (r.stats.resolvedImportCount || 0) + ' resolved imports.';
    renderCodeResults(items, 'Project map: directories and symbols'); await refreshCodeIndexStatus();
  } catch (e) { $('codeSearchStatus').textContent = e.message; }
  finally { $('codeMapBtn').disabled = false; }
}

/* ================= activity bar, composer, boot ================= */
