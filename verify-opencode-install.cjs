'use strict';
// Checks the "OpenCode without a prior install" features against the real agent-server.js:
// status when missing, install from a fake local npm registry (with integrity check), saved API key
// handling (never echoed back, 0600 file, passed to the process env + inline config + --model).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const root = __dirname, PORT = 18900 + Math.floor(Math.random() * 200), TOKEN = 'oc-test-' + Math.random().toString(16).slice(2);
let passed = 0; const ok = n => { passed++; console.log('PASS', n); };

const pkgName = (() => { // mirror ocPlatformPackages() for the machine running the test
  const o = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return 'opencode-' + o + '-' + (process.arch === 'arm64' ? 'arm64' : 'x64');
})();
const MOCK = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9-mock'); process.exit(0); }
if (process.argv[2] === 'run') {
  const info = { argv: process.argv.slice(3, -1), key: process.env.OPENCODE_API_KEY || '', anth: process.env.ANTHROPIC_API_KEY || '', cfg: process.env.OPENCODE_CONFIG_CONTENT || '' };
  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_MOCK1234', messageID: 'm1', part: { type: 'text', id: 'p1', text: JSON.stringify(info) } }));
  process.exit(0);
}
process.exit(2);
`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-oc-')), data = path.join(tmp, 'data'), ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws); fs.mkdirSync(data);
  // Build the fake registry package: package/bin/opencode(.exe) inside a .tgz
  const pk = path.join(tmp, 'pk', 'package', 'bin'); fs.mkdirSync(pk, { recursive: true });
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  fs.writeFileSync(path.join(pk, exeName), MOCK); fs.chmodSync(path.join(pk, exeName), 0o755);
  const tgz = path.join(tmp, 'pkg.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', path.join(tmp, 'pk'), 'package']).status, 0);
  const tgzBuf = fs.readFileSync(tgz);
  let corrupt = false, regHits = [];
  const reg = http.createServer((req, res) => {
    regHits.push(req.url);
    if (req.url === '/' + pkgName + '/latest') {
      const integrity = 'sha512-' + crypto.createHash('sha512').update(corrupt ? Buffer.from('x') : tgzBuf).digest('base64');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ version: '9.9.9', dist: { tarball: 'http://127.0.0.1:' + regPort + '/dl/pkg.tgz', integrity } }));
    }
    if (req.url === '/dl/pkg.tgz') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(tgzBuf); }
    res.statusCode = 404; res.end('no');
  });
  await new Promise(r => reg.listen(0, '127.0.0.1', r)); const regPort = reg.address().port;

  const env = { ...process.env, MY_AGENT_DATA_DIR: data, CODESPACE_NPM_REGISTRY: 'http://127.0.0.1:' + regPort, PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin' };
  delete env.OPENCODE_BIN; delete env.OPENCODE_CONFIG_CONTENT;
  const srv = spawn(process.execPath, [path.join(root, 'agent-server.js'), ws, '--port', String(PORT), '--token', TOKEN], { env, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + PORT;
  const call = async (p, body, token = TOKEN) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})), r }; };
  const sse = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(body || {}) }); const t = await r.text(); return t.split('\n\n').map(x => x.replace(/^data: /, '')).filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await call('/info')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    let st = (await call('/opencode/status')).json;
    assert.equal(st.installed, false); assert.equal(st.canInstall, true); ok('status: not installed, install is offered');

    assert.equal((await call('/opencode/install', {}, 'wrong')).status, 401); ok('install endpoint needs the bearer token');
    assert.equal((await call('/opencode/auth/set', { provider: 'opencode', key: 'x' }, 'wrong')).status, 401); ok('key endpoint needs the bearer token');

    // corrupted download must be rejected and leave nothing behind
    corrupt = true;
    let ev = await sse('/opencode/install'); let done = ev.find(e => e.type === 'done');
    assert.equal(done.ok, false); assert.match(done.error, /integrity|corrupt/i);
    assert.equal(fs.existsSync(path.join(data, 'opencode', 'bin', exeName)), false); ok('a download that fails the integrity check is rejected');
    corrupt = false;

    ev = await sse('/opencode/install'); done = ev.find(e => e.type === 'done');
    assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.status.installed, true); assert.equal(done.status.managed, true);
    assert.ok(ev.some(e => e.type === 'progress' && /Downloading/.test(e.message))); ok('install downloads, verifies, unpacks and runs the CLI');
    st = (await call('/opencode/status')).json;
    assert.equal(st.installed, true); assert.match(st.version, /9\.9\.9/); ok('status finds the CodeSpace-installed copy');
    assert.equal(fs.readdirSync(path.join(data, 'opencode')).filter(x => x.startsWith('dl-')).length, 0); ok('temporary download folders are cleaned up');

    // saved key
    let v = (await call('/opencode/auth/set', { provider: 'opencode', key: 'sk-test-ABCDEFGH1234', model: 'opencode/big-pickle' })).json;
    assert.ok(v.providers.find(p => p.id === 'opencode').saved); assert.equal(v.providers.find(p => p.id === 'opencode').hint, '…1234');
    assert.ok(!JSON.stringify(v).includes('ABCDEFGH')); assert.equal(v.model, 'opencode/big-pickle'); ok('key is saved and only its last 4 characters are ever returned');
    assert.ok(!JSON.stringify((await call('/opencode/auth/get')).json).includes('ABCDEFGH')); ok('auth/get never returns the key');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(data, 'opencode-auth.json')).mode & 0o077, 0); ok('key file is private (0600)');
    assert.equal((await call('/opencode/auth/set', { provider: 'bad id!', key: 'abcdefghij' })).status >= 400, true); ok('bad provider ids are rejected');
    assert.equal((await call('/opencode/auth/set', { provider: 'opencode', key: 'has space inside' })).status >= 400, true); ok('keys with whitespace are rejected');
    await call('/opencode/auth/set', { provider: 'anthropic', key: 'sk-ant-zzzzzzzz9999' });

    // run: key reaches the process via env + inline config + --model, not via the command line
    await call('/workspace/set', { path: ws });
    ev = await sse('/opencode/run', { prompt: 'hello' }); done = ev.find(e => e.type === 'done');
    assert.equal(done.exitCode, 0, JSON.stringify(done)); const info = JSON.parse(done.text);
    assert.equal(info.key, 'sk-test-ABCDEFGH1234'); assert.equal(info.anth, 'sk-ant-zzzzzzzz9999'); ok('saved keys reach OpenCode as provider environment variables');
    const cfg = JSON.parse(info.cfg); assert.equal(cfg.provider.opencode.options.apiKey, 'sk-test-ABCDEFGH1234'); ok('saved keys are also supplied as inline OpenCode config');
    assert.deepEqual(info.argv.slice(info.argv.indexOf('--model'), info.argv.indexOf('--model') + 2), ['--model', 'opencode/big-pickle']); ok('the saved model is passed with --model');
    assert.ok(!info.argv.join(' ').includes('ABCDEFGH')); ok('the key never appears on the command line');

    // removing a key
    v = (await call('/opencode/auth/set', { provider: 'opencode', clear: true })).json;
    assert.equal(v.providers.find(p => p.id === 'opencode').saved, false); ok('a saved key can be removed');
    const audit = fs.existsSync(path.join(data, 'audit.jsonl')) ? fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8') : '';
    assert.ok(!audit.includes('ABCDEFGH') && !audit.includes('zzzzzzzz')); ok('keys are not written to the audit log');
    console.log('\nopencode-install: ' + passed + ' checks passed');
  } finally { srv.kill(); reg.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
