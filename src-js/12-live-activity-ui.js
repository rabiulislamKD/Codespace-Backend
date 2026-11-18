const MA_ACTIVITY_ROLES = [
  { id: 'planner', name: 'Planner' },
  { id: 'architect', name: 'Architect' },
  { id: 'researcher', name: 'Researcher' },
  { id: 'test', name: 'QA Engineer' },
  { id: 'implementer', name: 'Coder' },
  { id: 'debugger', name: 'Debugger' },
  { id: 'reviewer', name: 'Reviewer' }
];
let maActivityState = { visible: false, dismissed: false, stages: [] };
let maActivityCursor = 0, maActivityTicker = null, maActivityDisplayedId = '', maActivitySwitchTimer = null;
let maActivityHideTimer = null, maActivityExitTimer = null;
let maActivityStartedAt = 0, maActivityGeneration = 0;
const maActivityTerminalTimers = new Map();
const MA_ACTIVITY_MIN_SPINNER_MS = 650;
/* ---- 3.13.0 live process feed: every line stays, full text is readable, the feed only
   clears when the next run starts — never while the model is still working. ---- */
const ACTIVITY_SHOW_REASONING = true;   // false = show a plain "Thinking…" line instead of a live reasoning snippet
const MA_FEED_MAX_ROWS = 400;           // safety bound only; runs never come close. Old 6-row cap removed in 3.13.0.
const MA_FEED_MAX_CHARS = 4000;         // per-line bound for DOM sanity; ~25x more readable text than before
const maFeed = { rows: new Map(), seq: 0, lastText: '', lastId: 0, stageRows: new Map(), progId: 0, liveRowId: 0 };
function feedClear() {
  maFeed.rows.clear(); maFeed.stageRows.clear(); maFeed.lastText = ''; maFeed.lastId = 0; maFeed.progId = 0; maFeed.liveRowId = 0;
  const el = $('maActivityFeed'); if (el) el.textContent = '';
  const panel = $('maActivityPanel'); if (panel) panel.classList.remove('is-done');
}
function feedPinScroll() {
  const el = $('maActivityFeed'); if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
function feedPush(text, opts) {
  const el = $('maActivityFeed'); text = String(text || '').replace(/\s+$/g, '').trim();
  if (!el || !text) return 0;
  if (text.length > MA_FEED_MAX_CHARS) text = '…' + text.slice(-MA_FEED_MAX_CHARS);
  if (!(opts && opts.force) && text === maFeed.lastText && maFeed.rows.has(maFeed.lastId)) return maFeed.lastId;
  const row = document.createElement('div'); row.className = 'ma-feed-row is-live' + (opts && opts.think ? ' is-think' : '');
  const ico = document.createElement('span'); ico.className = 'ma-feed-ico';
  const txt = document.createElement('span'); txt.className = 'ma-feed-txt'; txt.textContent = text; txt.title = 'Full text of this step';
  row.append(ico, txt); el.appendChild(row);
  const id = ++maFeed.seq; maFeed.rows.set(id, { el: row, txt, t0: Date.now() });
  maFeed.lastText = text; maFeed.lastId = id;
  while (el.children.length > MA_FEED_MAX_ROWS) {
    const first = el.firstElementChild; el.removeChild(first);
    for (const [k, v] of maFeed.rows) if (v.el === first) { maFeed.rows.delete(k); break; }
  }
  feedPinScroll();
  if (chatIsNearBottom()) pinChatToLatest();
  return id;
}
function feedSet(id, text) {
  const r = maFeed.rows.get(id); text = String(text || '').replace(/\s+$/g, '').trim();
  if (text.length > MA_FEED_MAX_CHARS) text = '…' + text.slice(-MA_FEED_MAX_CHARS);
  if (!r || !text || r.txt.textContent === text) return;
  const wasLive = r.el.classList.contains('is-live');
  r.txt.textContent = text; r.txt.title = 'Full text of this step';
  if (id === maFeed.lastId) maFeed.lastText = text;
  if (wasLive) feedPinScroll();
}
function feedEnd(id, status) {
  const r = maFeed.rows.get(id); if (!r || !r.el.classList.contains('is-live')) return;
  r.el.classList.remove('is-live'); r.el.classList.add(status === 'err' ? 'is-err' : status === 'skip' ? 'is-skip' : 'is-ok');
  const ms = Date.now() - r.t0;
  if (ms >= 1000) { const t = document.createElement('span'); t.className = 'ma-feed-time'; t.textContent = (ms / 1000).toFixed(1) + 's'; r.el.appendChild(t); }
  feedPinScroll();
}
function feedFinishAll(status) { for (const id of maFeed.rows.keys()) feedEnd(id, status); }
function feedStage(stage) {
  if (!stage || stage.id === 'assistant' || stage.id === 'implementer') return; // those are shown as per-round / per-tool lines
  const text = stage.name + (stage.detail ? ' · ' + stage.detail : '');
  let id = maFeed.stageRows.get(stage.id);
  if (!id || !maFeed.rows.has(id)) { if (stage.status === 'waiting') return; id = feedPush(text, { force: true }); maFeed.stageRows.set(stage.id, id); }
  else feedSet(id, text);
  if (stage.status === 'completed') feedEnd(id, 'ok');
  else if (stage.status === 'failed') feedEnd(id, 'err');
  else if (stage.status === 'cancelled') feedEnd(id, 'skip');
}
function reasoningSnippet(t) {
  // 3.13.0: show a long, readable tail of the reasoning instead of a 110-char crumb.
  // The live row updates in place, so the user can follow the thinking line by line.
  t = String(t || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim(); if (!t) return '';
  return t.length > 900 ? '…' + t.slice(-880) : t;
}
function toolFeedLabel(call) {
  const a = call.args || {}, n = call.name || 'tool', short = (v, m) => { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return v.length > (m || 60) ? v.slice(0, (m || 60) - 1) + '…' : v; };
  const path = short(a.path, 56);
  switch (n) {
    case 'read_file': return 'Reading ' + (path || 'file') + (a.start_line ? ' (lines ' + a.start_line + (a.end_line ? '–' + a.end_line : '+') + ')' : '');
    case 'list_files': return 'Listing ' + (path || 'project files');
    case 'search_files': return 'Searching for “' + short(a.query, 40) + '”';
    case 'edit_file': return 'Editing ' + (path || 'file');
    case 'write_file': return 'Writing ' + (path || 'file');
    case 'run_command': return 'Running ' + short(a.command, 64);
    case 'terminal_read': return 'Reading terminal output';
    case 'run_js': return 'Running JavaScript';
    case 'code_search': return 'Searching code for “' + short(a.query, 40) + '”';
    case 'find_symbol': return 'Finding symbol ' + short(a.query, 40);
    case 'symbol_references': return 'Finding references to ' + short(a.symbol, 40);
    case 'related_files': return 'Checking files related to ' + (path || 'file');
    case 'project_map': return 'Mapping the project';
    case 'codebase_index_status': return 'Checking code index';
    case 'codebase_index_rebuild': return 'Rebuilding code index';
    case 'browser_open': return 'Opening ' + short(a.url, 56);
    case 'browser_read': return 'Reading the page';
    case 'browser_screenshot': return 'Taking a screenshot';
    case 'browser_click': return 'Clicking ' + short(a.selector || (a.x != null ? a.x + ',' + a.y : 'element'), 40);
    case 'browser_type': return 'Typing into ' + short(a.selector, 40);
    case 'browser_scroll': return 'Scrolling the page';
    case 'browser_run_js': return 'Running JavaScript in the page';
    case 'browser_console': return 'Reading the page console';
    case 'browser_network': return 'Reading the network requests';
    case 'load_skill': return 'Loading skill ' + short(a.name, 40);
    case 'install_skill': return 'Installing skill';
    case 'codespace_locate_installation': return 'Locating CodeSpace installation';
    case 'codespace_runtime_check': return 'Checking CodeSpace runtime';
    case 'install_tool': return 'Installing tool';
    case 'update_plan': return 'Updating the plan';
    case 'enable_tools': return 'Enabling ' + short(a.group, 30) + ' tools';
    case 'github_api': return 'GitHub ' + short((a.method || 'GET') + ' ' + (a.path || ''), 56);
    case 'vercel_api': return 'Vercel ' + short((a.method || 'GET') + ' ' + (a.path || ''), 56);
    case 'mysql_query': return 'Querying the database';
    case 'web_search': return 'Searching the web for ' + short(a.query, 40);
    case 'web_open': case 'web_extract': case 'web_find': return 'Reading ' + short(a.url, 56);
    case 'web_crawl': return 'Crawling ' + short(a.url, 48);
    case 'web_screenshot': return 'Screenshotting ' + short(a.url, 48);
    case 'http_request': case 'api_test': return (a.method || 'GET').toUpperCase() + ' ' + short(a.url, 48);
    case 'api_collection': return 'API collection: ' + short(a.action || 'list', 12) + ' ' + short(a.name || a.id || '', 30);
    case 'inspect_response': return 'Inspecting the last response';
    case 'run_tests': return a.command ? 'Running tests: ' + short(a.command, 44) : 'Discovering test commands';
    case 'get_diagnostics': return 'Running diagnostics (' + short(a.tool || 'auto', 16) + ')';
    case 'lint_project': return 'Linting the project';
    case 'format_code': return 'Formatting code (' + short(a.tool || 'auto', 16) + ')';
    case 'dependency_analysis': return 'Analyzing dependencies';
    case 'find_unused_code': return 'Looking for unused code';
    case 'inspect_package': return 'Inspecting package ' + short(a.name, 40);
    case 'project_health_check': return 'Checking project health';
    case 'multi_edit': return 'Editing ' + ((a.edits || []).length) + ' place(s) across files';
    case 'rename_symbol': return 'Renaming ' + short(a.symbol, 30) + ' to ' + short(a.new_name, 30);
    case 'undo_file': return 'Undoing changes to ' + short(a.path, 44);
    case 'redo_file': return 'Re-applying changes to ' + short(a.path, 44);
    case 'file_history': return 'Reading history of ' + short(a.path, 44);
    case 'delegate_subtask': return 'Delegating to ' + short(a.role || 'sub-agent', 14) + ': ' + short(a.task, 40);
    case 'task_create': return 'Starting background ' + short(a.kind || 'task', 16) + ' task';
    case 'task_list': return 'Listing background tasks';
    case 'task_cancel': return 'Cancelling task ' + short(a.id, 18);
    case 'task_retry': return 'Retrying task ' + short(a.id, 18);
    case 'browser_hover': return 'Hovering over ' + short(a.selector || 'element', 40);
    case 'browser_select': return 'Selecting "' + short(a.value, 30) + '" in ' + short(a.selector, 30);
    case 'browser_upload': return 'Uploading files';
    case 'browser_download': return 'Downloading via ' + short(a.selector || a.url || 'page', 40);
    case 'browser_press_key': return 'Pressing ' + short(a.key || 'key', 14);
    case 'browser_wait': return 'Waiting for ' + short(a.selector || a.text || 'page', 40);
    case 'browser_dom_snapshot': return 'Taking a DOM snapshot';
    case 'browser_accessibility_tree': return 'Reading the accessibility tree';
    default: return n.replace(/_/g, ' ');
  }
}
// One model round: a "Thinking" line that turns into a live reasoning tail, then "Writing response".
// 3.13.0: the writing row keeps a long, readable tail of the answer text (not a 140-char crumb),
// so the user can actually read what the model is writing while it streams.
function feedRound(step) {
  let thinkId = feedPush(step > 1 ? 'Thinking about the next step' : 'Thinking', { think: true, force: true }), writeId = 0, lastAt = 0, sawReasoning = false;
  const t0 = Date.now();
  const beat = setInterval(() => {
    const idle = Math.round((Date.now() - (lastAt || t0)) / 1000);
    if (idle < 20) return;
    const label = (writeId ? 'Still writing your answer' : 'Still thinking') + ' · ' + idle + ' s elapsed';
    if (writeId) feedSet(writeId, label); else if (thinkId) feedSet(thinkId, label);
  }, 5000);
  return {
    update(a) {
      if (!a) return; const now = Date.now(); if (now - lastAt < 250) return; lastAt = now;
      const reasoning = a.reasoning || splitThink(a.text).think;
      const visible = a.text ? splitThink(a.text).text : '';
      if (reasoning && !visible && !(a.names && a.names.length) && ACTIVITY_SHOW_REASONING) { const snip = reasoningSnippet(reasoning); if (snip) { sawReasoning = true; feedSet(thinkId, snip); } }
      if (a.names && a.names.length) { const nm = String(a.names[a.names.length - 1] || '').replace(/_/g, ' '); if (nm) { if (thinkId) feedSet(thinkId, 'Preparing ' + nm); } }
      else if (visible && !writeId) { feedEnd(thinkId, 'ok'); thinkId = 0; writeId = feedPush('Writing response', { force: true }); }
      if (writeId && visible) { const tail = visible.replace(/\s+/g, ' ').trim(); if (tail) feedSet(writeId, 'Writing response · ' + (tail.length > 1500 ? '…' + tail.slice(-1480) : tail)); }
    },
    end(status) { clearInterval(beat); feedEnd(thinkId, status || 'ok'); feedEnd(writeId, status || 'ok'); }
  };
}
function beginActivityCycle() {
  for (const timer of maActivityTerminalTimers.values()) clearTimeout(timer);
  maActivityTerminalTimers.clear();
  maActivityStartedAt = Date.now(); maActivityGeneration++;
  startMaElapsedTicker();
}
/* 3.13.0: live "working for…" counter on the activity card header */
let maActivityElapsedTimer = null;
function maFmtElapsed(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
function startMaElapsedTicker() {
  stopMaElapsedTicker();
  const el = $('maActivityElapsed'); if (el) el.textContent = '0s';
  maActivityElapsedTimer = setInterval(() => {
    if (!maActivityState.visible) { stopMaElapsedTicker(); return; }
    const t = $('maActivityElapsed'); if (t) t.textContent = maFmtElapsed(Date.now() - maActivityStartedAt);
  }, 1000);
}
function stopMaElapsedTicker() {
  if (maActivityElapsedTimer) { clearInterval(maActivityElapsedTimer); maActivityElapsedTimer = null; }
  const el = $('maActivityElapsed'); if (el) el.textContent = '';
}
function clearActivityTerminalTimer(id) {
  const timer = maActivityTerminalTimers.get(id);
  if (timer) clearTimeout(timer);
  maActivityTerminalTimers.delete(id);
}
const MA_ACTIVITY_LABELS = { thinking: 'Thinking', working: 'Working', reviewing: 'Reviewing', waiting: 'Waiting', completed: 'Done', failed: 'Failed', cancelled: 'Stopped' };
const MA_ACTIVITY_ACTIVE = new Set(['thinking','working','reviewing']);
const MA_ACTIVITY_TERMINAL = new Set(['completed','failed','cancelled']);
function clearMultiAgentAutoHide() {
  if (maActivityHideTimer) { clearTimeout(maActivityHideTimer); maActivityHideTimer = null; }
  if (maActivityExitTimer) { clearTimeout(maActivityExitTimer); maActivityExitTimer = null; }
  const panel = $('maActivityPanel'); if (panel) panel.classList.remove('is-leaving');
}
function scheduleMultiAgentAutoHide(activeCount) {
  const stages = maActivityState.stages || [];
  const allFinished = stages.length > 0 && stages.every(stage => MA_ACTIVITY_TERMINAL.has(stage.status));
  if (activeCount || !allFinished || maActivityState.dismissed) { clearMultiAgentAutoHide(); return; }
  if (maActivityHideTimer || maActivityExitTimer) return;
  // 3.13.0: keep the whole activity card (header + full feed) readable for 8s after the
  // model stops, then animate it away. While the model works it never hides.
  maActivityHideTimer = setTimeout(() => {
    maActivityHideTimer = null;
    const panel = $('maActivityPanel');
    if (!panel || !maActivityState.visible || maActivityState.dismissed) return;
    panel.classList.add('is-leaving');
    maActivityExitTimer = setTimeout(() => {
      maActivityExitTimer = null;
      panel.classList.remove('is-leaving');
      maActivityState.visible = false;
      stopMaElapsedTicker();
      renderMultiAgentActivity();
    }, 240);
  }, 8000);
}
function placeMultiAgentActivityUnderUser() {
  const panel = $('maActivityPanel');
  const turn = ui.turn || (chat.lastElementChild && chat.lastElementChild.classList.contains('turn') ? chat.lastElementChild : null);
  if (!panel || !turn) return;
  const userMsg = Array.from(turn.children).find(el => el.classList && el.classList.contains('umsg'));
  if (userMsg) userMsg.insertAdjacentElement('afterend', panel);
}
function placeActivityBeforeTranscript() {
  const panel = $('maActivityPanel'), host = $('chatPane');
  if (panel && host && chat && (panel.parentElement !== host || panel.nextElementSibling !== chat)) host.insertBefore(panel, chat);
}
function syncMultiAgentTicker(activeCount) {
  const shouldRun = maActivityState.visible && !maActivityState.dismissed && activeCount > 1;
  if (shouldRun && !maActivityTicker) {
    maActivityTicker = setInterval(() => {
      const activeNow = maActivityState.stages.filter(s => MA_ACTIVITY_ACTIVE.has(s.status));
      if (activeNow.length < 2) { syncMultiAgentTicker(activeNow.length); renderMultiAgentActivity(); return; }
      maActivityCursor = (maActivityCursor + 1) % activeNow.length;
      renderMultiAgentActivity();
    }, 1000);
  } else if (!shouldRun && maActivityTicker) {
    clearInterval(maActivityTicker); maActivityTicker = null;
  }
}
function renderMultiAgentActivity() {
  const panel = $('maActivityPanel');
  if (!panel) return;
  panel.hidden = !maActivityState.visible || maActivityState.dismissed;
  if (panel.hidden) { syncMultiAgentTicker(0); stopMaElapsedTicker(); return; }
  const stages = maActivityState.stages || [];
  const active = stages.filter(s => MA_ACTIVITY_ACTIVE.has(s.status));
  const failed = stages.filter(s => s.status === 'failed');
  syncMultiAgentTicker(active.length);
  const runFinished = !active.length && stages.length > 0 && stages.every(s => MA_ACTIVITY_TERMINAL.has(s.status));
  if (runFinished) feedFinishAll(failed.length ? 'err' : 'ok');
  panel.classList.toggle('is-done', runFinished);
  let selected = null, idx = 0;
  if (active.length) { idx = maActivityCursor % active.length; selected = active[idx]; }
  else {
    selected = [...stages].reverse().find(s => ['failed','completed','cancelled'].includes(s.status)) || stages[0] || { id:'none', name:'Preparing agents', status:'waiting', detail:'Waiting for activity' };
    idx = -1;
  }
  const line = $('maActivityLine');
  const switched = selected.id !== maActivityDisplayedId;
  if (switched && maActivityDisplayedId) {
    line.classList.add('is-switching');
    clearTimeout(maActivitySwitchTimer);
    maActivitySwitchTimer = setTimeout(() => {
      paintMultiAgentLine(selected, active, idx);
      requestAnimationFrame(() => line.classList.remove('is-switching'));
    }, 95);
  } else {
    paintMultiAgentLine(selected, active, idx);
    line.classList.remove('is-switching');
  }
  maActivityDisplayedId = selected.id;
  scheduleMultiAgentAutoHide(active.length);
  pinChatToLatest();
}
function paintMultiAgentLine(stage, active, idx) {
  if (!stage) return;
  // 3.13.0: the header keeps a compact status word + live detail; the full, untruncated
  // story lives in the feed below (every line, full text, visible until the run ends).
  const detail = String(stage.detail || '').trim() || MA_ACTIVITY_LABELS[stage.status] || 'Working';
  $('maActivityDetail').textContent = detail;
  $('maActivityState').textContent = MA_ACTIVITY_LABELS[stage.status] || 'Working';
  $('maActivityPanel').dataset.status = stage.status || 'waiting';
  $('maActivityPanel').title = detail;
}
function startMultiAgentActivity() {
  beginActivityCycle(); feedClear();
  clearMultiAgentAutoHide();
  if (maActivityTicker) { clearInterval(maActivityTicker); maActivityTicker = null; }
  clearTimeout(maActivitySwitchTimer); maActivityCursor = 0; maActivityDisplayedId = '';
  placeMultiAgentActivityUnderUser();
  const panel = $('maActivityPanel'); if (panel) { panel.hidden = false; panel.classList.remove('is-leaving'); }
  maActivityState = { visible: true, dismissed: false, stages: MA_ACTIVITY_ROLES.map(role => ({
    ...role,
    status: ['planner','architect','researcher','test'].includes(role.id) ? 'thinking' : 'waiting',
    detail: role.id === 'planner' ? 'Creating task plan' : role.id === 'architect' ? 'Assessing architecture and risks' : role.id === 'researcher' ? 'Researching docs and prior art' : role.id === 'test' ? 'Preparing validation strategy' : role.id === 'implementer' ? 'Waiting for specialist input' : role.id === 'debugger' ? 'Available for delegation' : 'Will review implementation evidence'
  })) };
  maActivityState.stages.forEach(feedStage);
  renderMultiAgentActivity();
}
function setMultiAgentActivity(id, status, detail) {
  if (!maActivityState.visible) return;
  const stage = maActivityState.stages.find(s => s.id === id);
  if (!stage) return;
  if (MA_ACTIVITY_TERMINAL.has(status) && stage.status !== status) {
    const elapsed = Date.now() - maActivityStartedAt;
    if (elapsed < MA_ACTIVITY_MIN_SPINNER_MS) {
      clearActivityTerminalTimer(id);
      const generation = maActivityGeneration;
      const timer = setTimeout(() => {
        maActivityTerminalTimers.delete(id);
        if (generation === maActivityGeneration) setMultiAgentActivity(id, status, detail);
      }, MA_ACTIVITY_MIN_SPINNER_MS - elapsed);
      maActivityTerminalTimers.set(id, timer);
      return;
    }
  }
  clearActivityTerminalTimer(id);
  stage.status = status;
  if (detail !== undefined) stage.detail = String(detail || '');
  feedStage(stage);
  renderMultiAgentActivity();
}
// Single-agent and OpenCode runs use the same live activity bubble as Multi-agent.
// The line reports safe progress labels, not private model chain-of-thought.
function startAssistantActivity(label, detail) {
  beginActivityCycle(); feedClear();
  clearMultiAgentAutoHide();
  if (maActivityTicker) { clearInterval(maActivityTicker); maActivityTicker = null; }
  clearTimeout(maActivitySwitchTimer); maActivityCursor = 0; maActivityDisplayedId = '';
  maActivityState = { visible: true, dismissed: false, stages: [{ id: 'assistant', name: label || 'AI assistant', status: 'thinking', detail: detail || 'Thinking about your request' }] };
  const panel = $('maActivityPanel');
  if (panel) { panel.hidden = false; panel.classList.remove('is-leaving'); }
  placeMultiAgentActivityUnderUser();
  renderMultiAgentActivity();
}
function updateTurnActivity(id, status, detail) {
  if (maActivityState.stages.some(stage => stage.id === id)) {
    setMultiAgentActivity(id, status, detail); return;
  }
  if (maActivityState.stages.length === 1 && maActivityState.stages[0].id === 'assistant') {
    setMultiAgentActivity('assistant', status, detail);
  }
}
function stopMultiAgentActivity(status, detail) {
  for (const stage of maActivityState.stages) {
    if (['thinking','working','reviewing','waiting'].includes(stage.status)) {
      stage.status = status;
      stage.detail = detail || (status === 'cancelled' ? 'Stopped by user' : 'Turn ended');
      feedStage(stage);
    }
  }
  renderMultiAgentActivity();
}
$('maActivityClose')?.addEventListener('click', () => { clearMultiAgentAutoHide(); maActivityState.dismissed = true; syncMultiAgentTicker(0); stopMaElapsedTicker(); renderMultiAgentActivity(); });

/* ================= multi-agent orchestration ================= */
/* ---- 3.10: bounded sub-agent runner (read-only tools, short rounds) ----
   Used by the Researcher preflight agent and by the delegate_subtask tool. Sub-agents can
   inspect the workspace and the public web but can never edit files or run commands, so
   parallel delegation cannot conflict with the Coder's file modifications. */
