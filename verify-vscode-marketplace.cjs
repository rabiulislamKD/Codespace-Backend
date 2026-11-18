'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const vm = require('vm');
const support = require('./vscode-extension-support.cjs');
function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); } return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(value), comp = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, n); off += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), local = Buffer.concat(locals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, end]);
}
const pkg = { name:'codespace-smoke', displayName:'CodeSpace smoke test', publisher:'codespace-test', version:'1.0.0', engines:{vscode:'^1.80.0'}, browser:'./dist/web/extension.js', contributes:{commands:[{command:'codespace-smoke.hello',title:'Hello from test'}]} };
const good = zip({ 'extension/package.json': JSON.stringify(pkg), 'extension/dist/web/extension.js': "const vscode = require('vscode'); exports.activate = function(){ vscode.commands.registerCommand('codespace-smoke.hello', function(){ vscode.window.showInformationMessage('Hello'); }); };" });
const result = support.inspectVsix(good);
assert.equal(result.compatible, true, result.reason);
assert.equal(result.browserPath, 'dist/web/extension.js');
assert.equal(result.commands[0].command, 'codespace-smoke.hello');
const treePkg = { ...pkg, contributes:{...pkg.contributes, views:{explorer:[{id:'codespace-smoke.tree',name:'Smoke Tree'}]}} };
const treeVsix = zip({ 'extension/package.json':JSON.stringify(treePkg), 'extension/dist/web/extension.js':"const vscode=require('vscode'); exports.activate=()=>{vscode.commands.registerCommand('codespace-smoke.hello',()=>{});vscode.window.registerTreeDataProvider('codespace-smoke.tree',{getChildren:()=>[{label:'Root item'}],getTreeItem:item=>item});};" });
const treeResult=support.inspectVsix(treeVsix);
assert.equal(treeResult.compatible,true,treeResult.reason);
assert.ok(treeResult.supportedApi.includes('window.registerTreeDataProvider'));
assert.equal(support.engineCompatible('^1.80.0'), true);
assert.equal(support.engineCompatible('^1.100.0'), false);
assert.equal(support.registryIdentityMatches(result, { namespace:'codespace-test', name:'codespace-smoke', version:'1.0.0' }), true);
assert.equal(support.registryIdentityMatches(result, { namespace:'someone-else', name:'codespace-smoke', version:'1.0.0' }), false);
assert.equal(support.registryIdentityMatches(result, { namespace:'codespace-test', name:'codespace-smoke', version:'2.0.0' }), false);
const badNode = zip({ 'extension/package.json': JSON.stringify({ ...pkg, browser: undefined, main:'./out/node.js' }), 'extension/package.json': JSON.stringify({ ...pkg, browser: '', main:'./out/node.js' }) });
assert.equal(support.inspectVsix(badNode).compatible, false);
const badApi = zip({ 'extension/package.json': JSON.stringify(pkg), 'extension/dist/web/extension.js': "const vscode=require('vscode'); exports.activate=()=>vscode.window.createWebviewPanel('x','x',1,{});" });
assert.equal(support.inspectVsix(badApi).compatible, false);
const badNet = zip({ 'extension/package.json': JSON.stringify(pkg), 'extension/dist/web/extension.js': "const vscode=require('vscode'); exports.activate=()=>fetch('https://example.com');" });
assert.equal(support.inspectVsix(badNet).compatible, false);
const badEntry = zip({ 'extension/package.json': JSON.stringify({ ...pkg, browser:'./dist/web/extension.mjs' }), 'extension/dist/web/extension.mjs': "const vscode=require('vscode'); exports.activate=()=>vscode.commands.registerCommand('x.y',()=>{});" });
assert.equal(support.inspectVsix(badEntry).compatible, false);
const workerGlobal = zip({ 'extension/package.json': JSON.stringify(pkg), 'extension/dist/web/extension.js': "const vscode=require('vscode'); exports.activate=()=>{ const target=self; vscode.commands.registerCommand('codespace-smoke.hello',()=>{}); };" });
assert.equal(support.inspectVsix(workerGlobal).compatible, false);
const badCrc = Buffer.from(good); const cdAt = badCrc.readUInt32LE(badCrc.length - 6); badCrc[cdAt + 16] ^= 0xff; assert.throws(() => support.readEntry(badCrc, 'extension/package.json'), /checksum/i);
const zipSlip = zip({ '../evil.txt': 'nope', 'extension/package.json': JSON.stringify(pkg), 'extension/dist/web/extension.js': "const vscode=require('vscode'); exports.activate=()=>vscode.commands.registerCommand('x.y',()=>{});" });
assert.throws(() => support.extractVsix(zipSlip, path.join(os.tmpdir(), 'cs-vsix-slip')), /Unsafe VSIX entry path/i);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vsix-'));
try {
  const extracted = support.extractVsix(good, path.join(tmp, 'out'));
  assert.equal(extracted.name, 'codespace-smoke');
  assert.ok(fs.existsSync(path.join(tmp, 'out', 'dist', 'web', 'extension.js')));
} finally { fs.rmSync(tmp, { recursive:true, force:true }); }
const appModule = fs.readFileSync(path.join(__dirname, 'src-js/24-vscode-marketplace.js'), 'utf8');
const workerFn = appModule.slice(appModule.indexOf('function vscodeWorkerSource(ext)'), appModule.indexOf('\nfunction vscodeHostStop'));
const template = workerFn.match(/return `([\s\S]*)`;\n}/);
assert.ok(template, 'worker source template exists');
const workerSource = template[1].replaceAll('${JSON.stringify(ext.id)}', JSON.stringify('publisher.extension')).replaceAll('${JSON.stringify(entry)}', JSON.stringify('https://127.0.0.1/extension.js'));
new vm.Script(workerSource, { filename: 'codespace-extension-worker.js' });
(async () => {
  const messages = [];
  const context = { navigator: { language:'en' }, postMessage: message => messages.push(message) };
  context.self = context;
  vm.createContext(context);
  context.importScripts = () => vm.runInContext("const vscode = require('vscode'); exports.activate = function(){ vscode.commands.registerCommand('codespace-smoke.hello', function(){ vscode.window.showInformationMessage('Hello from runtime'); return 'runtime-ok'; }); vscode.window.registerTreeDataProvider('codespace-smoke.tree',{getChildren:()=>[{label:'Root item'}],getTreeItem:item=>item}); };", context);
  vm.runInContext(workerSource, context, { filename:'codespace-extension-worker.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(x => x.type === 'commandRegistered' && x.command === 'codespace-smoke.hello'));
  assert.ok(messages.some(x => x.type === 'activated'));
  assert.ok(messages.some(x => x.type === 'treeData' && x.viewId === 'codespace-smoke.tree' && x.items[0].label === 'Root item'));
  await context.onmessage({ data:{ type:'runCommand', command:'codespace-smoke.hello', args:[], requestId:'smoke-1' } });
  assert.ok(messages.some(x => x.type === 'commandResult' && x.requestId === 'smoke-1' && x.result === 'runtime-ok'));
  assert.ok(messages.some(x => x.type === 'notification' && x.message.includes('Hello from runtime')));
  console.log('VS Code Marketplace compatibility checks: 24/24 passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
