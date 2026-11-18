/* ================= 3.15.0 persistent autonomous task center ================= */
let pendingTaskLaunch = null;
function taskLedger(session) {
  if (!Array.isArray(session.tasks)) session.tasks = [];
  return session.tasks;
}
function claimTaskForRun(session, prompt, startedAt) {
  const pending = pendingTaskLaunch;
  pendingTaskLaunch = null;
  if (pending && pending.sessionId === session.id) {
    const found = taskLedger(session).find(t => t.id === pending.id);
    if (found) { found.status = 'running'; found.startedAt = startedAt; found.updatedAt = startedAt; found.phase = 'Starting'; persistSession(); return found; }
  }
  const task = { id: uid() + uid(), title: String(prompt || 'Engineering task').replace(/\s+/g, ' ').slice(0, 88), prompt: String(prompt || '').slice(0, 12000), status: 'running', phase: 'Starting', createdAt: startedAt, startedAt, updatedAt: startedAt, sessionId: session.id, modelRounds: 0, toolCalls: 0, toolIssues: 0, changedFiles: [], validations: [] };
  const list = taskLedger(session); list.unshift(task); if (list.length > 50) list.length = 50;
  persistSession(); return task;
}
function updateTaskRecord(session, id, patch) {
  const task = taskLedger(session).find(t => t.id === id); if (!task) return;
  Object.assign(task, patch || {}); task.updatedAt = Number(task.updatedAt) || Date.now();
  session.updated = Date.now();
  persistSession();
  if (typeof renderTaskCenter === 'function' && $('taskCenterDlg')?.open) renderTaskCenter();
}
function markRecoveredTasksInterrupted() {
  const now = Date.now(); let changed = false;
  for (const session of sessions || []) for (const task of taskLedger(session)) {
    if (task.status === 'running') { task.status = 'interrupted'; task.phase = 'App closed before task completion'; task.updatedAt = now; changed = true; }
  }
  if (changed) { try { saveSessionsLocal(); } catch {} }
}
function taskStatusLabel(status) {
  return ({ queued: 'Queued', running: 'Running', interrupted: 'Interrupted', completed: 'Completed', cancelled: 'Cancelled', error: 'Failed', 'empty-final': 'Incomplete', 'tool-limit': 'Limit reached', 'repeat-limit': 'Stopped safely' })[status] || String(status || 'Unknown');
}
function allTaskEntries() {
  return sessions.flatMap(session => taskLedger(session).map(task => ({ ...task, sessionTitle: session.title, _sessionId: session.id }))).sort((a,b) => Number(b.updatedAt || b.createdAt) - Number(a.updatedAt || a.createdAt));
}
function showTaskCenter() {
  const dlg = $('taskCenterDlg'); if (!dlg) return;
  renderTaskCenter(); if (!dlg.open) dlg.showModal();
}
function renderTaskCenter() {
  const list = $('taskCenterList'); if (!list) return;
  const tasks = allTaskEntries();
  const counts = tasks.reduce((a,t) => (a[t.status] = (a[t.status] || 0) + 1, a), {});
  $('taskCenterCounts').textContent = `${tasks.length} tasks · ${counts.queued || 0} queued · ${counts.running || 0} running · ${counts.interrupted || 0} interrupted`;
  $('taskRunNext').disabled = !!ctrl || !tasks.some(t => t.status === 'queued');
  list.innerHTML = '';
  if (!tasks.length) { list.innerHTML = '<div class="task-empty">No tasks</div>'; return; }
  for (const task of tasks) {
    const row = document.createElement('article'); row.className = 'task-row';
    const status = document.createElement('span'); status.className = 'task-status ' + String(task.status).replace(/[^a-z-]/g,''); status.textContent = taskStatusLabel(task.status);
    const title = document.createElement('div'); title.className = 'task-title'; title.textContent = task.title || 'Engineering task';
    const meta = document.createElement('div'); meta.className = 'task-meta';
    const when = new Date(Number(task.updatedAt || task.createdAt) || Date.now()).toLocaleString();
    meta.textContent = `${task.sessionTitle || 'Chat'} · ${when}${task.phase ? ' · ' + task.phase : ''}`;
    const stats = document.createElement('div'); stats.className = 'task-meta';
    stats.textContent = `${Number(task.modelRounds)||0} model rounds · ${Number(task.toolCalls)||0} tool calls${task.changedFiles?.length ? ' · ' + task.changedFiles.length + ' changed files' : ''}`;
    const main = document.createElement('div'); main.className = 'task-main'; main.append(status,title,meta,stats);
    const actions = document.createElement('div'); actions.className = 'task-actions';
    const addAction = (label, fn, danger=false, disabled=false) => { const b=document.createElement('button'); b.type='button'; b.className='btn sm'+(danger?' danger':''); b.textContent=label; b.disabled=!!disabled; b.onclick=fn; actions.appendChild(b); };
    if (task.status === 'queued') addAction('Run', () => launchQueuedTask(task._sessionId, task.id));
    if (task.status === 'interrupted' || ['cancelled','error','empty-final','tool-limit','repeat-limit'].includes(task.status)) addAction('Resume', () => resumeTask(task._sessionId, task.id));
    addAction('Open chat', () => { $('taskCenterDlg').close(); switchSession(task._sessionId); }, false, !!ctrl && task._sessionId !== curId);
    if (task.status === 'queued') addAction('Remove', () => { const s=sessions.find(x=>x.id===task._sessionId); if(s){s.tasks=taskLedger(s).filter(t=>t.id!==task.id);persistSession();renderTaskCenter();} }, true);
    row.append(main,actions); list.appendChild(row);
  }
}
function launchQueuedTask(sessionId, taskId) {
  if (ctrl) { addNote('An agent task is already running.'); return; }
  const session = sessions.find(s => s.id === sessionId); const task = session && taskLedger(session).find(t => t.id === taskId);
  if (!task || task.status !== 'queued') return;
  switchSession(sessionId); $('taskCenterDlg').close();
  pendingTaskLaunch = { id: task.id, sessionId };
  runAgent(task.prompt, []);
}
function resumeTask(sessionId, taskId) {
  if (ctrl) { addNote('An agent task is already running.'); return; }
  const session = sessions.find(s => s.id === sessionId); const task = session && taskLedger(session).find(t => t.id === taskId);
  if (!task) return;
  switchSession(sessionId); $('taskCenterDlg').close();
  const resumePrompt = `Continue the existing engineering task below from its saved conversation and workspace state. Do not restart completed work. First inspect current files and the latest tool results, verify what already succeeded, then continue from the first unfinished step. Preserve user changes and all existing permission gates. Re-run relevant tests and report only verified outcomes.\n\nORIGINAL TASK:\n${task.prompt}`;
  pendingTaskLaunch = { id: task.id, sessionId };
  runAgent(resumePrompt, []);
}
$('taskCenterClose')?.addEventListener('click', () => $('taskCenterDlg').close());
$('taskQueueForm')?.addEventListener('submit', e => {
  e.preventDefault(); const prompt = String($('taskQueuePrompt').value || '').trim(); if (!prompt) return;
  const session = cur(); const now = Date.now();
  const task = { id: uid()+uid(), title: prompt.replace(/\s+/g,' ').slice(0,88), prompt: prompt.slice(0,12000), status: 'queued', phase: 'Waiting for approval to run', createdAt: now, updatedAt: now, sessionId: session.id, modelRounds: 0, toolCalls: 0, toolIssues: 0, changedFiles: [], validations: [] };
  taskLedger(session).unshift(task); persistSession(); $('taskQueuePrompt').value=''; renderTaskCenter();
});
$('taskRunNext')?.addEventListener('click', () => { const next=allTaskEntries().find(t=>t.status==='queued'); if(next) launchQueuedTask(next._sessionId,next.id); });
