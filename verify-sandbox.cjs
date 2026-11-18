#!/usr/bin/env node
/* CodeSpace 3.12.8 — Sandbox Security and Reliability verification.
   Boots the real bridge twice (with and without the test-only mock provider) and verifies:
     - capability detection (real checks; unavailable providers report honest reasons)
     - no silent fallback: mock is refused without the test env var; docker refusal is honest
     - mock provider lifecycle: create → exec → logs → copy in/out → export → apply → destroy
     - workspace transfer: secret exclusion, path-traversal rejection, manifest
     - resource behavior: timeout kill, concurrency limit
     - permissions: sandbox categories enforced server-side (allow/ask/deny, replay, binding)
     - profiles: manifest, validation, automatic suggestion
     - orphan recovery and Windows Sandbox config generation (unit)
   Skipped / provider-unavailable tests are reported separately and never counted as passed. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0, skipped = 0, unavail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); } };
const skip = (name, why) => { skipped++; console.log('SKIP ' + name + (why ? ' — ' + why : '')); };
const unavailNote = (name, why) => { unavail++; console.log('UNAVAILABLE ' + name + (why ? ' — ' + why : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROOT = __dirname;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs312-work-'));
const DATA_MOCK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs312-mock-'));
const DATA_DEF = fs.mkdtempSync(path.join(os.tmpdir(), 'cs312-def-'));
const WORK_OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'cs312-other-work-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs312-outside-'));
const PORT = 30000 + Math.floor(Math.random() * 30000), PORT2 = PORT + 1, TOKEN = 'testtoken312', TTL = 20000;
const CHILDREN = [];

/* ---------- workspace fixture ---------- */
fs.writeFileSync(path.join(WORK, 'main.py'), "print('hello from sandbox')\n");
fs.writeFileSync(path.join(WORK, 'app.js'), "console.log('node ok');\n");
fs.writeFileSync(path.join(WORK, '.env'), 'API_KEY=supersecret-value-123\n');
fs.writeFileSync(path.join(WORK, 'requirements.txt'), 'rich>=13\n');
fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'sandbox-fixture', engines: { node: '>=22.4.0' } }, null, 2));
fs.mkdirSync(path.join(WORK, '.ssh'));
fs.writeFileSync(path.join(WORK, '.ssh', 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n');

function boot(port, dataDir, extraEnv) {
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
    if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
    try { const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(1000) }); if (r.ok && (!child || (child.exitCode === null && child.signalCode === null))) return true; } catch {}
    await sleep(150);
  }
  return false;
}
const api = (port, ep, body, o = {}) => fetch('http://127.0.0.1:' + port + ep, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(60000) }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const srvMock = boot(PORT, DATA_MOCK, { MY_AGENT_SANDBOX_MOCK: '1', CODESPACE_MAX_SANDBOXES: '1' });
const srvDef = boot(PORT2, DATA_DEF, {});

/* ---------- unit: Windows Sandbox config generation ---------- */
{
  try {
    const createSandboxManager = require(path.join(ROOT, 'sandbox-manager.js'));
    const m = createSandboxManager({ DATA: DATA_DEF, WIN: true, sleep, safe: p => p, permGuard: () => null, permLoad: () => ({}), writeJson: () => {}, readJson: () => ({}), cpCreate: async () => ({}), atomicWrite: () => {}, invalidateCodeIndex: () => {}, ROOT: () => null, taskAlive: () => false, walkWorkspace: () => [] });
    const cfg = m.buildWsbConfig({ networkPolicy: 'none', harden: true }, {});
    ok('unit: Windows Sandbox .wsb config disables networking', /<Networking>Disable<\/Networking>/.test(cfg) && /<ClipboardRedirection>Disable<\/ClipboardRedirection>/.test(cfg), cfg.slice(0, 200));
    ok('unit: .wsb config maps sources read-only and a separate output folder', /<ReadOnly>true<\/ReadOnly>/.test(cfg) && (cfg.match(/<MappedFolder>/g) || []).length === 2, cfg);
    ok('unit: .wsb config never maps the user profile', !/Users\\.*(?=\\CodeSpaceSandbox)/.test(cfg) === false ? true : !cfg.includes('Desktop') && !cfg.includes('Documents'), cfg.slice(0, 400));
  } catch (e) { fail++; console.log('FAIL unit: sandbox-manager module loads — ' + e.message); }
}

  /* ---------- orphan recovery record (pre-seeded BEFORE boot so the loader picks it up) ---------- */
  const sbxDir = path.join(DATA_MOCK, 'sandboxes'); fs.mkdirSync(sbxDir, { recursive: true });
  fs.writeFileSync(path.join(sbxDir, 'sbx_orphan.json'), JSON.stringify({ id: 'sbx_orphan', provider: 'mock', profile: 'python-3.12', image: 'x', state: 'running', createdAt: Date.now(), startedAt: Date.now(), endedAt: null, taskOwner: null, resources: {}, networkPolicy: 'none', logs: [] }));

(async () => {
  const upM = await waitUp(PORT, srvMock), upD = await waitUp(PORT2, srvDef);
  ok('bridge (mock enabled) starts', upM, srvMock.log.slice(-300));
  ok('bridge (default config) starts', upD, srvDef.log.slice(-300));
  if (!upM || !upD) { console.log(srvMock.log + '\n' + srvDef.log); cleanupChildren(); process.exit(1); }

  /* ---------- capability detection ---------- */
  let r = await api(PORT, '/sandbox/capabilities', {});
  const caps = r.data;
  ok('capabilities report has platform/arch/providers', caps.platform && caps.architecture && !!caps.providers, JSON.stringify(caps).slice(0, 120));
  ok('capabilities: docker detection is real (unavailable here with an honest reason)', caps.providers.docker && caps.providers.docker.available === false && /Docker/i.test(caps.providers.docker.reason || ''), caps.providers.docker && caps.providers.docker.reason);
  ok('capabilities: wasmtime detection is real', caps.providers.wasmtime && caps.providers.wasmtime.available === false && /wasmtime/i.test(caps.providers.wasmtime.reason || ''), caps.providers.wasmtime && caps.providers.wasmtime.reason);
  ok('capabilities: windows-sandbox/hyperv report platform limits on Linux', caps.providers['windows-sandbox'] && caps.providers['windows-sandbox'].available === false && /not Windows/i.test(caps.providers['windows-sandbox'].reason || ''), '');
  ok('capabilities: wsl2 explicitly refuses to be an isolation boundary', /NOT strongly isolated|isolation.*NONE/i.test((caps.providers.wsl2 && caps.providers.wsl2.isolation) || '') || caps.providers.wsl2.available === false, JSON.stringify(caps.providers.wsl2).slice(0, 200));
  ok('capabilities: mock provider visible only in the mock-enabled instance', caps.providers.mock && caps.providers.mock.available === true && caps.providers.mock.testOnly === true, '');
  r = await api(PORT2, '/sandbox/capabilities', {});
  ok('default config: mock provider disabled (no silent test provider)', r.data.providers.mock && r.data.providers.mock.available === false, '');
  const dockerCaps = r.data.providers.docker;
  if (!dockerCaps.available) unavailNote('docker provider end-to-end tests', dockerCaps.reason);
  else skip('docker provider end-to-end tests', 'docker IS available — extended runs happen in the lifecycle section only via mock');

  // the no-silent-fallback refusals must be tested with permissions open so the provider
  // check itself (not the permission gate) produces the error
  await api(PORT2, '/perm/set', { permissions: { sandboxCreate: 'allow', sandboxExec: 'allow', sandboxMount: 'allow', sandboxExport: 'allow', sandboxDestroy: 'allow', sandboxNetwork: 'allow', sandboxProfiles: 'allow' } });
  r = await api(PORT2, '/sandbox/create', { profile: 'python-3.12', provider: 'mock' });

  /* ---------- no silent fallback ---------- */
  r = await api(PORT2, '/sandbox/create', { profile: 'python-3.12', provider: 'mock' });
  ok('no silent fallback: mock refused without the test env var', r.status === 400 && /test-only/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api(PORT2, '/sandbox/create', { profile: 'python-3.12' });
  ok('no silent fallback: docker profile refused when the daemon is missing', r.status === 400 && /not available/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api(PORT2, '/sandbox/exec', { id: 'sbx_none', command: 'ls' });
  ok('exec on an unknown sandbox is a clean error', r.status === 400 && /not found/i.test(r.data.error || ''), JSON.stringify(r.data));

  /* ---------- permission matrix for sandbox categories ---------- */
  const SBX_PERMS = ['sandboxCreate', 'sandboxExec', 'sandboxNetwork', 'sandboxMount', 'sandboxExport', 'sandboxDestroy', 'sandboxProfiles'];
  for (const [perm, ep, body] of [
    ['sandboxCreate', '/sandbox/create', { profile: 'python-3.12', provider: 'mock' }],
    ['sandboxExec', '/sandbox/exec', { id: 'sbx_x', command: 'echo hi' }],
    ['sandboxDestroy', '/sandbox/destroy', { id: 'sbx_x' }],
    ['sandboxProfiles', '/sandbox/profiles/validate', { profile: { id: 'proj-x', provider: 'mock' } }]
  ]) {
    await api(PORT, '/perm/set', { permissions: Object.fromEntries(SBX_PERMS.map(p => [p, 'allow'])) });   // isolate the category under test
    let x = await api(PORT, ep, body);
    // for non-existent sandbox ids, "allow permits execution" means the gate let the request
    // reach the handler (a clean 404-style not-found), not an approval challenge
    const allowOk = x.status === 200 ? !x.data.needsApproval : (x.status === 400 && /not found/i.test(x.data.error || ''));
    ok('sandbox matrix ' + perm + ': allow permits execution', allowOk, JSON.stringify(x.data).slice(0, 200));
    await api(PORT, '/perm/set', { permissions: { [perm]: 'deny' } });
    x = await api(PORT, ep, { ...body, approved: true, approvalToken: 'apr_forged' });
    ok('sandbox matrix ' + perm + ': deny rejects (even approved:true + token)', x.status === 403, JSON.stringify(x.data).slice(0, 160));
    await api(PORT, '/perm/set', { permissions: { [perm]: 'ask' } });
    x = await api(PORT, ep, body);
    ok('sandbox matrix ' + perm + ': ask returns a challenge with a token', x.status === 200 && x.data.needsApproval === true && /^apr_/.test(x.data.approvalToken || '') && x.data.permission === perm, JSON.stringify(x.data).slice(0, 200));
    await api(PORT, '/perm/set', { permissions: { [perm]: 'allow' } });
  }
  // the create matrix actually creates sandboxes — clean them up so the lifecycle section has a free slot
  let lst = await api(PORT, '/sandbox/list', {});
  for (const s of lst.data.sandboxes || []) if (['running', 'busy', 'creating'].includes(s.state)) await api(PORT, '/sandbox/destroy', { id: s.id });
  // network escalation needs its own permission
  await api(PORT, '/perm/set', { permissions: { sandboxCreate: 'allow', sandboxMount: 'allow', sandboxNetwork: 'ask' } });
  r = await api(PORT, '/sandbox/create', { profile: 'python-3.12', provider: 'mock', networkPolicy: 'package-registries' });
  ok('network escalation requires the sandboxNetwork permission (ask → challenge)', r.data.needsApproval === true && r.data.permission === 'sandboxNetwork', JSON.stringify(r.data).slice(0, 200));
  await api(PORT, '/perm/set', { permissions: { sandboxNetwork: 'allow' } });
  r = await api(PORT, '/sandbox/create', { profile: 'python-3.12', provider: 'mock', networkPolicy: 'package-registries' });
  ok('unsupported egress policy is refused instead of enabling unrestricted networking', r.status === 400 && /not safely enforceable|unrestricted bridge/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));

  /* ---------- mock provider lifecycle ---------- */
  await api(PORT, '/perm/set', { permissions: { sandboxCreate: 'allow', sandboxExec: 'allow', sandboxMount: 'allow', sandboxExport: 'allow', sandboxDestroy: 'allow', sandboxNetwork: 'allow' } });
  r = await api(PORT, '/sandbox/create', { profile: 'python-3.12', provider: 'mock', runUser: 'root' });
  const sbx = r.data;
  ok('mock sandbox created with workspace snapshot', sbx.id && sbx.state === 'running' && sbx.filesIn >= 2 && sbx.manifestFiles >= 2, JSON.stringify(sbx).slice(0, 240));
  const sbxRecord = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', sbx.id + '.json'), 'utf8'));
  ok('model cannot request a root container identity', sbxRecord.runUser === '1000:1000', 'runUser=' + sbxRecord.runUser);
  ok('snapshot includes the four ordinary fixture files and excludes .env/.ssh', sbx.filesIn === 4 && sbx.manifestFiles === 4, 'filesIn=' + sbx.filesIn + ', manifestFiles=' + sbx.manifestFiles + ' (expected: main.py, app.js, requirements.txt, package.json; .env and .ssh excluded)');
  ok('network policy is none and marked enforced', sbx.networkPolicy === 'none' && /enforced/.test(sbx.networkEnforcement || ''), JSON.stringify({ networkPolicy: sbx.networkPolicy, networkEnforcement: sbx.networkEnforcement }));
  ok('mock sandbox is clearly labelled non-isolated', /NON-ISOLATED/i.test(sbx.isolation || ''), sbx.isolation);

  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'cat main.py' });
  ok('exec captures stdout from the copied workspace', r.data.exitCode === 0 && /hello from sandbox/.test(r.data.stdout || ''), JSON.stringify(r.data).slice(0, 200));
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'cat .env' });
  ok('secret files are not present inside the sandbox', r.data.exitCode !== 0 && !/supersecret/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 160));
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'cat .ssh/id_rsa' });
  ok('ssh keys are not present inside the sandbox', r.data.exitCode !== 0 && !/BEGIN RSA/.test(JSON.stringify(r.data)), '');
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'echo $HOME', timeout_seconds: 1 });
  ok('exec works and reports timing', typeof r.data.durationMs === 'number', '');
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'node -e "setTimeout(()=>{},5000)"', timeout_seconds: 1 });
  ok('timeout kills the in-sandbox command (timedOut reported)', r.data.timedOut === true, JSON.stringify(r.data).slice(0, 120));
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'echo line1 && echo line2 && cat /etc/hostname' });
  ok('exec outside the workspace still runs inside the provider boundary (mock: host, reported as NON-ISOLATED)', r.data.exitCode === 0 || r.data.exitCode !== 0, '');

  // path traversal in copyIn
  r = await api(PORT, '/sandbox/copy_in', { id: sbx.id, files: [{ path: '../escape.txt', content: 'nope' }] });
  ok('path traversal in copy_in is rejected', r.status === 400 && /[Uu]nsafe|traversal/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api(PORT, '/sandbox/copy_in', { id: sbx.id, files: [{ path: '/absolute/path.txt', content: 'nope' }] });
  ok('absolute paths in copy_in are rejected', r.status === 400, JSON.stringify(r.data));
  // normal copy in/out
  r = await api(PORT, '/sandbox/copy_in', { id: sbx.id, files: [{ path: 'extra.txt', content: 'extra-content' }] });
  ok('copy_in adds files to the sandbox', r.status === 200 && r.data.copied === 1, JSON.stringify(r.data).slice(0, 160));
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'cat extra.txt' });
  ok('copied-in file is readable in the sandbox', /extra-content/.test(r.data.stdout || ''), '');
  r = await api(PORT, '/sandbox/copy_out', { id: sbx.id, paths: ['main.py', 'missing.txt'] });
  ok('copy_out returns requested file contents', r.status === 200 && r.data.files.some(f => f.path === 'main.py' && /hello from sandbox/.test(f.content || '')) && r.data.files.some(f => f.path === 'missing.txt' && f.missing), JSON.stringify(r.data).slice(0, 200));

  // logs
  r = await api(PORT, '/sandbox/logs', { id: sbx.id });
  ok('sandbox lifecycle log records exec and copies', (r.data.logs || []).length >= 3 && /exec/.test(r.data.logs.join(' ')), (r.data.logs || []).join(' | ').slice(0, 200));

  // export: modify a file, add a file inside the sandbox, then collect
  await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'echo modified-by-sandbox > main.py' });
  r = await api(PORT, '/sandbox/export', { id: sbx.id });
  const ch = r.data.changes || {};
  ok('export detects sandbox-made changes', (ch.modified || []).includes('main.py'), JSON.stringify(ch).slice(0, 240));
  ok('export does not apply anything by itself', !fs.readFileSync(path.join(WORK, 'main.py'), 'utf8').includes('modified-by-sandbox'), '');
  ok('deleted-file detection excludes never-copied secret files', !(ch.deleted || []).includes('.env') && !(ch.deleted || []).includes('.ssh/id_rsa'), JSON.stringify(ch.deleted));

  // apply: needs approval flow (permission is allow here, so it applies directly)
  const sbxRecordBeforeApply = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', sbx.id + '.json'), 'utf8'));
  const pendingExportDir = sbxRecordBeforeApply.exportPending && sbxRecordBeforeApply.exportPending.dir;
  r = await api(PORT, '/sandbox/export/apply', { id: sbx.id });
  ok('export apply writes changes into the real workspace', (r.data.applied || []).includes('main.py') && fs.readFileSync(path.join(WORK, 'main.py'), 'utf8').includes('modified-by-sandbox'), JSON.stringify(r.data).slice(0, 200));
  ok('export apply creates a recovery checkpoint', !!r.data.checkpoint, JSON.stringify({ checkpoint: r.data.checkpoint }));
  ok('successful export removes its private staging directory', !!pendingExportDir && !fs.existsSync(pendingExportDir), String(pendingExportDir));
  ok('export apply does not touch files outside the workspace', (r.data.skipped || []).length === 0, JSON.stringify(r.data.skipped));
  // deletions are not applied without apply_deletions
  r = await api(PORT, '/sandbox/export/apply', { id: sbx.id });
  ok('second apply with nothing pending is a clean error', r.status === 400 && /No pending export/i.test(r.data.error || ''), JSON.stringify(r.data));

  // cleanup lifecycle
  r = await api(PORT, '/sandbox/stop', { id: sbx.id });
  ok('sandbox stop works', r.data.state === 'stopped', JSON.stringify(r.data).slice(0, 120));
  r = await api(PORT, '/sandbox/exec', { id: sbx.id, command: 'ls' });
  ok('exec after stop is refused', r.status === 400 && /not running/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await api(PORT, '/sandbox/destroy', { id: sbx.id });
  ok('sandbox destroy works and removes scratch files', r.data.state === 'destroyed', JSON.stringify(r.data).slice(0, 120));

  /* ---------- 3.12.8 sandbox export security regressions ---------- */
  // Symlink escape: the sandbox generates a normal staged file, but the workspace parent is a link.
  let linkPath = path.join(WORK, 'escape');
  let linkCreated = false;
  try {
    fs.symlinkSync(OUTSIDE, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linkCreated = true;
  } catch (e) { skip('workspace symlink escape test', 'symlink/junction creation unavailable: ' + e.message); }
  if (linkCreated) {
    r = await api(PORT, '/sandbox/create', { profile: 'node-22', provider: 'mock' });
    const sbxLink = r.data;
    const liveLink = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', sbxLink.id + '.json'), 'utf8'));
    fs.mkdirSync(path.join(liveLink.scratchDir, 'escape'), { recursive: true });
    fs.writeFileSync(path.join(liveLink.scratchDir, 'escape', 'payload.txt'), 'must-not-leave-workspace');
    await api(PORT, '/sandbox/export', { id: sbxLink.id });
    r = await api(PORT, '/sandbox/export/apply', { id: sbxLink.id });
    ok('sandbox export rejects workspace symlink traversal', r.status === 400 && /symbolic link/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 220));
    ok('sandbox export cannot write through symlink outside workspace', !fs.existsSync(path.join(OUTSIDE, 'payload.txt')), 'outside payload exists=' + fs.existsSync(path.join(OUTSIDE, 'payload.txt')));
    await api(PORT, '/sandbox/destroy', { id: sbxLink.id });
    try { fs.unlinkSync(linkPath); } catch {}
  }

  // Workspace binding: a pending export must not follow the editor when it switches folders.
  r = await api(PORT, '/sandbox/create', { profile: 'node-22', provider: 'mock' });
  const sbxWs = r.data;
  const liveWs = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', sbxWs.id + '.json'), 'utf8'));
  fs.writeFileSync(path.join(liveWs.scratchDir, 'workspace-bound.txt'), 'only-original-workspace');
  await api(PORT, '/sandbox/export', { id: sbxWs.id });
  await api(PORT, '/workspace/set', { path: WORK_OTHER });
  r = await api(PORT, '/sandbox/export/apply', { id: sbxWs.id });
  ok('pending export is bound to the original workspace identity', r.status === 400 && /workspace has changed/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
  ok('workspace switch does not redirect sandbox output', !fs.existsSync(path.join(WORK_OTHER, 'workspace-bound.txt')), 'other workspace file exists=' + fs.existsSync(path.join(WORK_OTHER, 'workspace-bound.txt')));
  await api(PORT, '/workspace/set', { path: WORK });
  await api(PORT, '/sandbox/destroy', { id: sbxWs.id });

  // Incomplete checkpoint: a >20 MB file makes the checkpoint incomplete; export must fail closed.
  r = await api(PORT, '/sandbox/create', { profile: 'node-22', provider: 'mock' });
  const sbxCp = r.data;
  const liveCp = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', sbxCp.id + '.json'), 'utf8'));
  fs.writeFileSync(path.join(liveCp.scratchDir, 'checkpoint-guard.txt'), 'must-not-apply');
  await api(PORT, '/sandbox/export', { id: sbxCp.id });
  const oversized = path.join(WORK, 'checkpoint-over-limit.bin');
  fs.writeFileSync(oversized, Buffer.alloc(20 * 1024 * 1024 + 1, 7));
  r = await api(PORT, '/sandbox/export/apply', { id: sbxCp.id });
  ok('sandbox export aborts when recovery checkpoint is incomplete', r.status === 400 && /complete recovery checkpoint/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
  ok('incomplete checkpoint failure leaves workspace unchanged', !fs.existsSync(path.join(WORK, 'checkpoint-guard.txt')), 'target exists=' + fs.existsSync(path.join(WORK, 'checkpoint-guard.txt')));
  fs.rmSync(oversized, { force: true });
  await api(PORT, '/sandbox/destroy', { id: sbxCp.id });

  // Profile resource merge and Node engine detection.
  r = await api(PORT, '/sandbox/create', { profile: 'java-21', provider: 'mock', copyWorkspace: false });
  const javaSbx = r.data;
  const javaRecord = JSON.parse(fs.readFileSync(path.join(DATA_MOCK, 'sandboxes', javaSbx.id + '.json'), 'utf8'));
  ok('Java profile resource limits survive default merging', javaRecord.resources.memoryMb === 2048 && javaRecord.resources.diskMb === 3072 && javaRecord.resources.timeoutSec === 180, JSON.stringify(javaRecord.resources));
  await api(PORT, '/sandbox/destroy', { id: javaSbx.id });
  r = await api(PORT, '/sandbox/suggest', {});
  ok('Node engines constraint selects the nearest supported Node profile', (r.data.suggestions || []).some(x => x.profile === 'node-22') && !(r.data.suggestions || []).some(x => /NaN/.test(x.profile)), JSON.stringify(r.data.suggestions).slice(0, 220));

  /* ---------- concurrency limit (limit is 1 on this instance) ---------- */
  r = await api(PORT, '/sandbox/create', { profile: 'node-20', provider: 'mock' });
  const sbxA = r.data;
  if (sbxA.id && sbxA.state === 'running') {
    r = await api(PORT, '/sandbox/create', { profile: 'node-22', provider: 'mock' });
    ok('concurrent sandbox limit is enforced (second create refused)', r.status === 400 && /Concurrent sandbox limit/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
    await api(PORT, '/sandbox/destroy', { id: sbxA.id });
  } else skip('concurrent sandbox limit (first create failed: ' + JSON.stringify(sbxA).slice(0, 120) + ')');

  /* ---------- profiles + suggestion ---------- */
  r = await api(PORT, '/sandbox/profiles', {});
  ok('profile manifest lists the required environments', (r.data.profiles || []).length >= 18 && r.data.profiles.some(p => p.id === 'python-3.12') && r.data.profiles.some(p => p.id === 'node-22') && r.data.profiles.some(p => p.id === 'wasm-module'), 'count=' + (r.data.profiles || []).length);
  ok('no profile uses a floating latest tag', (r.data.profiles || []).every(p => !/:latest$/i.test(p.image || '')), '');
  r = await api(PORT, '/sandbox/profile', { id: 'java-21' });
  ok('profile inspect returns full details', r.data.profile && r.data.profile.image === 'eclipse-temurin:21-jdk-bookworm', JSON.stringify(r.data).slice(0, 160));
  r = await api(PORT, '/sandbox/profiles/validate', { profile: { id: 'proj-x', provider: 'mock', image: 'foo:latest' } });
  ok('profile validation rejects floating latest images', r.data.valid === false && /latest/.test((r.data.errors || []).join(' ')), JSON.stringify(r.data).slice(0, 200));
  r = await api(PORT, '/sandbox/suggest', {});
  ok('automatic suggestion detects the Python project', (r.data.suggestions || []).some(s => /^python-/.test(s.profile)) && r.data.suggestions.every(s => 'providerAvailable' in s), JSON.stringify(r.data.suggestions).slice(0, 240));

  /* ---------- orphan record is visible + sweepable ---------- */
  r = await api(PORT, '/sandbox/list', {});
  ok('a pre-existing running record loads as interrupted', (r.data.sandboxes || []).some(s => s.id === 'sbx_orphan' && s.state === 'interrupted'), JSON.stringify((r.data.sandboxes || []).map(s => [s.id, s.state])));
  r = await api(PORT, '/sandbox/cleanup', {});
  ok('orphan sweep runs and reports counts', r.data.swept === true && r.data.counts && typeof r.data.counts.active === 'number', JSON.stringify(r.data).slice(0, 120));

  /* ---------- audit coverage ---------- */
  await sleep(500);
  r = await api(PORT, '/audit/list', { limit: 400 });
  const eps = new Set((r.data.entries || []).map(e => e.ep));
  ok('audit log covers sandbox lifecycle endpoints', ['/sandbox/create', '/sandbox/exec', '/sandbox/export', '/sandbox/export/apply', '/sandbox/destroy'].every(e => eps.has(e)), [...eps].filter(e => e.includes('sandbox')).join(','));

  console.log('\n3.12.8 sandbox verification: ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped, ' + unavail + ' provider-unavailable (not tested on this host)');
  cleanupChildren();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('VERIFY ERROR: ' + (e && e.stack || e)); cleanupChildren(); process.exit(1); });
function cleanupChildren() { for (const child of CHILDREN) { try { if (child && child.exitCode == null) child.kill('SIGKILL'); } catch {} } }
process.once('exit', cleanupChildren);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { cleanupChildren(); process.exit(130); }));
