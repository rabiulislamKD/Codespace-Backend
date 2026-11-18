const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
function renderSessions() {
  const box = $('sessList'), q = $('sessFilter').value.trim().toLowerCase(); box.innerHTML = '';
  sessions.slice().sort((a, b) => b.updated - a.updated).filter(s => !q || s.title.toLowerCase().includes(q)).forEach(s => {
    const row = document.createElement('div'); row.className = 'li click' + (s.id === curId ? ' cur' : ''); row.tabIndex = 0;
    row.innerHTML = '<div class="info"><b>' + esc(s.title) + '</b><span>' + ago(s.updated) + ' · ' + s.messages.filter(m => m.role === 'user').length + ' messages</span></div>';
    const del = document.createElement('button'); del.className = 'btn sm danger'; del.type = 'button'; del.textContent = '✕'; del.title = 'Delete this chat'; del.setAttribute('aria-label', 'Delete chat');
    del.onclick = e => { e.stopPropagation(); deleteSession(s.id); };
    row.appendChild(del); row.onclick = () => switchSession(s.id); row.onkeydown = e => { if (e.key === 'Enter') switchSession(s.id); };
    box.appendChild(row);
  });
  if (!box.children.length) box.innerHTML = '<div class="tnote">No chats found.</div>';
}
function switchSession(id) {
  if (id === curId) return;
  if (ctrl) ctrl.abort();
  curId = id; historyVisible = 80; saveSessionsLocal(); renderHistory(); renderPlanPanel(); renderSessions(); updateMeters();
}
function newSession() {
  if (ctrl) ctrl.abort();
  const c = cur();
  if (c && !c.messages.length) { renderHistory(); return; }
  const s = blankSession(); sessions.push(s); curId = s.id; historyVisible = 80; saveSessionsLocal(); renderHistory(); renderPlanPanel(); renderSessions(); updateMeters();
}
function deleteSession(id) {
  if (ctrl && id === curId) ctrl.abort();
  sessions = sessions.filter(s => s.id !== id);
  if (B.ok) bcall('/sessions/delete', { id }).catch(() => {});
  if (!sessions.length) sessions.push(blankSession());
  if (!sessions.some(s => s.id === curId)) { curId = sessions.slice().sort((a, b) => b.updated - a.updated)[0].id; renderHistory(); }
  saveSessionsLocal(); renderSessions(); updateMeters();
}

/* ================= editor: tabs, code viewer, tables, preview ================= */
