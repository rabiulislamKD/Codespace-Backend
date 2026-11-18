'use strict';
// CodeSpace Node.js Extension Host (3.18.0).
// Run only as a child process with Node --permission. Extension code is not trusted.
// Workspace access is RPC-mediated by agent-server.js; direct fs access is limited by Node.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const Module = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EventEmitter: NativeEventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const [extensionDirArg, mainPathArg, extensionKey, workspaceRootArg, stateDirArg, extensionId, nativeAddonsFlag] = process.argv.slice(2);
const nativeAddonsAllowed = nativeAddonsFlag === '1';
const extensionDir = path.resolve(extensionDirArg || '.');
const mainPath = String(mainPathArg || '');
const workspaceRoot = workspaceRootArg && workspaceRootArg !== '-' ? path.resolve(workspaceRootArg) : null;
const stateDir = path.resolve(stateDirArg || path.join(extensionDir, '.codespace-state'));
fs.mkdirSync(stateDir, { recursive: true });
const ipc = fs.createWriteStream(null, { fd: 3, autoClose: false });
const send = (type, data = {}) => { try { ipc.write(JSON.stringify({ type, ...data }) + '\n'); } catch {} };
const blocked = new Set(['cluster','node:cluster','worker_threads','node:worker_threads','http','node:http','https','node:https','http2','node:http2','tls','node:tls','dns','node:dns','dgram','node:dgram','inspector','node:inspector','electron','node:electron','undici','node:undici','module','node:module','vm','node:vm']);
const originalLoad = Module._load;
let vscode;
let childProcessShim;
const socketDenied = () => { throw new Error('Socket networking is disabled in CodeSpace extensions; use a managed stdio language-server process instead.'); };
const ipv4 = value => { const parts=String(value||'').split('.'); return parts.length===4&&parts.every(x=>/^\d{1,3}$/.test(x)&&Number(x)<=255); };
const restrictedNetShim = { isIP:value => ipv4(value)?4:(String(value||'').includes(':')?6:0), isIPv4:ipv4, isIPv6:value=>String(value||'').includes(':'), connect:socketDenied, createConnection:socketDenied, createServer:socketDenied, Socket:class DisabledSocket { constructor(){socketDenied();} }, Server:class DisabledServer { constructor(){socketDenied();} }, BlockList:class DisabledBlockList { addAddress(){socketDenied();} addRange(){socketDenied();} addSubnet(){socketDenied();} check(){return false;} }, getDefaultAutoSelectFamily:()=>false, setDefaultAutoSelectFamily:()=>{}, getDefaultAutoSelectFamilyAttemptTimeout:()=>250, setDefaultAutoSelectFamilyAttemptTimeout:()=>{} };
Module._load = function(request, parent, isMain) {
  const name = String(request || '');
  if (name === 'vscode') return vscode;
  if (name === 'child_process' || name === 'node:child_process') return childProcessShim;
  if (name === 'net' || name === 'node:net') return restrictedNetShim;
  if (blocked.has(name)) throw new Error('CodeSpace Node Extension Host blocks module: ' + name);
  return originalLoad.call(this, request, parent, isMain);
};
if (typeof process.getBuiltinModule === 'function') {
  const originalGetBuiltin = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = name => {
    const key = String(name || '');
    if (key === 'vscode') return vscode;
    if (key === 'child_process' || key === 'node:child_process') return childProcessShim;
    if (key === 'net' || key === 'node:net') return restrictedNetShim;
    if (blocked.has(key)) throw new Error('CodeSpace Node Extension Host blocks module: ' + key);
    return originalGetBuiltin(key);
  };
}
try { process.binding = () => { throw new Error('process.binding is unavailable in CodeSpace extensions'); }; } catch {}
if (!nativeAddonsAllowed) { try { process.dlopen = () => { throw new Error('Native add-ons require the Native extension code permission'); }; } catch {} }
try { global.fetch = async () => { throw new Error('Network access is unavailable in the CodeSpace Node Extension Host'); }; } catch {}
// Node 22 exposes WebSocket globally even when HTTP/TLS modules are blocked.
// Disable global browser-style network transports as well.
for (const name of ['WebSocket', 'EventSource', 'WebTransport', 'XMLHttpRequest']) {
  try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {}
}
try { process._linkedBinding = () => { throw new Error('Linked native bindings are unavailable in CodeSpace extensions'); }; } catch {}
// Node's Permission Model does not block process-level signalling. Prevent extension code
// from signalling another same-user process or asking it to enable the inspector.
for (const name of ['kill', '_debugProcess', 'abort']) {
  try { Object.defineProperty(process, name, { value: () => { throw new Error('process.' + name + ' is unavailable in the CodeSpace Node Extension Host'); }, configurable: false, writable: false }); } catch {}
}
console.log = (...a) => send('log', { level: 'info', message: a.map(safeString).join(' ').slice(0, 3000) });
console.info = console.log;
console.warn = (...a) => send('log', { level: 'warning', message: a.map(safeString).join(' ').slice(0, 3000) });
console.error = (...a) => send('log', { level: 'error', message: a.map(safeString).join(' ').slice(0, 3000) });

const pending = new Map(); let rpcSeq = 0; const commands = new Map(); const subscriptions = []; const extensionData = {};
const managedProcesses = new Map(); const terminals = new Map(); const webviews = new Map(); const debugFactories = new Map(); const debugProviders = new Map(); const debugSessions = new Map(); const featureProviders = new Map(); const diagnosticCollections = new Map(); const webviewViewProviders = new Map();
let managedSeq = 0;
function stopManagedDebugSession(sessionId) {
  const id=String(sessionId||''), old=debugSessions.get(id); if(!old)return false;
  try { if(old.proc) old.proc.kill(); } catch {}
  debugSessions.delete(id);
  if(!old.proc) send('debugTerminated',{sessionId:id});
  return true;
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'rpcResult') {
    const p = pending.get(message.requestId); if (!p) return; pending.delete(message.requestId);
    message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
  } else if (message.type === 'runCommand') {
    const fn = commands.get(String(message.command));
    if (!fn) return send('commandResult', { requestId: message.requestId, error: 'Command is not registered' });
    Promise.resolve().then(() => fn(...(Array.isArray(message.args) ? message.args : [])))
      .then(result => send('commandResult', { requestId: message.requestId, result: serializable(result) }))
      .catch(error => send('commandResult', { requestId: message.requestId, error: error && error.message || String(error) }));
  } else if (message.type === 'processOutput') { const proc = managedProcesses.get(String(message.processId)); if (proc) (message.stream === 'stderr' ? proc.stderr : proc.stdout).write(Buffer.from(String(message.data || ''), 'base64')); }
  else if (message.type === 'processExit') { const proc = managedProcesses.get(String(message.processId)); if (proc) { proc.exitCode = message.code; proc.signalCode = message.signal || null; proc.stdout.end(); proc.stderr.end(); proc.emit('exit', proc.exitCode, proc.signalCode); proc.emit('close', proc.exitCode, proc.signalCode); managedProcesses.delete(String(message.processId)); } }
  else if (message.type === 'webviewMessage') { const view = webviews.get(String(message.panelId)); if (view) view._receive(message.message); }
  else if (message.type === 'webviewDisposed') { const view = webviews.get(String(message.panelId)); if (view) view._disposeFromHost(); }
  else if (message.type === 'featureRequest') { Promise.resolve().then(() => runFeatureRequest(message)).then(result => send('featureResult', { requestId: message.requestId, result: serializable(result) })).catch(error => send('featureResult', { requestId: message.requestId, error: error.message || String(error) })); }
  else if (message.type === 'documentSync') { try { if (globalThis.__codespaceSyncDocument) globalThis.__codespaceSyncDocument(message); } catch (error) { send('log', { level:'warning', message:'Document sync: ' + (error.message || String(error)) }); } }
  else if (message.type === 'openWebviewView') { Promise.resolve().then(() => openWebviewView(message.viewType)).catch(error => send('log', { level:'error', message:'Webview view could not open: ' + (error.message || String(error)) })); }
  else if (message.type === 'stopDebug') { stopManagedDebugSession(message.sessionId); }
  else if (message.type === 'shutdown') shutdown();
});
function rpc(method, args = {}) {
  const requestId = 'rpc-' + (++rpcSeq);
  return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); send('rpc', { requestId, method, args }); setTimeout(() => { if (pending.has(requestId)) { pending.delete(requestId); reject(new Error('Workspace API request timed out')); } }, 20000).unref?.(); });
}
function makeManagedChild(command, args, options = {}) {
  const proc = new NativeEventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  let pendingInput = [], endedBeforeReady = false, spawnReady = false;
  proc.stdin = { write(data) { const text = Buffer.isBuffer(data) ? data.toString() : String(data); if (!spawnReady) { pendingInput.push(text); return true; } rpc('process.write', { processId: proc.__codespaceId, data: text }).catch(e => proc.emit('error', e)); return true; }, end(data) { if (data) this.write(data); if (!spawnReady) { endedBeforeReady = true; return; } rpc('process.end', { processId: proc.__codespaceId }).catch(() => {}); } };
  proc.pid = undefined; proc.exitCode = null; proc.signalCode = null; proc.kill = signal => { if (!spawnReady) { proc.once('spawn', () => proc.kill(signal)); return true; } rpc('process.kill', { processId: proc.__codespaceId, signal: String(signal || 'SIGTERM') }).catch(e => proc.emit('error', e)); return true; };
  proc.unref = () => proc; proc.ref = () => proc; proc.connected = true; proc.spawnargs = [String(command), ...(Array.isArray(args) ? args.map(String) : [])]; proc.spawnfile = String(command);
  rpc('process.spawn', { command: String(command), args: Array.isArray(args) ? args.map(String).slice(0, 128) : [], cwd: options.cwd ? String(options.cwd) : undefined, env: options.env && typeof options.env === 'object' ? options.env : undefined }).then(info => { proc.__codespaceId = String(info.processId); proc.pid = Number(info.pid) || undefined; managedProcesses.set(proc.__codespaceId, proc); spawnReady = true; proc.emit('spawn'); for (const data of pendingInput.splice(0)) proc.stdin.write(data); if (endedBeforeReady) proc.stdin.end(); }, e => proc.emit('error', e));
  return proc;
}
childProcessShim = {
  spawn(command, args, options) { if (!Array.isArray(args)) { options = args || {}; args = []; } return makeManagedChild(command, args, options || {}); },
  execFile(command, args, options, callback) {
    if (!Array.isArray(args)) { callback = options; options = args || {}; args = []; }
    if (typeof options === 'function') { callback = options; options = {}; }
    const proc = makeManagedChild(command, args, options || {}); let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c.toString(); if (stdout.length > 2e6) stdout = stdout.slice(-2e6); });
    proc.stderr.on('data', c => { stderr += c.toString(); if (stderr.length > 2e6) stderr = stderr.slice(-2e6); });
    if (typeof callback === 'function') proc.once('close', (code, signal) => callback(code ? Object.assign(new Error('Process exited with code ' + code), { code, signal, stdout, stderr }) : null, stdout, stderr));
    return proc;
  },
  exec() { throw new Error('child_process.exec is not supported; use execFile or spawn with a declared executable'); },
  spawnSync() { throw new Error('Synchronous child processes are not supported by CodeSpace'); },
  execSync() { throw new Error('Synchronous child processes are not supported by CodeSpace'); },
  fork() { throw new Error('Forked Node processes are not supported by CodeSpace'); }
};

// Intercept ESM imports of child_process in the same isolate. This lets common
// vscode-languageclient/node packages use `import { spawn } from 'node:child_process'`
// without ever receiving the real OS process API. Dangerous built-ins remain blocked.
function installEsmRuntimeHooks() {
  if (typeof Module.registerHooks !== 'function') throw new Error('Node.js 22.15 or newer is required for the CodeSpace ESM extension loader.');
  const childUrl = 'codespace-extension-host:child-process';
  const netUrl = 'codespace-extension-host:net';
  const blockedUrl = 'codespace-extension-host:blocked';
  const blockedMessage = name => `throw new Error(${JSON.stringify('CodeSpace Node Extension Host blocks module: ')} + ${JSON.stringify(name)});`;
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = String(specifier || '');
      if (name === 'child_process' || name === 'node:child_process') return { url: childUrl, shortCircuit: true };
      if (name === 'net' || name === 'node:net') return { url: netUrl, shortCircuit: true };
      if (blocked.has(name)) return { url: blockedUrl + '/' + encodeURIComponent(name), shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === childUrl) return { format: 'module', shortCircuit: true, source: `const api = globalThis.__codespaceChildProcess; if (!api) throw new Error('CodeSpace process bridge is unavailable'); export default api; export const spawn=api.spawn, execFile=api.execFile, exec=api.exec, spawnSync=api.spawnSync, execSync=api.execSync, fork=api.fork, constants=api.constants;` };
      if (url === netUrl) return { format: 'module', shortCircuit: true, source: `const api=globalThis.__codespaceNet; if(!api) throw new Error('CodeSpace network bridge unavailable'); export default api; export const isIP=api.isIP,isIPv4=api.isIPv4,isIPv6=api.isIPv6,connect=api.connect,createConnection=api.createConnection,createServer=api.createServer,Socket=api.Socket,Server=api.Server,BlockList=api.BlockList;` };
      if (url.startsWith(blockedUrl + '/')) {
        const name = decodeURIComponent(url.slice((blockedUrl + '/').length));
        return { format: 'module', shortCircuit: true, source: blockedMessage(name) };
      }
      return nextLoad(url, context);
    }
  });
}
function safeString(value) { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } }
function serializable(value) { if (value === undefined) return undefined; try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } }
function Disposable(fn) { this.fn = typeof fn === 'function' ? fn : null; }
Disposable.prototype.dispose = function() { if (this.fn) { const f = this.fn; this.fn = null; try { f(); } catch {} } };
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (listener, thisArgs, disposables) => { const entry = (...args) => listener.apply(thisArgs, args); this.listeners.add(entry); const disposable = new Disposable(() => this.listeners.delete(entry)); if (Array.isArray(disposables)) disposables.push(disposable); return disposable; }; }
  fire(value) { for (const fn of [...this.listeners]) { try { fn(value); } catch (e) { send('log', { level: 'error', message: e.message || String(e) }); } } }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(scheme, authority, uriPath, query = '', fragment = '') { this.scheme = scheme || 'file'; this.authority = authority || ''; this.path = uriPath || ''; this.query = query || ''; this.fragment = fragment || ''; this.fsPath = this.scheme === 'file' ? (this.authority ? `//${this.authority}${this.path}` : this.path) : this.path; }
  static parse(value) { const u = new URL(String(value)); return new Uri(u.protocol.replace(/:$/, ''), u.host, decodeURIComponent(u.pathname), u.search.replace(/^\?/, ''), u.hash.replace(/^#/, '')); }
  static file(value) { const p = path.resolve(String(value)); return new Uri('file', '', process.platform === 'win32' ? p.replace(/\\/g, '/') : p); }
  static joinPath(base, ...parts) { const joined = path.posix.join(String(base.path || ''), ...parts.map(String)); return new Uri(base.scheme, base.authority, joined, base.query, base.fragment); }
  static from(parts) { return new Uri(parts.scheme, parts.authority, parts.path, parts.query, parts.fragment); }
  with(change = {}) { return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment); }
  toString() { if (this.scheme === 'file') return pathToFileURL(this.fsPath).toString(); const u = new URL(this.scheme + '://' + this.authority + this.path); if (this.query) u.search = this.query; if (this.fragment) u.hash = this.fragment; return u.toString(); }
}
class Position { constructor(line, character) { this.line = Math.max(0, Number(line) || 0); this.character = Math.max(0, Number(character) || 0); } isBefore(p) { return this.line < p.line || this.line === p.line && this.character < p.character; } isEqual(p) { return this.line === p.line && this.character === p.character; } isAfter(p) { return !this.isBefore(p) && !this.isEqual(p); } isBeforeOrEqual(p) { return this.isBefore(p) || this.isEqual(p); } isAfterOrEqual(p) { return !this.isBefore(p); } compareTo(p) { return this.isBefore(p) ? -1 : this.isEqual(p) ? 0 : 1; } translate(dl = 0, dc = 0) { return new Position(this.line + dl, this.character + dc); } with(line = this.line, character = this.character) { return new Position(line, character); } }
class Range {
  // Supports both new Range(startPosition, endPosition) and new Range(startLine, startChar, endLine, endChar); start is always <= end.
  constructor(a, b, c, d) {
    let start, end;
    if (a instanceof Position) { start = a; end = b instanceof Position ? b : a; } else { start = new Position(a, b); end = c instanceof Position ? c : new Position(c, d); }
    if (end.isBefore(start)) [start, end] = [end, start];
    this.start = start; this.end = end;
  }
  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }
  contains(p) { const pos = p instanceof Range ? p.start : p; const last = p instanceof Range ? p.end : p; return !pos.isBefore(this.start) && !this.end.isBefore(last); }
  isEqual(r) { return this.start.isEqual(r.start) && this.end.isEqual(r.end); }
  intersection(r) { const start = this.start.isBefore(r.start) ? r.start : this.start, end = this.end.isBefore(r.end) ? this.end : r.end; return end.isBefore(start) ? undefined : new Range(start, end); }
  union(r) { return new Range(this.start.isBefore(r.start) ? this.start : r.start, this.end.isBefore(r.end) ? r.end : this.end); }
  with(start = this.start, end = this.end) { return new Range(start, end); }
}
class Selection extends Range {
  constructor(a, b, c, d) { super(a, b, c, d); const anchor = a instanceof Position ? a : new Position(a, b), active = a instanceof Position ? (b instanceof Position ? b : a) : (c instanceof Position ? c : new Position(c, d)); this.anchor = anchor; this.active = active; }
  get isReversed() { return this.anchor.isEqual(this.end) && !this.anchor.isEqual(this.start); }
}
class Location { constructor(uri, range) { this.uri = uri; this.range = range; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = String(message || ''); this.severity = severity; this.source = ''; this.code = undefined; this.tags = []; this.relatedInformation = []; } }
class MarkdownString { constructor(value = '') { this.value = String(value); this.isTrusted = false; this.supportHtml = false; } appendText(value) { this.value += String(value); return this; } appendMarkdown(value) { this.value += String(value); return this; } }
class TextEdit { constructor(range, newText) { this.range = range; this.newText = String(newText ?? ''); } static replace(range, text) { return new TextEdit(range, text); } static insert(position, text) { return new TextEdit(new Range(position, position), text); } static delete(range) { return new TextEdit(range, ''); } }
class WorkspaceEdit { constructor() { this.entries = []; } replace(uri, range, text) { this.entries.push({ type: 'replace', uri, range, text: String(text) }); } insert(uri, position, text) { this.entries.push({ type: 'insert', uri, position, text: String(text) }); } delete(uri, range) { this.entries.push({ type: 'delete', uri, range }); } set(uri, edits) { for (const e of edits || []) this.replace(uri, e.range, e.newText); } }
class FileSystemError extends Error {
  constructor(messageOrUri, code = 'Unknown') { super(String(messageOrUri === undefined || messageOrUri === null ? '' : messageOrUri)); this.name = 'FileSystemError'; this.code = code; }
  static FileNotFound(uri) { return new FileSystemError('File not found: ' + (uri && uri.path || uri), 'FileNotFound'); }
  static FileExists(uri) { return new FileSystemError('File exists: ' + (uri && uri.path || uri), 'FileExists'); }
  static FileNotADirectory(uri) { return new FileSystemError('File is not a directory: ' + (uri && uri.path || uri), 'FileNotADirectory'); }
  static FileIsADirectory(uri) { return new FileSystemError('File is a directory: ' + (uri && uri.path || uri), 'FileIsADirectory'); }
  static NoPermissions(uri) { return new FileSystemError('Permission denied: ' + (uri && uri.path || uri), 'NoPermissions'); }
  static Unavailable(uri) { return new FileSystemError('Unavailable: ' + (uri && uri.path || uri), 'Unavailable'); }
}
class CancellationTokenSource { constructor() { this.emitter = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event }; } cancel() { this.token.isCancellationRequested = true; this.emitter.fire(undefined); } dispose() { this.emitter.dispose(); } }
const settings = loadJson(path.join(stateDir, 'state.json'), {});
const extensionManifest = loadJson(path.join(extensionDir, 'package.json'), {});
vscode = createVscodeApi();
function saveSettings() { try { fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(settings, null, 2)); } catch (e) { send('log', { level: 'warning', message: 'Could not persist extension state: ' + e.message }); } }
function memento(name) { const data = settings[name] && typeof settings[name] === 'object' ? settings[name] : (settings[name] = {}); return { get: (key, def) => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : def, update: async (key, value) => { if (value === undefined) delete data[key]; else data[key] = value; saveSettings(); }, keys: () => Object.keys(data), setKeysForSync: async keys => { settings[name + 'SyncKeys'] = Array.isArray(keys) ? keys : []; saveSettings(); } }; }
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function uriArg(uri) { if (uri instanceof Uri) return { scheme: uri.scheme, path: uri.path, fsPath: uri.fsPath, authority: uri.authority }; if (typeof uri === 'string') return { path: uri, fsPath: uri }; return uri || {}; }
function collectConfigurationDefaults(manifest) {
  const defaults = Object.create(null);
  const blocks = manifest && manifest.contributes && manifest.contributes.configuration;
  for (const block of (Array.isArray(blocks) ? blocks : blocks ? [blocks] : [])) {
    const properties = block && block.properties && typeof block.properties === 'object' ? block.properties : {};
    for (const [key, schema] of Object.entries(properties)) if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) defaults[key] = schema.default;
  }
  return defaults;
}
function workspaceFs() {
  const call = (method, args) => rpc('workspace.' + method, args);
  return {
    readFile: async uri => Buffer.from((await call('readFile', { uri: uriArg(uri) })).base64, 'base64'),
    writeFile: (uri, data) => call('writeFile', { uri: uriArg(uri), base64: Buffer.from(data || []).toString('base64') }),
    stat: uri => call('stat', { uri: uriArg(uri) }),
    readDirectory: uri => call('readDirectory', { uri: uriArg(uri) }),
    createDirectory: uri => call('createDirectory', { uri: uriArg(uri) }),
    delete: (uri, options = {}) => call('delete', { uri: uriArg(uri), options }),
    rename: (oldUri, newUri, options = {}) => call('rename', { oldUri: uriArg(oldUri), newUri: uriArg(newUri), options }),
    copy: (source, destination, options = {}) => call('copy', { source: uriArg(source), destination: uriArg(destination), options }),
    isWritableFileSystem: scheme => scheme === 'file'
  };
}
function createDapClient(proc, sessionId) {
  let buffer = Buffer.alloc(0), seq = 1; const pendingDap = new Map(); let initialized = false;
  function sendFrame(frame) { const body=Buffer.from(JSON.stringify(frame)); proc.stdin.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body])); }
  function request(command,args={}) { const requestSeq=seq++; const frame={seq:requestSeq,type:'request',command,arguments:args||{}}; return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pendingDap.delete(requestSeq);reject(new Error('Debug adapter request timed out: '+command));},20000);pendingDap.set(requestSeq,{resolve,reject,timer,command});sendFrame(frame);}); }
  proc.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,Buffer.from(chunk)]);if(buffer.length>2e6){buffer=Buffer.alloc(0);send('log',{level:'error',message:'Debug Adapter Protocol buffer exceeded 2 MB'});return;}while(true){const split=buffer.indexOf('\r\n\r\n');if(split<0)break;const head=buffer.subarray(0,split).toString('ascii');const match=head.match(/Content-Length:\s*(\d+)/i);if(!match){buffer=buffer.subarray(split+4);continue;}const len=Math.min(1e6,Number(match[1])||0);if(buffer.length<split+4+len)break;const body=buffer.subarray(split+4,split+4+len);buffer=buffer.subarray(split+4+len);let msg;try{msg=JSON.parse(body.toString('utf8'));}catch{continue;}if(msg.type==='response'){const p=pendingDap.get(Number(msg.request_seq));if(p){clearTimeout(p.timer);pendingDap.delete(Number(msg.request_seq));msg.success===false?p.reject(new Error(msg.message||'Debug adapter request failed')):p.resolve(msg);}}else if(msg.type==='event'){send('debugEvent',{sessionId,event:msg.event,body:serializable(msg.body)});if(msg.event==='initialized'&&!initialized){initialized=true;request('configurationDone',{}).catch(e=>send('log',{level:'warning',message:'Debug configurationDone: '+e.message}));}}else if(msg.type==='request'){send('log',{level:'info',message:'Debug adapter requested '+String(msg.command||'unknown')+'; this request requires adapter-specific support.'});}}});
  proc.stderr.on('data',chunk=>send('log',{level:'debug',message:'debug adapter: '+chunk.toString('utf8').slice(0,1000)}));
  proc.once('close',()=>{for(const p of pendingDap.values()){clearTimeout(p.timer);p.reject(new Error('Debug adapter exited'));}pendingDap.clear();send('debugTerminated',{sessionId});});
  return {request,sendFrame};
}
function createVscodeApi() {
  const commandEmitter = new EventEmitter();
  const configDefaults = collectConfigurationDefaults(extensionManifest);
  const commandsApi = {
    registerCommand(id, handler) { if (typeof handler !== 'function') throw new TypeError('Command handler must be a function'); id = String(id); commands.set(id, handler); send('commandRegistered', { command: id }); const d = new Disposable(() => { commands.delete(id); send('commandRemoved', { command: id }); }); subscriptions.push(d); return d; },
    registerTextEditorCommand(id, handler) { return this.registerCommand(id, (...args) => handler(window.activeTextEditor, ...args)); },
    executeCommand(id, ...args) { const fn = commands.get(String(id)); if (fn) return Promise.resolve().then(() => fn(...args)); return rpc('command.executeBuiltIn', { command: String(id), args }); },
    getCommands() { return Promise.resolve([...commands.keys()]); }, onDidExecuteCommand: commandEmitter.event
  };
  function message(level, args) { send('notification', { level, message: args.map(safeString).join(' ').slice(0, 1500) }); return Promise.resolve(undefined); }
  function output(name) { return { name: String(name), append: s => send('output', { channel: String(name), message: String(s) }), appendLine: s => send('output', { channel: String(name), message: String(s) }), clear: () => send('output', { channel: String(name), message: '' }), replace: s => send('output', { channel: String(name), message: String(s) }), show: () => {}, hide: () => {}, dispose: () => {} }; }
  function statusBarItem(alignment, priority) { const item = { alignment, priority, text: '', tooltip: '', color: '', command: undefined, name: '', show() { send('statusBar', { text: this.text, tooltip: this.tooltip, command: this.command }); }, hide() { send('statusBar', { text: '' }); }, dispose() { this.hide(); } }; return item; }
  const folderUri = workspaceRoot ? Uri.file(workspaceRoot) : null;
  const workspaceEmitter = { config: new EventEmitter(), open: new EventEmitter(), save: new EventEmitter(), change: new EventEmitter(), close: new EventEmitter(), willSave: new EventEmitter() };
  const workspace = {
    name: workspaceRoot ? path.basename(workspaceRoot) : undefined,
    rootPath: workspaceRoot || undefined,
    workspaceFolders: workspaceRoot ? [{ uri: folderUri, name: path.basename(workspaceRoot), index: 0 }] : undefined,
    textDocuments: [],
    fs: workspaceFs(),
    getConfiguration(section = '') { const key = String(section || ''); return { get: (name, def) => { const k = key ? key + '.' + name : name; return Object.prototype.hasOwnProperty.call(settings.configuration || {}, k) ? settings.configuration[k] : Object.prototype.hasOwnProperty.call(configDefaults, k) ? configDefaults[k] : def; }, has: name => Object.prototype.hasOwnProperty.call(settings.configuration || {}, key ? key + '.' + name : name), update: async (name, value) => { settings.configuration = settings.configuration || {}; const k = key ? key + '.' + name : name; if (value === undefined) delete settings.configuration[k]; else settings.configuration[k] = value; saveSettings(); { const changed = key ? key + '.' + name : name; workspaceEmitter.config.fire({ affectsConfiguration: s => { s = String(s || ''); return s === changed || changed.startsWith(s + '.') || s.startsWith(changed + '.'); } }); } }, inspect: name => ({ key: key ? key + '.' + name : name, globalValue: (settings.configuration || {})[key ? key + '.' + name : name], workspaceValue: undefined, defaultValue: configDefaults[key ? key + '.' + name : name] }) }; },
    onDidChangeConfiguration: workspaceEmitter.config.event,
    onDidOpenTextDocument: workspaceEmitter.open.event, onDidSaveTextDocument: workspaceEmitter.save.event,
    onDidChangeTextDocument: workspaceEmitter.change.event, onDidCloseTextDocument: workspaceEmitter.close.event,
    onWillSaveTextDocument: workspaceEmitter.willSave.event,
    async findFiles(include = '**/*', exclude, maxResults = 1000) { return (await rpc('workspace.findFiles', { include: String(include && typeof include === 'object' && include.pattern || include), exclude: String(exclude && typeof exclude === 'object' && exclude.pattern || exclude || ''), maxResults: Math.max(1, Math.min(2000, Number(maxResults) || 1000)) })).map(x => Uri.file(x)); },
    async openTextDocument(input) { const uri = typeof input === 'string' ? Uri.file(path.resolve(workspaceRoot || extensionDir, input)) : input && input.scheme ? input : Uri.file(path.resolve(workspaceRoot || extensionDir, String(input || ''))); const key=uri.toString(); if(documentCache.has(key))return documentCache.get(key); const data = await rpc('workspace.openTextDocument', { uri: uriArg(uri) }); const doc = makeTextDocument(uri, data.text, data.languageId); documentCache.set(key,doc); workspace.textDocuments.push(doc); workspaceEmitter.open.fire(doc); return doc; },
    async applyEdit(edit) {
      const byFile = new Map();
      for (const e of (edit && edit.entries) || []) { if (!['replace', 'insert', 'delete'].includes(e.type)) continue; const key = e.uri.toString(); if (!byFile.has(key)) byFile.set(key, { uri: e.uri, list: [] }); byFile.get(key).list.push(e); }
      for (const { uri, list } of byFile.values()) {
        const doc = await this.openTextDocument(uri); const original = doc.getText();
        const resolved = list.map((e, index) => { const start = e.range ? e.range.start : e.position, end = e.range ? e.range.end : start; return { index, from: doc.offsetAt(start), to: doc.offsetAt(end), text: e.type === 'delete' ? '' : String(e.text || '') }; })
          .sort((a, b) => a.from - b.from || a.index - b.index);
        let content = original;
        for (let i = resolved.length - 1; i >= 0; i--) { const r = resolved[i]; content = content.slice(0, r.from) + r.text + content.slice(r.to); }
        await this.fs.writeFile(uri, Buffer.from(content)); doc._update(content, undefined, undefined, false);
      }
      return true;
    },
    createFileSystemWatcher() { const a=new EventEmitter(),b=new EventEmitter(),c=new EventEmitter(); return { onDidCreate:a.event,onDidChange:b.event,onDidDelete:c.event, dispose(){a.dispose();b.dispose();c.dispose();} }; }
  };
  const documentCache = new Map();
  function makeTextDocument(uri, text, languageId, version = 1) {
    let value = String(text || ''), currentVersion = Number(version) || 1, dirty = false;
    const lines = () => value.split('\n');
    const doc = {
      uri, fileName: uri.fsPath, languageId: languageId || path.extname(uri.fsPath).slice(1), get isDirty() { return dirty; }, isUntitled: false,
      get lineCount() { return lines().length; }, get version() { return currentVersion; },
      getText(range) { if (!range) return value; const a = this.offsetAt(range.start), b = this.offsetAt(range.end); return value.slice(a, b); },
      lineAt(n) { if (n && typeof n === 'object') n = n.line; const row = lines(), line = row[n] || ''; return { lineNumber:n, text:line, range:new Range(new Position(n,0),new Position(n,line.length)), rangeIncludingLineBreak:new Range(new Position(n,0),new Position(n,line.length+1)), firstNonWhitespaceCharacterIndex:Math.max(0,line.search(/\S|$/)), isEmptyOrWhitespace:!line.trim() }; },
      positionAt(offset) { const before = value.slice(0, Math.max(0, Number(offset)||0)).split('\n'); return new Position(before.length-1,before[before.length-1].length); },
      offsetAt(pos) { return lines().slice(0,pos.line).reduce((n,l)=>n+l.length+1,0)+pos.character; },
      getWordRangeAtPosition(pos, regex = /[\w$]+/) { const row=lines()[pos.line]||''; const re=new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g'); let m; while((m=re.exec(row))){ if(pos.character>=m.index&&pos.character<=m.index+m[0].length)return new Range(new Position(pos.line,m.index),new Position(pos.line,m.index+m[0].length)); if(!m[0].length)re.lastIndex++; } return undefined; },
      save: async () => { if (!dirty) return true; await workspace.fs.writeFile(uri, Buffer.from(value, 'utf8')); dirty = false; workspaceEmitter.save.fire(doc); return true; }, validateRange: r => r, validatePosition: p => p,
      _update(nextText, nextVersion, nextLanguage, markDirty = true) { value=String(nextText ?? ''); currentVersion=Number(nextVersion)||currentVersion+1; if(nextLanguage)this.languageId=String(nextLanguage); dirty=!!markDirty; }
    };
    return doc;
  }
  function syncWorkspaceDocument(message) {
    const event = String(message.event || ''), file = String(message.path || '');
    if (!file || !workspaceRoot) return;
    const uri = Uri.file(path.resolve(workspaceRoot, file));
    const key = uri.toString(); let doc = documentCache.get(key);
    if (event === 'close') { if (doc) { workspaceEmitter.close.fire(doc); documentCache.delete(key); workspace.textDocuments = workspace.textDocuments.filter(x => x !== doc); } return; }
    if (!doc) { doc=makeTextDocument(uri,message.text||'',message.languageId,message.version); documentCache.set(key,doc); workspace.textDocuments.push(doc); if(event==='open')workspaceEmitter.open.fire(doc); }
    else if (event === 'change') { const old = doc.getText(); doc._update(message.text, message.version, message.languageId, true); workspaceEmitter.change.fire({ document:doc, contentChanges:[{ range:new Range(new Position(0,0),doc.positionAt(old.length)), text:doc.getText() }], reason:undefined }); }
    if (event === 'save') { doc._update(message.text ?? doc.getText(), message.version, message.languageId, false); workspaceEmitter.save.fire(doc); }
  }
  globalThis.__codespaceSyncDocument = syncWorkspaceDocument;
  globalThis.__codespaceMakeTextDocument = makeTextDocument;
  const windowEmitter = { openTerminal: new EventEmitter(), closeTerminal: new EventEmitter(), };
  const window = {
    activeTextEditor: undefined, visibleTextEditors: [], state: { focused: false }, terminals: [], onDidOpenTerminal: windowEmitter.openTerminal.event, onDidCloseTerminal: windowEmitter.closeTerminal.event,
    createTerminal(options = {}) { const terminal = { name: String(options.name || 'Extension Terminal'), processId: undefined, creationOptions: options, _ready: null, show: () => (terminal._ready||Promise.resolve()).then(() => rpc('terminal.show', { id: terminal.__codespaceId })).catch(() => {}), hide: () => {}, sendText: (text, addNewLine = true) => (terminal._ready||Promise.resolve()).then(() => rpc('terminal.write', { id: terminal.__codespaceId, data: String(text) + (addNewLine ? (process.platform === 'win32' ? '\r\n' : '\n') : '') })), dispose: () => (terminal._ready||Promise.resolve()).then(() => { terminals.delete(terminal.__codespaceId); window.terminals = window.terminals.filter(x => x !== terminal); windowEmitter.closeTerminal.fire(terminal); return rpc('terminal.close', { id: terminal.__codespaceId }).catch(() => {}); }) }; const create = rpc('terminal.create', { name: terminal.name, cwd: options.cwd && (options.cwd.fsPath || options.cwd.path) || undefined }); terminal.processId = create.then(info => Number(info.pid) || undefined); terminal._ready = create.then(info => { terminal.__codespaceId = String(info.id); terminals.set(terminal.__codespaceId, terminal); window.terminals.push(terminal); send('terminalCreated', { id: terminal.__codespaceId, name: terminal.name }); windowEmitter.openTerminal.fire(terminal); return terminal; }).catch(e => { send('log', { level:'error', message:'Terminal could not start: ' + e.message }); throw e; }); return terminal; },
    showInformationMessage: (...a) => message('info', a), showWarningMessage: (...a) => message('warning', a), showErrorMessage: (...a) => message('error', a),
    createOutputChannel: output, createStatusBarItem: statusBarItem, setStatusBarMessage: (text, timeout) => { send('statusBar', { text: String(text) }); return new Disposable(); },
    withProgress: async (_options, task) => task({ report: p => send('progress', p) }, new CancellationTokenSource().token),
    registerWebviewViewProvider(viewType, provider, options = {}) { const key=String(viewType||''); if(!key||!provider||typeof provider.resolveWebviewView!=='function')throw new Error('registerWebviewViewProvider requires a view id and resolveWebviewView provider'); webviewViewProviders.set(key,{provider,options}); send('webviewViewRegistered',{viewType:key}); return new Disposable(()=>{webviewViewProviders.delete(key);send('webviewViewUnregistered',{viewType:key});}); },
    createWebviewPanel(viewType, title, column, options = {}) { const id = 'wv-' + (++managedSeq); const emitter = new EventEmitter(); let html = ''; const webview = { options, html: '', cspSource: 'codespace-webview:', asWebviewUri: uri => uri, postMessage: message => rpc('webview.post', { panelId:id, message:serializable(message) }), onDidReceiveMessage: emitter.event, _receive: message => emitter.fire(message), _disposeFromHost: () => { emitter.dispose(); webviews.delete(id); panelEmitter.fire(panel); } }; const panelEmitter = new EventEmitter(); const panel = { viewType:String(viewType), title:String(title), viewColumn:column || 1, webview, options, visible:true, active:true, onDidDispose:panelEmitter.event, onDidChangeViewState: new EventEmitter().event, reveal: () => rpc('webview.reveal',{panelId:id}), dispose: () => { webviews.delete(id); emitter.dispose(); panelEmitter.fire(panel); rpc('webview.dispose',{panelId:id}).catch(()=>{}); } }; Object.defineProperty(webview,'html',{get:()=>html,set:value=>{html=String(value||'').slice(0,2000000); rpc('webview.update',{panelId:id,title:panel.title,viewType:panel.viewType,html,options}).catch(e=>send('log',{level:'error',message:'Webview update failed: '+e.message})); }}); webviews.set(id,panel); rpc('webview.create',{panelId:id,title:panel.title,viewType:panel.viewType,options}).then(()=>send('webviewCreated',{panelId:id,title:panel.title})).catch(e=>send('log',{level:'error',message:'Webview could not open: '+e.message})); return panel; },
    showQuickPick: async () => undefined, showInputBox: async () => undefined,
    async showTextDocument(doc) { const editor = { document: doc, selection: new Selection(new Position(0,0),new Position(0,0)), selections: [], options: {}, viewColumn: 1, edit: async callback => { const edit = new WorkspaceEdit(); await callback({ replace: (range,text) => edit.replace(doc.uri,range,text), insert: (position,text) => edit.insert(doc.uri,position,text), delete: range => edit.delete(doc.uri,range) }); return workspace.applyEdit(edit); }, setDecorations() {}, revealRange() {} }; window.activeTextEditor = editor; window.visibleTextEditors = [editor]; return editor; }
  };
  const languages = {
    createDiagnosticCollection(name = '') { const items = new Map(); const collection = { name, _items: items, set: (uri, diagnostics) => { items.set(uri.toString(), diagnostics); send('diagnostics', { collection:name, uri: uri.toString(), diagnostics: (diagnostics || []).map(d => ({message:d.message, severity:d.severity, code:d.code, source:d.source, range:d.range})) }); }, delete: uri => { items.delete(uri.toString()); send('diagnosticsClear',{collection:name,uri:uri.toString()}); }, clear: () => { items.clear(); send('diagnosticsClear',{collection:name}); }, forEach: fn => items.forEach((v,k) => fn(Uri.parse(k),v)), dispose: () => items.clear() }; diagnosticCollections.set(name, collection); return collection; },
    getDiagnostics: uri => { const all = [...diagnosticCollections.values()]; if (uri) return all.flatMap(c => c._items.get(uri.toString()) || []); const merged = new Map(); for (const c of all) for (const [k, v] of c._items) merged.set(k, (merged.get(k) || []).concat(v)); return [...merged].map(([k, v]) => [Uri.parse(k), v]); },
    registerCompletionItemProvider: (...a) => registerFeature('completion',a), registerHoverProvider: (...a) => registerFeature('hover',a), registerDefinitionProvider: (...a) => registerFeature('definition',a), registerReferenceProvider: (...a) => registerFeature('references',a), registerDocumentFormattingEditProvider: (...a) => registerFeature('formatting',a), registerDocumentRangeFormattingEditProvider: (...a) => registerFeature('rangeFormatting',a), registerCodeActionsProvider: (...a) => registerFeature('codeActions',a), registerRenameProvider: (...a) => registerFeature('rename',a), registerSignatureHelpProvider: (...a) => registerFeature('signatureHelp',a), registerDocumentSymbolProvider: (...a) => registerFeature('documentSymbols',a), registerCodeLensProvider: (...a) => registerFeature('codeLens',a)
  };
  function registerFeature(name,args) { const id = 'feature-' + (++managedSeq); featureProviders.set(id,{name,args}); send('featureRegistered',{id,name}); const d = new Disposable(()=>{featureProviders.delete(id);send('featureUnregistered',{id,name});}); subscriptions.push(d); return d; }
  const debugEmitter = { start:new EventEmitter(), stop:new EventEmitter() };
  const debug = {
    activeDebugSession: undefined, onDidStartDebugSession: debugEmitter.start.event, onDidTerminateDebugSession: debugEmitter.stop.event,
    registerDebugConfigurationProvider(type, provider) { debugProviders.set(String(type),provider); return new Disposable(()=>debugProviders.delete(String(type))); },
    registerDebugAdapterDescriptorFactory(type, factory) { debugFactories.set(String(type),factory); return new Disposable(()=>debugFactories.delete(String(type))); },
    registerDebugAdapterTrackerFactory() { return new Disposable(); },
    async startDebugging(folder, configuration, options = {}) { const type=String(configuration && configuration.type || ''); if (!type) throw new Error('Debug configuration requires a type'); let config={...configuration}; const provider=debugProviders.get(type); if(provider && provider.resolveDebugConfiguration) config=await provider.resolveDebugConfiguration(folder,config)||config; const factory=debugFactories.get(type); if(!factory) throw new Error('No Debug Adapter Descriptor Factory is registered for '+type); const descriptor=await factory.createDebugAdapterDescriptor({configuration:config,workspaceFolder:folder}); if(!descriptor || !descriptor.command) throw new Error('CodeSpace requires a local DebugAdapterExecutable descriptor'); const proc=makeManagedChild(String(descriptor.command),Array.isArray(descriptor.args)?descriptor.args.map(String):[],{cwd:descriptor.options&&descriptor.options.cwd||workspaceRoot||extensionDir,env:descriptor.options&&descriptor.options.env||undefined}); await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Debug adapter did not start within 10 seconds')),10000);proc.once('spawn',()=>{clearTimeout(timer);resolve();});proc.once('error',e=>{clearTimeout(timer);reject(e);});}); const sessionId='dbg-'+(++managedSeq); const dap=createDapClient(proc,sessionId); const session={id:sessionId,type,name:String(config.name||type),configuration:config,customRequest:(command,args={})=>dap.request(String(command),args),getDebugProtocolBreakpoint:()=>undefined,parentSession:undefined}; debugSessions.set(sessionId,{session,dap,proc}); debug.activeDebugSession=session; try { await dap.request('initialize',{clientID:'codespace',clientName:'CodeSpace',adapterID:type,pathFormat:'path',linesStartAt1:true,columnsStartAt1:true,supportsVariableType:true,supportsRunInTerminalRequest:false}); await dap.request(String(config.request||'launch'),serializable(config)); } catch(e) { proc.kill(); debugSessions.delete(sessionId); throw e; } debugEmitter.start.fire(session); send('debugStarted',{sessionId,debugType:type,name:session.name}); return true; },
    async stopDebugging(session) { const id=session&&session.id || (debug.activeDebugSession&&debug.activeDebugSession.id); if(!id)return; const old=debugSessions.get(id); stopManagedDebugSession(id); if(old)debugEmitter.stop.fire(old.session||old); if(debug.activeDebugSession&&debug.activeDebugSession.id===id)debug.activeDebugSession=undefined; },
    addBreakpoints: async()=>{}, removeBreakpoints: async()=>{}
  };
  const extensionObject = extensionData; Object.assign(extensionObject, { id: String(extensionId || ''), extensionUri: Uri.file(extensionDir), extensionPath: extensionDir, packageJSON: loadJson(path.join(extensionDir,'package.json'),{}), isActive: false, exports: undefined, activate: async () => extensionObject.exports }); 
  const extensions = { getExtension: id => String(id) === extensionObject.id ? extensionObject : undefined, all: [extensionObject] };
  const env = { appName: 'CodeSpace', language: 'en', uiKind: 2, machineId: 'codespace-local', uriScheme: 'codespace', remoteName: undefined, clipboard: { readText: async () => '', writeText: async () => {} }, openExternal: async () => false, executeNativeTool: async (command,args=[],options={}) => { const started=await rpc('process.spawn',{command:String(command),args:Array.isArray(args)?args.map(String):[],cwd:options.cwd||extensionDir}); return {processId:started.processId,pid:started.pid}; } };
  return {
    version: '1.90.0', ExtensionMode: { Production: 1, Development: 2, Test: 3 }, ExtensionKind: { UI: 1, Workspace: 2 },
    Disposable, EventEmitter, Uri, Position, Range, Selection, Location, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItem: class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }, CompletionItemKind: { Text:0,Method:1,Function:2,Constructor:3,Field:4,Variable:5,Class:6,Interface:7,Module:8,Property:9,Unit:10,Value:11,Enum:12,Keyword:13,Snippet:14,Color:15,File:16,Reference:17,Folder:18,EnumMember:19,Constant:20,Struct:21,Event:22,Operator:23,TypeParameter:24 },
    TextEdit, WorkspaceEdit, MarkdownString, CancellationTokenSource, FileType: { File:1,Directory:2,SymbolicLink:64 }, FileSystemError,
    StatusBarAlignment: { Left:1, Right:2 }, ProgressLocation: { SourceControl:1, Window:10, Notification:15 }, ConfigurationTarget: { Global:1, Workspace:2, WorkspaceFolder:3 }, CodeActionKind: { Empty:'', QuickFix:'quickfix', Refactor:'refactor', Source:'source' },
    commands: commandsApi, workspace, window, env, languages, extensions, debug,
    DebugAdapterExecutable: class DebugAdapterExecutable { constructor(command,args=[],options={}) { this.command=command; this.args=args; this.options=options; } },
  };
}



async function openWebviewView(viewType) {
  const record=webviewViewProviders.get(String(viewType||'')); if(!record)throw new Error('No extension registered the requested webview view');
  const panel=vscode.window.createWebviewPanel(viewType,viewType,1,{enableScripts:!!record.options.enableScripts,retainContextWhenHidden:false});
  const view={webview:panel.webview,visible:true,show:()=>panel.reveal(),onDidDispose:panel.onDidDispose,onDidChangeVisibility:panel.onDidChangeViewState};
  await record.provider.resolveWebviewView(view,{state:undefined,viewType},new CancellationTokenSource().token);
  return true;
}

const FEATURE_METHODS = { completion:'provideCompletionItems', hover:'provideHover', definition:'provideDefinition', references:'provideReferences', formatting:'provideDocumentFormattingEdits', rangeFormatting:'provideDocumentRangeFormattingEdits', codeActions:'provideCodeActions', rename:'provideRenameEdits', signatureHelp:'provideSignatureHelp', documentSymbols:'provideDocumentSymbols', codeLens:'provideCodeLenses' };
async function runFeatureRequest(message) {
  const record=featureProviders.get(String(message.featureId||'')); if(!record)throw new Error('Language feature provider is no longer registered');
  const method=FEATURE_METHODS[record.name]; if(!method)throw new Error('Unsupported language feature: '+record.name);
  const provider=[...record.args].reverse().find(x=>x&&typeof x==='object'&&typeof x[method]==='function'); if(!provider)throw new Error('Provider does not implement '+method);
  const input=message.params||{}, uri=Uri.file(path.resolve(workspaceRoot||extensionDir,String(input.path||'')));
  const doc=globalThis.__codespaceMakeTextDocument ? globalThis.__codespaceMakeTextDocument(uri,String(input.text||''),String(input.languageId||path.extname(input.path||'').slice(1)),Number(input.version)||1) : null;
  if(!doc)throw new Error('Text document bridge is not ready');
  const pos=new Position(Number(input.line)||0,Number(input.character)||0), token=new CancellationTokenSource().token;
  if(record.name==='completion')return await provider[method](doc,pos,token,input.context||{triggerKind:1});
  if(record.name==='hover'||record.name==='definition'||record.name==='references'||record.name==='signatureHelp')return await provider[method](doc,pos,token,...(record.name==='references'?[input.context||{includeDeclaration:true}]:[]));
  if(record.name==='formatting')return await provider[method](doc,input.options||{},token);
  if(record.name==='rangeFormatting')return await provider[method](doc,new Range(new Position(0,0),doc.positionAt(doc.getText().length)),input.options||{},token);
  if(record.name==='codeActions')return await provider[method](doc,new Range(pos,pos),input.context||{diagnostics:[],only:undefined,triggerKind:1},token);
  if(record.name==='rename')return await provider[method](doc,pos,String(input.newName||''),token);
  return await provider[method](doc,token);
}

async function shutdown() {
  try { const ext = extensionModule && extensionModule.exports; if (ext && typeof ext.deactivate === 'function') await ext.deactivate(); } catch (e) { send('log', { level:'error', message:'deactivate: ' + (e.message || String(e)) }); }
  for (const d of subscriptions.splice(0)) { try { d.dispose(); } catch {} }
  // Flush the IPC frame before exit; otherwise the parent can miss the stopped event.
  try { ipc.write(JSON.stringify({ type: 'stopped' }) + '\n', () => process.exit(0)); }
  catch { process.exit(0); }
}
let extensionModule = null;
process.on('uncaughtException', e => { send('error', { error: e && e.stack || String(e) }); });
process.on('unhandledRejection', e => { send('error', { error: e && e.stack || String(e) }); });
(async () => {
  try {
    if (!workspaceRoot) send('log', { level:'warning', message:'No workspace folder is open; workspace file APIs will be unavailable.' });
    if (!mainPath || mainPath.includes('..') || path.isAbsolute(mainPath)) throw new Error('Invalid extension main path');
    const full = path.resolve(extensionDir, mainPath);
    const relative = path.relative(extensionDir, full); if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(full)) throw new Error('Extension main file is missing or outside its package');
    process.chdir(extensionDir);
    globalThis.__codespaceVscode = vscode;
    globalThis.__codespaceChildProcess = childProcessShim;
globalThis.__codespaceNet = restrictedNetShim;
    installEsmRuntimeHooks();
    const isEsm = extensionManifest.type === 'module' || /\.mjs$/i.test(mainPath);
    extensionModule = isEsm ? await import(pathToFileURL(full).href) : require(full);
    if (!extensionModule || typeof extensionModule.activate !== 'function') throw new Error('Extension main module does not export activate(context)');
    const manifest = extensionManifest;
    const context = {
      subscriptions, extensionMode: 1, extension: { id: String(extensionId || ''), extensionUri: Uri.file(extensionDir), extensionPath: extensionDir, packageJSON: manifest },
      extensionPath: extensionDir, extensionUri: Uri.file(extensionDir), storagePath: stateDir, globalStoragePath: stateDir,
      storageUri: Uri.file(stateDir), globalStorageUri: Uri.file(stateDir), logPath: stateDir,
      globalState: memento('globalState'), workspaceState: memento('workspaceState'), secrets: { get: async () => undefined, store: async () => { throw new Error('Secret storage is not available in this restricted extension host'); }, delete: async () => {} },
      asAbsolutePath: relative => path.resolve(extensionDir, String(relative || '')),
      environmentVariableCollection: { persistent: false, append: () => {}, prepend: () => {}, replace: () => {}, delete: () => {}, clear: () => {}, get: () => undefined, forEach: () => {}, getScoped: () => ({ append:()=>{},prepend:()=>{},replace:()=>{},delete:()=>{},clear:()=>{} }) },
      languageModelAccessInformation: { canSendRequest: () => false }
    };
    Object.assign(extensionData, context.extension, { isActive: true, exports: extensionModule.exports });
    await extensionModule.activate(context);
    send('ready', { commands: [...commands.keys()], runtime: 'CodeSpace Node.js Extension Host', permissionModel: process.permission ? 'enabled' : 'unavailable' });
  } catch (e) { send('activationError', { error: e && e.stack || String(e) }); process.exitCode = 1; setTimeout(() => process.exit(1), 250).unref?.(); }
})();
