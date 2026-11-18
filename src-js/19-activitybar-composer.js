let curView = 'explorer';
function onViewOpen(v) {
  if (v === 'explorer') refreshExplorer();
  if (v === 'sessions') renderSessions();
  if (v === 'git') gitRefresh();
  if (v === 'checkpoints') { $('cpAuto').checked = S.autoCheckpoint !== false; renderCheckpoints(); refreshCheckpoints(); }
  if (v === 'codebase') refreshCodeIndexStatus();
  if (v === 'log') renderActivity();
  if (v === 'models') renderProviders();
  if (v === 'skills') { renderSkills(); if (B.ok) refreshSkills().then(renderSkills).catch(() => {}); }
  if (v === 'ext') { extTries = 0; refreshExtUI(); }
  if (v === 'tools') renderTools();
  if (v === 'conn') refreshConnUI();
}
function showView(v) {
  const app = $('app');
  if (curView === v && !app.classList.contains('nosidebar')) app.classList.add('nosidebar'); else { app.classList.remove('nosidebar'); curView = v; }
  const open = !app.classList.contains('nosidebar');
  document.querySelectorAll('.abtn[data-view]').forEach(b => b.classList.toggle('on', open && b.dataset.view === curView));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.dataset.view === curView));
  if (open) onViewOpen(curView);
  if (typeof syncDockState === 'function') syncDockState();
}
/* Highlights the workspace-dock shortcuts so the active panel is obvious and a
   second tap on the same shortcut closes it again. */
function syncDockState() {
  const dockOpen = !$('app').classList.contains('nosidebar');
  document.querySelectorAll('#chatToolDock [data-tool]').forEach(b => {
    let on = false;
    if (b.dataset.tool === 'folder') {
      const hasRoot = (B.ok && B.info && B.info.root) || (!B.ok && typeof dirHandle !== 'undefined' && dirHandle);
      if (hasRoot) on = dockOpen && curView === 'explorer';
      b.title = hasRoot ? 'Show workspace files' : 'Open workspace folder';
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('on', !!on);
      return;
    }
    if (['models', 'ext', 'conn', 'tools', 'skills'].includes(b.dataset.tool)) on = dockOpen && curView === b.dataset.tool;
    else if (b.dataset.tool === 'browser') on = tabs.some(t => t.id === 'preview') && activeTab === 'preview';
    b.classList.toggle('on', on);
  });
}
document.querySelectorAll('.abtn[data-view]').forEach(b => { b.onclick = () => showView(b.dataset.view); });

// Compact Android workspace dock: keep every shortcut bound to an existing app action.
document.querySelectorAll('#chatToolDock [data-tool]').forEach(button => {
  button.addEventListener('click', () => {
    const action = button.dataset.tool;
    if (action === 'folder') {
      // Once a folder is open this shortcut shows the files instead of asking again;
      // the Explorer header now has its own "Open folder…" button to switch folders.
      if ((B.ok && B.info && B.info.root) || (!B.ok && dirHandle)) showView('explorer');
      else openFolder();
      return;
    }
    if (['models', 'ext', 'conn', 'tools', 'skills'].includes(action)) { showView(action); return; }
    if (action === 'browser') {
      // Toggle: a second tap closes/hides the browser, otherwise open it.
      if (tabs.some(t => t.id === 'preview') && activeTab === 'preview') {
        setBrowserFullscreen(false);
        closeTab('preview');
      } else {
        showPanel(true);
      }
      syncDockState();
    }
  });
});
$('cpCreate').onclick = createCheckpoint; $('cpRefresh').onclick = refreshCheckpoints;
$('codeIndexBuild').onclick = rebuildCodeIndex; $('codeIndexRefresh').onclick = refreshCodeIndexStatus; $('codeSearchBtn').onclick = searchCodeIndex; $('codeMapBtn').onclick = showCodeProjectMap;
$('codeQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchCodeIndex(); } });
$('cpAuto').onchange = () => { S.autoCheckpoint = $('cpAuto').checked; S.updated = Date.now(); saveLocal(); if (B.ok) pushConfig(); cpSay('Automatic checkpointing ' + (S.autoCheckpoint ? 'enabled.' : 'disabled.') ); };
const autoSize = () => { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; };
const pendingFilePaths = [], pendingImages = [], pendingTextFiles = [], pendingElements = []; let pendingSelection = '';
function renderAttachTray() {
  const box = $('attachTray'); box.innerHTML = '';
  const entries = [ ...pendingFilePaths.map((path, i) => ({ kind: 'file', label: '@' + path, remove: () => pendingFilePaths.splice(i, 1) })), ...pendingImages.map((im, i) => ({ kind: 'image', label: im.name, remove: () => pendingImages.splice(i, 1) })), ...pendingTextFiles.map((f, i) => ({ kind: 'text', label: 'File: ' + f.name, remove: () => pendingTextFiles.splice(i, 1) })), ...pendingElements.map((el, i) => ({ kind: 'element', label: el.kind === 'selection' ? 'Page text · ' + String(el.text || '').slice(0, 28) : '🌐 ' + (el.label || el.tag || 'element'), remove: () => pendingElements.splice(i, 1) })), ...(pendingSelection ? [{ kind: 'selection', label: 'Editor selection (' + pendingSelection.length + ' chars)', remove: () => { pendingSelection = ''; } }] : []) ];
  box.hidden = !entries.length; entries.forEach((x, i) => { const chip = document.createElement('span'); chip.className = 'attachchip'; const label = document.createElement('span'); label.textContent = x.label; const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove attachment'; rm.onclick = () => { x.remove(); renderAttachTray(); }; chip.append(label, rm); box.appendChild(chip); });
}
async function addFilesToComposer(files) {
  for (const file of [...(files || [])]) {
    if (file.type && file.type.startsWith('image/')) {
      if (pendingImages.length >= 4) { addErr('You can attach up to 4 images per message.'); break; }
      if (file.size > 12 * 1024 * 1024) { addErr(file.name + ' is larger than 12 MB.'); continue; }
      if (!P().vision) { addErr('The active model is not marked as vision-capable. Select a vision model in Models before attaching images.'); continue; }
      try {
        let dataUrl;
        if (typeof createImageBitmap === 'function') {
          const bmp = await createImageBitmap(file), max = 1600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
          const ctx = canvas.getContext('2d'); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close();
          dataUrl = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.82);
        } else dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
        pendingImages.push({ name: file.name || 'image', dataUrl });
      } catch (e) { addErr('Could not attach ' + file.name + ': ' + e.message); }
    } else {
      if (pendingTextFiles.length >= 8) { addErr('You can attach up to 8 text files.'); break; }
      if (file.size > 1024 * 1024) { addErr(file.name + ' exceeds the 1 MB text attachment limit. Use @ to attach a project file excerpt instead.'); continue; }
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (!/^(txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|php|html?|css|xml|ya?ml|sql|java|kt|dart|go|rs|sh|bat|ps1|log|csv|toml|ini|env|gitignore|dockerfile)$/i.test(ext) && !/^(readme|license|makefile|dockerfile)$/i.test(file.name)) { addErr(file.name + ' is not a supported text attachment.'); continue; }
      try { pendingTextFiles.push({ name: file.name, content: await file.text() }); } catch (e) { addErr('Could not read ' + file.name + ': ' + e.message); }
    }
  }
  renderAttachTray();
}

/* Phase 3J: request-aware code retrieval. Heuristic import discovery and focused excerpts; no UI changes. */
function wfExtractImports(source) {
  const out = new Set(), text = String(source || '').slice(0, 180000);
  const patterns = [/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g, /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /(?:include|require_once|include_once)\s*\(?\s*['"]([^'"]+)['"]/g];
  for (const re of patterns) { let m; while ((m = re.exec(text)) && out.size < 30) { const spec=String(m[1]||'').trim(); if (spec && (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('~/'))) out.add(spec); } }
  return [...out];
}
function wfFocusedExcerpt(source, query, maxChars) {
  const text=String(source||''); if(text.length<=maxChars) return text;
  const lines=text.split(/\r?\n/), terms=[...wfContextTokens(query)].filter(t=>t.length>2).slice(0,18), hits=[];
  for(let i=0;i<lines.length;i++){const low=lines[i].toLowerCase();let score=0;for(const t of terms)if(low.includes(t))score++;if(score)hits.push({i,score});}
  if(!hits.length) return text.slice(0,Math.max(0,maxChars-40))+'\n…[focused excerpt truncated; no keyword match in prefix]';
  hits.sort((a,b)=>b.score-a.score || a.i-b.i);
  const windows=[]; let used=0;
  for(const hit of hits){let a=Math.max(0,hit.i-5),b=Math.min(lines.length,hit.i+9); if(windows.some(w=>a<=w.b+2&&b>=w.a-2))continue; const chunk=lines.slice(a,b).join('\n'); if(used+chunk.length>maxChars)continue; windows.push({a,b,chunk,score:hit.score});used+=chunk.length+30;if(used>=maxChars*0.8)break;}
  windows.sort((a,b)=>a.a-b.a);
  if(!windows.length) return text.slice(0,Math.max(0,maxChars-35))+'\n…[excerpt truncated]';
  return windows.map(w=>'[… lines '+(w.a+1)+'–'+w.b+' …]\n'+w.chunk).join('\n…\n').slice(0,maxChars);
}
function wfPathBase(spec) { return String(spec||'').replace(/\\/g,'/').split('/').filter(Boolean).pop().replace(/\.(?:js|jsx|ts|tsx|mjs|cjs|py|php|java|kt|go|rs|vue|svelte)$/i,'').toLowerCase(); }
async function wfSmartContext(userRequest) {
  if (!B.ok || !userRequest || userRequest.trim().length < 4 || !wfShouldRetrieveContext(userRequest)) return '';
  try {
    const query=userRequest.replace(/```[\s\S]*?```/g,' ').replace(/https?:\/\/\S+/g,' ').replace(/[^\p{L}\p{N}_$./ -]/gu,' ').replace(/\s+/g,' ').trim().slice(0,220);
    if(query.length<4)return '';
    const found=await bcall('/index/search',{query,limit:20});
    const results=found.results||[]; if(!results.length)return '';
    const queryTokens=wfContextTokens(query), byPath=new Map();
    function addHit(hit, extra=0, reason='search'){
      const p=String(hit.path||'').replace(/\\/g,'/');
      if(!p || p.split('/').some(part=>/^(node_modules|vendor|dist|build|coverage|\.git|\.agent)$/i.test(part)))return;
      if(/(^|\/)(\.env(?:\..*)?|.*(?:secret|credential|private.?key|id_rsa).*)$/i.test(p))return;
      const pathTokens=wfContextTokens(p);let overlap=0;for(const t of pathTokens)if(queryTokens.has(t))overlap++;
      const score=(Number(hit.score)||0)+overlap*2+extra, prev=byPath.get(p);
      if(!prev||score>prev.score)byPath.set(p,{path:p,score,reason});
    }
    results.forEach(h=>addHit(h));
    // Read a small seed set, then use relative imports to discover likely dependency files.
    const seeds=[...byPath.values()].sort((a,b)=>b.score-a.score).slice(0,5), seedContents=[];
    for(const seed of seeds){try{const r=await bcall('/fs/read',{path:seed.path});const content=String(r.content||'');if(content)seedContents.push({path:seed.path,content});}catch{}}
    const importSpecs=[...new Set(seedContents.flatMap(x=>wfExtractImports(x.content)))].slice(0,12);
    for(const spec of importSpecs){
      const base=wfPathBase(spec);if(!base||base.length<2)continue;
      try{const dep=await bcall('/index/search',{query:base,limit:5});for(const h of(dep.results||[])){const hp=String(h.path||'').replace(/\\/g,'/');const name=wfPathBase(hp.split('/').pop());const exact=name===base;addHit(h,exact?7:0,'import '+spec);}}catch{}
    }
    // Phase 3K: use the existing relationship index to find files that depend on, or are imported by, seed files.
    const relationNotes=[];
    for(const seed of seeds.slice(0,4)){
      try{
        const rel=await bcall('/index/related',{path:seed.path});
        for(const item of (rel.importedBy||[]).slice(0,8)){
          if(item.path){addHit({path:item.path,score:0},4,'depends on '+seed.path);relationNotes.push(item.path+' imports '+seed.path);}
        }
        for(const item of (rel.imports||[]).slice(0,8)){
          if(item.path){addHit({path:item.path,score:0},2,'dependency of '+seed.path);}
        }
      }catch{}
    }
    // If the request mentions likely identifiers, use indexed symbol references to expose possible change impact.
    const identifiers=[...new Set(query.match(/\b[A-Za-z_$][\w$]{2,}\b/g)||[])].filter(x=>!['please','change','update','modify','fix','file','function','class','method','project','this','that','with','from'].includes(x.toLowerCase())).slice(0,4);
    for(const symbol of identifiers){
      try{const refs=await bcall('/index/references',{symbol,limit:18});for(const ref of(refs.references||[])){if(ref.path)addHit({path:ref.path,score:0},ref.definition?4:2,'symbol '+symbol);}}catch{}
    }
    const chosen=[...byPath.values()].sort((a,b)=>b.score-a.score).slice(0,14), blocks=[], fingerprints=new Set();let budget=6500;
    for(const item of chosen){
      if(budget<=0||blocks.length>=5)break;
      try{
        const cached=seedContents.find(x=>x.path===item.path);const r=cached?{content:cached.content}:await bcall('/fs/read',{path:item.path});let content=String(r.content||'');
        if(!content||/(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*['"`][^'"`\r\n]{8,}/i.test(content))continue;
        const fingerprint=wfContextNormalize(content.slice(0,6000)).slice(0,1200);if(!fingerprint||fingerprints.has(fingerprint))continue;fingerprints.add(fingerprint);
        const cap=Math.min(item.reason.startsWith('import ')?900:1700,budget);content=wfFocusedExcerpt(content,query,cap);
        const block='['+item.path+(item.reason.startsWith('import ')?' · '+item.reason:'')+']\n```\n'+content+'\n```';
        blocks.push(block);budget-=content.length+item.path.length+60;
      }catch{}
    }
    if(!blocks.length)return '';
    return 'Files:\n'+(relationNotes.length?'Related: '+[...new Set(relationNotes)].slice(0,8).join('; ')+'\n':'')+blocks.join('\n\n');
  }catch(e){console.warn('Smart context unavailable:',e);return '';}
}

/* The model currently chosen for OpenCode CLI. In OpenCode mode the selector holds opencode::...
   values; fall back to the configured OpenCode model. The native /opencode/run uses the model in
   OpenCode's own auth config when this is empty. */
function currentOpenCodeModel() {
  try {
    const q = $('provQuick');
    if (q && q.value && q.value.startsWith('opencode::')) return q.value.slice('opencode::'.length);
  } catch {}
  return (openCodeModelsCache && openCodeModelsCache.configured) || '';
}

/* v43: Android-local OpenCode execution calls the native adapter DIRECTLY (never bcall), so a
   remote bridge URL can never redirect an Android-folder run to the remote agent-server, which
   has no Android folder. Falls back to bcall only if the native adapter is somehow absent. */
function ocLocalCall(pathname, body) {
  try {
    if (typeof csNativeCall === 'function' && window.CodeSpaceNative &&
        typeof window.CodeSpaceNative.localApiCall === 'function') {
      return csNativeCall(pathname, body, undefined);
    }
  } catch (e) { /* fall through to bcall */ }
  return bcall(pathname, body);
}

/* Genuine Android-local OpenCode CLI execution: poll NDJSON output from the native bridge and
   turn it into the same progress/live/done events the remote SSE path produces. Never falls back
   to an AI API — the real CLI binary output drives the result. */
async function runOpenCodeAndroidLocalOnce(text, sess) {
  const started = await ocLocalCall('/opencode/run', {
    prompt: text, sessionId: sess.openCodeSessionId || '', autoApprove: !!S.openCodeAutoApprove, title: sess.title,
    model: currentOpenCodeModel(),
    thinkLevel: (typeof S !== 'undefined' && S.thinkLevel) ? S.thinkLevel : 'off'
  });
  if (!started || started.ok === false) {
    const err = (started && started.error) || 'Could not start OpenCode CLI on this device.';
    if (started && started.needsInstall) {
      addErr(err + ' Open Settings → OpenCode CLI to install/set up the CLI (Termux or a bundled Android-compatible binary). OpenCode CLI will NOT be silently switched to OpenCode Zen.');
    } else addErr('OpenCode CLI failed: ' + err);
    return null;
  }
  if (started.sessionId) sess.openCodeSessionId = started.sessionId;
  if (started.mirrored) feedPush && feedPush('Android folder mirrored to a local workspace; changes will sync back after the run.');
  // Parse OpenCode NDJSON events from the growing output file.
  const messageParts = new Map(); const order = []; const seen = new Set(); let plain = ''; let session = started.sessionId || '';
  const onLine = line => {
    line = String(line || '').trim(); if (!line) return;
    let ev; try { ev = JSON.parse(line); } catch { plain = (plain + line + '\n').slice(-40000); return; }
    if (typeof ev.sessionID === 'string' && /^ses_[A-Za-z0-9_-]{4,200}$/.test(ev.sessionID)) session = ev.sessionID;
    const part = ev.part || {};
    if (typeof part.sessionID === 'string' && /^ses_[A-Za-z0-9_-]{4,200}$/.test(part.sessionID)) session = part.sessionID;
    const typ = String(ev.type || ev.event || ''), ptyp = String(part.type || '');
    if (typ === 'text' || ptyp === 'text') {
      const t = typeof part.text === 'string' ? part.text : (typeof ev.text === 'string' ? ev.text : '');
      if (t) {
        const mid = String(part.messageID || ev.messageID || session + ':m');
        const pid = String(part.id || ev.id || mid + ':' + messageParts.size);
        if (!messageParts.has(mid)) { messageParts.set(mid, new Map()); order.push(mid); }
        seen.add(mid + '|' + pid); messageParts.get(mid).set(pid, t.slice(0, 150000));
        const tail = t.replace(/\s+/g, ' ').trim().slice(-140);
        if (tail && maFeed) { if (!maFeed.liveRowId || !maFeed.rows.has(maFeed.liveRowId)) maFeed.liveRowId = feedPush('OpenCode is writing… · ' + tail, { force: true }); else feedSet(maFeed.liveRowId, 'OpenCode is writing… · ' + tail); }
      }
    } else if (/tool|step_start|step-finish|step_finish|session\.status/i.test(typ + ' ' + ptyp)) {
      const tool = String(part.tool || part.name || ev.tool || '').replace(/[^A-Za-z0-9 _./:-]/g, '').slice(0, 60);
      if (tool) feedPush('OpenCode is using ' + tool + '…');
    }
  };
  let since = 0; let carried = ''; const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    if (ctrl && ctrl.signal.aborted) { try { await ocLocalCall('/opencode/run/cancel', { sessionId: session }); } catch {} throw new DOMException('Aborted', 'AbortError'); }
    let snap; try { snap = await ocLocalCall('/opencode/run/read', { sessionId: session, since }); } catch (e) { throw e; }
    if (snap && snap.data) {
      carried += snap.data;
      let at; while ((at = carried.indexOf('\n')) >= 0) { onLine(carried.slice(0, at)); carried = carried.slice(at + 1); }
    }
    if (typeof snap.next === 'number') since = snap.next;
    if (snap && snap.exited) {
      if (carried.trim()) onLine(carried);
      const lastMid = order.slice().reverse().find(m => [...(messageParts.get(m) || new Map()).values()].join('').trim());
      let finalText = lastMid ? [...messageParts.get(lastMid).values()].join('') : '';
      if (!finalText.trim() && plain.trim()) finalText = plain.trim();
      if (started.mirrored) { try { const s = await ocLocalCall('/opencode/workspace/sync-out', {}); if (s.conflicts && s.conflicts.length) addErr('Some OpenCode changes were not synced back (conflicts): ' + s.conflicts.map(c => c.path).join(', ')); else feedPush('Android folder synchronized (' + (s.written || 0) + ' file(s)).'); } catch {} }
      return { exitCode: snap.code == null ? -1 : snap.code, sessionId: session, text: finalText, stderr: snap.stderr || '', timedOut: false };
    }
    await new Promise(r => setTimeout(r, 350));
  }
  try { await ocLocalCall('/opencode/run/cancel', { sessionId: session }); } catch {}
  return { exitCode: -1, sessionId: session, text: '', stderr: 'Timed out after 60 minutes.', timedOut: true };
}

/* Detect a quota / rate-limit / exhausted-key failure from OpenCode CLI output so we can fall
   back to the next saved API key against the SAME model. */
function looksLikeQuotaFailure(r) {
  if (!r) return false;
  if (r.exitCode === 0) return false;
  const s = String((r.stderr || '') + '\n' + (r.text || '')).toLowerCase();
  return /rate.?limit|quota|too many requests|429|insufficient (quota|credits|balance)|credit balance|exhausted|billing|upgrade (your )?plan|resource.?exhausted|overloaded/.test(s);
}

/* Run OpenCode CLI, and when a key is rate-limited/exhausted, rotate to the next saved API key
   and retry with the SAME prompt and model. Bounded by the number of keys to avoid loops. */
async function runOpenCodeAndroidLocal(text, sess) {
  let result = null;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    result = await runOpenCodeAndroidLocalOnce(text, sess);
    if (!result || result.exitCode === 0 || ctrl && ctrl.signal.aborted) return result;
    if (!looksLikeQuotaFailure(result)) return result;
    let rotated;
    try { rotated = await bcall('/opencode/keys/rotate', { reason: 'quota' }); } catch { return result; }
    if (!rotated || !rotated.rotated) {
      addErr('OpenCode API key hit its limit and there is no other saved key to fall back to. Add more keys in Settings → OpenCode CLI.');
      return result;
    }
    feedPush && feedPush('OpenCode key hit its limit — switched to ' + (rotated.label || 'next key') + ', retrying with the same model…');
    // A fresh session per attempt so a failed session does not pollute the retry.
    sess.openCodeSessionId = '';
    await new Promise(r => setTimeout(r, 400));
  }
  return result;
}

async function runOpenCodeChat(text, userDisplayText = text, privateContext = '') {
  await refreshWorkspaceInfo();
  // Authoritative routing: an Android-selected workspace (or local mode) ALWAYS uses the real
  // device CLI — never the remote server, which has no Android folder.
  const hasAndroidWorkspace = !!(activeWorkspaceState && activeWorkspaceState.platform === 'android');
  const nativeMode = (L.bridgeUrl === 'codespace-native://local' || isAndroidFolderWorkspace());
  // v43 workspace trace. The full workspace/state dump is logged by refreshWorkspaceInfo(); this
  // records the final routing decision and the endpoint it selects.
  try { ocWsLog('runOpenCodeChat:route', { nativeMode, isAndroidFolderWorkspace: isAndroidFolderWorkspace(), endpoint: nativeMode ? 'android-local:/opencode/run' : (L.bridgeUrl.replace(/\/+$/, '') + '/opencode/run') }); } catch (e) {}
  if (nativeMode) {
    // Missing/revoked/unavailable folder: clear, actionable error; no remote/Zen fallback.
    if (hasAndroidWorkspace && !activeWorkspaceState.available) {
      addErr('OpenCode CLI cannot start: ' + (activeWorkspaceState.error || 'the selected folder is unavailable') + ' Open Folder to select a valid project folder.');
      return;
    }
    // Cached-first availability (same rule as the tap): await an in-flight probe, and only run a
    // fresh one when we have no valid status. A transient probe failure must NOT reset the current
    // selection (that would silently restore CodeSpace) — it only blocks this dispatch with a
    // clear reason. The actual run below is the real execution gate.
    if (!opencodeRuntimeAvailable()) { await awaitOpenCodeStatusIfInFlight(); }
    let status = lastOpenCodeStatus || {};
    if (!opencodeRuntimeAvailable()) { await refreshOpenCodeStatus(); status = lastOpenCodeStatus || {}; }
    ocLog('runOpenCodeChat:dispatch-check', JSON.stringify({ nativeMode, available: opencodeRuntimeAvailable(), termuxState: status.termuxState }));
    if (!opencodeRuntimeAvailable()) {
      const why = status && status.message ? status.message : '';
      const st = status && status.termuxState ? ' [' + status.termuxState + ']' : '';
      addErr('OpenCode CLI is unavailable' + st + '. ' + why + ' Open Settings → OpenCode CLI to set it up. OpenCode CLI is NOT silently switched to OpenCode Zen.');
      S.openCodeCLI = false; S.updated = Date.now(); saveLocal(); if (typeof syncMode === 'function') syncMode(); if (typeof updateMeters === 'function') updateMeters();
      return;
    }
  }
  const sess = cur(), h = sess.messages;
  const privatePromptContext = String(privateContext || '').trim()
    ? '\n\nINTERNAL ATTACHMENT REFERENCE (not the user request):\n' + String(privateContext).slice(0, 26000) + '\n\nUse this reference only to answer the users actual request. Never dump or quote this reference, its headers, excerpt markers, or full file contents unless explicitly asked. Keep the answer concise.'
    : '';
  for (let i = h.length - 1; i >= 0; i--) if (isInternalAgentMessage(h[i])) h.splice(i, 1);
  // 3.12.7: same continuation context as the built-in engines — a stopped OpenCode run must
  // not leave the next "continue" prompt contextless.
  const continuationNote = buildContinuationNote(sess, h);
  resetPlanForNewTurn(sess);
  chatAutoFollowActiveTurn = true;
  h.push({ role: 'user', content: userDisplayText, images: [] });
  if (sess.title === 'New chat') sess.title = userDisplayText.replace(/\s+/g, ' ').slice(0, 48);
  sess.updated = Date.now();
  if (chat.querySelector('.empty')) chat.innerHTML = '';
  appendItem(h[h.length - 1], true); $('chatTitle').textContent = sess.title; renderPlanPanel();
  ctrl = new AbortController(); setBusy(true, 'OpenCode CLI: starting…');
  startAssistantActivity('OpenCode CLI', 'Starting your task');
  maFeed.liveRowId = 0; maFeed.progId = feedPush('Starting OpenCode CLI');
  let result = null, readError = '', openCodeSuccess = false;
  try {
    const fullPrompt = text + privatePromptContext + continuationNote;
    if (nativeMode) {
      result = await runOpenCodeAndroidLocal(fullPrompt, sess);
      if (!result) return;
    } else {
    const response = await fetch(L.bridgeUrl.replace(/\/+$/, '') + '/opencode/run', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + L.bridgeToken, Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt: fullPrompt, sessionId: sess.openCodeSessionId || '', autoApprove: !!S.openCodeAutoApprove, title: sess.title, model: (typeof P === 'function' && P() && P().model) ? P().model : '', thinkLevel: (typeof S !== 'undefined' && S.thinkLevel) ? S.thinkLevel : 'off' })
    });
    if (!response.ok) { const d = await response.json().catch(() => ({})); throw new Error(d.error || ('OpenCode bridge error ' + response.status)); }
    if (!response.body) throw new Error('The browser does not support streaming this OpenCode response.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buf = '';
    const eventPacket = packet => {
      for (const line of packet.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'progress') { const progress = String(ev.message || 'OpenCode CLI is working…').slice(0, 180); setBusy(true, progress); updateTurnActivity('assistant', 'working', progress); feedEnd(maFeed.progId, 'ok'); maFeed.progId = feedPush(progress); }
        else if (ev.type === 'live') {
          // Live model detail (writing tail / waiting heartbeat): updates one row instead of stacking lines.
          const live = String(ev.message || 'OpenCode is working…').slice(0, 120) + (ev.tail ? ' · ' + String(ev.tail).slice(0, 140) : '');
          if (!maFeed.liveRowId || !maFeed.rows.has(maFeed.liveRowId)) maFeed.liveRowId = feedPush(live, { force: true });
          else feedSet(maFeed.liveRowId, live);
          setBusy(true, live); updateTurnActivity('assistant', 'working', live);
        }
        else if (ev.type === 'done') result = ev;
        else if (ev.type === 'error') readError = String(ev.error || 'OpenCode CLI failed');
      }
    };
    while (true) {
      const part = await reader.read(); if (part.done) break;
      buf += decoder.decode(part.value, { stream: true });
      let at; while ((at = buf.indexOf('\n\n')) >= 0) { eventPacket(buf.slice(0, at)); buf = buf.slice(at + 2); }
    }
    if (buf.trim()) eventPacket(buf);
    }
    // 3.12.7: a Stop pressed mid-run can surface as a clean stream end (see readSSE note);
    // without this check an interrupted OpenCode run was reported as a generic failure
    // instead of "cancelled", and the next turn lost the unfinished-work context.
    if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!result) throw new Error(readError || 'OpenCode CLI ended without a completion event. Check that OpenCode is installed and its provider is logged in.');
    if (result.sessionId) sess.openCodeSessionId = result.sessionId;
    if (result.exitCode !== 0) {
      const detail = result.timedOut ? 'Timed out after 60 minutes.' : (result.stderr || ('Process exited with code ' + result.exitCode));
      addErr('OpenCode CLI failed. ' + detail.slice(0, 1800));
    } else if (String(result.text || '').trim()) {
      let cleanText = stripInternalContextDump(String(result.text).trim(), userDisplayText);
      if (!cleanText && isWorkspaceVisibilityQuestion(userDisplayText)) cleanText = workspaceVisibilityAnswer();
      if (cleanText) {
        const answer = { role: 'assistant', content: cleanText, model: 'OpenCode CLI', engine: 'opencode-cli' };
        h.push(answer); appendItem(answer, true); updateMeters(); openCodeSuccess = true;
      } else addErr('No answer.');
    } else {
      addErr('OpenCode CLI finished without a visible text answer. Check the terminal output or OpenCode session.');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') addErr('OpenCode CLI task cancelled. Review Git diff/checkpoints if it already changed files.');
    else addErr('OpenCode CLI request failed: ' + String(e && e.message || e));
  } finally {
    if (maFeed.liveRowId) { feedEnd(maFeed.liveRowId, ctrl && ctrl.signal.aborted ? 'skip' : (openCodeSuccess ? 'ok' : 'err')); maFeed.liveRowId = 0; }
    const activityStatus = ctrl && ctrl.signal.aborted ? 'cancelled' : (openCodeSuccess ? 'completed' : 'failed');
    setMultiAgentActivity('assistant', activityStatus, activityStatus === 'completed' ? 'Response complete' : activityStatus === 'cancelled' ? 'Stopped by you' : 'OpenCode run ended');
    sess.lastRunStop = ctrl && ctrl.signal.aborted ? 'cancelled' : (openCodeSuccess ? 'completed' : 'error'); // 3.12.7: feeds buildContinuationNote on the next turn
    ctrl = null; finishChatAutoFollow(); finishTurn(); setBusy(false); sess.updated = Date.now(); persistSession(); renderSessions();
  }
}

let sendPreparing = false;
async function send() {
  const v = $('input').value.trim(); if ((!v && !pendingFilePaths.length && !pendingImages.length && !pendingTextFiles.length && !pendingSelection && !pendingElements.length) || ctrl || sendPreparing) return;
  // OpenCode CLI mode is now genuinely supported on Android Local (real CLI process). The
  // runOpenCodeChat() entry point re-checks the real status and reports a clear setup error if
  // the CLI is unavailable — it never silently switches providers.
  if (S.openCodeCLI && pendingImages.length) { addErr('OpenCode CLI mode currently accepts text and file context, not image attachments. Turn OpenCode off to send images through a vision-capable CodeSpace model.'); return; }
  if (pendingImages.length && !P().vision) { addErr('Select a vision-capable model before sending attached images.'); return; }

  // Show the thin activity line synchronously on send, before any asynchronous
  // project-memory retrieval or attachment reads. Move it back under the new user
  // message when the agent run creates that transcript entry.
  sendPreparing = true;
  startAssistantActivity(S.openCodeCLI ? 'OpenCode CLI' : 'AI assistant', 'Thinking about your request');
  placeActivityBeforeTranscript();
  $('sendBtn').disabled = true;
  $('sendBtn').title = 'Preparing request…';

  // The transcript shows only what the user typed and short attachment names.
  // Retrieved context and file contents travel separately to the model.
  const visibleParts = [v || (pendingImages.length ? 'Please inspect the attached image(s).' : (pendingFilePaths.length || pendingTextFiles.length || pendingSelection || pendingElements.length ? 'Review the attached files.' : 'Please inspect the workspace.'))];
  const contextParts = [];
  try {
    if (!S.openCodeCLI) {
      const memRow = feedPush('Searching project memory');
      const memoryContext = await wfMemoryContext(v);
      feedEnd(memRow, 'ok');
      if (memoryContext) contextParts.push(memoryContext);
      const ctxRow = feedPush('Finding relevant files');
      const smartContext = await wfSmartContext(v);
      feedEnd(ctxRow, 'ok');
      if (smartContext) contextParts.push(smartContext);
    }
  } catch (e) {
    sendPreparing = false; $('sendBtn').disabled = false; $('sendBtn').title = '';
    setMultiAgentActivity('assistant', 'failed', 'Failed');
    addErr('Request preparation failed: ' + String(e && e.message || e).slice(0, 500));
    return;
  }
  const attachmentLabels = [];
  const fileBlocks = [];
  for (const file of pendingTextFiles) {
    let content = file.content;
    if (content.length > 30000) content = content.slice(0, 15000) + '\n…[trimmed]…\n' + content.slice(-15000);
    const ext = (file.name.split('.').pop() || '').replace(/[^a-z0-9_-]/gi, '');
    fileBlocks.push('[File: ' + file.name + ']\n```' + ext + '\n' + content + '\n```');
    attachmentLabels.push(file.name);
  }
  for (const path of pendingFilePaths) {
    try {
      let content = await fsRead(path);
      if (content.length > 30000) content = content.slice(0, 15000) + '\n…[trimmed]…\n' + content.slice(-15000);
      const ext = (path.split('.').pop() || '').replace(/[^a-z0-9_-]/gi, '');
      fileBlocks.push('[File: ' + path + ']\n```' + ext + '\n' + content + '\n```');
      attachmentLabels.push(path.split(/[\\/]/).pop() || path);
    } catch (e) { fileBlocks.push('[File read error: ' + path + ' · ' + e.message + ']'); attachmentLabels.push(path.split(/[\\/]/).pop() || path); }
  }
  if (pendingSelection) { fileBlocks.push('[Editor selection]\n```\n' + pendingSelection.slice(0, 30000) + '\n```'); attachmentLabels.push('Editor selection'); }
  for (const el of pendingElements) { fileBlocks.push(browserAttachmentBlock(el)); attachmentLabels.push(el.kind === 'selection' ? 'Page text' : (el.label || el.tag || 'element')); }
  if (fileBlocks.length) contextParts.push(fileBlocks.join('\n\n'));
  if (attachmentLabels.length) visibleParts.push('Attachments: ' + attachmentLabels.slice(0, 8).join(', '));
  const userDisplayText = visibleParts.filter(Boolean).join('\n');
  const privateContext = contextParts.join('\n\n');
  const imgs = pendingImages.slice();
  if (P().vision) for (const el of pendingElements) { if (el.image && imgs.length < 4) imgs.push({ name: (el.label || 'element') + '.jpg', dataUrl: el.image }); }
  pendingFilePaths.length = 0; pendingTextFiles.length = 0; pendingImages.length = 0; pendingElements.length = 0; pendingSelection = ''; renderAttachTray();
  $('input').value = ''; autoSize();
  sendPreparing = false; $('sendBtn').disabled = false; $('sendBtn').title = '';
  if (S.openCodeCLI) await runOpenCodeChat(userDisplayText, userDisplayText, privateContext);
  else await runAgent(userDisplayText, imgs, privateContext);
}
$('sendBtn').onclick = send;
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('input').addEventListener('input', autoSize);
$('stopBtn').onclick = () => { if (ctrl) ctrl.abort(); if ($('appr').open) $('appr').close('deny'); };
$('sessNew').onclick = newSession;
$('sessFilter').addEventListener('input', renderSessions);
// Chat history / compress / new now live in the File menu. Keep shared helpers so the
// context popover and menubar invoke the exact same implementations.
function csNewChat() { return newSession(); }
function csOpenHistory() { if (!(curView === 'sessions' && !$('app').classList.contains('nosidebar'))) showView('sessions'); }
function csCompress() { if (!ctrl && !compressing) { setBusy(true, 'Compressing context…'); return compressNow(true).finally(() => { setBusy(false); }); } }
$('sbCtx').onclick = () => $('ctxRing').click();
$('ctxRing').onclick = e => { e.stopPropagation(); const pop = $('ctxPop'); pop.hidden = !pop.hidden; if (!pop.hidden) updateMeters(); };
$('ctxCompress').onclick = () => { $('ctxPop').hidden = true; csCompress(); };
document.addEventListener('click', e => { if (!$('ctxPop').hidden && !e.target.closest('#ctxPop')) $('ctxPop').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('ctxPop').hidden = true; });
$('provQuick').onchange = e => {
  const v = String(e.target.value), at = v.indexOf('::'), pid = at < 0 ? v : v.slice(0, at), mid = at < 0 ? '' : v.slice(at + 2);
  // OpenCode CLI model selection: store it in OpenCode's own config, not the CodeSpace providers.
  if (pid === 'opencode') {
    if (mid) bcall('/opencode/auth/set', { model: mid }).then(() => { addNote('OpenCode model set to ' + mid + '.'); }).catch(err => addErr('Could not save OpenCode model: ' + err.message));
    if (openCodeModelsCache) openCodeModelsCache.configured = mid;
    syncModelBtn && syncModelBtn();
    return;
  }
  if (v === 'copilot::auto') {
    const act = P();
    if (!act || !copilotEligibleModel(act, act.model)) {
      const first = modelPickerItems().free[0]; // first free model of any enabled provider
      if (!first || !first.id) { addNote('CodeSpace Copilot needs at least one free model. Add or refresh free models in Models.'); S.copilotAuto = false; fillQuick(); return; }
      S.activeId = first.p.id; first.p.model = first.id;
    }
    S.copilotAuto = true; COPILOT_LAST_OK = '';
    S.updated = Date.now(); saveLocal(); fillQuick(); updateMeters(); syncOpenCodeUI(); if (B.ok) pushConfig();
    return;
  }
  const p = S.providers.find(x => x.id === pid); if (!p) return;
  S.copilotAuto = false; COPILOT_LAST_OK = '';
  if (S.chatZaiCLI && !isChatZaiProvider(p)) {
    S.chatZaiCLI = false; S.chatZaiPrevId = ''; S.updated = Date.now(); saveLocal();
    if (B.ok) { pushConfig(); bcall('/chat-zai/stop').catch(() => {}); }
    addNote('Chat Z.ai mode disabled because you selected another provider.');
  }
  S.activeId = pid; if (mid) p.model = mid;
  S.updated = Date.now(); saveLocal(); updateMeters(); syncOpenCodeUI();
  const mi = modelReasoningInfo(p);
  if (mi && (mi.supported === false || (Array.isArray(mi.efforts) && !mi.efforts.includes(S.thinkLevel))) && S.thinkLevel !== 'off') setThinkingStatus('unsupported', 'Thinking level not supported', 'The selected model does not advertise the requested effort. Choose a supported level or Think: Off.');
  else if (S.thinkLevel !== 'off') setThinkingStatus('warning', 'Think: ' + S.thinkLevel + ' · support not yet verified', 'CodeSpace will send a reasoning request parameter. Provider documentation and model support vary; a returned reasoning delta/token signal confirms reasoning data, but not necessarily the exact requested effort level.');
  if (B.ok) pushConfig();
};
const ROUTE_LABEL = { codespace: 'CodeSpace', opencode: 'OpenCode', zai: 'Chat Z.ai' };
const currentRoute = () => S.openCodeCLI ? 'opencode' : S.chatZaiCLI ? 'zai' : 'codespace';
let lastOpenCodeStatus = null; // result of the real /opencode/status probe (never faked)

/* v42 diagnostics. Unique prefix so a device logcat/console capture can be filtered:
   `adb logcat | grep OPENCODE_SELECT_V42`. Temporary instrumentation for the selection bug. */
function ocLog(...args) { try { console.log('[OPENCODE_SELECT_V42]', ...args); } catch {} }

/* v43 workspace-routing diagnostics. Unique prefix `[OPENCODE_WORKSPACE_V43]`. Written to the
   WebView console AND pushed to the native /diag/log endpoint so a physical-device capture of
   /sdcard/Download/codespace-diagnostics.txt shows the REAL workspace state and route (the web
   console alone is not captured there). Never throws, never blocks. */
function ocWsLog(event, data) {
  let line;
  try { line = '[OPENCODE_WORKSPACE_V43] ' + event + (data === undefined ? '' : ' ' + JSON.stringify(data)); }
  catch (e) { line = '[OPENCODE_WORKSPACE_V43] ' + event; }
  try { console.log(line); } catch (e) {}
  try {
    if (typeof csNativeCall === 'function' && window.CodeSpaceNative &&
        typeof window.CodeSpaceNative.localApiCall === 'function') {
      csNativeCall('/diag/log', { msg: line }).catch(() => {});
    }
  } catch (e) {}
  return line;
}

/* True when the Android-native OpenCode runtime is genuinely usable. The native /opencode/status
   reports termuxState OK only after a real `opencode --version` succeeded. We do NOT require an
   API key, a remote server, OpenCode Zen or a model list to enable the CLI *execution* option —
   auth/models are configured inside OpenCode separately. */
function opencodeRuntimeAvailable() {
  const s = lastOpenCodeStatus;
  if (!s || typeof s !== 'object') return false;
  if (s.termuxState === 'OK') return true;
  return !!(s.installed && s.runtimeKind && s.runtimeKind !== 'NONE');
}

/* Single-flight probe of the real runtime. Multiple UI paths (boot, menu-open, tap, settings, send)
   previously each launched their own /opencode/status RUN_COMMAND probe with no coordination; two
   concurrent Termux probes can make one fail transiently, which vetoed selection. All callers now
   share one in-flight promise and the SAME result is written to lastOpenCodeStatus. */
let opencodeStatusInFlight = null;
function refreshOpenCodeStatus() {
  if (opencodeStatusInFlight) return opencodeStatusInFlight;
  ocLog('probe:start /opencode/status');
  opencodeStatusInFlight = (async () => {
    try {
      if (typeof bcall === 'function') {
        const s = await bcall('/opencode/status', {}, undefined);
        if (s && typeof s === 'object') lastOpenCodeStatus = s;
      }
    } catch (e) { ocLog('probe:error', e && e.message); }
    ocLog('probe:done', JSON.stringify({ termuxState: lastOpenCodeStatus && lastOpenCodeStatus.termuxState, installed: lastOpenCodeStatus && lastOpenCodeStatus.installed, runtimeKind: lastOpenCodeStatus && lastOpenCodeStatus.runtimeKind }));
    if (typeof syncOpenCodeUI === 'function') syncOpenCodeUI();
    return lastOpenCodeStatus;
  })();
  opencodeStatusInFlight.then(
    () => { opencodeStatusInFlight = null; },
    () => { opencodeStatusInFlight = null; }
  );
  return opencodeStatusInFlight;
}
/* Wait for an already-running probe (boot/menu-open) without starting a new one. A tap must never
   launch a *fresh* Termux probe: a transient failure would overwrite a valid cached OK status and
   veto the selection even though the menu already showed the CLI as ready. */
async function awaitOpenCodeStatusIfInFlight() {
  if (opencodeStatusInFlight) { try { await opencodeStatusInFlight; } catch {} }
  return lastOpenCodeStatus;
}
/* Canonical "select OpenCode CLI" commit. Writes the SAME state the selector reads (currentRoute)
   and the composer dispatches on (send), persists it, and synchronizes the UI. Nothing else owns
   the selection — this is the single source of truth, so a refresh cannot overwrite it. */
function selectOpenCodeLocal(status) {
  ocLog('selectOpenCodeLocal:enter', JSON.stringify({ before: { openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI, copilotAuto: S.copilotAuto }, status: status && status.termuxState }));
  S.openCodeCLI = true;
  S.chatZaiCLI = false;
  S.copilotAuto = false;
  S.updated = Date.now();
  saveLocal();
  ocLog('selectOpenCodeLocal:after-assign+save', JSON.stringify({ openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI, copilotAuto: S.copilotAuto, updated: S.updated, persisted: (() => { try { return JSON.parse(localStorage.getItem('agent3.state') || '{}').openCodeCLI; } catch { return 'n/a'; } })(), currentRoute: currentRoute() }));
  try { if (typeof syncMode === 'function') syncMode(); } catch {}
  try { if (typeof updateMeters === 'function') updateMeters(); } catch {}
  try { if (typeof syncOpenCodeUI === 'function') syncOpenCodeUI(); } catch {}
  if (B.ok) { try { pushConfig(); } catch {} }
  ocLog('selectOpenCodeLocal:after-ui-sync', JSON.stringify({ currentRoute: currentRoute(), btnRoute: (() => { try { return $('routeBtn').dataset.route; } catch { return 'n/a'; } })(), btnLabel: (() => { try { const t = $('routeBtn').querySelector('.rt-txt'); return t ? t.textContent : 'n/a'; } catch { return 'n/a'; } })() }));
  const ver = status && status.version ? status.version : 'version unknown';
  const kind = status && status.runtimeKind ? status.runtimeKind : 'local';
  addNote('OpenCode CLI — Android Local enabled (' + ver + ', ' + kind + '). Chat messages now run the real OpenCode CLI on this device against your selected Android folder. Click the engine selector again to go back.');
}

let openCodeModelsCache = null; // OpenCode's own model IDs, shown only while OpenCode CLI mode is active
let openCodeModelsShown = false;

/* Populate the model selector with ONLY OpenCode models while OpenCode CLI mode is active. Uses
   the real /opencode/models endpoint; CodeSpace/Chat-Z providers are not shown in this mode. */
async function fillOpenCodeQuick() {
  const q = $('provQuick'); if (!q) return;
  openCodeModelsShown = true;
  try {
    if (!openCodeModelsCache) openCodeModelsCache = await bcall('/opencode/models', {});
    const models = (openCodeModelsCache && openCodeModelsCache.models) || [];
    // Publish to the shared model picker so the popup shows only OpenCode models.
    if (typeof globalThis !== 'undefined') globalThis.__opencodeModelIds = models.slice();
    const prev = q.value;
    q.innerHTML = '';
    const g = document.createElement('optgroup'); g.label = 'OpenCode models (' + models.length + ')';
    models.forEach(id => { const o = document.createElement('option'); o.value = 'opencode::' + id; o.textContent = id; g.appendChild(o); });
    q.appendChild(g);
    const cur = (openCodeModelsCache && openCodeModelsCache.configured) || (openCodeModelsCache && openCodeModelsCache.default) || '';
    const want = 'opencode::' + cur;
    q.value = models.some(m => 'opencode::' + m === prev) ? prev : (models.some(m => 'opencode::' + m === want) ? want : (q.firstChild && q.firstChild.value ? q.firstChild.value : ''));
    if (typeof syncModelBtn === 'function') syncModelBtn();
  } catch { /* keep existing options if the model list can't be loaded */ }
}
function syncThinkVisibility() {
  const ts = $('thinkSel'); if (!ts) return;
  const p = S.providers.find(x => x.id === S.activeId) || S.providers[0];
  ts.hidden = !thinkingSupported(p);                 // unsupported model (or OpenCode): the control disappears entirely
}
function syncOpenCodeUI() {
  const btn = $('routeBtn'); if (!btn) return;
  const route = currentRoute(), ready = !!(B.ok && B.info && B.info.root), on = route === 'opencode';
  ocLog('syncOpenCodeUI:render', JSON.stringify({ route, on, openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI }));
  btn.dataset.route = route; btn.classList.toggle('on', route !== 'codespace');
  btn.querySelector('.rt-txt').textContent = ROUTE_LABEL[route];
  btn.setAttribute('aria-label', 'Chat engine: ' + ROUTE_LABEL[route]);
  btn.title = route === 'opencode' ? 'OpenCode CLI is answering. Open the menu to switch back to CodeSpace.'
    : route === 'zai' ? 'Chat Z.ai is answering. Open the menu to switch back to CodeSpace.'
    : 'Choose which engine answers your messages.';
  $('routeMenu').querySelectorAll('[data-route]').forEach(o => {
    const r = o.dataset.route; o.setAttribute('aria-checked', String(r === route));
    const localNative = L.bridgeUrl === 'codespace-native://local';
    const androidFolder = isAndroidFolderWorkspace();
    const nativeMode = localNative || androidFolder;
    const cliOk = opencodeRuntimeAvailable();
    // Android/Termux runtime OK -> CLI is enabled regardless of API keys or model lists.
    // Remote workspaces keep the previous "needs bridge + folder" rule.
    const ocReady = nativeMode ? cliOk : ready;
    o.classList.toggle('notready', (r === 'opencode' && !ocReady) || (r === 'zai' && !B.ok));
    if (r === 'opencode') {
      o.disabled = false; // never block the click; an unavailable runtime shows a clear message on tap
      o.title = nativeMode
        ? (cliOk
            ? 'OpenCode CLI — Android Local is available; it runs on this device against your selected folder.'
            : 'OpenCode CLI is unavailable on this Android device: ' + ((lastOpenCodeStatus && lastOpenCodeStatus.message) || 'runtime not ready') + '. Tap to see setup steps. No automatic switch to OpenCode Zen.')
        : (!ready ? 'Needs a connected bridge and an open workspace folder.' : 'OpenCode CLI on the remote server.');
      // Small inline availability hint without changing the layout.
      const small = o.querySelector('.perm-option-copy small');
      if (small) small.textContent = nativeMode
        ? (cliOk ? 'Android Termux · ready' : 'Android Termux · unavailable')
        : 'Uses OpenCode’s own login';
    }
  });
  $('modeSel').disabled = on; $('saverBtn').disabled = on;
  // Keep the model and thinking-level selectors enabled in OpenCode CLI mode so the user can
  // choose the model (`opencode run --model`) and reasoning effort passed on every run.
  const ts = $('thinkSel'); if (ts) ts.disabled = false;
  $('provQuick').disabled = false;
  if (ts) ts.title = on ? 'Thinking effort passed to OpenCode CLI for this run.' : 'Requests a thinking effort from the model (depends on provider/model support).';
  $('modeSel').title = on ? 'OpenCode CLI uses its own agent; the CodeSpace mode selector is paused.' : 'Ask chats only; Agent uses tools; Multi-agent adds separate planning and independent QA calls.';
  $('provQuick').title = on ? 'Choose the model passed to OpenCode CLI (opencode run --model).' : 'Choose a model. CodeSpace Copilot switches models automatically; Free models are IDs ending in :free and Chat Z.ai models; Paid models are everything else.';
  // In OpenCode CLI mode show ONLY OpenCode models; otherwise restore the CodeSpace provider list.
  if (on) { if (typeof fillOpenCodeQuick === 'function') fillOpenCodeQuick(); }
  else if (openCodeModelsShown) {
    openCodeModelsShown = false; openCodeModelsCache = null;
    if (typeof globalThis !== 'undefined') globalThis.__opencodeModelIds = null;
    if (typeof fillQuick === 'function') fillQuick();
  }
  syncThinkVisibility();
  if (typeof syncModelBtn === 'function') syncModelBtn();
}
const syncMode = () => { $('modeSel').value = !S.agentOn ? 'ask' : (S.multiAgent ? 'multi' : 'agent'); const ts = $('thinkSel'); if (ts) ts.value = ['low', 'medium', 'high'].includes(S.thinkLevel) ? S.thinkLevel : 'off'; if (typeof syncPermissionUI === 'function') syncPermissionUI(); const on = S.tokenSaver !== false; $('saverBtn').classList.toggle('on', on); $('saverBtn').setAttribute('aria-checked', String(on)); syncOpenCodeUI(); };

/* ================= Chat Z.ai: local bridge + composer toggle ================= */
function ensureChatZaiProvider() {
  // Match only the built-in local bridge provider; do not overwrite a user's separately configured Chat Z.ai API endpoint.
  let p = S.providers.find(x => x && (x.providerKey === 'chat-zai' || x.id === 'chat-zai' || x.id === 'chat-zai-local'));
  if (!p) {
    p = { id: 'chat-zai-local', name: 'Chat Z.ai (local bridge)', format: 'openai', base: 'http://127.0.0.1:9876/v1', path: '/chat/completions', model: '', models: [], key: '', auth: 'none', ctx: 128000, vision: false, chatZai: true, extra: '', extraBody: '' };
    S.providers.push(p);
  }
  p.chatZai = true; p.providerKey = 'chat-zai'; p.format = 'openai';
  p.base = 'http://127.0.0.1:9876/v1'; p.path = '/chat/completions'; p.auth = 'none'; p.key = '';
  if (!Array.isArray(p.models)) p.models = [];
  return p;
}
function applyChatZaiModels(provider, models) {
  const list = [...new Set((Array.isArray(models) ? models : []).map(x => String(x || '').trim()).filter(Boolean))];
  if (!list.length) throw new Error('Chat Z.ai did not provide any model IDs.');
  provider.models = list;
  if (!list.includes(provider.model)) provider.model = list[0];
  provider.vision = false; // the current chat.z.ai guest adapter does not expose image input.
}
let chatZaiResumePromise = null;
async function resumeChatZaiMode() {
  if (chatZaiResumePromise) return chatZaiResumePromise;
  chatZaiResumePromise = (async () => {
    const p = ensureChatZaiProvider();
    try {
      const result = await bcall('/chat-zai/start');
      applyChatZaiModels(p, result.models);
      S.chatZaiCLI = true; S.openCodeCLI = false; S.activeId = p.id; S.copilotAuto = false; COPILOT_LAST_OK = '';
      S.updated = Date.now(); saveLocal(); fillQuick(); syncMode(); updateMeters();
      addNote('Chat Z.ai bridge restored. Select a Chat Z.ai model in the model selector and send your next message.');
      return true;
    } catch (e) {
      S.chatZaiCLI = false;
      const prev = S.providers.find(x => x.id === S.chatZaiPrevId && !isChatZaiProvider(x)) || S.providers.find(x => !isChatZaiProvider(x));
      if (prev) S.activeId = prev.id;
      S.chatZaiPrevId = ''; S.updated = Date.now(); saveLocal(); fillQuick(); syncMode();
      addErr('Could not restore Chat Z.ai mode: ' + e.message);
      throw e;
    }
  })().finally(() => { chatZaiResumePromise = null; });
  return chatZaiResumePromise;
}
async function toggleChatZai() {
  const btn = $('routeBtn');
  if (S.chatZaiCLI) {
    S.chatZaiCLI = false;
    const prev = S.providers.find(x => x.id === S.chatZaiPrevId && !isChatZaiProvider(x)) || S.providers.find(x => !isChatZaiProvider(x));
    if (prev) S.activeId = prev.id;
    S.chatZaiPrevId = ''; S.updated = Date.now(); saveLocal(); if (B.ok) pushConfig(); fillQuick(); syncMode(); updateMeters();
    if (B.ok) bcall('/chat-zai/stop').catch(e => console.warn('Chat Z.ai stop failed:', e));
    addNote('Chat Z.ai mode disabled. New messages will use your selected CodeSpace provider.');
    return;
  }
  if (!B.ok) { addErr('Chat Z.ai cannot start: the Agent Bridge is not connected. Open Settings > Bridge, connect the bridge URL and token, then click Chat Z.ai again.'); return; }
  if (S.openCodeCLI) { S.openCodeCLI = false; }
  const previous = S.providers.find(x => x.id === S.activeId && !isChatZaiProvider(x)) || S.providers.find(x => !isChatZaiProvider(x));
  const p = ensureChatZaiProvider();
  if (previous) S.chatZaiPrevId = previous.id;
  btn.disabled = true; btn.title = 'Starting the local Chat Z.ai browser bridge…';
  try {
    const result = await bcall('/chat-zai/start');
    applyChatZaiModels(p, result.models);
    S.activeId = p.id; S.chatZaiCLI = true; S.openCodeCLI = false; S.copilotAuto = false; COPILOT_LAST_OK = '';
    S.updated = Date.now(); saveLocal(); if (B.ok) pushConfig(); fillQuick(); syncMode(); updateMeters();
    addNote('Chat Z.ai mode enabled. The next message will use the selected Chat Z.ai model directly in this chat. Click Chat Z.ai again to switch back.');
  } catch (e) {
    S.chatZaiCLI = false;
    const prev = S.providers.find(x => x.id === S.chatZaiPrevId && !isChatZaiProvider(x)) || S.providers.find(x => !isChatZaiProvider(x));
    if (prev) S.activeId = prev.id;
    S.chatZaiPrevId = ''; S.updated = Date.now(); saveLocal(); if (B.ok) pushConfig(); fillQuick(); syncMode();
    addErr('Could not start Chat Z.ai: ' + e.message);
    /* 3.13.19: in the desktop app the sign-in now happens inside CodeSpace — open chat.z.ai in
       the Integrated Browser panel; once signed in, the session is captured automatically and
       the next click on Chat Z.ai succeeds without any external browser window. */
    if (DESKTOP_EMBED) {
      addNote('Opening chat.z.ai in the CodeSpace Browser panel. Sign in there if needed — CodeSpace captures the session automatically — then click Chat Z.ai again.');
      openChatZaiInBrowser();
    } else {
      addErr('Check that Chrome or Edge is installed and that the CodeSpace folder has been installed with npm install.');
    }
  } finally { btn.disabled = false; syncOpenCodeUI(); }
}

/* ================= OpenCode: install + saved API key ================= */
const ocMsg = (t, bad) => { const e = $('ocMsg'); if (!e) return; e.textContent = t || ''; e.style.color = bad ? 'var(--err)' : ''; };
async function ocRefresh() {
  const st = $('ocStatus'); if (!st) return;
  try {
    const s = await bcall('/opencode/status');
    lastOpenCodeStatus = s;
    const android = !!(s.platform === 'android' || s.runtimeKind || s.termuxInstalled !== undefined || L.bridgeUrl === 'codespace-native://local');
    let detail = '';
    if (android && s.termuxInstalled !== undefined) {
      const perm = s.termuxPermissionGranted ? 'permission granted' : 'permission NOT granted';
      const inst = s.termuxInstalled ? 'Termux installed' : 'Termux NOT installed';
      detail = ' [Termux: ' + inst + ', ' + perm + ', state: ' + (s.termuxState || '?') + ']';
      // Auto-request the RUN_COMMAND permission once when Termux is installed but not granted.
      window.__ocPermTried = window.__ocPermTried || {};
      if (s.termuxInstalled && !s.termuxPermissionGranted && !window.__ocPermTried.termux) {
        window.__ocPermTried.termux = true;
        bcall('/opencode/termux/permission', {}).then(() => setTimeout(() => ocRefresh(), 800)).catch(() => {});
      }
    }
    st.textContent = (s.installed
      ? 'OpenCode ' + (s.version || '') + ' is ready' + (android ? ' on this Android device (' + (s.runtimeKind || 'local') + ')' : ' on this computer') + '.'
      : (s.message || 'OpenCode is not installed on this computer.')) + detail;
    $('ocInstall').hidden = !!s.installed || !s.canInstall;
    const a = await bcall('/opencode/auth/get');
    $('ocProvList').innerHTML = ''; a.providers.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.label = p.label; $('ocProvList').appendChild(o); });
    const saved = a.providers.filter(p => p.saved).map(p => p.label + ' (' + p.hint + ')');
    $('ocSaved').textContent = saved.length ? 'Saved keys: ' + saved.join(', ') : 'No OpenCode API key saved yet.';
    if (document.activeElement !== $('ocModel')) $('ocModel').value = a.model || '';
    if (typeof ocRenderKeys === 'function') ocRenderKeys();
    // Keep the chat route menu's OpenCode ready-state in sync with the real probe result.
    if (typeof syncOpenCodeUI === 'function') syncOpenCodeUI();
  } catch (e) { st.textContent = 'Could not check OpenCode: ' + e.message; }
}
async function ocInstallRun() {
  const btn = $('ocInstall'); btn.disabled = true; ocMsg('Starting the install…');
  let good = false;
  try {
    if (L.bridgeUrl === 'codespace-native://local' || isAndroidFolderWorkspace()) {
      // Native: setup guidance is returned as JSON, not SSE. Installation of a real CLI on
      // Android requires Termux or a bundled binary; this never fakes success.
      const res = await bcall('/opencode/install', {});
      ocMsg(res.message || 'OpenCode CLI setup requires Termux or a bundled Android-compatible binary.');
      good = false; // a fresh --version probe decides availability; never assume installed
      return false;
    }
    const r = await fetch(L.bridgeUrl.replace(/\/+$/, '') + '/opencode/install', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + L.bridgeToken }, body: '{}' });
    if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'The install request failed (' + r.status + ').'); }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read(); if (end) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
        try { const ev = JSON.parse(line); if (ev.type === 'progress') ocMsg(ev.message); else if (ev.type === 'done') done = ev; } catch {}
      }
    }
    if (!done) throw new Error('The install ended without a result.');
    if (!done.ok) throw new Error(done.error || 'The install failed.');
    ocMsg('OpenCode ' + ((done.status && done.status.version) || '') + ' is installed.'); good = true;
  } catch (e) { ocMsg('Install failed: ' + e.message + ' You can also install OpenCode yourself (npm i -g opencode-ai) or set OPENCODE_BIN, then restart the bridge.', true); }
  finally { btn.disabled = false; ocRefresh(); }
  return good;
}
$('ocInstall').onclick = () => { if (!B.ok) { ocMsg('Connect the terminal bridge first.', true); return; } ocInstallRun(); };
$('ocRecheck').onclick = () => { ocMsg(''); ocRefresh(); };
// Native reports the RUN_COMMAND permission result; refresh settings so the state is current.
try {
  window.addEventListener('codespace-termux-permission', () => {
    if (typeof ocRefresh === 'function') setTimeout(() => ocRefresh(), 300);
  });
} catch {}
/* Render saved OpenCode API keys as clickable chips. Clicking a key makes it active (so when one
   key hits its quota you switch to the next). A ✕ removes a key. */
async function ocRenderKeys() {
  const box = $('ocKeyList'); if (!box) return;
  try {
    const data = await bcall('/opencode/keys/list', {});
    const keys = (data && data.keys) || [];
    box.textContent = '';
    if (!keys.length) { box.textContent = 'No API keys saved yet.'; return; }
    keys.forEach(k => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:6px;padding:2px 6px;margin:2px;cursor:pointer;' + (k.active ? 'border-color:var(--accent);' : '');
      const label = document.createElement('span');
      label.textContent = (k.active ? '● ' : '') + (k.label || k.provider) + ' ' + (k.hint || '');
      label.title = k.active ? 'Active — click to keep' : 'Click to use this key';
      label.onclick = async () => {
        if (k.active) return;
        try { await bcall('/opencode/keys/select', { id: k.id }); ocMsg('Switched to ' + (k.label || k.provider) + '.'); ocRenderKeys(); }
        catch (e) { ocMsg(e.message, true); }
      };
      const x = document.createElement('span'); x.textContent = '✕'; x.title = 'Remove this key';
      x.onclick = async e => { e.stopPropagation(); try { await bcall('/opencode/keys/remove', { id: k.id }); ocMsg('Key removed.'); ocRenderKeys(); } catch (er) { ocMsg(er.message, true); } };
      chip.appendChild(label); chip.appendChild(x); box.appendChild(chip);
    });
  } catch (e) { box.textContent = 'Could not load keys: ' + e.message; }
}

$('ocSaveKey').onclick = async () => {
  if (!B.ok) { ocMsg('Connect the terminal bridge first.', true); return; }
  const key = $('ocKey').value.trim(), model = $('ocModel').value.trim();
  if (model) { try { await bcall('/opencode/auth/set', { model }); } catch (e) { ocMsg(e.message, true); return; } }
  if (key) {
    const provider = $('ocProv').value.trim().toLowerCase() || 'opencode';
    try { await bcall('/opencode/keys/add', { provider, key }); $('ocKey').value = ''; ocMsg('API key saved. Click it below to switch to it when a key hits its limit.'); }
    catch (e) { ocMsg(e.message, true); return; }
  } else if (model) ocMsg('Default model saved.');
  ocRefresh();
};
$('ocClearKey').onclick = async () => {
  if (!B.ok) { ocMsg('Connect the terminal bridge first.', true); return; }
  const id = $('ocProv').value.trim().toLowerCase() || 'opencode';
  if (!confirm('Remove the saved OpenCode API key for \"' + id + '\"?')) return;
  try { await bcall('/opencode/auth/set', { provider: id, clear: true }); ocMsg('Removed the saved key for ' + id + '.'); ocRefresh(); }
  catch (e) { ocMsg(e.message, true); }
};

/* True when the active workspace is a folder on the Android device (SAF tree or built-in
   device-storage browser). Such folders exist only behind the native bridge — no native CLI
   (OpenCode included) running on the remote sandbox can access them.
   Prefer the authoritative native answer (hasLocalWorkspace) so detection survives stale
   B.info after a folder pick, server switch, reconnect or app restart; fall back to the
   cached /info indicators for builds/hosts where the native method is unavailable. */
/* Canonical workspace state from the native bridge — the single source of truth shared by chat,
   file tools and OpenCode CLI. Set by refreshWorkspaceInfo(); null until first successful read. */
let activeWorkspaceState = null;

function isAndroidFolderWorkspace() {
  // v43: canonical native state is definitive when it carries the workspace kind. A non-app-private
  // kind means the user HAS selected a folder on the device, even if it is currently unavailable
  // (revoked permission) — that must never be mistaken for "no Android workspace" and fall through
  // to the remote server.
  if (activeWorkspaceState && activeWorkspaceState.platform === 'android' && activeWorkspaceState.kind) {
    return activeWorkspaceState.kind !== 'app-private';
  }
  try {
    if (window.CodeSpaceNative && typeof window.CodeSpaceNative.hasLocalWorkspace === 'function' &&
        window.CodeSpaceNative.hasLocalWorkspace()) return true;
  } catch {}
  if (activeWorkspaceState && activeWorkspaceState.available && activeWorkspaceState.platform === 'android') return true;
  const i = B.info || {};
  return i.platform === 'android' || i.fileProvider === 'android-native-bridge' ||
    i.safWorkspace === true || /^saf:\/\//.test(String(i.root || ''));
}

/* Re-fetch the canonical native workspace state + /info so all consumers see one consistent,
   validated workspace (survives folder pick, server switch, reconnect, restart, permission loss).
   v43: query the native adapter DIRECTLY — /workspace/state and /info are pure device endpoints,
   so a stale hasLocalWorkspace()/remote /info can no longer hide a selected Android folder (the
   old bcall() gate did exactly that and sent OpenCode to the remote server, which has no Android
   folder and replied "Open a workspace folder in My Chat Agent first."). */
async function refreshWorkspaceInfo() {
  const log = (typeof ocWsLog === 'function') ? ocWsLog : function () {};
  const nativeAdapter = !!(typeof csNativeCall === 'function' && window.CodeSpaceNative &&
    typeof window.CodeSpaceNative.localApiCall === 'function');
  if (nativeAdapter) {
    try {
      const st = await csNativeCall('/workspace/state', {}, undefined);
      if (st && typeof st === 'object' && st.ok) activeWorkspaceState = st;
    } catch (e) { log('workspace/state error', String((e && e.message) || e)); }
    const androidSelected = !!(activeWorkspaceState && activeWorkspaceState.platform === 'android' &&
      activeWorkspaceState.kind && activeWorkspaceState.kind !== 'app-private');
    if (androidSelected) {
      // The device is authoritative: never overwrite a valid Android workspace with stale remote /info.
      try {
        const info = await csNativeCall('/info', {}, undefined);
        if (info && typeof info === 'object') { B.info = info; B.ok = true; }
      } catch (e) { log('/info (native) error', String((e && e.message) || e)); }
    } else {
      // No Android folder selected: the selected remote/Local bridge owns /info.
      try {
        const info = await bcall('/info', {}, undefined);
        if (info && typeof info === 'object') { B.info = info; B.ok = true; }
      } catch (e) { log('/info error', String((e && e.message) || e)); }
    }
    const i = B.info || {};
    log('refreshWorkspaceInfo', {
      bridgeUrl: L.bridgeUrl,
      hasLocalWorkspace: (() => { try { return !!(window.CodeSpaceNative && typeof window.CodeSpaceNative.hasLocalWorkspace === 'function' && window.CodeSpaceNative.hasLocalWorkspace()); } catch (e) { return 'error'; } })(),
      workspaceState: activeWorkspaceState,
      info: { platform: i.platform || null, root: i.root || null, fileProvider: i.fileProvider || null, safWorkspace: !!i.safWorkspace, workspaceKind: i.workspaceKind || null },
      isAndroidFolderWorkspace: isAndroidFolderWorkspace()
    });
    return;
  }
  // No native adapter (desktop/browser): the remote bridge is authoritative.
  try {
    if (typeof bcall === 'function') {
      try {
        const st = await bcall('/workspace/state', {}, undefined);
        if (st && typeof st === 'object' && st.ok) activeWorkspaceState = st;
      } catch {}
      const info = await bcall('/info', {}, undefined);
      if (info && typeof info === 'object') { B.info = info; B.ok = true; }
    }
  } catch {}
}

/* Permanently decline OpenCode CLI against an Android folder: clear any stale mode state and
   route the user to OpenCode Zen. Returns true when it handled the request. */
function declineOpenCodeForAndroidFolder(why) {
  if (S.openCodeCLI) {
    S.openCodeCLI = false; S.updated = Date.now(); saveLocal();
    if (typeof syncMode === 'function') syncMode();
    if (typeof updateMeters === 'function') updateMeters();
    if (B.ok && typeof pushConfig === 'function') pushConfig();
  }
  redirectToOpenCodeZen(why || 'OpenCode CLI cannot read files from a folder on your Android device.');
  return true;
}

/* Send the user to Providers → OpenCode Zen with an explanation. OpenCode Zen runs through
   the normal CodeSpace engine, whose file tools are routed to the Android folder by the native
   bridge, so it works with phone folders (some Zen models are free). */
function redirectToOpenCodeZen(reason) {
  addNote((reason || 'OpenCode CLI is not available for Android folders.') + ' Opening Providers — choose “OpenCode Zen” (key from https://opencode.ai/zen; some models are free).');
  try { if (typeof openView === 'function') openView('models'); else showView('models'); } catch {}
  try { if (typeof pickCard === 'function') pickCard('opencodezen'); } catch {}
}

async function toggleOpenCode() {
  if (S.openCodeCLI) {
    S.openCodeCLI = false; S.updated = Date.now(); saveLocal(); syncMode(); updateMeters();
    addNote('OpenCode CLI mode disabled. New messages will use the selected CodeSpace provider again.'); return;
  }
  if (S.chatZaiCLI) {
    const prev = S.providers.find(x => x.id === S.chatZaiPrevId && !isChatZaiProvider(x)) || S.providers.find(x => !isChatZaiProvider(x));
    if (prev) S.activeId = prev.id;
    S.chatZaiCLI = false; S.chatZaiPrevId = ''; S.updated = Date.now(); saveLocal(); fillQuick(); syncMode(); updateMeters();
    if (B.ok) { pushConfig(); bcall('/chat-zai/stop').catch(() => {}); }
  }
  // Refresh/validate workspace first (survives folder pick, server switch, reconnect, restart).
  await refreshWorkspaceInfo();
  const nativeMode = (L.bridgeUrl === 'codespace-native://local' || isAndroidFolderWorkspace());
  if (!B.ok && !nativeMode) { addErr('OpenCode cannot start: the terminal bridge is not connected. Open Settings > Bridge, paste the URL and token from the agent-server window, and press Connect. Then click OpenCode again.'); return; }
  if ((!B.info || !B.info.root) && !nativeMode) { addErr('OpenCode cannot start: no workspace folder is open. Use File > Open Folder (or the Open folder button in the empty Explorer), choose your project folder, then click OpenCode again.'); return; }
  const btn = $('routeBtn'); btn.disabled = true; btn.title = 'Checking OpenCode CLI…';
  try {
    ocLog('toggleOpenCode:enter', JSON.stringify({ nativeMode, openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI }));
    if (nativeMode) {
      // v42 root-cause fix: the tap must NOT launch a *fresh* Termux probe. The menu-open probe
      // (and the boot probe) already populate lastOpenCodeStatus; opencodeRuntimeAvailable() reads
      // that authoritative cached status. A redundant tap-time probe could transiently fail and
      // overwrite the valid OK status, which vetoed selection (the reported bug). If a valid status
      // is already cached we commit immediately; otherwise we await an in-flight probe, and only
      // start a real probe when we still have no valid status.
      if (!opencodeRuntimeAvailable()) {
        await awaitOpenCodeStatusIfInFlight();
      }
      let status = lastOpenCodeStatus || {};
      ocLog('availability:cached', JSON.stringify({ available: opencodeRuntimeAvailable(), termuxState: status.termuxState, installed: status.installed, runtimeKind: status.runtimeKind }));
      if (!opencodeRuntimeAvailable()) {
        ocLog('availability:cached-miss -> one real probe');
        await refreshOpenCodeStatus();
        status = lastOpenCodeStatus || {};
        ocLog('availability:after-probe', JSON.stringify({ available: opencodeRuntimeAvailable(), termuxState: status.termuxState, installed: status.installed, runtimeKind: status.runtimeKind }));
      }
      if (!opencodeRuntimeAvailable()) {
        const why = status && status.message ? status.message : '';
        const st = status && status.termuxState ? ' [' + status.termuxState + ']' : '';
        ocLog('toggleOpenCode:BLOCKED runtime unavailable', JSON.stringify({ termuxState: status.termuxState, message: why }));
        addErr('OpenCode CLI is unavailable on this device' + st + '. ' + why + ' Open Settings → OpenCode CLI → Check again to retry. OpenCode CLI is NOT silently switched to OpenCode Zen or a remote provider.');
        return;
      }
      if (S.openCodeAutoApprove && !confirm('OpenCode CLI auto-approval is enabled. It may edit files and run commands without normal permission prompts. Enable OpenCode mode?')) { addNote('OpenCode mode was not enabled (you cancelled).'); return; }
      // Commit the canonical selection IMMEDIATELY. currentRoute()/send() both read S.openCodeCLI,
      // so this single write is the authoritative state — no separate selector variable. Persist it.
      selectOpenCodeLocal(status);
      return;
    }
    // Remote server workspace -> OpenCode CLI Remote. (Needs a fresh probe of the remote server.)
    await refreshOpenCodeStatus();
    let status = lastOpenCodeStatus || {};
    if (!status.installed && status.canInstall) {
      if (!confirm('OpenCode is not installed on the remote server.\n\nInstall it for CodeSpace now? It is downloaded from the npm registry and checked, goes into CodeSpace\u2019s own data folder, and needs no administrator rights.')) { addNote('OpenCode install cancelled.'); return; }
      addNote('Installing OpenCode for CodeSpace…'); btn.title = 'Installing OpenCode…';
      if (!await ocInstallRun()) throw new Error('The install did not finish. See Settings > OpenCode CLI for details.');
      status = await bcall('/opencode/status'); lastOpenCodeStatus = status;
    }
    if (!status.installed) throw new Error(status.message || 'OpenCode CLI was not found.');
    if (!status.workspace) throw new Error('Open a workspace folder first.');
    if (S.openCodeAutoApprove && !confirm('OpenCode CLI auto-approval is enabled. It may edit files and run commands without normal permission prompts. Enable OpenCode mode?')) { addNote('OpenCode mode was not enabled (you cancelled). Click the OpenCode toggle again if you change your mind.'); return; }
    S.openCodeCLI = true; S.updated = Date.now(); saveLocal(); syncMode(); updateMeters();
    addNote('OpenCode CLI — Remote enabled (' + (status.version || 'version unknown') + '). Chat messages now use the provider/model configured inside OpenCode on the remote server. Click the toggle again to go back.');
  } catch (e) { addErr('Could not enable OpenCode CLI: ' + e.message + ' Add a key in Settings > OpenCode CLI or run `opencode auth login` as the OS user that runs agent-server.js.'); }
  finally { btn.disabled = false; syncOpenCodeUI(); }
}

/* 3.18.3: one "engine" dropdown replaces the separate OpenCode and Chat Z.ai switches. */
function closeRouteMenu() { const m = $('routeMenu'); if (m) m.hidden = true; $('routeBtn').setAttribute('aria-expanded', 'false'); }
async function setRoute(route) {
  ocLog('setRoute:enter', JSON.stringify({ route, before: { openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI } }));
  closeRouteMenu();
  if (route === 'opencode') { if (!S.openCodeCLI) await toggleOpenCode(); }
  else if (route === 'zai') { if (!S.chatZaiCLI) await toggleChatZai(); }
  else if (S.openCodeCLI) await toggleOpenCode();
  else if (S.chatZaiCLI) await toggleChatZai();
  ocLog('setRoute:done', JSON.stringify({ route, after: { openCodeCLI: S.openCodeCLI, chatZaiCLI: S.chatZaiCLI }, currentRoute: currentRoute() }));
}
$('routeBtn').onclick = e => {
  e.stopPropagation(); const m = $('routeMenu');
  if (typeof closePermissionMenu === 'function') closePermissionMenu();
  m.hidden = !m.hidden; $('routeBtn').setAttribute('aria-expanded', String(!m.hidden));
  // Refresh the real runtime state each time the menu opens so the OpenCode option is never
  // shown as unavailable because of a stale/null status. Selection is never reset here.
  if (!m.hidden && typeof refreshOpenCodeStatus === 'function') refreshOpenCodeStatus().catch(() => {});
};
$('routeMenu').addEventListener('click', e => { const o = e.target.closest('[data-route]'); ocLog('menu:click', JSON.stringify({ target: e.target && e.target.tagName, route: o && o.dataset.route })); if (o) setRoute(o.dataset.route).catch(err => { ocLog('menu:click-error', err && err.message); addErr(err.message); }); });
document.addEventListener('pointerdown', e => { if (!$('routeWrap').contains(e.target)) closeRouteMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('routeMenu').hidden) { closeRouteMenu(); $('routeBtn').focus(); } });
/* busy / retry text no longer takes space in the composer; it stays available as the Stop button's tooltip */
try { new MutationObserver(() => { const t = $('ctxHint').textContent; $('stopBtn').title = t ? 'Stop — ' + t : 'Stop'; }).observe($('ctxHint'), { childList: true, characterData: true, subtree: true }); } catch {}

$('modeSel').onchange = e => { S.agentOn = e.target.value !== 'ask'; S.multiAgent = e.target.value === 'multi'; S.updated = Date.now(); saveLocal(); updateMeters(); if (B.ok) pushConfig(); };

/* Android sandbox selector: Local (on this device), the free Render server, or a
   GitHub Codespace agent server. The native side reloads the WebView after
   switching, so this control only reflects the saved mode and asks the native
   layer to change it. */
(() => {
  const sel = $('sandboxSel'); if (!sel) return;
  const api = window.CodeSpaceNative;
  if (!api || typeof api.setSandboxMode !== 'function') { sel.hidden = true; return; }
  const names = ['Local', 'Render', 'GitHub'];
  const paint = mode => { sel.dataset.mode = String(mode || 'Local').toLowerCase(); };
  try {
    const current = typeof api.sandboxMode === 'function' ? String(api.sandboxMode() || 'Local') : 'Local';
    sel.value = names.includes(current) ? current : 'Local';
  } catch { sel.value = 'Local'; }
  sel.hidden = false;
  paint(sel.value);
  sel.onchange = () => {
    const mode = sel.value;
    if (mode === 'configure' || mode === 'configure-github') {
      const github = mode === 'configure-github';
      const current = sel.dataset.mode === 'render' ? 'Render' : sel.dataset.mode === 'github' ? 'GitHub' : 'Local';
      sel.value = current;
      let res = {};
      try { res = JSON.parse(api.setSandboxMode(github ? 'configure-github' : 'configure') || '{}'); }
      catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      if (res.error) addErr('Could not open ' + (github ? 'GitHub Codespace' : 'Render') + ' settings: ' + res.error);
      else addNote(github
        ? 'Opening GitHub Codespace settings. Run the agent server in a Codespace on port 8787, make the port public, then paste its URL and token.'
        : 'Opening Render settings. Add or replace the URL and token, then tap Save and test.');
      return;
    }
    if (mode === 'Render' && typeof api.renderEndpoint === 'function' && !String(api.renderEndpoint() || '').trim()) {
      addNote('Add your Render Agent Server URL and token in the dialog. The app switches to the free server after saving.');
    }
    if (mode === 'GitHub' && typeof api.githubEndpoint === 'function' && !String(api.githubEndpoint() || '').trim()) {
      addNote('Add your GitHub Codespace Agent Server URL and token in the dialog. The app switches to it after saving.');
    }
    let res = {};
    try { res = JSON.parse(api.setSandboxMode(mode) || '{}'); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) {
      if (res.reason === 'render-unconfigured') addNote('Render is not configured yet. Add its URL and token to use the free server.');
      else if (res.reason === 'render-configure') addNote('Opening Render settings.');
      else if (res.reason === 'github-unconfigured') addNote('GitHub Codespace is not configured yet. Add its public port URL and token to use it.');
      else if (res.reason === 'github-configure') addNote('Opening GitHub Codespace settings.');
      else if (res.error) addErr('Could not switch sandbox: ' + res.error);
      sel.value = names.includes(res.mode) ? res.mode : 'Local';
      paint(sel.value);
      return;
    }
    paint(mode);
    addNote(mode === 'Local' ? 'Switching to Local (on this device)…' : mode === 'GitHub' ? 'Connecting to your GitHub Codespace…' : 'Connecting to your free Render server…');
  };
})();
$('thinkSel').onchange = e => { S.thinkLevel = ['low', 'medium', 'high'].includes(e.target.value) ? e.target.value : 'off'; S.updated = Date.now(); saveLocal(); setThinkingStatus(S.thinkLevel === 'off' ? 'off' : 'warning', S.thinkLevel === 'off' ? '' : 'Think: ' + S.thinkLevel + ' · checking support', S.thinkLevel === 'off' ? 'Thinking is off.' : 'The selected effort is sent to the provider when selected. Support is model/provider-specific; rejected parameters show an error, and missing reasoning data is marked unverified.'); };
chat.addEventListener('click', e => { const b = e.target.closest('.sugg'); if (b) { $('input').value = b.dataset.p; autoSize(); $('input').focus(); } });
document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); } });
(() => {
  const app = $('app'), sp = $('split'); if (!sp) return; let drag = false;
  const savedW = Number(localStorage.getItem('agent3.chatw')); if (savedW) app.style.setProperty('--chatw', savedW + 'px');
  const savedH = Number(localStorage.getItem('agent3.chath')); if (savedH) app.style.setProperty('--chath', savedH + 'px');
  const stacked = () => window.matchMedia('(max-width:900px)').matches;
  const chatPane = $('chatPane');
  sp.addEventListener('pointerdown', e => { drag = true; document.body.classList.add('cs-dragging'); sp.classList.add('dragging'); sp.setPointerCapture(e.pointerId); e.preventDefault(); });
  sp.addEventListener('pointercancel', () => { drag = false; document.body.classList.remove('cs-dragging'); sp.classList.remove('dragging'); });
  sp.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = app.getBoundingClientRect();
    if (stacked()) {
      // Phones: the divider resizes the CHAT box. Its bottom/composer stays pinned: we derive
      // the height from the chat's real bottom edge (not a drifting cached rect), so the box
      // grows/shrinks from the top only and never shifts position.
      const bottom = (chatPane ? chatPane.getBoundingClientRect().bottom : r.bottom) || r.bottom;
      const h = Math.round(Math.min(Math.max(bottom - e.clientY, 140), r.height * 0.78));
      app.style.setProperty('--chath', h + 'px');
    } else {
      app.style.setProperty('--chatw', Math.round(Math.min(Math.max(r.right - e.clientX, 320), r.width * 0.7)) + 'px');
    }
  });
  sp.addEventListener('pointerup', () => {
    drag = false; document.body.classList.remove('cs-dragging'); sp.classList.remove('dragging');
    try {
      if (stacked()) {
        const ch = parseInt(app.style.getPropertyValue('--chath')) || '';
        if (ch) localStorage.setItem('agent3.chath', String(ch));
      } else localStorage.setItem('agent3.chatw', String(parseInt(app.style.getPropertyValue('--chatw')) || ''));
    } catch {}
  });
})();

/* 3.13.2: resizable side panel — drag the strip between the sidebar and the editor.
   The width is persisted in localStorage and survives restarts. */
(() => {
  const app = $('app'), sp = $('sideSplit'); if (!sp) return; let drag = false;
  const saved = Number(localStorage.getItem('agent3.sidew')); if (saved) app.style.setProperty('--sidew', saved + 'px');
  sp.addEventListener('pointerdown', e => { drag = true; sp.classList.add('dragging'); sp.setPointerCapture(e.pointerId); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  sp.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = app.getBoundingClientRect();
    const w = Math.round(Math.min(Math.max(e.clientX - r.left - 48, 170), Math.max(300, r.width * 0.55)));
    app.style.setProperty('--sidew', w + 'px');
  });
  const end = () => { if (!drag) return; drag = false; sp.classList.remove('dragging'); document.body.style.cursor = ''; document.body.style.userSelect = ''; try { localStorage.setItem('agent3.sidew', String(parseInt(app.style.getPropertyValue('--sidew')) || '')); } catch {} };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('dblclick', () => { app.style.removeProperty('--sidew'); try { localStorage.removeItem('agent3.sidew'); } catch {} });
})();

/* ================= undo for the agent's changes ================= */
