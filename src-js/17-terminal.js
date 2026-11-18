const T = { list: [], active: null, since: {}, text: {}, timer: null, listTimer: null, streams: new Map(), hist: [], hi: 0, xterms: new Map(), xtermLoading: null, xtermPending: new Map() };
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
function fillTermShells() {
  const s = $('termShell'); s.innerHTML = '';
  ((B.info && B.info.shells) || []).forEach(x => { const o = document.createElement('option'); o.value = x.id; o.textContent = x.label; s.appendChild(o); });
}
function drawTermTabs() {
  const box = $('termTabs'); box.innerHTML = '';
  T.list.forEach(t => {
    const el = document.createElement('div'); el.className = 'ttab' + (t.id === T.active ? ' on' : ''); el.tabIndex = 0;
    el.textContent = (t.exited ? '○ ' : '● ') + t.name + ' '; el.onclick = () => { T.active = t.id; drawTermTabs(); if (t.pty) ensureXterm(t).then(drawTermOut); drawTermOut(); connectTermStream(t.id); if (!t.pty) $('termCmd').focus(); };
    const x = document.createElement('button'); x.className = 'btn sm'; x.style.padding = '0 4px'; x.textContent = '✕'; x.setAttribute('aria-label', 'Close terminal');
    x.onclick = async e => { e.stopPropagation(); try { const r = await bApproved('/term/close', { id: t.id }, undefined, 'Close this terminal (server permission)?', 'term_close'); if (r && r.needsApproval) return; } catch {} refreshTerms(); };
    el.appendChild(x); box.appendChild(el);
  });
}
function drawTermOut() {
  const t = T.list.find(x => x.id === T.active), box = $('termXterm'), out = $('termOut'), input = $('termIn');
  const useXterm = !!(t && t.pty && window.Terminal && T.xterms.has(t.id));
  box.hidden = !useXterm; box.style.display = useXterm ? 'flex' : 'none'; out.hidden = useXterm; input.hidden = useXterm;
  if (useXterm) { for (const child of box.children) child.style.display = child.dataset.terminalId === t.id ? 'block' : 'none'; try { T.xterms.get(t.id).fit.fit(); T.xterms.get(t.id).term.focus(); } catch {} return; }
  const near = out.scrollHeight - out.scrollTop - out.clientHeight < 50;
  out.textContent = T.text[T.active] || ''; if (near) out.scrollTop = out.scrollHeight;
}
async function loadXtermAssets() {
  if (window.Terminal && window.FitAddon) return true;
  if (T.xtermLoading) return T.xtermLoading;
  T.xtermLoading = (async () => {
    const local = L.bridgeUrl === 'codespace-native://local';
    const base = local ? 'file:///android_asset/codespace-web' : (L.bridgeUrl || '').replace(/\/+$/, ''); if (!base) return false;
    const asset = name => base + '/vendor/' + name;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = asset('xterm.css'); document.head.appendChild(css);
    const load = src => new Promise((resolve, reject) => { const el = document.createElement('script'); el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Could not load terminal assets')); document.head.appendChild(el); });
    try { await load(asset('xterm.js')); await load(asset('addon-fit.js')); return !!(window.Terminal && window.FitAddon); }
    catch (e) { console.warn(e); return false; }
  })();
  return T.xtermLoading;
}
// 3.11: terminal input respects the server-side terminal permission. In 'ask' mode each input
// batch needs a token; the first one shows the approval dialog, later ones reuse your choice
// for this session ("don't ask again until reload"). In the default 'allow' mode nothing changes.
async function bTermWrite(id, data) {
  try {
    const r = await bApproved('/term/write', { id, data }, undefined, 'Send input to terminal ' + id + '?', 'term_write');
    if (r && r.needsApproval) console.warn('terminal input blocked by permission settings');
  } catch (e) { console.warn('terminal input:', e.message); }
}
async function ensureXterm(t) {
  if (!t || !t.pty || T.xterms.has(t.id)) return;
  if (T.xtermPending.has(t.id)) return T.xtermPending.get(t.id);
  const job = mountXterm(t).finally(() => T.xtermPending.delete(t.id));
  T.xtermPending.set(t.id, job);
  return job;
}
async function mountXterm(t) {
  if (!await loadXtermAssets()) return;
  if (T.xterms.has(t.id)) return;
  const host = $('termXterm');
  const mount = document.createElement('div'); mount.className = 'xterm-session'; mount.dataset.terminalId = t.id; mount.style.display = T.active === t.id ? 'block' : 'none'; host.appendChild(mount);
  const term = new window.Terminal({ cursorBlink: true, convertEol: false, scrollback: 5000, fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: 12, theme: { background: '#111111', foreground: '#eeeeee', cursor: '#eeeeee' } });
  const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(mount);
  term.onData(data => { if (T.active === t.id) bTermWrite(t.id, data); });
  term.onResize(({ cols, rows }) => bcall('/term/resize', { id: t.id, cols, rows }).catch(() => {}));
  T.xterms.set(t.id, { term, fit });
  const old = T.text[t.id]; if (old) { term.write(old.replace(/\n/g, '\r\n')); T.text[t.id] = ''; }
  requestAnimationFrame(() => { try { fit.fit(); term.focus(); } catch {} });
}
async function refreshTerms() {
  if (!B.ok) return;
  try { T.list = (await bcall('/term/list')).terminals; } catch { return; }
  if (!T.list.some(t => t.id === T.active)) T.active = T.list.length ? T.list[0].id : null;
  drawTermTabs(); const active = T.list.find(x => x.id === T.active); if (active && active.pty) ensureXterm(active).then(drawTermOut); drawTermOut(); if (T.active) connectTermStream(T.active); refreshWorkflow();
}
async function termPoll() {
  if ($('termPanel').hidden || !B.ok || !T.active) return;
  const id = T.active; if (T.streams.has(id)) return;
  try {
    const r = await bcall('/term/read', { id, since: T.since[id] || 0 });
    if (r.data) { const xt = T.xterms.get(id); if (xt) xt.term.write(r.data); else T.text[id] = ((T.text[id] || '') + stripAnsi(r.data)).slice(-120000); if (id === T.active) drawTermOut(); }
    T.since[id] = r.next;
    const t = T.list.find(x => x.id === id); if (t && t.exited !== r.exited) { t.exited = r.exited; drawTermTabs(); }
  } catch {}
}
function connectTermStream(id) {
  if (L.bridgeUrl === 'codespace-native://local') return; // Android Local PTY output is polled over the native API.
  if (!id || !B.ok || $('termPanel').hidden || T.streams.has(id)) return;
  const ac = new AbortController(); T.streams.set(id, ac);
  consumeSSE('/term/stream?id=' + encodeURIComponent(id) + '&since=' + encodeURIComponent(T.since[id] || 0), ac.signal, ev => {
    if (!ev || ev.type !== 'terminal') return;
    if (ev.data) { const xt = T.xterms.get(id); if (xt) xt.term.write(ev.data); else T.text[id] = ((T.text[id] || '') + stripAnsi(ev.data)).slice(-120000); }
    if (Number.isFinite(ev.next)) T.since[id] = ev.next;
    const t = T.list.find(x => x.id === id); if (t && ev.exited) { t.exited = true; t.code = ev.code; drawTermTabs(); }
    if (id === T.active) drawTermOut();
    if (ev.exited) ac.abort();
  }).catch(() => {}).finally(() => {
    if (T.streams.get(id) === ac) T.streams.delete(id);
    if (!$('termPanel').hidden && B.ok && T.list.some(x => x.id === id && !x.exited)) setTimeout(() => connectTermStream(id), 2500);
  });
}
async function newTerm() {
  if (!B.ok) return;
  try { const r = await bApproved('/term/start', { shell: $('termShell').value || undefined }, undefined, 'Start a terminal (server permission)?', 'term_start'); if (r && r.needsApproval) return; T.list.push(r); T.active = r.id; T.since[r.id] = 0; T.text[r.id] = ''; drawTermTabs(); if (r.pty) await ensureXterm(r); drawTermOut(); connectTermStream(r.id); if (!r.pty) $('termCmd').focus(); }
  catch (e) { addErr('Could not start a terminal: ' + e.message); }
}
function showTerminal(id) {
  if (!B.ok) { addErr('The terminal needs the bridge. Connect it in Settings.'); return; }
  $('termPanel').hidden = false; if (id) T.active = id;
  if (!T.timer) { T.timer = setInterval(termPoll, 700); T.listTimer = setInterval(refreshTerms, 4000); }
  refreshTerms().then(() => { if (!T.list.length) newTerm(); else { termPoll(); const t = T.list.find(x => x.id === T.active); if (t && t.pty) ensureXterm(t).then(drawTermOut); } });
  const active = T.list.find(x => x.id === T.active); if (!active || !active.pty) $('termCmd').focus();
}
function hideTerminal() { $('termPanel').hidden = true; clearInterval(T.timer); clearInterval(T.listTimer); T.timer = T.listTimer = null; for (const ac of T.streams.values()) ac.abort(); T.streams.clear(); }
const toggleTerminal = () => { if ($('termPanel').hidden) showTerminal(); else hideTerminal(); };
window.addEventListener('resize', () => { const x = T.xterms.get(T.active); if (x) { try { x.fit.fit(); } catch {} } });
// The panel also changes height without a window resize (drag handle, 900px breakpoint), so refit on any size change.
if (typeof ResizeObserver === 'function') new ResizeObserver(() => { const x = T.xterms.get(T.active); if (x) { try { x.fit.fit(); } catch {} } }).observe($('termPanel'));
$('termNew').onclick = newTerm; $('termHide').onclick = hideTerminal; $('sbTerm').onclick = toggleTerminal;
$('termClear').onclick = () => { if (T.xterms.has(T.active)) T.xterms.get(T.active).term.clear(); else T.text[T.active] = ''; drawTermOut(); };
$('termKill').onclick = async () => { if (T.active) { try { const r = await bApproved('/term/kill', { id: T.active }, undefined, 'Kill terminal ' + T.active + '?', 'term_kill'); if (r && r.needsApproval) return; } catch {} setTimeout(refreshTerms, 400); } };
$('termCmd').addEventListener('keydown', async e => {
  if (e.key === 'ArrowUp') { if (T.hist.length) { T.hi = Math.max(0, T.hi - 1); e.target.value = T.hist[T.hi] || ''; } e.preventDefault(); return; }
  if (e.key === 'ArrowDown') { T.hi = Math.min(T.hist.length, T.hi + 1); e.target.value = T.hist[T.hi] || ''; e.preventDefault(); return; }
  if (e.key !== 'Enter') return;
  const cmd = e.target.value; e.target.value = '';
  if (!T.active) { await newTerm(); if (!T.active) return; }
  if (cmd.trim()) { T.hist.push(cmd); T.hi = T.hist.length; }
  const t = T.list.find(x => x.id === T.active);
  T.text[T.active] = (T.text[T.active] || '') + '› ' + cmd + '\n'; drawTermOut();
  try { const r = await bApproved('/term/write', { id: T.active, data: cmd + (t && t.shell === 'cmd' ? '\r\n' : '\n') }, undefined, 'Run this command in the terminal (server permission)?', 'term_cmd'); if (r && r.needsApproval) { T.text[T.active] += '[' + (r.note || 'blocked by permission settings') + ']\n'; drawTermOut(); return; } } catch (er) { T.text[T.active] += '[' + er.message + ']\n'; drawTermOut(); }
});
(() => {
  const drag = $('termDrag'), work = $('termPanel'), app = $('app'); let on = false;
  drag.addEventListener('pointerdown', e => { on = true; document.body.classList.add('cs-dragging'); drag.setPointerCapture(e.pointerId); });
  drag.addEventListener('pointermove', e => { if (!on) return; const r = app.getBoundingClientRect(), sb = $('statusbar').offsetHeight; work.style.setProperty('--termh', Math.round(Math.min(Math.max(r.bottom - sb - e.clientY, 120), r.height * 0.6)) + 'px'); });
  drag.addEventListener('pointerup', () => { on = false; document.body.classList.remove('cs-dragging'); });
  drag.addEventListener('pointercancel', () => { on = false; document.body.classList.remove('cs-dragging'); });
})();

/* ---------- development workflow dashboard ---------- */
function renderWorkflow(data) {
  const host = $('devWorkflow'); if (!host) return;
  host.querySelectorAll('.wf-chip').forEach(n => n.remove());
  const summary = $('wfSummary');
  const sessions = (data && data.sessions) || [];
  summary.textContent = sessions.length ? `${sessions.filter(s => s.running).length} running · ${sessions.length} session${sessions.length === 1 ? '' : 's'}` : 'No terminal sessions yet';
  for (const s of sessions.slice(0, 8)) {
    const chip = document.createElement('span'); chip.className = 'wf-chip'; chip.dataset.state = s.status || (s.running ? 'running' : 'stopped');
    const label = document.createElement('span'); label.textContent = (s.running ? '● ' : '○ ') + s.name + (s.signal ? ` · ${s.signal}` : s.exitCode != null ? ` · exit ${s.exitCode}` : ''); chip.appendChild(label);
    if (s.urls && s.urls.length) {
      for (const url of s.urls.slice(0, 2)) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = new URL(url).host; a.title = 'Open development server ' + url; a.addEventListener('click', e => e.stopPropagation()); chip.appendChild(a); }
    } else if (s.result) { const tag = document.createElement('span'); tag.textContent = s.result; chip.appendChild(tag); }
    chip.title = [s.name, s.cwd, s.result, ...(s.urls || [])].filter(Boolean).join('\n');
    chip.addEventListener('click', () => showTerminal(s.id)); host.insertBefore(chip, $('wfRefresh'));
  }
}
async function refreshWorkflow() {
  if (!B.ok) { if ($('wfSummary')) $('wfSummary').textContent = 'Connect Agent Bridge to inspect workflow'; return; }
  try { renderWorkflow(await bcall('/workflow/status')); wfHistoryRender(); }
  catch (e) { if ($('wfSummary')) $('wfSummary').textContent = 'Workflow status unavailable'; }
}
$('wfRefresh')?.addEventListener('click', refreshWorkflow);
/* Phase 3E: lightweight repair history. Hidden until at least one repair event exists; inherits active theme. */
const WF_HISTORY_KEY = 'my-agent-repair-history-v1';
function wfHistoryRead() { try { const a = JSON.parse(localStorage.getItem(WF_HISTORY_KEY) || '[]'); return Array.isArray(a) ? a.slice(0, 60) : []; } catch { return []; } }
function wfHistoryAdd(event) {
  const items = wfHistoryRead();
  items.unshift({ id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), at: Date.now(), ...event });
  try { localStorage.setItem(WF_HISTORY_KEY, JSON.stringify(items.slice(0, 60))); } catch {}
  wfHistoryRender();
}
function wfHistoryRender() {
  const host = $('devWorkflow'); if (!host) return;
  let box = $('wfHistoryBox'); const items = wfHistoryRead();
  if (!items.length) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('details'); box.id = 'wfHistoryBox';
    box.style.cssText = 'flex-basis:100%;color:var(--muted);border-top:1px solid var(--line);padding:5px 0 2px;margin-top:2px';
    const summary = document.createElement('summary'); summary.textContent = 'Repair history'; summary.style.cssText = 'cursor:pointer;color:var(--ink);font-size:11px';
    const list = document.createElement('div'); list.id = 'wfHistoryItems'; list.style.cssText = 'display:grid;gap:5px;padding:6px 0';
    box.append(summary, list); host.appendChild(box);
  }
  const list = $('wfHistoryItems'); if (!list) return; list.replaceChildren();
  for (const item of items.slice(0, 8)) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px';
    const text = document.createElement('span');
    const date = new Date(item.at || Date.now()).toLocaleString();
    text.textContent = `${date} · ${item.status || 'started'} · ${item.terminal || 'terminal'} · attempt ${item.attempt || 1}${item.detail ? ' · ' + item.detail : ''}`;
    row.appendChild(text);
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn sm'; restore.textContent = 'Checkpoints'; restore.title = 'Open workspace checkpoints to compare or restore a saved version'; restore.addEventListener('click', () => openView('checkpoints')); row.appendChild(restore);
    list.appendChild(row);
  }
}

/* Phase 3F: workspace-scoped project memory; panel is opened on demand and uses theme tokens. */
let WF_MEMORY = [];
function wfMemoryRender() {
  const host = $('wfMemoryItems'); if (!host) return; host.replaceChildren();
  $('wfMemoryMeta').textContent = WF_MEMORY.length + ' saved note' + (WF_MEMORY.length === 1 ? '' : 's');
  if (!WF_MEMORY.length) { const p=document.createElement('div'); p.textContent='No project notes yet. Add durable decisions, commands, constraints, or known issues.'; p.style.color='var(--muted)'; host.appendChild(p); }
  WF_MEMORY.forEach((entry, i) => {
    const row=document.createElement('div'); row.style.cssText='display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:start';
    const ta=document.createElement('textarea'); ta.value=entry.text; ta.rows=Math.min(5,Math.max(2,Math.ceil(entry.text.length/90))); ta.setAttribute('aria-label','Project memory note '+(i+1)); ta.style.cssText='width:100%;resize:vertical;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:7px;font:inherit'; ta.addEventListener('input',()=>{entry.text=ta.value;});
    const del=document.createElement('button'); del.className='btn sm'; del.type='button'; del.textContent='×'; del.title='Remove note'; del.addEventListener('click',()=>{WF_MEMORY.splice(i,1);wfMemoryRender();}); row.append(ta,del); host.appendChild(row);
  });
}
async function wfMemoryLoad() { if(!B.ok) { addErr('Connect Agent Bridge and open a workspace to use Project Memory.'); return; } try { const r=await bcall('/project-memory/get'); WF_MEMORY=r.entries||[]; wfMemoryRender(); $('wfMemoryPanel').hidden=false; } catch(e) { addErr('Could not load project memory: '+e.message); } }
$('wfMemoryBtn')?.addEventListener('click',()=>{ if($('wfMemoryPanel').hidden) wfMemoryLoad(); else $('wfMemoryPanel').hidden=true; });
$('wfMemoryClose')?.addEventListener('click',()=>{$('wfMemoryPanel').hidden=true;});
$('wfMemoryAdd')?.addEventListener('click',()=>{WF_MEMORY.push({id:(crypto.randomUUID?crypto.randomUUID():String(Date.now())),category:'note',text:'',updatedAt:Date.now()});wfMemoryRender();const a=$('wfMemoryItems').querySelector('textarea:last-of-type');if(a)a.focus();});
$('wfMemorySave')?.addEventListener('click',async()=>{if(!B.ok){addErr('Connect Agent Bridge first.');return;}try{const entries=WF_MEMORY.map(x=>({...x,text:String(x.text||'').trim()})).filter(x=>x.text);const r=await bcall('/project-memory/set',{entries});WF_MEMORY=entries;wfMemoryRender();addNote('Project memory saved ('+r.count+' notes).');}catch(e){addErr('Could not save project memory: '+e.message);}});
function wfContextNormalize(s) { return String(s||'').toLowerCase().replace(/```[\s\S]*?```/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' '); }
function wfContextTokens(s) { return new Set(wfContextNormalize(s).split(' ').filter(t=>t.length>2)); }
function wfShouldRetrieveContext(userRequest) {
  const q = String(userRequest || '').trim().toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ');
  if (!q) return false;
  // Capability/status questions should get a direct answer, not an unsolicited source dump.
  if (/\b(did you see|can you see|do you see|are you able to see|can you access|do you have access to|is .*\b(workspace|project)\b .*\b(open|connected|available)\b|workspace (open|connected|available)|project (open|connected|available)|what do you see in my workspace)\b/.test(q)) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|great|nice|got it|are you there|can you hear me)[.!? ]*$/.test(q)) return false;
  return true;
}
async function wfMemoryContext(userRequest='') {
  if(!B.ok || !wfShouldRetrieveContext(userRequest)) return '';
  try {
    const r=await bcall('/project-memory/get');
    const reqNorm=wfContextNormalize(userRequest), reqTokens=wfContextTokens(userRequest);
    const seen=new Set(), picked=[]; let budget=3200;
    for(const x of (r.entries||[])) {
      const raw=String(x.text||'').trim(); if(!raw) continue;
      const norm=wfContextNormalize(raw); if(!norm || seen.has(norm)) continue; seen.add(norm);
      // Avoid injecting a note that simply repeats the current user request.
      if(reqNorm && (norm===reqNorm || (norm.length>40 && reqNorm.includes(norm)))) continue;
      const tokens=wfContextTokens(raw); let overlap=0; for(const t of tokens) if(reqTokens.has(t)) overlap++;
      const text=raw.length>700?raw.slice(0,700)+'…[note trimmed]':raw;
      const cost=text.length+24; if(cost>budget) continue;
      picked.push({category:String(x.category||'note').slice(0,40),text,overlap}); budget-=cost;
    }
    // Relevant notes first; stable order for ties.
    picked.sort((a,b)=>b.overlap-a.overlap);
    if(!picked.length) return '';
    return 'Memory:\n'+picked.map(x=>'- ['+x.category+'] '+x.text).join('\n');
  } catch { return ''; }
}

/* Phase 3G: on-demand project understanding; keeps existing layout and theme tokens. */
let WF_PROJECT_SCAN = null;
function wfProjectScanRender(scan) {
  const host=$('wfProjectScanResults'); if(!host)return; host.replaceChildren();
  const add=(label,value)=>{const row=document.createElement('div');row.style.cssText='display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);gap:8px;padding:5px 0;border-bottom:1px solid var(--line)';const a=document.createElement('span');a.textContent=label;a.style.color='var(--muted)';const b=document.createElement('span');b.textContent=Array.isArray(value)?(value.join(', ')||'None detected'):String(value||'None detected');b.style.overflowWrap='anywhere';row.append(a,b);host.appendChild(row);};
  add('Project type',scan.projectType);add('Frameworks',scan.frameworks);add('Files scanned',scan.fileCount+(scan.truncated?' (limit reached)':''));add('Languages / extensions',Object.entries(scan.languageCounts||{}).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>k+' ('+v+')'));add('Top-level folders',scan.topLevel);add('Entry point candidates',scan.entryCandidates);add('Manifest/config files',scan.manifests);add('Package scripts',Object.entries(scan.scripts||{}).map(([k,v])=>k+': '+v));add('Suggested commands', (scan.recommendedCommands||[]).map(x=>x.command+' — '+x.reason));
  (scan.notes||[]).forEach((n,i)=>{if(i===0){const p=document.createElement('p');p.textContent=n;p.style.color='var(--muted)';host.appendChild(p);}});
  $('wfProjectScanMeta').textContent='Scanned '+new Date(scan.scannedAt||Date.now()).toLocaleTimeString(); $('wfProjectDraft').disabled=false;
}
$('wfProjectScan')?.addEventListener('click',async()=>{if(!B.ok){addErr('Connect Agent Bridge and open a workspace first.');return;}const panel=$('wfProjectScanPanel');panel.hidden=false;$('wfProjectScanMeta').textContent='Scanning…';$('wfProjectScanResults').replaceChildren();$('wfProjectDraft').disabled=true;try{WF_PROJECT_SCAN=await bcall('/project/understand');wfProjectScanRender(WF_PROJECT_SCAN); }catch(e){$('wfProjectScanMeta').textContent='Scan failed';addErr('Project scan failed: '+e.message);}});
$('wfProjectScanClose')?.addEventListener('click',()=>{$('wfProjectScanPanel').hidden=true;});
$('wfProjectDraft')?.addEventListener('click',async()=>{if(!B.ok)return;try{const r=await bcall('/project/understand/draft-memory');const existing=WF_MEMORY.map(x=>({...x}));const seen=new Set(existing.map(x=>x.text.trim().toLowerCase()));for(const e of (r.proposedEntries||[])){if(!seen.has(e.text.trim().toLowerCase()))existing.push(e);}WF_MEMORY=existing.slice(0,80);wfMemoryRender();$('wfProjectScanPanel').hidden=true;addNote('Project memory draft prepared. Review the notes, then press Save to keep them.');}catch(e){addErr('Could not prepare project memory draft: '+e.message);}});

/* Phase 3D: bounded automatic repair loop. Existing tool/permission gates remain authoritative. */
const WF_AUTO = { timer: null, busy: false, seen: new Set(), lastStarted: 0, attempts: new Map(), maxAttempts: 3 };
const WF_TEST_COMMAND_RE = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|check|typecheck|type-check)|pytest|\bpython\s+-m\s+unittest|\bphp\s+artisan\s+test|\bvendor\/bin\/phpunit|\b(?:cargo|go)\s+test|\bflutter\s+test|\bgradle\s+(?:test|check)|\bmvn\s+(?:test|verify)\b/i;
function wfTestEvidence(sessions, since=0) {
  const list=(sessions||[]).filter(x=>Number(x.startedAt||0)>=since && WF_TEST_COMMAND_RE.test(String(x.command||'')));
  const passed=list.find(x=>x.exited===true && Number(x.exitCode)===0 && !/\b(error|failed|failure|exception|traceback|ELIFECYCLE|ERR!)\b/i.test(String(x.outputTail||'')));
  const failed=list.find(x=>x.exited===true && Number(x.exitCode)!==0);
  return passed ? {status:'passed',session:passed} : failed ? {status:'failed',session:failed} : {status:'missing',session:list[0]||null};
}
function wfFingerprint(s) {
  const text = String(s.outputTail || '').replace(/\d{2}:\d{2}:\d{2}/g, 'TIME').slice(-1800);
  return [s.id, s.command || '', s.exitCode, text].join('|');
}
function wfHasError(s) {
  return (s.errorLines || []).length > 0 || s.status === 'failed' || (s.exitCode != null && s.exitCode !== 0);
}
function wfDetails(s, attempt) {
  return [
    '### Terminal: ' + s.name,
    'Repair attempt: ' + attempt + ' of ' + WF_AUTO.maxAttempts,
    'Status: ' + s.status + (s.exitCode != null ? ' (exit ' + s.exitCode + ')' : ''),
    'Working directory: ' + (s.cwd || '(unknown)'),
    'Command: ' + (s.command || '(interactive shell)'),
    s.urls && s.urls.length ? 'Detected URLs: ' + s.urls.join(', ') : '',
    s.errorLines && s.errorLines.length ? 'Potential error lines:\n' + s.errorLines.join('\n') : '',
    'Recent output:\n' + String(s.outputTail || '').slice(-6000)
  ].filter(Boolean).join('\n');
}
async function autoDiagnoseAndRepair() {
  if (!B.ok || WF_AUTO.busy || ctrl || Date.now() - WF_AUTO.lastStarted < 12000) return;
  try {
    const d = await bcall('/workflow/diagnostics');
    const candidates = (d.sessions || []).filter(s => wfHasError(s) && String(s.outputTail || '').length > 0);
    for (const s of candidates) {
      const fp = wfFingerprint(s);
      if (WF_AUTO.seen.has(fp)) continue;
      WF_AUTO.seen.add(fp);
      if (WF_AUTO.seen.size > 120) WF_AUTO.seen = new Set([...WF_AUTO.seen].slice(-60));
      const key = String(s.id) + '|' + String(s.command || '');
      const used = WF_AUTO.attempts.get(key) || 0;
      if (used >= WF_AUTO.maxAttempts) {
        if ($('wfSummary')) $('wfSummary').textContent = 'Auto Repair paused: retry limit reached for ' + (s.name || 'terminal');
        continue;
      }
      WF_AUTO.busy = true; WF_AUTO.lastStarted = Date.now();
      try {
        let current = s;
        for (let attempt = used + 1; attempt <= WF_AUTO.maxAttempts; attempt++) {
          WF_AUTO.attempts.set(key, attempt);
          if ($('wfSummary')) $('wfSummary').textContent = `Auto Repair: ${s.name || 'terminal'} · attempt ${attempt}/${WF_AUTO.maxAttempts}`;
          const verificationSince = Date.now();
          const prompt = 'AUTOMATIC DEBUG / REPAIR + VERIFICATION LOOP. Diagnose the failure from the evidence below. Inspect relevant files, make the smallest safe fix, then run an appropriate test/build/lint/type-check command supported by the project manifest. Prefer an existing package script; do not invent unavailable scripts. If the project has no suitable automated test, run the safest relevant available check and explicitly say that full tests were not run. Capture the actual command and result. A clean terminal alone is not proof that tests passed. Follow existing permission gates; never bypass approvals, overwrite unrelated work, change secrets, weaken security, or run destructive commands. If approval is needed, stop and explain. Stop after at most ' + WF_AUTO.maxAttempts + ' attempts. If the issue remains, report the exact unresolved error and next safe step.\n\n' + wfDetails(current, attempt);
          wfHistoryAdd({ status: 'started', terminal: s.name || 'terminal', terminalId: s.id, attempt, detail: 'Repair and test verification started' });
          await runAgent(prompt, []);
          // Refresh diagnostics after the agent turn; only retry if a current failure is still visible.
          await new Promise(resolve => setTimeout(resolve, 1500));
          const after = await bcall('/workflow/diagnostics');
          const latest = (after.sessions || []).find(x => String(x.id) === String(s.id));
          const testEvidence = wfTestEvidence(after.sessions, verificationSince);
          if (!latest || !wfHasError(latest)) {
            if (testEvidence.status === 'passed') {
              wfHistoryAdd({ status: 'verified', terminal: s.name || 'terminal', terminalId: s.id, attempt, detail: 'Test/build command exited 0: ' + String(testEvidence.session.command || '').slice(0, 120) });
              if ($('wfSummary')) $('wfSummary').textContent = 'Auto Repair: verification command passed for ' + (s.name || 'terminal');
            } else {
              wfHistoryAdd({ status: 'unverified', terminal: s.name || 'terminal', terminalId: s.id, attempt, detail: testEvidence.status === 'failed' ? 'Verification command failed: ' + String(testEvidence.session.command || '').slice(0, 100) : 'No completed test/build command evidence detected; inspect the agent report' });
              if ($('wfSummary')) $('wfSummary').textContent = 'Auto Repair: no error detected, but test result is unverified';
            }
            WF_AUTO.attempts.delete(key);
            break;
          }
          current = latest;
          if (attempt === WF_AUTO.maxAttempts) {
            wfHistoryAdd({ status: 'failed', terminal: s.name || 'terminal', terminalId: s.id, attempt, detail: 'Retry limit reached; error remains' });
            if ($('wfSummary')) $('wfSummary').textContent = 'Auto Repair stopped after ' + WF_AUTO.maxAttempts + ' attempts; error remains in ' + (s.name || 'terminal');
          }
        }
      } catch (e) {
        wfHistoryAdd({ status: 'interrupted', terminal: 'terminal', attempt: 0, detail: String(e.message || e).slice(0, 180) });
        if ($('wfSummary')) $('wfSummary').textContent = 'Auto Repair stopped: ' + e.message;
      } finally { WF_AUTO.busy = false; }
      return;
    }
  } catch (e) {
    if ($('wfSummary') && B.ok) $('wfSummary').textContent = 'Auto diagnostics temporarily unavailable';
  }
}
function startWorkflowAutoRepair() {
  if (WF_AUTO.timer) clearInterval(WF_AUTO.timer);
  WF_AUTO.timer = setInterval(() => { refreshWorkflow(); autoDiagnoseAndRepair(); }, 5000);
  autoDiagnoseAndRepair();
}
startWorkflowAutoRepair();
wfHistoryRender();

/* ================= sidebar: skills, extensions, connections ================= */
