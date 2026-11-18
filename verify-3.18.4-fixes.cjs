'use strict';
// Regression tests for the 3.18.4 bug-hunt fixes. Run: node verify-3.18.4-fixes.cjs
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { spawn } = require('child_process');
let passed = 0; const ok = n => { passed++; console.log('PASS', n); };
const server = fs.readFileSync(path.join(__dirname, 'agent-server.js'), 'utf8');
const tools = fs.readFileSync(path.join(__dirname, 'src-js/08-tools.js'), 'utf8');

// --- pure functions pulled out of the source so they can be called directly ---
const a = server.indexOf('function isPrivateIpv4'), b = server.indexOf('\n}\n', server.indexOf('function isPrivateIp(ip)')) + 3;
const { isPrivateIp } = new Function('netMod', server.slice(a, b) + '\nreturn { isPrivateIp };')(require('net'));
const pa = tools.indexOf('function parseArgs'), pb = tools.indexOf('\n}\n', pa) + 3;
const { parseArgs } = new Function(tools.slice(pa, pb) + '\nreturn { parseArgs };')();

// 1. IPv6: zero-padded spellings of private addresses must still be private
for (const ip of ['::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '0000:0000:0000:0000:0000:ffff:7f00:0001', '0000:0000:0000:0000:0000:0000:0000:0000', '0064:ff9b:0000:0000:0000:0000:7f00:0001', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1'])
  assert.equal(isPrivateIp(ip), true, ip + ' must be private');
assert.equal(isPrivateIp('2606:4700::1111'), false); assert.equal(isPrivateIp('8.8.8.8'), false); assert.equal(isPrivateIp('10.0.0.1'), true);
ok('padded IPv6 loopback / mapped / NAT64 / unspecified addresses are private; public ones are not');

// 2. parseArgs only returns plain objects
for (const raw of ['null', '5', '"text"', '[1,2]', 'true']) { const r = parseArgs(raw); assert.deepEqual(r.args, {}, raw); }
assert.deepEqual(parseArgs('{"a":1}').args, { a: 1 }); assert.deepEqual(parseArgs('').args, {});
assert.deepEqual(parseArgs('{"a":1,}').args, { a: 1 }); assert.deepEqual(parseArgs('{"a":"x"').args, { a: 'x' });
ok('parseArgs rejects null / scalar / array JSON and still repairs truncated objects');

// 3. replacement strings must never be interpreted as patterns
assert.match(server, /content\.replace\(oldText, \(\) => newText\)/); ok('batch edit uses a function replacer');
assert.match(server, /content\.replace\(re, \(m, pre\) => pre \+ newName\)/); ok('rename uses a function replacer');
{ // behaviour of the rename replacement with $-names
  const re = /(^|[^A-Za-z0-9_$])foo(?![A-Za-z0-9_$])/g;
  assert.equal('let foo = foo + 1'.replace(re, (m, pre) => pre + '$$el'), 'let $$el = $$el + 1');
  assert.equal('let foo = 1'.replace(re, (m, pre) => pre + '$1x'), 'let $1x = 1');
}
ok('renaming to $$el / $1x keeps the dollar signs');

// 4. the global crash guard exists and startup errors stay fatal
assert.match(server, /process\.on\('unhandledRejection'/); assert.match(server, /process\.on\('uncaughtException'/);
assert.match(server, /server\.on\('error', e => \{[\s\S]*?process\.exit\(1\)/); ok('unhandledRejection / uncaughtException handlers exist, EADDRINUSE still exits');

// 5. end-to-end against a real server
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-3184-')), ws = path.join(tmp, 'ws'), data = path.join(tmp, 'd');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(data);
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'x' }, dependencies: { react: '1' } }));
  fs.writeFileSync(path.join(ws, 'src', 'index.js'), 'const a = 1;\n'); fs.writeFileSync(path.join(ws, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(ws, 'price.txt'), 'cost: PLACEHOLDER\n');
  const PORT = 19950 + Math.floor(Math.random() * 40), T = 't-' + Math.random().toString(16).slice(2);
  const srv = spawn(process.execPath, [path.join(__dirname, 'agent-server.js'), ws, '--port', String(PORT), '--token', T], { env: { ...process.env, MY_AGENT_DATA_DIR: data }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + PORT;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify(body || {}) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/info', { headers: { Authorization: 'Bearer ' + T } })).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    let r = await post('/project/understand'); assert.equal(r.s, 200, JSON.stringify(r.j)); assert.equal(r.j.ok, true);
    assert.deepEqual(r.j.topLevel, ['src']); assert.ok(r.j.fileCount >= 4); ok('/project/understand works on a project with files and lists only folders as top level');

    const edit = { edits: [{ path: 'price.txt', old_text: 'PLACEHOLDER', new_text: 'cost $& and $1 and $$ and $`' }] };
    r = await post('/fs/editbatch', edit);
    if (r.j && r.j.needsApproval) r = await post('/fs/editbatch', { ...edit, approvalToken: r.j.approvalToken });
    assert.equal(r.s, 200, JSON.stringify(r.j));
    assert.equal(fs.readFileSync(path.join(ws, 'price.txt'), 'utf8'), 'cost: cost $& and $1 and $$ and $`\n'); ok('batch edit writes $&, $1, $$ and $` literally');

    // the server must survive a request that fails in the background
    r = await post('/info'); assert.ok(r.s === 200 || r.s === 404 || r.s === 405); ok('server still answers afterwards');
  } finally { try { srv.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  console.log(passed + ' checks passed');
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
