function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
async function undoOne(tm, force) {
  const u = tm.undo; if (!u || tm.undone) return true;
  let cur = null; try { cur = await fsRead(u.path); } catch {}
  if (!force && cur !== null && strHash(cur) !== u.after && !confirm('"' + u.path + '" has changed since the agent edited it.\n\nUndo anyway? Your newer changes to it will be lost.')) return false;
  if (u.existed) {
    if (u.old === null) { addErr('"' + u.path + '" was too large to keep a copy, so it cannot be undone.'); return false; }
    await fsWrite(u.path, u.old);
  } else if (cur !== null) await fsDelete(u.path);
  tm.undone = true; return true;
}
function afterUndo() { refreshTabs(); refreshExplorer(); reloadPreview(); gitRefresh(); persistSession(); }
async function undoStep(tm) {
  if (ctrl) { addErr('Wait for the agent to finish, or press Stop, before undoing.'); return; }
  try { if (await undoOne(tm)) { afterUndo(); renderHistory(); } } catch (e) { addErr('Could not undo: ' + e.message); }
}
async function keepStep(tm) {
  if (!tm || !tm.undo || tm.undone) return;
  tm.kept = true; persistSession(); renderHistory();
}
async function undoMany(list) {
  if (ctrl) { addErr('Wait for the agent to finish, or press Stop, before undoing.'); return false; }
  try {
    const last = new Map(); list.forEach(m => last.set(m.undo.path, m)); // the newest edit of each file
    const changed = [];
    for (const [p, m] of last) { let cur = null; try { cur = await fsRead(p); } catch {} if (cur !== null && strHash(cur) !== m.undo.after) changed.push(p); }
    if (changed.length && !confirm('These files changed since the agent edited them:\n' + changed.join('\n') + '\n\nUndo anyway? Your newer changes to them will be lost.')) return false;
    for (const m of [...list].reverse()) { if (!await undoOne(m, true)) return false; }
    afterUndo(); renderHistory(); return true;
  } catch (e) { addErr('Could not undo: ' + e.message); return false; }
}
function renderBar(turn, msgs) {
  turn.querySelectorAll(':scope > .chbar').forEach(e => e.remove());
  const user = msgs[0]; if (!user || user.role !== 'user' || user.kept) return;
  const ch = msgs.filter(m => m.role === 'tool' && m.undo && !m.undone && !m.kept); if (!ch.length) return;
  const byPath = new Map(); ch.forEach(m => { const e = byPath.get(m.undo.path) || { add: 0, del: 0 }; if (m.diff) { e.add += m.diff.add; e.del += m.diff.del; } byPath.set(m.undo.path, e); });
  let add = 0, del = 0; byPath.forEach(e => { add += e.add; del += e.del; });
  const bar = document.createElement('div'); bar.className = 'chbar';
  const info = document.createElement('span'); info.className = 'chinfo';
  info.innerHTML = '<b>' + byPath.size + (byPath.size === 1 ? ' file' : ' files') + ' changed</b><span class="badge add">+' + add + '</span><span class="badge del">−' + del + '</span>'; /* 3.13.1: no icon in chat */
  const acts = document.createElement('span'); acts.className = 'chacts';
  acts.append(
    mkBtn('Review', '', () => openDiffTab('Agent changes', 'agent:' + ch[0].toolCallId, { blocks: ch.filter(m => m.diff).map(m => ({ title: m.undo.path, lines: m.diff.lines })), patch: undefined })),
    mkBtn('Undo all', 'danger', () => undoMany(ch)),
    mkBtn('Keep', 'primary', () => { ch.forEach(m => { m.kept = true; }); user.kept = true; persistSession(); renderHistory(); }));
  const names = document.createElement('div'); names.className = 'chfiles'; names.textContent = [...byPath.keys()].join(', ');
  bar.append(info, acts, names); turn.appendChild(bar);
}
function finishTurn() { if (ui.turn) renderBar(ui.turn, ui.msgs || []); }

/* ================= diff tab ================= */
function patchHtml(p) {
  if (!String(p).trim()) return '<div class="tnote">No differences.</div>';
  return '<div class="diff full">' + p.split('\n').map(l => {
    const cls = l.startsWith('@@') ? 'hunk' : /^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename)/.test(l) ? 'meta' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '';
    return '<div class="dl ' + cls + '">' + esc(l || ' ') + '</div>';
  }).join('') + '</div>';
}
function drawDiffTab(t) {
  $('diffInfo').textContent = t.title; const box = $('diffBody'); box.innerHTML = '';
  if (t.patch !== undefined) { box.innerHTML = patchHtml(t.patch); return; }
  (t.blocks || []).forEach(bl => { const h = document.createElement('div'); h.className = 'dfile'; h.textContent = bl.title; box.appendChild(h); const w = document.createElement('div'); w.innerHTML = renderDiff({ lines: bl.lines }); box.appendChild(w.firstChild); });
  if (!(t.blocks || []).length) box.innerHTML = '<div class="tnote">No differences to show.</div>';
}
function openDiffTab(title, key, data) {
  const id = 'diff:' + key; let t = tabs.find(x => x.id === id);
  if (!t) { t = { id, type: 'diff', title }; tabs.push(t); }
  Object.assign(t, { title }, data); activate(id);
}

/* ================= source control (Git) ================= */
const G = { st: null, map: new Map(), log: [], branches: [], remotes: [], msg: '', note: '', noteBad: false, sig: '', busy: false };
const gitMark = full => G.map.get(full) || '';
const viewOpen = v => curView === v && !$('app').classList.contains('nosidebar');
function updateGitBar() {
  const st = G.st, on = B.ok && B.info && B.info.root && st && st.isRepo;
  $('sbGit').hidden = !on; if (!on) return;
  const n = st.files.length;
  $('sbGit').textContent = '⎇ ' + st.branch + (n ? ' ●' + n : '') + (st.ahead ? ' ↑' + st.ahead : '') + (st.behind ? ' ↓' + st.behind : '');
}
async function gitRefresh() {
  if (!B.ok || !B.info || !B.info.root) { G.st = null; G.map = new Map(); G.sig = ''; updateGitBar(); if (viewOpen('git')) drawGit(); return; }
  if (G.busy) return; G.busy = true;
  try {
    G.st = await bcall('/git/status');
    if (viewOpen('git') && G.st.isRepo) { try { G.log = (await bcall('/git/log', { n: 12 })).commits; G.branches = (await bcall('/git/branches')).branches; G.remotes = (await bcall('/git/remotes')).remotes || []; } catch { G.remotes = []; } }
  } catch (e) { G.st = { isRepo: false, error: e.message }; }
  G.busy = false;
  const map = new Map();
  if (G.st.isRepo) G.st.files.forEach(f => { map.set(f.path, f.work || f.index); const seg = f.path.split('/'); for (let i = 1; i < seg.length; i++) { const d = seg.slice(0, i).join('/'); if (!map.has(d)) map.set(d, '•'); } });
  const sig = JSON.stringify([...map]) + (G.st.branch || '') + (G.st.ahead || 0) + (G.st.behind || 0);
  const changed = sig !== G.sig; G.sig = sig; G.map = map;
  updateGitBar(); if (changed && !ctrl) drawTree();
  if (viewOpen('git')) drawGit();
}
function gitNote(t, bad) { G.note = t || ''; G.noteBad = !!bad; if (viewOpen('git')) drawGit(); }
async function gitDo(path, body, okMsg) {
  try { const r = await bcall(path, body); if (okMsg) gitNote(typeof okMsg === 'string' ? okMsg : (r.out || 'Done.')); else gitNote(''); await gitRefresh(); return r; }
  catch (e) { gitNote(e.message, true); return null; }
}
async function gitShowDiff(f, staged) {
  try { const r = await bcall('/git/diff', { path: f.path, staged, untracked: f.untracked && !staged }); openDiffTab(f.path + (staged ? ' (staged)' : ''), 'git:' + (staged ? 's:' : 'w:') + f.path, { patch: r.patch, blocks: undefined }); }
  catch (e) { gitNote(e.message, true); }
}
async function genCommitMsg(btn) {
  const st = G.st; if (!st || !st.files.length) { gitNote('There are no changes to describe.', true); return; }
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    const staged = st.files.some(f => f.index), d = await bcall('/git/diff', { all: true, staged, max: 12000 });
    const names = st.files.map(f => (f.work || f.index) + ' ' + f.path).join('\n');
    const r = await callModel(P(), 'You write git commit messages. Reply with only the message: a short imperative subject line (max 72 characters), then optionally a blank line and a few short bullet points. No quotes and no code fences.', [{ role: 'user', content: 'Changed files:\n' + names + '\n\nDiff:\n' + (d.patch || '(only new files)') }], [], undefined);
    G.msg = stripThink(r.text).replace(/^```\w*\n?/, '').replace(/```$/, '').trim(); gitNote('');
  } catch (e) { gitNote('Could not write a message: ' + e.message, true); }
  drawGit();
}
async function gitAddRemote() {
  const name = (await ctxAsk('New Git remote name', 'origin') || '').trim(); if (!name) return;
  const url = (await ctxAsk('HTTPS Git remote URL', 'https://github.com/owner/repository.git') || '').trim(); if (!url) return;
  await gitDo('/git/remote/add', { name, url }, 'Remote ' + name + ' added.');
}
async function gitRemoveRemote() {
  if (!G.remotes.length) { gitNote('No Git remotes are configured.', true); return; }
  const defaultName = G.remotes[0].name;
  const name = (await ctxAsk('Remote name to remove', defaultName) || '').trim(); if (!name) return;
  if (!confirm('Remove Git remote "' + name + '"? This only removes its local configuration; it does not delete the server repository.')) return;
  await gitDo('/git/remote/remove', { name }, 'Remote ' + name + ' removed.');
}
async function gitRemoteSync(kind) {
  const st = G.st; if (!st || !st.isRepo) return;
  const inferred = st.upstream && !st.upstream.startsWith('.') ? st.upstream.split('/')[0] : (G.remotes[0] && G.remotes[0].name) || 'origin';
  const remote = (await ctxAsk('Git remote for ' + kind, inferred) || '').trim(); if (!remote) return;
  let token = await ctxAsk('HTTPS password / access token (leave blank for a public repository)', '', true);
  if (token === null) return;
  let username = '';
  try {
    if (token) { username = (await ctxAsk('Git HTTPS username', 'x-access-token') || '').trim(); if (!username) { gitNote('A username is required when a token is supplied.', true); return; } }
    const upstream = typeof st.upstream === 'string' ? st.upstream : '';
    const trackedRemote = upstream && !upstream.startsWith('.') ? upstream.slice(0, upstream.indexOf('/')) : '';
    const trackedBranch = trackedRemote && upstream.startsWith(trackedRemote + '/') ? upstream.slice(trackedRemote.length + 1) : '';
    const remoteBranch = trackedRemote === remote && trackedBranch ? trackedBranch : st.branch;
    const result = await bcall('/git/' + kind, { remote, remoteBranch, username, token: token || '' });
    gitNote(result.out || (kind === 'push' ? 'Push completed.' : kind === 'fetch' ? 'Fetch completed.' : 'Pull completed.'));
    await gitRefresh();
  } catch (e) { const message = String(e && e.message || e); gitNote(token ? message.split(token).join('[credential hidden]') : message, true); }
  finally { token = ''; username = ''; }
}
function drawGit() {
  const box = $('gitBody'); box.innerHTML = '';
  const note = t => { const d = document.createElement('div'); d.className = 'tnote'; d.textContent = t; box.appendChild(d); };
  if (!B.ok) { note('Bridge not connected.'); return; }
  if (!B.info.root) { note('No workspace open.'); return; }
  const st = G.st; if (!st) { note('Loading…'); return; }
  if (st.error) { note(st.error); return; }
  if (st.gitMissing) { note('Git is not installed on this computer.'); return; }
  if (!st.isRepo) {
    const d = document.createElement('div'); d.className = 'emptytree'; d.innerHTML = 'This folder is not a Git repository yet.<br>'; d.appendChild(mkBtn('Initialize repository', 'primary', () => gitDo('/git/init', {}, 'Repository created.'))); box.appendChild(d); return;
  }
  const bar = document.createElement('div'); bar.className = 'gitbar';
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Branch');
  [...new Set([st.branch, ...G.branches])].forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }); sel.value = st.branch;
  sel.onchange = () => gitDo('/git/checkout', { branch: sel.value }, 'Switched to ' + sel.value);
  bar.append(sel,
    mkBtn('+', '', async () => { const n = (await ctxAsk('Name for the new branch', '') || '').trim(); if (n) gitDo('/git/checkout', { branch: n, create: true }, 'Created and switched to ' + n); }),
    mkBtn('Remote +', '', gitAddRemote),
    mkBtn('Remote −', '', gitRemoveRemote),
    mkBtn('Fetch', '', async () => { gitNote('Fetching…'); await gitRemoteSync('fetch'); }),
    mkBtn('Pull' + (st.behind ? ' ↓' + st.behind : ''), '', async () => { gitNote('Pulling…'); await gitRemoteSync('pull'); }),
    mkBtn('Push' + (st.ahead ? ' ↑' + st.ahead : ''), '', async () => { gitNote('Pushing…'); await gitRemoteSync('push'); }));
  bar.children[bar.children.length - 3].title = 'git fetch'; bar.children[bar.children.length - 2].title = 'git pull (fast-forward only)'; bar.lastChild.title = 'git push (non-force)';
  box.appendChild(bar);
  const remoteSummary = document.createElement('div'); remoteSummary.className = 'tnote';
  remoteSummary.textContent = G.remotes.length ? 'Remotes: ' + G.remotes.map(r => r.name + (r.url ? ' · fetch ' + r.url : '') + (r.pushUrl && r.pushUrl !== r.url ? ' · push ' + r.pushUrl : '')).join('  |  ') : 'No remote configured. Add an HTTPS remote to fetch, pull or push.';
  box.appendChild(remoteSummary);
  const staged = st.files.filter(f => f.index), changes = st.files.filter(f => f.work);
  const cm = document.createElement('div'); cm.className = 'gitcommit';
  const ta = document.createElement('textarea'); ta.className = 'fld'; ta.placeholder = 'Commit message'; ta.value = G.msg; ta.setAttribute('aria-label', 'Commit message'); ta.oninput = () => { G.msg = ta.value; };
  const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '6px';
  const gen = mkBtn('✨ Write message', '', () => genCommitMsg(gen)); gen.title = 'Ask the model to describe the changes';
  const commit = mkBtn(staged.length ? 'Commit' : 'Commit all', 'primary', async () => {
    const msg = G.msg.trim(); if (!msg) { gitNote('Write a commit message first.', true); return; }
    if (!st.files.length) { gitNote('There is nothing to commit.', true); return; }
    if (!staged.length && !confirm('Nothing is staged. Commit all ' + st.files.length + ' changed files?')) return;
    const r = await gitDo('/git/commit', { message: msg, all: !staged.length }, true); if (r) G.msg = '';
  });
  commit.disabled = !st.files.length; row.append(gen, commit); cm.append(ta, row); box.appendChild(cm);
  if (G.note) { const n = document.createElement('div'); n.className = 'gitnote'; if (G.noteBad) n.style.color = 'var(--err)'; n.textContent = G.note; box.appendChild(n); }
  const section = (title, list, isStaged) => {
    if (!list.length) return;
    const h = document.createElement('div'); h.className = 'gitsec'; h.append(document.createTextNode(title + ' (' + list.length + ')'), Object.assign(document.createElement('span'), { className: 'sp' }));
    h.appendChild(mkBtn(isStaged ? '− all' : '+ all', '', () => gitDo(isStaged ? '/git/unstage' : '/git/stage', { paths: ['.'] }))); box.appendChild(h);
    list.forEach(f => {
      const r = document.createElement('div'); r.className = 'gitrow'; r.tabIndex = 0; r.title = f.path;
      const letter = isStaged ? f.index : f.work, base = f.path.split('/').pop(), dir = f.path.slice(0, f.path.length - base.length);
      const ltr = document.createElement('span'); ltr.className = 'ltr'; ltr.dataset.g = letter; ltr.textContent = letter;
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = base; if (dir) { const sm = document.createElement('small'); sm.textContent = dir; nm.appendChild(sm); }
      const acts = document.createElement('span'); acts.className = 'acts';
      if (!isStaged) acts.appendChild(mkBtn('↶', '', e => { e.stopPropagation(); if (confirm((f.untracked ? 'Delete the new file ' : 'Discard all changes to ') + f.path + '? This cannot be undone.')) gitDo('/git/discard', { path: f.path, untracked: f.untracked }); }));
      acts.lastChild && (acts.lastChild.title = f.untracked ? 'Delete this new file' : 'Discard changes');
      const tog = mkBtn(isStaged ? '−' : '+', '', e => { e.stopPropagation(); gitDo(isStaged ? '/git/unstage' : '/git/stage', { paths: [f.path] }); }); tog.title = isStaged ? 'Unstage' : 'Stage'; acts.appendChild(tog);
      r.append(ltr, nm, acts); r.onclick = () => gitShowDiff(f, isStaged); r.onkeydown = e => { if (e.key === 'Enter') gitShowDiff(f, isStaged); };
      box.appendChild(r);
    });
  };
  section('Staged changes', staged, true); section('Changes', changes, false);
  if (!st.files.length) note('No changes. Everything is committed.');
  if (G.log.length) {
    const h = document.createElement('div'); h.className = 'gitsec'; h.textContent = 'Recent commits'; box.appendChild(h);
    G.log.forEach(c => { const d = document.createElement('div'); d.className = 'gitlog'; d.innerHTML = '<b>' + esc(c.hash) + '</b>' + esc(c.subject) + ' <span>· ' + esc(c.when) + '</span>'; box.appendChild(d); });
  }
}
$('gitRefreshBtn').onclick = gitRefresh;
$('sbGit').onclick = () => openView('git');
setInterval(() => { if (B.ok && B.info && B.info.root && !document.hidden && !ctrl) gitRefresh(); }, 8000);

/* ================= permissions panel, saver toggle ================= */
const HOW_TEXT = { rule: 'your rule', mode: 'auto-allowed', you: 'you allowed', denied: 'you denied', blocked: 'blocked by your rule' };
function renderActivity() {
  const mode = S.permMode || 'smart';
  const rl = $('ruleList'); rl.innerHTML = '';
  (S.rules || []).forEach(r => {
    const row = listRow((r.action === 'allow' ? 'Always allow ' : 'Never allow ') + (RULE_TOOLS[r.tool] || r.tool).toLowerCase(), r.match && r.match !== '*' ? (r.tool === 'command' ? 'starting with "' + r.match + '"' : r.match) : 'any', [mkBtn('✕', 'danger', () => { S.rules = S.rules.filter(x => x.id !== r.id); touchS(); renderActivity(); })]);
    rl.appendChild(row);
  });
  if (!(S.rules || []).length) rl.innerHTML = '<div class="tnote">No rules yet. Tick "Always allow" in an approval prompt to add one, or add one below.</div>';
  const ll = $('logList'); ll.innerHTML = '';
  const rows = logRows();
  rows.slice(0, 120).forEach(a => {
    const row = listRow(a.ic + ' ' + a.title + (a.sub ? ' · ' + a.sub : ''), new Date(a.t).toLocaleTimeString() + ' · ' + a.chat + (a.how && HOW_TEXT[a.how] ? ' · ' + HOW_TEXT[a.how] : ''), []);
    if (a.st === 'err') row.style.borderLeft = '3px solid var(--err)'; else if (a.how === 'you' || a.how === 'mode' || a.how === 'rule') row.style.borderLeft = '3px solid var(--ok)';
    ll.appendChild(row);
  });
  const note = $('logNote');
  if (LOGSRC === 'server') note.textContent = SRV.msg || '';
  else note.textContent = 'Showing this browser\u2019s log (last 300 actions). Switch to the bridge audit file for a log the page cannot edit.';
  if (!rows.length) ll.innerHTML = '<div class="tnote">' + (LOGSRC === 'server' ? 'No matching audit entries.' : (ACT.length ? 'No activity matches your filter.' : 'Nothing yet. Every action the agent takes is listed here.')) + '</div>';
}
/* Phase 3S: activity filters, exports, and the bridge audit view */
let LOGSRC = 'app', SRV = { rows: [], msg: '' };
function logRows() {
  const q = ($('logQ').value || '').trim().toLowerCase(), f = $('logFilter').value;
  const src = LOGSRC === 'server' ? SRV.rows : ACT;
  return src.filter(a => {
    if (f === 'err' && a.st !== 'err') return false;
    if (f === 'you' && a.how !== 'you') return false;
    if (f === 'blocked' && a.how !== 'blocked' && a.how !== 'denied') return false;
    return !q || (a.title + ' ' + (a.sub || '') + ' ' + (a.chat || '')).toLowerCase().includes(q);
  });
}
async function loadServerAudit() {
  SRV.msg = 'Loading\u2026'; renderActivity();
  try {
    const r = await bcall('/audit/list', { limit: 300 });
    SRV.rows = (r.entries || []).map(e => ({ t: Date.parse(e.t), ic: '\ud83d\udee1', title: e.ep, sub: Object.entries(e.d || {}).map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join(',') : v)).join(' ').slice(0, 160), how: e.approved ? 'you' : '', st: e.ok ? 'ok' : 'err', chat: 'HTTP ' + e.status + ' \u00b7 ' + e.ms + ' ms' }));
    SRV.msg = (r.chain && r.chain.ok ? '\u2705 Hash chain intact over ' + r.chain.checked + ' entries. ' : '\u26d4 Chain broken near entry ' + (r.chain ? r.chain.brokenAt : '?') + ': the file may have been edited. ') + 'File: ' + r.file + '. The chain detects edits or deleted lines in the middle; it cannot detect removal of the newest lines.';
  } catch (e) { SRV.rows = []; SRV.msg = 'Could not load the audit file: ' + e.message + ' (is the bridge connected and up to date?)'; }
  renderActivity();
}
function downloadText(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const csvCell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };   // also blocks spreadsheet formula injection
$('logSrc').onclick = () => { LOGSRC = LOGSRC === 'app' ? 'server' : 'app'; $('logSrc').textContent = LOGSRC === 'app' ? 'This chat app' : 'Bridge audit file'; $('logSrc').setAttribute('aria-pressed', String(LOGSRC === 'server')); if (LOGSRC === 'server') loadServerAudit(); else renderActivity(); };
$('logQ').oninput = () => renderActivity(); $('logFilter').onchange = () => renderActivity();
$('logJson').onclick = () => downloadText('agent-activity-' + LOGSRC + '.json', JSON.stringify(logRows(), null, 2), 'application/json');
$('logCsv').onclick = () => downloadText('agent-activity-' + LOGSRC + '.csv', ['time,action,details,permission,status,context'].concat(logRows().map(a => [new Date(a.t).toISOString(), a.title, a.sub, a.how, a.st, a.chat].map(csvCell).join(','))).join('\n'), 'text/csv');

$('ruleAdd').onclick = () => {
  const tool = $('ruleTool').value, match = $('ruleMatch').value.trim() || '*', action = $('ruleAction').value;
  addRule({ tool, match, action }); $('ruleMatch').value = '';
};
$('logClear').onclick = () => { if (LOGSRC === 'server') { SRV.msg = 'The bridge audit file is append-only and cannot be cleared from the page.'; renderActivity(); return; } ACT = []; try { localStorage.setItem('agent3.log', '[]'); } catch {} renderActivity(); };
const permissionModes = {
  smart: { label: 'Default', short: 'Default' },
  all: { label: 'Allow all', short: 'Allow all' },
  auto: { label: 'Autopilot', short: 'Autopilot' }
};
function syncPermissionUI() {
  const mode = ['smart', 'all', 'auto'].includes(S.permMode) ? S.permMode : 'smart';
  const cfg = permissionModes[mode];
  const btn = $('permBtn'), menu = $('permMenu');
  btn.dataset.mode = mode; btn.removeAttribute('title'); btn.setAttribute('aria-label', 'Agent permissions: ' + cfg.label);
  btn.setAttribute('aria-expanded', String(!menu.hidden));
  menu.querySelectorAll('[data-permission]').forEach(option => option.setAttribute('aria-checked', String(option.dataset.permission === mode)));
}
function closePermissionMenu() { $('permMenu').hidden = true; $('permBtn').setAttribute('aria-expanded', 'false'); }
function setPermissionMode(mode) {
  if (!['smart', 'all', 'auto'].includes(mode)) return;
  if (mode === 'all' && S.permMode !== 'all') {
    const ok = confirm('Enable Allow all?\n\nThe agent can run commands, overwrite or delete files, modify database data, and make external changes without approval prompts. Explicit Never allow rules still block matching actions.\n\nContinue?');
    if (!ok) { closePermissionMenu(); return; }
  }
  S.permMode = mode; S.updated = Date.now(); touchS(); syncMode(); closePermissionMenu();
  if (viewOpen('log')) renderActivity();
}
$('permBtn').onclick = e => { e.stopPropagation(); if (typeof closeRouteMenu === 'function') closeRouteMenu(); const menu = $('permMenu'); menu.hidden = !menu.hidden; $('permBtn').setAttribute('aria-expanded', String(!menu.hidden)); };
$('permMenu').addEventListener('click', e => {
  const option = e.target.closest('[data-permission]');
  if (option) { setPermissionMode(option.dataset.permission); return; }
  if (e.target.closest('#permManage')) { closePermissionMenu(); openView('log'); }
});
document.addEventListener('pointerdown', e => { if (!$('permWrap').contains(e.target)) closePermissionMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('permMenu').hidden) { closePermissionMenu(); $('permBtn').focus(); } });
$('saverBtn').onclick = () => { S.tokenSaver = !(S.tokenSaver !== false); syncMode(); touchS(); };

/* ================= website elements attached from the embedded browser ================= */
