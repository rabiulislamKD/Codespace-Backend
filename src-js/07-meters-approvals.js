const msgChars = m => (m.content || '').length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
function ctxUsed(forceEst) {
  const s = cur(), h = s.messages, u = s.usage;
  if (!forceEst && u && u.n <= h.length) { let extra = 0; for (let i = u.n; i < h.length; i++) extra += msgChars(h[i]); return { used: u.input + Math.ceil(extra / 3.6), exact: true }; }
  let ch = buildSystem().length + JSON.stringify(toolDefs()).length; prepared(h).forEach(m => { ch += msgChars(m); });
  return { used: Math.ceil(ch / 3.6), exact: false };
}
function sessionCost(sess) {
  const entries = sess && Array.isArray(sess.costEntries) ? sess.costEntries : [];
  return entries.reduce((sum, e) => ({ usd: sum.usd + (Number(e.usd) || 0), input: sum.input + (Number(e.input) || 0), output: sum.output + (Number(e.output) || 0), calls: sum.calls + 1, unpriced: sum.unpriced + ((Number(e.inputRate) || 0) === 0 && (Number(e.outputRate) || 0) === 0 ? 1 : 0) }), { usd: 0, input: 0, output: 0, calls: 0, unpriced: 0 });
}
function recordUsageCost(sess, provider, usage) {
  if (!sess || !usage) return;
  const input = Math.max(0, Number(usage.input) || 0), output = Math.max(0, Number(usage.output) || 0);
  const inputRate = Math.max(0, Number(provider.inputRate) || 0), outputRate = Math.max(0, Number(provider.outputRate) || 0);
  const usd = (input * inputRate + output * outputRate) / 1000000;
  if (!Array.isArray(sess.costEntries)) sess.costEntries = [];
  sess.costEntries.push({ at: Date.now(), providerId: provider.id || '', provider: provider.name || '', model: provider.model || '', input, output, cachedInput: Math.max(0, Number(usage.cachedInput) || 0), inputRate, outputRate, usd });
  if (sess.costEntries.length > 20000) sess.costEntries.splice(0, sess.costEntries.length - 20000);
}
function updateMeters() {
  const p = P(), lim = p.ctx || DEFAULT_CTX, { used, exact } = ctxUsed(), frac = Math.min(1, used / lim), pct = Math.round(frac * 100);
  const cls = pct > 90 ? ' hot' : pct > 70 ? ' warn' : '';
  const arc = $('ctxArc'); arc.style.strokeDashoffset = String(56.55 * (1 - (used > 0 ? Math.max(0.04, frac) : 0))); arc.setAttribute('class', 'rf' + cls);
  const txt = (exact ? '' : '~') + fmtTok(used) + ' / ' + fmtTok(lim);
  const sysTok = Math.ceil((buildSystem().length + JSON.stringify(toolDefs()).length) / 3.6), msgTok = Math.max(0, used - sysTok);
  $('ctxPct').textContent = pct + '%'; $('ctxText').textContent = txt + ' tokens';
  const bar = $('ctxPopBar'); bar.style.width = pct + '%'; bar.className = cls.trim();
  $('ctxSaved').textContent = S.tokenSaver ? '~' + fmtTok(saverSaved) : 'off';
  $('ctxMsgs').textContent = '~' + fmtTok(msgTok); $('ctxSys').textContent = '~' + fmtTok(Math.min(sysTok, used)); $('ctxLim').textContent = fmtTok(lim);
  $('ctxNote').textContent = (exact ? 'Size reported by the model.' : 'Estimated from the text.') + (pct > 80 ? ' Nearly full: compress to free up room.' : '');
  $('ctxRing').title = 'Context: ' + txt + ' (' + pct + '%). Click for details.';
  $('sbCtx').textContent = 'Context: ' + txt + ' (' + pct + '%)';
  $('sbModel').textContent = S.copilotAuto ? 'Model: CodeSpace Copilot' + (COPILOT_LAST_OK ? ' · ' + COPILOT_LAST_OK.split('::').slice(1).join('::') : '') : 'Model: ' + p.name + (p.model ? ' · ' + p.model : '');
  const cost = sessionCost(cur()); $('sbCost').textContent = !cost.calls ? 'Cost: —' : (cost.unpriced === cost.calls ? 'Est. cost: set rates' : 'Est. cost: $' + cost.usd.toFixed(4) + (cost.unpriced ? ' + ' + cost.unpriced + ' unpriced' : '')); $('sbCost').title = cost.calls + ' model requests · ' + fmtTok(cost.input) + ' input tokens · ' + fmtTok(cost.output) + ' output tokens. Approximate: configure input/output USD per million tokens for each provider; provider-specific cache discounts are not included.';
}
/* Model selector. Two groups, decided by model ID / provider only (never by price fields, tags or
   local endpoints, as fixed in 3.12.9):
   - Free models: model IDs whose final suffix is exactly ":free", plus the built-in Chat Z.ai bridge
     (its guest web models cost nothing and are part of the Copilot free pool).
   - Paid models: everything else. This label is not a billing guarantee: local servers and
     provider free tiers without a ":free" ID also land here.
   "CodeSpace Copilot" is a single entry above both groups (automatic model switching).
   3.13.21: the native <select> stays in the DOM as the state holder (value / change event / disabled),
   but is hidden; a grouped, searchable popup menu is what the user sees. The old native popup was
   squeezed to the 96-150px composer slot, so group headers and long model names were cut off. */
const FREE_MODEL_ID = /:free$/i;
function isFreeModelId(id) { return typeof id === 'string' && FREE_MODEL_ID.test(id.trim()); }
/* 'free' | 'paid' for one provider/model pair. */
function modelTier(p, id) {
  if (p && (p.chatZai === true || p.providerKey === 'chat-zai' || p.id === 'chat-zai' || p.id === 'chat-zai-local')) return 'free';
  return isFreeModelId(String(id || '')) ? 'free' : 'paid';
}
function providerModelIds(p) {
  const ids = Array.isArray(p.models) ? p.models.filter(x => typeof x === 'string' && x.trim()) : [];
  if (p.model && !ids.includes(p.model)) ids.unshift(p.model);
  return ids;
}
/* Providers shown in the picker: the Chat Z.ai bridge only while it is switched ON (otherwise its
   models would point at a bridge that is not running). */
const quickProviders = () => (S.providers || []).filter(p => p && (!(p.chatZai === true || p.providerKey === 'chat-zai' || p.id === 'chat-zai' || p.id === 'chat-zai-local') || S.chatZaiCLI));
function modelPickerItems() {
  // When OpenCode CLI mode is active, the popup menu must show ONLY OpenCode models — not the
  // CodeSpace providers. globalThis.__opencodeModelIds is published by the composer from the
  // device-local /opencode/models endpoint; each entry is an OpenCode `provider/model` id.
  const ocIds = (typeof globalThis !== 'undefined' && globalThis.__opencodeModelIds) || null;
  if (Array.isArray(ocIds) && ocIds.length) {
    const items = { free: [], paid: [] };
    const pseudo = { id: 'opencode', name: 'OpenCode', model: '', models: ocIds, providerKey: 'opencode' };
    // v46: group by the model ID itself — Free when the id ends with "-free" (case-insensitive).
    ocIds.forEach(id => items[(typeof isFreeOpenCodeModel === 'function' ? isFreeOpenCodeModel(id) : /-free$/i.test(String(id))) ? 'free' : 'paid'].push({ p: pseudo, id }));
    return items;
  }
  const items = { free: [], paid: [] };
  quickProviders().forEach(p => {
    const ids = providerModelIds(p);
    (ids.length ? ids : ['']).forEach(id => items[modelTier(p, id)].push({ p, id }));
  });
  return items;
}
const COPILOT_LABEL = 'CodeSpace Copilot';
function fillQuick() {
  // v46: while OpenCode CLI mode owns the model selector, the CodeSpace provider list must never
  // clobber the discovered OpenCode model list / the user's selected OpenCode model.
  if (typeof S !== 'undefined' && S.openCodeCLI && typeof fillOpenCodeQuick === 'function') { fillOpenCodeQuick(); return; }
  const q = $('provQuick'); q.innerHTML = '';
  const items = modelPickerItems();
  if (items.free.length) { // Copilot needs at least one free model to switch to
    const ao = document.createElement('option'); ao.value = 'copilot::auto'; ao.textContent = COPILOT_LABEL;
    q.appendChild(ao);
  }
  [['free', 'Free models'], ['paid', 'Paid models']].forEach(([key, label]) => {
    const list = items[key];
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label + ' (' + list.length + ')';
    list.forEach(({ p, id }) => {
      const o = document.createElement('option');
      o.value = p.id + '::' + id;
      o.textContent = p.name + ' · ' + (id || '(no model set)');
      o.title = modelTier(p, id) === 'free'
        ? 'Free: model ID ends with :free, or a Chat Z.ai guest model. Provider limits still apply.'
        : 'Paid / other: the model ID does not end in :free. This does not prove the endpoint is paid (local and free-tier models may appear here).';
      g.appendChild(o);
    });
    q.appendChild(g);
  });
  const act = S.providers.find(p => p.id === S.activeId) || S.providers[0];
  if (S.copilotAuto && q.querySelector('option[value="copilot::auto"]')) q.value = 'copilot::auto';
  else if (act) q.value = act.id + '::' + (act.model || '');
  if (typeof syncModelBtn === 'function') syncModelBtn();
}

/* ---- grouped model menu (button + popup) ---- */
let modelBtn = null, modelMenu = null, modelOpenedAt = 0;
function ensureModelMenu() {
  if (modelMenu) return;
  const q = $('provQuick'); q.style.display = 'none';
  modelBtn = document.createElement('button'); modelBtn.type = 'button'; modelBtn.id = 'provQuickBtn'; modelBtn.className = 'modelbtn';
  modelBtn.setAttribute('aria-haspopup', 'listbox'); modelBtn.setAttribute('aria-expanded', 'false'); modelBtn.setAttribute('aria-label', 'Model');
  modelBtn.innerHTML = '<span class="mb-tier" aria-hidden="true"></span><span class="mb-txt"></span><span class="mb-chev" aria-hidden="true">▾</span>';
  q.insertAdjacentElement('afterend', modelBtn);
  modelMenu = document.createElement('div'); modelMenu.id = 'provMenu'; modelMenu.className = 'provmenu'; modelMenu.hidden = true;
  modelMenu.setAttribute('role', 'listbox'); modelMenu.setAttribute('aria-label', 'Choose a model');
  modelMenu.innerHTML = '<input type="text" class="pm-search" placeholder="Search models…" aria-label="Search models" autocomplete="off" spellcheck="false"><div class="pm-list"></div>';
  document.body.appendChild(modelMenu);
  modelBtn.addEventListener('click', e => { e.stopPropagation(); if (modelBtn.disabled) return; modelMenu.hidden ? openModelMenu() : closeModelMenu(); });
  const search = modelMenu.querySelector('.pm-search');
  search.addEventListener('input', () => renderModelMenu(search.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); const f = modelMenu.querySelector('.pm-item'); if (f) f.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); const f = modelMenu.querySelector('.pm-item'); if (f) f.click(); }
  });
  modelMenu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModelMenu(); modelBtn.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...modelMenu.querySelectorAll('.pm-item')]; if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowUp' && i <= 0) { e.preventDefault(); search.focus(); return; }
    if (i < 0 && e.key === 'ArrowUp') return;
    e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
  // Use pointerdown rather than the legacy mousedown event. Some Android WebViews
  // still synthesize a mouse event after the opening click; that used to close the
  // menu in the same tap. The short grace period covers that synthetic event while
  // still closing normally on a real outside tap.
  document.addEventListener('pointerdown', e => {
    if (!modelMenu || modelMenu.hidden) return;
    if (Date.now() - modelOpenedAt < 280) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !target.closest('#provMenu, #provQuickBtn')) closeModelMenu();
  });
  // Closing on any resize made the menu vanish as soon as the soft keyboard opened on a
  // phone. Keep it open and reposition it instead; only close when the page is hidden.
  window.addEventListener('resize', () => { if (!modelMenu.hidden) positionModelMenu(); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if (!modelMenu.hidden) positionModelMenu(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeModelMenu(); });
}
function syncModelBtn() {
  ensureModelMenu();
  const q = $('provQuick'), act = S.providers.find(p => p.id === S.activeId) || S.providers[0];
  let text, tier = '', title;
  // OpenCode CLI mode: the selector holds `opencode::<model>` and the chatbox must show THAT
  // model — not the CodeSpace provider that merely remains active underneath. Otherwise the
  // chosen OpenCode model never appears as the selected model in the composer.
  const ocModel = S.openCodeCLI && typeof currentOpenCodeModel === 'function' ? currentOpenCodeModel() : '';
  if (S.openCodeCLI) {
    text = ocModel || 'Select OpenCode model';
    tier = ocModel ? 'paid' : '';
    title = 'OpenCode CLI model · ' + (ocModel || '(none selected)') + ' — passed to opencode run --model';
  } else if (S.copilotAuto && q.querySelector('option[value="copilot::auto"]')) { text = COPILOT_LABEL; tier = 'auto'; title = 'CodeSpace Copilot switches to the next free model automatically when the current one hits a limit or fails.'; }
  else if (act) { text = act.model || act.name || 'Select model'; tier = modelTier(act, act.model); title = act.name + ' · ' + (act.model || '(no model set)') + (tier === 'free' ? ' — free' : ' — paid / other'); }
  else { text = 'Select model'; title = 'No provider configured'; }
  modelBtn.querySelector('.mb-txt').textContent = text;
  modelBtn.querySelector('.mb-tier').dataset.tier = tier;
  modelBtn.title = q.disabled ? q.title : title;
  modelBtn.disabled = !!q.disabled;
  if (typeof syncThinkVisibility === 'function') syncThinkVisibility();   // Think control follows the model's capability
}
function renderModelMenu(filter) {
  const list = modelMenu.querySelector('.pm-list'); list.innerHTML = '';
  const needle = String(filter || '').trim().toLowerCase();
  const items = modelPickerItems(), cur = $('provQuick').value;
  const add = (value, main, sub, tier) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-item'; b.setAttribute('role', 'option'); b.dataset.value = value;
    b.setAttribute('aria-selected', String(value === cur));
    b.innerHTML = '<span class="pm-check">' + (value === cur ? '✓' : '') + '</span><span class="pm-main"></span><span class="pm-sub"></span>';
    b.querySelector('.pm-main').textContent = main; b.querySelector('.pm-sub').textContent = sub || '';
    b.title = main + (sub ? ' · ' + sub : '');
    b.onclick = () => { closeModelMenu(); const q = $('provQuick'); if (q.value !== value) { q.value = value; q.dispatchEvent(new Event('change', { bubbles: true })); } else if (value === 'copilot::auto' && !S.copilotAuto) q.dispatchEvent(new Event('change', { bubbles: true })); modelBtn.focus(); };
    list.appendChild(b);
  };
  const head = (label, n) => { const h = document.createElement('div'); h.className = 'pm-head'; h.textContent = label + ' (' + n + ')'; list.appendChild(h); };
  // v46: while OpenCode CLI mode is active, offer a one-tap refresh of the dynamically discovered list.
  if (Array.isArray(globalThis.__opencodeModelIds)) {
    const r = document.createElement('button'); r.type = 'button'; r.className = 'pm-item pm-refresh'; r.setAttribute('role', 'button'); r.dataset.value = '__oc_refresh__';
    r.innerHTML = '<span class="pm-check"></span><span class="pm-main"></span><span class="pm-sub"></span>';
    r.querySelector('.pm-main').textContent = '↻ Refresh OpenCode models';
    r.querySelector('.pm-sub').textContent = globalThis.__opencodeModelIds.length + ' discovered';
    r.onclick = () => { try { Promise.resolve(typeof fillOpenCodeQuick === 'function' ? fillOpenCodeQuick(true) : null).then(() => renderModelMenu('')).catch(() => {}); } catch {} };
    list.appendChild(r);
  }
  if (items.free.length && (!needle || COPILOT_LABEL.toLowerCase().includes(needle))) add('copilot::auto', COPILOT_LABEL, 'auto-switch', 'auto');
  [['free', 'Free models'], ['paid', 'Paid models']].forEach(([key, label]) => {
    const rows = items[key].filter(({ p, id }) => !needle || (p.name + ' ' + id).toLowerCase().includes(needle));
    if (!rows.length) return;
    head(label, rows.length);
    rows.forEach(({ p, id }) => add(p.id + '::' + id, id || '(no model set)', p.name, key));
  });
  if (!list.children.length) { const e = document.createElement('div'); e.className = 'pm-empty'; e.textContent = needle ? 'No model matches “' + filter + '”.' : 'No models yet. Add a provider and refresh its models in Models.'; list.appendChild(e); }
}
function positionModelMenu() {
  if (!modelMenu || modelMenu.hidden || !modelBtn) return;
  const r = modelBtn.getBoundingClientRect();
  const vv = window.visualViewport;
  // visualViewport shrinks when the soft keyboard is open. Using it keeps the
  // menu above the keyboard instead of positioning it off-screen.
  const vw = Math.min(window.innerWidth, vv ? vv.width : window.innerWidth);
  const vh = Math.min(window.innerHeight, vv ? vv.height : window.innerHeight);
  const vTop = vv ? Math.max(0, vv.offsetTop || 0) : 0;
  const btnTop = r.top - vTop, btnBottom = r.bottom - vTop;
  const w = Math.min(Math.max(300, r.width), 420, vw - 16);
  const below = vh - btnBottom - 10, above = btnTop - 10, up = above >= below || above >= 360;
  modelMenu.style.width = w + 'px';
  modelMenu.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
  modelMenu.style.maxHeight = Math.max(160, Math.min(up ? above : below, 460)) + 'px';
  if (up) { modelMenu.style.top = 'auto'; modelMenu.style.bottom = Math.round(vh - btnTop + 6) + 'px'; }
  else { modelMenu.style.bottom = 'auto'; modelMenu.style.top = Math.round(btnBottom + 6) + 'px'; }
}
function openModelMenu() {
  ensureModelMenu(); renderModelMenu('');
  const s = modelMenu.querySelector('.pm-search'); s.value = '';
  modelMenu.hidden = false; modelOpenedAt = Date.now(); modelBtn.setAttribute('aria-expanded', 'true');
  // On a phone the composer may already own the keyboard. Drop it before measuring
  // so the popup has the full viewport and is not hidden behind the IME.
  const coarse = (navigator.maxTouchPoints || 0) > 0 || window.matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    try { if (document.activeElement && document.activeElement !== modelBtn && document.activeElement.blur) document.activeElement.blur(); } catch {}
  }
  positionModelMenu();
  requestAnimationFrame(positionModelMenu);
  const sel = modelMenu.querySelector('.pm-item[aria-selected="true"]'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  // Forcing the keyboard open used to trigger a resize that closed the menu immediately
  // on Android. Only auto-focus the search field when there is a fine pointer (desktop).
  if (!coarse) s.focus();
}
function closeModelMenu() {
  if (!modelMenu || modelMenu.hidden) return;
  modelMenu.hidden = true; modelBtn.setAttribute('aria-expanded', 'false');
}
/* v47.5: an active turn owns an Android foreground service + wake lock, and further user
   messages are queued instead of being silently dropped by the composer's single-flight guard. */
const CS_QUEUED_MESSAGES = [];
let csUiBusy = false, csQueueFlushing = false, csAiBgActive = false;
function csQueuedCount() { return CS_QUEUED_MESSAGES.length; }
function csSetAiBackground(active, label) {
  if (csAiBgActive === active) return;
  csAiBgActive = active;
  try {
    if (window.CodeSpaceNative && typeof window.CodeSpaceNative.setAiBackground === 'function') {
      window.CodeSpaceNative.setAiBackground(!!active, String(label || ''));
    } else if (typeof bcall === 'function') {
      bcall('/ai/background', { active: !!active, label: String(label || '').slice(0, 120) }).catch(() => {});
    }
  } catch (_) {}
}
function csUpdateBusyHint(b, text) {
  const el = $('ctxHint'); if (!el) return;
  if (!b) { el.textContent = ''; return; }
  const q = csQueuedCount();
  el.textContent = (text || 'Working…') + (q ? ' · ' + q + ' queued message' + (q > 1 ? 's' : '') : '') + ' · you can keep typing';
}
function csRenderQueueHint() { csUpdateBusyHint(csUiBusy, csUiBusy ? ($('ctxHint')?.dataset?.csBusyText || 'Working…') : ''); }
function csQueueMessage(snapshot) {
  CS_QUEUED_MESSAGES.push(snapshot);
  csRenderQueueHint();
  return CS_QUEUED_MESSAGES.length;
}
async function csFlushQueuedMessages() {
  if (csQueueFlushing || ctrl || sendPreparing || (typeof ocRunActive !== 'undefined' && ocRunActive)) return;
  csQueueFlushing = true;
  try {
    while (CS_QUEUED_MESSAGES.length && !ctrl && !sendPreparing && !(typeof ocRunActive !== 'undefined' && ocRunActive)) {
      const next = CS_QUEUED_MESSAGES.shift();
      csRenderQueueHint();
      try { await send(next); }
      catch (e) { addErr('Queued message failed: ' + String(e && e.message || e).slice(0, 500)); }
    }
  } finally { csQueueFlushing = false; csRenderQueueHint(); }
}
function setBusy(b, text) {
  b = !!b;
  csUiBusy = b;
  csSetAiBackground(b, text);
  if ($('ctxHint')) $('ctxHint').dataset.csBusyText = b ? String(text || 'Working…') : '';
  // v47.5: keep the composer usable while the agent works. Enter now queues the message.
  $('sendBtn').hidden = false; $('stopBtn').hidden = !b; $('input').disabled = false;
  csUpdateBusyHint(b, text);
  if (!b) {
    // v47.3: auto-focusing the composer on a phone raises the soft keyboard over the chat
    // (including at startup and after every turn). Only desktop/fine pointers get auto-focus.
    let coarse = false;
    try { coarse = (navigator.maxTouchPoints || 0) > 0 || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch {}
    if (!coarse) $('input').focus();
    updateMeters();
    csFlushQueuedMessages();
  }
}

/* ================= approvals + file access ================= */
/* ================= permissions, approvals and the activity log ================= */
let permHow = '';
const RULE_TOOLS = { command: 'Commands', edit: 'File edits', ext: 'Extension tools', site: 'Websites (external)', web: 'Web & HTTP requests', dev: 'Project checks (tests/lint/diagnostics)', sandboxjs: 'Sandbox JavaScript', pagejs: 'JavaScript in pages', sql: 'SQL that changes data', github: 'GitHub changes', vercel: 'Vercel changes', skill: 'Skill installs', '*': 'Anything' };
const splitCommand = c => String(c || '').split(/&&|\|\||;|\||\r?\n|&(?!&)/).map(x => x.trim()).filter(Boolean);
const DANGER = [/\brm\s+(-[a-z]*[rf]|--recursive|--force)/i, /\b(rmdir|rd)\s+\/s/i, /\bdel\s+.*\/[sqf]/i, /\bremove-item\b.*-recurse/i, /\bformat\s+[a-z]:/i, /\bmkfs\b/i, /\bdd\s+if=/i, /\bgit\s+push\b/i, /\bgit\s+reset\s+--hard/i, /\bgit\s+clean\b/i, /\bgit\s+checkout\s+--\s/i, /\bgit\s+branch\s+-D/i, /\bsudo\b/i, /\bchmod\s+-R/i, /\bchown\s+-R/i, /(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(sh|bash|zsh|powershell|pwsh|iex)/i, /\binvoke-expression\b|\biex\b/i, /\b(shutdown|reboot|halt)\b/i, /\b(taskkill|killall|pkill)\b/i, /:\(\)\s*\{/, />\s*\/dev\/sd/i, /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i, /\bdelete\s+from\b/i, /\bnpm\s+publish\b/i, /\bvercel\b.*--prod/i, /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)/i];
const SAFE = [/^(ls|dir|pwd|cd|echo|cat|type|head|tail|wc|grep|rg|which|where|whoami|date|tree|stat|file|sort|uniq|diff)(\s|$)/i, /^git\s+(status|diff|log|show|branch(\s+(-a|--list|-v|-vv|--show-current))?|remote(\s+-v)?|rev-parse|ls-files|blame|stash\s+list)(\s|$)/i, /^(node|python3?|py)\s+(-v|--version|-V)\s*$/i, /^(npm|npx|pnpm|yarn|pip3?|cargo|go|dotnet|java|mvn|gradle)\s+(-v|--version|version)\s*$/i, /^(npm|pnpm|yarn)\s+(ls|list|outdated|view|test|t)(\s|$)/i, /^(npm|pnpm|yarn)\s+run\s+(test|lint|build|check|typecheck)(\s|$)/i, /^npx\s+(tsc\s+--noEmit|eslint|prettier\s+--check|jest|vitest)(\s|$)/i, /^(pytest|python3?\s+-m\s+(pytest|unittest))(\s|$)/i, /^pip3?\s+(list|show|freeze)(\s|$)/i, /^node\s+--check\s/i, /^(cargo|go|dotnet)\s+(check|test|build|vet)(\s|$)/i, /^(mvn|gradle)\s+(test|verify|compile)(\s|$)/i, /^make\s+(test|check|lint)(\s|$)/i, /^(get-childitem|get-content|select-string|get-location|test-path)\b/i];
const isDangerousCommand = c => DANGER.some(r => r.test(String(c || '')));
function isSafeCommand(seg) {
  const s = String(seg).trim().replace(/\s*[12]?>\s*\/dev\/null/g, '').replace(/2>&1/g, '');
  if (/[<>]|`|\$\(|\$\{/.test(s) || /\bfind\b.*(-exec|-delete)/.test(s)) return false;
  return SAFE.some(r => r.test(s));
}
const isSensitivePath = p => /(^|\/)(\.env(\..*)?|\.git\/|\.ssh\/|id_rsa|\.npmrc|\.aws\/)/i.test(String(p || '').replace(/\\/g, '/'));
function commandPrefix(cmd) {
  const t = (splitCommand(cmd)[0] || String(cmd)).split(/\s+/);
  return ['git', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'pip', 'pip3', 'node', 'cargo', 'go', 'dotnet', 'docker', 'make', 'mvn', 'gradle'].includes(t[0]) && t[1] && !t[1].startsWith('-') ? t[0] + ' ' + t[1] : t[0];
}
const globRe = p => new RegExp('^' + String(p).split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
function ruleMatches(r, cat, subject) {
  if (r.tool !== cat && r.tool !== '*') return false;
  const m = String(r.match || '*').trim(), sub = String(subject || '').trim().replace(/\s+/g, ' ');
  if (cat === 'command' && r.tool === 'command') { const p = m.replace(/\*+$/, '').trim().toLowerCase(); return !p || sub.toLowerCase().startsWith(p); }
  return globRe(m || '*').test(sub);
}
function decide(cat, subject) {
  const rules = S.rules || [], segs = cat === 'command' ? splitCommand(subject) : [String(subject || '')];
  // Explicit Never allow rules always win, including when Allow all is selected.
  if (rules.some(r => r.action === 'deny' && segs.some(x => ruleMatches(r, cat, x)))) return { d: 'deny', why: 'blocked' };
  const mode = S.permMode || 'smart';
  if (mode === 'all') return { d: 'allow', why: 'mode' };
  const risky = cat === 'command' ? isDangerousCommand(subject) : cat === 'edit' ? isSensitivePath(subject) : false;
  if (risky) return { d: 'ask', why: 'risky' };
  const allowed = r => r.action === 'allow';
  if (cat === 'command') { if (segs.length && segs.every(x => rules.some(r => allowed(r) && ruleMatches(r, 'command', x)))) return { d: 'allow', why: 'rule' }; }
  else if (rules.some(r => allowed(r) && ruleMatches(r, cat, subject))) return { d: 'allow', why: 'rule' };
  if (['sql', 'github', 'vercel', 'site', 'skill', 'ext'].includes(cat)) return { d: 'ask', why: 'sensitive' };
  if (cat === 'web') {
    // Read-only public-web research (search/fetch/extract/find, GET requests) is auto-allowed in
    // smart mode; anything that sends data (POST/PUT/PATCH/DELETE prefix) always asks.
    if (/^(POST|PUT|PATCH|DELETE)\b/i.test(String(subject || ''))) return { d: 'ask', why: 'sensitive' };
    return { d: mode === 'ask' ? 'ask' : 'allow', why: 'mode' };
  }
  if (cat === 'dev') return mode === 'ask' ? { d: 'ask', why: 'mode' } : { d: 'allow', why: 'mode' };
  if (cat === 'pagejs') return /^(file:|https?:\/\/(localhost|127\.0\.0\.1|\[::1\]))/i.test(subject || '') ? { d: 'allow', why: 'mode' } : { d: 'ask', why: 'mode' };
  if (mode === 'ask') return { d: 'ask', why: 'mode' };
  if (mode === 'auto') return { d: 'allow', why: 'mode' };
  if (cat === 'edit' || cat === 'sandboxjs') return { d: 'allow', why: 'mode' };
  if (cat === 'command') return segs.length && segs.every(isSafeCommand) ? { d: 'allow', why: 'mode' } : { d: 'ask', why: 'mode' };
  return { d: 'ask', why: 'mode' };
}
function permMeta(cat, subject) {
  const risky = cat === 'command' ? isDangerousCommand(subject) : cat === 'edit' ? isSensitivePath(subject) : false;
  const m = { cat, subject: String(subject || ''), risky };
  if (risky) { m.noRule = true; return m; }
  if (cat === 'command') { const p = commandPrefix(subject); m.rule = { tool: 'command', match: p }; m.ruleLabel = 'Always allow commands starting with "' + p + '"'; }
  else if (cat === 'edit') { m.rule = { tool: 'edit', match: '*' }; m.ruleLabel = 'Always allow the agent to edit files in this project'; }
  else if (cat === 'ext') { m.rule = { tool: 'ext', match: subject }; m.ruleLabel = 'Always allow the "' + subject + '" extension'; }
  else if (cat === 'site') { m.rule = { tool: 'site', match: subject }; m.ruleLabel = 'Always allow the agent to use ' + subject; }
  return m;
}
function addRule(r) {
  S.rules = S.rules || [];
  if (S.rules.some(x => x.tool === r.tool && x.match === r.match && x.action === r.action)) return;
  S.rules.push({ id: uid(), ...r }); touchS(); renderActivity();
}
function approve(title, preview, key, meta) {
  if (meta) {
    const r = decide(meta.cat, meta.subject);
    if (r.d === 'allow') { permHow = r.why === 'rule' ? 'rule' : 'mode'; return Promise.resolve(true); }
    if (r.d === 'deny') { permHow = 'blocked'; return Promise.resolve(false); }
  } else if (autoOk.has(key)) { permHow = 'mode'; return Promise.resolve(true); }
  else if (S.permMode === 'all') { permHow = 'mode'; return Promise.resolve(true); }
  return new Promise(res => {
    const d = $('appr'), risky = !!(meta && meta.risky);
    $('apprTitle').textContent = title; $('apprBody').textContent = String(preview).slice(0, 4000); $('apprAuto').checked = false;
    $('apprWarn').hidden = !risky; if (risky) $('apprWarn').textContent = '⚠ This looks risky: it could delete data, publish something, or run remote code. Check it carefully.';
    $('apprAutoRow').hidden = !!(meta && meta.noRule);
    $('apprAutoLabel').textContent = meta && meta.ruleLabel ? meta.ruleLabel : "Don't ask again for this tool until I reload";
    const onClose = () => {
      d.removeEventListener('close', onClose); const ok = d.returnValue === 'allow'; permHow = ok ? 'you' : 'denied';
      if (ok && $('apprAuto').checked) { if (meta && meta.rule) addRule({ ...meta.rule, action: 'allow' }); else autoOk.add(key); }
      res(ok);
    };
    d.addEventListener('close', onClose); d.returnValue = ''; d.showModal();
  });
}
let ACT = []; try { ACT = JSON.parse(localStorage.getItem('agent3.log') || '[]'); } catch {}
function logActivity(call, out) {
  const m = stepMeta(call);
  ACT.unshift({ t: Date.now(), ic: m.ic, title: m.t, sub: String(m.sub || '').slice(0, 140), how: permHow || '', st: out.st || 'ok', chat: cur().title });
  if (ACT.length > 300) ACT.length = 300;
  try { localStorage.setItem('agent3.log', JSON.stringify(ACT)); } catch {}
  if (typeof viewOpen === 'function' && viewOpen('log')) renderActivity();
}
const READONLY = new Set(['list_files', 'read_file', 'search_files', 'codebase_index_status', 'code_search', 'find_symbol', 'symbol_references', 'related_files', 'project_map', 'browser_read', 'browser_tabs', 'browser_console', 'browser_network', 'load_skill', 'terminal_read', 'web_search', 'web_open', 'web_extract', 'web_find', 'get_diagnostics', 'lint_project', 'project_health_check', 'dependency_analysis', 'find_unused_code', 'inspect_package', 'task_list', 'file_history', 'browser_dom_snapshot', 'browser_accessibility_tree', 'api_collection', 'inspect_response', 'run_tests']);
function cleanPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(x => x && x !== '.');
  if (parts.includes('..')) throw new Error('Paths with ".." are not allowed');
  return parts;
}
async function getDir(parts, create = false) { let h = dirHandle; for (const p of parts) h = await h.getDirectoryHandle(p, { create }); return h; }
async function getFileH(p) { const parts = cleanPath(p); if (!parts.length) throw new Error('Missing file path'); const name = parts.pop(); return (await getDir(parts)).getFileHandle(name); }
async function* walkH(dir, prefix = '') {
  for await (const [name, h] of dir.entries()) {
    if (IGNORE.has(name)) continue;
    if (h.kind === 'directory') yield* walkH(h, prefix + name + '/'); else yield { path: prefix + name, handle: h };
  }
}
/* 3.13.3: outside-workspace access. The server allows read-only listing/reading/searching
   OUTSIDE the opened folder only after the user approves it (permission 'outside', default
   'ask'). These wrappers send through bApproved so the challenge turns into the usual
   approval dialog; inside the workspace nothing changes (no challenge, no dialog). */
async function outsideApproved(ep, body, sig, verb) {
  const r = await bApproved(ep, body, sig, verb + ' outside the opened folder?', 'fs_outside:' + ep + ':' + JSON.stringify(body), permMeta('outside', String(body.path || '')));
  if (r && r.needsApproval) throw new Error(String(r.note || 'Outside-folder access was not approved.'));
  if (r && r.st === 'err' && r.text) throw new Error(r.text);
  return r;
}
async function fsRead(p, sig) {
  if (B.ok) return (await outsideApproved('/fs/read', { path: p }, sig, 'Read a file')).content;
  if (!dirHandle) throw new Error('No project folder is open');
  if (BINARY.test(p)) throw new Error('Refusing to read a binary file');
  const f = await (await getFileH(p)).getFile();
  if (f.size > 1e6) throw new Error('File is larger than 1 MB');
  return f.text();
}
async function fsWrite(p, content, sig) {
  if (B.ok) {
    const r = await bApproved('/fs/write', { path: p, content }, sig, 'Write file (server permission)?', 'fs_write', permMeta('edit', p));
    if (r && r.needsApproval) throw new Error(String(r.note || 'The server approval could not be completed.'));
    if (r && r.st === 'err' && r.text) throw new Error(r.text);
    return;
  }
  if (!dirHandle) throw new Error('No project folder is open');
  const parts = cleanPath(p), name = parts.pop();
  const fh = await (await getDir(parts, true)).getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(content); await w.close();
}
async function fsDelete(p, sig) {
  if (B.ok) {
    const r = await bApproved('/fs/delete', { path: p }, sig, 'Delete file (server permission)?', 'fs_delete', permMeta('edit', p));
    if (r && r.needsApproval) throw new Error(String(r.note || 'The server blocked this delete (permission settings).'));
    if (r && r.st === 'err' && r.text) throw new Error(r.text);
    return;
  }
  if (!dirHandle) throw new Error('No project folder is open');
  const parts = cleanPath(p), name = parts.pop(); await (await getDir(parts)).removeEntry(name);
}
async function fsList(p, recursive, sig) {
  if (B.ok) return (await outsideApproved('/fs/list', { path: p, recursive: !!recursive }, sig, 'List a folder')).entries;
  if (!dirHandle) throw new Error('No project folder is open');
  const dir = await getDir(cleanPath(p)), out = [];
  if (recursive) { for await (const f of walkH(dir)) { out.push(f.path); if (out.length >= 300) { out.push('…(limit reached)'); break; } } }
  else { for await (const [name, h] of dir.entries()) if (!IGNORE.has(name)) out.push(name + (h.kind === 'directory' ? '/' : '')); out.sort(); }
  return out;
}
async function fsSearch(q, p, sig) {
  if (B.ok) return (await outsideApproved('/fs/search', { query: q, path: p }, sig, 'Search a folder')).matches;
  if (!dirHandle) throw new Error('No project folder is open');
  const ql = String(q || '').toLowerCase(), hits = []; let scanned = 0;
  for await (const f of walkH(await getDir(cleanPath(p)))) {
    if (BINARY.test(f.path)) continue;
    if (++scanned > 400) { hits.push('…(stopped after 400 files)'); break; }
    const file = await f.handle.getFile(); if (file.size > 1e6) continue;
    (await file.text()).split('\n').forEach((line, i) => { if (hits.length < 60 && line.toLowerCase().includes(ql)) hits.push(f.path + ':' + (i + 1) + ': ' + line.trim().slice(0, 200)); });
    if (hits.length >= 60) { hits.push('…(match limit reached)'); break; }
  }
  return hits;
}

/* ================= tools ================= */
