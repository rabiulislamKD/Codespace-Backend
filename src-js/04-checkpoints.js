const CP = { items: [], busy: false, lastPreview: null };
let turnCheckpointId = null, turnCheckpointPromise = null;
function cpFormatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function cpSay(message, bad = false) {
  const el = $('cpMsg'); if (!el) return;
  el.textContent = message || ''; el.style.color = bad ? 'var(--err)' : '';
}
async function ensureTurnCheckpoint(label, signal) {
  if (S.autoCheckpoint === false || !B.ok || !B.info || !B.info.root) return null;
  if (turnCheckpointId) return { id: turnCheckpointId };
  if (turnCheckpointPromise) return await turnCheckpointPromise;
  turnCheckpointPromise = bcall('/checkpoints/create', { note: 'Auto before AI change: ' + String(label || 'workspace change').slice(0, 100) }, signal)
    .then(r => {
      turnCheckpointId = r.id;
      const partial = r.complete === false ? ' (partial: some large/unreadable files were skipped)' : '';
      cpSay('Automatic checkpoint created: ' + r.id + partial);
      CP.items = [{ ...r }, ...CP.items.filter(x => x.id !== r.id)];
      if ($('cpList')) renderCheckpoints();
      return r;
    })
    .finally(() => { turnCheckpointPromise = null; });
  return await turnCheckpointPromise;
}
function cpButton(label, cls, fn) { return mkBtn(label, cls || '', fn); }
function cpRenderPreview(cmp) {
  CP.lastPreview = cmp;
  const box = $('cpPreview'); if (!box) return;
  box.innerHTML = '';
  const p = document.createElement('p'); p.className = 'hint';
  p.textContent = 'Compared with current workspace: ' + cmp.modifiedCount + ' modified, ' + cmp.missingCount + ' missing, ' + cmp.addedCount + ' added.' + (cmp.complete ? '' : ' Scan is incomplete; deleting added files is disabled.');
  box.appendChild(p);
  for (const [label, key, count] of [['Modified since checkpoint', 'modified', cmp.modifiedCount], ['Missing from workspace', 'missing', cmp.missingCount], ['Added after checkpoint', 'added', cmp.addedCount]]) {
    const d = document.createElement('details');
    const s = document.createElement('summary'); s.textContent = label + ' (' + count + ')'; d.appendChild(s);
    const ul = document.createElement('div'); ul.className = 'hint'; ul.style.whiteSpace = 'pre-wrap'; ul.style.overflowWrap = 'anywhere';
    const items = (cmp[key] || []).slice(0, 200);
    ul.textContent = items.length ? items.join('\n') + (count > items.length ? '\n… and ' + (count - items.length) + ' more' : '') : '(none)';
    d.appendChild(ul); box.appendChild(d);
  }
  if (cmp.checkpointSkipped) {
    const skipped = Object.entries(cmp.checkpointSkipped).filter(([,v]) => Number(v) > 0).map(([k,v]) => k + ': ' + v);
    if (skipped.length) { const s = document.createElement('p'); s.className = 'hint'; s.textContent = 'Checkpoint skipped: ' + skipped.join(', '); box.appendChild(s); }
  }
}
function renderCheckpoints() {
  const box = $('cpList'); if (!box) return;
  box.innerHTML = '';
  if (!B.ok) { box.textContent = 'Bridge not connected.'; return; }
  if (!B.info || !B.info.root) { box.textContent = 'No workspace open.'; return; }
  if (!CP.items.length) { box.textContent = 'No checkpoints yet.'; return; }
  CP.items.forEach(cp => {
    const row = document.createElement('div'); row.className = 'li';
    const info = document.createElement('div'); info.className = 'info';
    const title = document.createElement('b'); title.textContent = cp.note || cp.id; title.title = cp.id;
    const sub = document.createElement('span');
    const date = cp.createdAt ? new Date(cp.createdAt).toLocaleString() : 'Date unavailable';
    sub.textContent = date + ' · ' + (cp.fileCount || 0) + ' files · ' + cpFormatBytes(cp.totalBytes) + (cp.complete === false ? ' · PARTIAL' : '');
    info.append(title, sub); row.appendChild(info);
    const acts = document.createElement('div'); acts.style.display = 'flex'; acts.style.gap = '4px'; acts.style.flexWrap = 'wrap';
    acts.appendChild(cpButton('Compare', '', () => compareCheckpoint(cp)));
    acts.appendChild(cpButton('Restore', '', () => restoreCheckpoint(cp)));
    acts.appendChild(cpButton('Delete', 'danger', () => deleteCheckpoint(cp)));
    row.appendChild(acts); box.appendChild(row);
  });
}
async function refreshCheckpoints() {
  if (CP.busy) return;
  if (!B.ok) { CP.items = []; renderCheckpoints(); return; }
  if (!B.info || !B.info.root) { CP.items = []; renderCheckpoints(); return; }
  CP.busy = true;
  try { const r = await bcall('/checkpoints/list'); CP.items = r.checkpoints || []; renderCheckpoints(); }
  catch (e) { cpSay('Could not list checkpoints: ' + e.message, true); }
  finally { CP.busy = false; }
}
async function createCheckpoint() {
  if (!B.ok || !B.info || !B.info.root) { cpSay('Connect the bridge and open a workspace first.', true); return; }
  const note = await ctxAsk('Checkpoint note (optional):', 'Before a change'); if (note === null) return;
  cpSay('Creating checkpoint…');
  try {
    const r = await bcall('/checkpoints/create', { note });
    cpSay('Created ' + r.id + ' with ' + r.fileCount + ' files (' + cpFormatBytes(r.totalBytes) + ').' + (r.complete ? '' : ' WARNING: this checkpoint is partial; some files were skipped.'), !r.complete);
    await refreshCheckpoints();
    compareCheckpoint(r).catch(() => {});
  } catch (e) { cpSay('Checkpoint creation failed: ' + e.message, true); }
}
async function compareCheckpoint(cp) {
  try {
    cpSay('Comparing workspace with ' + cp.id + '…');
    const cmp = await bcall('/checkpoints/compare', { id: cp.id }); cpRenderPreview(cmp);
    cpSay('Comparison ready for ' + cp.id + '.');
    return cmp;
  } catch (e) { cpSay('Comparison failed: ' + e.message, true); return null; }
}
async function restoreCheckpoint(cp) {
  try {
    const cmp = await bcall('/checkpoints/compare', { id: cp.id }); cpRenderPreview(cmp);
    const n = cmp.modifiedCount + cmp.missingCount;
    if (!n && !cmp.addedCount) { cpSay('Workspace already matches this checkpoint.'); return; }
    if (!confirm('Restore checkpoint "' + (cp.note || cp.id) + '"?\n\nThis will overwrite ' + cmp.modifiedCount + ' modified file(s) and recreate ' + cmp.missingCount + ' missing file(s). It will keep ' + cmp.addedCount + ' file(s) added later. A safety checkpoint of the current workspace will be created first.')) return;
    let removeAdded = false;
    if (cmp.addedCount && cmp.complete) removeAdded = confirm('A second confirmation: also DELETE the ' + cmp.addedCount + ' file(s) added after this checkpoint? This is irreversible except through the safety checkpoint. Choose Cancel to keep them.');
    cpSay('Restoring checkpoint…');
    const r = await bApproved('/checkpoints/restore', { id: cp.id, removeAdded }, undefined, 'Restore checkpoint ' + cp.id + ' (overwrites workspace files)?', 'checkpoint_restore');
    if (r && r.needsApproval) { cpSay(String(r.note || 'The server approval could not be completed.'), true); return; }
    cpSay('Restored ' + r.restoredCount + ' file(s); removed ' + r.removedAddedCount + ' later-added file(s).' + (r.safetyCheckpointId ? ' Safety checkpoint: ' + r.safetyCheckpointId : '') + (r.incompleteCheckpoint ? ' Source/current scan was partial.' : '') + (r.safetyCheckpointComplete === false ? ' The safety checkpoint was partial.' : ''));
    await refreshCheckpoints(); await refreshExplorer(); await gitRefresh();
    for (const t of tabs.filter(x => x.type === 'file')) await openFile(t.path, { focus: false });
    if (activeTab) activate(activeTab);
  } catch (e) { cpSay('Restore failed: ' + e.message, true); }
}
async function deleteCheckpoint(cp) {
  if (!confirm('Delete checkpoint ' + (cp.note || cp.id) + '? This cannot be undone.')) return;
  try { await bcall('/checkpoints/delete', { id: cp.id }); cpSay('Deleted checkpoint ' + cp.id + '.'); await refreshCheckpoints(); }
  catch (e) { cpSay('Could not delete checkpoint: ' + e.message, true); }
}

/* ================= syntax colours, markdown, diff ================= */
