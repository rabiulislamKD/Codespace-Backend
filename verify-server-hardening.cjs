'use strict';
// Regression checks for request handling: malformed bodies, odd path types, oversized uploads,
// symlink escapes, token checks, and the OpenCode key endpoint's input validation.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { spawn } = require('child_process');
let passed = 0; const ok = n => { passed++; console.log('PASS', n); };
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hard-')), ws = path.join(tmp, 'ws'), data = path.join(tmp, 'd');
  fs.mkdirSync(ws); fs.mkdirSync(data); fs.writeFileSync(path.join(ws, 'a.txt'), 'hi'); fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
  let linked = true; try { fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(ws, 'link.txt')); } catch { linked = false; }
  const PORT = 19700 + Math.floor(Math.random() * 250), T = 'hard-' + Math.random().toString(16).slice(2);
  const srv = spawn(process.execPath, [path.join(__dirname, 'agent-server.js'), ws, '--port', String(PORT), '--token', T], { env: { ...process.env, MY_AGENT_DATA_DIR: data }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + PORT;
  const post = async (p, body, o = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(o.noauth ? {} : { Authorization: 'Bearer ' + (o.token || T) }) }, body: o.raw !== undefined ? o.raw : JSON.stringify(body || {}) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/info', { headers: { Authorization: 'Bearer ' + T } })).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    let r = await post('/fs/read', null, { raw: 'null' }); assert.equal(r.s, 400); assert.match(r.j.error, /JSON object/); ok('a null body gets a clear 400, not an internal error');
    r = await post('/fs/read', null, { raw: '[1,2]' }); assert.equal(r.s, 400); assert.match(r.j.error, /JSON object/); ok('an array body is rejected clearly');
    r = await post('/fs/read', null, { raw: '{bad' }); assert.equal(r.s, 400); assert.match(r.j.error, /Invalid JSON/); ok('invalid JSON is reported');
    r = await post('/fs/read', { path: 123 }); assert.equal(r.s, 400); assert.match(r.j.error, /must be text/); ok('a numeric path is rejected (no "[object Object]" files)');
    r = await post('/fs/read', { path: { a: 1 } }); assert.equal(r.s, 400); assert.match(r.j.error, /must be text/); ok('an object path is rejected');
    r = await post('/fs/read', { path: 'a.txt\0x' }); assert.equal(r.s, 400); assert.match(r.j.error, /Invalid path/); ok('a NUL byte in a path is rejected');
    r = await post('/fs/read', { path: 'a.txt' }); assert.equal(r.j.content, 'hi'); ok('normal reads still work');
    /* 3.13.3: reads OUTSIDE the opened workspace are no longer hard-refused — they return a
       single-use approval challenge (permission 'outside', default ask) the user must approve.
       The token handshake must work exactly once and never replay. Writes stay hard-blocked. */
    r = await post('/fs/read', { path: '../secret.txt' }); assert.equal(r.s, 200); assert.equal(r.j.needsApproval, true); assert.equal(r.j.permission, 'outside'); assert.match(r.j.preview, /outside the opened folder/); assert.ok(!r.j.content); ok('../ traversal outside the workspace asks for approval instead of reading');
    r = await post('/fs/read', { path: '../secret.txt' }); assert.equal(r.s, 200); assert.equal(r.j.needsApproval, true); assert.notEqual(r.j.approvalToken, undefined); ok('a repeated outside request gets a fresh challenge (no auto-approval)');
    r = await post('/fs/read', { path: '../secret.txt', approvalToken: r.j.approvalToken }); assert.equal(r.s, 200); assert.equal(r.j.content, 'SECRET'); ok('after the user approves, the outside file is readable exactly once');
    r = await post('/fs/read', { path: '../secret.txt', approvalToken: r.j.approvalToken }); assert.equal(r.s, 200); assert.equal(r.j.needsApproval, true); assert.ok(!r.j.content); ok('the approval token is single-use — replay gets a new challenge');
    r = await post('/fs/write', { path: '../secret.txt', content: 'X' }); assert.equal(r.s, 400); assert.equal(fs.readFileSync(path.join(tmp, 'secret.txt'), 'utf8'), 'SECRET'); ok('writing outside the workspace stays hard-blocked even for read-approved paths');
    if (linked) { r = await post('/fs/read', { path: 'link.txt' }); assert.equal(r.s, 200); assert.equal(r.j.needsApproval, true); r = await post('/fs/write', { path: 'link.txt', content: 'X' }); assert.equal(r.s, 400); assert.equal(fs.readFileSync(path.join(tmp, 'secret.txt'), 'utf8'), 'SECRET'); ok('a symlink pointing outside the workspace asks before reading and can never be overwritten'); }
    r = await post('/fs/read', { path: 'a.txt' }, { noauth: true }); assert.equal(r.s, 401); r = await post('/fs/read', { path: 'a.txt' }, { token: T + 'x' }); assert.equal(r.s, 401); ok('missing and near-miss tokens are refused');
    r = await post('/fs/write', { path: 'big.txt', content: 'x'.repeat(8e6) }); assert.equal(r.s, 413); assert.match(r.j.error, /too large/i); assert.equal(fs.existsSync(path.join(ws, 'big.txt')), false); ok('an oversized request gets a proper 413 and writes nothing');
    r = await post('/fs/read', { path: 'a.txt' }); assert.equal(r.s, 200); ok('the server keeps working after an oversized request');
    r = await post('/opencode/auth/set', { provider: 'opencode', key: 12345678901 }); assert.equal(r.s, 400); assert.match(r.j.error, /must be text/); ok('a non-text API key is an error, not a silent no-op');
    r = await post('/opencode/auth/set', { provider: 'constructor', key: 'abcdefghij123' }); assert.equal(r.s, 200);
    assert.ok(r.j.providers.some(p => p.id === 'constructor' && p.saved)); ok('a provider id that matches an Object property name still shows up as a saved key');
    r = await post('/opencode/auth/set', { provider: '__proto__', key: 'abcdefghij123' }); assert.equal(r.s, 400); ok('__proto__ is not accepted as a provider id');

    // Provider relay: streams, forwards headers, passes statuses through, refuses unsafe targets
    {
      const http = require('http'); const seen = [];
      const up = http.createServer((q, a) => {
        let raw = ''; q.on('data', c => raw += c); q.on('end', () => {
          seen.push({ url: q.url, method: q.method, auth: q.headers.authorization, cookie: q.headers.cookie, ct: q.headers['content-type'], body: raw });
          if (q.url === '/stream') { a.writeHead(200, { 'Content-Type': 'text/event-stream' }); a.write('data: one\n\n'); setTimeout(() => { a.write('data: two\n\n'); a.end(); }, 150); return; }
          if (q.url === '/limited') { a.writeHead(429, { 'Content-Type': 'application/json' }); return a.end('{"error":"rate limited"}'); }
          a.writeHead(200, { 'Content-Type': 'application/json' }); a.end(JSON.stringify({ echo: raw }));
        });
      });
      await new Promise(r => up.listen(0, '127.0.0.1', r)); const U = 'http://127.0.0.1:' + up.address().port;
      const raw = async (b, token = T) => fetch(base + '/llm/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(b) });
      try {
        let rr = await raw({ url: U + '/chat', method: 'POST', headers: { Authorization: 'Bearer sk-provider', 'Content-Type': 'application/json', Cookie: 'steal=1', Host: 'evil' }, body: '{"hi":1}' });
        assert.equal(rr.status, 200); assert.equal((await rr.json()).echo, '{"hi":1}');
        assert.equal(seen[0].auth, 'Bearer sk-provider'); assert.equal(seen[0].cookie, undefined); assert.equal(seen[0].method, 'POST'); ok('relay: forwards method, body and the provider key header, drops cookies');
        rr = await raw({ url: U + '/stream', method: 'POST', headers: {}, body: '{}' }); const rd = rr.body.getReader(); const t0 = Date.now(); const first = await rd.read();
        assert.match(Buffer.from(first.value).toString(), /one/); assert.ok(Date.now() - t0 < 140, 'first chunk must arrive before the stream ends'); while (!(await rd.read()).done); ok('relay: streams chunks as they arrive');
        rr = await raw({ url: U + '/limited', method: 'POST', headers: {}, body: '{}' }); assert.equal(rr.status, 429); assert.equal(rr.headers.get('x-codespace-proxy-error'), null); assert.match((await rr.json()).error, /rate limited/); ok('relay: provider error statuses pass through unchanged');
        rr = await raw({ url: 'http://127.0.0.1:9/none', method: 'GET' }); assert.equal(rr.status, 502); assert.equal(rr.headers.get('x-codespace-proxy-error'), '1'); assert.match((await rr.json()).error, /Could not reach/); ok('relay: an unreachable provider is reported as a relay error');
        rr = await raw({ url: 'http://example.com/x' }); assert.equal(rr.status, 400); assert.match((await rr.json()).error, /https/); ok('relay: plain http to a public host is refused');
        rr = await raw({ url: 'https://169.254.169.254/latest/meta-data' }); assert.equal(rr.status, 400); ok('relay: cloud metadata addresses are refused');
        rr = await raw({ url: 'file:///etc/passwd' }); assert.equal(rr.status, 400); ok('relay: file: and other schemes are refused');
        rr = await raw({ url: U + '/x', method: 'DELETE' }); assert.equal(rr.status, 400); ok('relay: only GET and POST');
        rr = await raw({ url: U + '/x', method: 'POST', body: { a: 1 } }); assert.equal(rr.status, 400); ok('relay: a non-text body is refused');
        rr = await raw({ url: U + '/x' }, 'wrong'); assert.equal(rr.status, 401); ok('relay: needs the bridge token');
        const audit = fs.existsSync(path.join(data, 'audit.jsonl')) ? fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8') : ''; assert.ok(!audit.includes('sk-provider') && !audit.includes('llm/proxy')); ok('relay: requests (which carry provider keys) are not written to the activity log');
      } finally { up.close(); }
    }
    // Node fallback: a computer with no Node on PATH still gets `node` from the runtime that runs CodeSpace.
    if (process.platform !== 'win32') {
      const nodeDir = path.join(tmp, 'rt'), binDir = path.join(tmp, 'bin'); fs.mkdirSync(nodeDir); fs.mkdirSync(binDir);
      fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
      for (const c of ['bash', 'sh', 'which']) { const f = ['/usr/bin/', '/bin/'].map(d => d + c).find(x => fs.existsSync(x)); if (f) fs.symlinkSync(f, path.join(binDir, c)); }
      const PORT2 = PORT + 400, ws2 = path.join(tmp, 'ws2'); fs.mkdirSync(ws2);
      const srv2 = spawn(path.join(nodeDir, 'node'), [path.join(__dirname, 'agent-server.js'), ws2, '--port', String(PORT2), '--token', T], { env: { PATH: binDir, MY_AGENT_DATA_DIR: path.join(tmp, 'd2'), HOME: tmp }, stdio: 'ignore' });
      try {
        const b2 = 'http://127.0.0.1:' + PORT2;
        for (let i = 0; i < 60; i++) { try { if ((await fetch(b2 + '/info', { headers: { Authorization: 'Bearer ' + T } })).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
        const rr = await fetch(b2 + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify({ command: 'node -v', approved: true }) });
        const txt = await rr.text(); assert.ok(txt.includes(process.version), txt.slice(0, 300)); ok('with no Node on PATH, commands still get the bundled Node');
      } finally { srv2.kill('SIGKILL'); }
    }
    console.log('\nserver-hardening: ' + passed + ' checks passed');
  } finally { srv.kill('SIGKILL'); await new Promise(r => setTimeout(r, 100)); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch {} }
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
