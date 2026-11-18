/* 3.18.0 — CodeSpace-compatible VS Code marketplace with Web + expanded restricted Node.js Extension Hosts. */
const vscodeHosts = new Map();
let vscodeMarketplaceBusy = false;
function vscodeMktStatus(message, bad = false) {
  const el = $('extMktStatus'); if (!el) return;
  el.textContent = String(message || ''); el.style.color = bad ? 'var(--err)' : '';
}
function vscodeMktButton(label, cls, action) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm ' + (cls || ''); b.textContent = label; b.addEventListener('click', action); return b;
}
function vscodeMktRender(items) {
  const box = $('extMktResults'); if (!box) return;
  box.replaceChildren();
  (items || []).forEach(item => {
    const card = document.createElement('article'); card.className = 'ext-market-card';
    const logo = document.createElement('div'); logo.className = 'ext-market-logo';
    const iconUrl = String(item.icon || '');
    if (/^https:\/\/(?:[^/]+\.)?(?:vsassets\.io|open-vsx\.org)\//i.test(iconUrl)) {
      const img = document.createElement('img'); img.className = 'ext-market-icon'; img.alt = ''; img.loading = 'lazy'; img.src = iconUrl;
      img.onerror = () => { img.remove(); logo.textContent = String(item.displayName || item.name || '?').trim().slice(0, 1).toUpperCase(); };
      logo.appendChild(img);
    } else {
      logo.textContent = String(item.displayName || item.name || '?').trim().slice(0, 1).toUpperCase();
    }
    const title = document.createElement('div'); title.className = 'ext-market-title'; title.textContent = item.displayName || item.name || item.id;
    title.title = title.textContent;
    const install = vscodeMktButton('Install', 'primary', async () => {
      install.disabled = true; install.textContent = 'Installing…';
      try {
        const r = await bApproved('/ext/marketplace/install', { id: item.id, version: item.version }, undefined, 'Install ' + item.displayName + '?', 'ext_install', permMeta('ext', item.id));
        if (r && r.needsApproval) { install.disabled = false; install.textContent = 'Install'; return; }
        if (r && r.st === 'err') throw new Error(r.text || 'Installation was not approved');
        install.textContent = 'Installed'; install.disabled = true;
        vscodeMktStatus('Installed ' + item.displayName + ' · activating…');
        await vscodeLoadInstalled(true);
        vscodeMktStatus('Installed ' + item.displayName);
      } catch (e) { install.disabled = false; install.textContent = 'Install'; vscodeMktStatus(e.message || String(e), true); }
    });
    card.append(logo, title, install); box.appendChild(card);
  });
  if (!(items || []).length) {
    const empty = document.createElement('div'); empty.className = 'ext-vsix-installed-empty'; empty.textContent = 'No compatible extensions found'; box.appendChild(empty);
  }
}
async function vscodeMarketplaceSearch(recommended = false) {
  if (vscodeMarketplaceBusy || !B.ok) return false;
  const query = $('extMktQuery').value.trim();
  if (!recommended && !query) { vscodeMktStatus('Enter an extension name to search.'); return false; }
  vscodeMarketplaceBusy = true; $('extMktSearch').disabled = true;
  vscodeMktStatus(recommended ? 'Checking CodeSpace-compatible recommendations…' : 'Checking extension compatibility…');
  $('extMktResults').replaceChildren();
  try {
    const r = await bApproved('/ext/marketplace/search', { query: recommended ? '' : query, recommended: !!recommended, size: 30 }, undefined, 'Search the VS Code extension registry?', 'network', permMeta('network', 'Open VSX extension registry'));
    if (r && r.st === 'err') throw new Error(r.text || 'Marketplace search was not approved');
    vscodeMktRender(r.items || []);
    vscodeMktStatus((r.items || []).length ? (r.items.length + ' compatible extension' + (r.items.length === 1 ? '' : 's') + ' · Open VSX') : 'No extensions passed the CodeSpace compatibility checks.');
    return true;
  } catch (e) { vscodeMktStatus(e.message || String(e), true); }
  finally { vscodeMarketplaceBusy = false; $('extMktSearch').disabled = false; }
}
function vscodeWorkerSource(ext) {
  const base = L.bridgeUrl.replace(/\/+$/, '') + '/extension-host/assets/' + encodeURIComponent(ext.key) + '/';
  const entry = base + String(ext.browserPath || '').split('/').map(encodeURIComponent).join('/') + '?token=' + encodeURIComponent(L.bridgeToken);
  return `
'use strict';
// Keep host bootstrap names inside a closure so a normal extension bundle can declare
// top-level const/let symbols (for example a local vscode binding).
(() => {
const extensionId=${JSON.stringify(ext.id)};
const registered=new Map();
const treeProviders=new Map();
const configStore=Object.create(null);
const send=(type,data={})=>self.postMessage({type,extensionId,...data});
class Disposable{constructor(fn){this.fn=fn;}dispose(){if(this.fn){const f=this.fn;this.fn=null;f();}}}
const commands={
 registerCommand(id,handler){id=String(id);if(typeof handler!=='function')throw new Error('Command handler must be a function');registered.set(id,handler);send('commandRegistered',{command:id});return new Disposable(()=>{registered.delete(id);send('commandRemoved',{command:id});});},
 executeCommand(id,...args){const f=registered.get(String(id));return f?Promise.resolve().then(()=>f(...args)):Promise.resolve(undefined);},
 getCommands(){return Promise.resolve([...registered.keys()]);}
};
const message=(level,args)=>{send('notification',{level,message:args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ').slice(0,1000)});return Promise.resolve(undefined);};
const output=(name)=>({name,append:s=>send('output',{message:String(s)}),appendLine:s=>send('output',{message:String(s)}),clear:()=>{},replace:s=>send('output',{message:String(s)}),show:()=>{},hide:()=>{},dispose:()=>{}});
class EventEmitter{constructor(){this.listeners=new Set();this.event=fn=>{this.listeners.add(fn);return new Disposable(()=>this.listeners.delete(fn));};}fire(value){for(const fn of [...this.listeners]){try{fn(value);}catch{}}}dispose(){this.listeners.clear();}}
class TreeItem{constructor(label,collapsibleState=0){this.label=label;this.collapsibleState=collapsibleState;this.contextValue='';this.tooltip=undefined;this.description=undefined;this.iconPath=undefined;this.command=undefined;this.id=undefined;}}
const TreeItemCollapsibleState={None:0,Collapsed:1,Expanded:2};
const treeRefresh=(id)=>{const provider=treeProviders.get(String(id));if(!provider)return;Promise.resolve().then(()=>provider.getChildren(undefined)).then(items=>{const rows=(items||[]).slice(0,200).map(item=>{const t=provider.getTreeItem?provider.getTreeItem(item):item;return {label:String(t&&t.label!==undefined?t.label:item&&item.label!==undefined?item.label:item).slice(0,180),description:String(t&&t.description||'').slice(0,120),tooltip:String(t&&t.tooltip||'').slice(0,200),collapsibleState:Number(t&&t.collapsibleState||0),command:t&&t.command?{command:String(t.command.command||''),title:String(t.command.title||'').slice(0,100),arguments:Array.isArray(t.command.arguments)?t.command.arguments.slice(0,5):[]}:null};});send('treeData',{viewId:String(id),items:rows});}).catch(e=>send('treeError',{viewId:String(id),error:String(e&&e.message||e)}));};
let rpcSequence=0;const rpcPending=new Map();
const rpc=(method,args={})=>new Promise((resolve,reject)=>{const requestId='fs-'+(++rpcSequence);const timer=setTimeout(()=>{rpcPending.delete(requestId);reject(new Error('Extension host request timed out'));},15000);rpcPending.set(requestId,{resolve,reject,timer});send('hostRequest',{requestId,method,args});});
const toUri=value=>typeof value==='string'?vscode.Uri.parse(value):value;
const fs={readFile:async uri=>{const r=await rpc('readFile',{uri:toUri(uri).toString()});return new TextEncoder().encode(String(r.content||''));},writeFile:async(uri,data)=>rpc('writeFile',{uri:toUri(uri).toString(),content:new TextDecoder('utf-8',{fatal:true}).decode(data)}),stat:async uri=>rpc('stat',{uri:toUri(uri).toString()}),readDirectory:async uri=>rpc('readDirectory',{uri:toUri(uri).toString()}),createDirectory:async uri=>rpc('createDirectory',{uri:toUri(uri).toString()}),delete:async(uri,options={})=>rpc('delete',{uri:toUri(uri).toString(),recursive:!!options.recursive}),rename:async(from,to,options={})=>rpc('rename',{from:toUri(from).toString(),to:toUri(to).toString(),overwrite:!!options.overwrite})};
const workspace={workspaceFolders:[],fs,getConfiguration(section=''){const key=String(section||'');return {get:(name,def)=>{const v=configStore[key+'.'+name];return v===undefined?def:v;},has:name=>Object.prototype.hasOwnProperty.call(configStore,key+'.'+name),update:(name,value)=>{configStore[key+'.'+name]=value;return Promise.resolve();},inspect:name=>({key:key+'.'+name,globalValue:configStore[key+'.'+name],workspaceValue:undefined,defaultValue:undefined}),};},onDidChangeConfiguration:()=>new Disposable(()=>{}),onDidOpenTextDocument:()=>new Disposable(()=>{}),onDidCloseTextDocument:()=>new Disposable(()=>{}),onDidChangeTextDocument:()=>new Disposable(()=>{})};
const vscode={version:'1.90.0',ExtensionMode:{Production:1,Development:2},TreeItem,TreeItemCollapsibleState,EventEmitter,ThemeIcon:class ThemeIcon{constructor(id){this.id=String(id);}},FileType:{Unknown:0,File:1,Directory:2,SymbolicLink:64},FilePermission:{Readonly:1},Disposable,commands,window:{showInformationMessage:(...a)=>message('info',a),showWarningMessage:(...a)=>message('warning',a),showErrorMessage:(...a)=>message('error',a),createOutputChannel:output,showTextDocument:async document=>document,activeTextEditor:undefined,registerTreeDataProvider:(id,provider)=>{id=String(id);if(!provider||typeof provider.getChildren!=='function')throw new Error('TreeDataProvider.getChildren is required');treeProviders.set(id,provider);const sub=provider.onDidChangeTreeData&&provider.onDidChangeTreeData(()=>treeRefresh(id));treeRefresh(id);return new Disposable(()=>{if(sub&&sub.dispose)sub.dispose();treeProviders.delete(id);send('treeRemoved',{viewId:id});});},createTreeView:(id,options={})=>{const disposable=vscode.window.registerTreeDataProvider(id,options.treeDataProvider);return {onDidExpandElement:new EventEmitter().event,onDidCollapseElement:new EventEmitter().event,reveal:async element=>{treeRefresh(id);},dispose:()=>disposable.dispose(),visible:true,selection:[]};}},workspace,env:{appName:'CodeSpace',language:(self.navigator&&self.navigator.language)||'en',uiKind:2},Uri:{parse:s=>({scheme:String(s).split(':')[0],path:String(s),fsPath:String(s),toString:()=>String(s)}),file:s=>({scheme:'file',path:String(s),fsPath:String(s),toString:()=>String(s)})}};
self.exports={};self.module={exports:self.exports};self.require=(name)=>{if(name==='vscode')return vscode;throw new Error('CodeSpace Web Extension Host blocks module: '+String(name));};
self.fetch=()=>Promise.reject(new Error('Network access is not available inside CodeSpace extensions.'));
self.XMLHttpRequest=undefined;self.WebSocket=undefined;self.EventSource=undefined;
try{
 importScripts(${JSON.stringify(entry)});
 self.importScripts=()=>{throw new Error('Additional script loading is disabled in the CodeSpace extension sandbox');};
 const api=self.module.exports||self.exports;const activate=(api&&api.activate)||(self.exports&&self.exports.activate);
 if(typeof activate!=='function')throw new Error('The browser entry did not export activate(context)');
 const subscriptions=[];const store=()=>{const m=new Map();return {get:(k,d)=>m.has(k)?m.get(k):d,update:(k,v)=>{m.set(k,v);return Promise.resolve();},keys:()=>[...m.keys()]};};
 const context={subscriptions,extensionMode:1,globalState:store(),workspaceState:store(),extension:{id:extensionId,packageJSON:{}}};
 Promise.resolve(activate(context)).then(()=>send('activated',{commands:[...registered.keys()]})).catch(e=>send('activationError',{error:String(e&&e.stack||e).slice(0,2000)}));
}catch(e){send('activationError',{error:String(e&&e.stack||e).slice(0,2000)});}
self.onmessage=async e=>{const d=e.data||{};if(d.type==='hostResponse'){const p=rpcPending.get(d.requestId);if(p){clearTimeout(p.timer);rpcPending.delete(d.requestId);d.error?p.reject(new Error(d.error)):p.resolve(d.result);}return;}if(d.type==='refreshTree'){treeRefresh(d.viewId);return;}if(d.type!=='runCommand')return;const fn=registered.get(String(d.command));if(!fn){send('commandResult',{requestId:d.requestId,error:'Command is not registered'});return;}try{const result=await fn(...(Array.isArray(d.args)?d.args:[]));send('commandResult',{requestId:d.requestId,result:typeof result==='string'?result:undefined});}catch(err){send('commandResult',{requestId:d.requestId,error:String(err&&err.message||err)});}};
})();
`;
}
function vscodeHostStop(key) {
  const host = vscodeHosts.get(key); if (!host) return;
  if (host.activateTimer) clearTimeout(host.activateTimer);
  for (const pending of host.pending.values()) { clearTimeout(pending.timer); try { pending.reject(new Error('Extension host stopped')); } catch {} }
  host.pending.clear();
  if (host.mode === 'node') {
    // The local server owns the child process; stop it before dropping the UI handle.
    vscodeHosts.delete(key);
    if (B.ok) return bcall('/ext/marketplace/node/stop', { key }).catch(() => {});
  } else {
    try { host.worker.terminate(); } catch {}
    try { URL.revokeObjectURL(host.url); } catch {}
  }
  vscodeHosts.delete(key);
  return Promise.resolve();
}
async function vscodeNodeHostStart(ext) {
  if (vscodeHosts.has(ext.key)) return;
  const host = { mode: 'node', ext, commands: new Set(), pending: new Map(), ready: false };
  vscodeHosts.set(ext.key, host);
  try {
    const r = await bApproved('/ext/marketplace/node/activate', { key: ext.key }, undefined,
      'Run ' + ext.displayName + '?', 'ext_run', permMeta('ext', ext.id));
    if (!r || r.st === 'err') throw new Error(r && r.text || 'Extension activation was not approved');
    if (!r.ok || r.state !== 'running') throw new Error(r.error || 'Node.js extension host did not start');
    host.commands = new Set((r.commands || []).map(x => typeof x === 'string' ? x : x && x.command).filter(Boolean));
    host.ready = true;
    vscodeRenderInstalledCommands(ext.key);
    const startupLog = (r.logs || []).slice(-1)[0];
    await vscodeSyncNodeUi(ext.key);
    vscodeMktStatus(startupLog ? ext.displayName + ': ' + startupLog.message : ext.displayName + ' · Node.js extension host active', startupLog && startupLog.level === 'error');
  } catch (e) {
    host.error = e.message || String(e);
    vscodeRenderInstalledCommands(ext.key);
    vscodeMktStatus(ext.displayName + ': ' + host.error, true);
  }
}
function vscodeExtensionWorkspacePath(uri) {
  const raw=String(uri||'');let path=raw;
  if(/^file:/i.test(raw)){try{path=decodeURIComponent(new URL(raw).pathname);}catch{throw new Error('Invalid file URI');}}
  const root=String(B.info&&B.info.root||'').replace(/\\/g,'/').replace(/\/$/,'');
  path=path.replace(/\\/g,'/');
  if(root&&path.startsWith(root+'/'))path=path.slice(root.length+1);
  else if(path.startsWith('/'))path=path.replace(/^\/+/, '');
  const parts=path.split('/').filter(Boolean);
  if(!parts.length||parts.some(part=>part==='.'||part==='..')||parts.some(part=>/[\u0000-\u001f]/.test(part)))throw new Error('Extension file access must stay inside the active workspace');
  return parts.join('/');
}
async function vscodeHandleWebHostRequest(ext,worker,data){
  const a=data.args||{},m=String(data.method||''),reply=(result)=>worker.postMessage({type:'hostResponse',requestId:data.requestId,result});
  if(m==='readFile'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bcall('/fs/read',{path});reply({content:String(r.content||'')});return;}
  if(m==='writeFile'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bApproved('/fs/write',{path,content:String(a.content||'')},undefined,'Allow extension to write a workspace file?','fs_write',permMeta('fs',path));if(r&&r.st==='err')throw new Error(r.text||'File write denied');reply({written:true});return;}
  if(m==='stat'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bcall('/fs/list',{path,recursive:false}).catch(()=>null);if(r&&Array.isArray(r.entries))throw new Error('Directory stat metadata is not exposed by this adapter');const file=await bcall('/fs/read',{path});reply({type:1,ctime:0,mtime:0,size:new TextEncoder().encode(String(file.content||'')).length});return;}
  if(m==='readDirectory'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bcall('/fs/list',{path,recursive:false});reply((r.entries||[]).map(item=>{const directory=String(item).endsWith('/');return [String(item).replace(/\/$/,''),directory?2:1];}));return;}
  if(m==='createDirectory'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bApproved('/fs/mkdir',{path},undefined,'Allow extension to create a workspace folder?','fs_write',permMeta('fs',path));if(r&&r.st==='err')throw new Error(r.text||'Folder creation denied');reply(true);return;}
  if(m==='delete'){const path=vscodeExtensionWorkspacePath(a.uri),r=await bApproved('/fs/delete',{path,recursive:!!a.recursive},undefined,'Allow extension to delete a workspace item?','fs_write',permMeta('fs',path));if(r&&r.st==='err')throw new Error(r.text||'Delete denied');reply(true);return;}
  if(m==='rename'){const from=vscodeExtensionWorkspacePath(a.from),to=vscodeExtensionWorkspacePath(a.to);if(a.overwrite)throw new Error('Overwrite rename is not supported safely');const r=await bApproved('/fs/rename',{path:from,to},undefined,'Allow extension to rename a workspace item?','fs_write',permMeta('fs',from));if(r&&r.st==='err')throw new Error(r.text||'Rename denied');reply(true);return;}
  throw new Error('Unsupported extension host request: '+m);
}
function vscodeHostStart(ext) {
  if (vscodeHosts.has(ext.key) || typeof Worker === 'undefined') return;
  const source = vscodeWorkerSource(ext), url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url); const host = { worker, url, ext, commands: new Set(), pending: new Map() }; vscodeHosts.set(ext.key, host);
  worker.onmessage = event => {
    const data = event.data || {};
    if (data.type === 'hostRequest') { vscodeHandleWebHostRequest(ext, worker, data).catch(error => worker.postMessage({type:'hostResponse',requestId:data.requestId,error:String(error&&error.message||error)})); return; }
    if (data.type === 'commandRegistered') { host.commands.add(data.command); vscodeRenderInstalledCommands(ext.key); }
    else if (data.type === 'commandRemoved') { host.commands.delete(data.command); vscodeRenderInstalledCommands(ext.key); }
    else if (data.type === 'activated') { host.ready = true; if (host.activateTimer) clearTimeout(host.activateTimer); vscodeRenderInstalledCommands(ext.key); }
    else if (data.type === 'treeData') vscodeRenderWebTree(ext.key, data);
    else if (data.type === 'treeError') vscodeMktStatus(ext.displayName + ': tree view error: ' + String(data.error||'').slice(0,180), true);
    else if (data.type === 'treeRemoved') vscodeRenderWebTree(ext.key, {viewId:data.viewId,items:[]});
    else if (data.type === 'activationError') { host.error = data.error || 'Extension activation failed'; if (host.activateTimer) clearTimeout(host.activateTimer); vscodeMktStatus(ext.displayName + ': ' + host.error, true); }
    else if (data.type === 'notification') vscodeMktStatus(ext.displayName + ': ' + data.message, data.level === 'error');
    else if (data.type === 'output') vscodeMktStatus(ext.displayName + ': ' + String(data.message || '').slice(0, 240));
    else if (data.type === 'commandResult') {
      const p = host.pending.get(data.requestId); if (p) { clearTimeout(p.timer); host.pending.delete(data.requestId); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result || 'Command completed.'); }
    }
  };
  worker.onerror = e => { host.error = e.message || 'Extension worker failed'; vscodeMktStatus(ext.displayName + ': ' + host.error, true); vscodeHostStop(ext.key); };
  host.activateTimer = setTimeout(() => { if (!host.ready && !host.error) { host.error = 'Activation timed out'; vscodeMktStatus(ext.displayName + ': activation timed out', true); vscodeHostStop(ext.key); } }, 15000);
}
function vscodeRenderWebTree(key, data) {
  const card=document.querySelector('[data-vsix-key="'+CSS.escape(key)+'"]'); if(!card)return;
  const box=card.querySelector('.ext-vsix-installed-tree'); if(!box)return;
  let section=box.querySelector('[data-tree-view="'+CSS.escape(String(data.viewId||''))+'"]');
  if(!section){section=document.createElement('section');section.dataset.treeView=String(data.viewId||'');section.className='ext-vsix-tree-view';const heading=document.createElement('div');heading.className='ext-vsix-installed-meta';heading.textContent=String(data.viewId||'Extension view');section.appendChild(heading);box.appendChild(section);}
  section.querySelectorAll('[data-tree-item]').forEach(x=>x.remove());
  (Array.isArray(data.items)?data.items:[]).slice(0,200).forEach(item=>{const button=document.createElement('button');button.type='button';button.className='btn sm';button.dataset.treeItem='1';button.style.display='block';button.style.width='100%';button.style.textAlign='left';button.textContent=(item.collapsibleState===1?'▸ ':item.collapsibleState===2?'▾ ':'')+String(item.label||'').slice(0,180)+(item.description?' · '+String(item.description).slice(0,80):'');button.title=String(item.tooltip||item.label||'');button.addEventListener('click',()=>{if(item.command&&item.command.command)vscodeRunCommand(key,item.command.command,item.command.arguments||[]);else if(item.collapsibleState){const host=vscodeHosts.get(key);if(host&&host.worker)host.worker.postMessage({type:'refreshTree',viewId:data.viewId});}});section.appendChild(button);});
}
function vscodeRunCommand(key, command, args = []) {
  const host = vscodeHosts.get(key); if (!host || !host.ready) { vscodeMktStatus('Extension is not active yet.'); return; }
  if (host.mode === 'node') {
    bcall('/ext/marketplace/node/command', { key, command, args: [] })
      .then(async r => { await vscodeSyncNodeUi(key); const value = r && r.result !== undefined ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)) : ''; const log = r && r.logs && r.logs.length ? r.logs[r.logs.length - 1].message : ''; vscodeMktStatus(value || log || 'Command completed.'); })
      .catch(e => vscodeMktStatus(e.message || String(e), true));
    return;
  }
  const requestId = uid(); const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { host.pending.delete(requestId); reject(new Error('Extension command timed out')); }, 60000);
    host.pending.set(requestId, { resolve, reject, timer });
  });
  host.worker.postMessage({ type: 'runCommand', command, args: Array.isArray(args)?args.slice(0,5):[], requestId });
  promise.then(result => vscodeMktStatus(String(result || 'Command completed.'))).catch(e => vscodeMktStatus(e.message, true));
}
function vscodeRenderInstalledCommands(key) {
  const card = document.querySelector('[data-vsix-key="' + CSS.escape(key) + '"]'); if (!card) return;
  const host = vscodeHosts.get(key), box = card.querySelector('.ext-vsix-installed-commands'); if (!box) return;
  box.replaceChildren();
  const ext = host && host.ext;
  (ext && ext.commands || []).forEach(command => {
    if (!host || !host.commands.has(command.command)) return;
    const button = vscodeMktButton(command.title || command.command, '', () => vscodeRunCommand(key, command.command));
    button.disabled = !host || !host.ready; button.title = command.command; box.appendChild(button);
  });
  if (host && host.error) { const err = document.createElement('span'); err.className = 'ext-vsix-installed-meta'; err.textContent = 'Activation failed'; box.appendChild(err); }
}
async function vscodeLoadInstalled(forceRestart = false) {
  const box = $('extVsixInstalled'); if (!box || !B.ok) return;
  try {
    const r = await bcall('/ext/marketplace/installed', {}), items = r.items || [];
    const keep = new Set(items.map(x => x.key));
    await Promise.all([...vscodeHosts.keys()].filter(key => !keep.has(key) || forceRestart).map(vscodeHostStop));
    box.replaceChildren();
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'ext-vsix-installed-empty'; empty.textContent = 'No VS Code extensions installed'; box.appendChild(empty); return; }
    items.forEach(ext => {
      const card = document.createElement('div'); card.className = 'ext-vsix-installed-card'; card.dataset.vsixKey = ext.key;
      const main = document.createElement('div'); main.className = 'ext-vsix-installed-main';
      const name = document.createElement('div'); name.className = 'ext-vsix-installed-name'; name.textContent = ext.displayName;
      const meta = document.createElement('div'); meta.className = 'ext-vsix-installed-meta'; meta.textContent = ext.id + ' · v' + ext.version + ' · ' + (ext.runtime || (ext.hostType === 'node' ? 'Node.js Extension Host' : 'Web Extension Host')) + (ext.requiresNativeCode || ext.requiresNativeAddons ? ' · Native code permission' : '');
      const commands = document.createElement('div'); commands.className = 'ext-vsix-installed-commands';
      const tree = document.createElement('div'); tree.className = 'ext-vsix-installed-tree'; tree.setAttribute('aria-label','Extension contributed tree views');
      main.append(name, meta, commands, tree); card.appendChild(main);
      const remove = vscodeMktButton('Uninstall', 'danger', async () => {
        if (!confirm('Uninstall ' + ext.displayName + '?')) return;
        try { const r = await bApproved('/ext/marketplace/uninstall', { key: ext.key }, undefined, 'Uninstall ' + ext.displayName + '?', 'ext_remove', permMeta('ext', ext.id)); if (r && r.st === 'err') throw new Error(r.text); await vscodeHostStop(ext.key); await vscodeLoadInstalled(); }
        catch (e) { vscodeMktStatus(e.message || String(e), true); }
      });
      card.appendChild(remove); box.appendChild(card);
      if (!vscodeHosts.has(ext.key)) { if (ext.hostType === 'node') vscodeNodeHostStart(ext); else vscodeHostStart(ext); }
    });
  } catch (e) { vscodeMktStatus(e.message || String(e), true); }
}
const vscodeWebviewMessageCursor = new Map();
let vscodeActiveWebview = null;
async function vscodeShowWebview(key, view) {
  if (!view || !view.html || !$('extWebviewDlg') || !$('extWebviewFrame')) return;
  const dlg=$('extWebviewDlg'), frame=$('extWebviewFrame');
  const panelId=String(view.panelId||'');
  const current=vscodeActiveWebview;
  const changed=!current||current.key!==key||current.panelId!==panelId||current.html!==String(view.html||'');
  $('extWebviewTitle').textContent=String(view.title||'Extension View').slice(0,120);
  if(changed){
    let network=false; try { const p=await bcall('/perm/get',{}); network=p&&p.permissions&&p.permissions.network==='allow'; } catch {}
    const net=network?'https:':'none';
    const optionScripts=!!(view.options&&view.options.enableScripts);
    frame.setAttribute('sandbox',optionScripts?'allow-scripts allow-forms allow-popups':'allow-forms');
    const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${net}; font-src data: ${net}; style-src 'unsafe-inline' ${net}; script-src 'unsafe-inline' ${net}; connect-src ${net}; frame-src ${net}; form-action ${net}; base-uri 'none'; object-src 'none'">`;
    const bridge=`<script>(()=>{const panelId=${JSON.stringify(panelId)};let state=null;window.acquireVsCodeApi=()=>({postMessage:message=>parent.postMessage({__codespaceWebview:true,panelId,message},'*'),getState:()=>state,setState:value=>(state=value)});})();<\/script>`;
    let html=String(view.html||''); if(/<head[^>]*>/i.test(html))html=html.replace(/<head([^>]*)>/i,`<head$1>${csp}${optionScripts?bridge:''}`);else html=`<!doctype html><html><head>${csp}${optionScripts?bridge:''}</head><body>${html}</body></html>`;
    frame.srcdoc=html;
    vscodeActiveWebview={key,panelId,html};
  }
  const cursor=vscodeWebviewMessageCursor.get(panelId)||0, msgs=Array.isArray(view.messages)?view.messages:[];
  msgs.slice(cursor).forEach(message=>{try{frame.contentWindow&&frame.contentWindow.postMessage(message,'*');}catch{}});
  vscodeWebviewMessageCursor.set(panelId,msgs.length);
  if(!dlg.open)dlg.showModal();
}
function vscodeRenderNodeDebugSessions(key, sessions) {
  const card=document.querySelector('[data-vsix-key="'+CSS.escape(key)+'"]'); if(!card)return;
  const box=card.querySelector('.ext-vsix-installed-commands'); if(!box)return;
  box.querySelectorAll('[data-cs-debug]').forEach(x=>x.remove());
  (sessions||[]).forEach(session=>{
    const label=document.createElement('span');label.className='ext-vsix-installed-meta';label.dataset.csDebug='1';
    label.textContent='Debugging · '+String(session.name||session.type||'Session').slice(0,48);box.appendChild(label);
    const stop=vscodeMktButton('Stop debug','danger',async()=>{
      stop.disabled=true;
      try{await bcall('/ext/marketplace/node/debug/stop',{key,sessionId:session.sessionId});await vscodeSyncNodeUi(key);vscodeMktStatus('Debugger stopped.');}
      catch(e){stop.disabled=false;vscodeMktStatus(e.message||String(e),true);}
    });stop.dataset.csDebug='1';stop.title='Stop this extension debug session';box.appendChild(stop);
  });
}
function vscodeRenderNodeViews(key, views) {
  const card=document.querySelector('[data-vsix-key="'+CSS.escape(key)+'"]'); if(!card)return;
  const box=card.querySelector('.ext-vsix-installed-commands'); if(!box)return;
  box.querySelectorAll('[data-cs-view]').forEach(x=>x.remove());
  (views||[]).forEach(view=>{const button=vscodeMktButton('Open '+String(view.viewType||'View').slice(0,30),'',async()=>{try{await bcall('/ext/marketplace/node/view/open',{key,viewType:view.viewType});setTimeout(()=>vscodeSyncNodeUi(key),250);}catch(e){vscodeMktStatus(e.message||String(e),true);}});button.dataset.csView='1';box.appendChild(button);});
}
async function vscodeSyncNodeUi(key) {
  if(!B.ok||!key)return;
  try{
    const state=await bcall('/ext/marketplace/node/status',{key});
    const host=vscodeHosts.get(key); if(!host)return;
    const termIds=Array.isArray(state.terminalIds)?state.terminalIds:[];
    const seen=host.seenTerminals||(host.seenTerminals=new Set());
    const fresh=termIds.filter(id=>!seen.has(id)); fresh.forEach(id=>seen.add(id));
    if(fresh.length&&typeof showTerminal==='function')showTerminal(fresh[fresh.length-1]);
    vscodeRenderNodeViews(key,state.viewProviders||[]);
    const views=Array.isArray(state.webviews)?state.webviews:[];
    const active=views.filter(v=>v.visible&&v.html); if(active.length)await vscodeShowWebview(key,active[active.length-1]);
    if(Array.isArray(state.debugSessions)){host.debugSessions=state.debugSessions;vscodeRenderNodeDebugSessions(key,state.debugSessions);}
    host.features=state.features||[]; host.diagnostics=state.diagnostics||[];
    if(host.diagnostics.length&&activeFileTab()&&$('fState'))$('fState').textContent=host.diagnostics.reduce((n,d)=>n+(d.diagnostics||[]).length,0)+' extension diagnostics';
  }catch{}
}
window.addEventListener('message',event=>{
  const frame=$('extWebviewFrame'); if(!frame||event.source!==frame.contentWindow||!event.data||event.data.__codespaceWebview!==true)return;
  const active=vscodeActiveWebview;if(!active||String(event.data.panelId)!==active.panelId)return;
  bcall('/ext/marketplace/node/webview/message',{key:active.key,panelId:active.panelId,message:event.data.message}).catch(()=>{});
});
$('extWebviewClose')?.addEventListener('click',async()=>{
  const active=vscodeActiveWebview; $('extWebviewDlg')?.close(); $('extWebviewFrame').srcdoc=''; vscodeActiveWebview=null;
  if(active&&B.ok)await bcall('/ext/marketplace/node/webview/close',{key:active.key,panelId:active.panelId}).catch(()=>{});
});
$('extWebviewDlg')?.addEventListener('close',()=>{if($('extWebviewFrame'))$('extWebviewFrame').srcdoc='';vscodeActiveWebview=null;});
let vscodeDocSyncTimer=null;
const androidLspOpenDocs=new Set(),androidLspInit=new Map(),androidLspPumps=new Map();
const androidLspLanguage=tab=>{const ext=(tab.path.split('.').pop()||'plaintext').toLowerCase();return ({js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',kt:'kotlin',kts:'kotlin',java:'java',json:'json',html:'html',htm:'html',css:'css',scss:'scss',go:'go',rs:'rust',php:'php',c:'c',h:'c',cc:'cpp',cpp:'cpp',hpp:'cpp',cs:'csharp',rb:'ruby',sh:'shellscript',yml:'yaml',yaml:'yaml',md:'markdown'})[ext]||ext;};
const androidLspLocal=()=>L.bridgeUrl==='codespace-native://local';
async function androidLspWaitResponse(id,requestId,timeout=1600){const until=Date.now()+timeout;while(Date.now()<until){const r=await bcall('/lsp/response',{id,requestId,remove:false}).catch(()=>null);if(r&&r.ready){await bcall('/lsp/response',{id,requestId,remove:true}).catch(()=>{});return r.response;}await sleep(50);}return null;}
async function androidLspSendServerReply(id,requestId,result,error){
  const message={jsonrpc:'2.0',id};if(error)message.error=error;else message.result=result;
  await bcall('/lsp/send',{id,message});
}
function androidLspWorkspaceFolder(session){
  const raw=String(session.cwd||((B.info&&B.info.root)||'' )).replace(/\\/g,'/');
  if(!raw.startsWith('/'))return [];
  const uri='file:///'+raw.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return [{uri,name:raw.split('/').filter(Boolean).pop()||'workspace'}];
}
async function androidLspHandleServerMessage(session,message){
  if(!message||typeof message!=='object'||typeof message.method!=='string')return;
  const method=message.method,params=message.params||{};
  if(Object.prototype.hasOwnProperty.call(message,'id')){
    let result=null,error=null;
    if(method==='workspace/configuration'){
      const items=Array.isArray(params.items)?params.items:[];
      result=items.map(item=>item&&typeof item.section==='string'?{}:{});
    }else if(method==='workspace/workspaceFolders')result=androidLspWorkspaceFolder(session);
    else if(method==='workspace/applyEdit')result={applied:false,failureReason:'Workspace edits are not applied automatically in this Android editor.'};
    else if(method==='workspace/executeCommand')error={code:-32601,message:'Workspace command execution is disabled in this Android build.'};
    else if(['client/registerCapability','client/unregisterCapability','window/workDoneProgress/create','window/showMessageRequest','workspace/semanticTokens/refresh','workspace/codeLens/refresh','workspace/diagnostics/refresh','workspace/inlayHint/refresh'].includes(method))result=null;
    else error={code:-32601,message:'Client request is not supported: '+method};
    await androidLspSendServerReply(session.id,message.id,result,error).catch(()=>{});
    return;
  }
  if(method==='textDocument/publishDiagnostics'){
    const uri=String(params.uri||''),diagnostics=Array.isArray(params.diagnostics)?params.diagnostics:[];
    const tab=typeof activeFileTab==='function'?activeFileTab():null;
    if(tab&&tab.lspUri===uri){
      tab.lspDiagnosticsCount=diagnostics.length;
      tab.lspDiagnostics=diagnostics;
      const state=$('fState');if(state)state.textContent=diagnostics.length?'LSP · '+diagnostics.length+' diagnostics':'Language server ready';
    }
  }else if(method==='window/logMessage'||method==='window/showMessage'){
    const text=String(params.message||'').slice(0,180),state=$('fState');
    if(text&&state&&activeFileTab())state.textContent='LSP · '+text;
  }
}
function androidLspStartPump(session){
  if(androidLspPumps.has(session.id))return;
  const control={active:true};androidLspPumps.set(session.id,control);
  (async()=>{
    let failures=0;
    while(control.active&&androidLspPumps.get(session.id)===control){
      let batch;
      try{batch=await bcall('/lsp/read',{id:session.id,limit:80,waitMs:500});failures=0;}
      catch(e){if(++failures>=3)break;await sleep(180);continue;}
      if(!batch||batch.running===false)break;
      for(const message of (Array.isArray(batch.messages)?batch.messages:[])){
        try{await androidLspHandleServerMessage(session,message);}catch{}
      }
    }
  })().catch(()=>{}).finally(()=>{if(androidLspPumps.get(session.id)===control)androidLspPumps.delete(session.id);});
}
async function androidLspEnsureSession(language){
  let rows=(await bcall('/lsp/list',{})).servers||[];let session=rows.find(x=>x.running&&x.language===language);
  if(!session){const started=await bcall('/lsp/autostart',{language});if(!started||!started.available||!started.id)return null;session=started;}
  if(!androidLspInit.has(session.id)){
    const initPromise=(async()=>{const req=await bcall('/lsp/initialize',{id:session.id});const response=await androidLspWaitResponse(session.id,req.requestId,3500);if(!response||response.error)throw new Error(response&&response.error&&response.error.message||'Language server did not complete initialize');await bcall('/lsp/initialized',{id:session.id});return true;})();
    androidLspInit.set(session.id,initPromise);try{await initPromise;}catch(e){androidLspInit.delete(session.id);await bcall('/lsp/stop',{id:session.id}).catch(()=>{});throw e;}
  }else await androidLspInit.get(session.id);
  androidLspStartPump(session);
  return session;
}
async function androidLspSync(event,tab){
  if(!androidLspLocal()||!B.ok||!tab||tab.type!=='file'||!tab.path)return;
  const language=androidLspLanguage(tab);if(!language||language==='plaintext')return;
  if(event==='close'){
    const rows=(await bcall('/lsp/list',{}).catch(()=>({servers:[]}))).servers||[];
    for(const session of rows){const key=session.id+'|'+tab.path;if(androidLspOpenDocs.has(key)){await bcall('/lsp/document/close',{id:session.id,path:tab.path}).catch(()=>{});androidLspOpenDocs.delete(key);}}
    return;
  }
  const session=await androidLspEnsureSession(language).catch(e=>{if(/configured|Create \.codespace-tools/i.test(e.message||''))return null;return null;});
  if(!session)return;
  const key=session.id+'|'+tab.path;
  if(!androidLspOpenDocs.has(key)){
    const opened=await bcall('/lsp/document/open',{id:session.id,path:tab.path,languageId:language,text:tab.text||''});tab.lspUri=opened.uri||tab.lspUri;androidLspOpenDocs.add(key);
  }else if(event==='change'||event==='save'){
    await bcall('/lsp/document/change',{id:session.id,path:tab.path,text:tab.text||''});
  }
  if(event==='save')await bcall('/lsp/document/save',{id:session.id,path:tab.path,includeText:false}).catch(()=>{});
  const diag=await bcall('/lsp/diagnostics',{id:session.id,uri:tab.lspUri||''}).catch(()=>null);
  if(diag&&Array.isArray(diag.items)){let count=0;for(const item of diag.items)count+=(item.diagnostics||[]).length;tab.lspDiagnosticsCount=count;if(activeFileTab()===tab&&$('fState'))$('fState').textContent=count?('LSP · '+count+' diagnostics'):'Language server ready';}
}
function vscodeSyncEditorDocument(event, tab) {
  if(!B.ok||!tab||tab.type!=='file'||!tab.path)return;
  clearTimeout(vscodeDocSyncTimer);
  vscodeDocSyncTimer=setTimeout(()=>{
    if(androidLspLocal())androidLspSync(event,tab).catch(e=>{if($('fState')&&activeFileTab()===tab)$('fState').textContent='LSP: '+String(e.message||e).slice(0,100);});
    for(const [key,host] of vscodeHosts){if(host.mode!=='node'||!host.ready)continue;
      bcall('/ext/marketplace/node/document',{key,event,path:tab.path,text:tab.text||'',languageId:(tab.path.split('.').pop()||'plaintext').toLowerCase(),version:Date.now()}).catch(()=>{});
    }
  },event==='change'?180:0);
}
async function vscodeRequestEditorCompletions() {
  const tab=activeFileTab(), ta=$('edTa'); if(!tab||!ta||!B.ok)return;
  const cursor=ta.selectionStart, before=ta.value.slice(0,cursor), lines=before.split('\n');
  const params={path:tab.path,text:ta.value,languageId:(tab.path.split('.').pop()||'plaintext').toLowerCase(),version:Date.now(),line:lines.length-1,character:lines[lines.length-1].length};
  if(androidLspLocal()){
    const language=androidLspLanguage(tab),session=await androidLspEnsureSession(language).catch(()=>null);
    if(session){
      const key=session.id+'|'+tab.path;
      if(!androidLspOpenDocs.has(key)){const opened=await bcall('/lsp/document/open',{id:session.id,path:tab.path,languageId:language,text:ta.value});tab.lspUri=opened.uri||tab.lspUri;androidLspOpenDocs.add(key);}
      const req=await bcall('/lsp/completion',{id:session.id,path:tab.path,line:params.line,character:params.character});
      const response=await androidLspWaitResponse(session.id,req.requestId,1800);
      const value=response&&response.result;const items=Array.isArray(value)?value:(value&&Array.isArray(value.items)?value.items:[]);
      if(items.length){
        let popup=document.getElementById('csExtCompletionPopup');if(!popup){popup=document.createElement('div');popup.id='csExtCompletionPopup';popup.className='cs-ext-completion-popup';document.body.appendChild(popup);}
        popup.replaceChildren();popup.style.display='block';const rect=ta.getBoundingClientRect();popup.style.left=Math.max(8,Math.min(window.innerWidth-340,rect.left+Math.min(ta.clientWidth-320,24)))+'px';popup.style.top=Math.min(window.innerHeight-220,rect.top+Math.min(rect.height-8,80))+'px';
        items.slice(0,60).forEach(item=>{const b=document.createElement('button');b.type='button';b.className='cs-ext-completion-item';const label=typeof item.label==='string'?item.label:(item.label&&item.label.label)||'Suggestion';b.textContent=label+(item.detail?' · '+String(item.detail).slice(0,50):'');b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>{const lineStart=before.lastIndexOf('\n')+1,fragment=before.slice(lineStart),word=(fragment.match(/[\w$.-]+$/)||[''])[0],edit=item.textEdit,insert=edit&&edit.newText||(item.insertText&&typeof item.insertText==='object'?item.insertText.value:item.insertText),start=edit&&edit.range&&edit.range.start,end=edit&&edit.range&&edit.range.end,lines=ta.value.split('\n'),pos=(p)=>lines.slice(0,p.line).reduce((n,line)=>n+line.length+1,0)+p.character,from=start?pos(start):cursor-word.length,to=end?pos(end):cursor;ta.setRangeText(String(insert??label),from,to,'end');ta.dispatchEvent(new Event('input',{bubbles:true}));popup.style.display='none';ta.focus();});popup.appendChild(b);});
        const close=event=>{if(!popup.contains(event.target)&&event.target!==ta){popup.style.display='none';document.removeEventListener('mousedown',close,true);}};document.addEventListener('mousedown',close,true);return;
      }
    }
  }
  const hosts=[...vscodeHosts.entries()].filter(([,h])=>h.mode==='node'&&h.ready&&((h.features||[]).some(f=>f.name==='completion')));
  if(!hosts.length){vscodeMktStatus('No active extension provides completions for this file.');return;}
  const results=await Promise.all(hosts.map(([key])=>bcall('/ext/marketplace/node/feature',{key,feature:'completion',params}).catch(()=>({results:[]}))));
  const items=results.flatMap(x=>(x.results||[]).flatMap(r=>Array.isArray(r)?r:Array.isArray(r.items)?r.items:[])).filter(x=>x&&x.label).slice(0,40);
  if(!items.length){vscodeMktStatus('No extension completions at this position.');return;}
  let popup=document.getElementById('csExtCompletionPopup'); if(!popup){popup=document.createElement('div');popup.id='csExtCompletionPopup';popup.className='cs-ext-completion-popup';document.body.appendChild(popup);}
  popup.replaceChildren(); popup.style.display='block'; const rect=ta.getBoundingClientRect(); popup.style.left=Math.max(8,Math.min(window.innerWidth-340,rect.left+Math.min(ta.clientWidth-320,24)))+'px';popup.style.top=Math.min(window.innerHeight-220,rect.top+Math.min(rect.height-8,80))+'px';
  items.forEach(item=>{const b=document.createElement('button');b.type='button';b.className='cs-ext-completion-item';const label=typeof item.label==='string'?item.label:(item.label.label||'Suggestion');b.textContent=label+(item.detail?' · '+String(item.detail).slice(0,50):'');b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>{const lineStart=before.lastIndexOf('\n')+1, fragment=before.slice(lineStart), word=(fragment.match(/[\w$.-]+$/)||[''])[0], insert=item.insertText&&typeof item.insertText==='object'?item.insertText.value:item.insertText;ta.setRangeText(String(insert??label),cursor-word.length,cursor,'end');ta.dispatchEvent(new Event('input',{bubbles:true}));popup.style.display='none';ta.focus();});popup.appendChild(b);});
  const close=event=>{if(!popup.contains(event.target)&&event.target!==ta){popup.style.display='none';document.removeEventListener('mousedown',close,true);}};document.addEventListener('mousedown',close,true);
}
window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='Space'&&document.activeElement===$('edTa')){e.preventDefault();vscodeRequestEditorCompletions().catch(err=>vscodeMktStatus(err.message||String(err),true));}});
async function androidLspActiveDocument(){
  const tab=activeFileTab(),ta=$('edTa');if(!tab||!ta||!B.ok||!androidLspLocal())return null;
  const language=androidLspLanguage(tab),session=await androidLspEnsureSession(language);if(!session)return null;
  const key=session.id+'|'+tab.path;
  if(!androidLspOpenDocs.has(key)){const opened=await bcall('/lsp/document/open',{id:session.id,path:tab.path,languageId:language,text:ta.value});tab.lspUri=opened.uri||tab.lspUri;androidLspOpenDocs.add(key);}
  else await bcall('/lsp/document/change',{id:session.id,path:tab.path,text:ta.value}).catch(()=>{});
  const before=ta.value.slice(0,ta.selectionStart),lines=before.split('\n');
  return {tab,ta,session,key,line:lines.length-1,character:lines[lines.length-1].length};
}
function androidLspShowPanel(title,rows,anchor){
  let panel=document.getElementById('csAndroidLspPanel');if(!panel){panel=document.createElement('div');panel.id='csAndroidLspPanel';document.body.appendChild(panel);}
  panel.replaceChildren();Object.assign(panel.style,{position:'fixed',zIndex:'100000',width:'min(520px,calc(100vw - 24px))',maxHeight:'min(55vh,440px)',overflow:'auto',background:'var(--panel,#20242b)',color:'var(--text,#eee)',border:'1px solid var(--line,#555)',borderRadius:'10px',boxShadow:'0 12px 36px #0008',padding:'10px',fontSize:'13px'});
  const rect=(anchor||$('edTa')).getBoundingClientRect();panel.style.left=Math.max(8,Math.min(window.innerWidth-540,rect.left))+'px';panel.style.top=Math.max(8,Math.min(window.innerHeight-460,rect.bottom+6))+'px';
  const head=document.createElement('div');head.textContent=title;head.style.cssText='font-weight:600;padding:3px 4px 9px;border-bottom:1px solid var(--line,#555);margin-bottom:6px';
  const close=document.createElement('button');close.type='button';close.textContent='×';close.title='Close';close.style.cssText='float:right;border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer';close.onclick=()=>panel.remove();head.prepend(close);panel.appendChild(head);
  if(!rows.length){const empty=document.createElement('div');empty.textContent='No results from the language server.';empty.style.padding='8px 4px';panel.appendChild(empty);return panel;}
  rows.slice(0,100).forEach(row=>{const item=document.createElement('button');item.type='button';item.textContent=row.label||row.text||'Result';item.title=row.detail||'';item.style.cssText='display:block;width:100%;text-align:left;padding:8px 6px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:normal';item.onmouseenter=()=>item.style.background='var(--hover,#ffffff14)';item.onmouseleave=()=>item.style.background='transparent';item.onclick=()=>{if(row.onSelect)row.onSelect();panel.remove();};panel.appendChild(item);if(row.detail){const detail=document.createElement('div');detail.textContent=row.detail;detail.style.cssText='padding:0 6px 7px;opacity:.72;white-space:pre-wrap';panel.appendChild(detail);}});
  const outside=e=>{if(!panel.contains(e.target)){panel.remove();document.removeEventListener('pointerdown',outside,true);}};document.addEventListener('pointerdown',outside,true);return panel;
}
function androidLspContentText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.map(androidLspContentText).join('\n');if(value&&typeof value==='object')return value.value||value.language&&value.value||JSON.stringify(value);return '';}
function androidLspOpenLocation(location){if(!location||!location.uri)return;try{const root=String((B.info&&B.info.root)||''),absolute=decodeURIComponent(new URL(location.uri).pathname);if(!root||!absolute.startsWith(root+'/'))return;openFile(absolute.slice(root.length+1)).then(target=>{if(!target||!location.range)return;const text=target.text||'',range=location.range,offset=text.split('\n').slice(0,range.start.line).reduce((n,line)=>n+line.length+1,0)+range.start.character,end=text.split('\n').slice(0,range.end.line).reduce((n,line)=>n+line.length+1,0)+range.end.character;const editor=$('edTa');editor.focus();editor.setSelectionRange(offset,end);});}catch{}}
async function androidLspRequestFeature(feature){
  const ctx=await androidLspActiveDocument();if(!ctx)return;
  const {tab,ta,session,line,character}=ctx;let route,body={id:session.id,path:tab.path,line,character};
  if(feature==='hover')route='/lsp/hover';else if(feature==='references'){route='/lsp/references';body.includeDeclaration=true;}else if(feature==='symbols')route='/lsp/document-symbols';else return;
  const req=await bcall(route,body),response=await androidLspWaitResponse(session.id,req.requestId,2200);if(!response||response.error){androidLspShowPanel('Language server · '+feature,[{text:response&&response.error&&response.error.message||'No response'}],ta);return;}
  const value=response.result;
  if(feature==='hover'){
    const contents=value&&value.contents, text=androidLspContentText(contents&&contents.value!==undefined?contents.value:contents);
    androidLspShowPanel('Hover information',[{text:text||'No hover information'}],ta);return;
  }
  if(feature==='references'){
    const locations=Array.isArray(value)?value:[];androidLspShowPanel('References · '+locations.length,locations.map(loc=>({label:(loc.uri||'').split('/').pop()+' · line '+((loc.range&&loc.range.start.line||0)+1),detail:loc.uri,onSelect:()=>androidLspOpenLocation(loc)})),ta);return;
  }
  const symbols=Array.isArray(value)?value:[];const flatten=(items,depth=0)=>items.flatMap(x=>[{label:' '.repeat(Math.min(depth,5)*2)+(x.name||'Symbol'),detail:(x.detail||'')+(x.kind?' · kind '+x.kind:''),onSelect:()=>{if(x.location)androidLspOpenLocation(x.location);else{const range=x.selectionRange||x.range;if(range){const text=ta.value,offset=text.split('\n').slice(0,range.start.line).reduce((n,line)=>n+line.length+1,0)+range.start.character;ta.focus();ta.setSelectionRange(offset,offset);}}}}].concat(flatten(x.children||[],depth+1)));
  androidLspShowPanel('Document symbols',flatten(symbols),ta);
}
function androidLspOffset(text,pos){return text.split('\n').slice(0,Math.max(0,pos.line|0)).reduce((n,line)=>n+line.length+1,0)+Math.max(0,pos.character|0);}
function androidLspApplyTextEdits(ta,edits){
  if(!Array.isArray(edits)||!edits.length)return false;
  const text=ta.value,ordered=edits.map(e=>({start:androidLspOffset(text,e.range.start),end:androidLspOffset(text,e.range.end),text:String(e.newText??'')})).sort((a,b)=>b.start-a.start);
  let next=text,last=text.length+1;for(const e of ordered){if(e.start<0||e.end<e.start||e.end>text.length||e.end>last)throw new Error('Language server returned overlapping or invalid text edits');next=next.slice(0,e.start)+e.text+next.slice(e.end);last=e.start;}
  ta.value=next;ta.dispatchEvent(new Event('input',{bubbles:true}));return true;
}
async function androidLspAdvanced(feature){
  const ctx=await androidLspActiveDocument();if(!ctx)return;const {tab,ta,session,line,character}=ctx;let route,body={id:session.id,path:tab.path,line,character};
  if(feature==='format'){route='/lsp/formatting';body.tabSize=2;body.insertSpaces=true;}
  else if(feature==='rename'){const word=ta.value.slice(ta.selectionStart,ta.selectionEnd)||((ta.value.slice(0,ta.selectionStart).match(/[\w$]+$/)||[])[0]||'');const name=window.prompt('Rename symbol to:',word);if(!name||!/^[$A-Z_a-z][$\w]*$/.test(name))return;route='/lsp/rename';body.newName=name;}
  else if(feature==='signature')route='/lsp/signature-help';
  else if(feature==='actions')route='/lsp/code-actions';
  else if(feature==='highlights')route='/lsp/document-highlights';else return;
  const req=await bcall(route,body),response=await androidLspWaitResponse(session.id,req.requestId,2600);if(!response||response.error){androidLspShowPanel('Language server · '+feature,[{text:response&&response.error&&response.error.message||'No response'}],ta);return;}
  const value=response.result;
  if(feature==='format'){if(androidLspApplyTextEdits(ta,value||[]))vscodeMktStatus('Document formatted');else androidLspShowPanel('Format',[{text:'The language server returned no formatting edits.'}],ta);return;}
  if(feature==='rename'){
    const changes=value&&value.changes&&value.changes[ctx.tab.lspUri||''];
    if(changes&&changes.length&&window.confirm('Apply '+changes.length+' rename edit(s) in this file?')){androidLspApplyTextEdits(ta,changes);vscodeMktStatus('Rename edits applied to current file');}
    else androidLspShowPanel('Rename preview',[{text:'Rename returned edits for other files or a documentChanges workspace edit. Cross-file edits are not applied automatically.'}],ta);return;
  }
  if(feature==='signature'){const sigs=value&&value.signatures||[];const active=value&&value.activeSignature||0;androidLspShowPanel('Signature help',sigs.map((x,i)=>({label:(i===active?'● ':'')+(x.label||'Signature'),detail:androidLspContentText(x.documentation)})),ta);return;}
  if(feature==='actions'){
    const actions=Array.isArray(value)?value:[];androidLspShowPanel('Code actions · '+actions.length,actions.map(a=>({label:a.title||'Code action',detail:a.kind||'',onSelect:async()=>{if(a.edit&&a.edit.changes){const edits=a.edit.changes[ctx.tab.lspUri||''];if(edits&&window.confirm('Apply code action edits to this file?'))androidLspApplyTextEdits(ta,edits);}else if(a.command&&a.command.command){androidLspShowPanel('Code action', [{text:'This action requires a server command. Command execution is not enabled in this Android build.'}],ta);}}})),ta);return;
  }
  const rows=Array.isArray(value)?value:[];androidLspShowPanel('Document highlights · '+rows.length,rows.map(x=>({label:'Line '+((x.range&&x.range.start&&x.range.start.line||0)+1),detail:'Highlight kind '+(x.kind||'text')})),ta);
}
async function androidLspShowDiagnostics(){
  const ctx=await androidLspActiveDocument();if(!ctx)return;const result=await bcall('/lsp/diagnostics',{id:ctx.session.id,uri:ctx.tab.lspUri||''});const rows=[];
  for(const doc of result.items||[])for(const d of doc.diagnostics||[]){const severity=['','Error','Warning','Information','Hint'][d.severity||0]||'Diagnostic';rows.push({label:severity+' · line '+((d.range&&d.range.start&&d.range.start.line||0)+1),detail:d.message||'',onSelect:()=>{const r=d.range;if(r){const text=ctx.ta.value,offset=text.split('\n').slice(0,r.start.line).reduce((n,line)=>n+line.length+1,0)+r.start.character;ctx.ta.focus();ctx.ta.setSelectionRange(offset,offset);}}});}
  androidLspShowPanel('Diagnostics · '+rows.length,rows,ctx.ta);
}
$('fState')?.addEventListener('click',()=>{if(androidLspLocal()&&/LSP|Language server/i.test($('fState').textContent||''))androidLspShowDiagnostics().catch(e=>vscodeMktStatus(e.message||String(e),true));});
window.addEventListener('keydown',e=>{
  if(document.activeElement!==$('edTa')||!androidLspLocal())return;
  if(e.altKey&&e.key==='F1'){e.preventDefault();androidLspRequestFeature('hover').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if(e.shiftKey&&e.key==='F12'){e.preventDefault();androidLspRequestFeature('references').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.code==='KeyO'){e.preventDefault();androidLspRequestFeature('symbols').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if(e.shiftKey&&e.altKey&&e.key.toLowerCase()==='f'){e.preventDefault();androidLspAdvanced('format').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if(e.key==='F2'){e.preventDefault();androidLspAdvanced('rename').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.code==='Space'){e.preventDefault();androidLspAdvanced('signature').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if((e.ctrlKey||e.metaKey)&&e.code==='Period'){e.preventDefault();androidLspAdvanced('actions').catch(err=>vscodeMktStatus(err.message||String(err),true));}
  else if(e.altKey&&e.key==='F3'){e.preventDefault();androidLspAdvanced('highlights').catch(err=>vscodeMktStatus(err.message||String(err),true));}
});
document.addEventListener('keydown',async e=>{
  if(e.key!=='F12'||e.shiftKey||!androidLspLocal()||document.activeElement!==$('edTa'))return;
  const tab=activeFileTab(),ta=$('edTa');if(!tab||!ta)return;e.preventDefault();
  try{const language=androidLspLanguage(tab),session=await androidLspEnsureSession(language);if(!session)return;
    const key=session.id+'|'+tab.path;if(!androidLspOpenDocs.has(key)){await bcall('/lsp/document/open',{id:session.id,path:tab.path,languageId:language,text:ta.value});androidLspOpenDocs.add(key);}
    const before=ta.value.slice(0,ta.selectionStart),lines=before.split('\n');const req=await bcall('/lsp/definition',{id:session.id,path:tab.path,line:lines.length-1,character:lines[lines.length-1].length});const response=await androidLspWaitResponse(session.id,req.requestId,1800);let loc=response&&response.result;if(Array.isArray(loc))loc=loc[0];if(loc&&loc.uri&&loc.range){const root=String((B.info&&B.info.root)||'');const absolute=decodeURIComponent(new URL(loc.uri).pathname);if(root&&absolute.startsWith(root+'/')){const target=await openFile(absolute.slice(root.length+1));if(target){const text=target.text||'',offset=text.split('\n').slice(0,loc.range.start.line).reduce((n,line)=>n+line.length+1,0)+loc.range.start.character;const editor=$('edTa');editor.focus();editor.setSelectionRange(offset,offset);}}}
  }catch(err){if($('fState'))$('fState').textContent='Definition lookup: '+String(err.message||err).slice(0,100);}
});
setInterval(()=>{if(typeof curView!=='undefined'&&curView==='ext'&&document.visibilityState!=='hidden'){for(const [key,host] of vscodeHosts)if(host.mode==='node'&&host.ready)vscodeSyncNodeUi(key);}},1600);

async function vscodeLoadMarketplace() {
  if (!B.ok) { vscodeMktStatus('Connect CodeSpace to the local Agent Server first.', true); return; }
  await vscodeLoadInstalled();
  if (!vscodeMktResultsLoaded) vscodeMktResultsLoaded = await vscodeMarketplaceSearch(true);
}
let vscodeMktResultsLoaded = false;
$('extMktSearch').addEventListener('click', () => { vscodeMarketplaceSearch(false); });
$('extMktQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); vscodeMarketplaceSearch(false); } });
$('extVsixRefresh').addEventListener('click', () => vscodeLoadInstalled(true));
const onViewOpenBeforeVsix = onViewOpen;
onViewOpen = function(v) { onViewOpenBeforeVsix(v); if (v === 'ext') vscodeLoadMarketplace(); };
window.addEventListener('beforeunload', () => { [...vscodeHosts.keys()].forEach(key => { vscodeHostStop(key); }); });
