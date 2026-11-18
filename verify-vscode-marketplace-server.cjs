'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const assert = require('assert/strict');
const { spawn } = require('child_process');

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); } return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(value), comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, n); offset += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), local = Buffer.concat(locals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, end]);
}

(async () => {
  const root = __dirname, data = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vscode-mkt-server-'));
  const port = 19000 + Math.floor(Math.random() * 1000), token = 'vscode-marketplace-' + crypto.randomBytes(12).toString('hex');
  const id = 'codespace-test.smoke-extension', version = '1.0.0';
  const key = crypto.createHash('sha256').update(id + '@' + version).digest('hex').slice(0, 24);
  const candidateDir = path.join(data, 'vscode-extension-candidates'); fs.mkdirSync(candidateDir, { recursive:true });
  const pkg = { name:'smoke-extension', displayName:'CodeSpace Marketplace smoke extension', publisher:'codespace-test', version, engines:{vscode:'^1.80.0'}, browser:'./dist/web/extension.js', contributes:{commands:[{command:'codespace-test.smoke',title:'Smoke test'}]} };
  const payload = zip({ 'extension/package.json':JSON.stringify(pkg), 'extension/dist/web/extension.js':"const vscode=require('vscode'); exports.activate=function(){vscode.commands.registerCommand('codespace-test.smoke',function(){return 'ok';});};" });
  fs.writeFileSync(path.join(candidateDir, key + '.vsix'), payload);
  const server = spawn(process.execPath, [path.join(root, 'agent-server.js'), '--port', String(port), '--token', token], { env:{ ...process.env, MY_AGENT_DATA_DIR:data }, stdio:'ignore' });
  const base = 'http://127.0.0.1:' + port;
  const call = async (endpoint, body = {}, auth = token) => {
    const response = await fetch(base + endpoint, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + auth }, body:JSON.stringify(body) });
    return { status:response.status, json:await response.json().catch(()=>({})) };
  };
  const check = (name, ok) => { assert.ok(ok, name); console.log('PASS ' + name); };
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) { try { const r = await call('/info'); if (r.status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    check('real Agent Server starts for extension marketplace integration', ready);
    const denied = await call('/ext/marketplace/installed', {}, 'incorrect-token');
    check('marketplace bridge route rejects an invalid local token', denied.status === 401);
    let install = await call('/ext/marketplace/install', { id, version });
    check('install route requires the existing extension permission approval', install.json.needsApproval === true && !!install.json.approvalToken);
    install = await call('/ext/marketplace/install', { id, version, approvalToken:install.json.approvalToken });
    check('validated VSIX installs after its approval token is supplied', install.status === 200 && install.json.ok === true && install.json.key === key);
    const installed = await call('/ext/marketplace/installed');
    check('installed registry returns the extension metadata and browser entry point', installed.json.items?.length === 1 && installed.json.items[0].id === id && installed.json.items[0].browserPath === 'dist/web/extension.js');
    const assetUrl = base + '/extension-host/assets/' + key + '/dist/web/extension.js?token=' + encodeURIComponent(token);
    const asset = await fetch(assetUrl);
    check('token-protected extension asset route serves the installed browser bundle', asset.status === 200 && (await asset.text()).includes('registerCommand'));
    const noAssetToken = await fetch(base + '/extension-host/assets/' + key + '/dist/web/extension.js');
    check('extension asset route rejects requests without the bridge token', noAssetToken.status === 401);
    let remove = await call('/ext/marketplace/uninstall', { key });
    check('uninstall route requires the existing destructive-action approval', remove.json.needsApproval === true && !!remove.json.approvalToken);
    remove = await call('/ext/marketplace/uninstall', { key, approvalToken:remove.json.approvalToken });
    check('approved uninstall removes the extension package', remove.status === 200 && remove.json.ok === true);
    const after = await call('/ext/marketplace/installed');
    check('installed registry is empty after uninstall', after.json.items?.length === 0);
    console.log('\nVS Code Marketplace server integration: 10/10 passed');
  } finally {
    server.kill();
    fs.rmSync(data, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
