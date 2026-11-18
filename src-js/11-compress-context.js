async function compressNow(manual) {
  if (compressing) return false; compressing = true;
  const sess = cur(), h = sess.messages, lim = P().ctx || DEFAULT_CTX, before = ctxUsed(true).used;
  try {
    // step 1: shrink bulky old tool output and file contents (no model call)
    const keepFrom = Math.max(0, h.length - 6);
    for (let i = 0; i < keepFrom; i++) {
      const m = h[i];
      if (m.role === 'tool') { if (m.content.length > 1200) m.content = m.content.slice(0, 600) + '\n…[trimmed to save context]…\n' + m.content.slice(-300); delete m.image; delete m.diff; }
      if (m.role === 'assistant' && m.toolCalls) m.toolCalls.forEach(c => { if (c.args && typeof c.args.content === 'string' && c.args.content.length > 800) c.args = { ...c.args, content: c.args.content.slice(0, 300) + '…[trimmed]' }; });
    }
    sess.usage = null;
    // step 2: summarize everything except the most recent messages
    if (manual || ctxUsed().used / lim > 0.6) {
      let cut = -1;
      for (let i = h.length - 8; i > 0; i--) { if (h[i].role === 'assistant' || h[i].role === 'user') { cut = i; break; } }
      if (cut > 0) {
        let tx = h.slice(0, cut).map(m => {
          if (m.role === 'user') return 'User: ' + m.content;
          if (m.role === 'summary') return 'Earlier summary: ' + m.content;
          if (m.role === 'assistant') return 'Assistant: ' + stripThink(m.content) + (m.toolCalls || []).map(c => '\n  [called ' + c.name + ' ' + JSON.stringify(c.args || {}).slice(0, 200) + ']').join('');
          return 'Tool result (' + m.name + '): ' + String(m.content).slice(0, 500);
        }).join('\n');
        if (tx.length > 14000) tx = '[earlier part omitted]\n' + tx.slice(-14000);
        const r = await callModel(P(), 'You compress chat history for an AI coding agent so work can continue with less context. Write a dense, factual summary in plain text with these parts: Goal; Decisions and constraints; Files created or changed (with paths); Commands run and their outcomes; Open problems and next steps; Important facts (names, URLs, settings). Do not invent anything. Be concise.', [{ role: 'user', content: 'Summarize this conversation:\n\n' + tx }], [], ctrl ? ctrl.signal : undefined);
        const sum = stripThink(r.text);
        if (sum) h.splice(0, cut, { role: 'summary', content: sum });
      }
    }
    sess.usage = null; persistSession(); renderHistory();
    const after = ctxUsed(true).used;
    addNote('Context compressed: ' + fmtTok(before) + ' → ' + fmtTok(after) + ' tokens');
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') addErr('Could not summarize the conversation: ' + e.message);
    return false;
  } finally { compressing = false; updateMeters(); }
}
async function maybeCompress() {
  const sess = cur(), h = sess.messages, frac = ctxUsed().used / (P().ctx || DEFAULT_CTX);
  const saver = S.tokenSaver && frac > 0.5 && h.length > 12 && h.length - (sess.lastCompressAt || 0) >= 8;
  const full = S.autoCompress && frac > 0.85;
  if (!saver && !full) return;
  setBusy(true, 'Compressing context…');
  if (await compressNow(saver)) sess.lastCompressAt = h.length;
}
/* Token saver: what is sent to the model is a leaner copy. The chat itself keeps everything. */
function prepared(h) {
  saverSaved = 0;
  if (!S.tokenSaver) return h;
  const recent = h.length - 8;
  return h.map((m, i) => {
    if (i >= recent) return m;
    if (m.role === 'tool') {
      let out = m; const c = m.content || '';
      if (c.length > 700) { const t = c.slice(0, 450) + '\n…[older output trimmed to save tokens]…\n' + c.slice(-150); saverSaved += (c.length - t.length) / 3.6; out = { ...m, content: t }; }
      if (m.image) { out = { ...out, image: undefined }; saverSaved += 400; }
      return out;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      let changed = false;
      const tcs = m.toolCalls.map(c => {
        const a = c.args;
        if (a) { const o = { ...a }; let hit = false; for (const k of ['content', 'old_text', 'new_text']) if (typeof o[k] === 'string' && o[k].length > 400) { saverSaved += o[k].length / 3.6; o[k] = '[' + o[k].length + ' characters omitted to save tokens]'; hit = true; } if (hit) { changed = true; return { ...c, args: o }; } }
        return c;
      });
      return changed ? { ...m, toolCalls: tcs } : m;
    }
    return m;
  });
}

/* ================= bounded agent loop ================= */
const MAX_TOOL_CALLS_PER_TURN = 100;
const MAX_IDENTICAL_TOOL_RESULTS = 5;
/* 3.12.6: when the model deadlocks (identical tool call returning the same result 5 times) or
   ends without a visible final answer, the turn no longer just stops and waits for the user:
   the agent AUTO-RESUMES with a private continuation instruction, at most AUTO_RESUME_MAX times
   per turn. Bounded so it can never loop forever or burn unbounded tokens; pressing Stop still
   cancels immediately, and every auto-resume is announced in the chat as a visible note. */
const AUTO_RESUME_MAX = 2;
const AUTO_RESUME_REPEAT_PROMPT = 'AUTOMATIC CONTINUATION (internal system message, not from the user): your previous turn was stopped because an identical tool call kept returning the same result. Continue the task now with a DIFFERENT approach — another tool, different arguments, or a different path to the same goal — and finish with a clear, visible final answer for the user.';
const AUTO_RESUME_EMPTY_PROMPT = 'AUTOMATIC CONTINUATION (internal system message, not from the user): your previous reply had no visible final answer for the user. Reply now with the final answer, based on the work and tool results already collected.';
function isValidationCommand(command) {
  const c = String(command || '').trim();
  return [
    /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|tests|lint|build|check|typecheck|type-check|verify)\b/i,
    /^(?:npm|pnpm|yarn)\s+(?:exec\s+)?(?:vitest|jest|eslint|tsc|prettier)\b/i,
    /^(?:npx|bunx)\s+(?:vitest|jest|eslint|tsc|prettier)\b/i,
    /^(?:pytest|phpunit|pest|ruff|mypy|eslint|tsc|vitest|jest)\b/i,
    /^python(?:3)?\s+-m\s+(?:pytest|unittest|mypy|compileall)\b/i,
    /^php\s+artisan\s+(?:test|lint|check)\b/i,
    /^composer\s+(?:test|validate)\b/i,
    /^(?:cargo|go|dotnet|mvn|gradle|make)\s+(?:test|check|build|verify|lint|vet|compile)\b/i,
    /^node\s+--check\b/i,
    /^git\s+diff\s+--check\b/i
  ].some(re => re.test(c));
}
function recordTurnActivity(run, call, out) {
  const a = call.args || {};
  const output = String(out && out.text || '');
  if (out && (out.st === 'err' || out.st === 'warn')) run.toolIssues++;
  if ((call.name === 'edit_file' || call.name === 'write_file') && /^(Edited|Wrote) /.test(output)) {
    if (a.path) run.changedFiles.add(String(a.path));
  }
  if (call.name === 'browser_read') run.browserInspections++;
  if (call.name === 'run_command' && isValidationCommand(a.command)) {
    const rc = output.match(/\bexit code:\s*(-?\d+)/i);
    const started = output.match(/Started in terminal\s+([\w-]+)/i);
    let status = 'unverified';
    if (/timed out and was killed/i.test(output)) status = 'timed out';
    else if (rc) status = Number(rc[1]) === 0 ? 'passed' : 'failed';
    else if (started) status = 'running';
    run.validations.push({ command: String(a.command).slice(0, 180), status, terminalId: started ? started[1] : '', detail: rc ? 'exit code ' + rc[1] : '' });
  } else if (call.name === 'terminal_read') {
    const pending = run.validations.find(v => v.status === 'running' && v.terminalId === String(a.id || ''));
    if (pending) {
      const done = output.match(/process exited with code\s+(-?\d+)/i);
      if (done) { pending.status = Number(done[1]) === 0 ? 'passed' : 'failed'; pending.detail = 'exit code ' + done[1]; }
      else if (/timed out/i.test(output)) { pending.status = 'timed out'; pending.detail = 'terminal output indicates timeout'; }
    }
  }
}
function formatAgentRunReport(run) {
  const stopLabels = {
    completed: 'Agent returned a final response',
    running: 'Agent is still working (saved recovery snapshot)',
    interrupted: 'Agent was interrupted before its final response',
    'empty-final': 'Agent ended without a user-facing final answer',
    'tool-limit': 'Stopped at the tool-call limit',
    'repeat-limit': 'Stopped after repeated identical tool results',
    cancelled: 'Cancelled by the user',
    error: 'Stopped because of an error'
  };
  const lines = [
    'Run report: ' + (stopLabels[run.stopReason] || 'Stopped') + '.',
    'Activity: ' + run.steps + ' model rounds (no fixed round cap) · ' + run.toolCalls + '/' + MAX_TOOL_CALLS_PER_TURN + ' tool calls · ' + run.toolIssues + ' tool error/warning(s).'
  ];
  if (run.changedFiles.size) lines.push('Files changed: ' + [...run.changedFiles].slice(0, 12).join(', ') + (run.changedFiles.size > 12 ? ', …' : ''));
  if (run.validations.length) {
    const counts = { passed: 0, failed: 0, 'timed out': 0, running: 0, unverified: 0 };
    run.validations.forEach(v => { counts[v.status] = (counts[v.status] || 0) + 1; });
    lines.push('Validation commands: ' + run.validations.map(v => v.command + ' — ' + v.status + (v.detail ? ' (' + v.detail + ')' : '')).join('; '));
  } else {
    lines.push('Validation: No test/build/lint/type-check command was detected this turn; that does not mean the code passed.');
  }
  if (run.browserInspections) lines.push('Browser inspections: ' + run.browserInspections + ' browser_read call(s); this is not a substitute for automated tests.');
  if (run.multiAgent) {
    lines.push('Multi-agent roles: ' + ((run.agentStages || []).map(x => x.name + ' — ' + x.status).join('; ') || 'no sub-agent result recorded') + '.');
    if (run.reviewSummary) lines.push('Independent QA review: ' + run.reviewSummary);
    const routed = (run.agentStages || []).filter(x => x.providerName).map(x => x.name + ' = ' + x.providerName + (x.model ? ' / ' + x.model : '') + ' (' + x.status + ')');
    lines.push('Per-role model routing: ' + (routed.join('; ') || 'no role/provider metadata recorded') + '. Unassigned roles fall back to the chat-selected model. Advisory agents do not directly edit files or execute tools.');
  }
  if (run.stopReason === 'running') lines.push('Completeness: The run is still in progress; this is a saved progress snapshot, not a completion report.');
  else if (run.stopReason !== 'completed') lines.push('Completeness: This task may be incomplete. Review the saved work and continue from the last completed action.');
  else lines.push('Completeness: The model returned a final response; use the validation results above to judge what was actually verified.');
  if (run.internalWarnings && run.internalWarnings.length) lines.push('Internal warnings: ' + run.internalWarnings.join('; '));
  return lines.join('\n');
}
/* 3.12.7: when a turn stops before finishing (user Stop, provider error, tool-call limit,
   repeat limit, empty final), the NEXT user message (typically "continue") used to reach the
   model as a bare word on top of raw, token-saver-trimmed history — the model could not see
   where the work actually stopped, so it restarted the task instead of resuming it. The run
   report above was stored for diagnostics only. Now the next turn injects this private
   continuation note (report + the most recent work items) into the model context, for every
   engine: ask/agent/multi-agent share runAgent, OpenCode appends it to the CLI prompt.
   Injected exactly once, then cleared. */
function buildContinuationNote(sess, h) {
  if (!sess || !sess.lastRunStop || sess.lastRunStop === 'completed') return '';
  const stop = sess.lastRunStop;
  const labels = {
    cancelled: 'was cancelled (you pressed Stop, or the connection ended the turn)',
    interrupted: 'was interrupted by an app reload, browser restart, or connection loss',
    running: 'was interrupted while it was still running (the last saved progress is shown below)',
    error: 'was stopped by an error (often a temporary provider problem)',
    'tool-limit': 'was stopped at the tool-call safety limit',
    'repeat-limit': 'was stopped after repeating identical tool results',
    'empty-final': 'ended without a final answer'
  };
  const tail = [];
  for (let i = h.length - 1; i >= 0 && tail.length < 5; i--) {
    const m = h[i];
    if (m.role === 'assistant' && String(m.content || '').trim()) tail.unshift('Last assistant message: ' + stripThink(String(m.content)).trim().slice(0, 700));
    else if (m.role === 'tool') tail.unshift('Tool result [' + (m.name || 'tool') + ']: ' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 400));
  }
  sess.lastRunStop = ''; // inject once, then clear
  return '\n\nCONTINUATION CONTEXT (internal system note, not from the user — never mention or quote it): The previous turn ' + (labels[stop] || 'was stopped before finishing') + '. Work state recorded at that point:\n' + String(sess.lastRunReport || 'No run report was recorded.').slice(0, 2200) + (tail.length ? '\nMost recent work items:\n' + tail.join('\n') : '') + '\n\nContinue that work from where it stopped: do NOT restart the task from scratch and do NOT redo steps that already succeeded. If anything about the current state is unclear, verify it with tools first, then finish the remaining work and end with a clear final answer for the user. If the user\u2019s new message is a different request, just answer that request normally.';
}

/* ================= live multi-agent activity UI ================= */
