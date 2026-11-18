'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const support = require('./vscode-extension-support.cjs');

function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); } return (c ^ 0xffffffff) >>> 0; }
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(value), comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42); ch.writeUInt16LE(0x0314, 4); const mode = /\.(?:bin|exe|sh)$/i.test(name) ? 0o100755 : 0o100644; ch.writeUInt32LE((mode << 16) >>> 0, 38);
    centrals.push(ch, n); offset += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), local = Buffer.concat(locals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, end]);
}
let checkCount = 0;
function check(name, ok) { assert.ok(ok, name); checkCount++; console.log('PASS ' + name); }
function makePackage(id = 'codespace-test.node-smoke', version = '1.0.0', main = '') {
  const name = id.split('.').slice(1).join('.');
  const publisher = id.split('.')[0];
  const pkg = { name, displayName: 'CodeSpace Node host smoke test', publisher, version, engines: { vscode: '^1.80.0' }, main: './out/main.js', contributes: { commands: [{ command: id + '.inspect', title: 'Inspect workspace and host boundaries' }], configuration: { title: 'Node host smoke', properties: { [id + '.greeting']: { type: 'string', default: 'from-manifest-default' } } } } };
  return { pkg, id, version, name, publisher, main: main || `
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.activate = function () {
  vscode.commands.registerCommand(${JSON.stringify(id + '.inspect')}, async function () {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'hello.txt')));
    const configDefault = vscode.workspace.getConfiguration(${JSON.stringify(id)}).get('greeting', 'missing');
    let writeDenied = false; try { await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(root, 'created-by-extension.txt')), Buffer.from('extension write')); } catch (e) { writeDenied = /File editing|permission/i.test(e.message); }
    let readDenied = false; try { fs.readFileSync(path.join(root, '..', 'outside.txt'), 'utf8'); } catch (e) { readDenied = e.code === 'ERR_ACCESS_DENIED'; }
    const moduleName = 'node:' + 'child_process'; let childShim = false, childExecBlocked = false; try { const cp = require(moduleName); childShim = typeof cp.spawn === 'function' && typeof cp.execFile === 'function'; try { cp.exec('echo unsafe'); } catch (e) { childExecBlocked = /not supported/.test(e.message); } } catch {}
    let builtinShim = false; try { const cp = process.getBuiltinModule(moduleName); builtinShim = typeof cp.spawn === 'function'; } catch (e) {}
    let socketBlocked = false; try { require('node:net').createConnection({ host:'example.com', port:443 }); } catch (e) { socketBlocked = /Socket networking is disabled/.test(e.message); }
    let processSignalBlocked = false; try { process['ki' + 'll'](process.pid, 0); } catch (e) { processSignalBlocked = /unavailable/.test(e.message); }
    let debugSignalBlocked = false; try { process['_' + 'debugProcess'](process.ppid); } catch (e) { debugSignalBlocked = /unavailable/.test(e.message); }
    return { text: doc.getText(), configDefault, writeDenied, readDenied, childShim, childExecBlocked, builtinShim, socketBlocked, processSignalBlocked, debugSignalBlocked, webSocketDisabled: typeof globalThis['Web' + 'Socket'] === 'undefined' };
  });
};
` };
}

async function runnerTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codespace-node-host-'));
  const ext = path.join(temp, 'extension'), state = path.join(temp, 'state'), workspace = path.join(temp, 'workspace');
  fs.mkdirSync(ext); fs.mkdirSync(state); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'workspace rpc works');
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'must remain inaccessible');
  const marketplaceUi = fs.readFileSync(path.join(__dirname, 'src-js/24-vscode-marketplace.js'), 'utf8');
  check('installed extension manager provides a stop control for running debugger sessions', /function vscodeRenderNodeDebugSessions/.test(marketplaceUi) && /\/ext\/marketplace\/node\/debug\/stop/.test(marketplaceUi));
  const fixture = makePackage();
  fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify(fixture.pkg));
  fs.mkdirSync(path.join(ext, 'out'));
  fs.writeFileSync(path.join(ext, 'out', 'main.js'), fixture.main);
  const runner = path.resolve(__dirname, 'vscode-node-extension-host.cjs');
  const args = ['--permission', '--max-old-space-size=256', `--allow-fs-read=${ext}`, `--allow-fs-read=${runner}`, `--allow-fs-read=${state}`, `--allow-fs-write=${state}`, '--disable-proto=throw', '--disallow-code-generation-from-strings', runner, ext, 'out/main.js', 'a'.repeat(24), workspace, state, fixture.id];
  const child = spawn(process.execPath, args, { cwd: ext, env: { PATH: process.env.PATH || '', TEMP: os.tmpdir(), TMP: os.tmpdir() }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const messages = []; let buf = '', stderr = '';
  child.stdout.on('data', c => { /* stdout is captured, never forwarded to the parent terminal */ });
  child.stderr.on('data', c => { stderr += c.toString('utf8'); });
  child.stdio[3].setEncoding('utf8');
  const commandResult = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Node extension host integration timed out. ' + stderr)), 12000);
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Node extension host exited with code ' + code + ': ' + stderr)); });
    child.stdio[3].on('data', chunk => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1); if (!line) continue;
        const m = JSON.parse(line); messages.push(m);
        if (m.type === 'rpc') {
          const result = m.method === 'workspace.openTextDocument' ? { text: 'workspace rpc works', languageId: 'txt' } : { ok: true };
          child.stdin.write(JSON.stringify({ type: 'rpcResult', requestId: m.requestId, result }) + '\n');
        } else if (m.type === 'ready') {
          child.stdin.write(JSON.stringify({ type: 'runCommand', requestId: 'node-check-1', command: fixture.id + '.inspect', args: [] }) + '\n');
        } else if (m.type === 'commandResult' && m.requestId === 'node-check-1') {
          clearTimeout(timer);
          if (m.error) reject(new Error(m.error)); else resolve(m.result);
          child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        }
      }
    });
  });
  try {
    const result = await commandResult;
    check('Node extension activates and registers a VS Code command', messages.some(x => x.type === 'ready' && x.commands.includes(fixture.id + '.inspect')));
    check('Node host routes workspace document reads through CodeSpace RPC', result.text === 'workspace rpc works');
    check('Node host reads default settings from the extension manifest', result.configDefault === 'from-manifest-default');
    check('Node host routes workspace writes through the CodeSpace filesystem RPC', result.writeDenied === false);
    check('Node permission model blocks direct reads outside extension/state folders', result.readDenied === true);
    check('CommonJS child_process imports are replaced with the permission-managed CodeSpace process bridge', result.childShim === true && result.childExecBlocked === true);
    check('process.getBuiltinModule also returns the managed child_process bridge', result.builtinShim === true);
    check('global WebSocket transport is disabled in the Node host', result.webSocketDisabled === true);
    check('process kill and inspector signalling are disabled in the extension process', result.processSignalBlocked === true && result.debugSignalBlocked === true);
    await new Promise(resolve => child.once('exit', resolve));
    check('Node extension deactivates and host process exits cleanly', messages.some(x => x.type === 'stopped'));
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function esmRunnerTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codespace-esm-host-'));
  const ext = path.join(temp, 'extension'), state = path.join(temp, 'state'), workspace = path.join(temp, 'workspace');
  fs.mkdirSync(path.join(ext, 'out'), { recursive: true }); fs.mkdirSync(path.join(ext, 'node_modules', 'vscode'), { recursive: true }); fs.mkdirSync(state); fs.mkdirSync(workspace);
  const id='codespace-test.esm-smoke', command=id+'.inspect';
  const pkg={name:'esm-smoke',publisher:'codespace-test',version:'1.0.0',displayName:'CodeSpace ESM smoke',type:'module',main:'./out/main.mjs',engines:{vscode:'^1.80.0'},contributes:{commands:[{command,title:'Inspect ESM host'}]}};
  fs.writeFileSync(path.join(ext,'package.json'),JSON.stringify(pkg));
  fs.writeFileSync(path.join(ext,'node_modules','vscode','package.json'),JSON.stringify({name:'vscode',version:'1.90.0-codespace',type:'module',exports:{import:'./index.mjs'}}));
  fs.writeFileSync(path.join(ext,'node_modules','vscode','index.mjs'),`const api=globalThis.__codespaceVscode; export default api; export const commands=api.commands;`);
  fs.writeFileSync(path.join(ext,'out','main.mjs'),`import vscode,{commands} from 'vscode'; import {spawn} from 'node:child_process'; import {createConnection} from 'node:net'; export function activate(){commands.registerCommand(${JSON.stringify(command)},()=>{let socketBlocked=false;try{createConnection({host:'example.com',port:443});}catch(e){socketBlocked=/Socket networking is disabled/.test(e.message);}return {defaultApi:!!vscode.commands,namedApi:typeof commands.registerCommand==='function',managedSpawn:typeof spawn==='function',socketBlocked};});}`);
  const runner=path.resolve(__dirname,'vscode-node-extension-host.cjs'), key='b'.repeat(24);
  const args=['--permission','--max-old-space-size=256',`--allow-fs-read=${ext}`,`--allow-fs-read=${runner}`,`--allow-fs-read=${state}`,`--allow-fs-write=${state}`,'--disable-proto=throw','--disallow-code-generation-from-strings',runner,ext,'out/main.mjs',key,workspace,state,id,'0'];
  const child=spawn(process.execPath,args,{cwd:ext,env:{PATH:process.env.PATH||'',TEMP:os.tmpdir(),TMP:os.tmpdir()},stdio:['pipe','pipe','pipe','pipe']});
  let buf='',stderr=''; const messages=[];
  child.stderr.on('data',c=>stderr+=c.toString('utf8')); child.stdio[3].setEncoding('utf8');
  try {
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('ESM extension host test timed out: '+stderr)),12000);
      child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('ESM host exited '+code+': '+stderr));});
      child.stdio[3].on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\n'))>=0){const line=buf.slice(0,at);buf=buf.slice(at+1);if(!line)continue;const m=JSON.parse(line);messages.push(m);if(m.type==='ready')child.stdin.write(JSON.stringify({type:'runCommand',requestId:'esm-1',command,args:[]})+'\n');else if(m.type==='commandResult'&&m.requestId==='esm-1'){clearTimeout(timer);m.error?reject(new Error(m.error)):resolve(m.result);child.stdin.write(JSON.stringify({type:'shutdown'})+'\n');}}});
    });
    check('ES module extension loads through the CodeSpace VS Code ESM shim',messages.some(m=>m.type==='ready'&&m.commands.includes(command)));
    check('ESM named imports receive the CodeSpace VS Code API, managed child_process bridge and socket-denying net shim',result.defaultApi&&result.namedApi&&result.managedSpawn&&result.socketBlocked);
    await new Promise(resolve=>child.once('exit',resolve));
  } finally { if(child.exitCode===null)child.kill(); fs.rmSync(temp,{recursive:true,force:true}); }
}

async function serverIntegrationTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codespace-node-host-server-'));
  const workspace = path.join(temp, 'workspace'), data = path.join(temp, 'data'); fs.mkdirSync(workspace); fs.mkdirSync(data);
  fs.writeFileSync(path.join(workspace, 'hello.txt'), 'server workspace rpc works');
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'private file outside workspace');
  fs.writeFileSync(path.join(data, 'permissions.json'), JSON.stringify({ ext: 'ask', destructive: 'ask', fsEdit: 'deny' }));
  const port = 20000 + Math.floor(Math.random() * 10000), token = 'codespace-node-' + crypto.randomBytes(12).toString('hex');
  const fixture = makePackage('codespace-test.node-server-smoke', '1.0.0');
  const payload = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main });
  const key = crypto.createHash('sha256').update(fixture.id + '@' + fixture.version).digest('hex').slice(0, 24);
  const candidateDir = path.join(data, 'vscode-extension-candidates'); fs.mkdirSync(candidateDir, { recursive: true }); fs.writeFileSync(path.join(candidateDir, key + '.vsix'), payload);
  const server = spawn(process.execPath, [path.join(__dirname, 'agent-server.js'), workspace, '--port', String(port), '--token', token], { cwd: __dirname, env: { ...process.env, MY_AGENT_DATA_DIR: data, MY_AGENT_DISABLE_EXTERNAL_BROWSER: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; server.stderr.on('data', c => { stderr += c.toString('utf8').slice(-5000); });
  const base = 'http://127.0.0.1:' + port;
  const call = async (endpoint, body = {}, auth = token) => {
    const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => ({})) };
  };
  async function approve(endpoint, body) {
    let r = await call(endpoint, body);
    if (r.json.needsApproval) r = await call(endpoint, { ...body, approvalToken: r.json.approvalToken });
    return r;
  }
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { const r = await call('/info'); if (r.status === 200) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 125)); }
    check('real CodeSpace Agent Server starts with an opened workspace', ready);
    const inspected = support.inspectVsixForCodeSpace(payload);
    check('Node VSIX passes manifest, API and entry-point compatibility inspection', inspected.compatible && inspected.hostType === 'node' && inspected.mainPath === 'out/main.js');
    const installed = await approve('/ext/marketplace/install', { id: fixture.id, version: fixture.version });
    check('Node VSIX installs only after the extension permission approval', installed.status === 200 && installed.json.ok === true && installed.json.hostType === 'node');
    const list = await call('/ext/marketplace/installed');
    check('installed extension registry identifies the Node.js host type', list.json.items?.some(x => x.key === key && x.hostType === 'node'));
    const started = await approve('/ext/marketplace/node/activate', { key });
    check('Node extension activation requires and consumes a permission approval', started.status === 200 && started.json.ok === true && started.json.state === 'running');
    const command = await call('/ext/marketplace/node/command', { key, command: fixture.id + '.inspect', args: [] });
    const result = command.json.result || {};
    check('Node extension command can read an opened workspace document through RPC', command.status === 200 && result.text === 'server workspace rpc works');
    check('Node extension reads manifest-provided configuration defaults', result.configDefault === 'from-manifest-default');
    check('Node extension cannot write workspace files when File editing is denied', result.writeDenied === true && !fs.existsSync(path.join(workspace, 'created-by-extension.txt')));
    check('Node extension child cannot read files outside its extension and private state folders', result.readDenied === true);
    check('Node extension process creation uses the CodeSpace child-process bridge', result.childShim === true && result.builtinShim === true);
    check('Socket creation remains blocked while the net shim permits stdio language-client imports', result.socketBlocked === true && result.webSocketDisabled === true);
    check('Node extension cannot signal the CodeSpace server process or enable its inspector', result.processSignalBlocked === true && result.debugSignalBlocked === true);
    const stopped = await call('/ext/marketplace/node/stop', { key });
    check('Node extension host can be stopped through the local server API', stopped.status === 200 && stopped.json.stopped === true);
    const remove = await approve('/ext/marketplace/uninstall', { key });
    check('approved uninstall removes the running Node extension package', remove.status === 200 && remove.json.ok === true);
    const after = await call('/ext/marketplace/installed');
    check('Node extension is absent from the installed registry after uninstall', !after.json.items?.some(x => x.key === key));
    console.log('\nVS Code Node Extension Host integration: 14/14 checks passed');
  } finally {
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) return resolve(); server.once('exit', resolve); setTimeout(resolve, 1500).unref(); });
    fs.rmSync(temp, { recursive: true, force: true });
    if (stderr && /SyntaxError|ReferenceError|Unhandled/i.test(stderr)) console.error('Agent Server stderr:', stderr);
  }
}

async function advancedHostIntegrationTest() {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codespace-extension-advanced-'));
  const workspace=path.join(temp,'workspace'),data=path.join(temp,'data');fs.mkdirSync(workspace);fs.mkdirSync(data);
  fs.writeFileSync(path.join(workspace,'hello.txt'),'language server workspace document');
  fs.writeFileSync(path.join(data,'permissions.json'),JSON.stringify({ext:'ask',destructive:'ask',fsEdit:'deny',terminal:'allow',nativeCode:'ask'}));
  const id='codespace-test.advanced-host',version='1.0.0',key=crypto.createHash('sha256').update(id+'@'+version).digest('hex').slice(0,24);
  const pkg={name:'advanced-host',publisher:'codespace-test',displayName:'CodeSpace Advanced Host Test',version,engines:{vscode:'^1.80.0'},main:'./out/main.js',contributes:{commands:[{command:id+'.advanced',title:'Run advanced host checks'}],debuggers:[{type:'codespace-fake',label:'CodeSpace fake DAP'}],views:{codespace:[{id:id+'.webview',name:'CodeSpace Webview',type:'webview'}]}}};
  const main=`exports.activate=function(){ const vscode=require('vscode'); const cp=require('child_process');
const id=${JSON.stringify(id)};
vscode.languages.registerCompletionItemProvider({language:'txt'},{provideCompletionItems(){return [{label:'codespace-language-server-completion',insertText:'codespace-complete'}];}});
const diagnostics=vscode.languages.createDiagnosticCollection('codespace-test');
diagnostics.set(vscode.Uri.file(require('node:path').join(${JSON.stringify(workspace)},'hello.txt')),[new vscode.Diagnostic(new vscode.Range(new vscode.Position(0,0),new vscode.Position(0,1)),'test diagnostic',vscode.DiagnosticSeverity.Warning)]);
vscode.window.registerWebviewViewProvider(id+'.webview',{resolveWebviewView(view){view.webview.html='<h1>Contributed webview ready</h1>';}});
vscode.debug.registerDebugAdapterDescriptorFactory('codespace-fake',{createDebugAdapterDescriptor(){return new vscode.DebugAdapterExecutable(process.execPath,['fake-dap.js'],{cwd:__dirname});}});
vscode.commands.registerCommand(id+'.advanced',async()=>{
 const terminal=vscode.window.createTerminal({name:'CodeSpace Extension Terminal'}); terminal.show(); const pid=await terminal.processId;
 const panel=vscode.window.createWebviewPanel('codespace-test-panel','CodeSpace Test Panel',1,{enableScripts:false}); panel.webview.html='<h1>Panel HTML ready</h1>';
 const lsp=cp.spawn(process.execPath,['fake-lsp.js'],{cwd:__dirname}); let buf=Buffer.alloc(0); let pendingResolve; const init=new Promise(resolve=>pendingResolve=resolve);
 lsp.stdout.on('data',chunk=>{buf=Buffer.concat([buf,Buffer.from(chunk)]);while(true){const at=buf.indexOf('\\r\\n\\r\\n');if(at<0)break;const head=buf.subarray(0,at).toString();const m=head.match(/Content-Length:\\s*(\\d+)/i);if(!m)break;const len=Number(m[1]);if(buf.length<at+4+len)break;const body=JSON.parse(buf.subarray(at+4,at+4+len).toString());buf=buf.subarray(at+4+len);if(body.id===1)pendingResolve(body.result&&body.result.capabilities||{});}});
 const payload=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{processId:process.pid,rootUri:null,capabilities:{}}})); lsp.stdin.write(Buffer.concat([Buffer.from('Content-Length: '+payload.length+'\\r\\n\\r\\n'),payload]));
 const caps=await Promise.race([init,new Promise(resolve=>setTimeout(()=>resolve(null),5000))]);
 const native=cp.execFile(${JSON.stringify(process.platform==='win32'?'cmd.exe':'echo.bin')},${JSON.stringify(process.platform==='win32'?['/c','echo','native-process-ok']:['native-process-ok'])},{cwd:__dirname}); let nativeOut='';native.stdout.on('data',c=>nativeOut+=c.toString());await new Promise(resolve=>native.once('close',resolve));
 await vscode.debug.startDebugging(undefined,{type:'codespace-fake',name:'Fake debug',request:'launch'});
 return {terminal:!!pid,lspInitialized:!!caps&&caps.textDocumentSync===1,nativeOutput:nativeOut.trim(),debugStarted:true,webviewPanel:panel.viewType};
}); };`;
  const fakeLsp=`let buf=Buffer.alloc(0);let seq=1;function send(v){const b=Buffer.from(JSON.stringify(v));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b);}process.stdin.on('data',c=>{buf=Buffer.concat([buf,c]);while(true){const at=buf.indexOf('\\r\\n\\r\\n');if(at<0)break;const m=buf.subarray(0,at).toString().match(/Content-Length:\\s*(\\d+)/i);if(!m)break;const len=Number(m[1]);if(buf.length<at+4+len)break;const msg=JSON.parse(buf.subarray(at+4,at+4+len).toString());buf=buf.subarray(at+4+len);if(msg.method==='initialize')send({jsonrpc:'2.0',id:msg.id,result:{capabilities:{textDocumentSync:1,completionProvider:{}}}});else if(msg.method==='shutdown')send({jsonrpc:'2.0',id:msg.id,result:null});}});`;
  const fakeDap=`let buf=Buffer.alloc(0),seq=1;function send(v){const b=Buffer.from(JSON.stringify(v));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b);}process.stdin.on('data',c=>{buf=Buffer.concat([buf,c]);while(true){const at=buf.indexOf('\\r\\n\\r\\n');if(at<0)break;const m=buf.subarray(0,at).toString().match(/Content-Length:\\s*(\\d+)/i);if(!m)break;const len=Number(m[1]);if(buf.length<at+4+len)break;const msg=JSON.parse(buf.subarray(at+4,at+4+len).toString());buf=buf.subarray(at+4+len);if(msg.type==='request'){send({seq:seq++,type:'response',request_seq:msg.seq,success:true,command:msg.command,body:{capabilities:{}}});if(msg.command==='initialize')send({seq:seq++,type:'event',event:'initialized',body:{}});}}});`;
  const files={'extension/package.json':JSON.stringify(pkg),'extension/out/main.js':main,'extension/out/fake-lsp.js':fakeLsp,'extension/out/fake-dap.js':fakeDap,'extension/out/echo.bin':fs.existsSync('/bin/echo')?fs.readFileSync('/bin/echo'):Buffer.from('not-supported-on-this-host'),'extension/native/addon.node':Buffer.from([1,2,3])};
  if(fs.existsSync('/bin/echo'))files['extension/out/echo.bin']=fs.readFileSync('/bin/echo');
  const payload=zip(files),candidateDir=path.join(data,'vscode-extension-candidates');fs.mkdirSync(candidateDir,{recursive:true});fs.writeFileSync(path.join(candidateDir,key+'.vsix'),payload);
  if(fs.existsSync('/bin/echo'))fs.chmodSync(path.join(candidateDir,key+'.vsix'),0o644);
  const port=26000+Math.floor(Math.random()*1000),token='codespace-advanced-'+crypto.randomBytes(10).toString('hex');
  const server=spawn(process.execPath,[path.join(__dirname,'agent-server.js'),workspace,'--port',String(port),'--token',token],{cwd:__dirname,env:{...process.env,MY_AGENT_DATA_DIR:data,MY_AGENT_DISABLE_EXTERNAL_BROWSER:'1'},stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',c=>stderr+=c.toString('utf8').slice(-8000));
  const base='http://127.0.0.1:'+port,call=async(endpoint,body={})=>{const r=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});return{status:r.status,json:await r.json().catch(()=>({}))};};
  async function approve(endpoint,body){let r=await call(endpoint,body);if(r.json.needsApproval)r=await call(endpoint,{...body,approvalToken:r.json.approvalToken});return r;}
  try{
    let ready=false;for(let i=0;i<80;i++){try{if((await call('/info')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,125));}check('advanced extension test starts the real CodeSpace server',ready);
    const inspect=support.inspectVsixForCodeSpace(payload);check('advanced extension manifest passes support checks for debugger, contributed webview and native code',inspect.compatible&&inspect.requiresNativeAddons&&inspect.requiresNativeCode&&inspect.nativeBinaries.includes('out/echo.bin')&&inspect.contributions.includes('debuggers'));
    const installed=await approve('/ext/marketplace/install',{id,version});check('advanced Node extension installs through the marketplace approval gate',installed.status===200&&installed.json.ok===true);
    let started=await approve('/ext/marketplace/node/activate',{key});check('native add-on activation is refused until Native extension code is allowed',started.status>=400&&/native binaries or Node add-ons/i.test(started.json.error||''));
    const perm=await call('/perm/set',{permissions:{nativeCode:'allow'}});check('Native extension code permission can be explicitly enabled',perm.status===200&&perm.json.permissions.nativeCode==='allow');
    started=await approve('/ext/marketplace/node/activate',{key});check('Node host activates after native code and extension permission approvals',started.status===200&&started.json.state==='running');
    await call('/ext/marketplace/node/document',{key,event:'open',path:'hello.txt',text:'hello language feature',languageId:'txt',version:1});
    const features=await call('/ext/marketplace/node/status',{key});check('extension registers language completion and a contributed webview provider',features.json.features?.some(x=>x.name==='completion')&&features.json.viewProviders?.some(x=>x.viewType===id+'.webview'));
    const completion=await call('/ext/marketplace/node/feature',{key,feature:'completion',params:{path:'hello.txt',text:'hello language feature',languageId:'txt',line:0,character:5,version:1}});check('CodeSpace requests completion results from the active language extension',completion.json.results?.some(x=>x.label==='codespace-language-server-completion'));
    check('extension diagnostics are reported to the Agent Server',features.json.diagnostics?.length>0);
    await call('/ext/marketplace/node/view/open',{key,viewType:id+'.webview'});await new Promise(r=>setTimeout(r,350));
    const afterView=await call('/ext/marketplace/node/status',{key});check('contributed webview providers open a working extension webview',afterView.json.webviews?.some(x=>String(x.html).includes('Contributed webview ready')));
    const command=await call('/ext/marketplace/node/command',{key,command:id+'.advanced',args:[]});const result=command.json.result||{};
    check('extension terminal API creates a managed CodeSpace terminal',command.status===200&&result.terminal===true);
    check('language server process launches and completes its LSP initialize handshake',result.lspInitialized===true);
    check('native executable runs only after the explicit native-code permission',result.nativeOutput==='native-process-ok');
    check('debugger API launches a managed DAP adapter and completes initialize/launch',result.debugStarted===true);
    const status=await call('/ext/marketplace/node/status',{key});check('Agent Server tracks active terminal, webview and DAP debug session state',status.json.terminalIds?.length>0&&status.json.webviews?.length>0&&status.json.debugSessions?.length>0);
    const debugSession=status.json.debugSessions[0];const debugStop=await call('/ext/marketplace/node/debug/stop',{key,sessionId:debugSession.sessionId});await new Promise(r=>setTimeout(r,400));const afterDebugStop=await call('/ext/marketplace/node/status',{key});check('CodeSpace can stop an active DAP debugger from the extension manager',debugStop.status===200&&afterDebugStop.json.debugSessions?.length===0);
    await call('/ext/marketplace/node/stop',{key});const remove=await approve('/ext/marketplace/uninstall',{key});check('advanced extension resources are stopped and package uninstalls',remove.status===200&&remove.json.ok===true);
    console.log('\nAdvanced extension API integration: 14/14 checks passed');
  }finally{server.kill();await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);setTimeout(resolve,1500).unref();});fs.rmSync(temp,{recursive:true,force:true});if(stderr&&/SyntaxError|ReferenceError|Unhandled/i.test(stderr))console.error(stderr);}
}

(async () => {
  const fixture = makePackage();
  const good = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main });
  const info = support.inspectVsixForCodeSpace(good);
  check('Node-compatible extension is classified as Node.js host', info.compatible && info.hostType === 'node');
  check('Node compatibility result exposes its API and command metadata', info.compatible && info.mainPath === 'out/main.js' && info.commands[0].command === fixture.id + '.inspect');
  const badNetwork = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main, 'extension/node_modules/dependency.js': "const client = require('node:https'); module.exports = client;" });
  check('unsupported networking dependency is excluded even outside the main entry point', !support.inspectVsixForCodeSpace(badNetwork).compatible);
  const badNative = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main, 'extension/native/addon.node': Buffer.from([1, 2, 3]) });
  const nativeInfo = support.inspectVsixForCodeSpace(badNative);
  check('native Node add-on extensions are supported behind an explicit native-code permission', nativeInfo.compatible && nativeInfo.requiresNativeAddons === true && nativeInfo.nativeAddons.includes('native/addon.node') && nativeInfo.requiresNativeCode === true);
  const nativeExeInfo=support.inspectVsixForCodeSpace(zip({'extension/package.json':JSON.stringify(fixture.pkg),'extension/out/main.js':fixture.main,'extension/bin/helper.exe':Buffer.from('MZ-native-test')}));
  check('bundled native executables are detected and gated by native-code permission',nativeExeInfo.compatible&&nativeExeInfo.requiresNativeCode===true&&nativeExeInfo.nativeBinaries.includes('bin/helper.exe'));
  const badContribution = { ...fixture.pkg, contributes: { ...fixture.pkg.contributes, debuggers: [{ type: 'node' }] } };
  const unsupported = zip({ 'extension/package.json': JSON.stringify(badContribution), 'extension/out/main.js': fixture.main });
  check('debugger contribution points are admitted when the extension uses the managed debugger API', support.inspectVsixForCodeSpace(unsupported).compatible && support.inspectVsixForCodeSpace(unsupported).contributions.includes('debuggers'));
  const debugSignal = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main.replace('exports.activate', "process._debugProcess(process.ppid); exports.activate") });
  check('direct process inspector signalling is excluded during compatibility inspection', !support.inspectVsixForCodeSpace(debugSignal).compatible);
  const esmPkg = { ...fixture.pkg, type: 'module', main: './out/main.mjs' };
  const esmSource = "import vscode, { commands } from 'vscode'; import { spawn } from 'node:child_process'; export function activate(){ commands.registerCommand('codespace-test.esm',()=>({defaultApi:!!vscode.commands,namedApi:typeof commands.registerCommand==='function',managedSpawn:typeof spawn==='function'})); }";
  const esmInfo = support.inspectVsixForCodeSpace(zip({ 'extension/package.json': JSON.stringify(esmPkg), 'extension/out/main.mjs': esmSource }));
  check('ES module extensions using VS Code named imports and managed child_process pass compatibility inspection', esmInfo.compatible && esmInfo.moduleType === 'module');
  const treeViewPkg = { ...fixture.pkg, contributes: { ...fixture.pkg.contributes, views: { explorer: [{ id: 'codespace.tree', name: 'Tree', type: 'tree' }] } } };
  check('custom TreeDataProvider views remain excluded until their provider API is implemented', !support.inspectVsixForCodeSpace(zip({ 'extension/package.json': JSON.stringify(treeViewPkg), 'extension/out/main.js': fixture.main })).compatible);
  const unsupportedWorkspaceApi = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main.replace('exports.activate', "const unsupported = vscode.workspace.getWorkspaceFolder; exports.activate") });
  check('extensions requiring an unimplemented workspace API are excluded from marketplace compatibility', !support.inspectVsixForCodeSpace(unsupportedWorkspaceApi).compatible);
  const terminalProfilePkg = { ...fixture.pkg, contributes: { ...fixture.pkg.contributes, terminal: { profiles: [{ title: 'Custom shell', id: 'codespace-test.profile' }] } } };
  check('terminal-profile contributions are excluded until their provider API is implemented', !support.inspectVsixForCodeSpace(zip({ 'extension/package.json': JSON.stringify(terminalProfilePkg), 'extension/out/main.js': fixture.main })).compatible);
  const fakeDebugServer = zip({ 'extension/package.json': JSON.stringify(fixture.pkg), 'extension/out/main.js': fixture.main.replace('exports.activate', 'const unsupported = vscode.DebugAdapterServer; exports.activate') });
  check('TCP DebugAdapterServer descriptors remain excluded while managed stdio debugger adapters are supported', !support.inspectVsixForCodeSpace(fakeDebugServer).compatible);
  check('VS Code engine range is enforced for Node extensions', !support.inspectVsixForCodeSpace(zip({ 'extension/package.json': JSON.stringify({ ...fixture.pkg, engines: { vscode: '^1.100.0' } }), 'extension/out/main.js': fixture.main })).compatible);
  await runnerTest();
  await esmRunnerTest();
  await serverIntegrationTest();
  await advancedHostIntegrationTest();
  console.log(`\nVS Code Node Extension Host verification: ${checkCount}/${checkCount} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
