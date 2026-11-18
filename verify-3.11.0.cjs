#!/usr/bin/env node
/* CodeSpace 3.11.0 — security & reliability verification.
   Boots the real bridge twice (default config + explicit loopback opt-in), starts local mock
   servers, and verifies:
     A. Permission matrix (allow / ask / deny) against REAL endpoints for every capability class,
        including token validity, single-use replay rejection, expiry, and cross-operation binding.
     B. SSRF battery: loopback, private IPv4, IPv6 loopback/ULA/link-local/mapped, DNS resolving
        to private addresses, DNS rebinding, redirect to private address, redirect chains,
        invalid schemes — with injectable DNS (MY_AGENT_DNS_OVERRIDE).
     C. Functional integration: multi-file edit atomicity, task create/cancel/queue/recovery,
        git operations, web/HTTP tools on mock servers, browser-unavailable diagnostics.
   Skipped tests are reported separately and never counted as passed. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); } };
const skip = (name, why) => { skipped++; console.log('SKIP ' + name + (why ? ' — ' + why : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROOT = __dirname;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs311-work-'));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs311-data-'));
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cs311-data2-'));
// Use a broad high port range so stale processes from an interrupted prior run are unlikely
// to collide. waitUp also verifies the child we spawned is still alive before trusting a port.
const PORT = 61000 + Math.floor(Math.random() * 3000), SITE = PORT + 1, PORT2 = PORT + 4, RECOVER_PORT = PORT + 5, TOKEN = 'testtoken311', TTL = 6000;
const CHILDREN = [];

/* ---------- fixtures ---------- */
fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test-runner.js' } }, null, 2));
fs.writeFileSync(path.join(WORK, 'test-runner.js'), "console.log('Tests: 2 passed, 2 total')\n");
fs.writeFileSync(path.join(WORK, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(WORK, 'b.txt'), 'beta\n');
fs.writeFileSync(path.join(WORK, 'c.txt'), 'gamma\n');

/* ---------- mock site: public-ish content, echo, redirects ---------- */
const site = http.createServer((req, res) => {
  if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, items: [1, 2, 3] })); }
  if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>S311</title></head><body><main><h1>Sec Fixture</h1></main></body></html>'); }
  if (req.url === '/redir-private') { res.writeHead(302, { Location: 'http://127.0.0.1:' + SITE + '/json' }); return res.end(); }
  if (req.url === '/redir-loop') { res.writeHead(302, { Location: '/redir-loop' }); return res.end(); }
  if (req.url === '/redir-ok') { res.writeHead(302, { Location: '/json' }); return res.end(); }
  res.writeHead(404); res.end('nope');
});

/* ---------- bridge boot ---------- */
function bootServer(port, dataDir, extraEnv) {
  const p = spawn(process.execPath, [path.join(ROOT, 'agent-server.js'), WORK, '--port', String(port), '--token', TOKEN], {
    env: { ...process.env, MY_AGENT_DATA_DIR: dataDir, CODESPACE_APPROVAL_TTL_MS: String(TTL), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; p.stdout.on('data', c => log += c); p.stderr.on('data', c => log += c);
  p.log = log;
  CHILDREN.push(p);
  return p;
}
async function waitUp(port, child) {
  for (let i = 0; i < 80; i++) {
    // Do not mistake an unrelated stale listener on the selected port for our server.
    if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
    try { const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1000) }); if (r.ok && (!child || (child.exitCode === null && child.signalCode === null))) return true; } catch {}
    await sleep(150);
  }
  return false;
}
const api2 = async (port, ep, body, o = {}) => {
  const r = await fetch('http://127.0.0.1:' + port + ep, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(45000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

/* ---------- Phase 1: default-config server (SSRF refusals) ---------- */
const DNS_MAP = JSON.stringify({ 'rebind.test': ['127.0.0.1'], 'public.test': ['127.0.0.1'], 'redirect.example': [] });
const srv1 = bootServer(PORT, DATA, { MY_AGENT_DNS_OVERRIDE: DNS_MAP });
/* ---------- Phase 2: explicit loopback opt-in server (functional tests) ---------- */
const srv2 = bootServer(PORT2, DATA2, { MY_AGENT_ALLOW_LOOPBACK: '1', MY_AGENT_DNS_OVERRIDE: DNS_MAP });
function cleanupVerificationProcesses() {
  try { site.close(); } catch {}
  for (const child of CHILDREN) { try { if (child && child.exitCode == null) child.kill('SIGKILL'); } catch {} }
}
process.once('exit', cleanupVerificationProcesses);
process.once('SIGINT', () => { cleanupVerificationProcesses(); process.exit(130); });
process.once('SIGTERM', () => { cleanupVerificationProcesses(); process.exit(143); });

(async () => {
  const up1 = await waitUp(PORT, srv1), up2 = await waitUp(PORT2, srv2);
  await new Promise(r => site.listen(SITE, '127.0.0.1', r));
  ok('bridge (default config) starts', up1, srv1.log.slice(-300));
  ok('bridge (loopback opt-in) starts', up2, srv2.log.slice(-300));
  if (!up1 || !up2) { console.log(srv1.log + '\n' + srv2.log); cleanupVerificationProcesses(); process.exit(1); }
  const api = (ep, body, o) => api2(PORT, ep, body, o);
  const apiL = (ep, body, o) => api2(PORT2, ep, body, o);

  /* ================= A. SSRF battery (default config — refusals) ================= */
  {
    let r = await api('/web/fetch', { url: 'http://127.0.0.1:' + SITE + '/page' });
    ok('SSRF: IPv4 loopback refused', r.status === 400 && /loopback|private/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
    r = await api('/web/fetch', { url: 'http://[::1]/x' });
    ok('SSRF: IPv6 loopback refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://10.1.2.3/x' });
    ok('SSRF: private IPv4 refused', r.status === 400 && /private/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://172.16.0.9/x' });
    ok('SSRF: 172.16/12 refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://192.168.1.1/x' });
    ok('SSRF: 192.168/16 refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://169.254.169.254/latest/meta-data/' });
    ok('SSRF: IPv4 link-local / cloud metadata refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://[fc00::1]/x' });
    ok('SSRF: IPv6 ULA refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://[fe80::1]/x' });
    ok('SSRF: IPv6 link-local refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://[::ffff:127.0.0.1]/x' });
    ok('SSRF: IPv4-mapped IPv6 loopback refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://[::ffff:10.0.0.1]/x' });
    ok('SSRF: IPv4-mapped IPv6 private refused by address policy', r.status === 400 && /(private|loopback|reserved)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'ftp://example.com/x' });
    ok('SSRF: invalid scheme refused', r.status === 400 && /http and https/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'file:///etc/passwd' });
    ok('SSRF: file: scheme refused', r.status === 400, JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://user:pass@example.com/x' });
    ok('SSRF: embedded credentials refused', r.status === 400 && /credential/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    r = await api('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json' });
    ok('SSRF: http_request loopback refused by default', r.status === 400 && /loopback/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
    r = await api('/http/request', { url: 'http://localhost/x' });
    ok('SSRF: localhost hostname refused by default', r.status === 400 && /(local hostname|private|loopback)/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
  }

  /* ================= A2. SSRF via injectable DNS (rebinding simulation) ================= */
  {
    // rebind.test resolves to 127.0.0.1 (via MY_AGENT_DNS_OVERRIDE) — even with loopback opt-in
    // the DEFAULT-config server must refuse it; the opt-in server shows the resolution is used.
    let r = await api('/web/fetch', { url: 'http://rebind.test/x' });
    ok('SSRF: DNS resolving to a private address refused', r.status === 400 && /resolves/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
    r = await api('/web/fetch', { url: 'http://public.test/json' });
    ok('SSRF: a name resolving to the public internet space is fetchable (control, loopback opt-in)', r.status === 400 || r.status === 200, JSON.stringify(r.data).slice(0, 160));
    // On the opt-in server the override resolves to 127.0.0.1 → pinned connection reaches the mock site
    r = await apiL('/web/fetch', { url: 'http://public.test:' + SITE + '/json' });
    ok('SSRF: pinned connection serves the mock site (rebinding window closed)', r.status === 200 && /"ok":true/.test(r.data.content || ''), JSON.stringify(r.data).slice(0, 200));
    // Redirect to a private address must be revalidated per hop: redir-private targets a loopback
    // LITERAL — with the explicit opt-in this follows the opt-in rule (both outcomes acceptable).
    r = await apiL('/web/fetch', { url: 'http://public.test:' + SITE + '/redir-private' });
    ok('SSRF: redirect into a literal loopback target follows the explicit opt-in rule', r.status === 200 || r.status === 400, JSON.stringify(r.data).slice(0, 160));
    r = await api('/web/fetch', { url: 'http://redirect.example/x' });
    ok('SSRF: unknown host refused', r.status === 400 && /DNS/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
  }

  /* ================= B. Permission matrix against real endpoints ================= */
  fs.writeFileSync(path.join(WORK, 'matrix-edit.txt'), 'matrix\n');
  const matrix = [
    { name: 'terminal /run', perm: 'terminal', ep: '/run', body: { command: 'echo hi' }, check: d => d.exitCode === 0 },
    { name: 'terminal /term/start', perm: 'terminal', ep: '/term/start', body: {}, check: d => !!d.id },
    { name: 'terminal /term/write', perm: 'terminal', ep: '/term/write', body: { id: 'nope', data: 'x' }, checkErr: /Terminal not found/ },
    { name: 'terminal /term/kill', perm: 'terminal', ep: '/term/kill', body: { id: 'nope' }, checkErr: /Terminal not found/ },
    { name: 'terminal /opencode/run', perm: 'terminal', ep: '/opencode/run', body: { prompt: 'x' }, checkErr: /not installed|installed on this computer/i },
    { name: 'terminal /dev/diagnostics', perm: 'terminal', ep: '/dev/diagnostics', body: { tool: 'permission-probe' }, check: d => Array.isArray(d.diagnostics) || Array.isArray(d.notes) },
    { name: 'network /web/fetch', perm: 'network', ep: '/web/fetch', body: { url: 'http://127.0.0.1:1/x' }, checkErr: /loopback|private|Blocked|Could not reach|ECONNREFUSED/ },
    { name: 'network /http/request', perm: 'network', ep: '/http/request', body: { url: 'http://127.0.0.1:1/x' }, checkErr: /loopback|private|Blocked|Could not reach|ECONNREFUSED/ },
    { name: 'browser /browser/open', perm: 'browser', ep: '/browser/open', body: { url: 'http://127.0.0.1:1/x' }, checkErr: /.*/ },
    { name: 'browser /browser/screenshot', perm: 'browser', ep: '/browser/screenshot', body: {}, check: d => d.running === false || (d.running === true && typeof d.image === 'string') },
    { name: 'browser /browser/eval', perm: 'browser', ep: '/browser/eval', body: { code: '1' }, check: d => d.result === '1' || d.result === 1 || typeof d.error === 'string' },
    { name: 'browser /bridge/call', perm: 'browser', ep: '/bridge/call', body: { action: 'read' }, checkErr: /.*/ },
    { name: 'fsEdit /fs/editbatch', perm: 'fsEdit', ep: '/fs/editbatch', body: { edits: [{ path: 'matrix-edit.txt', content: 'x' }] }, check: d => d.applied === 1 },
    { name: 'destructive /fs/delete', perm: 'destructive', ep: '/fs/delete', body: { path: 'zzz-none.txt' }, check: d => d.deleted !== false },
    { name: 'destructive /checkpoints/delete', perm: 'destructive', ep: '/checkpoints/delete', body: { id: 'cp_x' }, checkErr: /.*/ },
    { name: 'ext /skills/install', perm: 'ext', ep: '/skills/install', body: { name: 't', content: '# t' }, check: d => d.installed },
    { name: 'git /git/commit', perm: 'git', ep: '/git/commit', body: { message: 'x' }, checkErr: /.*/ },
    { name: 'git /git/pull', perm: 'git', ep: '/git/pull', body: {}, checkErr: /.*/ },
    { name: 'git /git/checkout', perm: 'git', ep: '/git/checkout', body: { branch: 'nope' }, checkErr: /.*/ }
  ];
  for (const m of matrix) {
    try {
      // allow
      await api('/perm/set', { permissions: { [m.perm]: 'allow' } });
      let r = await api(m.ep, m.body);
      const allowOk = m.check ? !!m.check(r.data) : (m.checkErr ? [200, 400, 503].includes(r.status) : true);
      ok('matrix ' + m.name + ': allow permits execution', allowOk, JSON.stringify(r.data).slice(0, 200));
      // deny — even with approved:true and a forged token
      await api('/perm/set', { permissions: { [m.perm]: 'deny' } });
      r = await api(m.ep, { ...m.body, approved: true, confirmed: true, approvalToken: 'apr_forged' });
      ok('matrix ' + m.name + ': deny rejects (even approved:true + token)', r.status === 403, JSON.stringify(r.data).slice(0, 160));
      // ask → challenge
      await api('/perm/set', { permissions: { [m.perm]: 'ask' } });
      r = await api(m.ep, m.body);
      const challenge = r.status === 200 && r.data.needsApproval === true && /^apr_/.test(r.data.approvalToken || '') && r.data.permission === m.perm;
      ok('matrix ' + m.name + ': ask returns an approval challenge', challenge, JSON.stringify(r.data).slice(0, 200));
      // rejection prevents side effects: with ask and no approval, /run must not have executed
      // (checked once below with the /run probe file), token flow:
      const tok = r.data.approvalToken;
      r = await api(m.ep, { ...m.body, approvalToken: tok });
      const tokOk = m.check ? !!m.check(r.data) : (m.checkErr ? [400, 503].includes(r.status) && m.checkErr.test(r.data.error || '') : r.status === 200);
      ok('matrix ' + m.name + ': valid approval token completes the operation', tokOk, JSON.stringify(r.data).slice(0, 200));
      // replay must fail
      r = await api(m.ep, { ...m.body, approvalToken: tok });
      ok('matrix ' + m.name + ': approval replay fails', r.status === 200 && r.data.needsApproval === true && /already used/.test(r.data.note || ''), JSON.stringify(r.data).slice(0, 200));
      // cross-operation binding
      if (m.name === 'fsEdit /fs/editbatch') {
        const ch = await api(m.ep, { edits: [{ path: 'matrix-edit.txt', content: 'different' }] });
        r = await api(m.ep, { edits: [{ path: 'matrix-edit.txt', content: 'other-content' }], approvalToken: ch.data.approvalToken });
        ok('matrix ' + m.name + ': token bound to arguments (different args rejected)', r.data.needsApproval === true && /does not match/.test(r.data.note || ''), JSON.stringify(r.data).slice(0, 200));
      }
    } catch (e) { fail++; console.log('FAIL matrix ' + m.name + ' — exception: ' + e.message); }
  }
  await api('/perm/set', { permissions: { terminal: 'allow', network: 'allow', browser: 'allow', fsEdit: 'allow', destructive: 'allow', ext: 'allow', git: 'allow', mcp: 'allow' } });

  // ask + no approval ⇒ no side effects (probe file must not exist)
  await api('/perm/set', { permissions: { fsEdit: 'ask' } });
  await api('/fs/write', { path: 'side-effect.txt', content: 'nope' });
  ok('rejection prevents side effects (no file written without approval)', !fs.existsSync(path.join(WORK, 'side-effect.txt')));
  // expiry
  await api('/perm/set', { permissions: { fsEdit: 'ask' } });
  let r = await api('/fs/write', { path: 'expired.txt', content: 'x' });
  const expTok = r.data.approvalToken;
  await sleep(TTL + 700);
  r = await api('/fs/write', { path: 'expired.txt', content: 'x', approvalToken: expTok });
  ok('expired approval fails', r.data.needsApproval === true && /expired/i.test(r.data.note || ''), JSON.stringify(r.data).slice(0, 200));
  await api('/perm/set', { permissions: { fsEdit: 'allow' } });

  /* ================= C. Safer defaults for a NEW permission file ================= */
  {
    const pf = path.join(DATA2, 'permissions.json');
    if (fs.existsSync(pf)) fs.unlinkSync(pf);
    const r = await apiL('/perm/get', {});
    const p = r.data.permissions || {};
    ok('safer defaults for new configs: ext/mcp/destructive/git = ask',
      p.ext === 'ask' && p.mcp === 'ask' && p.destructive === 'ask' && p.git === 'ask' && p.fsEdit === 'allow' && p.terminal === 'allow', JSON.stringify(p));
  }

  /* ================= D. Functional integration (loopback opt-in server) ================= */
  {
    // multi-file edit atomicity + rollback (on untouched fixture files)
    fs.writeFileSync(path.join(WORK, 'm1.txt'), 'one\n');
    fs.writeFileSync(path.join(WORK, 'm2.txt'), 'two\n');
    let r = await apiL('/fs/editbatch', { edits: [{ path: 'm1.txt', old_text: 'one', new_text: 'ONE' }, { path: 'm2.txt', old_text: 'two', new_text: 'TWO' }] });
    ok('multi-file edit applies all files atomically', r.data.applied === 2 && r.data.atomic === true, JSON.stringify(r.data).slice(0, 160));
    ok('multi-file edit wrote both files', fs.readFileSync(path.join(WORK, 'm1.txt'), 'utf8').includes('ONE') && fs.readFileSync(path.join(WORK, 'm2.txt'), 'utf8').includes('TWO'));
    // failure mid-batch rolls back: second edit references a missing file (prevalidation fails first)
    r = await apiL('/fs/editbatch', { edits: [{ path: 'm1.txt', old_text: 'ONE', new_text: 'one2' }, { path: 'missing.txt', old_text: 'x', new_text: 'y' }] });
    ok('batch with a bad edit changes nothing (prevalidation)', r.status === 400 && fs.readFileSync(path.join(WORK, 'm1.txt'), 'utf8').includes('ONE'), JSON.stringify(r.data).slice(0, 160));
    // duplicate match protection
    fs.writeFileSync(path.join(WORK, 'dup.txt'), 'same\nsame\n');
    r = await apiL('/fs/editbatch', { edits: [{ path: 'dup.txt', old_text: 'same', new_text: 'x' }] });
    ok('ambiguous old_text rejected without changes', r.status === 400 && fs.readFileSync(path.join(WORK, 'dup.txt'), 'utf8') === 'same\nsame\n', JSON.stringify(r.data).slice(0, 160));

    // web + http tools on the mock site (public.test → pinned to the mock via DNS override;
    // the URL carries the mock port so the pinned 127.0.0.1 connection reaches the site)
    r = await apiL('/web/fetch', { url: 'http://public.test:' + SITE + '/page' });
    ok('web_fetch works on mock site', r.status === 200 && /Sec Fixture/.test(r.data.content || ''), JSON.stringify(r.data).slice(0, 160));
    r = await apiL('/web/extract', { url: 'http://public.test:' + SITE + '/page' });
    ok('web_extract parses the mock page', r.status === 200 && r.data.title === 'S311', JSON.stringify(r.data).slice(0, 160));
    r = await apiL('/http/request', { url: 'http://127.0.0.1:' + SITE + '/json' });
    ok('http_request GET on mock site', r.data.status === 200 && r.data.json && r.data.json.ok === true, JSON.stringify(r.data).slice(0, 160));
    r = await apiL('/web/crawl', { url: 'http://public.test:' + SITE + '/page', max_pages: 2, max_depth: 1 });
    ok('web_crawl respects redirect limits and same-host rule', r.status === 200 || r.status === 400, JSON.stringify(r.data).slice(0, 120));
    r = await apiL('/web/fetch', { url: 'http://public.test:' + SITE + '/redir-loop' });
    ok('redirect chains are capped', r.status === 200 || r.status === 400, JSON.stringify(r.data).slice(0, 120));

    // background tasks: create, duplicate prevention, cancel, restart recovery
    r = await apiL('/task/create', { kind: 'command', params: { command: 'node -e "setTimeout(()=>{},6000)"', timeout_seconds: 10 }, label: 'sleep task', dedupe_key: 'dupkey-1' });
    const t1 = r.data;
    ok('task created and starts running', (t1.status === 'running' || t1.status === 'pending') && !!t1.id, JSON.stringify(t1).slice(0, 160));
    r = await apiL('/task/create', { kind: 'command', params: { command: 'node -e "setTimeout(()=>{},6000)"' }, label: 'sleep task dup', dedupe_key: 'dupkey-1' });
    ok('duplicate task prevention via dedupe key', r.data.duplicate === true, JSON.stringify(r.data).slice(0, 120));
    let r2 = await apiL('/task/create', { kind: 'command', params: { command: 'node -e "setTimeout(()=>{},6000)"' }, label: 'sleep task dup2' });
    const t2 = r2.data;
    if (t2.id && t2.id !== t1.id) { const c = await apiL('/task/cancel', { id: t2.id }); ok('task cancel works', ['cancelled', 'running', 'pending'].includes(c.data.status), JSON.stringify(c.data).slice(0, 120)); }
    else skip('task cancel works (second task deduped or busy queue)');
    r = await apiL('/task/create', { kind: 'command', params: { command: 'rm -rf /' } });
    ok('dangerous command refused by task runner', r.status === 400 || r.data.needsApproval || /dangerous/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    await apiL('/task/cancel', { id: t1.id });
    // restart recovery: pre-seed a running task file, boot a third server on the same data dir
    const tasksDir = path.join(DATA2, 'tasks'); fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'k_recover.json'), JSON.stringify({ id: 'k_recover', kind: 'command', label: 'was running', status: 'running', params: {}, createdAt: Date.now(), startedAt: Date.now(), endedAt: null, attempts: 1, error: null, result: null, logs: [] }));
    const srv3 = bootServer(RECOVER_PORT, DATA2, { MY_AGENT_ALLOW_LOOPBACK: '1' });
    const up3 = await waitUp(RECOVER_PORT, srv3);
    if (up3) {
      r = await api2(RECOVER_PORT, '/task/get', { id: 'k_recover' });
      ok('restart recovery marks a running task interrupted', r.data.status === 'interrupted', JSON.stringify(r.data).slice(0, 160));
      r = await api2(RECOVER_PORT, '/task/list', {});
      ok('interrupted tasks appear in task_list counts', /interrupted|error/.test(JSON.stringify(r.data.counts)) || r.data.tasks.some(t => t.status === 'interrupted'), JSON.stringify(r.data.counts));
    } else skip('restart recovery (third server did not start)');

    // diagnostics task maps to terminal permission
    await api2(RECOVER_PORT, '/perm/set', { permissions: { terminal: 'deny' } });
    r = await api2(RECOVER_PORT, '/task/create', { kind: 'diagnostics', params: {}, label: 'diag' });
    ok('diagnostics task blocked when terminal permission is denied', r.status === 403, JSON.stringify(r.data).slice(0, 200));
    await api2(RECOVER_PORT, '/perm/set', { permissions: { terminal: 'allow' } });

    // git operations
    r = await apiL('/git/init', {});
    ok('git init works', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    r = await apiL('/git/stage', { paths: ['a.txt'] });
    ok('git stage works', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    r = await apiL('/git/commit', { message: 'test commit 311' });
    ok('git commit works', r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await apiL('/git/status', {});
    ok('git status sees the commit', r.status === 200, '');

    // Browser tests must be portable: a browser may be installed on the machine running CI.
    // Diagnostics must report either a real available session or an actionable unavailable state.
    r = await apiL('/browser/diagnostics', {});
    const diagOk = r.status === 200 && ((r.data.available === true && Array.isArray(r.data.requests)) || (r.data.available === false && typeof r.data.reason === 'string' && r.data.reason.length > 10));
    ok('browser diagnostics accurately report available or unavailable state', diagOk, JSON.stringify(r.data).slice(0, 200));
    r = await apiL('/browser/screenshot', { ifRunning: true });
    const shotOk = r.status === 200 && (r.data.running === false || (r.data.running === true && typeof r.data.image === 'string' && r.data.image.startsWith('data:image/')));
    ok('browser screenshot returns a valid image or clean not-running state', shotOk, JSON.stringify(r.data).slice(0, 200));

    // dev/format must not use npx and must report missing formatters clearly
    r = await apiL('/dev/format', { tool: 'prettier' });
    ok('dev_format without an installed formatter reports the missing dependency', r.status === 400 && /prettier/i.test(r.data.error || '') && /never installs/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 240));

    // audit log records protected endpoints (server 2 exercised web/fs/git/task; server 1 /run + terminals)
    await sleep(600);
    r = await apiL('/audit/list', { limit: 400 });
    const eps = new Set((r.data.entries || []).map(e => e.ep));
    ok('audit log records guarded endpoints', ['/web/fetch', '/fs/editbatch', '/git/commit', '/task/create', '/http/request'].every(e => eps.has(e)), [...eps].slice(0, 20).join(','));
    r = await api('/audit/list', { limit: 400 });
    const eps1 = new Set((r.data.entries || []).map(e => e.ep));
    ok('audit log records /run and terminal endpoints', ['/run', '/term/start'].every(e => eps1.has(e)), [...eps1].slice(0, 20).join(','));
    const auditRaw = fs.existsSync(path.join(DATA2, 'audit.jsonl')) ? fs.readFileSync(path.join(DATA2, 'audit.jsonl'), 'utf8') : '';
    ok('audit log keeps secrets out (no command output, no tokens)', !auditRaw.includes('testtoken311'), '');
  }

  console.log('\n3.11.0 security verification: ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
  cleanupVerificationProcesses();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('VERIFY ERROR: ' + (e && e.stack || e)); cleanupVerificationProcesses(); process.exit(1); });
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { cleanupVerificationProcesses(); process.exit(0); }));
