'use strict';
// CodeSpace's conservative VS Code extension compatibility inspectors.
// Web packages use the Web Worker host; compatible CommonJS packages may use the
// restricted Node host. Neither host claims full desktop VS Code API compatibility.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILES = 5000;
const MAX_TOTAL = 80 * 1024 * 1024;
const MAX_ENTRY = 20 * 1024 * 1024;
const API_VERSION = '1.90.0';
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zipEntries(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const min = Math.max(0, buf.length - 65557);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < min || eocd + 22 > buf.length) throw new Error('Invalid VSIX: ZIP directory is missing');
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8), count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (disk || cdDisk || count !== countDisk || count > MAX_FILES || cdOff + cdSize > buf.length || count === 0) throw new Error('Unsupported or invalid VSIX ZIP directory');
  const out = []; let p = cdOff, total = 0; const cdEnd = cdOff + cdSize;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid VSIX ZIP entry');
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new Error('VSIX ZIP64 packages are not supported by the safe installer');
    const rawName = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (p > buf.length || (flags & 1) || ![0, 8].includes(method)) throw new Error('Unsupported or encrypted VSIX entry');
    if (!rawName || rawName.includes('\\') || rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) throw new Error('Unsafe VSIX entry path');
    const parts = rawName.split('/').filter(Boolean);
    if (parts.some(x => x === '.' || x === '..')) throw new Error('Unsafe VSIX entry path');
    const name = parts.join('/');
    const unixMode = madeBy >> 8 === 3 ? (extAttr >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error('VSIX symlinks are not supported');
    if (usize > MAX_ENTRY || (usize && csize === 0) || (csize && usize / csize > 150)) throw new Error('VSIX entry exceeds safe extraction limits');
    total += usize; if (total > MAX_TOTAL) throw new Error('VSIX package exceeds the 80 MB extracted-size limit');
    out.push({ name, rawName, method, crc, csize, usize, lho, unixMode, directory: rawName.endsWith('/') });
  }
  if (p > cdEnd) throw new Error('Invalid VSIX central directory size');
  return { buf, entries: out };
}
function inflateEntry(zip, entry) {
  const { buf } = zip, p = entry.lho;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Invalid VSIX local header');
  const localFlags = buf.readUInt16LE(p + 6), localMethod = buf.readUInt16LE(p + 8);
  const nlen = buf.readUInt16LE(p + 26), elen = buf.readUInt16LE(p + 28), start = p + 30 + nlen + elen;
  const localName = buf.subarray(p + 30, p + 30 + nlen).toString('utf8');
  if (localName !== entry.rawName || localMethod !== entry.method || (localFlags & 1)) throw new Error('VSIX local and central entry headers do not match');
  if (start + entry.csize > buf.length) throw new Error('Truncated VSIX entry');
  const comp = buf.subarray(start, start + entry.csize);
  const out = entry.method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp, { maxOutputLength: MAX_ENTRY });
  if (out.length !== entry.usize) throw new Error('VSIX entry size mismatch');
  if (crc32(out) !== entry.crc) throw new Error('VSIX entry checksum mismatch');
  return out;
}
function readEntry(input, wanted) {
  const zip = zipEntries(input), e = zip.entries.find(x => x.name.toLowerCase() === String(wanted).toLowerCase());
  return e ? inflateEntry(zip, e) : null;
}
function safeExtensionPath(root, name) {
  const full = path.resolve(root, ...name.split('/'));
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe extension path');
  return full;
}
function extractVsix(input, destination) {
  const zip = zipEntries(input);
  fs.mkdirSync(destination, { recursive: true });
  let extracted = 0;
  for (const e of zip.entries) {
    // Only extract the extension payload; skip VSIX wrapper metadata and arbitrary top-level files.
    if (!e.name.toLowerCase().startsWith('extension/')) continue;
    const rel = e.name.slice('extension/'.length);
    if (!rel) continue;
    const target = safeExtensionPath(destination, rel);
    if (e.directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    const data = inflateEntry(zip, e);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode: (e.unixMode & 0o111) ? 0o755 : 0o644 });
    if (process.platform !== 'win32' && (e.unixMode & 0o111)) { try { fs.chmodSync(target, (e.unixMode & 0o777) | 0o100); } catch {} }
    extracted++;
  }
  if (!extracted || !fs.existsSync(path.join(destination, 'package.json'))) throw new Error('VSIX does not contain extension/package.json');
  return JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
}
function versionParts(s) { return String(s || '').match(/\d+/g)?.slice(0, 3).map(Number) || []; }
function cmp(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function engineCompatible(range, target = API_VERSION) {
  const r = String(range || '').trim();
  if (!r) return false;
  return r.split(/\s*\|\|\s*/).some(part => {
    part = part.trim().replace(/(\^|~|>=|<=|>|<|=)\s+(?=v?\d)/g, '$1'); if (!part || part === '*' || part.toLowerCase() === 'latest') return true;
    const tokens = part.split(/\s+/).filter(Boolean);
    return tokens.every(token => {
      const m = token.match(/^(\^|~|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2}|\d+(?:\.\d+)?\.x|\*)$/i);
      if (!m) return false;
      const op = m[1] || '=', wanted = m[2];
      if (wanted === '*') return true;
      if (/\.x$/i.test(wanted)) { const prefix = wanted.split('.').slice(0, -1), t = String(target).split('.'); return prefix.every((seg, i) => t[i] === seg); }
      const c = cmp(target, wanted);
      if (op === '>=' ) return c >= 0;
      if (op === '^') { const w = versionParts(wanted), t = versionParts(target); return c >= 0 && (w[0] > 0 ? t[0] === w[0] : w[1] > 0 ? t[0] === 0 && t[1] === w[1] : t[0] === 0 && t[1] === 0 && t[2] === w[2]); }
      if (op === '~') { const w = versionParts(wanted), t = versionParts(target); return c >= 0 && t[0] === w[0] && t[1] === w[1]; }
      if (op === '>') return c > 0;
      if (op === '<=') return c <= 0;
      if (op === '<') return c < 0;
      return c === 0;
    });
  });
}
const API_ALLOW = new Set([
  'commands.registerCommand', 'commands.getCommands',
  'window.registerTreeDataProvider', 'window.createTreeView', 'TreeItem', 'TreeItemCollapsibleState', 'ThemeIcon', 'EventEmitter',
  'window.showInformationMessage', 'window.showWarningMessage', 'window.showErrorMessage', 'window.createOutputChannel',
  'workspace.getConfiguration',
  'env.appName', 'env.language', 'env.uiKind', 'version', 'Uri.parse', 'Uri.file',
  'ExtensionMode.Production', 'ExtensionMode.Development', 'Disposable'
]);
function inspectVsix(input) {
  const pkgBytes = readEntry(input, 'extension/package.json');
  if (!pkgBytes || pkgBytes.length > 2 * 1024 * 1024) return { compatible: false, reason: 'Missing or oversized extension manifest' };
  let pkg; try { pkg = JSON.parse(pkgBytes.toString('utf8')); } catch { return { compatible: false, reason: 'Invalid extension manifest' }; }
  if (!pkg || typeof pkg !== 'object') return { compatible: false, reason: 'Invalid extension manifest' };
  if (!engineCompatible(pkg.engines && pkg.engines.vscode)) return { compatible: false, reason: 'VS Code API engine range is not compatible with CodeSpace Web API 1.90' };
  if (typeof pkg.browser !== 'string' || !pkg.browser.trim()) return { compatible: false, reason: 'No browser extension entry point' };
  const contributes = pkg.contributes || {};
  const unsupported = Object.keys(contributes).filter(k => !['commands', 'configuration', 'views', 'viewsContainers'].includes(k));
  if (unsupported.length) return { compatible: false, reason: 'Uses unsupported contributions: ' + unsupported.slice(0, 4).join(', ') };
  const commands = Array.isArray(contributes.commands) ? contributes.commands.filter(x => x && /^[\w.-]{2,160}$/.test(String(x.command || '')) && String(x.title || '').trim()).map(x => ({ command: String(x.command), title: String(x.title).slice(0, 100), category: String(x.category || '').slice(0, 80) })) : [];
  if (!commands.length) return { compatible: false, reason: 'No supported contributed commands' };
  const rel = pkg.browser.replace(/^\.\//, '').replace(/\\/g, '/');
  if (!rel || !/\.js$/i.test(rel) || rel.startsWith('/') || rel.split('/').some(x => !x || x === '.' || x === '..')) return { compatible: false, reason: 'Browser entry point must be a safe bundled .js file' };
  const entryBytes = readEntry(input, 'extension/' + rel);
  if (!entryBytes || !entryBytes.length || entryBytes.length > 8 * 1024 * 1024) return { compatible: false, reason: 'Browser entry point is missing or exceeds 8 MB' };
  const code = entryBytes.toString('utf8');
  const codeForChecks = code.replace(/\bvscode\.window\b/g, 'vscodeWindow');
  if (/\b(?:document|window|process|Buffer|__dirname|__filename|globalThis|self|navigator|location|indexedDB|caches|BroadcastChannel|Worker|SharedWorker|WebTransport|RTCPeerConnection|postMessage)\b|require\s*\(\s*['"](?!vscode['"])[^'"]+['"]\s*\)|\b(?:importScripts|XMLHttpRequest|WebSocket|EventSource)\b|\bfetch\s*\(|\b(?:eval|Function)\s*\(/.test(codeForChecks)) return { compatible: false, reason: 'Uses browser or Node APIs outside the CodeSpace extension sandbox' };
  if (/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]|\bimport\s*\(/.test(codeForChecks)) return { compatible: false, reason: 'Uses external or module imports; CodeSpace requires a bundled web entry point' };
  const references = new Set();
  const re = /\bvscode(?:\.([A-Za-z_$][\w$]*))(?:\.([A-Za-z_$][\w$]*))?/g; let hit;
  while ((hit = re.exec(code))) references.add(hit[1] + (hit[2] ? '.' + hit[2] : ''));
  const unsupportedApis = [...references].filter(x => !API_ALLOW.has(x) && ![...API_ALLOW].some(a => a.startsWith(x + '.')));
  if (unsupportedApis.length) return { compatible: false, reason: 'Uses unsupported VS Code APIs: ' + unsupportedApis.slice(0, 4).join(', ') };
  if (!/\b(?:const|let|var)\s+vscode\s*=\s*require\s*\(\s*['"]vscode['"]\s*\)/.test(code) || !/vscode\.commands\.registerCommand/.test(code)) return { compatible: false, reason: 'No detectable supported VS Code API usage' };
  return {
    compatible: true, runtime: 'CodeSpace Web Extension Host', apiVersion: API_VERSION,
    manifest: pkg, browserPath: rel, commands,
    displayName: String(pkg.displayName || pkg.name || '').slice(0, 120), publisher: String(pkg.publisher || ''),
    version: String(pkg.version || ''), description: String(pkg.description || '').slice(0, 500),
    engines: String(pkg.engines.vscode),
    supportedApi: [...references]
  };
}


// 3.18.0 — Expanded Node.js Extension Host compatibility inspection.
// The Node host is a separate Node process with the Node permission model enabled.
// It has no child-process/worker/native-addon permission and blocks common network modules.
const NODE_BLOCKED_MODULES = new Set([
  'cluster', 'node:cluster',
  'worker_threads', 'node:worker_threads', 'http', 'node:http',
  'https', 'node:https', 'http2', 'node:http2', 'tls', 'node:tls', 'dns', 'node:dns',
  'dgram', 'node:dgram', 'inspector', 'node:inspector', 'electron', 'node:electron',
  'undici', 'node:undici'
]);
const NODE_API_ALLOW = new Set([
  'commands.registerCommand', 'commands.registerTextEditorCommand', 'commands.executeCommand', 'commands.getCommands',
  'window.showInformationMessage', 'window.showWarningMessage', 'window.showErrorMessage',
  'window.createOutputChannel', 'window.createStatusBarItem', 'window.setStatusBarMessage',
  'window.withProgress', 'window.showTextDocument', 'window.createTerminal', 'window.onDidOpenTerminal', 'window.onDidCloseTerminal', 'window.createWebviewPanel', 'window.registerWebviewViewProvider',
  'window.activeTextEditor', 'window.visibleTextEditors', 'window.state',
  'debug.startDebugging', 'debug.stopDebugging', 'debug.activeDebugSession', 'debug.registerDebugConfigurationProvider', 'debug.registerDebugAdapterDescriptorFactory', 'debug.onDidStartDebugSession', 'debug.onDidTerminateDebugSession',
  'workspace.onDidChangeTextDocument', 'workspace.onDidSaveTextDocument',
  'languages.createDiagnosticCollection', 'languages.getDiagnostics', 'languages.registerCompletionItemProvider', 'languages.registerHoverProvider', 'languages.registerDefinitionProvider', 'languages.registerReferenceProvider', 'languages.registerDocumentFormattingEditProvider', 'languages.registerDocumentRangeFormattingEditProvider', 'languages.registerCodeActionsProvider', 'languages.registerRenameProvider', 'languages.registerSignatureHelpProvider', 'languages.registerDocumentSymbolProvider', 'languages.registerCodeLensProvider',
    'workspace.getConfiguration', 'workspace.onDidChangeConfiguration', 'workspace.workspaceFolders',
  'workspace.rootPath', 'workspace.name', 'workspace.textDocuments', 'workspace.fs', 'workspace.findFiles',
  'workspace.openTextDocument', 'workspace.applyEdit', 'workspace.onDidOpenTextDocument', 'workspace.onDidCloseTextDocument', 'workspace.onWillSaveTextDocument', 'workspace.createFileSystemWatcher',
  'window.terminals', 'window.showQuickPick', 'window.showInputBox', 'env.clipboard',
  'env.appName', 'env.language', 'env.uiKind', 'env.machineId', 'env.uriScheme', 'env.remoteName',
  'version', 'Uri.parse', 'Uri.file', 'Uri.joinPath', 'Uri.from',
  'ExtensionMode.Production', 'ExtensionMode.Development', 'ExtensionMode.Test',
  'Disposable', 'EventEmitter', 'Position', 'Range', 'Selection', 'Location',
  'Diagnostic', 'DiagnosticSeverity', 'DiagnosticSeverity.Error', 'DiagnosticSeverity.Warning', 'DiagnosticSeverity.Information', 'DiagnosticSeverity.Hint', 'CompletionItem', 'CompletionItemKind', 'CompletionItemKind.Text', 'CompletionItemKind.Method', 'CompletionItemKind.Function', 'CompletionItemKind.Class', 'CompletionItemKind.Property', 'CompletionItemKind.Variable', 'CompletionItemKind.Keyword', 'CompletionItemKind.Snippet',
  'TextEdit', 'WorkspaceEdit', 'FileType', 'FileSystemError', 'StatusBarAlignment',
  'ProgressLocation', 'ConfigurationTarget', 'ExtensionKind', 'MarkdownString',
  'CodeActionKind', 'CancellationTokenSource',
  'extensions.getExtension', 'extensions.all', 'DebugAdapterExecutable'
]);
function inspectNodeVsix(input) {
  let pkgBytes; try { pkgBytes = readEntry(input, 'extension/package.json'); } catch (e) { return { compatible: false, reason: e.message }; }
  if (!pkgBytes || pkgBytes.length > 2 * 1024 * 1024) return { compatible: false, reason: 'Missing or oversized extension manifest' };
  let pkg; try { pkg = JSON.parse(pkgBytes.toString('utf8')); } catch { return { compatible: false, reason: 'Invalid extension manifest' }; }
  if (!pkg || typeof pkg !== 'object' || !engineCompatible(pkg.engines && pkg.engines.vscode)) return { compatible: false, reason: 'VS Code API engine range is not compatible with CodeSpace API 1.90' };
  if (typeof pkg.main !== 'string' || !pkg.main.trim()) return { compatible: false, reason: 'No Node.js main entry point' };
  const rel = pkg.main.replace(/^\.\//, '').replace(/\\/g, '/');
  const isEsm = pkg.type === 'module' || /\.mjs$/i.test(rel);
  if (!rel || !/\.(?:js|cjs|mjs)$/i.test(rel) || rel.startsWith('/') || rel.split('/').some(x => !x || x === '.' || x === '..')) return { compatible: false, reason: 'Node entry point must be a safe bundled .js or .cjs file' };
  let zip; try { zip = zipEntries(input); } catch (e) { return { compatible: false, reason: e.message }; }
  const entry = zip.entries.find(x => x.name.toLowerCase() === ('extension/' + rel).toLowerCase());
  if (!entry || entry.directory || entry.usize > 8 * 1024 * 1024) return { compatible: false, reason: 'Node.js main entry point is missing or exceeds 8 MB' };
  const nativeAddons = zip.entries.filter(x => /^extension\//i.test(x.name) && !x.directory && /\.node$/i.test(x.name)).map(x => x.name.slice('extension/'.length));
  const nativeBinaries = zip.entries.filter(x => /^extension\//i.test(x.name) && !x.directory && /(?:\.exe|\.dll|\.so(?:\.\d+)*|\.dylib|\.bin)$/i.test(x.name) && !/\.node$/i.test(x.name)).map(x => x.name.slice('extension/'.length));
  if (nativeAddons.length > 32 || nativeBinaries.length > 64) return { compatible: false, reason: 'Extension contains too many native code files' };
  const osList = Array.isArray(pkg.os) ? pkg.os : null, cpuList = Array.isArray(pkg.cpu) ? pkg.cpu : null;
  if (osList) { const positive=osList.filter(x=>!String(x).startsWith('!')); const excluded=osList.some(x=>x==='!'+process.platform); if (excluded || (positive.length && !positive.includes(process.platform))) return { compatible: false, reason: 'Extension does not declare support for this operating system' }; }
  if (cpuList) { const positive=cpuList.filter(x=>!String(x).startsWith('!')); const excluded=cpuList.some(x=>x==='!'+process.arch); if (excluded || (positive.length && !positive.includes(process.arch))) return { compatible: false, reason: 'Extension does not declare support for this CPU architecture' }; }
  // Scan every bundled JS file rather than only the manifest entry: dependencies are
  // executed in the same process and must obey the same API/network restrictions.
  const jsEntries = zip.entries.filter(x => /^extension\//i.test(x.name) && /\.(?:js|cjs|mjs)$/i.test(x.name) && !x.directory);
  if (jsEntries.length > 1500) return { compatible: false, reason: 'Extension has too many JavaScript modules for the compatibility scanner' };
  const sources = [];
  for (const file of jsEntries) {
    if (file.usize > 8 * 1024 * 1024) return { compatible: false, reason: 'A JavaScript module exceeds the 8 MB compatibility scan limit' };
    let source; try { source = inflateEntry(zip, file).toString('utf8'); } catch (e) { return { compatible: false, reason: 'Unable to inspect a JavaScript module: ' + e.message }; }
    sources.push(source);
  }
  const code = sources.join('\n');
  // Runtime guards repeat these checks at execution time; this static pass prevents
  // packages requiring unavailable capabilities from being advertised as compatible.
  const blocked = /(?:require|import)\s*\(?\s*['"](?:node:)?(?:cluster|worker_threads|http|https|http2|tls|dns|dgram|inspector|electron|undici|module|vm)['"]|\bprocess\.(?:binding|_linkedBinding|dlopen|kill|_debugProcess|abort)\s*\(|\b(?:fetch|WebSocket|EventSource|WebTransport|XMLHttpRequest)\b/i;
  if (blocked.test(code)) return { compatible: false, reason: 'Uses process, network, dynamic-module or native APIs unavailable in the restricted Node host' };
  const contributes = pkg.contributes || {};
  const supportedContrib = ['commands', 'configuration', 'debuggers', 'views', 'viewsContainers'];
  const unsupported = Object.keys(contributes).filter(k => !supportedContrib.includes(k));
  if (unsupported.length) return { compatible: false, reason: 'Uses unsupported contribution points: ' + unsupported.slice(0, 4).join(', ') };
  if (contributes.views && Object.values(contributes.views).flat().some(view => !view || view.type !== 'webview')) return { compatible: false, reason: 'Only webview-based contributed views are supported; custom TreeDataProvider views are not yet implemented' };
  const commands = Array.isArray(contributes.commands) ? contributes.commands.filter(x => x && /^[\w.-]{2,160}$/.test(String(x.command || '')) && String(x.title || '').trim()).map(x => ({ command: String(x.command), title: String(x.title).slice(0, 100), category: String(x.category || '').slice(0, 80) })) : [];
  const importsVscode = /\bimport\s+(?:[^;]*?\s+from\s*)?['"]vscode['"]/.test(code);
  const requiresVscode = /\brequire\s*\(\s*['"]vscode['"]\s*\)/.test(code);
  if (!(requiresVscode || importsVscode) || !/(?:\bvscode\.(?:commands|workspace|window|extensions|debug|languages)\b|\b(?:commands|workspace|window|extensions|debug|languages)\s*\.)/.test(code)) return { compatible: false, reason: 'Node entry point does not expose detectable supported VS Code API usage' };
  const references = new Set();
  const re = /\bvscode(?:\.([A-Za-z_$][\w$]*))(?:\.([A-Za-z_$][\w$]*))?/g; let hit;
  while ((hit = re.exec(code))) references.add(hit[1] + (hit[2] ? '.' + hit[2] : ''));
  const importRe = /(?:import\s*\{([^}]+)\}\s*from\s*['"]vscode['"]|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]vscode['"]\s*\))/g;
  while ((hit = importRe.exec(code))) { const names=hit[1]||hit[2]||''; for (const item of names.split(',')) { const name=item.trim().split(/\s+as\s+/i)[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(name)) { references.add(name); const usages=new RegExp('\\b'+name+'\\.([A-Za-z_$][\\w$]*)','g'); let use; while((use=usages.exec(code))) references.add(name+'.'+use[1]); } } }
  const unsupportedApis = [...references].filter(x => !NODE_API_ALLOW.has(x) && ![...NODE_API_ALLOW].some(a => a.startsWith(x + '.')));
  if (unsupportedApis.length) return { compatible: false, reason: 'Uses unsupported VS Code APIs: ' + unsupportedApis.slice(0, 5).join(', ') };
  // Extension context capabilities deliberately not offered in this runtime.
  if (/\b(?:context|extensionContext)\.secrets\b|\blanguageModelAccessInformation\b/.test(code)) return { compatible: false, reason: 'Uses secret storage or language-model APIs that CodeSpace does not provide to extensions' };
  return {
    compatible: true, hostType: 'node', runtime: 'CodeSpace Node.js Extension Host', apiVersion: API_VERSION,
    manifest: pkg, mainPath: rel, moduleType: isEsm ? 'module' : 'commonjs', commands, contributions: Object.keys(contributes),
    displayName: String(pkg.displayName || pkg.name || '').slice(0, 120), publisher: String(pkg.publisher || ''),
    version: String(pkg.version || ''), description: String(pkg.description || '').slice(0, 500),
    engines: String(pkg.engines.vscode), supportedApi: [...references], requiresNativeAddons: nativeAddons.length > 0, nativeAddons, nativeBinaries, requiresNativeCode: nativeAddons.length > 0 || nativeBinaries.length > 0,
    sandbox: 'Node permission model; extension-directory read; extension-storage write; bundled native executable subprocesses, terminals, debugger adapters and language servers via managed child-process bridge (terminal permission required); native in-process .node addons require the separate Native extension code permission (Allow); unrestricted network access remains blocked; workspace access via CodeSpace permission RPC'
  };
}
function inspectVsixForCodeSpace(input) {
  const node = inspectNodeVsix(input);
  if (node.compatible) return { ...node, compatibilityLabel: node.moduleType === 'module' ? 'Node.js ES Module Host' : 'Node.js Extension Host' };
  const web = inspectVsix(input);
  if (web.compatible) return { ...web, hostType: 'web', compatibilityLabel: 'Web Extension Host' };
  return { compatible: false, reason: node.reason || web.reason || 'No compatible CodeSpace extension runtime' };
}

function registryIdentityMatches(check, listing) {
  if (!check || !check.compatible || !check.manifest || !listing) return false;
  const manifest = check.manifest;
  return String(manifest.publisher || '').toLowerCase() === String(listing.namespace || '').toLowerCase()
    && String(manifest.name || '').toLowerCase() === String(listing.name || '').toLowerCase()
    && String(manifest.version || '') === String(listing.version || '');
}

module.exports = { API_VERSION, zipEntries, readEntry, extractVsix, inspectVsix, inspectNodeVsix, inspectVsixForCodeSpace, engineCompatible, registryIdentityMatches };
