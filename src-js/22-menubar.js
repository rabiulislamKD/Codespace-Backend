
/* ================= application menu bar =================
   File / Edit / Selection / View / Go / Run / Terminal / Debug / Help.
   Every entry calls an action that already exists in CodeSpace; nothing here is a placeholder. */
(() => {
  const bar = $('menubar'); if (!bar) return;
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
  const kb = s => !s ? '' : mac ? s.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : s;
  const TEXT_INPUT = /^(text|search|password|number|url|email)?$/i;
  let lastField = null;
  document.addEventListener('focusin', e => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && TEXT_INPUT.test(t.type || '')))) lastField = t;
  });
  const field = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && TEXT_INPUT.test(a.type || '')))) return a;
    return lastField && document.contains(lastField) ? lastField : $('edTa');
  };
  const exec = c => { const f = field(); if (f) f.focus(); document.execCommand(c); };
  const selectAll = () => { const f = field(); if (f) { f.focus(); f.select(); } };
  const paste = async () => {
    const f = field();
    try {
      const t = await navigator.clipboard.readText();
      if (!f) return; f.focus();
      if (!document.execCommand('insertText', false, t)) f.setRangeText(t, f.selectionStart, f.selectionEnd, 'end');
      f.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { addErr('Paste was blocked by the browser. Press Ctrl+V instead.'); }
  };
  const hasFile = () => !!activeFileTab();
  const hasDirty = () => tabs.some(t => t.type === 'file' && t.dirty);
  const bridge = () => !!(typeof B !== 'undefined' && B.ok);
  const sidebarToggle = () => showView(typeof curView === 'string' && curView ? curView : 'explorer');

  const RUNNERS = { js: 'node', mjs: 'node', cjs: 'node', py: 'python', rb: 'ruby', php: 'php', pl: 'perl', sh: 'bash', ps1: 'powershell -ExecutionPolicy Bypass -File', bat: 'cmd /c', cmd: 'cmd /c', go: 'go run', lua: 'lua' };
  // Quote a file path for the terminal's shell so file names can never be interpreted as commands.
  function shellQuote(path, shellId) {
    const sid = String(shellId || '');
    if (/^cmd$/i.test(sid)) { if (/["%^&|<>]/.test(path)) return null; return '"' + path + '"'; }
    if (/pwsh|powershell/i.test(sid)) return "'" + path.replace(/'/g, "''") + "'";
    return "'" + path.replace(/'/g, "'\\''") + "'";
  }
  async function runActiveFile() {
    const t = activeFileTab(); if (!t) { addErr('Open a file in the editor first.'); return; }
    const ext = (String(t.path).split('.').pop() || '').toLowerCase();
    if (ext === 'html' || ext === 'htm') { showPanel(); reloadPreview(); return; }
    let runner = RUNNERS[ext];
    if (!runner) { addErr('No run command is known for .' + ext + ' files. Use the terminal instead.'); return; }
    if (!bridge()) { addErr('Running a file needs the terminal bridge. Connect it in Settings.'); return; }
    if (t.dirty) await saveTab(t);
    showTerminal();
    for (let i = 0; i < 40 && !T.active; i++) await new Promise(r => setTimeout(r, 100));
    const cmd = $('termCmd'); if (!cmd || !T.active) return;
    const term = T.list.find(x => x.id === T.active), sid = term && term.shell;
    const posix = !/^(cmd|powershell|pwsh)$/i.test(String(sid || ''));
    if (ext === 'py' && posix) runner = '"$(command -v python3 || command -v python)"';
    const p = /^cmd$/i.test(String(sid || '')) ? String(t.path).replace(/\//g, '\\') : String(t.path);
    const q = shellQuote(p, sid);
    if (q === null) { addErr('This file name contains characters that are unsafe to run from cmd.exe. Rename the file or run it in the terminal yourself.'); return; }
    cmd.value = runner + ' ' + q;
    cmd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  const stopRun = () => { if (csUiBusy) csStopActiveRun(); else addNote('Nothing is running.'); };
  async function oneClickRepair() {
    if (typeof ctrl !== 'undefined' && ctrl) { addNote('An agent task is already running.'); return; }
    const prompt = `ONE-CLICK CODESPACE REPAIR. The user deliberately started this workflow from Run > Repair CodeSpace. Begin immediately; do not ask the user to describe the problem first.

1. Inspect the active environment using codespace_runtime_check. Also call codespace_locate_installation and use only its exact reported paths; never guess paths or scan unrelated drives.
2. Inspect the opened workspace and its health. Use workflow_diagnostics, project_health_check, relevant logs, Installed Tools records, provider/model diagnostics, and focused tests where applicable. Treat CodeSpace itself and the opened project as separate repair targets.
3. Identify root causes and prepare a concise plan. Inspect Git status/diff before editing and preserve all pre-existing user changes.
4. Repair the smallest safe set of files/configurations. Use a checkpoint where supported. Follow every existing permission gate: never bypass approvals, overwrite unrelated work, alter secrets, weaken security, run destructive commands, request administrator privileges, or execute unreviewed remote install scripts. If a tool must be installed, use the official-source install_tool approval flow.
5. If CodeSpace source files are outside the opened workspace, report the exact discovered source path and ask the user to open that folder; do not bypass the workspace boundary or edit packaged binaries blindly. Continue with repairs that are safely available in the current workspace.
6. Run focused verification after each repair. Report exact changed paths, actual commands and observed results. If verification fails, diagnose and safely retry where practical; do not claim success without evidence.

Prioritize issues that prevent CodeSpace from starting, connecting to providers, using tools, opening the browser, running terminals, or completing agent tasks. If no fault is found, report a healthy result and the checks actually completed.`;
    await runAgent(prompt, []);
  }

  const MENUS = [
    ['File', [
      { l: 'New Chat', run: () => csNewChat() },
      { l: 'Chat History', run: () => csOpenHistory() },
      { l: 'Compress Conversation', run: () => csCompress(), tip: 'Summarizes older chat messages to free context space.' },
      '-',
      { l: 'New File…', run: () => ctxNewFile(''), on: bridge },
      { l: 'New Folder…', run: () => ctxNewFolder(''), on: bridge },
      '-',
      { l: 'Open File…', k: 'Ctrl+P', run: () => openQuickOpen('open') },
      { l: 'Open Folder…', run: () => openFolder() },
      '-',
      { l: 'Save', k: 'Ctrl+S', run: () => saveTab(activeFileTab()), on: () => hasFile() && !!activeFileTab().dirty },
      { l: 'Save All', run: () => Promise.all(tabs.filter(t => t.type === 'file' && t.dirty).map(saveTab)), on: hasDirty },
      '-',
      { l: 'Close Editor', run: () => closeTab(activeTab), on: () => !!activeTab },
      '-',
      { l: 'Settings', run: () => openSettings() }
    ]],
    ['Edit', [
      { l: 'Undo', k: 'Ctrl+Z', run: () => exec('undo') },
      { l: 'Redo', k: 'Ctrl+Y', run: () => exec('redo') },
      '-',
      { l: 'Cut', k: 'Ctrl+X', run: () => exec('cut') },
      { l: 'Copy', k: 'Ctrl+C', run: () => exec('copy') },
      { l: 'Paste', k: 'Ctrl+V', run: paste },
      '-',
      { l: 'Select All', k: 'Ctrl+A', run: selectAll },
      '-',
      { l: 'Find in Files', k: 'Ctrl+Shift+F', run: () => { openView('codebase'); $('codeQuery').focus(); } }
    ]],
    ['Selection', [
      { l: 'Select All', k: 'Ctrl+A', run: selectAll },
      { l: 'Attach Selection to Chat', k: 'Ctrl+Shift+A', run: () => attachEditorSelection(), on: hasFile },
      '-',
      { l: 'Compress Conversation', run: () => compressNow(true) }
    ]],
    ['View', [
      { l: 'Command Palette…', k: 'Ctrl+Shift+P', run: () => openQuickOpen('command') },
      '-',
      { l: 'Explorer', run: () => openView('explorer') },
      { l: 'Source Control', run: () => openView('git') },
      { l: 'Checkpoints', run: () => openView('checkpoints') },
      { l: 'Codebase Intelligence', run: () => openView('codebase') },
      { l: 'Chats', run: () => openView('sessions') },
      { l: 'Action History', run: () => openView('log') },
      '-',
      { l: 'Toggle Sidebar', run: sidebarToggle },
      { l: 'Toggle Terminal', k: 'Ctrl+`', run: () => toggleTerminal() },
      '-',
      { l: 'Theme: System', run: () => changeTheme('auto'), check: () => (S.theme || 'auto') === 'auto' },
      { l: 'Theme: Light', run: () => changeTheme('light'), check: () => S.theme === 'light' },
      { l: 'Theme: Dark', run: () => changeTheme('dark'), check: () => S.theme === 'dark' }
    ]],
    ['Go', [
      { l: 'Go to File…', k: 'Ctrl+P', run: () => openQuickOpen('open') },
      { l: 'Search Code', k: 'Ctrl+Shift+F', run: () => { openView('codebase'); $('codeQuery').focus(); } },
      '-',
      { l: 'Focus Chat', run: () => $('input').focus() },
      { l: 'Focus Editor', run: () => $('edTa').focus(), on: hasFile },
      { l: 'Focus Terminal', run: () => showTerminal(), on: bridge },
      { l: 'Browser', run: () => showPanel() }
    ]],
    ['Run', [
      { l: 'Run Active File', run: runActiveFile, on: hasFile },
      { l: 'Task Center', run: () => showTaskCenter(), tip: 'View queued, running, interrupted and completed engineering tasks.' },
      { l: 'Repair CodeSpace', run: oneClickRepair, tip: 'Run a full CodeSpace and workspace diagnosis, repair safe issues, then verify the result. Existing permission approvals still apply.' },
      { l: 'Stop Agent', run: stopRun },
      '-',
      { l: 'Open Browser', run: () => showPanel() },
      { l: 'Open chat.z.ai', run: () => openChatZaiInBrowser() },
      { l: 'Reload Browser Preview', run: () => { showPanel(); reloadPreview(); } }
    ]],
    ['Terminal', [
      { l: 'New Terminal', run: async () => { await newTerm(); showTerminal(); }, on: bridge },
      { l: 'Toggle Terminal', k: 'Ctrl+`', run: () => toggleTerminal() },
      '-',
      { l: 'Clear Terminal', run: () => $('termClear').click(), on: bridge },
      { l: 'Kill Terminal', run: () => $('termKill').click(), on: bridge }
    ]],
    ['Debug', [
      { l: 'Launch / Continue Node Debugger', k: 'F5', run: () => csDebug.attached ? csDebugControl('continue') : csDebugLaunch(), on: hasFile },
      { l: 'Pause', run: () => csDebugControl('pause'), on: () => csDebug.attached && !csDebug.stopped },
      { l: 'Step Over', k: 'F10', run: () => csDebugControl('next'), on: () => csDebug.attached && csDebug.stopped },
      { l: 'Step Into', k: 'F11', run: () => csDebugControl('stepIn'), on: () => csDebug.attached && csDebug.stopped },
      { l: 'Step Out', k: 'Shift+F11', run: () => csDebugControl('stepOut'), on: () => csDebug.attached && csDebug.stopped },
      { l: 'Stop Debugging', k: 'Shift+F5', run: () => csDebugFinish(true), on: () => csDebug.attached || !!csDebug.terminalId },
      { l: 'Open Debug Panel', run: () => csDebugShow(true), on: hasFile },
      '-',
      { l: 'Browser Console', run: () => { showPanel(); toggleDiag('console'); } },
      { l: 'Browser Network Requests', run: () => { showPanel(); toggleDiag('network'); } },
      '-',
      { l: 'Action History', run: () => openView('log') },
      '-',
      { l: 'Reload App', run: () => location.reload() }
    ]],
    ['Help', [
      { l: 'Command Palette…', k: 'Ctrl+Shift+P', run: () => openQuickOpen('command') },
      { l: 'Settings', run: () => openSettings() }
    ]]
  ];

  const drop = document.createElement('div');
  drop.id = 'menuDrop'; drop.className = 'mb-drop'; drop.hidden = true; drop.setAttribute('role', 'menu');
  document.body.appendChild(drop);
  let openIdx = -1;
  const titles = MENUS.map(([name], i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mb-title'; b.textContent = name; b.id = 'mbt' + i;
    b.setAttribute('role', 'menuitem'); b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false');
    bar.appendChild(b); return b;
  });

  function close(refocus) {
    if (openIdx >= 0) { titles[openIdx].classList.remove('open'); titles[openIdx].setAttribute('aria-expanded', 'false'); if (refocus) titles[openIdx].focus(); }
    openIdx = -1; drop.hidden = true; drop.innerHTML = '';
  }
  function render(i) {
    drop.innerHTML = '';
    MENUS[i][1].forEach(it => {
      if (it === '-') { const s = document.createElement('div'); s.className = 'mb-sep'; s.setAttribute('role', 'separator'); drop.appendChild(s); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'mb-item';
      b.setAttribute('role', it.check ? 'menuitemradio' : 'menuitem');
      b.disabled = !!(it.on && !it.on());
      const ck = it.check ? !!it.check() : false;
      if (it.check) b.setAttribute('aria-checked', String(ck));
      b.innerHTML = '<span class="mb-ck">' + (ck ? '✓' : '') + '</span><span class="mb-l">' + esc(it.l) + '' + '</span><span class="mb-k">' + esc(kb(it.k)) + '</span>';
      if (it.tip) b.title = it.tip;
      b.onclick = () => { close(); try { const r = it.run(); if (r && typeof r.catch === 'function') r.catch(e => addErr(e.message)); } catch (e) { addErr(e.message); } };
      drop.appendChild(b);
    });
  }
  function open(i, focusFirst) {
    // v47.3: on touch devices a focused text field raises the soft keyboard over the dropdown.
    // Blur it before showing the menu (desktop/mouse keeps focus for selection as before).
    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === 'function' && ae !== document.body) ae.blur();
      }
    } catch {}
    if (openIdx >= 0 && openIdx !== i) { titles[openIdx].classList.remove('open'); titles[openIdx].setAttribute('aria-expanded', 'false'); }
    openIdx = i; render(i); drop.hidden = false;
    const t = titles[i]; t.classList.add('open'); t.setAttribute('aria-expanded', 'true');
    const r = t.getBoundingClientRect(), w = drop.offsetWidth;
    drop.style.top = Math.round(r.bottom) + 'px';
    drop.style.left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - w - 6)) + 'px';
    if (focusFirst) { const f = drop.querySelector('.mb-item:not(:disabled)'); if (f) f.focus(); }
  }
  titles.forEach((t, i) => {
    t.addEventListener('click', () => { if (openIdx === i) close(); else open(i); });
    t.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== i) open(i); });
  });
  // keep focus (and the text selection) where it was while the menu is used with the mouse
  bar.addEventListener('mousedown', e => e.preventDefault());
  drop.addEventListener('mousedown', e => e.preventDefault());
  document.addEventListener('mousedown', e => { if (openIdx >= 0 && !e.target.closest('#menubar, #menuDrop')) close(); });
  window.addEventListener('blur', () => close());
  window.addEventListener('resize', () => close());

  const move = (list, cur, d) => { if (!list.length) return null; const i = list.indexOf(cur); return list[(i + d + list.length) % list.length]; };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openIdx >= 0) { e.preventDefault(); close(true); return; }
    const inBar = document.activeElement && document.activeElement.classList.contains('mb-title');
    const inDrop = document.activeElement && document.activeElement.classList.contains('mb-item');
    if (!inBar && !inDrop) return;
    const idx = inBar ? titles.indexOf(document.activeElement) : openIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault(); const n = (idx + (e.key === 'ArrowRight' ? 1 : -1) + titles.length) % titles.length;
      if (openIdx >= 0) { open(n, inDrop); if (!inDrop) titles[n].focus(); } else titles[n].focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (inBar) { open(idx, true); return; }
      const items = [...drop.querySelectorAll('.mb-item:not(:disabled)')];
      const nx = move(items, document.activeElement, e.key === 'ArrowDown' ? 1 : -1); if (nx) nx.focus();
    }
  });
})();

/* ---------- title bar: workspace / chat name, bridge dot, settings, toolbar highlight ---------- */
(() => {
  const ws = $('tbWorkspace'), chat = $('tbChat'), dot = $('tbBridge'), gear = $('tbSettings');
  if (!ws || !chat || !dot) return;
  const sync = () => {
    const folder = (($('expTitle') || {}).textContent || '').trim();
    ws.textContent = folder && folder.toLowerCase() !== 'explorer' ? folder : 'No folder open';
    chat.textContent = (($('chatTitle') || {}).textContent || '').trim() || 'New chat';
    const sb = $('sbBridge'), label = sb ? sb.textContent.trim() : '';
    dot.dataset.state = label && !/not connected/i.test(label) ? 'on' : 'off';
    dot.title = label;
    const open = document.querySelector('.abtn.on[data-view]');
    document.querySelectorAll('#chatToolDock [data-tool]').forEach(b => b.classList.toggle('on', !!open && b.dataset.tool === open.dataset.view));
  };
  const obs = new MutationObserver(sync);
  ['expTitle', 'chatTitle', 'sbBridge'].forEach(id => { const n = $(id); if (n) obs.observe(n, { childList: true, characterData: true, subtree: true }); });
  const act = $('activity'); if (act) obs.observe(act, { attributes: true, attributeFilter: ['class'], subtree: true });
  if (gear) gear.addEventListener('click', () => { const s = $('settingsBtn'); if (s) s.click(); });
  sync();
})();
