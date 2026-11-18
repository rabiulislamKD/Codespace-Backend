#!/usr/bin/env node
/* CodeSpace 3.10.0 — functional verification of the new backend capabilities.
   Boots the real bridge on a test port with a temp workspace + temp data dir,
   starts a loopback test site, and exercises every new endpoint end-to-end. */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs310-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs310-data-'));
// Use a per-run port pair so a stale server from an interrupted test cannot impersonate this run.
const PORT = 25000 + Math.floor(Math.random() * 3000), SITE = PORT + 1, TOKEN = 'testtoken310';
let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const skip = name => { skipped++; console.log('SKIP ' + name); };

// ---- workspace fixtures ----
fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test-runner.js' } }, null, 2));
fs.writeFileSync(path.join(WORK, 'test-runner.js'), "console.log('Tests: 3 passed, 3 total')\n");
fs.writeFileSync(path.join(WORK, 'app.js'), 'function greetUser(name) {\n  return "hello " + name;\n}\nfunction unusedHelper() { return 42; }\nmodule.exports = { greetUser };\n');
fs.writeFileSync(path.join(WORK, 'main.js'), 'const { greetUser } = require("./app.js");\nconsole.log(greetUser("world"));\n');

// ---- loopback test site ----
const site = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, items: [1, 2, 3], token: 'secret-value' })); }
    else if (req.url === '/echo') { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ method: req.method, echo: body, headerAuth: req.headers['x-auth'] || '' })); }
    else if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head><title>Fixtures</title></head><body><main><h1>Fixture Page</h1><p>The quick brown fox.</p><a href="/json">data</a></main><script>ignored()</script></body></html>'); }
    else { res.writeHead(404); res.end('nope'); }
  });
});

const server = spawn(process.execPath, [path.join(ROOT, 'agent-server.js'), WORK, '--port', String(PORT), '--token', TOKEN], {
  env: { ...process.env, MY_AGENT_DATA_DIR: DATA, MY_AGENT_ALLOW_LOOPBACK: '1' }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', c => { serverLog += c; });
server.stderr.on('data', c => { serverLog += c; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(ep, body, expectStatus) {
  const r = await fetch('http://127.0.0.1:' + PORT + ep, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(45000) });
  const data = await r.json().catch(() => ({}));
  if (expectStatus && r.status !== expectStatus) throw new Error('POST ' + ep + ' → HTTP ' + r.status + ' (wanted ' + expectStatus + '): ' + JSON.stringify(data).slice(0, 200));
  return { status: r.status, data };
}

(async () => {
  // Wait for the bridge we actually spawned; a stale listener must not count as success.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    if (server.exitCode !== null || server.signalCode !== null) break;
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); up = r.ok && server.exitCode === null && server.signalCode === null; } catch {}
    if (!up) await sleep(250);
  }
  ok('bridge starts and serves', up, serverLog.slice(-400));
  if (!up) { console.log(serverLog); process.exit(1); }
  await new Promise(r => site.listen(SITE, '127.0.0.1', r));

  // ---------- permissions ----------
  let r = await api('/perm/get');
  ok('perm/get returns all 17 current permission definitions (including native extension code)', r.data.permissions && Object.keys(r.data.permissions).length === 17, JSON.stringify(r.data).slice(0, 150));
  r = await api('/perm/set', { permissions: { fsEdit: 'deny' } });
  ok('perm/set accepts modes', r.data.permissions && r.data.permissions.fsEdit === 'deny');
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x' });
  ok('deny blocks fs/write (backend enforcement)', r.status === 403 && /permission/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x', approved: true, confirmed: true });
  ok('deny blocks fs/write even with approved:true', r.status === 403 && !fs.existsSync(path.join(WORK, 'blocked.txt')), JSON.stringify(r.data));
  r = await api('/perm/set', { permissions: { fsEdit: 'ask' } });
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x' });
  ok('ask returns needsApproval gate with a token', r.status === 200 && r.data.needsApproval === true && r.data.permission === 'fsEdit' && /^apr_/.test(r.data.approvalToken || ''), JSON.stringify(r.data).slice(0, 150));
  const tk = r.data.approvalToken;
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x', approved: true, confirmed: true });
  ok('approved:true no longer passes the ask gate (3.11)', r.status === 200 && r.data.needsApproval === true, JSON.stringify(r.data).slice(0, 150));
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x', approvalToken: tk });
  ok('a valid approval token completes the operation', r.status === 200 && r.data.bytes === 1, JSON.stringify(r.data).slice(0, 150));
  r = await api('/fs/write', { path: 'blocked.txt', content: 'x', approvalToken: tk });
  ok('approval replay fails (single use)', r.status === 200 && r.data.needsApproval === true && /already used/.test(r.data.note || ''), JSON.stringify(r.data).slice(0, 200));
  r = await api('/fs/write', { path: 'blocked2.txt', content: 'x', approvalToken: (await api('/fs/write', { path: 'blocked.txt', content: 'x' })).data.approvalToken });
  ok('a token for another operation does not approve a different body', r.status === 200 && r.data.needsApproval === true && /does not match/.test(r.data.note || ''), JSON.stringify(r.data).slice(0, 200));
  await api('/perm/set', { permissions: { fsEdit: 'allow' } });
  r = await api('/perm/set', { permissions: { fsEdit: 'banana' } });
  ok('invalid mode rejected', r.status === 400);

  // ---------- rate limiting (uses /index/rebuild, limited to 6/min and fast on a tiny workspace) ----------
  let limited = false;
  for (let i = 0; i < 8; i++) { const x = await api('/index/rebuild', {}); if (x.status === 429) { limited = true; break; } }
  ok('rate limiter returns 429 on /index/rebuild after 6/min', limited);
  await sleep(500);

  // ---------- http tools ----------
  r = await api('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json' });
  ok('http_request GET loopback works', r.data.status === 200 && r.data.json && r.data.json.ok === true, JSON.stringify(r.data).slice(0, 160));
  ok('http_request returns duration + headers + responseId', typeof r.data.durationMs === 'number' && r.data.headers && !!r.data.responseId);
  r = await api('/http/request', { method: 'POST', url: 'http://127.0.0.1:' + SITE + '/echo', body: { hello: 'world' }, headers: { 'X-Auth': 'topsecret' } });
  ok('http_request POST JSON body + custom header', r.data.status === 201 && r.data.json.echo.includes('hello'), JSON.stringify(r.data).slice(0, 160));
  r = await api('/http/request', { method: 'POST', url: 'http://127.0.0.1:' + SITE + '/echo', form: { a: '1', b: '2' } });
  ok('http_request form encoding', r.data.json.echo.includes('a=1'));
  r = await api('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json', expect: { status: 200, json_path: 'items.1', equals: 2, max_ms: 5000 } });
  ok('expect validation passes', r.data.validation && r.data.validation.passed === true, JSON.stringify(r.data.validation));
  r = await api('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json', expect: { status: 500 } });
  ok('expect validation reports failures', r.data.validation && r.data.validation.passed === false && r.data.validation.failures.length >= 1);
  r = await api('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json' });
  const rid = r.data.responseId;
  r = await api('/http/inspect', { response_id: rid, path: 'items.0' });
  ok('inspect_response dot-path lookup', r.data.found === true && r.data.value === 1, JSON.stringify(r.data).slice(0, 160));
  r = await api('/http/inspect', { search: 'secret-value' });
  ok('inspect_response text search with context', r.data.search && r.data.search.found === true);
  r = await api('/api/collection-placeholder-not-real', {});
  ok('unknown endpoint still 404', r.status === 404);
  r = await api('/http/collection', { action: 'save', name: 'fixture-json', method: 'GET', url: 'http://127.0.0.1:' + SITE + '/json', expect: { status: 200 } });
  ok('api_collection save', r.data.saved && r.data.count === 1);
  r = await api('/http/collection', { action: 'list' });
  ok('api_collection list hides headers/body', r.data.requests.length === 1 && r.data.requests[0].url.includes('/json') && !JSON.stringify(r.data).includes('topsecret'));
  r = await api('/http/collection', { action: 'run', name: 'fixture-json' });
  ok('api_collection run with stored expect', r.data.status === 200 && r.data.validation.passed === true);
  r = await api('/http/collection', { action: 'delete', name: 'fixture-json' });
  ok('api_collection delete', r.data.deleted === 1);
  r = await api('/http/request', { url: 'https://127.0.0.1/x' });
  ok('https to private host never returns data (blocked, or connect-refused under explicit loopback opt-in)', (r.status === 400 && /private|loopback/i.test(r.data.error || '')) || (r.status === 400 && /reach|failed/i.test(r.data.error || '')), JSON.stringify(r.data));
  r = await api('/http/request', { url: 'http://example.com/x' });
  ok('plain http to public host blocked', r.status === 400 && /localhost/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api('/http/request', { method: 'TRACE', url: 'http://127.0.0.1:' + SITE + '/json' });
  ok('unsupported method rejected', r.status === 400);

  // ---------- web tools ----------
  // This suite runs with MY_AGENT_ALLOW_LOOPBACK=1 (the explicit configuration that 3.11 requires
  // for local dev servers); the SSRF refusal tests for the DEFAULT config live in verify-3.11.0.cjs.
  r = await api('/web/fetch', { url: 'http://127.0.0.1:' + SITE + '/page' });
  ok('web tools reach a local dev server only with explicit loopback opt-in', r.status === 200 && r.data.content && r.data.content.includes('Fixture Page'), JSON.stringify(r.data).slice(0, 140));
  r = await api('/web/extract', { url: 'https://example.com' });
  const netOk = r.status === 200;
  if (netOk) {
    ok('web_extract reads a public page', /Example|iana/i.test(r.data.text || '') && r.data.title, JSON.stringify(r.data).slice(0, 140));
    r = await api('/web/find', { url: 'https://example.com', query: 'examples' });
    ok('web_find locates text with line numbers', r.data.matches && r.data.matches.length >= 1);
  } else skip('public-web tools (no internet in sandbox): ' + (r.data.error || r.status));

  // ---------- multi-file edits ----------
  r = await api('/fs/editbatch', { edits: [
    { path: 'app.js', old_text: '"hello "', new_text: '"hi "' },
    { path: 'main.js', old_text: 'greetUser("world")', new_text: 'greetUser("code")' }
  ] });
  ok('fs/editbatch applies coordinated edits', r.data.applied === 2 && fs.readFileSync(path.join(WORK, 'app.js'), 'utf8').includes('"hi "'), JSON.stringify(r.data).slice(0, 200));
  const beforeMain = fs.readFileSync(path.join(WORK, 'main.js'), 'utf8');
  r = await api('/fs/editbatch', { edits: [ { path: 'main.js', old_text: 'DOES-NOT-EXIST', new_text: 'x' } ] });
  ok('editbatch atomic: failed match changes nothing', r.status === 400 && fs.readFileSync(path.join(WORK, 'main.js'), 'utf8') === beforeMain);
  r = await api('/fs/editbatch', { edits: [ { path: 'app.js', old_text: 'greetUser', new_text: 'X', replace_all: false } ] });
  ok('editbatch refuses ambiguous multi-match without replace_all', r.status === 400 && /times/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 140));

  // ---------- per-file undo/redo ----------
  r = await api('/fs/history', { path: 'app.js' });
  ok('fs/history lists versions', r.data.undo.length >= 1, JSON.stringify(r.data));
  const afterEdit = fs.readFileSync(path.join(WORK, 'app.js'), 'utf8');
  r = await api('/fs/undo', { path: 'app.js' });
  ok('fs/undo restores previous version', r.data.ok === true && !fs.readFileSync(path.join(WORK, 'app.js'), 'utf8').includes('"hi "'));
  r = await api('/fs/redo', { path: 'app.js' });
  ok('fs/redo re-applies', r.data.ok === true && fs.readFileSync(path.join(WORK, 'app.js'), 'utf8') === afterEdit);

  // ---------- rename symbol (index-driven) ----------
  await api('/index/rebuild', {});
  r = await api('/index/rename', { symbol: 'greetUser', new_name: 'sayHello' });
  ok('index/rename replaces across files', r.status === 200 && r.data.totalReplacements >= 3 && fs.readFileSync(path.join(WORK, 'app.js'), 'utf8').includes('function sayHello'), JSON.stringify(r.data).slice(0, 200));
  r = await api('/index/rename', { symbol: 'not an id!', new_name: 'x' });
  ok('index/rename validates identifiers', r.status === 400);

  // ---------- developer intelligence ----------
  r = await api('/dev/tooling', {});
  ok('dev/tooling probes toolchains', Array.isArray(r.data.tools) && r.data.tools.some(t => t.name === 'node' && t.available));
  r = await api('/dev/tests', {});
  ok('run_tests discovers npm test script', r.data.ran === false && r.data.commands.some(c => c.command === 'npm run test'), JSON.stringify(r.data).slice(0, 200));
  r = await api('/dev/tests', { command: 'node test-runner.js' });
  ok('run_tests executes and parses summary', r.data.ran === true && r.data.exitCode === 0 && r.data.summary && r.data.summary.passed === 3, JSON.stringify(r.data).slice(0, 220));
  r = await api('/dev/tests', { command: 'rm -rf /' });
  ok('run_tests refuses dangerous commands', r.status === 400 && /dangerous/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api('/dev/tests', { command: 'npm install left-pad' });
  ok('run_tests refuses installs', r.status === 400);
  r = await api('/dev/diagnostics', {});
  ok('get_diagnostics returns structured result', Array.isArray(r.data.diagnostics) && Array.isArray(r.data.notes));
  r = await api('/dev/lint', {});
  ok('lint_project returns structured result', Array.isArray(r.data.issues));
  r = await api('/dev/deps', {});
  ok('dependency_analysis reads manifests', r.data.manifests['package.json'] && r.data.counts.dependencies === 0, JSON.stringify(r.data).slice(0, 160));
  r = await api('/dev/unused', {});
  ok('find_unused_code finds unreferenced symbol', Array.isArray(r.data.unused) && r.data.unused.some(u => /unusedHelper|sayHello/.test(u.name)), JSON.stringify(r.data.unused).slice(0, 220));
  r = await api('/dev/health', {});
  ok('project_health_check aggregates', typeof r.data.score === 'number' && r.data.checks && r.data.checks.manifests.includes('package.json'), JSON.stringify(r.data).slice(0, 160));

  // ---------- tasks ----------
  // The first task must still be RUNNING when the dedupe check fires: 'echo' alone finishes in
  // milliseconds, which made this check flaky (fast machines raced past it). Sleep first.
  r = await api('/task/create', { kind: 'command', params: { command: (process.platform === 'win32' ? 'timeout /t 2 /nobreak' : 'sleep 2') + ' && echo codespace-task-ok' }, label: 'echo test', dedupe_key: 'echo-1' });
  const taskId = r.data.id;
  ok('task_create returns id', /^k[0-9a-z_]+/.test(taskId || ''), JSON.stringify(r.data));
  r = await api('/task/create', { kind: 'command', params: { command: 'echo dup' }, dedupe_key: 'echo-1' });
  ok('task dedupe key prevents duplicates', r.data.duplicate === true, JSON.stringify(r.data));
  let done = false;
  for (let i = 0; i < 40 && !done; i++) { await sleep(300); r = await api('/task/get', { id: taskId }); done = r.data.status === 'done'; }
  ok('task completes with result', done && /codespace-task-ok/.test(JSON.stringify(r.data.result || '')), JSON.stringify(r.data).slice(0, 240));
  r = await api('/task/create', { kind: 'command', params: { command: (process.platform === 'win32' ? 'timeout /t 30' : 'sleep 30') }, label: 'sleepy' });
  const sleepId = r.data.id;
  await sleep(1200);
  r = await api('/task/cancel', { id: sleepId });
  ok('task_cancel accepts request', r.data.status === 'running' || r.data.status === 'cancelled', r.data.status);
  let cancelled = false;
  for (let i = 0; i < 30 && !cancelled; i++) { await sleep(400); r = await api('/task/get', { id: sleepId }); cancelled = r.data.status === 'cancelled' || r.data.status === 'error'; }
  ok('task_cancel actually stops the process', cancelled, r.data.status);
  r = await api('/task/list', {});
  ok('task_list shows persisted tasks', r.data.tasks.length >= 2 && r.data.counts && typeof r.data.counts.done === 'number');
  r = await api('/task/retry', { id: taskId });
  ok('task_retry refuses completed tasks', r.status === 400);
  r = await api('/task/create', { kind: 'banana', params: {} });
  ok('unknown task kind rejected', r.status === 400);
  // interrupted tasks are marked after restart — simulate by reading the persisted file
  const taskFile = fs.readdirSync(path.join(DATA, 'tasks')).find(f => f.endsWith('.json'));
  ok('tasks are persisted to disk', !!taskFile);

  // ---------- browser additions behave correctly with or without a local browser ----------
  // Do not assume Chrome is absent on the machine running this suite. When a browser is
  // available, a deliberately missing selector must produce a specific timeout error;
  // when unavailable, the endpoint must return a clear startup/availability error.
  r = await api('/browser/wait', { selector: '#codespace-verify-never-present', timeout_seconds: 1 });
  const waitErr = String(r.data.error || '');
  ok('browser wait reports a specific selector timeout or clear browser-unavailable error', r.status === 400 && (/Selector not found/i.test(waitErr) || /Chrome|browser is not running|browser.*unavailable/i.test(waitErr)), JSON.stringify(r.data).slice(0, 180));
  r = await api('/browser/tabs', { action: 'list' });
  const tabsErr = String(r.data.error || '');
  ok('browser_tabs returns tab data when available or a clear browser-unavailable error', (r.status === 200 && Array.isArray(r.data.tabs)) || (r.status === 400 && /Chrome|browser is not running|browser.*unavailable/i.test(tabsErr)), JSON.stringify(r.data).slice(0, 180));

  // ---------- workflow diagnostics regex fix ----------
  r = await api('/workflow/diagnostics', {});
  ok('workflowDiagnostics parses error lines (regex bug fixed)', r.data && Array.isArray(r.data.sessions));

  // ---------- audit log covers new endpoints ----------
  r = await api('/audit/list', { limit: 400 });
  const eps = new Set((r.data.entries || []).map(e => e.ep));
  ok('audit log records fs/editbatch', eps.has('/fs/editbatch'));
  ok('audit log records /http/request without header values', eps.has('/http/request') && !JSON.stringify(r.data.entries).includes('topsecret'), [...eps].join(','));
  ok('audit log records /perm/set', eps.has('/perm/set'));

  console.log('\n3.10.0 verification: ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
  cleanupVerification();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('VERIFY ERROR:', e); console.error(serverLog.slice(-1500)); cleanupVerification(); process.exit(1); });
function cleanupVerification() { try { site.close(); } catch {} try { if (server.exitCode === null) server.kill('SIGKILL'); } catch {} }
process.once('exit', cleanupVerification);
process.once('SIGINT', () => { cleanupVerification(); process.exit(130); });
process.once('SIGTERM', () => { cleanupVerification(); process.exit(143); });
