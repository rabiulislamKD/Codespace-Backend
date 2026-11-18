const chat = $('chat');
let ui = { turn: null, steps: null, map: new Map(), first: true, msgs: [] };
let chatAutoFollowActiveTurn = false, chatTouchStartY = null;
function chatIsNearBottom(tolerance = 100) { return chat.scrollHeight - chat.scrollTop - chat.clientHeight < tolerance; }
// Keep new work visible above the composer. Extra bottom padding gives the active
// reply breathing room, while manual upward scrolling always wins.
function pinChatToLatest(force = false) {
  if (!force && !(chatAutoFollowActiveTurn && ctrl)) return;
  requestAnimationFrame(() => {
    if (!chat || (!force && !(chatAutoFollowActiveTurn && ctrl))) return;
    chat.scrollTop = chat.scrollHeight;
  });
}
function finishChatAutoFollow() {
  chatAutoFollowActiveTurn = false;
  pinChatToLatest(true);
}
chat.addEventListener('wheel', e => {
  if (e.deltaY < -4) chatAutoFollowActiveTurn = false;
  else if (e.deltaY > 4) setTimeout(() => { if (ctrl && chatIsNearBottom(80)) chatAutoFollowActiveTurn = true; }, 90);
}, { passive: true });
chat.addEventListener('touchstart', e => { chatTouchStartY = e.touches && e.touches.length ? e.touches[0].clientY : null; }, { passive: true });
chat.addEventListener('touchend', e => {
  if (chatTouchStartY == null || !e.changedTouches || !e.changedTouches.length) return;
  const dy = e.changedTouches[0].clientY - chatTouchStartY; chatTouchStartY = null;
  if (dy > 18) chatAutoFollowActiveTurn = false;
  else if (dy < -18) setTimeout(() => { if (ctrl && chatIsNearBottom(80)) chatAutoFollowActiveTurn = true; }, 90);
}, { passive: true });
chat.addEventListener('keydown', e => {
  if (['ArrowUp','PageUp','Home'].includes(e.key)) chatAutoFollowActiveTurn = false;
  else if (['ArrowDown','PageDown','End'].includes(e.key)) setTimeout(() => { if (ctrl && chatIsNearBottom(80)) chatAutoFollowActiveTurn = true; }, 50);
});

function stepMeta(call) {
  const a = call.args || {}, n = call.name, sh = (s, k = 60) => { s = String(s ?? ''); return s.length > k ? s.slice(0, k) + '…' : s; };
  switch (n) {
    case 'list_files': return { ic: '▤', t: 'Listed files', sub: a.path || '.' };
    case 'read_file': return { ic: '📄', t: 'Read', sub: a.path };
    case 'inspect_apk': return { ic: '📦', t: 'Inspected APK', sub: a.path };
    case 'extract_apk': return { ic: '🧰', t: 'Extracted APK', sub: a.path };
    case 'search_files': return { ic: '🔍', t: 'Searched for', sub: sh(a.query) };
    case 'write_file': return { ic: '✏️', t: 'Edited', sub: a.path };
    case 'update_plan': return { ic: '☷', t: 'Updated plan', sub: (a.steps || []).length + ' steps' };
    case 'edit_file': return { ic: '✏️', t: 'Edited', sub: a.path };
    case 'enable_tools': return { ic: '🧰', t: 'Turned on tools', sub: a.group };
    case 'run_command': return { ic: '⌨', t: a.background ? 'Started in background' : 'Ran command', sub: sh(a.command, 90) };
    case 'terminal_read': return { ic: '⌨', t: 'Read terminal output', sub: a.id };
    case 'run_js': return { ic: '⚡', t: 'Ran JavaScript', sub: sh(a.code, 70) };
    case 'browser_open': return { ic: '🌐', t: 'Opened page', sub: a.url };
    case 'browser_read': return { ic: '🌐', t: 'Read the page', sub: '' };
    case 'browser_screenshot': return { ic: '📷', t: 'Took a screenshot', sub: '' };
    case 'browser_click': return { ic: '🖱', t: 'Clicked', sub: a.selector || ('x ' + a.x + ', y ' + a.y) };
    case 'browser_type': return { ic: '⌨', t: 'Typed', sub: sh(a.text, 40) + ' into ' + a.selector };
    case 'browser_scroll': return { ic: '↕', t: 'Scrolled', sub: a.to || (a.pixels + ' px') };
    case 'browser_run_js': return { ic: '⚡', t: 'Ran JavaScript in page', sub: sh(a.code, 70) };
    case 'browser_console': return { ic: '▤', t: 'Read page console', sub: a.all ? 'all messages' : 'new messages' };
    case 'browser_network': return { ic: '⇅', t: 'Read network requests', sub: a.filter ? 'matching ' + sh(a.filter, 30) : (a.failed_only ? 'failed requests' : (a.all ? 'all requests' : 'new requests')) };
    case 'load_skill': return { ic: '✦', t: 'Loaded skill', sub: a.name };
    case 'install_skill': return { ic: '✦', t: 'Installed skill', sub: a.source };
    case 'codespace_locate_installation': return { ic: '⌕', t: 'Located CodeSpace installation', sub: 'Install root and source-file inventory' };
    case 'codespace_runtime_check': return { ic: '⚙', t: 'Checked CodeSpace runtime', sub: 'Bridge, tools, processes and install paths' };
    case 'install_tool': return { ic: '⬇', t: 'Installed tool', sub: a.source || a.command };
    case 'github_api': return { ic: '🐙', t: 'GitHub', sub: (a.method || 'GET') + ' ' + a.path };
    case 'vercel_api': return { ic: '▲', t: 'Vercel', sub: (a.method || 'GET') + ' ' + a.path };
    case 'mysql_query': return { ic: '🗄', t: 'MySQL', sub: sh(a.sql, 90) };
    /* ---- 3.10 tools ---- */
    case 'web_search': return { ic: '🔎', t: 'Searched the web', sub: sh(a.query, 70) };
    case 'web_open': case 'web_fetch': return { ic: '🌐', t: 'Fetched page', sub: sh(a.url, 80) };
    case 'web_extract': return { ic: '📃', t: 'Extracted page', sub: sh(a.url, 80) };
    case 'web_find': return { ic: '🔍', t: 'Found in page', sub: sh(a.query, 60) };
    case 'web_crawl': return { ic: '🕸', t: 'Crawled site', sub: sh(a.url, 80) };
    case 'web_screenshot': return { ic: '📷', t: 'Screenshot of site', sub: sh(a.url, 80) };
    case 'http_request': case 'api_test': return { ic: '⇅', t: (a.method || 'GET').toUpperCase() + ' request', sub: sh(a.url, 90) };
    case 'api_collection': return { ic: '🗂', t: 'API collection · ' + (a.action || 'list'), sub: a.name || a.id || '' };
    case 'inspect_response': return { ic: '🔬', t: 'Inspected response', sub: a.path || a.search || '' };
    case 'run_tests': return { ic: '🧪', t: a.command ? 'Ran tests' : 'Discovered tests', sub: a.command || '' };
    case 'get_diagnostics': return { ic: '🩺', t: 'Ran diagnostics', sub: a.tool || 'auto' };
    case 'lint_project': return { ic: '🧹', t: 'Linted project', sub: a.tool || 'auto' };
    case 'format_code': return { ic: '✨', t: 'Formatted code', sub: a.tool || 'auto' };
    case 'dependency_analysis': return { ic: '📦', t: 'Analyzed dependencies', sub: a.audit ? 'with npm audit' : '' };
    case 'find_unused_code': return { ic: '🧭', t: 'Found unused symbols', sub: '' };
    case 'inspect_package': return { ic: '📦', t: 'Inspected package', sub: a.name };
    case 'project_health_check': return { ic: '💚', t: 'Project health check', sub: '' };
    case 'multi_edit': return { ic: '✏️', t: 'Multi-file edit', sub: (a.edits || []).length + ' edit(s)' };
    case 'rename_symbol': return { ic: '✏️', t: 'Renamed symbol', sub: a.symbol + ' → ' + a.new_name };
    case 'undo_file': return { ic: '↩', t: 'Undo file', sub: a.path };
    case 'redo_file': return { ic: '↪', t: 'Redo file', sub: a.path };
    case 'file_history': return { ic: '🕓', t: 'File history', sub: a.path };
    case 'delegate_subtask': return { ic: '👥', t: 'Delegated to ' + (a.role || 'sub-agent'), sub: sh(a.task, 70) };
    case 'task_create': return { ic: '📌', t: 'Started background task', sub: a.kind };
    case 'sandbox_create': return { ic: '📦', t: 'Created sandbox', sub: (a.profile || a.provider || '') + (a.networkPolicy && a.networkPolicy !== 'none' ? ' · net:' + a.networkPolicy : ' · net:off') };
    case 'sandbox_exec': return { ic: '⚙️', t: 'Executed in sandbox', sub: String(a.command || '').slice(0, 80) };
    case 'sandbox_export_apply': return { ic: '📥', t: 'Applied sandbox changes', sub: a.id };
    case 'sandbox_destroy': return { ic: '🧹', t: 'Destroyed sandbox', sub: a.id };
    case 'task_list': return { ic: '📌', t: 'Listed tasks', sub: '' };
    case 'task_cancel': return { ic: '⏹', t: 'Cancelled task', sub: a.id };
    case 'task_retry': return { ic: '🔁', t: 'Retried task', sub: a.id };
    case 'update_server_permissions': return { ic: '🛡', t: 'Updated server permissions', sub: Object.keys(a).join(', ') };
    case 'browser_hover': return { ic: '🖱', t: 'Hovered', sub: a.selector || ('x ' + a.x + ', y ' + a.y) };
    case 'browser_select': return { ic: '▾', t: 'Selected option', sub: a.value + ' in ' + a.selector };
    case 'browser_upload': return { ic: '📎', t: 'Uploaded files', sub: (Array.isArray(a.files) ? a.files.join(', ') : a.file) || '' };
    case 'browser_download': return { ic: '⬇', t: 'Downloaded', sub: a.selector || a.url || '' };
    case 'browser_press_key': case 'browser_key': return { ic: '⌨', t: 'Pressed key', sub: [a.key, a.ctrl && 'ctrl', a.alt && 'alt', a.shift && 'shift', a.meta && 'meta'].filter(Boolean).join('+') };
    case 'browser_wait': return { ic: '⏳', t: 'Waited for page', sub: a.selector ? sh(a.selector, 50) : (a.text ? 'text: ' + sh(a.text, 40) : '') };
    case 'browser_dom_snapshot': return { ic: '🌳', t: 'DOM snapshot', sub: '' };
    case 'browser_accessibility_tree': return { ic: '🌳', t: 'Accessibility tree', sub: '' };
    default: return n.startsWith('ext_') ? { ic: '🧩', t: 'Extension', sub: n.replace(/^ext_/, '') } : { ic: '•', t: n, sub: sh(JSON.stringify(a), 70) };
  }
}
function buildStep(call, meta) {
  const m = meta || stepMeta(call), el = document.createElement('div');
  el.className = 'step'; if (call.id) el.dataset.id = call.id;
  el.innerHTML = '<div class="step-head" role="button" tabindex="0"><span class="st"><span class="spin"></span></span><span class="step-title">' + esc(m.t) + '</span><span class="step-sub">' + esc(m.sub || '') + '</span><span class="badges"></span></div><div class="step-body"></div>';
  const head = el.firstChild, toggle = () => el.classList.toggle('open');
  head.onclick = toggle; head.onkeydown = e => { if (e.key === 'Enter') toggle(); };
  return el;
}
function fillStep(el, call, tm) {
  const st = tm.st || 'ok', stEl = el.querySelector('.st');
  stEl.className = 'st ' + st; stEl.textContent = ''; /* 3.13.1: status is drawn by CSS as a colored point — no glyph */
  const body = el.querySelector('.step-body'), badges = el.querySelector('.badges');
  if (tm.diff) {
    badges.innerHTML = '<span class="badge add">+' + tm.diff.add + '</span><span class="badge del">−' + tm.diff.del + '</span>';
    body.innerHTML = renderDiff(tm.diff);
  } else if (call.name === 'run_command' || call.name === 'terminal_read') {
    const a = call.args || {};
    body.innerHTML = '<pre class="term">' + esc((a.command ? '$ ' + a.command + '\n' : '') + clip(tm.content || '', 8000)) + '</pre>';
  } else {
    body.innerHTML = '<pre>' + esc(clip(tm.content || '', 8000)) + '</pre>';
  }
  if (tm.ms >= 500) badges.insertAdjacentHTML('beforeend', '<span class="badge">' + (tm.ms / 1000).toFixed(1) + 's</span>');
  if (tm.undo) {
    if (tm.kept) badges.insertAdjacentHTML('beforeend', '<span class="badge">Kept</span>');
    else if (tm.undone) { badges.insertAdjacentHTML('beforeend', '<span class="badge">Undone</span>'); body.style.opacity = '.55'; }
    else {
      const u = document.createElement('button'); u.type = 'button'; u.className = 'btn sm undo'; u.textContent = 'Undo'; u.title = 'Restore the file as it was before this edit'; u.onclick = e => { e.stopPropagation(); undoStep(tm); }; badges.appendChild(u);
      const k = document.createElement('button'); k.type = 'button'; k.className = 'btn sm'; k.textContent = 'Keep'; k.title = 'Keep this edit and remove its Undo action'; k.onclick = e => { e.stopPropagation(); keepStep(tm); }; badges.appendChild(k);
    }
  }
  if (tm.image) { const im = document.createElement('img'); im.src = tm.image; im.alt = 'Screenshot'; body.appendChild(im); }
  if (st === 'err') el.classList.add('open');
}
function stepsSummary(box) {
  const items = [...box.querySelectorAll('.step')], n = items.length;
  const cnt = k => items.filter(s => s.dataset.kind === k).length;
  const bits = [n + (n === 1 ? ' step' : ' steps')];
  const e = cnt('edit'), c = cnt('cmd'), b = cnt('browser');
  if (e) bits.push(e + (e === 1 ? ' file edited' : ' files edited'));
  if (c) bits.push(c + (c === 1 ? ' command' : ' commands'));
  if (b) bits.push(b + ' browser');
  const running = items.some(s => s.querySelector('.spin'));
  box.querySelector(':scope > summary').innerHTML = (running ? '<span class="spin"></span><span class="shimmer">Working</span><span> · </span>' : '') + esc(bits.join(' · '));
}
function ensureTurn() {
  if (!ui.turn) { ui.turn = document.createElement('div'); ui.turn.className = 'turn'; chat.appendChild(ui.turn); ui.first = true; ui.steps = null; }
  return ui.turn;
}
function ensureSteps(live) {
  const turn = ensureTurn();
  if (!ui.steps) {
    const d = document.createElement('details'); d.className = 'steps'; d.open = !!live;
    d.innerHTML = '<summary></summary>'; turn.appendChild(d); ui.steps = d;
  }
  return ui.steps;
}
function addAssistantText(turn, text, model) {
  const el = document.createElement('div'); el.className = 'amsg';
  el.innerHTML = (ui.first ? '<div class="avatar" aria-hidden="true"></div>' : '<div class="avatar" style="visibility:hidden"></div>') +
    '<div class="abody">' + (ui.first ? '<div class="who">Agent<span>' + esc(model || '') + '</span></div>' : '') + md(text) + '</div>';
  // 3.13.1: Copy action on every AI reply (copies the raw markdown text, not the rendered HTML); text-only button
  const acts = document.createElement('div'); acts.className = 'aactions';
  const copy = document.createElement('button'); copy.className = 'uact'; copy.type = 'button';
  copy.textContent = 'Copy'; copy.title = 'Copy this reply';
  copy.onclick = () => copyMessageText(copy, text);
  acts.appendChild(copy); el.querySelector('.abody').appendChild(acts);
  ui.first = false; turn.appendChild(el);
}
/* 3.13.0 message actions: Edit loads the text into the composer only; Copy writes the raw
   text to the clipboard with a graceful fallback for non-secure contexts. */
function editMessageOnly(msg) {
  if (ctrl) { addErr('Stop the current run before editing a previous message.'); return; }
  const content = String(msg.content || '');
  const input = $('input');
  input.value = content; autoSize();
  try { input.focus(); input.setSelectionRange(content.length, content.length); } catch { try { input.focus(); } catch {} }
  addNote('Message loaded into the composer — edit it and press Send when ready.');
}
function copyMessageText(btn, text) {
  const done = ok => {
    if (!btn) return;
    btn.classList.toggle('is-copied', !!ok);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.classList.remove('is-copied'); btn.textContent = 'Copy'; }, 1400);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea'); ta.value = String(text || '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); document.body.removeChild(ta); done(ok);
    } catch { done(false); }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(String(text || '')).then(() => done(true)).catch(fallback);
  } else fallback();
}
function addNarration(box, text) { const d = document.createElement('div'); d.className = 'nrow narr'; d.innerHTML = md(text); box.appendChild(d); }
function liveBegin() {
  // The unified activity line is the only live indicator. Do not stream model reasoning,
  // private context, or raw partial answers into a second large chat card.
  const t0 = Date.now(); let last = null;
  return {
    update(a) { last = a; },
    end() { return Date.now() - t0; },
    latest() { return last; }
  };
}
function kindOf(name) { return (name === 'write_file' || name === 'edit_file') ? 'edit' : (name === 'run_command' || name === 'terminal_read') ? 'cmd' : name.startsWith('browser_') ? 'browser' : 'other'; }
function isInternalAgentMessage(m) { return !!(m && m.agentMeta && ['preflight', 'qa-review', 'auto-resume'].includes(m.agentMeta.type)); }
function appendItem(m, live) {
  // Keep coordinator/reviewer messages in the model transcript, not in the user-facing chat.
  if (isInternalAgentMessage(m)) return;
  const followChat = m.role === 'user' || chatAutoFollowActiveTurn || chatIsNearBottom();
  if (m.role !== 'user') ui.msgs.push(m);
  if (m.role === 'user') {
    finishTurn(); ui.turn = null; ui.steps = null; ui.msgs = [m]; const t = ensureTurn();
    const u = document.createElement('div'); u.className = 'umsg'; u.innerHTML = '<div class="uhead">You</div><div class="ubody"></div>'; u.querySelector('.ubody').textContent = m.content;
    (m.images || []).forEach(im => { if (!im || !im.dataUrl) return; const img = document.createElement('img'); img.className = 'user-image'; img.src = im.dataUrl; img.alt = im.name || 'Attached image'; img.title = im.name || 'Attached image'; u.appendChild(img); });
    // 3.13.0: Edit only loads the message back into the composer (no auto-regenerate, no
    // history removal). Copy puts the raw message text on the clipboard.
    const acts = document.createElement('div'); acts.className = 'uactions';
    const edit = document.createElement('button'); edit.className = 'uact'; edit.type = 'button';
    edit.textContent = 'Edit'; edit.title = 'Put this message back into the composer so you can edit it';
    edit.onclick = () => editMessageOnly(m);
    const copy = document.createElement('button'); copy.className = 'uact'; copy.type = 'button';
    copy.textContent = 'Copy'; copy.title = 'Copy this message';
    copy.onclick = () => copyMessageText(copy, m.content);
    acts.append(edit, copy); u.appendChild(acts); t.appendChild(u);
  } else if (m.role === 'summary') {
    const d = document.createElement('details'); d.className = 'steps';
    d.innerHTML = '<summary>Earlier conversation was summarized to save context</summary><div class="step-body" style="display:block;border-top:1px solid var(--line)">' + md(m.content) + '</div>';
    ensureTurn().appendChild(d); ui.steps = null;
  } else if (m.role === 'assistant') {
    const turn = ensureTurn(), sp = splitThink(m.content), hasTools = !!(m.toolCalls && m.toolCalls.length);
    const text = sp.text;
    // Never render raw model reasoning as a persistent chat block. The one-word activity
    // indicator is temporary; the chat keeps only the user-facing answer and tool steps.
    if (hasTools) {
      const box = ensureSteps(live);
      if (text) addNarration(box, text);
      m.toolCalls.forEach(c => { const s = buildStep(c); s.dataset.kind = kindOf(c.name); ui.map.set(c.id, { el: s, call: c }); box.appendChild(s); });
      stepsSummary(box);
    } else {
      if (text) addAssistantText(turn, text, m.model);
      ui.steps = null;
    }
  } else if (m.role === 'tool') {
    const ent = ui.map.get(m.toolCallId);
    if (ent) { fillStep(ent.el, ent.call, m); const box = ent.el.closest('.steps'); if (box) stepsSummary(box); }
  }
  if (followChat) pinChatToLatest(true);
  
}
function addNote(text) { const follow = chatIsNearBottom(); const d = document.createElement('div'); d.className = 'note'; d.textContent = text; chat.appendChild(d); if (follow) chat.scrollTop = chat.scrollHeight; ui.turn = null; ui.steps = null;  }
function addErr(text) { const follow = chatIsNearBottom(); const d = document.createElement('div'); d.className = 'errmsg'; d.textContent = text; chat.appendChild(d); if (follow) chat.scrollTop = chat.scrollHeight;  }
function collapseSteps() { chat.querySelectorAll('details.steps[open]').forEach(d => { d.open = false; stepsSummary(d); }); }
let historyVisible = 80, historyLoading = false;
function loadOlderMessages() {
  if (historyLoading) return;
  const h = hist(); if (historyVisible >= h.length) return;
  historyLoading = true; const heightBefore = chat.scrollHeight, topBefore = chat.scrollTop;
  historyVisible = Math.min(h.length, historyVisible + 80); renderHistory();
  chat.scrollTop = Math.max(0, chat.scrollHeight - heightBefore + topBefore);
  requestAnimationFrame(() => { historyLoading = false; });
}
function renderHistory() {
  // Live status widgets are reattached to the active/last turn after transcript rebuild.
  const planPanel = $('planPanel');
  if (planPanel && chat.contains(planPanel)) chat.parentElement.insertBefore(planPanel, chat);
  const activityPanel = $('maActivityPanel');
  // Keep the animated activity bubble alive if history is redrawn during an active multi-agent turn.
  const keepActivityVisible = !!(activityPanel && maActivityState.visible && !maActivityState.dismissed && ctrl && !ctrl.signal.aborted);
  if (activityPanel && chat.contains(activityPanel)) {
    if (maActivityHideTimer) { clearTimeout(maActivityHideTimer); maActivityHideTimer = null; }
    if (maActivityExitTimer) { clearTimeout(maActivityExitTimer); maActivityExitTimer = null; }
    activityPanel.classList.remove('is-leaving'); activityPanel.hidden = true;
    if (!keepActivityVisible) maActivityState.visible = false;
    chat.parentElement.insertBefore(activityPanel, chat);
  }
  chat.innerHTML = ''; ui = { turn: null, steps: null, map: new Map(), first: true, msgs: [] };
  const h = hist();
  if (!h.length) {
    chat.innerHTML = '<div class="empty"><h3>Ask the agent</h3><div class="suggs"><button class="btn sugg" type="button" data-p="Explain how this project is structured">Explain this project</button><button class="btn sugg" type="button" data-p="Find and fix bugs in this project">Find and fix bugs</button><button class="btn sugg" type="button" data-p="Write tests for the main code and run them">Write and run tests</button></div></div>';
  } else {
    let start = Math.max(0, h.length - historyVisible);
    while (start > 0 && h[start] && h[start].role !== 'user') start--;
    for (let i = start; i < h.length; i++) appendItem(h[i], false);
    if (start > 0) {
      const older = document.createElement('button'); older.className = 'btn sm load-older'; older.style.margin = '8px'; older.textContent = 'Load older messages (' + start + ' hidden)';
      older.onclick = loadOlderMessages;
      chat.insertBefore(older, chat.firstChild);
    }
    collapseSteps(); finishTurn();
  }
  $('chatTitle').textContent = cur().title;
  renderPlanPanel();
  if (keepActivityVisible && activityPanel) {
    maActivityState.visible = true;
    activityPanel.hidden = false;
    placeMultiAgentActivityUnderUser();
    renderMultiAgentActivity();
  }
  chat.scrollTop = chat.scrollHeight;
}
chat.addEventListener('scroll', () => { if (chat.scrollTop < 24 && chat.querySelector('.load-older') && !historyLoading) loadOlderMessages(); }, { passive: true });
chat.addEventListener('click', e => {
  const b = e.target.closest('.copy'); if (!b) return;
  const code = b.closest('.cb').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); }).catch(() => {});
});

/* ================= model + context meters ================= */
