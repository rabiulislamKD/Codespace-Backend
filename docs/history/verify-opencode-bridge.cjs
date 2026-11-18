'use strict';
// Reproducible local integration smoke test for the OpenCode bridge. Uses a mock
// CLI executable so it does not require OpenCode, a provider login, or the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForServer(base, headers, child) {
  const deadline = Date.now() + 10000;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Agent server exited early.');
    try {
      const r = await fetch(base + '/opencode/status', { method: 'POST', headers, body: '{}' });
      if (r.ok) return await r.json();
      last = new Error('Status returned ' + r.status);
    } catch (e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start: ' + String(last));
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'my-agent-opencode-test-'));
  const workspace = path.join(tmp, 'workspace');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(workspace); fs.mkdirSync(home);
  const fakeCli = path.join(tmp, 'mock-opencode.js');
  fs.writeFileSync(fakeCli, `
if (process.argv.includes('--version')) { console.log('mock-opencode 1.2.3'); process.exit(0); }
if (process.argv[2] === 'run') {
  const args = process.argv.slice(3);
  const prompt = args[args.length - 1] || '';
  process.stdout.write(JSON.stringify({type:'text',sessionID:'ses_TEST1234',messageID:'m1',part:{type:'text',id:'p1',text:'Mock OpenCode answer: '+prompt}})+'\\n');
  process.stdout.write(JSON.stringify({type:'session.complete',sessionID:'ses_TEST1234'})+'\\n');
  process.exit(0);
}
process.exit(2);
`);
  const port = await getFreePort(), token = 'mock-opencode-test-token';
  const scriptDir = __dirname;
  const child = spawn(process.execPath, [path.join(scriptDir, 'agent-server.js'), workspace, '--port', String(port), '--token', token], {
    cwd: scriptDir,
    env: { ...process.env, OPENCODE_BIN: fakeCli, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let logs = '';
  child.stdout.on('data', b => { logs = (logs + b.toString()).slice(-6000); });
  child.stderr.on('data', b => { logs = (logs + b.toString()).slice(-6000); });
  const base = 'http://127.0.0.1:' + port;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    const status = await waitForServer(base, headers, child);
    assert.equal(status.installed, true); assert.match(status.version, /mock-opencode/); assert.equal(path.resolve(status.workspace), path.resolve(workspace));
    console.log('PASS mocked OpenCode status endpoint');

    const prompt = 'Inspect the project; literal shell text: ; touch SHOULD_NOT_EXIST';
    const response = await fetch(base + '/opencode/run', { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify({ prompt, autoApprove: false }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /Mock OpenCode answer/); assert.ok(stream.includes(prompt), 'prompt is preserved as one argument');
    assert.match(stream, /"sessionId":"ses_TEST1234"/); assert.match(stream, /"exitCode":0/);
    assert.equal(fs.existsSync(path.join(workspace, 'SHOULD_NOT_EXIST')), false, 'prompt must not execute through a shell');
    console.log('PASS streamed result, session ID, and no-shell prompt handling');

    const invalid = await fetch(base + '/opencode/run', { method: 'POST', headers, body: JSON.stringify({ prompt: '\u0000bad' }) });
    assert.equal(invalid.status, 400); assert.match((await invalid.text()), /null character/);
    console.log('PASS invalid prompt rejected');

    const unauthorized = await fetch(base + '/opencode/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    console.log('PASS bridge token required');
    console.log('\n4/4 OpenCode bridge integration checks passed. (Mock CLI; no live provider used.)');
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); setTimeout(resolve, 1500).unref(); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exitCode = 1; });
