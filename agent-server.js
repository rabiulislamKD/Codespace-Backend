#!/usr/bin/env node
/*
  CodeSpace bridge: a small local server that lets the chat page run terminal commands
  (node, npm, python, git, ...), read/write files in a workspace folder, and manage skills.

  Usage:   node agent-server.js [workspace-folder]   (optional: you can pick the folder in the app with Open folder) [--port 8787] [--token YOUR_TOKEN]
           [--show-browser] [--chrome "path to chrome/edge"]
  Saved data (settings, sessions, skills, extensions): ~/.my-agent
  Needs:   Node.js 18 or newer. No npm packages.

  Security: it only listens on 127.0.0.1 and every request needs the secret token printed
  at start-up. Anyone who has the token can run commands on this computer, so keep it private.
*/
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const vscodeExtSupport = require('./vscode-extension-support.cjs');
const dnsProm = require('dns').promises;
const { spawn, spawnSync } = require('child_process');
let ptyLib = null; try { ptyLib = require('node-pty'); } catch {}
const { fileURLToPath, pathToFileURL } = require('url');
const { getInstallLocation } = require('./codespace-install-location.cjs');

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Node.js 18 or newer is required. You have ' + process.version);
  process.exit(1);
}

/* ---------- options ---------- */
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const VALUE_FLAGS = ['--port', '--token', '--chrome'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1])));
const SHOW_BROWSER = argv.includes('--show-browser');
const CHROME_FLAG = flag('chrome', '');
const DATA = path.resolve(process.env.MY_AGENT_DATA_DIR || path.join(os.homedir(), '.my-agent'));
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const WORKSPACE_FILE = path.join(DATA, 'workspace.json');
let ROOT = null; // the folder the agent works in; chosen with "Open folder" in the app
if (positional[0]) {
  ROOT = path.resolve(positional[0]);
  if (!isDir(ROOT)) { console.error('Workspace folder not found: ' + ROOT); process.exit(1); }
} else {
  try { const w = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8')); if (w.path && isDir(w.path)) ROOT = w.path; } catch {}
}
const PORT = Number(flag('port', process.env.PORT || 8787));
const HOST = String(process.env.CODESPACE_HOST || '127.0.0.1').trim() || '127.0.0.1';
const TOKEN = String(flag('token', '') || process.env.CODESPACE_API_TOKEN || '').trim() || crypto.randomBytes(24).toString('hex');
/* Hosted deployments (Render, Docker, a VPS) must accept their public Host header. Render sets
   RENDER_EXTERNAL_HOSTNAME automatically; other hosts can set CODESPACE_PUBLIC_HOST. */
const PUBLIC_HOST = String(process.env.CODESPACE_PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
/* GitHub Codespaces forwards ports at https://<name>-<port>.<domain> (default app.github.dev)
   but does not set CODESPACE_PUBLIC_HOST. Detect that host only when actually running inside a
   Codespace, gated on CODESPACE_NAME / CODESPACE_WORKSPACE_DIR so this never becomes a Host-header
   bypass on Render/VPS/Docker deployments. */
const CODESPACE_FORWARDING_DOMAIN = String(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev')
  .trim().replace(/^\.+/, '').toLowerCase();
const CODESPACE_NAME_ENV = String(process.env.CODESPACE_NAME || '').trim().toLowerCase();
const ON_GITHUB_CODESPACE = Boolean(CODESPACE_NAME_ENV) || Boolean(String(process.env.CODESPACE_WORKSPACE_DIR || '').trim());
const isCodespaceForwardedHost = h => {
  if (!ON_GITHUB_CODESPACE) return false;
  const host = String(h || '').toLowerCase().replace(/:\d+$/, '');
  const suffix = '.' + CODESPACE_FORWARDING_DOMAIN;
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  if (!/^[a-z0-9][a-z0-9-]*-\d{2,5}$/.test(label)) return false;
  return CODESPACE_NAME_ENV ? label.startsWith(CODESPACE_NAME_ENV + '-') : true;
};
const HOSTED = Boolean(PUBLIC_HOST) || HOST === '0.0.0.0' || process.env.CODESPACE_HOSTED === '1';
/* The /browse proxy is deliberately unauthenticated so iframe navigations work. Never expose it
   as an open proxy on the public internet; hosted deployments must opt in explicitly. */
const ALLOW_BROWSE_PROXY = process.env.CODESPACE_ALLOW_BROWSE_PROXY === '1' || !HOSTED;
if (HOSTED && !String(flag('token', '') || process.env.CODESPACE_API_TOKEN || '').trim()) {
  console.error('Refusing to start a hosted bridge without a token. Set CODESPACE_API_TOKEN (Render: Environment → Secret) and redeploy.');
  process.exit(1);
}
const SKILLS_USER = path.join(DATA, 'skills');
const skillsProject = () => (ROOT ? path.join(ROOT, '.agent', 'skills') : null);

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', '.idea', '.vscode']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|wasm|bin|class|jar)$/i;
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* ---------- environment info ---------- */
function detectPython() {
  for (const cmd of ['python3', 'python', 'py']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return cmd + ' (' + ((r.stdout || '') + (r.stderr || '')).trim() + ')';
  }
  return '';
}
/* 3.13.4: when git is missing, GitHub repo installs fall back to downloading the
   repository archive (see ghRepoZip). Set CODESPACE_DISABLE_GIT=1 to simulate a
   machine without git (debugging / support). */
const GIT_OK = process.env.CODESPACE_DISABLE_GIT === '1' ? false
  : spawnSync('git', ['--version'], { timeout: 5000 }).status === 0;
const PYTHON = detectPython();

/* ---------- helpers ---------- */
const send = (res, code, obj) => {
  const s = JSON.stringify(obj);
  // 3.12: when an operation finishes with a non-challenge response, its satisfied permission
  // gates are consumed — replaying the same request afterwards needs fresh approvals.
  if (CURRENT_GATES) {
    if (obj && obj.needsApproval) CURRENT_GATES.lastWasChallenge = true;
    else { gatePlanClear(); }
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
};
function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, big = false;
    const limit = Math.max(1024, Math.min(40 * 1024 * 1024, Number(limitBytes) || 5 * 1024 * 1024));
    // Over the endpoint-specific limit: stop storing, keep reading so the client receives a 413.
    req.on('data', c => { n += c.length; if (big) { if (n > 64 * 1024 * 1024) req.destroy(); return; } if (n > limit) { big = true; chunks.length = 0; return; } chunks.push(c); });
    req.on('end', () => {
      if (big) { const e = new Error('Request too large (the limit is ' + Math.round(limit / (1024 * 1024)) + ' MB for this endpoint).'); e.status = 413; return reject(e); }
      if (!chunks.length) return resolve({});
      let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Invalid JSON')); }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new Error('The request body must be a JSON object.'));
      resolve(v);
    });
    req.on('error', reject);
  });
}
const inside = (base, target) => { const r = path.relative(base, target); return r === '' || (r.split(path.sep)[0] !== '..' && !path.isAbsolute(r)); };
function safe(p, base = ROOT) {
  if (!base) throw new Error('No folder is open. Use File > Open Folder in the app first.');
  if (p != null && typeof p !== 'string') throw new Error('A path must be text.');
  if (typeof p === 'string' && p.includes('\0')) throw new Error('Invalid path.');
  const full = path.resolve(base, String(p || '.'));
  if (!inside(base, full)) throw new Error(WORKSPACE_JAIL_MSG(p));
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  if (!inside(fs.realpathSync(base), fs.realpathSync(probe))) throw new Error(WORKSPACE_JAIL_MSG(p));
  return full;
}
/* 3.13.3: the workspace jail — the agent works ONLY in the folder the user opened first.
   The error doubles as guidance for the model: do not wander to other folders, ask the user. */
const WORKSPACE_JAIL_MSG = p => 'OUTSIDE_WORKSPACE: "' + String(p == null ? '' : p).slice(0, 200) + '" is not inside the opened workspace folder. CodeSpace works only in the folder the user opened first — never search other folders, the user\'s home directory or other drives for files. If the file is not in the workspace, stop and tell the user; they can open that folder or approve one-time outside access.';
function* walk(dir, prefix = '') {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), prefix + e.name + '/');
    else if (e.isFile()) yield { rel: prefix + e.name, full: path.join(dir, e.name) };
  }
}
function authorized(req) {
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/* ---------- data folder, saved config, secrets, sessions ---------- */
/* ---------- Phase 3S: append-only, hash-chained server audit log (what the bridge actually executed) ---------- */
const AUDIT_FILE = path.join(DATA, 'audit.jsonl'), AUDIT_MAX = 5 * 1024 * 1024;
const AUDITED = /^\/(run|opencode\/(run|install)|chat-zai\/(start|stop|token)|fs\/(write|delete|editbatch|undo|redo)|index\/rename|git\/(stage|unstage|discard|commit|init|push|pull|checkout)|checkpoints\/(create|restore|delete)|browser\/(open|eval|click|type|key|nav|hover|select|upload|download|wait|dom_snapshot|a11y_tree|tabs|viewport|read|screenshot|stream\/start|stream\/stop|close)|web\/(search|fetch|extract|find|crawl|screenshot)|http\/(request|collection)|dev\/(tests|diagnostics|lint|format|deps)|task\/(create|cancel|retry)|bridge\/call|term\/(start|write|kill|close)|conn\/(set|remove|github|vercel)|db\/query|ext\/(install|toggle|remove|restart|call)|skills\/(install|remove)|workspace\/(set|close)|config\/set|perm\/set|sandbox\/(create|exec|copy_in|copy_out|export|export\/apply|stop|destroy|cleanup|profiles\/validate))$/;
const redact = t => String(t == null ? '' : t)
  .replace(/\b(ghp_|gho_|github_pat_|sk-ant-|sk-|xox[abp]-|AKIA|AIza|vcp_)[A-Za-z0-9_\-]{8,}/g, '$1***')
  .replace(/(Bearer|Basic)\s+[A-Za-z0-9._\-+\/=]{8,}/gi, '$1 ***')
  .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+/gi, '$1***')
  .replace(/(:\/\/[^\s\/:@]+:)[^\s\/@]+@/g, '$1***@');
let auditPrev = '';
try { if (fs.existsSync(AUDIT_FILE)) { const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n'); auditPrev = (JSON.parse(lines[lines.length - 1] || '{}').h) || ''; } } catch {}
function auditSummary(ep, b) {
  const d = {}, cut = (k, n) => { if (b[k] !== undefined && b[k] !== null && b[k] !== '') d[k] = redact(String(typeof b[k] === 'string' ? b[k] : JSON.stringify(b[k]))).slice(0, n); };
  ['command', 'cwd', 'shell', 'path', 'url', 'selector', 'name', 'source', 'package', 'branch', 'method', 'id', 'label', 'dir', 'tool'].forEach(k => cut(k, 300));
  cut('message', 160); cut('sql', 240); cut('code', 160); cut('expression', 160); cut('key', 40);
  if (typeof b.text === 'string') d.textLength = b.text.length;           // typed text may be a password: log length only
  if (typeof b.prompt === 'string') d.promptLength = b.prompt.length;       // never store the OpenCode prompt in the audit log
  if (Array.isArray(b.paths)) d.paths = b.paths.slice(0, 10).map(x => redact(x).slice(0, 200));
  if (ep === '/bridge/call') { const a = b.args || {}; return { action: String(b.action || ''), url: redact(String(a.url || '')).slice(0, 300), selector: redact(String(a.selector || '')).slice(0, 300), textLength: typeof a.text === 'string' ? a.text.length : undefined, code: a.code ? redact(String(a.code)).slice(0, 160) : undefined }; }
  if (ep === '/conn/set') return { note: 'credential change requested (values not logged)' };
  if (ep === '/chat-zai/token') return { note: 'chat.z.ai session token captured (value never logged)' };
  if (ep === '/http/request' || ep === '/http/collection') return { method: String(b.method || 'GET').toUpperCase(), url: redact(String(b.url || '')).slice(0, 300), headerNames: b.headers && typeof b.headers === 'object' ? Object.keys(b.headers).slice(0, 20).join(',') : undefined, bodyBytes: b.body != null ? JSON.stringify(b.body).length : undefined }; // header values may carry secrets: log names only
  return d;
}
function auditWrite(entry) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX) fs.renameSync(AUDIT_FILE, AUDIT_FILE.replace(/\.jsonl$/, '.1.jsonl'));
    entry.p = auditPrev;
    entry.h = crypto.createHash('sha256').update(auditPrev + JSON.stringify(entry)).digest('hex').slice(0, 16);
    auditPrev = entry.h;
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {}
}
function auditList(b) {
  const limit = Math.min(Math.max(parseInt(b.limit, 10) || 200, 1), 500), q = String(b.q || '').toLowerCase().slice(0, 100), only = String(b.status || 'all');
  let all = [];
  if (fs.existsSync(AUDIT_FILE)) {
    const size = fs.statSync(AUDIT_FILE).size, fd = fs.openSync(AUDIT_FILE, 'r'), len = Math.min(size, 2 * 1024 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean); if (len < size) lines.shift();   // drop a possibly cut first line
    for (const l of lines) { try { all.push(JSON.parse(l)); } catch { all.push({ bad: true }); } }
  }
  let broken = null;                                                       // verify the chain inside the loaded window
  for (let i = 0; i < all.length; i++) {
    const e = all[i]; if (e.bad) { broken = i; break; }
    const { h, ...rest } = e, ok = crypto.createHash('sha256').update((e.p || '') + JSON.stringify(rest)).digest('hex').slice(0, 16) === h;
    if (!ok || (i > 0 && e.p !== all[i - 1].h)) { broken = i; break; }
  }
  let rows = all.filter(e => !e.bad).reverse();
  if (only === 'errors') rows = rows.filter(e => !e.ok);
  if (q) rows = rows.filter(e => (e.ep + ' ' + JSON.stringify(e.d || {})).toLowerCase().includes(q));
  return { file: AUDIT_FILE, total: all.length, chain: { checked: all.length, ok: broken === null, brokenAt: broken }, entries: rows.slice(0, limit) };
}

const CONFIG_FILE = path.join(DATA, 'config.json');
const SECRETS_FILE = path.join(DATA, 'connections.json');
const SESS_DIR = path.join(DATA, 'sessions');
const EXT_DIR = path.join(DATA, 'extensions');
const EXT_STATE = path.join(DATA, 'extensions-state.json');
const TOOLS_FILE = path.join(DATA, 'installed-tools.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
};
function toolsState() { const x = readJson(TOOLS_FILE, { items: [], history: [] }); return { items: Array.isArray(x.items) ? x.items : [], history: Array.isArray(x.history) ? x.history : [] }; }
function toolsList() { const x = toolsState(); return { items: x.items.sort((a,b) => String(b.installedAt || '').localeCompare(String(a.installedAt || ''))), history: x.history.slice(0, 200) }; }
function toolsRecord(b) {
  const name = String(b.name || b.purpose || '').trim().slice(0, 120);
  const source = String(b.source || '').trim().slice(0, 500);
  const command = String(b.command || '').trim().slice(0, 4000);
  if (!name || !source || !command) throw new Error('Tool record needs a name, source and install command.');
  const state = toolsState(), id = String(b.id || crypto.randomUUID()).slice(0, 80), now = new Date().toISOString();
  const item = { id, name, version: String(b.version || 'Unknown').trim().slice(0, 120), source, command,
    uninstallCommand: String(b.uninstallCommand || '').trim().slice(0, 4000), updateCheckCommand: String(b.updateCheckCommand || '').trim().slice(0, 2000),
    updateCommand: String(b.updateCommand || '').trim().slice(0, 4000), cwd: String(b.cwd || '').slice(0, 500), installedAt: now,
    updateAvailable: null, latestVersion: '', lastCheckedAt: '' };
  const old = state.items.findIndex(x => x.id === id || (x.name.toLowerCase() === name.toLowerCase() && x.source === source));
  if (old >= 0) state.items.splice(old, 1);
  state.items.unshift(item);
  state.history.unshift({ id: crypto.randomUUID(), toolId: id, name, version: item.version, action: 'installed', source, at: now });
  state.history = state.history.slice(0, 500); writeJson(TOOLS_FILE, state);
  return { ok: true, item };
}
function toolsUpdateStatus(b) {
  const state = toolsState(), item = state.items.find(x => x.id === String(b.id || ''));
  if (!item) throw new Error('Installed tool record not found.');
  item.updateAvailable = !!b.updateAvailable; item.latestVersion = String(b.latestVersion || '').slice(0, 120); item.lastCheckedAt = new Date().toISOString();
  if (b.updated === true && item.latestVersion) item.version = item.latestVersion;
  state.history.unshift({ id: crypto.randomUUID(), toolId: item.id, name: item.name, version: item.version, latestVersion: item.latestVersion, action: b.updated === true ? 'updated' : 'update-check', source: item.source, at: item.lastCheckedAt });
  state.history = state.history.slice(0, 500); writeJson(TOOLS_FILE, state); return { ok: true, item };
}
function toolsRemove(b) {
  const state = toolsState(), id = String(b.id || ''), i = state.items.findIndex(x => x.id === id);
  if (i < 0) throw new Error('Installed tool record not found.');
  const [item] = state.items.splice(i, 1), now = new Date().toISOString();
  state.history.unshift({ id: crypto.randomUUID(), toolId: item.id, name: item.name, version: item.version, action: 'uninstalled', source: item.source, at: now });
  state.history = state.history.slice(0, 500); writeJson(TOOLS_FILE, state); return { ok: true };
}

const readSecrets = () => readJson(SECRETS_FILE, {});

/* ---------- 3.10: server-side permission enforcement ----------
   The page has its own approval dialog; this is the second, server-side gate. Modes:
   'allow' = proceed, 'ask' = respond { needsApproval } so the caller must resend with
   approved:true (the page shows its dialog), 'deny' = refused even if the page approved.
   Stored in the data folder so the rules survive restarts and apply to every client. */
const PERM_FILE = path.join(DATA, 'permissions.json');
const PERM_DEFS = {
  outside: { label: 'Work outside the opened folder', desc: 'Read/search files or run commands that reach outside the opened workspace folder. The AI must ask first.' },
  fsEdit: { label: 'File editing', desc: 'Writing, editing, renaming and deleting files inside the workspace' },
  terminal: { label: 'Terminal execution', desc: 'Running shell commands, tests, diagnostics and OpenCode' },
  network: { label: 'Network access', desc: 'Web research, HTTP/API requests, crawls and registry lookups' },
  browser: { label: 'Browser automation', desc: 'Driving the external/embedded browser and the browser bridge' },
  ext: { label: 'Extension installs', desc: 'Installing, updating, toggling and removing extensions and skills' },
  nativeCode: { label: 'Native extension code', desc: 'Load publisher-provided native Node add-ons (.node). Native code can bypass JavaScript restrictions; allow only trusted publishers.' },
  mcp: { label: 'MCP tools', desc: 'Calling tools provided by MCP extensions' },
  destructive: { label: 'Destructive operations', desc: 'Deleting files, discarding git changes, pushing, restoring checkpoints, removing extensions' },
  git: { label: 'Git operations', desc: 'Committing, pulling, checking out branches, staging and discarding' },
  sandboxCreate: { label: 'Sandbox: create', desc: 'Creating disposable sandbox environments (Docker/OCI, Wasmtime, Windows Sandbox)' },
  sandboxExec: { label: 'Sandbox: execute', desc: 'Running commands and tests inside sandbox environments' },
  sandboxNetwork: { label: 'Sandbox: network', desc: 'Sandbox environments with outbound network access (default is network-disabled)' },
  sandboxMount: { label: 'Sandbox: file transfer', desc: 'Copying files into or out of sandbox environments' },
  sandboxExport: { label: 'Sandbox: export changes', desc: 'Applying sandbox-generated files to the real workspace (a checkpoint is always created first)' },
  sandboxDestroy: { label: 'Sandbox: stop/destroy', desc: 'Stopping and destroying sandbox environments' },
  sandboxProfiles: { label: 'Sandbox: profiles', desc: 'Validating and managing sandbox environment profiles' }
};
// 3.12: sandboxes create isolated execution contexts — creating, executing, mounting and
// exporting all ask first on a NEW permission file. An EXISTING permission file is preserved.
const PERM_SAFE_DEFAULTS2 = { sandboxCreate: 'ask', sandboxExec: 'ask', sandboxNetwork: 'ask', sandboxMount: 'ask', sandboxExport: 'ask', sandboxDestroy: 'ask', sandboxProfiles: 'allow' };
// 3.11: a NEW permission file starts with safer defaults (things that install code or destroy
// data ask first). An EXISTING permission file is preserved exactly as the user configured it.
const PERM_SAFE_DEFAULTS = { fsEdit: 'allow', terminal: 'allow', network: 'allow', browser: 'allow', outside: 'ask', ext: 'ask', nativeCode: 'ask', mcp: 'ask', destructive: 'ask', git: 'ask', ...PERM_SAFE_DEFAULTS2 };
function permLoad() {
  const d = readJson(PERM_FILE, null), out = {};
  for (const k of Object.keys(PERM_DEFS)) {
    if (k === 'nativeCode' && (!d || d[k] === undefined)) { out[k] = 'ask'; continue; }
    out[k] = d && ['allow', 'ask', 'deny'].includes(d[k]) ? d[k] : (d ? 'allow' : (PERM_SAFE_DEFAULTS[k] || 'allow'));
  }
  return out;
}
function permGet() { return { file: PERM_FILE, permissions: permLoad(), defs: PERM_DEFS, safeDefaults: PERM_SAFE_DEFAULTS }; }
function permSet(b) {
  const cur = permLoad();
  if (!b.permissions || typeof b.permissions !== 'object') throw new Error('Missing permissions');
  for (const [k, v] of Object.entries(b.permissions)) {
    if (!PERM_DEFS[k]) throw new Error('Unknown permission: ' + k);
    if (!['allow', 'ask', 'deny'].includes(v)) throw new Error('Permission mode must be allow, ask or deny');
    cur[k] = v;
  }
  writeJson(PERM_FILE, cur);
  return permGet();
}
/* ---------- 3.11: single-use, expiring, operation-bound approval tokens ----------
   When a permission is in 'ask' mode the server returns a challenge carrying a fresh token.
   The caller must resend the SAME body plus that token. A token is consumed on first use,
   expires, and is bound to (permission + preview + every other body field) — so it cannot be
   replayed for another operation and a stolen token cannot approve anything else.
   A client-declared approved:true / confirmed:true is ignored everywhere. */
const APPROVAL_TTL = Math.max(5000, Number(process.env.CODESPACE_APPROVAL_TTL_MS) || 120000);
const APPROVALS = new Map();
function canonicalBind(b) {
  const rest = {};
  if (b && typeof b === 'object') for (const k of Object.keys(b).sort()) if (!['approved', 'confirmed', 'approvalToken', 'human', 'visible', 'persist'].includes(k)) rest[k] = b[k];
  return JSON.stringify(rest);
}
const bindHash = (perm, what, b) => crypto.createHash('sha256').update(perm + '|' + what + '|' + canonicalBind(b)).digest('hex');
function approvalIssue(perm, what, b) {
  const token = 'apr_' + crypto.randomBytes(18).toString('hex');
  APPROVALS.set(token, { perm, what, bind: bindHash(perm, what, b), exp: Date.now() + APPROVAL_TTL });
  for (const [k, v] of APPROVALS) if (v.exp < Date.now()) APPROVALS.delete(k);
  if (APPROVALS.size > 400) { const first = APPROVALS.keys().next().value; APPROVALS.delete(first); }
  return token;
}
// Returns null when the token validly approves this exact operation, else a rejection reason.
function approvalConsume(token, perm, what, b) {
  const rec = APPROVALS.get(String(token || ''));
  if (!rec) return 'The approval token is unknown or was already used.';
  APPROVALS.delete(String(token || ''));   // single use: consumed on first presentation, valid or not
  if (rec.exp < Date.now()) return 'The approval expired. Approve the operation again.';
  if (rec.perm !== perm || rec.what !== what || rec.bind !== bindHash(perm, what, b)) return 'The approval does not match this operation. Approve it again.';
  return null;
}
// 3.12: a request can pass through several permission gates (e.g. sandbox create + network).
// Each gate gets its own single-use token, but a token for gate 1 must survive gate 2's
// challenge/resend cycle. GATE_PLAN records (per operation-bind hash) which gates a genuine
// approval already satisfied; entries expire with the token TTL and are keyed by the full
// operation binding, so a replay still cannot execute anything that was never approved.
const GATE_PLAN = new Map();
function gateSatisfied(bind, perm) { const rec = GATE_PLAN.get(bind); return !!rec && rec.exp > Date.now() && rec.perms.has(perm); }
// Request-scoped collector: the server handler sets CURRENT_GATES before dispatching; send()/finish
// clear the satisfied entries once the operation actually completes (success or failure), so a
// completed operation can never be replayed through its plan entry. Concurrent requests can at
// worst clear each other's entries → an extra challenge (fail-safe), never a bypass.
let CURRENT_GATES = null;
function gateMark(bind, perm) {
  const rec = GATE_PLAN.get(bind) || { perms: new Set(), exp: 0 };
  rec.perms.add(perm); rec.exp = Date.now() + APPROVAL_TTL;
  GATE_PLAN.set(bind, rec);
  if (CURRENT_GATES) CURRENT_GATES.add(bind);
}
function gatePlanClear() { if (CURRENT_GATES) { for (const b2 of CURRENT_GATES) GATE_PLAN.delete(b2); CURRENT_GATES = null; } }
// Returns null (proceed), { needsApproval, preview, approvalToken, ... } (caller must resend with
// that token), or throws on deny — deny blocks even if the caller sends approved:true or a token.
function permGuard(perm, what, b = {}) {
  const mode = permLoad()[perm];
  if (mode === 'deny') { const e = new Error('Blocked by CodeSpace permission settings: ' + (PERM_DEFS[perm] || {}).label + ' (' + perm + ').'); e.status = 403; throw e; }
  if (mode !== 'ask') return null;
  const bind = bindHash(perm, what, b);
  if (gateSatisfied(bind, perm)) return null;   // this exact operation was already genuinely approved
  if (b.approvalToken) {
    const bad = approvalConsume(b.approvalToken, perm, what, b);
    if (!bad) { gateMark(bind, perm); return null; }   // genuine single-use approval for exactly this operation
    return { needsApproval: true, preview: what, permission: perm, approvalToken: approvalIssue(perm, what, b), expiresInMs: APPROVAL_TTL, note: bad };
  }
  const out = { needsApproval: true, preview: what, permission: perm, approvalToken: approvalIssue(perm, what, b), expiresInMs: APPROVAL_TTL };
  if (b.approved || b.confirmed) out.note = 'Self-approved requests are ignored. Approve this operation in CodeSpace to get a valid approval token.';
  return out;
}
// For endpoints that must respect the network permission but where an interactive challenge
// would break a streaming/plain-lookup flow (the chat relay, read-only registry lookups):
// 'deny' still blocks hard, 'ask' behaves like 'allow' for these read-only/user-initiated calls.
function permDenyOnly(perm) { return permLoad()[perm] === 'deny'; }

/* ---------- 3.10: rate limiting for expensive endpoints ---------- */
const RATE_LIMITS = { '/ext/marketplace/node/activate': [8, 60000], '/ext/marketplace/node/command': [90, 60000], '/index/rebuild': [6, 60000], '/checkpoints/create': [12, 60000], '/checkpoints/restore': [6, 60000], '/web/search': [20, 60000], '/web/fetch': [40, 60000], '/web/extract': [40, 60000], '/web/find': [40, 60000], '/web/crawl': [4, 60000], '/web/screenshot': [12, 60000], '/http/request': [60, 60000], '/ext/install': [8, 60000], '/ext/marketplace/search': [40, 60000], '/ext/marketplace/install': [12, 60000], '/ext/marketplace/open-vscode': [6, 60000], '/dev/tests': [12, 60000], '/dev/diagnostics': [12, 60000], '/dev/lint': [12, 60000], '/dev/format': [6, 60000], '/dev/deps': [12, 60000], '/term/start': [20, 60000], '/task/create': [30, 60000], '/task/retry': [20, 60000], '/fs/editbatch': [60, 60000], '/skills/install': [10, 60000], '/opencode/install': [6, 60000], '/chat-zai/start': [4, 60000], '/chat-zai/token': [30, 60000], '/sandbox/create': [10, 60000], '/sandbox/exec': [120, 60000], '/sandbox/export': [20, 60000], '/sandbox/export/apply': [10, 60000] };
const RATE_HITS = new Map();
function rateLimit(ep) {
  const cfg = RATE_LIMITS[ep]; if (!cfg) return;
  const now = Date.now(), arr = (RATE_HITS.get(ep) || []).filter(t => now - t < cfg[1]);
  if (arr.length >= cfg[0]) { RATE_HITS.set(ep, arr); const e = new Error('Too many requests to ' + ep + ' — try again shortly.'); e.status = 429; throw e; }
  arr.push(now); RATE_HITS.set(ep, arr);
}

function configGet() { return { app: readJson(CONFIG_FILE, null), file: CONFIG_FILE }; }
function configSet(b) {
  if (!b.app || typeof b.app !== 'object') throw new Error('Missing config');
  if (JSON.stringify(b.app).length > 1e6) throw new Error('Config is too large');
  writeJson(CONFIG_FILE, b.app);
  return { saved: true, file: CONFIG_FILE };
}
const sid = id => { if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''))) throw new Error('Bad session id'); return String(id); };
function sessSave(b) {
  const id = sid(b.id);
  if (!b.session || typeof b.session !== 'object') throw new Error('Missing session');
  const str = JSON.stringify(b.session);
  if (str.length > 8e6) throw new Error('Session is too large');
  fs.mkdirSync(SESS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESS_DIR, id + '.json'), str);
  return { saved: true };
}
function sessList() {
  if (!fs.existsSync(SESS_DIR)) return { sessions: [] };
  const out = [];
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(SESS_DIR, f), null);
    if (j) out.push({ id: f.slice(0, -5), title: j.title || 'Untitled', updated: j.updated || 0, count: (j.messages || []).length });
  }
  out.sort((a, b) => b.updated - a.updated);
  return { sessions: out.slice(0, 300) };
}
const sessGet = b => ({ session: JSON.parse(fs.readFileSync(path.join(SESS_DIR, sid(b.id) + '.json'), 'utf8')) });
function sessDelete(b) { try { fs.unlinkSync(path.join(SESS_DIR, sid(b.id) + '.json')); } catch {} return { deleted: true }; }

/* ---------- shells, one-shot commands, persistent terminals ---------- */
const WIN = process.platform === 'win32';
const hasCmd = c => spawnSync(WIN ? 'where' : 'which', [c], { encoding: 'utf8' }).status === 0;
const PS_ONE = c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c];
const PS_PERSIST = ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'];
const SHELLS = (() => {
  const l = [];
  if (WIN) {
    l.push({ id: 'powershell', label: 'PowerShell', exe: 'powershell.exe', one: PS_ONE, persist: PS_PERSIST });
    if (hasCmd('pwsh')) l.push({ id: 'pwsh', label: 'PowerShell 7', exe: 'pwsh', one: PS_ONE, persist: PS_PERSIST });
    l.push({ id: 'cmd', label: 'Command Prompt', exe: 'cmd.exe', one: null, persist: ['/Q', '/K'] });
    if (hasCmd('bash')) l.push({ id: 'bash', label: 'Bash', exe: 'bash', one: c => ['-c', c], persist: [] });
  } else {
    for (const n of ['bash', 'zsh', 'sh']) if (hasCmd(n)) l.push({ id: n, label: n, exe: n, one: c => ['-c', c], persist: [] });
    if (hasCmd('pwsh')) l.push({ id: 'pwsh', label: 'PowerShell', exe: 'pwsh', one: PS_ONE, persist: PS_PERSIST });
  }
  return l;
})();
const pickShell = id => (id && id !== 'default') ? (SHELLS.find(s => s.id === id) || null) : null;

// If this computer has no Node.js on PATH, commands can still use the Node that runs CodeSpace itself (the bundled
// runtime in the portable app). It is appended last, so a real installed Node always wins. It has no npm.
const NODE_FALLBACK_DIR = (() => { try { return /^node(\.exe)?$/i.test(path.basename(process.execPath)) && !hasCmd('node') ? path.dirname(process.execPath) : ''; } catch { return ''; } })();
function cmdEnv(force) {
  const env = { ...process.env }, sec = readSecrets();
  if (NODE_FALLBACK_DIR) { const k = Object.keys(env).find(x => x.toUpperCase() === 'PATH') || 'PATH'; env[k] = (env[k] ? env[k] + path.delimiter : '') + NODE_FALLBACK_DIR; }
  if (sec.github && sec.github.token && (sec.github.expose || force)) {
    env.GH_TOKEN = env.GITHUB_TOKEN = sec.github.token;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + sec.github.token).toString('base64');
  }
  if (sec.vercel && sec.vercel.token && (sec.vercel.expose || force)) env.VERCEL_TOKEN = sec.vercel.token;
  return env;
}
function killTree(proc, graceful) {
  try {
    if (WIN) spawn('taskkill', graceful ? ['/pid', String(proc.pid), '/T'] : ['/pid', String(proc.pid), '/T', '/F']);
    else process.kill(-proc.pid, graceful ? 'SIGTERM' : 'SIGKILL');
  } catch {}
}
function runCommand(b, res) {
  const command = String(b.command || '').trim();
  if (!command) return send(res, 400, { error: 'Missing command' });
  const cwd = safe(b.cwd || '.');
  const sh = pickShell(b.shell);
  if (b.shell && b.shell !== 'default' && !sh) return send(res, 400, { error: 'Unknown shell: ' + b.shell });
  // Default command timeout is configurable for free-tier Codespaces (CODESPACE_TOOL_TIMEOUT_MS),
  // still clamped to 1..600 seconds so a caller can never disable the safety cap.
  const DEFAULT_TOOL_TIMEOUT_SEC = Math.max(1, Math.min(600, Math.round((Number(process.env.CODESPACE_TOOL_TIMEOUT_MS) || 60000) / 1000)));
  const timeoutMs = Math.min(Math.max(Number(b.timeout) || DEFAULT_TOOL_TIMEOUT_SEC, 1), 600) * 1000;
  const CAP = 100000;
  let out = '', err = '', done = false, timedOut = false;
  const opts = { cwd, detached: !WIN, env: cmdEnv(b.useConnections), windowsHide: true };
  const child = (sh && sh.one) ? spawn(sh.exe, sh.one(command), opts) : spawn(command, { ...opts, shell: true });
  const add = (s, c) => (s.length >= CAP ? s : (s + c.toString('utf8')).slice(0, CAP));
  child.stdout.on('data', c => { out = add(out, c); });
  child.stderr.on('data', c => { err = add(err, c); });
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  res.on('close', () => { if (!done) killTree(child); });
  child.on('close', (code, signal) => { done = true; clearTimeout(timer); invalidateCodeIndex('terminal command completed'); send(res, 200, { exitCode: code, signal, timedOut, stdout: out, stderr: err }); });
  child.on('error', e => { done = true; clearTimeout(timer); send(res, 200, { exitCode: -1, timedOut: false, stdout: out, stderr: String(e.message) }); });
}


/* ---------- OpenCode CLI chat bridge ----------
   Uses the user's own OpenCode CLI configuration and auth. The prompt is passed as a process
   argument with shell:false; the CLI's file/command permissions remain in effect unless the
   user explicitly enables the --auto option in the UI. */
/* ---------- Provider relay ----------
   Many hosted AI APIs refuse calls made straight from a web page (CORS). The page falls back to this relay, which
   forwards one request to the provider over https and streams the answer back. It needs the bridge token like
   everything else, only relays GET/POST, never forwards cookies, and is not written to the activity log (the
   request carries the provider key). http is allowed for loopback only. */
const LLM_BLOCK_HOST = /^(169\.254\.|metadata\.google\.internal$|\[?fd00:ec2::254\]?$)/i;
const LLM_DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'cookie', 'origin', 'referer']);
async function llmProxy(req, res, b) {
  const fail = (code, message) => {
    if (res.headersSent) return res.destroy();
    const out = JSON.stringify({ error: message });
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(out), 'X-Codespace-Proxy-Error': '1' });
    res.end(out);
  };
  let u; try { u = new URL(String(b.url || '')); } catch { return fail(400, 'That is not a valid provider address.'); }
  const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return fail(400, 'Only https provider addresses can be relayed.');
  if (LLM_BLOCK_HOST.test(u.hostname)) return fail(400, 'That address is not allowed.');
  if (permDenyOnly('network')) return fail(403, 'Network access is disabled by CodeSpace permission settings.');
  // 3.11: resolve the provider host up front and refuse private/reserved targets (the relay then
  // connects normally; provider hosts are user-configured and TLS-verified).
  try {
    const lit = u.hostname.replace(/^\[|\]$/g, '');
    if (!loop && !LLM_BLOCK_HOST.test(u.hostname) && !netMod.isIP(lit)) {
      const ips = await resolveHostIps(lit).catch(() => []);
      if (ips.length && ips.every(a => isPrivateIp(a))) return fail(400, 'That provider address resolves to a private network.');
    }
    if ((netMod.isIP(lit) && isPrivateIp(lit) && !loop)) return fail(400, 'That provider address is not allowed.');
  } catch {}
  const method = String(b.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return fail(400, 'Only GET and POST can be relayed.');
  const headers = {};
  if (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) {
    for (const [k, v] of Object.entries(b.headers)) {
      const key = String(k).toLowerCase();
      if (typeof v !== 'string' || !/^[a-z0-9-]{1,60}$/.test(key) || LLM_DROP_HEADERS.has(key) || /[\r\n]/.test(v)) continue;
      headers[key] = v;
    }
  }
  if (b.body != null && typeof b.body !== 'string') return fail(400, 'The relayed body must be text.');
  const body = b.body == null || method === 'GET' ? null : b.body;
  if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
  if (!headers['user-agent']) headers['user-agent'] = 'codespace-bridge';
  const up = (u.protocol === 'http:' ? http : https).request(u, { method, headers, timeout: 600000 }, r => {
    res.writeHead(r.statusCode || 502, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    r.on('error', () => res.destroy());
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('the provider did not answer in time')));
  up.on('error', e => fail(502, 'Could not reach ' + u.host + ': ' + ((e && e.message) || e)));
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  if (body != null) up.write(body);
  up.end();
}

/* ---------- OpenCode: install it for CodeSpace + save its API key ----------
   Lets OpenCode work on a computer that does not have it: the matching native build is downloaded from the
   npm registry (integrity-checked) into ~/.my-agent/opencode/bin. The API key is kept in a 0600 file in the
   data folder, handed to OpenCode only through the environment of the process we start, and never returned
   to the page (only the last 4 characters). */
const OC_DIR = path.join(DATA, 'opencode'), OC_BIN_DIR = path.join(OC_DIR, 'bin');
const OC_EXE = path.join(OC_BIN_DIR, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
const OC_AUTH_FILE = path.join(DATA, 'opencode-auth.json');
let ocInstalling = false;
// npm registry used for the download. Set CODESPACE_NPM_REGISTRY to use a mirror (https, or http on loopback only).
const OC_REGISTRY = String(process.env.CODESPACE_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
// 3.12.2: appended to every OpenCode prompt so work tasks end in an actionable report
// (mirrors REPORT_NOTE in my-chat-agent-v3.html; models that answer in one line otherwise
// leave out where the bugs were, why they mattered, what to improve, and what to do next).
const OC_REPORT_NOTE = '\n\nREPORTING REQUIREMENT for your final answer: if this task involved doing work — finding or fixing bugs, editing code, running commands, or analyzing the project — end with a structured report: "What I found" (each issue with its file path and why it is a problem), "What I changed" (file by file, with the reason for each change), "What I verified" (checks/tests you actually ran and their observed results, plus what you did not run), "What to improve" (weak spots worth addressing and why), and "Suggested next steps" (concrete, prioritized actions for this project). Use only real evidence; never invent files or results. Keep each section short. If the task was a simple question, answer normally without this structure.';
// 3.12.3: short-lived cache of the successful OpenCode --version pre-run check (see openCodeRun).
let ocRunCheck = { ok: false, until: 0 };
const OC_PROVIDERS = {
  opencode: { label: 'OpenCode Zen', env: ['OPENCODE_API_KEY'] },
  anthropic: { label: 'Anthropic (Claude)', env: ['ANTHROPIC_API_KEY'] },
  openai: { label: 'OpenAI', env: ['OPENAI_API_KEY'] },
  openrouter: { label: 'OpenRouter', env: ['OPENROUTER_API_KEY'] },
  google: { label: 'Google Gemini', env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'] },
  groq: { label: 'Groq', env: ['GROQ_API_KEY'] },
  deepseek: { label: 'DeepSeek', env: ['DEEPSEEK_API_KEY'] },
  mistral: { label: 'Mistral', env: ['MISTRAL_API_KEY'] },
  xai: { label: 'xAI', env: ['XAI_API_KEY'] }
};
const ocKnown = id => Object.prototype.hasOwnProperty.call(OC_PROVIDERS, id);
function ocAuthRead() {
  const o = readJson(OC_AUTH_FILE, {});
  const keys = {}; if (o && o.keys && typeof o.keys === 'object') for (const [k, v] of Object.entries(o.keys)) if (typeof v === 'string' && v) keys[k] = v;
  return { keys, model: o && typeof o.model === 'string' ? o.model : '' };
}
function ocSavedProviders() { return Object.keys(ocAuthRead().keys); }
function ocAuthView() {
  const a = ocAuthRead();
  const rows = Object.entries(OC_PROVIDERS).map(([id, v]) => ({ id, label: v.label, saved: !!a.keys[id], hint: a.keys[id] ? '…' + a.keys[id].slice(-4) : '' }));
  for (const id of Object.keys(a.keys)) if (!ocKnown(id)) rows.push({ id, label: id, saved: true, hint: '…' + a.keys[id].slice(-4) });
  return { providers: rows, model: a.model };
}
function ocAuthSet(b) {
  const a = ocAuthRead();
  if (typeof b.model === 'string') {
    const m = b.model.trim();
    if (m && !/^[A-Za-z0-9._\-\/:+]{1,120}$/.test(m)) throw new Error('The model name has characters OpenCode does not accept. Use provider/model, for example opencode/big-pickle.');
    a.model = m;
  }
  if (b.provider != null) {
    const id = String(b.provider).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) throw new Error('Provider ids use lowercase letters, digits, - and _ (for example opencode or anthropic).');
    if (b.clear === true) delete a.keys[id];
    else if (b.key != null && typeof b.key !== 'string') throw new Error('The API key must be text.');
    else if (typeof b.key === 'string' && b.key.trim()) {
      const k = b.key.trim();
      if (k.length < 8 || k.length > 500 || /[\s\0]/.test(k)) throw new Error('That does not look like an API key (no spaces, 8 to 500 characters).');
      a.keys[id] = k;
    }
  }
  writeJson(OC_AUTH_FILE, a);
  return ocAuthView();
}
// Environment for one `opencode run`: the saved keys as provider env vars AND as inline config (OPENCODE_CONFIG_CONTENT).
function ocRunEnv() {
  const a = ocAuthRead(), env = { ...process.env };
  const ids = Object.keys(a.keys);
  if (!ids.length) return { env, model: a.model };
  let cfg = {}; try { if (env.OPENCODE_CONFIG_CONTENT) cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) || {}; } catch { cfg = {}; }
  cfg.provider = (cfg.provider && typeof cfg.provider === 'object') ? cfg.provider : {};
  for (const id of ids) {
    const cur = cfg.provider[id] && typeof cfg.provider[id] === 'object' ? cfg.provider[id] : {};
    cfg.provider[id] = { ...cur, options: { ...(cur.options || {}), apiKey: a.keys[id] } };
    for (const n of (ocKnown(id) && OC_PROVIDERS[id].env) || []) env[n] = a.keys[id];
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
  return { env, model: a.model };
}
function ocPlatformPackages() {
  const o = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : '';
  const a = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!o || !a) return [];
  const musl = o === 'linux' && fs.existsSync('/etc/alpine-release');
  const base = 'opencode-' + o + '-' + a;
  const list = [base + (musl ? '-musl' : '')];
  if (a === 'x64') list.push(base + '-baseline' + (musl ? '-musl' : '')); // older CPUs without AVX2
  return list;
}
function ocHttpsGet(url, opts = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('Bad download address.')); }
    let reg; try { reg = new URL(OC_REGISTRY); } catch { return reject(new Error('CODESPACE_NPM_REGISTRY is not a valid address.')); }
    const loop = h => h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
    const allowedProto = u.protocol === 'https:' || (u.protocol === 'http:' && loop(u.hostname));
    if (!allowedProto || u.host !== reg.host) return reject(new Error('Refusing to download from ' + u.hostname + '.'));
    const maxBytes = opts.maxBytes || 400e6;
    const req = (u.protocol === 'http:' ? http : https).get(u, { headers: { 'User-Agent': 'codespace-bridge', Accept: '*/*' }, timeout: 60000 }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume(); if (hops >= 4) return reject(new Error('Too many redirects.'));
        return resolve(ocHttpsGet(new URL(r.headers.location, u).href, opts, hops + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('The registry answered HTTP ' + r.statusCode + '.')); }
      const chunks = []; let n = 0; const total = Number(r.headers['content-length']) || 0;
      r.on('data', c => { n += c.length; if (n > maxBytes) { req.destroy(new Error('The download is larger than expected.')); return; } chunks.push(c); if (opts.onProgress) opts.onProgress(n, total); });
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The download timed out (no data for 60 s). Check the internet connection or proxy.')));
    req.on('error', reject);
  });
}
async function ocInstall(res) {
  const say = message => sendSse(res, { type: 'progress', message });
  let ok = false, err = '';
  if (ocInstalling) { sendSse(res, { type: 'done', ok: false, error: 'An install is already running.', status: openCodeStatus() }); return res.end(); }
  ocInstalling = true;
  try {
    fs.mkdirSync(OC_BIN_DIR, { recursive: true });
    const pkgs = ocPlatformPackages();
    if (!pkgs.length) throw new Error('There is no OpenCode build for ' + process.platform + '/' + process.arch + '.');
    const errs = [];
    for (const pkg of pkgs) {
      let tmp = '';
      try {
        say('Looking up ' + pkg + ' on ' + new URL(OC_REGISTRY).host + '…');
        const meta = JSON.parse((await ocHttpsGet(OC_REGISTRY + '/' + pkg + '/latest')).toString('utf8'));
        const tarball = meta && meta.dist && meta.dist.tarball;
        if (!tarball) throw new Error('the registry returned no download link');
        say('Downloading OpenCode ' + (meta.version || '') + '…');
        let lastPct = -10;
        const buf = await ocHttpsGet(tarball, { onProgress: (n, t) => { const pct = t ? Math.floor(n / t * 100) : -10; if (pct >= lastPct + 10) { lastPct = pct; say('Downloading… ' + pct + '%'); } } });
        const integ = String(meta.dist.integrity || '');
        if (integ.startsWith('sha512-')) { if (crypto.createHash('sha512').update(buf).digest('base64') !== integ.slice(7)) throw new Error('integrity check failed, the download is corrupted'); }
        else if (meta.dist.shasum) { if (crypto.createHash('sha1').update(buf).digest('hex') !== String(meta.dist.shasum)) throw new Error('checksum failed, the download is corrupted'); }
        else throw new Error('the registry gave no checksum to verify the download');
        say('Unpacking…');
        tmp = fs.mkdtempSync(path.join(OC_DIR, 'dl-'));
        const tgz = path.join(tmp, 'pkg.tgz'); fs.writeFileSync(tgz, buf);
        const x = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { encoding: 'utf8', timeout: 120000, windowsHide: true });
        if (x.error || x.status !== 0) throw new Error('could not unpack (needs the "tar" command, built into Windows 10+ and Linux/macOS): ' + String((x.error && x.error.message) || x.stderr || '').slice(0, 200));
        const src = path.join(tmp, 'package', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
        if (!fs.existsSync(src)) throw new Error('the package does not contain the opencode program');
        const staged = OC_EXE + '.new';
        fs.copyFileSync(src, staged); if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);
        try { fs.rmSync(OC_EXE, { force: true }); } catch {}
        fs.renameSync(staged, OC_EXE);
        say('Checking that it starts…');
        const v = spawnSync(OC_EXE, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        if (v.error || v.status !== 0) { try { fs.rmSync(OC_EXE, { force: true }); } catch {} throw new Error('it does not run on this computer: ' + String((v.error && v.error.message) || v.stderr || ('exit ' + v.status)).slice(0, 160)); }
        say('OpenCode ' + (String(v.stdout || '').trim() || meta.version || '') + ' is installed for CodeSpace.');
        ok = true; break;
      } catch (e) { errs.push(pkg + ': ' + e.message); say('That build did not work (' + e.message + ').'); }
      finally { if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
    }
    if (!ok) throw new Error(errs.join(' | ') || 'The install failed.');
  } catch (e) { err = String(e.message || e); }
  finally { ocInstalling = false; }
  sendSse(res, { type: 'done', ok, error: err, status: openCodeStatus() });
  if (!res.writableEnded) res.end();
}
function ocInstallRoute(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders && res.flushHeaders();
  return ocInstall(res);
}

function resolveOpenCodeShim(cmdPath) {
  let source = '';
  try { source = fs.readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const quoted = [...source.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
  for (let target of quoted) {
    if (!/node_modules[\\/].*opencode/i.test(target) && !/%~?dp0%?[\\/].*node_modules[\\/]/i.test(target)) continue;
    target = target.replace(/^%~?dp0%?/i, '').replace(/^%dp0%/i, '').replace(/%~?dp0%?/ig, '');
    target = target.replace(/^[\\/]+/, '');
    const full = path.resolve(path.dirname(cmdPath), target.replace(/[\\/]/g, path.sep));
    if (!fs.existsSync(full) || /\.(cmd|bat|ps1)$/i.test(full)) continue;
    // npm's Windows OpenCode shim can target either a native PE executable or a JS entry.
    // Never hand a native .exe to Node: the PE 'MZ' header otherwise causes a JS SyntaxError.
    if (/\.exe$/i.test(full)) return { command: full, prefix: [], source: cmdPath };
    if (/\.(js|cjs|mjs)$/i.test(full)) return { command: process.execPath, prefix: [full], source: cmdPath };
    // Preserve non-script native launchers as native executables.
    return { command: full, prefix: [], source: cmdPath };
  }
  return null;
}
function resolveOpenCodeBinary() {
  const configured = String(process.env.OPENCODE_BIN || '').trim();
  const candidates = [];
  if (configured) {
    if (path.isAbsolute(configured) || /[\\/]/.test(configured)) candidates.push(configured);
    else {
      const lookup = spawnSync(WIN ? 'where.exe' : 'which', [configured], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (lookup.status === 0) candidates.push(...String(lookup.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
    }
  } else {
    const lookup = spawnSync(WIN ? 'where.exe' : 'which', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (lookup.status === 0) candidates.push(...String(lookup.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  }
  const unique = [...new Set(candidates)].filter(Boolean);
  // Prefer a native executable, then a directly executable Unix shim, then npm's Windows .cmd shim.
  unique.sort((a, b) => (/(\.exe)$/i.test(b) ? 4 : /\.(cmd|bat)$/i.test(b) ? 1 : 3) - (/(\.exe)$/i.test(a) ? 4 : /\.(cmd|bat)$/i.test(a) ? 1 : 3));
  for (const c of unique) {
    if (/\.(cmd|bat|ps1)$/i.test(c)) {
      if (WIN && /\.(cmd|bat)$/i.test(c)) { const sh = resolveOpenCodeShim(c); if (sh) return sh; }
      continue;
    }
    if (/\.(js|cjs|mjs)$/i.test(c) && fs.existsSync(c)) return { command: process.execPath, prefix: [c], source: c };
    if (!WIN || /\.exe$/i.test(c)) return { command: c, prefix: [], source: c };
  }
  // Nothing on PATH: use the copy CodeSpace installed itself (see ocInstall), if there is one.
  if (fs.existsSync(OC_EXE)) return { command: OC_EXE, prefix: [], source: OC_EXE, managed: true };
  return null;
}
function openCodeStatus() {
  const binary = resolveOpenCodeBinary();
  if (!binary) return { installed: false, canInstall: true, installing: ocInstalling, installDir: OC_BIN_DIR, authenticated: null, workspace: ROOT || '', savedKeys: ocSavedProviders(), message: 'OpenCode CLI was not found on this computer. Use \"Install OpenCode for CodeSpace\" in Settings (no admin rights needed), or install it yourself / set OPENCODE_BIN and restart the bridge.' };
  const r = spawnSync(binary.command, [...binary.prefix, '--version'], { cwd: ROOT || os.homedir(), encoding: 'utf8', timeout: 12000, windowsHide: true, env: process.env });
  const output = ((r.stdout || '') + '\n' + (r.stderr || '')).trim().slice(0, 500);
  if (r.error || r.status !== 0) return { installed: false, authenticated: null, workspace: ROOT || '', message: 'OpenCode CLI was found but could not start: ' + String((r.error && r.error.message) || output || ('exit code ' + r.status)).slice(0, 400) };
  return { installed: true, managed: !!binary.managed, source: binary.source, version: output || 'version unknown', authenticated: null, savedKeys: ocSavedProviders(), workspace: ROOT || '', message: ROOT ? 'Ready to run OpenCode in the open workspace.' : 'Open a workspace folder before sending a task to OpenCode.' };
}
function openCodeRun(req, res, b) {
  if (!ROOT || !isDir(ROOT)) return send(res, 400, { error: 'Open a workspace folder in My Chat Agent first.' });
  const prompt = String(b.prompt || '').trim();
  if (!prompt) return send(res, 400, { error: 'Missing OpenCode prompt.' });
  if (prompt.length > 100000) return send(res, 413, { error: 'OpenCode prompt is too large (maximum 100,000 characters).' });
  if (prompt.includes('\0')) return send(res, 400, { error: 'Prompt contains a null character.' });
  const sessionId = String(b.sessionId || '');
  if (sessionId && !/^ses_[A-Za-z0-9_-]{4,200}$/.test(sessionId)) return send(res, 400, { error: 'Invalid OpenCode session ID.' });
  const binary = resolveOpenCodeBinary();
  if (!binary) return send(res, 503, { error: 'OpenCode CLI is not installed on this computer. Open Settings > OpenCode CLI and press "Install OpenCode for CodeSpace" (or install it yourself / set OPENCODE_BIN).' });
  // 3.12.3: cache the successful pre-run --version check for 5 minutes so every chat message
  // does not pay an extra process spawn (noticeable on Windows). A run that fails to start
  // invalidates the cache, and the next run rechecks; the run itself stays fully supervised.
  if (!(ocRunCheck.ok && Date.now() < ocRunCheck.until)) {
    const check = spawnSync(binary.command, [...binary.prefix, '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 12000, windowsHide: true, env: process.env });
    if (check.error || check.status !== 0) { ocRunCheck = { ok: false, until: 0 }; return send(res, 503, { error: 'OpenCode CLI could not start: ' + String((check.error && check.error.message) || check.stderr || check.stdout || 'version check failed').slice(0, 400) }); }
    ocRunCheck = { ok: true, until: Date.now() + 5 * 60000 };
  }

  const runCfg = ocRunEnv();
  // The installed OpenCode v2 CLI has no `--dir` flag (verified with `opencode run --help`:
  // supported run flags are --session/-s, --model/-m, --format, --auto, --thinking, --agent,
  // --continue, --file, --fork, --standalone, --server). The workspace is supplied as the
  // process working directory via `cwd: ROOT` in the spawn call below, never as a CLI argument.
  const args = [...binary.prefix, 'run', '--format', 'json'];
  if (runCfg.model) args.push('--model', runCfg.model);
  if (sessionId) args.push('--session', sessionId);
  if (b.autoApprove === true) args.push('--auto');
  // Use argument arrays and shell:false; user prompt is never interpolated into a shell command.
  // 3.12.2: mirror the frontend WORK REPORT RULES so OpenCode answers to work tasks
  // ("find and fix bugs", refactors, …) are structured reports, not one-line summaries.
  args.push(prompt + OC_REPORT_NOTE);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.flushHeaders && res.flushHeaders();
  let child, timer = null, beat = null, done = false, timedOut = false, session = sessionId, stderr = '', stdoutCarry = '';
  const startedAt = Date.now();
  // 3.12.1: if OpenCode does not emit parseable JSON events (older build, --format unsupported,
  // plain-text output), keep its raw output as a fallback answer instead of "no visible text answer".
  let plainOut = '';
  const messageOrder = [], messageParts = new Map(), seenPartIds = new Set();
  let lastLiveTail = '';
  const say = message => sendSse(res, { type: 'progress', message });
  const cap = (old, text, n) => (old + String(text || '')).slice(-n);
  const onLine = line => {
    line = String(line || '').trim(); if (!line) return;
    let ev; try { ev = JSON.parse(line); } catch { plainOut = cap(plainOut, line + '\n', 40000); return; }
    if (typeof ev.sessionID === 'string' && /^ses_[A-Za-z0-9_-]{4,200}$/.test(ev.sessionID)) session = ev.sessionID;
    const part = ev.part || {};
    if (typeof part.sessionID === 'string' && /^ses_[A-Za-z0-9_-]{4,200}$/.test(part.sessionID)) session = part.sessionID;
    const typ = String(ev.type || ev.event || ''), ptyp = String(part.type || '');
    if (typ === 'text' || ptyp === 'text') {
      const text = typeof part.text === 'string' ? part.text : (typeof ev.text === 'string' ? ev.text : '');
      if (text) {
        const mid = String(part.messageID || ev.messageID || session + ':message');
        const pid = String(part.id || ev.id || (mid + ':' + messageParts.size));
        if (!messageParts.has(mid)) { messageParts.set(mid, new Map()); messageOrder.push(mid); }
        // JSON events identify a stable part ID; replace repeated snapshots rather than duplicating them.
        if (!seenPartIds.has(mid + '|' + pid)) seenPartIds.add(mid + '|' + pid);
        messageParts.get(mid).set(pid, text.slice(0, 150000));
        // Live writing: stream a short tail of the answer as it grows (updates one UI row
        // instead of stacking a new line on every snapshot).
        const tail = text.replace(/\s+/g, ' ').trim().slice(-140);
        if (tail && tail !== lastLiveTail) { lastLiveTail = tail; sendSse(res, { type: 'live', kind: 'text', message: 'OpenCode is writing…', tail }); }
      }
    } else if (/tool|step_start|step-finish|step_finish|session\.status/i.test(typ + ' ' + ptyp)) {
      const tool = String(part.tool || part.name || ev.tool || '').replace(/[^A-Za-z0-9 _./:-]/g, '').slice(0, 60);
      const st = part.state && typeof part.state === 'object' ? part.state : {};
      const detail = String(st.title || '').replace(/\s+/g, ' ').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
      say(tool ? 'OpenCode is using ' + tool + (detail ? ' · ' + detail : '') + '…' : 'OpenCode is working through the next step…');
    } else if (typ === 'session.complete') say('OpenCode finished; collecting its answer…');
  };
  function finish(exitCode, signal, errorText = '') {
    if (done) return; done = true; clearTimeout(timer); if (beat) clearInterval(beat);
    if (exitCode === -1) ocRunCheck = { ok: false, until: 0 }; // the binary broke; force a fresh check next run
    if (stdoutCarry.trim()) onLine(stdoutCarry);
    const lastMid = [...messageOrder].reverse().find(mid => [...(messageParts.get(mid) || new Map()).values()].join('').trim());
    let finalText = lastMid ? [...messageParts.get(lastMid).values()].join('') : '';
    // Fallback: no parseable JSON answer, but OpenCode printed something — show that instead of "no visible text answer".
    if (!String(finalText).trim() && plainOut.trim()) finalText = plainOut.trim();
    if (exitCode === 0) invalidateCodeIndex('OpenCode CLI task completed');
    sendSse(res, { type: 'done', exitCode, signal: signal || null, timedOut, sessionId: session, text: finalText, stderr: cap('', stderr || errorText, 12000) });
    if (!res.writableEnded) res.end();
  }
  try {
    say('Starting OpenCode CLI in ' + ROOT + '…');
    child = spawn(binary.command, args, { cwd: ROOT, detached: !WIN, windowsHide: true, env: runCfg.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      stdoutCarry += chunk.toString('utf8');
      let at; while ((at = stdoutCarry.indexOf('\n')) >= 0) { const line = stdoutCarry.slice(0, at); stdoutCarry = stdoutCarry.slice(at + 1); onLine(line); }
      if (stdoutCarry.length > 500000) stdoutCarry = stdoutCarry.slice(-200000);
    });
    child.stderr.on('data', chunk => { stderr = cap(stderr, chunk.toString('utf8'), 20000); const t = String(chunk).trim(); if (/error|denied|permission|auth|login|not found|failed/i.test(t)) say(t.slice(-180).replace(/[\r\n]+/g, ' ')); });
    // Heartbeat: while the model thinks (no events), keep the live view honest instead of frozen on one line.
    beat = setInterval(() => {
      if (done) return;
      const s = Math.round((Date.now() - startedAt) / 1000);
      sendSse(res, { type: 'live', kind: 'wait', message: 'OpenCode is still working… (' + Math.floor(s / 60) + 'm ' + (s % 60) + 's elapsed)' });
    }, 45000);
    timer = setTimeout(() => { timedOut = true; say('OpenCode exceeded the 60-minute safety timeout; stopping it…'); if (child && !done) killTree(child, true); }, 60 * 60 * 1000);
    res.on('close', () => { if (!done && child) killTree(child, true); });
    req.on('aborted', () => { if (!done && child) killTree(child, true); });
    child.on('error', e => finish(-1, null, e.message));
    child.on('close', (code, signal) => finish(code == null ? -1 : code, signal, ''));
  } catch (e) {
    if (child) killTree(child, true);
    if (!res.headersSent) return send(res, 500, { error: 'Could not start OpenCode CLI: ' + e.message });
    sendSse(res, { type: 'done', exitCode: -1, sessionId: session, text: '', stderr: e.message });
    if (!res.writableEnded) res.end();
  }
}

const TERMS = new Map(); const TERM_STREAMS = new Map(); let termSeq = 1;
function termStart(o) {
  const sh = pickShell(o.shell) || SHELLS[0];
  if (!sh) throw new Error('No shell was found on this computer');
  const cwd = ROOT ? safe(o.cwd || '.') : os.homedir();
  const env = { ...cmdEnv(o.useConnections), TERM: ptyLib ? 'xterm-256color' : 'dumb' };
  let proc, backend = 'pipe';
  if (ptyLib) {
    try { proc = ptyLib.spawn(sh.exe, sh.persist, { name: 'xterm-256color', cols: Math.max(40, Math.min(240, Number(o.cols) || 100)), rows: Math.max(10, Math.min(100, Number(o.rows) || 28)), cwd, env, useConpty: true }); backend = 'pty'; }
    catch (e) { console.warn('[terminal] PTY start failed; using pipe fallback:', e.message); }
  }
  if (!proc) proc = spawn(sh.exe, sh.persist, { cwd, detached: !WIN, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const t = { id: 't' + termSeq++, name: o.name || sh.label, shell: sh.id, cwd, command: String(o.command || ''), startedAt: Date.now(), buf: '', base: 0, exited: false, code: null, signal: null, proc, backend, pty: backend === 'pty' };
  const add = c => { const chunk = Buffer.isBuffer(c) ? c.toString('utf8') : String(c); t.buf += chunk; if (t.buf.length > 200000) { const cut = t.buf.length - 150000; t.buf = t.buf.slice(cut); t.base += cut; } const payload = { type: 'terminal', id: t.id, data: chunk, next: t.base + t.buf.length, exited: t.exited, code: t.code }; for (const client of (TERM_STREAMS.get(t.id) || [])) sendSse(client, payload); };
  if (backend === 'pty') {
    proc.onData(add);
    proc.onExit(ev => { t.exited = true; t.code = ev.exitCode; t.signal = ev.signal || null; add('\r\n[process exited' + (ev.exitCode != null ? ' with code ' + ev.exitCode : '') + ']\r\n'); for (const client of (TERM_STREAMS.get(t.id) || [])) sendSse(client, { type: 'terminal', id: t.id, data: '', next: t.base + t.buf.length, exited: true, code: t.code }); });
  } else {
    proc.stdout.on('data', add); proc.stderr.on('data', add); proc.stdin.on('error', () => {});
    proc.on('close', (code, signal) => { t.exited = true; t.code = code; t.signal = signal || null; add('\n[process exited' + (code != null ? ' with code ' + code : '') + ']\n'); for (const client of (TERM_STREAMS.get(t.id) || [])) sendSse(client, { type: 'terminal', id: t.id, data: '', next: t.base + t.buf.length, exited: true, code }); });
    proc.on('error', e => { t.exited = true; add('\n[error] ' + e.message + '\n'); });
  }
  TERMS.set(t.id, t);
  return t;
}
const termGet = id => { const t = TERMS.get(String(id)); if (!t) throw new Error('Terminal not found'); return t; };
const termInfo = t => ({ id: t.id, name: t.name, shell: t.shell, exited: t.exited, code: t.code, pty: !!t.pty, backend: t.backend, cwd: t.cwd, command: t.command, startedAt: t.startedAt, signal: t.signal });
function termRead(b) {
  const t = termGet(b.id); let since = Number(b.since) || 0;
  if (since < t.base) since = t.base;
  return { data: t.buf.slice(since - t.base), next: t.base + t.buf.length, exited: t.exited, code: t.code, pty: !!t.pty };
}
function termWrite(b) {
  const t = termGet(b.id);
  if (t.exited) throw new Error('This terminal has exited. Start a new one.');
  const data = String(b.data ?? '');
  if (t.pty) t.proc.write(data); else t.proc.stdin.write(data);
  invalidateCodeIndex('terminal input may change workspace files');
  return { ok: true };
}
function termResize(b) {
  const t = termGet(b.id); if (!t.pty) return { ok: false, pty: false };
  const cols = Math.max(20, Math.min(300, Number(b.cols) || 100));
  const rows = Math.max(5, Math.min(120, Number(b.rows) || 28));
  t.proc.resize(cols, rows); return { ok: true, cols, rows };
}
function termStop(t, graceful = true) {
  try { if (t.pty) t.proc.kill(graceful ? undefined : 'SIGKILL'); else killTree(t.proc, graceful); } catch {}
}
async function runBackground(b) {
  const command = String(b.command || '').trim();
  if (!command) throw new Error('Missing command');
  const t = termStart({ shell: b.shell, cwd: b.cwd, name: b.name || command.slice(0, 28), command, useConnections: b.useConnections });
  t.buf += '› ' + command + '\n';
  if (t.pty) t.proc.write(command + (t.shell === 'cmd' ? '\r' : '\r'));
  else t.proc.stdin.write(command + (t.shell === 'cmd' ? '\r\n' : '\n'));
  invalidateCodeIndex('background command started');
  await sleep(Math.min(Math.max(Number(b.wait) || 2500, 500), 15000));
  return { background: true, terminalId: t.id, output: t.buf.slice(-20000), exited: t.exited, code: t.code };
}
process.on('exit', () => { for (const t of TERMS.values()) termStop(t, false); });

function workflowStatus() {
  const sessions = [...TERMS.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map(t => {
    const tail = t.buf.slice(-30000);
    const urls = [...new Set((tail.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>]*)?/gi) || []).map(x => x.replace(/[),.;]+$/, '').replace('0.0.0.0', 'localhost').replace('[::1]', 'localhost')))];
    const failed = /\b(error|failed|failure|exception|traceback|ELIFECYCLE|ERR!|cannot find module)\b/i.test(tail) || (t.exited && t.code != null && t.code !== 0);
    const passed = /\b(all tests passed|tests? passed|build successful|compiled successfully|built successfully|successfully compiled|PASS(?:ED)?\b)\b/i.test(tail);
    const status = t.exited ? (t.code === 0 ? 'stopped' : 'failed') : (failed ? 'failed' : 'running');
    const result = failed ? 'error detected' : passed ? 'checks passed' : urls.length ? 'dev server' : (t.exited ? (t.code === 0 ? 'completed' : 'failed') : 'running');
    return { id: t.id, name: t.name, shell: t.shell, cwd: t.cwd, command: t.command, running: !t.exited, exited: t.exited, exitCode: t.code, signal: t.signal, startedAt: t.startedAt, backend: t.backend, pty: !!t.pty, urls, status, result, outputTail: tail.slice(-5000) };
  });
  return { root: ROOT, sessions, counts: { running: sessions.filter(s => s.running).length, failed: sessions.filter(s => s.status === 'failed').length, withUrls: sessions.filter(s => s.urls.length).length } };
}


function workflowDiagnostics() {
  const status = workflowStatus();
  const sessions = status.sessions.map(s => {
    const lines = String(s.outputTail || '').split(/\r?\n/);
    const matches = lines.filter(line => /\b(error|failed|failure|exception|traceback|ELIFECYCLE|ERR!|cannot find module|not found|syntaxerror|typeerror|referenceerror)\b/i.test(line));
    return { id: s.id, name: s.name, cwd: s.cwd, command: s.command, status: s.status, exitCode: s.exitCode,
      urls: s.urls, outputTail: s.outputTail, errorLines: [...new Set(matches)].slice(-30) };
  });
  return { root: status.root, counts: status.counts, sessions, generatedAt: new Date().toISOString(),
    note: 'Diagnostics are heuristic. Review the proposed repair prompt before sending it to the model.' };
}


/* ---------- Phase 3G: bounded project understanding scan ---------- */
function projectUnderstand() {
  if (!ROOT) throw new Error('Open a workspace before scanning the project.');
  const root = fs.realpathSync(ROOT);
  const files = [];
  const maxFiles = 1800;
  for (const f of walk(root)) {
    if (files.length >= maxFiles) break;
    if (f.rel.split('/').some(part => part.startsWith('.') && ['.agent', '.git', '.vscode'].includes(part))) continue;
    if (BINARY.test(f.rel) || /(^|\/)(\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa|credentials\.json|secrets?\.(json|ya?ml))$/i.test(f.rel)) continue;
    files.push(f.rel);
  }
  const readSmall = rel => {
    try { const full = safe(rel); const st = fs.statSync(full); if (!st.isFile() || st.size > 180000) return null; return fs.readFileSync(full, 'utf8'); } catch { return null; }
  };
  const manifests = {};
  for (const rel of ['package.json','pyproject.toml','requirements.txt','Pipfile','Cargo.toml','go.mod','composer.json','Gemfile','pom.xml','build.gradle','build.gradle.kts','pubspec.yaml','index.html','README.md','README.rst','vite.config.ts','vite.config.js','next.config.js','next.config.mjs','next.config.ts','angular.json','manage.py','artisan','Dockerfile','.github/workflows']) {
    if (rel.endsWith('/workflows')) continue;
    if (files.includes(rel)) { const text = readSmall(rel); if (text !== null) manifests[rel] = text.slice(0, 24000); }
  }
  const packageJson = (()=>{try{return JSON.parse(manifests['package.json']||'{}')}catch{return {}}})();
  const pythonDeps = (manifests['requirements.txt']||'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')).slice(0,80);
  const pyproject = manifests['pyproject.toml']||'';
  const langs = {};
  for (const f of files) { const ext = path.extname(f).toLowerCase() || (f==='Dockerfile'?'Dockerfile':''); if (ext) langs[ext]=(langs[ext]||0)+1; }
  const dirs = [...new Set(files.filter(f=>f.includes('/')).map(f=>f.split('/')[0]).filter(Boolean))].slice(0,80);
  const important = files.filter(f => /(^|\/)(src|app|pages|routes|api|server|backend|frontend|tests?|__tests__|components|lib|config)(\/|$)/i.test(f) || /(^|\/)(main|index|app|server|vite\.config|next\.config|Dockerfile|docker-compose|compose\.ya?ml|README)(\.|$)/i.test(f)).slice(0,160);
  const frameworks = new Set();
  const deps = {...(packageJson.dependencies||{}), ...(packageJson.devDependencies||{})};
  for (const [name,label] of [['react','React'],['vue','Vue'],['svelte','Svelte'],['next','Next.js'],['vite','Vite'],['@angular/core','Angular'],['express','Express'],['fastify','Fastify'],['electron','Electron'],['typescript','TypeScript'],['laravel/framework','Laravel'],['django','Django'],['fastapi','FastAPI'],['flask','Flask'],['torch','PyTorch'],['transformers','Hugging Face Transformers']]) if (deps[name] || pyproject.toLowerCase().includes(name) || pythonDeps.some(x=>x.toLowerCase().startsWith(name+'=')) || (name==='laravel/framework' && manifests['composer.json'])) frameworks.add(label);
  if (manifests['composer.json']) { try { const c=JSON.parse(manifests['composer.json']); const d={...(c.require||{}),...(c['require-dev']||{})}; if(d['laravel/framework']) frameworks.add('Laravel'); if(d['symfony/framework-bundle']) frameworks.add('Symfony'); } catch {} }
  if (manifests['requirements.txt'] || manifests['pyproject.toml']) frameworks.add('Python project');
  if (manifests['Cargo.toml']) frameworks.add('Rust'); if (manifests['go.mod']) frameworks.add('Go'); if (manifests['pubspec.yaml']) frameworks.add('Flutter/Dart'); if (manifests['pom.xml'] || manifests['build.gradle'] || manifests['build.gradle.kts']) frameworks.add('Java/JVM');
  const scripts = packageJson.scripts && typeof packageJson.scripts==='object' ? Object.fromEntries(Object.entries(packageJson.scripts).slice(0,40).map(([k,v])=>[k,String(v).slice(0,300)])) : {};
  const entryCandidates = files.filter(f=>/^(src\/)?(main|index|app|server)\.(js|jsx|ts|tsx|mjs|cjs|py|java|go|rs)$/i.test(f) || /^(src\/)?main\.dart$/i.test(f) || /^(artisan|manage\.py)$/i.test(f)).slice(0,50);
  const recommendations=[];
  if (packageJson.scripts?.test) recommendations.push({kind:'test',command:'npm test',reason:'package.json defines a test script'});
  if (packageJson.scripts?.build) recommendations.push({kind:'build',command:'npm run build',reason:'package.json defines a build script'});
  if (packageJson.scripts?.lint) recommendations.push({kind:'lint',command:'npm run lint',reason:'package.json defines a lint script'});
  if (files.includes('pytest.ini') || files.some(f=>f==='tests' || f.startsWith('tests/')) || pyproject.toLowerCase().includes('pytest')) recommendations.push({kind:'test',command:'pytest',reason:'Python test configuration or tests folder detected'});
  return {ok:true,root,scannedAt:new Date().toISOString(),limits:{maxFiles,filesFound:files.length,manifestBytes:180000},fileCount:files.length,truncated:files.length>=maxFiles,topLevel:dirs,languageCounts:langs,frameworks:[...frameworks],entryCandidates,importantFiles:important,manifests:Object.keys(manifests),scripts,recommendedCommands:recommendations,projectType:frameworks.size?[...frameworks].join(', '):'Unknown / mixed project',notes:['Scan uses filenames and selected manifest/config files only.','Secret-like files and source file contents are not included in this report.','Detected commands are suggestions only; none were executed.']};
}
function projectUnderstandMemoryDraft(b) {
  const scan = projectUnderstand();
  const entries = [];
  entries.push({id:crypto.randomUUID(),category:'architecture',text:'Project type/frameworks detected: '+scan.projectType+'. Top-level folders: '+scan.topLevel.slice(0,25).join(', ')+'.',updatedAt:Date.now()});
  if (scan.entryCandidates.length) entries.push({id:crypto.randomUUID(),category:'entry-points',text:'Likely entry points: '+scan.entryCandidates.slice(0,25).join(', ')+'. Verify before relying on this heuristic.',updatedAt:Date.now()});
  if (Object.keys(scan.scripts).length) entries.push({id:crypto.randomUUID(),category:'commands',text:'package.json scripts detected: '+Object.entries(scan.scripts).map(([k,v])=>k+'='+v).slice(0,20).join('; '),updatedAt:Date.now()});
  if (scan.recommendedCommands.length) entries.push({id:crypto.randomUUID(),category:'testing',text:'Suggested test/build commands (not run automatically): '+scan.recommendedCommands.map(x=>x.command+' ('+x.reason+')').join('; '),updatedAt:Date.now()});
  return {ok:true,scan,proposedEntries:entries};
}

/* ---------- project memory (workspace-scoped, bounded) ---------- */
function projectMemoryFile() {
  if (!ROOT) throw new Error('Open a workspace before using project memory.');
  return path.join(ROOT, '.agent', 'project-memory.json');
}
function projectMemoryGet() {
  const file = projectMemoryFile();
  const data = readJson(file, { version: 1, updatedAt: null, entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries.slice(0, 80).map(x => ({
    id: String(x.id || ''), text: String(x.text || '').slice(0, 2000), category: String(x.category || 'note').slice(0, 40), updatedAt: Number(x.updatedAt) || 0
  })) : [];
  return { ok: true, file: path.relative(ROOT, file).replace(/\\/g, '/'), updatedAt: data.updatedAt || null, entries };
}
function projectMemorySet(b) {
  const file = projectMemoryFile();
  const entries = Array.isArray(b.entries) ? b.entries.slice(0, 80).map(x => ({
    id: String(x.id || crypto.randomUUID()), text: String(x.text || '').trim().slice(0, 2000),
    category: String(x.category || 'note').slice(0, 40), updatedAt: Date.now()
  })).filter(x => x.text) : [];
  const data = { version: 1, updatedAt: Date.now(), entries };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, data);
  return { ok: true, count: entries.length, updatedAt: data.updatedAt };
}

/* ---------- files ---------- */
/* 3.13.3: workspace-folder access control. Inside the opened folder everything works as before.
   A path that resolves OUTSIDE the opened folder is only served after the user approves it
   (permission 'outside', default 'ask') — the AI must request it and the user decides.
   Writes/deletes outside the workspace stay blocked unconditionally. */
function fsAccess(p, verb, b) {
  if (!ROOT) throw new Error('No folder is open. Use File > Open Folder in the app first.');
  if (p != null && typeof p !== 'string') throw new Error('A path must be text.');
  if (typeof p === 'string' && p.includes('\0')) throw new Error('Invalid path.');
  const full = path.resolve(ROOT, p);
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  if (inside(fs.realpathSync(ROOT), fs.realpathSync(probe))) return { full };
  const g = permGuard('outside', verb + ' outside the opened folder "' + ROOT + '": ' + full, b);
  if (g) return { challenge: g };
  return { full };
}
function fsList(b) {
  const acc = fsAccess(b.path, 'List a folder', b);
  if (acc.challenge) return acc.challenge;
  const dir = acc.full; const entries = [];
  if (b.recursive) {
    for (const f of walk(dir)) { entries.push(f.rel); if (entries.length >= 300) { entries.push('…(limit reached)'); break; } }
  } else {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!IGNORE.has(e.name)) entries.push(e.name + (e.isDirectory() ? '/' : ''));
    }
    entries.sort();
  }
  return { entries };
}
function fsRead(b) {
  const acc = fsAccess(b.path, 'Read a file', b);
  if (acc.challenge) return acc.challenge;
  const f = acc.full;
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error('File not found: ' + b.path);
  if (BINARY.test(f)) throw new Error('Refusing to read a binary file');
  if (fs.statSync(f).size > 1e6) throw new Error('File is larger than 1 MB');
  return { content: fs.readFileSync(f, 'utf8') };
}
function fsWrite(b) {
  const f = safe(b.path);
  if (f === ROOT) throw new Error('Missing file path');
  // 3.13.6: b64 carries binary uploads (files dragged into the explorer). History is skipped
  // for these: file history stores UTF-8 text, and a lossy decode would corrupt the undo
  // record for binary files. Text writes keep the exact previous behaviour.
  if (b.b64 != null) {
    const bin = Buffer.from(String(b.b64), 'base64');
    if (bin.length > 5e6) throw new Error('File content is larger than the 5 MB write limit');
    if (!bin.length) throw new Error('The dropped file could not be decoded.');
    if (fs.existsSync(f) && !fs.statSync(f).isFile()) throw new Error('That path is a folder, not a file');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bin);
    invalidateCodeIndex('file write');
    return { bytes: bin.length };
  }
  const content = String(b.content ?? '');
  if (Buffer.byteLength(content) > 5e6) throw new Error('File content is larger than the 5 MB write limit');
  if (fs.existsSync(f)) { const st = fs.statSync(f); if (!st.isFile()) throw new Error('That path is a folder, not a file'); pushFileHistory(path.relative(ROOT, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  invalidateCodeIndex('file write');
  return { bytes: Buffer.byteLength(content) };
}
async function fsSearch(b) {
  const q = String(b.query || '').toLowerCase();
  if (!q) throw new Error('Empty query');
  const acc = fsAccess(b.path || '.', 'Search a folder', b);
  if (acc.challenge) return acc.challenge;
  const matches = []; let scanned = 0;
  const fsp = fs.promises;
  for (const f of walk(acc.full)) {
    if (BINARY.test(f.rel)) continue;
    if (++scanned > 400) { matches.push('…(stopped after 400 files)'); break; }
    if (fs.statSync(f.full).size > 1e6) continue;
    // Async read keeps the bridge responsive while scanning up to 400 files.
    (await fsp.readFile(f.full, 'utf8')).split('\n').forEach((line, i) => {
      if (matches.length < 60 && line.toLowerCase().includes(q)) matches.push(f.rel + ':' + (i + 1) + ': ' + line.trim().slice(0, 200));
    });
    if (matches.length >= 60) { matches.push('…(match limit reached)'); break; }
  }
  return { matches };
}

/* ---------- lightweight codebase intelligence index (symbols, imports, ranked search) ---------- */
const INDEXABLE = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|php|java|kt|kts|go|rs|cs|cpp|cc|c|h|hpp|rb|swift|vue|svelte|html|htm|css|scss|sass|less|sql|json|md|mdx|yaml|yml|toml|sh|bash|bat|ps1|xml|gradle|properties)$/i;
const INDEX_SECRET = /(^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx)(\/|$)/i;
const INDEX_SKIP_FILE = /\.(?:min|bundle)\.(?:js|css)$/i;
const INDEX_SECRET_LINE = /(?:(?:api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)\s*[:=]\s*['\"`][^'\"`\r\n]{8,}['\"`]|(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----))/i;
const INDEX_MAX_FILES = 2500;
const INDEX_MAX_FILE_BYTES = 1_000_000;
const INDEX_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const INDEX_MAX_LINES = 80000;
const INDEX_STOP = new Set(('a an the and or but if then else for to from in on of by with as at is are was were be been being do does did have has had can could should would will may might not no yes this that these those it its i we you they he she them our your their my me us what when where why how who which into out up down off over under more most less very use used using make made get got set new old file files code project workspace result results return true false null undefined const let var function class type interface enum async await promise string number object array import export default public private protected static final void int bool boolean return this self super extends implements package module require include import function function export async await await request response data error value values name path index search find get post put delete case switch try catch throw new while for each loop line lines other only all any some can read write edit update create test tests build check run debug log console print name thing things important'.split(/\s+/)));
let CODE_INDEX = { root: null, builtAt: 0, stale: true, building: false, files: [], lines: [], symbols: [], imports: [], stats: null, skipped: {} };
function invalidateCodeIndex(reason) { if (CODE_INDEX && CODE_INDEX.builtAt) { CODE_INDEX.stale = true; CODE_INDEX.staleReason = reason || 'workspace changed'; } }
function indexTokens(value) {
  const expanded = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return (expanded.match(/[A-Za-z_$][A-Za-z0-9_$.-]{1,}/g) || []).map(x => x.toLowerCase()).filter(x => x.length > 1 && !INDEX_STOP.has(x));
}
const INDEX_SYNONYMS = {
  auth: ['authentication', 'authorization', 'login', 'session', 'credential'], authentication: ['auth', 'login', 'session', 'credential'], authorization: ['auth', 'permission', 'access'],
  login: ['auth', 'authentication', 'signin', 'session'], signin: ['login', 'auth'], logout: ['signout', 'session', 'auth'], token: ['credential', 'jwt', 'session', 'bearer'], jwt: ['token', 'credential', 'auth'],
  api: ['endpoint', 'request', 'route', 'client'], endpoint: ['api', 'route', 'handler'], request: ['api', 'http', 'client'], response: ['api', 'http', 'handler'],
  database: ['db', 'sql', 'query', 'model', 'repository'], db: ['database', 'sql', 'query'], query: ['sql', 'database', 'repository'],
  ui: ['component', 'view', 'page', 'frontend'], frontend: ['ui', 'component', 'page', 'view'], backend: ['server', 'api', 'service', 'handler'],
  bug: ['error', 'exception', 'failure', 'issue'], error: ['exception', 'failure', 'bug'], test: ['spec', 'assert', 'validation'], tests: ['spec', 'assert', 'validation'],
  dependency: ['import', 'module', 'package', 'reference'], dependencies: ['import', 'module', 'package', 'reference'], reference: ['usage', 'call', 'dependency'], references: ['usage', 'calls'],
  config: ['settings', 'environment', 'option'], settings: ['config', 'option'], cache: ['memo', 'store', 'storage'], storage: ['store', 'persist', 'database'],
  route: ['endpoint', 'handler', 'navigation'], handler: ['endpoint', 'controller', 'callback'], component: ['ui', 'view', 'widget'],
  state: ['store', 'context', 'data'], memory: ['context', 'storage', 'store']
};
function expandedIndexTokens(query) {
  const out = new Map();
  for (const t of indexTokens(query)) {
    out.set(t, 1);
    for (const syn of INDEX_SYNONYMS[t] || []) if (!out.has(syn)) out.set(syn, 0.55);
  }
  return out;
}
function indexLanguage(rel) {
  const ext = path.extname(rel).toLowerCase();
  return ({ '.js':'javascript','.jsx':'javascript','.mjs':'javascript','.cjs':'javascript','.ts':'typescript','.tsx':'typescript','.py':'python','.php':'php','.java':'java','.kt':'kotlin','.kts':'kotlin','.go':'go','.rs':'rust','.cs':'csharp','.cpp':'cpp','.cc':'cpp','.c':'c','.h':'c','.hpp':'cpp','.rb':'ruby','.swift':'swift','.vue':'vue','.svelte':'svelte','.html':'html','.htm':'html','.css':'css','.scss':'scss','.sass':'scss','.less':'less','.sql':'sql','.json':'json','.md':'markdown','.mdx':'markdown','.yaml':'yaml','.yml':'yaml','.toml':'toml','.sh':'shell','.bash':'shell','.bat':'batch','.ps1':'powershell','.xml':'xml','.gradle':'gradle','.properties':'properties' })[ext] || 'text';
}
function extractIndexSymbol(line, lang) {
  let m;
  const checks = [
    ['function', /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/],
    ['class', /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
    ['type', /\b(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|trait|struct|record)\s+([A-Za-z_$][\w$]*)/],
    ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
    ['function', /\bfunction\s*&?\s*([A-Za-z_]\w*)\s*\(/],
    ['component', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|class\b)/],
    ['constant', /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/]
  ];
  for (const [kind, re] of checks) { m = line.match(re); if (m && m[1] && !['if','for','while','switch','catch','return','new','require','import'].includes(m[1])) return { name: m[1], kind }; }
  if (['java','kotlin','csharp','cpp','c','go','rust','swift'].includes(lang)) {
    m = line.match(/^\s*(?:(?:public|private|protected|static|async|override|virtual|export|default|final|inline|abstract|sealed|const|extern|unsafe)\s+)*[A-Za-z_$][\w<>?\[\].,:*& ]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|=>|$)/);
    if (m && m[1] && !['if','for','while','switch','catch','return','new','require','import'].includes(m[1])) return { name: m[1], kind: 'function' };
  }
  return null;
}
function extractIndexImport(line, lang) {
  const out = []; let m;
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/,
    /^\s*import\s+([A-Za-z0-9_.]+)\s*;?\s*$/,
    /^\s*use\s+([\\A-Za-z0-9_]+)\s*;/,
    /^\s*(?:include|require)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/i,
    /^\s*import\s+([A-Za-z0-9_.$]+)\s*;/,
    /^\s*(?:using|use)\s+([A-Za-z0-9_:.]+)\s*;/
  ];
  for (const re of patterns) { m = line.match(re); if (m && m[1]) { out.push(m[1]); break; } }
  return out;
}
function indexPathCandidates(importer, specifier) {
  const s = String(specifier || '').replace(/\\/g, '/');
  if (!s || s.startsWith('http:') || s.startsWith('https:') || s.startsWith('data:')) return [];
  let base;
  if (s.startsWith('./') || s.startsWith('../')) base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), s));
  else if (s.startsWith('@/')) base = path.posix.normalize(s.slice(2));
  else if (s.startsWith('~/')) base = path.posix.normalize(s.slice(2));
  else if (s.startsWith('src/')) base = path.posix.normalize(s);
  else if (/^[A-Za-z0-9_.]+$/.test(s) && (s.includes('.') || s.includes('_'))) base = path.posix.normalize(s.replace(/\./g, '/'));
  else return [];
  if (base.startsWith('../') || base === '..') return [];
  const exts = ['', '.js','.jsx','.mjs','.cjs','.ts','.tsx','.py','.php','.java','.json','.vue','.svelte','.css','.scss','.html'];
  const candidates = [];
  for (const ext of exts) candidates.push(base + ext);
  for (const ext of ['.js','.jsx','.ts','.tsx','.py','.php','.json','.vue','.svelte']) candidates.push(base.replace(/\/$/, '') + '/index' + ext, base.replace(/\/$/, '') + '/__init__' + ext);
  return [...new Set(candidates.map(x => x.replace(/^\.\//, '')))];
}
function buildCodeIndex() {
  if (!ROOT) throw new Error('No folder is open. Open a workspace before indexing the codebase.');
  if (CODE_INDEX.building) throw new Error('The codebase index is already building. Try again in a moment.');
  CODE_INDEX.building = true;
  try {
    const realRoot = fs.realpathSync(ROOT), files = [], lines = [], symbols = [], rawImports = [], skipped = { sensitive: 0, sensitiveLines: 0, unsupported: 0, tooLarge: 0, unreadable: 0, limits: 0, empty: 0 };
    let totalBytes = 0, totalLineCount = 0, complete = true;
    const candidates = walk(realRoot);
    for (const f of candidates) {
      const rel = f.rel.replace(/\\/g, '/');
      if (INDEX_SECRET.test(rel) || INDEX_SECRET.test('/' + rel)) { skipped.sensitive++; continue; }
      if (INDEX_SKIP_FILE.test(rel)) { skipped.unsupported++; continue; }
      if (!INDEXABLE.test(rel)) { skipped.unsupported++; continue; }
      if (files.length >= INDEX_MAX_FILES) { skipped.limits++; complete = false; break; }
      let st; try { st = fs.statSync(f.full); } catch { skipped.unreadable++; complete = false; continue; }
      if (st.size > INDEX_MAX_FILE_BYTES) { skipped.tooLarge++; complete = false; continue; }
      if (totalBytes + st.size > INDEX_MAX_TOTAL_BYTES) { skipped.limits++; complete = false; break; }
      let content; try { content = fs.readFileSync(f.full, 'utf8'); } catch { skipped.unreadable++; complete = false; continue; }
      if (content.includes('\0')) { skipped.unsupported++; continue; }
      const lang = indexLanguage(rel), sourceLines = content.split(/\r?\n/), fileTokens = new Set(indexTokens(rel));
      const doc = { path: rel, language: lang, size: st.size, mtimeMs: st.mtimeMs, lineCount: sourceLines.length, symbolNames: [], importSpecifiers: [], tokens: [] };
      let currentSymbol = '';
      for (let i = 0; i < sourceLines.length; i++) {
        const raw = sourceLines[i];
        // Avoid retaining obvious hard-coded credentials even when placed in an otherwise indexable source file.
        if (INDEX_SECRET_LINE.test(raw)) { skipped.sensitiveLines++; continue; }
        for (const t of indexTokens(raw)) fileTokens.add(t);
        const def = extractIndexSymbol(raw, lang);
        if (def) {
          currentSymbol = def.name; doc.symbolNames.push(def.name);
          symbols.push({ name: def.name, kind: def.kind, path: rel, line: i + 1, language: lang, exported: /\bexport\b|\bpublic\b/.test(raw), text: raw.trim().slice(0, 240), tokens: [...new Set(indexTokens(def.name))] });
        }
        for (const specifier of extractIndexImport(raw, lang)) {
          rawImports.push({ from: rel, line: i + 1, specifier, language: lang, text: raw.trim().slice(0, 200) });
          doc.importSpecifiers.push(specifier);
        }
        if (raw.trim() && lines.length < INDEX_MAX_LINES && raw.trim().length <= 1200) {
          lines.push({ path: rel, line: i + 1, text: raw.trim().slice(0, 280), symbol: currentSymbol, tokens: [...new Set(indexTokens(raw))] });
        } else if (raw.trim() && lines.length >= INDEX_MAX_LINES) { skipped.limits++; complete = false; }
        totalLineCount++;
      }
      doc.tokens = [...fileTokens]; files.push(doc); totalBytes += st.size;
    }
    const byPath = new Map(files.map(f => [f.path.toLowerCase(), f.path]));
    const imports = rawImports.map(im => {
      const candidates = indexPathCandidates(im.from, im.specifier); let to = null;
      for (const c of candidates) { const found = byPath.get(c.toLowerCase()); if (found) { to = found; break; } }
      // For Python-style absolute modules, try common source roots by suffix.
      if (!to && !im.specifier.startsWith('.') && im.specifier.includes('.')) {
        const suffix = im.specifier.replace(/\./g, '/').toLowerCase();
        const found = files.find(f => f.path.toLowerCase() === suffix || f.path.toLowerCase().endsWith('/' + suffix) || f.path.toLowerCase().startsWith(suffix + '.'));
        if (found) to = found.path;
      }
      return { ...im, to, external: !to };
    });
    const stats = { fileCount: files.length, symbolCount: symbols.length, importCount: imports.length, resolvedImportCount: imports.filter(x => x.to).length, indexedLines: lines.length, sourceLines: totalLineCount, totalBytes, complete, skipped };
    CODE_INDEX.root = realRoot; CODE_INDEX.builtAt = Date.now(); CODE_INDEX.stale = false; CODE_INDEX.staleReason = ''; CODE_INDEX.files = files; CODE_INDEX.lines = lines; CODE_INDEX.symbols = symbols; CODE_INDEX.imports = imports; CODE_INDEX.stats = stats; CODE_INDEX.skipped = skipped;
    return codeIndexStatus();
  } finally { CODE_INDEX.building = false; }
}
function codeIndexStatus() {
  return { indexed: !!CODE_INDEX.builtAt && CODE_INDEX.root === (ROOT ? fs.realpathSync(ROOT) : null), stale: !!CODE_INDEX.stale, building: !!CODE_INDEX.building, builtAt: CODE_INDEX.builtAt || null, root: CODE_INDEX.root, stats: CODE_INDEX.stats, staleReason: CODE_INDEX.staleReason || '' };
}
function ensureCodeIndex() {
  if (!ROOT) throw new Error('No folder is open. Open a workspace before searching the codebase.');
  const realRoot = fs.realpathSync(ROOT);
  // Build once per workspace. A stale index (files changed since the last build) is searched
  // as-is instead of rebuilding synchronously here: a full rebuild can take seconds on larger
  // projects and, running inside the request handler, used to block every other bridge call
  // (file reads, git status, terminal I/O) mid-turn. /index/rebuild refreshes it explicitly.
  if (!CODE_INDEX.builtAt || CODE_INDEX.root !== realRoot) buildCodeIndex();
  return CODE_INDEX;
}
function codeIndexSearch(b) {
  const q = String(b.query || '').trim(); if (q.length < 2) throw new Error('Enter at least 2 characters to search the codebase.');
  if (q.length > 240) throw new Error('Search query is too long (maximum 240 characters).');
  const idx = ensureCodeIndex(), qTokens = expandedIndexTokens(q), rawQ = q.toLowerCase(), limit = Math.min(Math.max(Number(b.limit) || 12, 1), 30), pathFilter = String(b.path || '').replace(/\\/g, '/').toLowerCase();
  const results = [];
  for (const line of idx.lines) {
    if (pathFilter && !line.path.toLowerCase().startsWith(pathFilter)) continue;
    let score = 0; const low = line.text.toLowerCase(), pathLow = line.path.toLowerCase(), lineTokens = new Set(line.tokens);
    for (const [t, weight] of qTokens) {
      if (lineTokens.has(t)) score += 2.2 * weight;
      if (pathLow.includes(t)) score += 3.0 * weight;
      if (line.symbol && indexTokens(line.symbol).includes(t)) score += 2.4 * weight;
    }
    if (low.includes(rawQ)) score += 5;
    if (score >= 1.6) results.push({ path: line.path, line: line.line, text: line.text, symbol: line.symbol, score: Math.round(score * 10) / 10, kind: 'code' });
  }
  for (const sym of idx.symbols) {
    if (pathFilter && !sym.path.toLowerCase().startsWith(pathFilter)) continue;
    let score = 0, name = sym.name.toLowerCase();
    for (const [t, weight] of qTokens) if (name.includes(t) || sym.tokens.includes(t)) score += 5 * weight;
    if (name === rawQ) score += 12;
    else if (rawQ.includes(name) && name.length > 2) score += 5;
    if (score > 0) results.push({ path: sym.path, line: sym.line, text: sym.text, symbol: sym.name, kind: sym.kind, score: Math.round(score * 10) / 10 });
  }
  results.sort((a, b2) => b2.score - a.score || a.path.localeCompare(b2.path) || a.line - b2.line);
  const dedup = new Set(), out = [];
  for (const r of results) { const key = r.path + ':' + r.line; if (dedup.has(key)) continue; dedup.add(key); out.push(r); if (out.length >= limit) break; }
  return { query: q, results: out, indexed: { fileCount: idx.stats.fileCount, symbolCount: idx.stats.symbolCount, complete: idx.stats.complete, stale: idx.stale, builtAt: idx.builtAt } };
}
function findCodeSymbols(b) {
  const q = String(b.query || b.symbol || '').trim(); if (!q) throw new Error('A symbol name or search term is required.');
  const idx = ensureCodeIndex(), tokens = indexTokens(q), low = q.toLowerCase();
  const ranked = idx.symbols.map(s => {
    const n = s.name.toLowerCase(); let score = n === low ? 30 : n.includes(low) || low.includes(n) ? 10 : 0;
    for (const t of tokens) if (s.tokens.includes(t) || n.includes(t)) score += 4;
    return { ...s, score };
  }).filter(s => s.score > 0).sort((a,b2)=>b2.score-a.score || a.path.localeCompare(b2.path)).slice(0, Math.min(Math.max(Number(b.limit)||20,1),40));
  return { query:q, symbols:ranked.map(({tokens,...s})=>s), indexed:{fileCount:idx.stats.fileCount,symbolCount:idx.stats.symbolCount,complete:idx.stats.complete} };
}
function codeSymbolReferences(b) {
  const q = String(b.symbol || b.query || '').trim(); if (!q || !/^[A-Za-z_$][\w$.-]{0,119}$/.test(q)) throw new Error('Enter a valid symbol identifier.');
  const idx = ensureCodeIndex(), low = q.toLowerCase(), definitions = idx.symbols.filter(s => s.name.toLowerCase() === low);
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '([^A-Za-z0-9_$]|$)','i');
  const refs = idx.lines.filter(l => re.test(l.text)).slice(0, Math.min(Math.max(Number(b.limit)||80,1),120)).map(l => ({path:l.path,line:l.line,text:l.text,symbol:l.symbol,definition:definitions.some(d=>d.path===l.path&&d.line===l.line)}));
  return { symbol:q, definitions:definitions.map(({tokens,...s})=>s), references:refs, truncated:idx.lines.some(l=>re.test(l.text)) && refs.length >= Math.min(Math.max(Number(b.limit)||80,1),120) };
}
function relatedCodeFiles(b) {
  const rel = String(b.path || '').replace(/\\/g,'/').replace(/^\.\//,''); if (!rel) throw new Error('A project-relative file path is required.');
  const idx = ensureCodeIndex(), file = idx.files.find(f => f.path.toLowerCase() === rel.toLowerCase());
  if (!file) throw new Error('File is not in the current code index: ' + rel);
  const outgoing = idx.imports.filter(x=>x.from===file.path).map(x=>({path:x.to||null,specifier:x.specifier,line:x.line,resolved:!!x.to}));
  const incoming = idx.imports.filter(x=>x.to===file.path).map(x=>({path:x.from,specifier:x.specifier,line:x.line,resolved:true}));
  const symbols = idx.symbols.filter(x=>x.path===file.path).map(({tokens,...s})=>s);
  return { path:file.path, language:file.language, symbols, imports:outgoing.slice(0,40), importedBy:incoming.slice(0,40), sameDirectory:idx.files.filter(f=>f.path!==file.path && path.posix.dirname(f.path)===path.posix.dirname(file.path)).slice(0,20).map(f=>f.path) };
}
function codeProjectMap() {
  const idx = ensureCodeIndex(), dirs = new Map();
  for (const f of idx.files) { const d = path.posix.dirname(f.path); dirs.set(d,(dirs.get(d)||0)+1); }
  const popular = [...idx.symbols].sort((a,b)=>Number(b.exported)-Number(a.exported)||a.name.localeCompare(b.name)).slice(0,50).map(({tokens,...s})=>s);
  return { root:idx.root, stats:idx.stats, topDirectories:[...dirs].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([path,count])=>({path,count})), symbols:popular };
}


/* ---------- skills ---------- */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/); const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!k) continue;
    let v = k[2].trim();
    if (/^[>|][+-]?$/.test(v)) { const parts = []; while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim()); v = parts.join(' '); }
    out[k[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}
const skillRoots = () => [{ scope: 'user', dir: SKILLS_USER }, ...(ROOT ? [{ scope: 'project', dir: skillsProject() }] : [])];
function listSkills() {
  const map = new Map();
  for (const { scope, dir } of skillRoots()) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const md = path.join(dir, e.name, 'SKILL.md');
      if (!e.isDirectory() || !fs.existsSync(md)) continue;
      const fm = parseFrontmatter(fs.readFileSync(md, 'utf8'));
      map.set(e.name, { name: e.name, description: fm.description || '', scope, dir: path.join(dir, e.name) });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function findSkill(name) {
  if (!VALID_NAME.test(String(name || ''))) throw new Error('Invalid skill name');
  const s = listSkills().find(x => x.name === name);
  if (!s) throw new Error('Skill not found: ' + name);
  return s;
}
function skillGet(b) {
  const s = findSkill(b.name);
  if (b.file) {
    const f = safe(b.file, s.dir);
    if (fs.statSync(f).size > 1e6) throw new Error('File is larger than 1 MB');
    return { content: fs.readFileSync(f, 'utf8'), dir: s.dir };
  }
  const files = [];
  for (const f of walk(s.dir)) { if (f.rel !== 'SKILL.md') files.push(f.rel); if (files.length >= 60) break; }
  return { name: s.name, dir: s.dir, content: fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), files };
}
function writeSkillFile(targetRoot, name, text) {
  if (!VALID_NAME.test(name)) throw new Error('Skill names may only use letters, numbers, dot, dash and underscore');
  const d = path.join(targetRoot, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), text);
  return name;
}

/* ---------- 3.13.4: no-git fallback for repository installs ----------
   When git is not installed (or git clone fails) a GitHub repository can still be
   fetched as a ZIP archive from codeload.github.com and unpacked with Node's built-in
   zlib — no dependencies, and nothing in the archive is ever executed. The extractor
   handles stored (0) and deflate (8) entries only, refuses path traversal (zip-slip),
   refuses symlinks, and enforces hard size/entry limits. */
const GH_ZIP_LIMITS = { maxArchive: 200e6, maxFile: 100e6, maxTotal: 400e6, maxEntries: 20000 };
function zipFindEOCD(buf) {
  const stop = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}
function unzipArchive(buf, destDir) {
  const eocd = zipFindEOCD(buf);
  if (eocd < 0) throw new Error('Unreadable archive (no ZIP central directory found)');
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (count < 1 || count > GH_ZIP_LIMITS.maxEntries) throw new Error('Unreadable archive (entry count out of range)');
  if (cdOff + cdSize > buf.length) throw new Error('Unreadable archive (bad central directory)');
  fs.mkdirSync(destDir, { recursive: true });
  let p = cdOff, total = 0, files = 0;
  for (let i = 0; i < count && p + 46 <= cdOff + cdSize; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (!name) continue;
    if (((attrs >> 16) & 0xf000) === 0xa000) continue;                  // symlink: never create
    const rel = path.normalize(name.replace(/\\/g, '/'));
    if (rel === '.' || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) continue; // zip-slip
    const dest = path.join(destDir, rel);
    if (!dest.startsWith(destDir + path.sep)) continue;
    if (name.endsWith('/') || (attrs & 0x10) !== 0) { fs.mkdirSync(dest, { recursive: true }); continue; }
    if (method !== 0 && method !== 8) continue;                        // only store/deflate
    if (csize === 0xffffffff) continue;                                // zip64 entry: skip (size caps below make this rare)
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) continue;
    let out = null;
    try { out = method === 0 ? buf.slice(start, start + csize) : zlib.inflateRawSync(buf.slice(start, start + csize)); } catch { continue; }
    total += out.length;
    if (total > GH_ZIP_LIMITS.maxTotal || out.length > GH_ZIP_LIMITS.maxFile) throw new Error('Repository archive is too large to unpack');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    files++;
  }
  if (!files) throw new Error('The archive contained no extractable files');
  return files;
}
async function ghRepoZip(url, repoDir, tmp) {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) throw new Error('Not a GitHub repository URL');
  const zipUrl = 'https://codeload.github.com/' + m[1] + '/' + m[2] + '/zip/HEAD';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(zipUrl, { signal: controller.signal });
    if (!r.ok) throw new Error('GitHub returned HTTP ' + r.status + ' for the repository archive');
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > GH_ZIP_LIMITS.maxArchive) throw new Error('Repository archive is empty or larger than 200 MB');
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Repository archive is not a ZIP');
    const stage = path.join(tmp, 'zipstage');
    const files = unzipArchive(buf, stage);
    /* codeload zips wrap everything in one top-level folder ("repo-<branch>") —
       copy its contents to where the git flow would have put the repo. */
    const tops = fs.readdirSync(stage).filter(x => !x.startsWith('.'));
    fs.cpSync(tops.length === 1 ? path.join(stage, tops[0]) : stage, repoDir, { recursive: true, force: true, filter: p => path.basename(p) !== '.git' });
    return { files, via: 'zip' };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('GitHub archive download timed out');
    throw e;
  } finally { clearTimeout(timer); }
}
/* Put the repository at <tmp>/repo: git clone --depth 1 when git exists, otherwise the
   codeload ZIP fallback for GitHub URLs. Returns which path was used. */
async function repoToDir(url, tmp) {
  const repo = path.join(tmp, 'repo');
  const isGh = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/i.test(url);
  let gitErr = null;
  if (GIT_OK) {
    const r = spawnSync('git', ['clone', '--depth', '1', '--', url, repo], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status === 0) return { via: 'git' };
    gitErr = 'git clone failed: ' + String(r.stderr || r.error || '').trim().slice(0, 300);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  } else {
    gitErr = 'git is not installed, so repositories cannot be cloned';
  }
  if (!isGh) throw new Error(gitErr);
  try {
    await ghRepoZip(url, repo, tmp);
    return { via: 'zip' };
  } catch (e) {
    throw new Error(gitErr + '; the GitHub archive fallback also failed: ' + e.message);
  }
}

async function skillInstall(b) {
  if (b.scope === 'project' && !ROOT) throw new Error('Open a folder first to install a project skill');
  const target = b.scope === 'project' ? skillsProject() : SKILLS_USER;
  fs.mkdirSync(target, { recursive: true });

  if (typeof b.content === 'string' && b.content.trim()) {
    const name = String(b.name || '').trim();
    let text = b.content;
    if (!/^---\r?\n/.test(text)) text = '---\nname: ' + name + '\ndescription: ' + name + '\n---\n\n' + text;
    return { installed: [writeSkillFile(target, name, text)] };
  }

  let src = String(b.source || '').trim();
  if (!src) throw new Error('Give a source (https URL, git repo, or owner/repo) or paste content');
  if (/^[\w.-]+\/[\w.-]+$/.test(src)) src = 'https://github.com/' + src;
  if (!/^https:\/\//i.test(src)) throw new Error('Source must be an https URL or owner/repo');
  const blob = src.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (blob) src = 'https://raw.githubusercontent.com/' + blob[1] + '/' + blob[2] + '/' + blob[3];

  if (/\.md(\?|$)/i.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error('Download failed: ' + r.status);
    const text = await r.text();
    if (text.length > 1e6) throw new Error('File is larger than 1 MB');
    const name = String(b.name || '').trim() || String(parseFrontmatter(text).name || '').replace(/[^A-Za-z0-9._-]/g, '-');
    return { installed: [writeSkillFile(target, name, text)] };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-'));
  try {
    const { via } = await repoToDir(src, tmp);   /* 3.13.4: git when present, ZIP fallback otherwise */
    const repo = path.join(tmp, 'repo');
    const installed = [];
    const repoName = path.basename(src).replace(/\.git$/, '');
    const found = [];
    (function find(dir, depth) {
      if (depth > 4) return;
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) found.push(dir);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') find(path.join(dir, e.name), depth + 1);
      }
    })(repo, 0);
    for (const dir of found) {
      if (installed.length >= 30) break;
      const name = dir === repo ? repoName : path.basename(dir);
      if (b.name && b.name !== name) continue;
      if (!VALID_NAME.test(name)) continue;
      fs.cpSync(dir, path.join(target, name), { recursive: true, force: true, filter: p => path.basename(p) !== '.git' });
      installed.push(name);
    }
    if (!installed.length) throw new Error('No SKILL.md found in that repository' + (b.name ? ' for "' + b.name + '"' : ''));
    return { installed, via };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function skillRemove(b) {
  const s = findSkill(b.name);
  fs.rmSync(s.dir, { recursive: true, force: true });
  return { removed: s.name };
}

/* ---------- browser (Chrome DevTools Protocol, no dependencies) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const c = [];
  if (CHROME_FLAG) c.push(CHROME_FLAG);
  if (process.env.CHROME_PATH) c.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    c.push(pf + '\\Google\\Chrome\\Application\\chrome.exe', pf86 + '\\Google\\Chrome\\Application\\chrome.exe', la + '\\Google\\Chrome\\Application\\chrome.exe',
      pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe', pf + '\\Microsoft\\Edge\\Application\\msedge.exe');
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const r = spawnSync('which', [n], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) c.push(r.stdout.trim());
    }
  }
  return c.find(p => p && fs.existsSync(p)) || null;
}
const CHROME = findChrome();

/* ---------- Chat Z.ai guest-session bridge ---------- */
let chatZaiChild = null, chatZaiStarting = null, chatZaiError = '', chatZaiModels = [];
/* 3.13.19: session token harvested automatically from chat.z.ai inside CodeSpace's Integrated
   Browser and pushed by the renderer. Kept in memory only (never written to disk or logs) and
   handed to the bridge process on start, or live via IPC while it is already running. */
let chatZaiToken = '';
const DESKTOP_HOST = process.env.MY_AGENT_DISABLE_EXTERNAL_BROWSER === '1';
const CHAT_ZAI_PORT = 9876;
function chatZaiStatus() {
  const running = !!(chatZaiChild && chatZaiChild.exitCode === null && !chatZaiChild.killed);
  return { running, ready: running && chatZaiModels.length > 0, baseUrl: 'http://127.0.0.1:' + CHAT_ZAI_PORT + '/v1', models: chatZaiModels.slice(), error: chatZaiError, sessionCaptured: !!chatZaiToken };
}
/* 3.13.19: accept a chat.z.ai session token from the renderer. The value must look like the
   site's JWT (three dot-separated base64url parts) and is length-capped. It is only echoed back
   as a boolean, never returned to any caller. */
function chatZaiSetToken(token) {
  const tok = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(tok) || tok.length < 40 || tok.length > 2000) return { ok: false, error: 'That value does not look like a chat.z.ai session token.' };
  const changed = tok !== chatZaiToken;
  chatZaiToken = tok;
  if (changed && chatZaiChild && chatZaiChild.exitCode === null) {
    try { chatZaiChild.send({ type: 'session-token', token: tok }); } catch {}
  }
  return { ok: true, sessionCaptured: true, running: !!(chatZaiChild && chatZaiChild.exitCode === null) };
}
async function chatZaiStop() {
  const child = chatZaiChild;
  chatZaiChild = null;
  if (child && child.exitCode === null) {
    try { child.kill(); } catch {}
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2500))]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }
  chatZaiModels = [];
  chatZaiError = '';
  return chatZaiStatus();
}
function chatZaiStart() {
  if (chatZaiStarting) return chatZaiStarting;
  if (chatZaiChild && chatZaiChild.exitCode === null && chatZaiModels.length) return Promise.resolve(chatZaiStatus());
  if (!CHROME) return Promise.reject(new Error('Chat Z.ai needs Google Chrome or Microsoft Edge. Install one, restart CodeSpace, and try again.'));
  const puppeteerPath = path.join(__dirname, 'node_modules', 'puppeteer-core');
  if (!fs.existsSync(puppeteerPath)) return Promise.reject(new Error('The Chat Z.ai browser dependency is not installed. Run npm install in the CodeSpace folder, then restart it.'));
  const script = path.join(__dirname, 'chat-zai-proxy.js');
  if (!fs.existsSync(script)) return Promise.reject(new Error('chat-zai-proxy.js is missing from the CodeSpace package.'));
  chatZaiError = '';
  chatZaiModels = [];
  chatZaiStarting = new Promise((resolve, reject) => {
    let settled = false, output = '';
    const child = spawn(process.execPath, [script], {
      cwd: __dirname,
      env: { ...process.env,
        CHROME_PATH: CHROME,
        CODESPACE_CHAT_ZAI_PORT: String(CHAT_ZAI_PORT),
        CODESPACE_CHAT_ZAI_TOKEN: TOKEN,
        CODESPACE_CHAT_ZAI_PROFILE_DIR: path.join(DATA, 'chat-zai-browser-profile'),
        /* 3.13.19: desktop hosts the sign-in inside CodeSpace's Integrated Browser and passes the
           harvested token below, so the bridge Chrome runs headless (no external window). */
        ...(chatZaiToken ? { CODESPACE_CHAT_ZAI_SESSION_TOKEN: chatZaiToken } : {}),
        ...(DESKTOP_HOST && !process.env.CODESPACE_CHAT_ZAI_HEADLESS ? { CODESPACE_CHAT_ZAI_HEADLESS: '1', CODESPACE_CHAT_ZAI_LOGIN_WAIT_MS: '45000' } : {})
      },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    chatZaiChild = child;
    const append = chunk => { output = (output + String(chunk || '')).slice(-5000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const finishError = error => {
      if (settled) return;
      settled = true;
      chatZaiError = String(error && error.message || error || output || 'The Chat Z.ai adapter failed to start.').slice(0, 1200);
      if (chatZaiChild === child) chatZaiChild = null;
      chatZaiModels = [];
      try { child.kill(); } catch {}
      reject(new Error(chatZaiError));
    };
    const timer = setTimeout(() => finishError(new Error('Chat Z.ai did not become ready within 190 seconds. If this is the first launch, sign in in the Chat Z.ai browser window and switch Chat Z.ai ON again. ' + output.slice(-900))), 190000);
    child.on('message', msg => {
      if (!msg || settled) return;
      if (msg.type === 'error') { clearTimeout(timer); finishError(new Error(msg.error || 'Chat Z.ai failed during startup.')); }
      if (msg.type === 'ready') {
        chatZaiModels = Array.isArray(msg.models) ? msg.models.map(String).filter(Boolean) : [];
        if (!chatZaiModels.length) { clearTimeout(timer); return finishError(new Error('Chat Z.ai started but did not return any models.')); }
        settled = true; clearTimeout(timer); chatZaiError = '';
        resolve(chatZaiStatus());
      }
    });
    child.on('error', error => { clearTimeout(timer); finishError(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (chatZaiChild === child) chatZaiChild = null;
      if (settled && code !== 0 && !signal) { chatZaiModels = []; chatZaiError = (output || 'Chat Z.ai bridge stopped unexpectedly.').slice(-1200); }
      if (!settled) finishError(new Error('Chat Z.ai bridge exited before becoming ready (' + (signal || code) + '). ' + output.slice(-900)));
    });
  }).finally(() => { chatZaiStarting = null; });
  return chatZaiStarting;
}

/* minimal WebSocket client (RFC 6455), enough for talking to Chrome */
function wsOpen(urlStr, onText, onClose) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    req.on('response', () => reject(new Error('Browser refused the WebSocket connection')));
    req.on('error', reject);
    req.on('upgrade', (res, socket, head) => {
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let frags = [];
      const sendFrame = (op, payload) => {
        const len = payload.length; let hdr;
        if (len < 126) hdr = Buffer.alloc(2);
        else if (len < 65536) { hdr = Buffer.alloc(4); hdr.writeUInt16BE(len, 2); }
        else { hdr = Buffer.alloc(10); hdr.writeBigUInt64BE(BigInt(len), 2); }
        hdr[0] = 0x80 | op; hdr[1] = 0x80 | (len < 126 ? len : len < 65536 ? 126 : 127);
        const mask = crypto.randomBytes(4), body = Buffer.alloc(len);
        for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
        socket.write(Buffer.concat([hdr, mask, body]));
      };
      const parse = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (masked) off += 4;
          if (buf.length < off + len) return;
          let payload = buf.subarray(off, off + len);
          if (masked) { const m = buf.subarray(off - 4, off); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3])); }
          buf = buf.subarray(off + len);
          if (op === 8) { socket.end(); return; }
          if (op === 9) { sendFrame(10, Buffer.from(payload)); continue; }
          if (op === 10) continue;
          frags.push(Buffer.from(payload));
          if (fin) { const msg = Buffer.concat(frags).toString('utf8'); frags = []; onText(msg); }
        }
      };
      socket.on('data', c => { buf = Buffer.concat([buf, c]); parse(); });
      socket.on('close', () => onClose());
      socket.on('error', () => {});
      if (buf.length) parse();
      resolve({ send: t => sendFrame(1, Buffer.from(t, 'utf8')), close: () => { try { socket.destroy(); } catch {} } });
    });
    req.end();
  });
}

async function cdpConnect(wsUrl, onEvent, onGone) {
  const pending = new Map(); let nextId = 1;
  const state = { closed: false };
  const sock = await wsOpen(wsUrl, text => {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result || {});
    } else if (m.method) onEvent(m);
  }, () => {
    state.closed = true;
    pending.forEach(p => { clearTimeout(p.t); p.rej(new Error('Browser connection closed')); });
    pending.clear(); onGone();
  });
  return {
    state,
    send(method, params = {}, timeout = 15000) {
      return new Promise((res, rej) => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); rej(new Error('Browser did not answer ' + method)); }, timeout);
        pending.set(id, { res, rej, t });
        try { sock.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(t); pending.delete(id); rej(e); }
      });
    },
    close: () => sock.close()
  };
}

const RM_DIRS = new Set();
const BR = { proc: null, dir: '', cdp: null, logs: [], waiters: [], starting: null, mouse: null, persist: false, visible: false, latestFrame: null, frameClients: new Set(), screencastOn: false, viewport: { width: 1280, height: 800, mobile: false }, networkEnabled: false, requests: [], requestsById: new Map() };
const pushLog = s => { BR.logs.push(String(s).slice(0, 400)); if (BR.logs.length > 500) BR.logs.splice(0, 250); };
const logsSince = m => BR.logs.slice(m).slice(-20);
const waitLoad = ms => new Promise(res => { const t = setTimeout(res, ms); BR.waiters.push(() => { clearTimeout(t); res(); }); });

function brReset() {
  const dir = BR.dir, proc = BR.proc, keep = BR.persist;
  BR.cdp = null; BR.proc = null; BR.dir = '';
  if (!dir || keep) return;
  RM_DIRS.add(dir);
  const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); RM_DIRS.delete(dir); } catch {} };
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.once('exit', () => setTimeout(rm, 200)); else rm();
}
async function closeBrowserGraceful() { // lets a browser with a saved profile write its cookies to disk before quitting
  const proc = BR.proc;
  try { if (BR.cdp) BR.cdp.close(); } catch {}
  if (proc && BR.persist) {
    try { const c = await cdpConnect(BR.wsUrl, () => {}, () => {}); await c.send('Browser.close', {}, 3000).catch(() => {}); c.close(); } catch {}
    for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(150);
    if (proc.exitCode === null && proc.signalCode === null) { killTree(proc, true); await sleep(500); }
  }
  closeBrowser();
}
function closeBrowser() {
  try { if (BR.cdp) BR.cdp.close(); } catch {}
  try { if (BR.proc) killTree(BR.proc); } catch {}
  brReset();
}
function sendSse(res, data) { try { if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch {} }
function brEvent(m) {
  const p = m.params || {};
  if (m.method === 'Runtime.consoleAPICalled') {
    pushLog((p.type === 'log' ? '' : p.type + ': ') + (p.args || []).map(a => a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.type)).join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    pushLog('error: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception'));
  } else if (m.method === 'Log.entryAdded') {
    pushLog(p.entry.level + ': ' + p.entry.text + (p.entry.url ? ' (' + p.entry.url + ')' : ''));
  } else if (m.method === 'Network.requestWillBeSent') {
    const row = { id: String(p.requestId), time: Date.now(), method: (p.request && p.request.method) || 'GET', url: String((p.request && p.request.url) || '').slice(0, 1500), type: p.type || '', status: null, durationMs: null, error: '' };
    BR.requestsById.set(row.id, row); BR.requests.push(row); if (BR.requests.length > 500) BR.requests.splice(0, BR.requests.length - 400); if (BR.requestsById.size > 1000) { const oldest = BR.requestsById.keys().next().value; if (oldest !== undefined) BR.requestsById.delete(oldest); }
  } else if (m.method === 'Network.responseReceived') {
    const row = BR.requestsById.get(String(p.requestId)); if (row) { row.status = p.response && p.response.status; row.mimeType = p.response && p.response.mimeType; row.fromCache = !!(p.response && p.response.fromDiskCache); row.responseTime = Date.now(); row.durationMs = row.responseTime - row.time; }
  } else if (m.method === 'Network.loadingFailed') {
    const row = BR.requestsById.get(String(p.requestId)); if (row) { row.error = String(p.errorText || 'Request failed').slice(0, 240); row.durationMs = Date.now() - row.time; }
  } else if (m.method === 'Page.screencastFrame') {
    BR.latestFrame = { type: 'frame', image: 'data:image/jpeg;base64,' + p.data, metadata: p.metadata || {}, time: Date.now() };
    for (const client of BR.frameClients) sendSse(client, BR.latestFrame);
    if (BR.cdp && p.sessionId !== undefined) BR.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  } else if (m.method === 'Page.loadEventFired') {
    BR.waiters.splice(0).forEach(f => f());
  } else if (m.method === 'Page.javascriptDialogOpening') {
    pushLog('dialog: ' + p.message);
    if (BR.cdp) BR.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  }
}
async function launchBrowser(opts = {}) {
  if (!CHROME) throw new Error('Chrome, Edge or Chromium was not found. Install one, or start the bridge with --chrome "full path to the program".');
  BR.visible = opts.visible !== undefined ? !!opts.visible : SHOW_BROWSER;
  BR.persist = !!opts.persist;
  if (BR.persist) { BR.dir = path.join(DATA, 'browser-profile'); fs.mkdirSync(BR.dir, { recursive: true }); }
  else BR.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  // Keep the browser profile persistent when requested, but avoid disabling ordinary
  // browser networking/extensions: those changes can interfere with site behavior.
  // We do not spoof a headless browser's user-agent or timezone.
  const args = ['--remote-debugging-port=0', '--user-data-dir=' + BR.dir, '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', '--window-size=1280,800'];
  if (!BR.visible) args.unshift('--headless=new');
  if ((typeof process.getuid === 'function' && process.getuid() === 0) || process.env.CODESPACE_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  args.push('about:blank');
  try {
    const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: !WIN });
    BR.proc = proc;
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('The browser did not start in time')), 25000);
      proc.stderr.on('data', c => { buf += c.toString(); const m = buf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/\S+)/); if (m) { clearTimeout(t); BR.wsUrl = m[1]; resolve(Number(m[2])); } });
      proc.on('error', e => { clearTimeout(t); reject(e); });
      proc.on('exit', () => { clearTimeout(t); reject(new Error('The browser exited right after starting')); BR.cdp = null; });
    });
    let target = null;
    for (let i = 0; i < 20 && !target; i++) {
      try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'); } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('The browser started but has no page to control');
    BR.cdp = await cdpConnect(target.webSocketDebuggerUrl, brEvent, () => { BR.cdp = null; });
    await BR.cdp.send('Page.enable'); await BR.cdp.send('Runtime.enable'); await BR.cdp.send('Log.enable');
    await BR.cdp.send('Network.enable', { maxTotalBufferSize: 10000000, maxResourceBufferSize: 1000000 }); BR.networkEnabled = true;
    // Keep normal browser identity/settings. Only set a desktop viewport for hidden mode;
    // never rewrite the user-agent or timezone to make automation look different.
    if (!BR.visible) await BR.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  } catch (e) { closeBrowser(); throw e; }
}
async function ensureBrowser(opts) {
  if (process.env.MY_AGENT_DISABLE_EXTERNAL_BROWSER === '1') {
    throw new Error('External Chrome process is disabled in CodeSpace Desktop. Use the embedded Browser panel.');
  }
  if (BR.cdp && !BR.cdp.state.closed) {
    const wantV = opts && opts.visible !== undefined ? !!opts.visible : BR.visible, wantP = opts && opts.persist !== undefined ? !!opts.persist : BR.persist;
    if (wantV === BR.visible && wantP === BR.persist) return;
    await closeBrowserGraceful(); await sleep(500); // the mode changed, so start again
  }
  if (!BR.starting) BR.starting = launchBrowser(opts || {}).finally(() => { BR.starting = null; });
  await BR.starting;
}
async function brEval(expression) {
  const r = await BR.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, 20000);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || 'Script error');
  }
  return r.result ? r.result.value : undefined;
}
async function brInfo() {
  try {
    return await brEval('({url:location.href,title:document.title,vw:innerWidth,vh:innerHeight,challenge:/just a moment|attention required|verify you are human|checking your browser|security verification|are you a robot/i.test(document.title+" "+(document.body?document.body.innerText.slice(0,600):""))||!!document.querySelector("#challenge-form,.cf-turnstile,#cf-challenge-running,iframe[src*=\\"challenges.cloudflare.com\\"]")})');
  }
  catch { return { url: '', title: '', vw: 1280, vh: 800 }; }
}
const isLocalUrl = u => {
  try { const x = new URL(u); return x.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(x.hostname) || x.hostname.endsWith('.localhost'); }
  catch { return false; }
};
function resolveUrl(input) {
  const u = String(input || '').trim();
  if (!u) throw new Error('Missing URL');
  if (/^https?:\/\//i.test(u)) return { url: u, local: isLocalUrl(u) };
  if (/^file:\/\//i.test(u)) return { url: pathToFileURL(safe(fileURLToPath(u))).href, local: true };
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return { url: 'http://' + u, local: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) throw new Error('Only http, https and workspace file URLs are allowed');
  const f = safe(u);
  if (fs.existsSync(f)) return { url: pathToFileURL(f).href, local: true };
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)) return { url: 'https://' + u, local: false };
  throw new Error('File not found in the workspace: ' + u);
}
async function externalCheck(b, what) {
  const cur = (await brInfo()).url;
  if (cur && cur !== 'about:blank' && !isLocalUrl(cur)) {
    const g = permGuard('browser', 'The browser page is on an external website:\n' + cur + '\n\n' + what, b);
    if (g) return g;
  }
  return null;
}

async function browserOpen(b) {
  const { url, local } = resolveUrl(b.url);
  await ensureBrowser({ visible: b.visible, persist: b.persist });
  const m = BR.logs.length;
  const requestStart = BR.requests.length;
  // Navigate the existing top-level tab. Capture the resulting URL and network
  // failures so Chromium's internal chrome-error page is never mistaken for a site.
  const loaded = waitLoad(20000);
  const r = await BR.cdp.send('Page.navigate', { url });
  if (r.errorText) throw new Error('Could not open ' + url + ': ' + r.errorText + (/REFUSED/.test(r.errorText) ? ' (is your dev server running?)' : ''));
  await loaded;
  // Some network failures render chrome-error://chromewebdata/ without a useful
  // Page.navigate error. Give Chromium a moment to publish Network.loadingFailed.
  await sleep(700);
  const info = await brInfo();
  const recentRequests = BR.requests.slice(requestStart);
  const failures = recentRequests.filter(x => x.error).slice(-8).map(x => ({ url: x.url, error: x.error, type: x.type }));
  if (/^chrome-error:\/\/chromewebdata\/?$/i.test(info.url || '')) {
    const detail = failures.map(x => x.error + (x.url ? ' — ' + x.url : '')).join('\n');
    const message = detail
      ? 'Chromium could not load ' + url + '. Network failure(s):\n' + detail
      : 'Chromium could not load ' + url + ' and displayed its internal error page. Check DNS, internet connection, TLS/certificate errors, and whether the site is reachable from this network.';
    pushLog(message);
    return { ...info, failed: true, requestedUrl: url, error: message, failures, console: logsSince(m) };
  }
  return { ...info, requestedUrl: url, failures, console: logsSince(m) };
}
async function browserShot(b) {
  if (!BR.cdp || BR.cdp.state.closed) { if (b.ifRunning) return { running: false }; await ensureBrowser(); }
  const params = { format: 'jpeg', quality: Math.min(Math.max(Number(b.quality) || 60, 20), 90) };
  if (b.fullPage) {
    const lm = await BR.cdp.send('Page.getLayoutMetrics'); const cs = lm.cssContentSize || lm.contentSize;
    params.captureBeyondViewport = true; params.clip = { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 8000), scale: 1 };
  }
  const r = await BR.cdp.send('Page.captureScreenshot', params, 30000);
  return { running: true, image: 'data:image/jpeg;base64,' + r.data, ...(await brInfo()) };
}
async function browserStreamStart() {
  await ensureBrowser();
  if (!BR.screencastOn) { await BR.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 2 }); BR.screencastOn = true; }
  return { started: true, viewport: BR.viewport };
}
async function browserStreamStop() {
  BR.frameClients.clear();
  if (BR.cdp && BR.screencastOn) { try { await BR.cdp.send('Page.stopScreencast'); } catch {} }
  BR.screencastOn = false; BR.latestFrame = null; return { stopped: true };
}
async function browserViewport(b) {
  await ensureBrowser();
  const width = Math.min(2560, Math.max(320, Math.trunc(Number(b.width) || 1280)));
  const height = Math.min(2000, Math.max(240, Math.trunc(Number(b.height) || 800)));
  const mobile = !!b.mobile;
  if (b.reset) { await BR.cdp.send('Emulation.clearDeviceMetricsOverride'); await BR.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await BR.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); BR.viewport = { width: 1280, height: 800, mobile: false }; }
  else { await BR.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }); await BR.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 1 : 0 }); BR.viewport = { width, height, mobile }; }
  return { viewport: BR.viewport, ...(await brInfo()) };
}
async function browserDiagnostics() {
  // 3.11: a missing browser is a structured, reportable state — not an unhandled error.
  if (!CHROME && !BRIDGE.ever && !BR.cdp) {
    return { available: false, running: false, url: '', title: '', reason: 'Chrome, Edge or Chromium was not found. Install one, or start the bridge with --chrome "full path to the program". Browser automation tools will fail until a browser is available.', console: BR.logs.slice(-20), requests: [] };
  }
  await ensureBrowser();
  if (!BR.networkEnabled) { await BR.cdp.send('Network.enable', { maxTotalBufferSize: 10000000, maxResourceBufferSize: 1000000 }).catch(() => {}); BR.networkEnabled = true; }
  return { available: true, console: BR.logs.slice(-100), requests: BR.requests.slice(-150).map(r => ({ time: r.time, method: r.method, url: r.url, type: r.type, status: r.status, durationMs: r.durationMs, error: r.error, fromCache: r.fromCache, mimeType: r.mimeType })), ...(await brInfo()) };
}
const READ_FN = function () {
  const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      let s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      const p = el.parentElement;
      if (p) { const same = [...p.children].filter(c => c.tagName === el.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'; }
      parts.unshift(s); el = p;
    }
    return parts.join(' > ');
  };
  const els = [];
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[onclick]')) {
    if (els.length >= 60) break;
    if (!vis(el)) continue;
    els.push({ selector: sel(el), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      href: el.getAttribute('href') || '' });
  }
  return { url: location.href, title: document.title, vw: innerWidth, vh: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight,
    text: (document.body ? document.body.innerText : '').slice(0, 5000), elements: els };
};
const READ_JS = '(' + READ_FN.toString() + ')()';
async function browserRead() {
  await ensureBrowser();
  const v = await brEval(READ_JS), info = await brInfo();
  return { ...v, challenge: info.challenge, console: BR.logs.splice(0).slice(-20) };
}
/* 3.11: browser input validation helpers — bounded selectors/text/code, workspace-limited files */
const selStr = (s, what, max = 300) => {
  const v = String(s ?? '').trim();
  if (!v) throw new Error('Missing ' + what);
  if (v.length > max) throw new Error(what.slice(0, 1).toUpperCase() + what.slice(1) + ' is too long (max ' + max + ' characters)');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error(what.slice(0, 1).toUpperCase() + what.slice(1) + ' contains control characters');
  return v;
};
async function browserEval(b) {
  await ensureBrowser();
  const code = String(b.code || '');
  if (!code.trim()) throw new Error('Missing code');
  if (code.length > 100000) throw new Error('Code is too long (100 KB limit)');
  const m = BR.logs.length; let value;
  try { value = await brEval('(async () => (\n' + code.trim().replace(/;+\s*$/, '') + '\n))()'); }
  catch (e) {
    if (/^SyntaxError/.test(e.message)) value = await brEval('(async () => {\n' + code + '\n})()');
    else throw e;
  }
  const text = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { result: text.slice(0, 20000), console: logsSince(m) };
}
const rnd = (a, b) => a + Math.random() * (b - a);
async function humanMove(x, y) {
  const from = BR.mouse || { x: rnd(80, 400), y: rnd(80, 300) };
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(6, Math.min(28, Math.round(dist / 35)));
  const cx = (from.x + x) / 2 + rnd(-60, 60), cy = (from.y + y) / 2 + rnd(-40, 40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    await BR.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: u * u * from.x + 2 * u * t * cx + t * t * x, y: u * u * from.y + 2 * u * t * cy + t * t * y });
    await sleep(rnd(5, 14));
  }
  BR.mouse = { x, y };
}
async function pointerClick(x, y, human) {
  const base = { x, y, button: 'left', clickCount: 1 };
  if (human) { await humanMove(x, y); await sleep(rnd(60, 160)); }
  else await BR.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await BR.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
  if (human) await sleep(rnd(45, 110));
  await BR.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  BR.mouse = { x, y };
}
async function browserClick(b) {
  await ensureBrowser();
  const need = await externalCheck(b, 'Click: ' + (b.selector || 'x=' + b.x + ', y=' + b.y));
  if (need) return need;
  const human = b.human !== false;
  let x = b.x, y = b.y;
  if (b.selector) {
    const pt = await brEval('(()=>{const el=document.querySelector(' + JSON.stringify(String(b.selector)) + ');if(!el)return null;el.scrollIntoView({block:"center",inline:"center",behavior:' + (human ? '"smooth"' : '"auto"') + '});return true;})()');
    if (!pt) throw new Error('No element matches selector: ' + b.selector);
    if (human) await sleep(450);
    const r = await brEval('(()=>{const r=document.querySelector(' + JSON.stringify(String(b.selector)) + ').getBoundingClientRect();return {x:r.left+r.width*(0.35+Math.random()*0.3),y:r.top+r.height*(0.35+Math.random()*0.3)};})()');
    x = r.x; y = r.y;
  }
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('Give a selector, or x and y');
  const m = BR.logs.length;
  await pointerClick(x, y, human);
  await sleep(human ? rnd(500, 900) : 600);
  return { ...(await brInfo()), console: logsSince(m) };
}
async function keyChar(ch) {
  const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : undefined;
  const vk = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : undefined;
  await BR.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
  await BR.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
}
async function pressEnter() {
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await BR.cdp.send('Input.dispatchKeyEvent', { ...k, type: 'keyDown', text: '\r' });
  await BR.cdp.send('Input.dispatchKeyEvent', { ...k, type: 'keyUp' });
}
async function browserType(b) {
  await ensureBrowser();
  const need = await externalCheck(b, 'Type into: ' + b.selector);
  if (need) return need;
  const human = b.human !== false, sel = JSON.stringify(String(b.selector || ''));
  const ok = await brEval('(()=>{const el=document.querySelector(' + sel + ');if(!el)return false;el.scrollIntoView({block:"center",behavior:' + (human ? '"smooth"' : '"auto"') + '});return true;})()');
  if (!ok) throw new Error('No element matches selector: ' + b.selector);
  if (human) {
    await sleep(450);
    const r = await brEval('(()=>{const r=document.querySelector(' + sel + ').getBoundingClientRect();return {x:r.left+Math.min(r.width-4,20+Math.random()*60),y:r.top+r.height/2};})()');
    await pointerClick(r.x, r.y, true); await sleep(rnd(120, 300));
  }
  await brEval('(()=>{const el=document.querySelector(' + sel + ');el.focus();' + (b.clear ? 'if(el.select)el.select();else document.execCommand("selectAll");' : '') + 'return true;})()');
  const m = BR.logs.length, text = String(b.text || '');
  if (text) {
    if (!human || text.length > 150) await BR.cdp.send('Input.insertText', { text });
    else for (const ch of text) {
      if (ch === '\n') await pressEnter(); else await keyChar(ch);
      await sleep(rnd(35, 110) + (/[\s.,!?]/.test(ch) && Math.random() < 0.25 ? rnd(120, 260) : 0));
    }
  }
  if (b.submit) { if (human) await sleep(rnd(150, 350)); await pressEnter(); }
  await sleep(human ? rnd(500, 800) : 500);
  return { ...(await brInfo()), console: logsSince(m) };
}
const SPECIAL_KEYS = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
const KEY_MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
async function browserKey(b) { // keys typed by the user into the preview
  await ensureBrowser();
  if (typeof b.insert === 'string' && b.insert) { await BR.cdp.send('Input.insertText', { text: b.insert.slice(0, 20000) }); return {}; }
  let modifiers = 0;
  for (const m of ['alt', 'ctrl', 'meta', 'shift']) if (b[m]) modifiers |= KEY_MODIFIERS[m];
  const keyName = String(b.key || '');
  if (keyName && SPECIAL_KEYS[keyName]) {
    const vk = SPECIAL_KEYS[keyName];
    if (keyName === 'Enter' && !modifiers) { await pressEnter(); return {}; }
    const base = { key: keyName === 'Space' ? ' ' : keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await BR.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown', text: keyName === 'Space' ? ' ' : undefined });
    await BR.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    return {};
  }
  if (typeof b.text === 'string' && b.text.length === 1) { await keyChar(b.text); return {}; }
  throw new Error('Unsupported key');
}
async function browserScroll(b) {
  await ensureBrowser();
  const x = Number(b.x) || 200, y = Number(b.y) || 200;
  let dy = Number(b.dy) || 0;
  if (b.to === 'top') dy = -1e6; else if (b.to === 'bottom') dy = 1e6;
  const human = b.human !== false, big = Math.abs(dy) > 5000;
  if (big) { await brEval('window.scrollTo({top:' + (dy < 0 ? 0 : 'document.documentElement.scrollHeight') + ',behavior:' + (human ? '"smooth"' : '"auto"') + '})'); await sleep(human ? 700 : 150); return {}; }
  const n = human ? Math.max(1, Math.ceil(Math.abs(dy) / 90)) : 1, step = dy / n;
  for (let i = 0; i < n; i++) { await BR.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: step }); if (human) await sleep(rnd(14, 32)); }
  if (human) await sleep(150);
  return {};
}
async function browserNav(b) {
  await ensureBrowser();
  const loaded = waitLoad(8000);
  if (b.action === 'reload') await BR.cdp.send('Page.reload');
  else {
    const h = await BR.cdp.send('Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + (b.action === 'back' ? -1 : 1)];
    if (!e) return brInfo();
    await BR.cdp.send('Page.navigateToHistoryEntry', { entryId: e.id });
  }
  await loaded; await sleep(300);
  return brInfo();
}
process.on('exit', () => {
  try { if (chatZaiChild) chatZaiChild.kill(); } catch {}
  try {
    if (BR.proc && BR.persist) { const pid = BR.proc.pid; killTree(BR.proc, true); for (let i = 0; i < 20; i++) { try { process.kill(pid, 0); } catch { break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); } }
    if (BR.proc) killTree(BR.proc);
  } catch {}
  if (BR.dir && !BR.persist) RM_DIRS.add(BR.dir);
  for (const d of RM_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {} }
});
const quit = async () => { try { await chatZaiStop(); } catch {} try { await closeBrowserGraceful(); } catch {} process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

/* ---------- connections: GitHub, Vercel, MySQL ---------- */
async function apiCall(base, headers, method, pth, body) {
  if (!/^\/[A-Za-z0-9_\-./?=&%:,+~@!$'()*;]*$/.test(String(pth || ''))) throw new Error('Invalid API path');
  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new Error('Unsupported method');
  const opts = { method: m, headers: { ...headers }, signal: AbortSignal.timeout(30000) };
  if (body !== undefined && body !== null && m !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(base + pth, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 20000); }
  return { status: r.status, data };
}
const ghHeaders = t => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'my-agent-bridge' });
const vcHeaders = t => ({ Authorization: 'Bearer ' + t, 'User-Agent': 'my-agent-bridge' });
function connStatus() {
  const s = readSecrets();
  return {
    github: s.github ? { connected: true, user: s.github.user || '', expose: !!s.github.expose } : { connected: false },
    vercel: s.vercel ? { connected: true, user: s.vercel.user || '', teamId: s.vercel.teamId || '', expose: !!s.vercel.expose } : { connected: false },
    mysql: s.mysql ? { connected: true, host: s.mysql.host, port: s.mysql.port, user: s.mysql.user, database: s.mysql.database || '', ssl: !!s.mysql.ssl, readOnly: s.mysql.readOnly !== false } : { connected: false }
  };
}
async function connSet(b) {
  const name = String(b.name || ''), sec = readSecrets();
  if (name === 'github') {
    const token = String(b.token || '').trim() || (sec.github && sec.github.token) || '';
    if (!token) throw new Error('Paste a GitHub personal access token');
    let r;
    try { r = await apiCall('https://api.github.com', ghHeaders(token), 'GET', '/user'); } catch (e) { throw new Error('Could not reach GitHub: ' + e.message); }
    if (r.status !== 200) throw new Error('GitHub did not accept the token (HTTP ' + r.status + ')');
    sec.github = { token, expose: !!b.expose, user: r.data.login };
  } else if (name === 'vercel') {
    const token = String(b.token || '').trim() || (sec.vercel && sec.vercel.token) || '';
    if (!token) throw new Error('Paste a Vercel token');
    let r;
    try { r = await apiCall('https://api.vercel.com', vcHeaders(token), 'GET', '/v2/user'); } catch (e) { throw new Error('Could not reach Vercel: ' + e.message); }
    if (r.status !== 200) throw new Error('Vercel did not accept the token (HTTP ' + r.status + ')');
    const u = r.data.user || {};
    sec.vercel = { token, teamId: String(b.teamId || '').trim(), expose: !!b.expose, user: u.username || u.email || '' };
  } else if (name === 'mysql') {
    const old = sec.mysql || {};
    const cfg = { host: String(b.host || '').trim(), port: Number(b.port) || 3306, user: String(b.user || '').trim(), password: b.password ? String(b.password) : (old.password || ''),
      database: String(b.database || '').trim(), ssl: !!b.ssl, readOnly: b.readOnly !== false };
    if (!cfg.host || !cfg.user) throw new Error('Host and user are required');
    await mysqlExec(cfg, 'SELECT 1', 1);
    sec.mysql = cfg;
  } else throw new Error('Unknown connection');
  writeJson(SECRETS_FILE, sec);
  return connStatus();
}
function connRemove(b) { const sec = readSecrets(); delete sec[String(b.name)]; writeJson(SECRETS_FILE, sec); return connStatus(); }
async function connGithub(b) {
  const s = readSecrets().github; if (!s) throw new Error('GitHub is not connected');
  return apiCall('https://api.github.com', ghHeaders(s.token), b.method, b.path, b.body);
}
async function connVercel(b) {
  const s = readSecrets().vercel; if (!s) throw new Error('Vercel is not connected');
  let p = String(b.path || '');
  if (s.teamId && !/[?&]teamId=/.test(p)) p += (p.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(s.teamId);
  return apiCall('https://api.vercel.com', vcHeaders(s.token), b.method, p, b.body);
}

function findMysql2() {
  try { return require(require.resolve('mysql2/promise', { paths: [__dirname, ROOT, process.cwd()].filter(Boolean) })); } catch { return null; }
}
const MYSQL_CLI = hasCmd('mysql');
const isReadSql = sql => {
  const s = String(sql).replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/g, '');
  return /^\(*\s*(select|show|describe|desc|explain|with)\b/i.test(s) && !/\binto\s+(outfile|dumpfile)\b/i.test(s);
};
function parseTsv(out, maxRows) {
  const lines = out.replace(/\r/g, '').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return { columns: [], rows: [], truncated: false, message: 'OK (no result set)' };
  const un = s => (s === 'NULL' ? null : s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c === '\\' ? '\\' : c)));
  return { columns: lines[0].split('\t'), rows: lines.slice(1, 1 + maxRows).map(l => l.split('\t').map(un)), truncated: lines.length - 1 > maxRows };
}
async function mysqlExec(cfg, sql, maxRows) {
  const lib = findMysql2();
  if (lib) {
    let conn;
    try {
      conn = await lib.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database || undefined,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000, dateStrings: true });
      if (cfg.readOnly !== false) await conn.query('SET SESSION TRANSACTION READ ONLY');
      const [rows, fields] = await conn.query({ sql, rowsAsArray: true });
      if (Array.isArray(rows)) {
        const cell = v => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? '<binary ' + v.length + ' bytes>' : typeof v === 'object' ? JSON.stringify(v) : v);
        return { columns: (fields || []).map(f => f.name), rows: rows.slice(0, maxRows).map(r => r.map(cell)), truncated: rows.length > maxRows };
      }
      return { columns: [], rows: [], truncated: false, message: 'OK. Rows affected: ' + (rows.affectedRows ?? 0) + (rows.insertId ? ', insert id: ' + rows.insertId : '') };
    } catch (e) { throw new Error('MySQL error: ' + e.message); }
    finally { if (conn) conn.end().catch(() => {}); }
  }
  if (MYSQL_CLI) {
    if (/;\s*\S/.test(sql)) throw new Error('Run one statement at a time');
    const args = ['--batch', '--default-character-set=utf8mb4', '-h', cfg.host, '-P', String(cfg.port), '-u', cfg.user];
    if (cfg.database) args.push('-D', cfg.database);
    if (cfg.ssl) args.push('--ssl-mode=REQUIRED');
    args.push('-e', (cfg.readOnly !== false ? 'SET SESSION TRANSACTION READ ONLY; ' : '') + sql);
    const r = spawnSync('mysql', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 20e6, env: { ...process.env, MYSQL_PWD: cfg.password || '' } });
    if (r.status !== 0) throw new Error('MySQL error: ' + String(r.stderr || r.error || 'failed').trim().slice(0, 400));
    return parseTsv(r.stdout || '', maxRows);
  }
  throw new Error('MySQL support is not installed. Run "npm install mysql2" in the folder that contains agent-server.js (or install the mysql command-line client), then restart the bridge.');
}
async function dbQuery(b) {
  const sql = String(b.sql || '').trim().replace(/;\s*$/, '');
  if (!sql) throw new Error('Missing SQL');
  const cfg = readSecrets().mysql; if (!cfg) throw new Error('MySQL is not connected. Add it under Connections.');
  if (!isReadSql(sql)) {
    if (cfg.readOnly !== false) throw new Error('This connection is read-only, so statements that change data are blocked. Turn off read-only under Connections to allow them.');
    const g = permGuard('destructive', 'Run SQL that changes data:\n' + sql.slice(0, 400), b);
    if (g) return g;
  }
  return mysqlExec(cfg, sql, Math.min(Math.max(Number(b.maxRows) || 200, 1), 1000));
}
const dbTables = () => dbQuery({ sql: 'SHOW TABLES', maxRows: 1000 });
function dbDescribe(b) {
  if (!/^[\w$.-]{1,128}$/.test(String(b.table || ''))) throw new Error('Invalid table name');
  return dbQuery({ sql: 'DESCRIBE `' + String(b.table).replace(/`/g, '') + '`', maxRows: 500 });
}

/* ---------- extensions: MCP servers and simple command tools ---------- */
class McpClient {
  constructor(name, def, cwd) { Object.assign(this, { name, def, cwd, proc: null, id: 1, pending: new Map(), tools: [], status: 'stopped', error: '', err: '', buf: '', ready: null }); }
  async start() {
    if (this.status === 'running') return;
    if (this.status === 'starting') return this.ready;
    this.status = 'starting'; this.error = ''; this.buf = ''; this.err = '';
    this.ready = (async () => {
      const d = this.def;
      const proc = spawn(d.command, d.args || [], { cwd: this.cwd, env: { ...process.env, ...(d.env || {}) }, shell: WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', c => {
        this.buf += c.toString('utf8'); let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.id !== undefined && !m.method && this.pending.has(m.id)) {
            const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.t);
            if (m.error) p.rej(new Error(m.error.message || 'MCP error')); else p.res(m.result || {});
          } else if (m.method && m.id !== undefined) proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
        }
      });
      proc.stderr.on('data', c => { this.err = (this.err + c.toString()).slice(-2000); });
      proc.on('error', e => this.fail(e.message));
      proc.on('close', () => { if (this.status !== 'stopped') this.fail('The server stopped. ' + this.err.trim().slice(-300)); });
      await this.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'my-agent', version: '1.0' } }, 60000);
      this.note('notifications/initialized');
      const r = await this.req('tools/list', {}, 30000);
      this.tools = (r.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } }));
      this.status = 'running';
    })().catch(e => { this.fail(e.message); throw e; });
    this.ready.catch(() => {});
    return this.ready;
  }
  fail(msg) {
    if (this.status === 'stopped') return;
    this.status = 'error'; this.error = msg;
    this.pending.forEach(p => { clearTimeout(p.t); p.rej(new Error(msg)); }); this.pending.clear();
    try { if (this.proc) this.proc.kill(); } catch {}
  }
  req(method, params, timeout = 120000) {
    return new Promise((res, rej) => {
      const id = this.id++;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('The extension did not answer ' + method)); }, timeout);
      this.pending.set(id, { res, rej, t });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  note(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); }
  async call(tool, args) {
    await this.start();
    const r = await this.req('tools/call', { name: tool, arguments: args || {} }, 120000);
    return { text: (r.content || []).map(c => (c.type === 'text' ? c.text : '[' + c.type + ' content]')).join('\n'), isError: !!r.isError };
  }
  stop() { this.status = 'stopped'; try { if (this.proc) this.proc.kill(); } catch {} this.proc = null; }
}
const MCPS = new Map();
process.on('exit', () => { for (const m of MCPS.values()) { try { m.stop(); } catch {} } });

async function extCatalogSearch(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const query = String(b.query || '').trim().slice(0, 160);
  if (!query) throw new Error('Enter a package or tool name to search');
  const size = Math.max(1, Math.min(20, Number(b.size) || 20));
  const textQuery = query.toLowerCase().includes('mcp') ? query : query + ' mcp';
  const url = 'https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(textQuery) + '&size=' + size + '&quality=0.2&popularity=0.4&maintenance=0.4';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!r.ok) throw new Error('npm registry returned HTTP ' + r.status);
    const data = await r.json();
    const packages = (data.objects || []).map(o => {
      const p = o.package || {}, score = o.score || {};
      return { name: String(p.name || ''), version: String(p.version || ''), description: String(p.description || '').slice(0, 500), license: String((p.license || (p.links && p.links.license) || '')).slice(0, 80), updated: String(p.date || ''), links: { npm: p.links && p.links.npm ? p.links.npm : '' }, maintainers: (p.maintainers || []).slice(0, 5).map(m => m.username || m.name || '').filter(Boolean).join(', '), weeklyDownloads: Number(o.downloads && o.downloads.weekly || 0), score: Number(score.final || 0) };
    }).filter(p => p.name && /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(p.name));
    return { query, packages };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('npm registry search timed out');
    throw e;
  } finally { clearTimeout(timer); }
}

// Phase 3Q: read-only package safety inspection (npm registry metadata only; nothing is installed or executed)
async function extPackageInspect(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const name = String(b.name || '').trim();
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) || name.length > 214) throw new Error('Invalid npm package name');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2f'), { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (r.status === 404) throw new Error('Package not found on npm');
    if (!r.ok) throw new Error('npm registry returned HTTP ' + r.status);
    const doc = await r.json();
    const latest = (doc['dist-tags'] && doc['dist-tags'].latest) || '';
    const v = (doc.versions && doc.versions[latest]) || {};
    const times = doc.time || {};
    const scripts = v.scripts || {};
    const installScripts = ['preinstall', 'install', 'postinstall'].filter(k => scripts[k]).map(k => k + ': ' + String(scripts[k]).slice(0, 160));
    const deps = Object.keys(v.dependencies || {});
    const repo = typeof v.repository === 'string' ? v.repository : (v.repository && v.repository.url) || '';
    const created = times.created ? Date.parse(times.created) : 0, modified = times[latest] ? Date.parse(times[latest]) : 0;
    const ageDays = created ? Math.floor((Date.now() - created) / 864e5) : null;
    const sinceUpdateDays = modified ? Math.floor((Date.now() - modified) / 864e5) : null;
    const flags = [];
    if (installScripts.length) flags.push({ level: 'high', text: 'Runs install scripts (' + installScripts.length + '). These execute during installation.' });
    if (v.deprecated) flags.push({ level: 'high', text: 'Marked deprecated: ' + String(v.deprecated).slice(0, 160) });
    if (!repo) flags.push({ level: 'medium', text: 'No source repository listed.' });
    if (!(v.license || doc.license)) flags.push({ level: 'medium', text: 'No license listed.' });
    if (ageDays !== null && ageDays < 30) flags.push({ level: 'medium', text: 'Package is only ' + ageDays + ' day(s) old.' });
    if (sinceUpdateDays !== null && sinceUpdateDays > 730) flags.push({ level: 'low', text: 'Not updated for over 2 years.' });
    if (deps.length > 40) flags.push({ level: 'low', text: 'Large dependency tree (' + deps.length + ' direct dependencies).' });
    if (!flags.length) flags.push({ level: 'info', text: 'No metadata red flags found. This is not a security audit.' });
    return {
      name, version: latest, license: String(v.license || doc.license || ''), repository: repo.replace(/^git\+/, '').slice(0, 300),
      homepage: String(v.homepage || '').slice(0, 300), maintainers: (doc.maintainers || []).slice(0, 6).map(m => m.name || m.username || '').filter(Boolean),
      directDependencies: deps.length, installScripts, bin: Object.keys(typeof v.bin === 'string' ? { [name]: v.bin } : (v.bin || {})).slice(0, 8),
      ageDays, daysSinceLatestRelease: sinceUpdateDays, flags
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('npm registry timed out');
    throw e;
  } finally { clearTimeout(timer); }
}

function extInstalled() {
  const state = readJson(EXT_STATE, {}), out = [];
  if (!fs.existsSync(EXT_DIR)) return out;
  for (const e of fs.readdirSync(EXT_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(EXT_DIR, e.name), manifest = readJson(path.join(dir, 'extension.json'), null);
    if (manifest) out.push({ name: e.name, dir, manifest, enabled: !(state[e.name] && state[e.name].enabled === false) });
  }
  return out;
}
const extFind = name => { const x = extInstalled().find(e => e.name === name); if (!x) throw new Error('Extension not found: ' + name); return x; };
const mcpFor = x => { let c = MCPS.get(x.name); if (!c) { c = new McpClient(x.name, x.manifest.mcp, x.dir); MCPS.set(x.name, c); } return c; };
async function extList() {
  const items = extInstalled();
  const out = await Promise.all(items.map(async x => {
    const base = { name: x.name, description: x.manifest.description || '', enabled: x.enabled, kind: x.manifest.mcp ? 'mcp' : 'tools', version: x.manifest.version || '', installSource: x.manifest.installSource || '', installArgs: Array.isArray(x.manifest.installArgs) ? x.manifest.installArgs.join(' ') : '' };
    if (!x.enabled) return { ...base, status: 'disabled', tools: [] };
    if (x.manifest.mcp) {
      const c = mcpFor(x);
      if (c.status === 'stopped') await Promise.race([c.start().catch(() => {}), sleep(3000)]);
      return { ...base, status: c.status, error: c.error, tools: c.status === 'running' ? c.tools : [] };
    }
    return { ...base, status: 'ready', tools: (x.manifest.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, run: t.run })) };
  }));
  return { extensions: out };
}
function runToolCommand(x, tool, args) {
  return new Promise(resolve => {
    const t = (x.manifest.tools || []).find(k => k.name === tool);
    if (!t || !t.run) return resolve({ text: 'Unknown tool: ' + tool, isError: true });
    const child = spawn(String(t.run), { cwd: x.dir, shell: true, env: { ...process.env, EXT_ARGS: JSON.stringify(args || {}) }, windowsHide: true });
    let out = '', err = ''; const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60000);
    child.stdout.on('data', c => { out = (out + c).slice(0, 100000); }); child.stderr.on('data', c => { err = (err + c).slice(0, 20000); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(args || {}));
    child.on('close', code => { clearTimeout(timer); resolve({ text: out + (code !== 0 && err ? '\n[stderr]\n' + err : ''), isError: code !== 0 }); });
    child.on('error', e => { clearTimeout(timer); resolve({ text: e.message, isError: true }); });
  });
}
function extRestart(b) {
  const x = extFind(String(b.name || ''));
  if (MCPS.has(x.name)) { MCPS.get(x.name).stop(); MCPS.delete(x.name); }
  if (x.manifest.mcp && x.enabled) mcpFor(x).start().catch(() => {});
  return { ok: true };
}
async function extCall(b) {
  const x = extFind(String(b.name || ''));
  if (!x.enabled) throw new Error('This extension is turned off');
  if (x.manifest.mcp) return mcpFor(x).call(String(b.tool), b.args);
  return runToolCommand(x, String(b.tool), b.args);
}
function validManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('The extension manifest must be a JSON object');
  const ok = (m.mcp && typeof m.mcp.command === 'string') || (Array.isArray(m.tools) && m.tools.every(t => t && typeof t.name === 'string' && typeof t.run === 'string'));
  if (!ok) throw new Error('A manifest needs "mcp": {"command": ...} or "tools": [{"name", "run"}]');
  return m;
}

/* ---------- 3.13.2: VS Code Marketplace — search the public gallery + download VSIX packages.
   Nothing is executed: Install saves the extension's .vsix into DATA/vscode-extensions so the
   user has the real package (same download Visual Studio Code itself serves). ---------- */
const VSIX_DIR = path.join(DATA, 'vscode-extensions');
const GALLERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const VSIX_SAFE = /^[A-Za-z0-9._-]+$/;
/* 3.13.3: Recommended extensions. The Add Extension page shows the most-installed VS Code
   extensions the moment it opens (gallery sortBy 4 = InstallCount, target VS Code only),
   so the user sees real content before typing anything. Result is cached 10 minutes. */
const MKT_REC_TTL = 10 * 60 * 1000;
let MKT_REC = { at: 0, items: null };
async function mktSearch(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const query = String(b.query || '').trim().slice(0, 160);
  const recommended = !query && !!b.recommended;
  if (!query && !recommended) throw new Error('Type a name to search the VS Code Marketplace');
  const size = Math.max(1, Math.min(30, Number(b.size) || 24));
  if (recommended && MKT_REC.items && Date.now() - MKT_REC.at < MKT_REC_TTL) return { query: '', recommended: true, items: MKT_REC.items };
  const body = JSON.stringify({ filters: [{ criteria: query ? [{ filterType: 10, value: query }, { filterType: 8, value: 'Microsoft.VisualStudio.Code' }] : [{ filterType: 8, value: 'Microsoft.VisualStudio.Code' }], pageNumber: 1, pageSize: size, sortBy: recommended ? 4 : 0 }], flags: 914 });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(GALLERY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' }, body, signal: controller.signal });
    if (!r.ok) throw new Error('Marketplace returned HTTP ' + r.status);
    const data = await r.json();
    const exts = (data.results && data.results[0] && data.results[0].extensions) || [];
    const items = exts.map(x => {
      const v = (x.versions && x.versions[0]) || {};
      const files = v.files || [];
      const iconFile = files.find(f => f.assetType === 'Microsoft.VisualStudio.Services.Icons.Default');
      const st = {}; (x.statistics || []).forEach(s => { st[s.statisticName] = Number(s.value) || 0; });
      return {
        id: String((x.publisher && x.publisher.publisherName) || '') + '.' + String(x.extensionName || ''),
        name: String(x.extensionName || ''),
        displayName: String(x.displayName || x.extensionName || '').slice(0, 120),
        publisher: String((x.publisher && x.publisher.publisherName) || ''),
        verified: !!(x.publisher && x.publisher.flags === 'verified'),
        version: String(v.version || '').slice(0, 40),
        icon: iconFile ? String(iconFile.source || '') : '',
        installs: Number(st.install || 0),
        rating: Number(st.averagerating || 0),
        ratingCount: Number(st.ratingcount || 0),
        updated: String(x.lastUpdated || '')
      };
    }).filter(x => x.name && x.publisher && VSIX_SAFE.test(x.publisher) && VSIX_SAFE.test(x.name));
    if (recommended) MKT_REC = { at: Date.now(), items };
    return { query, recommended, items };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Marketplace search timed out');
    throw e;
  } finally { clearTimeout(timer); }
}
function vsixPathFor(id, version) {
  const safe = (String(id || '') + '-' + String(version || '').replace(/^v/, '')).toLowerCase();
  if (!VSIX_SAFE.test(safe) || safe.length > 160) throw new Error('Invalid extension id or version');
  return path.join(VSIX_DIR, safe + '.vsix');
}
async function mktInstall(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const id = String(b.id || '').trim();               // "publisher.name"
  const pub = id.split('.')[0], name = id.split('.').slice(1).join('.');
  if (!pub || !name || !VSIX_SAFE.test(pub) || !VSIX_SAFE.test(name)) throw new Error('Invalid extension id');
  const version = String(b.version || '').replace(/^v/, '');
  if (!VSIX_SAFE.test(version)) throw new Error('Invalid extension version');
  const url = 'https://' + pub + '.gallery.vsassets.io/_apis/public/gallery/publisher/' + pub + '/extension/' + name + '/' + version + '/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage';
  fs.mkdirSync(VSIX_DIR, { recursive: true });
  const file = vsixPathFor(id, version);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error('VSIX download failed: HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('VSIX download was empty');
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Downloaded file is not a VSIX package (bad signature)');
    fs.writeFileSync(file, buf);
    auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/install', ok: true, status: 200, ms: 0, d: id + ' @ ' + version + ' (' + buf.length + ' bytes)' });
    return { ok: true, file: path.basename(file), bytes: buf.length };
  } catch (e) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
    if (e.name === 'AbortError') throw new Error('VSIX download timed out');
    throw e;
  } finally { clearTimeout(timer); }
}
/* 3.13.3: read the extension's real name out of the .vsix package (a ZIP). Installed cards
   show "Prettier — Code formatter · v11.0.0" instead of the file name prettier.prettier-11.0.0.
   3.13.4: also reads the description and the required VS Code engine so the details view
   opened by clicking a card can show what the package is and whether it can ever run here.
   Minimal ZIP central-directory reader: no dependencies, only the small manifest entries are
   decompressed (zlib is built into Node). Result is cached per file (name+size+mtime). */
const VSIX_META_CACHE = new Map();
function vsixMeta(file) {
  const st = fs.statSync(file);
  const key = st.size + ':' + Math.floor(st.mtimeMs);
  const hit = VSIX_META_CACHE.get(file);
  if (hit && hit.key === key) return hit.meta;
  let meta = null;
  const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } }).trim();
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const tailLen = Math.min(66000, st.size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
      const eocd = tail.lastIndexOf('PK\x05\x06');
      if (eocd >= 0 && eocd + 22 <= tail.length) {
        const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
        if (cdOff + cdSize <= st.size && count > 0 && count < 20000) {
          const cd = Buffer.alloc(cdSize);
          fs.readSync(fd, cd, 0, cdSize, cdOff);
          let p = 0;
          for (let i = 0; i < count && p + 46 <= cd.length; i++) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
            const name = cd.slice(p + 46, p + 46 + nlen).toString('utf8');
            p += 46 + nlen + elen + clen;
            const isManifest = /^extension\/vsixmanifest$/i.test(name) || /^extension\.vsixmanifest$/i.test(name);
            const isPkg = !isManifest && /^extension\/package\.json$/i.test(name);
            if (!isManifest && !isPkg) continue;
            if (lho + 30 > st.size) continue;
            const lh = Buffer.alloc(30);
            fs.readSync(fd, lh, 0, 30, lho);
            if (lh.readUInt32LE(0) !== 0x04034b50) continue;
            const dataStart = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
            if (dataStart + csize > st.size) continue;
            const comp = Buffer.alloc(csize);
            fs.readSync(fd, comp, 0, csize, dataStart);
            let buf = null;
            try { buf = method === 0 ? comp : method === 8 ? zlib.inflateRawSync(comp) : null; } catch {}
            if (!buf || buf.length > 2e6) continue;
            const txt = buf.toString('utf8');
            let m2 = null;
            if (isManifest) {
              const pick = t => { const m = txt.match(new RegExp('<(?:[A-Za-z]+:)?' + t + '(?:\\s[^>]*)?>([^<]*)</')); return m ? dec(m[1]) : ''; };
              const idm = txt.match(/<(?:[A-Za-z]+:)?Identity\s+([^>]*?)\/?>/);
              const attr = (n) => { if (!idm) return ''; const m = idm[1].match(new RegExp(n + '="([^"]*)"')); return m ? dec(m[1]) : ''; };
              m2 = { displayName: pick('DisplayName'), publisher: attr('Publisher'), version: attr('Version'), description: pick('Description'), engines: '', source: 'manifest' };
            } else if (txt.charCodeAt(0) === 0x7b || txt.charCodeAt(0) === 0x5b || /^\s*\{/.test(txt)) {
              try { const j = JSON.parse(txt); m2 = { displayName: dec(j.displayName || j.name || ''), publisher: dec(j.publisher || ''), version: dec(j.version || ''), description: dec(j.description || ''), engines: dec((j.engines && j.engines.vscode) || ''), source: 'package.json' }; } catch {}
            }
            /* merge both manifest entries (order in the archive is not guaranteed) */
            if (m2) {
              if (!meta) meta = m2;
              else for (const k of ['displayName', 'publisher', 'version', 'description', 'engines']) if (!meta[k] && m2[k]) meta[k] = m2[k];
            }
          }
        }
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  meta = (meta && meta.displayName) ? meta : { displayName: '', publisher: '', version: '', description: '', engines: '', source: 'filename' };
  VSIX_META_CACHE.set(file, { key, meta });
  if (VSIX_META_CACHE.size > 400) { const first = VSIX_META_CACHE.keys().next().value; VSIX_META_CACHE.delete(first); }
  return meta;
}
function mktInstalled() {
  fs.mkdirSync(VSIX_DIR, { recursive: true });
  const items = fs.readdirSync(VSIX_DIR).filter(f => f.toLowerCase().endsWith('.vsix')).map(f => {
    const full = path.join(VSIX_DIR, f);
    const st = fs.statSync(full);
    const m = vsixMeta(full);
    return { file: f, bytes: st.size, updated: st.mtimeMs, displayName: m.displayName, publisher: m.publisher, version: m.version, description: m.description || '', engines: m.engines || '' };
  }).sort((a, b) => b.updated - a.updated);
  return { items, dir: VSIX_DIR };
}


function nodeHostDebugStop(b) {
  const key=String(b.key||''), sessionId=String(b.sessionId||'');
  if(!/^[a-f0-9]{24}$/.test(key) || !/^dbg-/.test(sessionId)) throw new Error('Invalid extension debug session');
  if(permLoad().terminal!=='allow') throw new Error('Terminal permission must be set to Allow before stopping an extension debugger.');
  const host=VSCODE_NODE_HOSTS.get(key);
  if(!host || !host.debugSessions.has(sessionId)) return {ok:true,stopped:false};
  nodeHostSend(host,{type:'stopDebug',sessionId});
  return {ok:true,stopping:true,sessionId};
}
function nodeHostWebviewMessage(b) {
  const key=String(b.key||''), panelId=String(b.panelId||''); if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key), view=host&&host.webviews.get(panelId); if(!view)throw new Error('Webview panel not found.');
  const message=b.message; const encoded=JSON.stringify(message===undefined?null:message); if(encoded.length>100000)throw new Error('Webview message exceeds 100 KB.');
  nodeHostSend(host,{type:'webviewMessage',panelId,message:message===undefined?null:message}); return {ok:true};
}
function nodeHostWebviewClose(b) {
  const key=String(b.key||''),panelId=String(b.panelId||'');if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key);if(!host||!host.webviews.has(panelId))return {ok:true};
  host.webviews.delete(panelId);nodeHostSend(host,{type:'webviewDisposed',panelId});return {ok:true};
}
function mktUninstall(b) {
  const f = path.basename(String(b.file || ''));
  if (!/\.vsix$/i.test(f)) throw new Error('Invalid file');
  const file = path.join(VSIX_DIR, f);
  if (!file.startsWith(VSIX_DIR + path.sep)) throw new Error('Invalid path');
  if (fs.existsSync(file)) { fs.unlinkSync(file); auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/uninstall', ok: true, status: 200, ms: 0, d: f }); }
  return { ok: true };
}
/* 3.13.7: VS Code extensions cannot run inside CodeSpace (they need VS Code's own extension host),
   so the way to actually USE a Marketplace extension is to install its .vsix into a real VS Code.
   This runs `code --install-extension <file>` for a package already downloaded into VSIX_DIR.
   User-initiated from the Extensions panel; the file name is validated and shell metacharacters
   in the resolved path are refused because Windows needs a shell to launch code.cmd. */
function findVscodeCli() {
  const cands = [];
  if (WIN) {
    const la = process.env.LOCALAPPDATA, pf = process.env.ProgramFiles, pf86 = process.env['ProgramFiles(x86)'];
    if (la) cands.push(path.join(la, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), path.join(la, 'Programs', 'VSCodium', 'bin', 'codium.cmd'));
    if (pf) cands.push(path.join(pf, 'Microsoft VS Code', 'bin', 'code.cmd'));
    if (pf86) cands.push(path.join(pf86, 'Microsoft VS Code', 'bin', 'code.cmd'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  for (const name of (WIN ? ['code.cmd', 'codium.cmd'] : ['code', 'codium'])) if (hasCmd(name.replace(/\.cmd$/, ''))) return name;
  return '';
}
function mktOpenInVscode(b) {
  const f = path.basename(String(b.file || ''));
  if (!/^[A-Za-z0-9._-]+\.vsix$/i.test(f)) throw new Error('Invalid file');
  const file = path.join(VSIX_DIR, f);
  if (!file.startsWith(VSIX_DIR + path.sep) || !fs.existsSync(file)) throw new Error('That package is not in your CodeSpace extensions folder.');
  const cli = findVscodeCli();
  if (!cli) throw new Error('VS Code was not found. Install VS Code (https://code.visualstudio.com), then try again — or open VS Code and use Extensions \u203a \u2026 \u203a Install from VSIX with: ' + file);
  if (/["&|<>^%!`$\r\n]/.test(file + cli)) throw new Error('This path has characters that cannot be passed to VS Code safely. Install the package manually: ' + file);
  const r = WIN
    ? spawnSync('"' + cli + '" --install-extension "' + file + '" --force', { shell: true, encoding: 'utf8', timeout: 120000, windowsHide: true })
    : spawnSync(cli, ['--install-extension', file, '--force'], { encoding: 'utf8', timeout: 120000 });
  const out = String((r.stdout || '') + (r.stderr || '')).trim().slice(-800);
  const ok = r.status === 0 && !/failed|error/i.test(out.split('\n').pop() || '');
  auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/open-vscode', ok, status: ok ? 200 : 500, ms: 0, d: f });
  if (!ok) throw new Error('VS Code could not install the package' + (out ? ': ' + out : '.'));
  return { ok: true, output: out, file: f };
}
/* 3.16.0 — CodeSpace-compatible VS Code web extensions.
   Search uses the vendor-neutral Open VSX registry. Candidate VSIX files are inspected before
   they are shown; only packages compatible with the CodeSpace Web or restricted Node.js host
   API/runtime subset are listed. Unsupported desktop/native requirements are filtered out. */
const VSCODE_EXT_DIR = path.join(DATA, 'vscode-extensions', 'codespace-installed');
const VSCODE_CANDIDATE_DIR = path.join(DATA, 'vscode-extension-candidates');
const OPEN_VSX_API = 'https://open-vsx.org/api';
const MKT_COMPAT_TTL = 10 * 60 * 1000;
const MKT_COMPAT_CACHE = new Map();
function vscodeExtKey(id, version) {
  return crypto.createHash('sha256').update(String(id) + '@' + String(version)).digest('hex').slice(0, 24);
}
function normalizeOpenVsx(x) {
  const namespace = String(x.namespace || (x.extension && x.extension.namespace) || '').trim();
  const name = String(x.name || (x.extension && x.extension.name) || '').trim();
  const version = String(x.version || (x.extension && x.extension.version) || '').trim();
  const files = x.files || (x.extension && x.extension.files) || {};
  return {
    namespace, name, version, id: namespace && name ? namespace + '.' + name : '',
    displayName: String(x.displayName || (x.extension && x.extension.displayName) || name).slice(0, 120),
    description: String(x.description || (x.extension && x.extension.description) || '').slice(0, 500),
    downloadUrl: String(files.download || x.downloadUrl || ''), icon: String(files.icon || x.icon || ''),
    engines: x.engines || (x.extension && x.extension.engines) || {},
    downloadCount: Number(x.downloadCount || x.downloads || 0), averageRating: Number(x.averageRating || x.rating || 0),
    reviewCount: Number(x.reviewCount || x.ratingCount || 0), verified: !!(x.verified || x.namespaceAccess === 'verified')
  };
}
function openVsxDownloadUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('Registry returned an invalid download URL'); }
  if (u.protocol !== 'https:' || !['open-vsx.org'].includes(u.hostname)) throw new Error('Registry download host is not trusted');
  return u.href;
}
async function openVsxDetails(item, signal) {
  if (item.downloadUrl) return item;
  const u = OPEN_VSX_API + '/' + encodeURIComponent(item.namespace) + '/' + encodeURIComponent(item.name) + '/' + encodeURIComponent(item.version);
  const r = await fetch(u, { signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Open VSX metadata returned HTTP ' + r.status);
  return { ...item, ...normalizeOpenVsx(await r.json()) };
}
async function openVsxPackage(item, signal) {
  const key = vscodeExtKey(item.id, item.version), file = path.join(VSCODE_CANDIDATE_DIR, key + '.vsix');
  fs.mkdirSync(VSCODE_CANDIDATE_DIR, { recursive: true });
  try {
    const st = fs.statSync(file);
    if (st.size > 0 && st.size <= 20 * 1024 * 1024 && Date.now() - st.mtimeMs < 7 * 86400000) return fs.readFileSync(file);
  } catch {}
  const info = await openVsxDetails(item, signal);
  if (!info.downloadUrl) throw new Error('No downloadable VSIX is listed');
  const r = await fetch(openVsxDownloadUrl(info.downloadUrl), { signal, headers: { Accept: 'application/octet-stream' } });
  if (!r.ok) throw new Error('VSIX download returned HTTP ' + r.status);
  const length = Number(r.headers.get('content-length') || 0);
  if (length > 20 * 1024 * 1024) throw new Error("VSIX is larger than CodeSpace's 20 MB compatibility-check limit");
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 20 * 1024 * 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Registry response is not a valid, size-limited VSIX');
  fs.writeFileSync(file, buf);
  return buf;
}
async function inspectOpenVsxItem(item) {
  const cacheKey = item.id + '@' + item.version, cached = MKT_COMPAT_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < MKT_COMPAT_TTL) return cached.value;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const bytes = await openVsxPackage(item, controller.signal);
    const check = vscodeExtSupport.inspectVsixForCodeSpace(bytes);
    // The archive identity must exactly match the registry listing. This prevents a package
    // from being shown under one publisher/version and installing as another identity.
    const identityMatches = vscodeExtSupport.registryIdentityMatches(check, item);
    const value = check.compatible && identityMatches ? {
      id: item.id, namespace: item.namespace, name: item.name,
      displayName: check.displayName || item.displayName, publisher: item.namespace,
      version: item.version, description: check.description || item.description,
      icon: item.icon, downloads: item.downloadCount, rating: item.averageRating,
      ratingCount: item.reviewCount, verified: item.verified, requiresNativeAddons: !!check.requiresNativeAddons, nativeAddons: check.nativeAddons || [], nativeBinaries: check.nativeBinaries || [], requiresNativeCode: !!check.requiresNativeCode,
      runtime: check.runtime, hostType: check.hostType, compatibilityLabel: check.compatibilityLabel || (check.hostType === 'node' ? 'Node.js compatible' : 'Web compatible'), apiVersion: check.apiVersion, engines: check.engines,
      commands: check.commands, installable: true, compatible: true,
      candidateKey: vscodeExtKey(item.id, item.version)
    } : null;
    MKT_COMPAT_CACHE.set(cacheKey, { at: Date.now(), value });
    if (MKT_COMPAT_CACHE.size > 500) MKT_COMPAT_CACHE.delete(MKT_COMPAT_CACHE.keys().next().value);
    return value;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    return null;
  } finally { clearTimeout(timer); }
}
async function mktSearch(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const query = String(b.query || '').trim().slice(0, 120), recommended = !query && !!b.recommended;
  if (!query && !recommended) throw new Error('Type a name to search compatible VS Code extensions');
  const size = Math.max(1, Math.min(12, Number(b.size) || 10));
  const cacheKey = recommended ? 'recommended' : 'q:' + query.toLowerCase();
  const c = MKT_COMPAT_CACHE.get('result:' + cacheKey);
  if (c && Date.now() - c.at < MKT_COMPAT_TTL) return c.value;
  const params = new URLSearchParams({ size: '40', sortBy: 'downloadCount', sortOrder: 'desc' });
  if (query) params.set('query', query);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(OPEN_VSX_API + '/-/search?' + params.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Open VSX registry returned HTTP ' + r.status);
    const data = await r.json();
    const raw = Array.isArray(data.extensions) ? data.extensions : Array.isArray(data.results) ? data.results : [];
    const items = raw.map(normalizeOpenVsx).filter(x => x.id && x.version && /^[A-Za-z0-9_-]+$/.test(x.namespace) && /^[A-Za-z0-9._-]+$/.test(x.name));
    const results = [];
    // Probe in small concurrent batches: each candidate must be downloaded and checked,
    // but a slow package should not block every later result in the registry ranking.
    const candidates = items.slice(0, 24);
    for (let i = 0; i < candidates.length && results.length < size; i += 4) {
      const batch = await Promise.all(candidates.slice(i, i + 4).map(inspectOpenVsxItem));
      for (const hit of batch) { if (hit) results.push(hit); if (results.length >= size) break; }
    }
    const value = { query, recommended, source: 'Open VSX', compatibilityFilter: 'CodeSpace Web + restricted Node.js Extension Hosts', items: results };
    MKT_COMPAT_CACHE.set('result:' + cacheKey, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Open VSX compatibility search timed out');
    throw e;
  } finally { clearTimeout(timer); }
}
async function mktInstall(b) {
  if (permDenyOnly('network')) throw new Error('Network access is disabled by CodeSpace permission settings.');
  const id = String(b.id || '').trim(), version = String(b.version || '').trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(id) || !/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('Invalid extension identity');
  // A package must pass the exact same manifest and entry-point gate used by marketplace search.
  const cacheKey = vscodeExtKey(id, version), candidate = path.join(VSCODE_CANDIDATE_DIR, cacheKey + '.vsix');
  let bytes;
  try { bytes = fs.readFileSync(candidate); } catch { throw new Error('This candidate has expired. Search the marketplace again before installing.'); }
  const check = vscodeExtSupport.inspectVsixForCodeSpace(bytes);
  const identity = { namespace: id.split('.')[0], name: id.split('.').slice(1).join('.'), version };
  if (!check.compatible || !vscodeExtSupport.registryIdentityMatches(check, identity)) throw new Error('Extension failed CodeSpace compatibility or registry identity validation' + (check.reason ? ': ' + check.reason : '.'));
  const extPerm = permDenyOnly('ext'); if (extPerm) throw new Error('Extension installation is blocked by CodeSpace permission settings.');
  const key = vscodeExtKey(id, version), target = path.join(VSCODE_EXT_DIR, key), temp = target + '.installing';
  fs.mkdirSync(VSCODE_EXT_DIR, { recursive: true });
  try { fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
    vscodeExtSupport.extractVsix(bytes, temp);
    const verified = vscodeExtSupport.inspectVsixForCodeSpace(bytes); if (!verified.compatible) throw new Error(verified.reason);
    if (verified.moduleType === 'module') prepareCodeSpaceVscodeEsmShim(temp);
    fs.writeFileSync(path.join(temp, 'codespace-install.json'), JSON.stringify({ id, key, version, installedAt: new Date().toISOString(), runtime: verified.runtime, hostType: verified.hostType, apiVersion: verified.apiVersion, browserPath: verified.browserPath || '', mainPath: verified.mainPath || '', moduleType: verified.moduleType || 'commonjs', requiresNativeAddons: !!verified.requiresNativeAddons, nativeAddons: verified.nativeAddons || [], nativeBinaries: verified.nativeBinaries || [], requiresNativeCode: !!verified.requiresNativeCode, commands: verified.commands, contributions: verified.contributions || [], sandbox: verified.sandbox || '' }, null, 2));
    fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(temp, target);
  } catch (e) { fs.rmSync(temp, { recursive: true, force: true }); throw e; }
  auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/install', ok: true, status: 200, ms: 0, d: id + '@' + version + ' via Open VSX' });
  return { ok: true, id, version, key, runtime: check.runtime, hostType: check.hostType, moduleType: check.moduleType || 'commonjs', contributions: check.contributions || [], commands: check.commands };
}
function mktInstalled() {
  fs.mkdirSync(VSCODE_EXT_DIR, { recursive: true });
  const items = [];
  for (const key of fs.readdirSync(VSCODE_EXT_DIR)) {
    if (!/^[a-f0-9]{24}$/.test(key)) continue;
    const dir = path.join(VSCODE_EXT_DIR, key), state = readJson(path.join(dir, 'codespace-install.json'), null);
    if (!state || !fs.existsSync(path.join(dir, 'package.json'))) continue;
    const pkg = readJson(path.join(dir, 'package.json'), {});
    items.push({ key, id: state.id, version: state.version, displayName: String(pkg.displayName || pkg.name || state.id), publisher: String(pkg.publisher || state.id.split('.')[0]), description: String(pkg.description || '').slice(0, 300), runtime: state.runtime, hostType: state.hostType || 'web', apiVersion: state.apiVersion, browserPath: state.browserPath, mainPath: state.mainPath, moduleType: state.moduleType || 'commonjs', requiresNativeAddons: !!state.requiresNativeAddons, nativeBinaries: state.nativeBinaries || [], requiresNativeCode: !!state.requiresNativeCode, contributions: state.contributions || [], commands: state.commands || [], enabled: true, installedAt: state.installedAt });
  }
  return { items: items.sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt))), runtime: 'CodeSpace Web + Node.js Extension Hosts', apiVersion: vscodeExtSupport.API_VERSION };
}

/* 3.18.0 — expanded Node.js extension host. Each extension runs in its own child process.
   Node Permission Model is a guardrail, not a malicious-code security boundary; only activate
   trusted publisher code. Workspace APIs are RPC-mediated through CodeSpace permissions. */
const VSCODE_NODE_HOSTS = new Map();
const VSCODE_NODE_RUNNER = path.join(__dirname, 'vscode-node-extension-host.cjs');
const VSCODE_NODE_STATE = path.join(DATA, 'vscode-extension-state');
function nodeHostSend(host, message) {
  if (!host || !host.child || !host.child.stdin || host.child.stdin.destroyed) throw new Error('Node extension host is not available');
  host.child.stdin.write(JSON.stringify(message) + '\n');
}
function nodeHostStop(key) {
  const host = VSCODE_NODE_HOSTS.get(String(key)); if (!host) return { ok: true, stopped: false };
  VSCODE_NODE_HOSTS.delete(String(key));
  for (const pending of host.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Extension host stopped')); }
  host.pending.clear();
  for (const proc of host.processes.values()) { try { proc.kill('SIGTERM'); } catch {} } host.processes.clear();
  for (const id of host.terminals) { try { termStop(termGet(id), true); } catch {} } host.terminals.clear();
  host.webviews.clear(); host.debugSessions.clear();
  for (const pending of (host.featurePending || new Map()).values()) { clearTimeout(pending.timer); pending.reject(new Error('Extension host stopped')); } if (host.featurePending) host.featurePending.clear();
  try { nodeHostSend(host, { type: 'shutdown' }); } catch {}
  const child = host.child;
  const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 1200); killTimer.unref?.();
  child.once('exit', () => clearTimeout(killTimer));
  return { ok: true, stopped: true };
}
function nodeHostInfo(key) {
  const host = VSCODE_NODE_HOSTS.get(String(key));
  return host ? { state: host.error ? 'error' : host.ready ? 'running' : 'starting', commands: [...host.commands.values()], features: [...(host.features || new Map()).values()], viewProviders: [...(host.viewProviders || new Map()).values()], diagnostics: [...(host.diagnostics || new Map()).values()], error: host.error || '', logs: host.logs.slice(-20), terminalIds: [...host.terminals], webviews: [...host.webviews.values()].map(v => ({panelId:v.panelId,title:v.title,viewType:v.viewType,html:v.html,visible:v.visible,messages:v.messages||[]})), debugSessions: [...host.debugSessions.values()].map(d => ({sessionId:d.sessionId,type:d.type,name:d.name,state:d.state})) } : { state: 'stopped', commands: [], error: '', logs: [], terminalIds: [], webviews: [], debugSessions: [] };
}
function nodeHostLog(host, level, message) {
  const line = { at: new Date().toISOString(), level: String(level || 'info'), message: String(message || '').slice(0, 3000) };
  host.logs.push(line); if (host.logs.length > 100) host.logs.shift();
}
function nodeHostWorkspacePath(uri) {
  if (!ROOT) throw new Error('Open a workspace folder before using workspace file APIs from extensions.');
  let raw = uri && (uri.fsPath || uri.path) || '';
  if (uri && uri.scheme && uri.scheme !== 'file') throw new Error('Only file: workspace URIs are supported by CodeSpace.');
  raw = String(raw);
  if (!raw) throw new Error('Workspace URI is missing a path.');
  if (/^file:\/\//i.test(raw)) { try { raw = fileURLToPath(raw); } catch { throw new Error('Invalid workspace file URI.'); } }
  const full = path.isAbsolute(raw) ? path.resolve(raw) : safe(raw);
  if (!inside(ROOT, full)) throw new Error(WORKSPACE_JAIL_MSG(raw));
  let probe = full; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  if (!inside(fs.realpathSync(ROOT), fs.realpathSync(probe))) throw new Error(WORKSPACE_JAIL_MSG(raw));
  return full;
}
function nodeHostRequirePermission(category, action) {
  const mode = permLoad()[category] || 'ask';
  if (mode !== 'allow') throw new Error('CodeSpace permission "' + (PERM_DEFS[category] || {}).label + '" is set to ' + mode + '. Allow it in Permissions before this extension can ' + action + '.');
}
function nodeHostGlobToRegExp(pattern) {
  const src = String(pattern || '').replace(/(?:\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**');
  let out = '', depth = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '*') { if (src[i + 1] === '*') { i += 2; if (src[i] === '/') { out += '(?:.*/)?'; i++; } else out += '.*'; } else { out += '[^/]*'; i++; } continue; }
    if (c === '?') { out += '[^/]'; i++; continue; }
    if (c === '{') { depth++; out += '(?:'; i++; continue; }
    if (c === '}' && depth > 0) { depth--; out += ')'; i++; continue; }
    if (c === ',' && depth > 0) { out += '|'; i++; continue; }
    out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&'); i++;
  }
  out += ')'.repeat(depth);
  return new RegExp('^' + out + '$', 'i');
}
async function nodeHostRpc(host, method, args) {
  args = args && typeof args === 'object' ? args : {};
  if (method === 'command.executeBuiltIn') return undefined;
  if (method.startsWith('process.')) return nodeHostProcessRpc(host, method, args);
  if (method.startsWith('terminal.')) return nodeHostTerminalRpc(host, method, args);
  if (method.startsWith('webview.')) return nodeHostWebviewRpc(host, method, args);
  if (method.startsWith('debug.')) return nodeHostDebugRpc(host, method, args);
  if (!method.startsWith('workspace.')) throw new Error('Unsupported extension host RPC method: ' + method);
  if (method === 'workspace.findFiles') {
    if (!ROOT) throw new Error('No workspace folder is open.');
    const include = String(args.include || '**/*').slice(0, 300), exclude = String(args.exclude || '').slice(0, 300);
    const wildcard = nodeHostGlobToRegExp;
    const inc = wildcard(include), exc = exclude ? wildcard(exclude) : null, result = [];
    for (const f of walk(ROOT)) { const rel = f.rel.replace(/\\/g, '/'); if (inc.test(rel) && !(exc && exc.test(rel))) { result.push(f.full); if (result.length >= Math.max(1, Math.min(2000, Number(args.maxResults) || 1000))) break; } }
    return result;
  }
  if (method === 'workspace.openTextDocument') {
    const file = nodeHostWorkspacePath(args.uri); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Workspace file not found.');
    if (BINARY.test(file) || fs.statSync(file).size > 1e6) throw new Error('This file is binary or larger than 1 MB.');
    return { text: fs.readFileSync(file, 'utf8'), languageId: path.extname(file).slice(1) };
  }
  if (method === 'workspace.readFile') {
    const file = nodeHostWorkspacePath(args.uri); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Workspace file not found.');
    if (fs.statSync(file).size > 5e6) throw new Error('Workspace file is larger than the 5 MB extension API limit.');
    return { base64: fs.readFileSync(file).toString('base64') };
  }
  if (method === 'workspace.stat') {
    const file = nodeHostWorkspacePath(args.uri), st = fs.statSync(file);
    return { type: st.isFile() ? 1 : st.isDirectory() ? 2 : 0, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
  }
  if (method === 'workspace.readDirectory') {
    const dir = nodeHostWorkspacePath(args.uri), entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 1000);
    return entries.map(e => [e.name, e.isDirectory() ? 2 : e.isFile() ? 1 : 0]);
  }
  if (method === 'workspace.writeFile') {
    nodeHostRequirePermission('fsEdit', 'write workspace files');
    const file = nodeHostWorkspacePath(args.uri), data = Buffer.from(String(args.base64 || ''), 'base64');
    if (data.length > 5e6) throw new Error('Workspace write exceeds the 5 MB extension API limit.');
    if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error('Cannot replace a directory with a file.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) pushFileHistory(path.relative(ROOT, file).replace(/\\/g, '/'), fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, data); invalidateCodeIndex('Node extension workspace write'); return { ok: true };
  }
  if (method === 'workspace.createDirectory') {
    nodeHostRequirePermission('fsEdit', 'create workspace folders');
    const dir = nodeHostWorkspacePath(args.uri); fs.mkdirSync(dir, { recursive: true }); invalidateCodeIndex('Node extension folder create'); return { ok: true };
  }
  if (method === 'workspace.delete') {
    nodeHostRequirePermission('destructive', 'delete workspace files');
    const file = nodeHostWorkspacePath(args.uri); if (file === ROOT) throw new Error('An extension cannot delete the workspace root.');
    fs.rmSync(file, { recursive: !!(args.options && args.options.recursive), force: false }); invalidateCodeIndex('Node extension workspace delete'); return { ok: true };
  }
  if (method === 'workspace.rename' || method === 'workspace.copy') {
    const src = nodeHostWorkspacePath(args.oldUri || args.source), dst = nodeHostWorkspacePath(args.newUri || args.destination);
    if (method === 'workspace.rename') nodeHostRequirePermission('destructive', 'rename workspace files'); else nodeHostRequirePermission('fsEdit', 'copy workspace files');
    if (src === ROOT || dst === ROOT) throw new Error('Workspace root cannot be moved or replaced.');
    const overwrite = !!(args.options && args.options.overwrite);
    if (!fs.existsSync(src)) throw new Error('Source file not found.');
    if (fs.existsSync(dst) && !overwrite) throw new Error('Destination already exists. Pass { overwrite: true } to replace it.');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (method === 'workspace.rename') fs.renameSync(src, dst); else fs.cpSync(src, dst, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    invalidateCodeIndex('Node extension workspace ' + (method.endsWith('rename') ? 'rename' : 'copy')); return { ok: true };
  }
  throw new Error('Unsupported workspace API: ' + method);
}
function nodeHostProcessPath(host, command, args = [], cwdHint = null) {
  const raw = String(command || '').trim(); if (!raw || raw.length > 2048) throw new Error('Invalid extension process executable');
  const allowedRoots = [host.extensionDir, ROOT].filter(Boolean).map(x => path.resolve(x));
  const insideAny = file => allowedRoots.some(root => inside(root, file));
  const isNode = /^(?:node|node\.exe)$/i.test(raw) || (path.isAbsolute(raw) && path.resolve(raw) === path.resolve(process.execPath));
  // The bundled/system Node executable is an explicit exception: it may only execute
  // a script file stored under the extension or current workspace, and its own
  // permission flags are supplied by CodeSpace (never by the extension).
  if (isNode) {
    let script = null;
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print' || arg === '-r' || arg === '--require' || arg === '--import' || arg === '--experimental-loader' || arg === '--loader' || arg === '--inspect' || arg.startsWith('--inspect=') || arg.startsWith('--allow-') || arg === '--no-permission' || arg === '--permission') throw new Error('Node child processes may not override CodeSpace permission or loader flags, use eval, or enable debugging ports.');
      if (arg.startsWith('-')) continue;
      script = arg; break;
    }
    if (!script) throw new Error('A Node child process must execute a script file inside the extension or workspace.');
    const file = path.isAbsolute(script) ? path.resolve(script) : path.resolve(cwdHint || host.extensionDir, script);
    if (!insideAny(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Node child process scripts must stay inside the installed extension or opened workspace.');
    return process.execPath;
  }
  if (path.isAbsolute(raw)) {
    const full = path.resolve(raw);
    if (!insideAny(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('Native processes must be inside the installed extension or opened workspace.');
    return full;
  }
  const bases = [cwdHint, host.extensionDir, ROOT, path.join(host.extensionDir,'node_modules','.bin'), path.join(host.extensionDir,'bin'), path.join(host.extensionDir,'tools'), ROOT && path.join(ROOT,'node_modules','.bin')].filter(Boolean);
  for (const base of bases) {
    const candidate = path.resolve(base, raw);
    const tries = process.platform === 'win32' && !path.extname(candidate) ? [candidate+'.exe',candidate] : [candidate];
    for (const file of tries) if (insideAny(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error('Executable not found inside this extension or workspace. Bundle the executable in the VSIX or workspace.');
}
function nodeHostProcessRpc(host, method, args) {
  if (permLoad().terminal !== 'allow') throw new Error('Terminal permission must be explicitly set to Allow before an extension can start a native process or language server.');
  if (method === 'process.spawn') {
    if (host.processes.size >= 8) throw new Error('An extension can run at most 8 managed child processes at once.');
    const rawArgs = Array.isArray(args.args)?args.args.map(String).slice(0,128):[];
    let cwd = ROOT || host.extensionDir; if (args.cwd) { const raw=String(args.cwd); cwd=path.isAbsolute(raw)?path.resolve(raw):safe(raw); if (!inside(host.extensionDir,cwd) && !(ROOT && inside(ROOT,cwd))) throw new Error('Extension process working directory must stay inside the extension or workspace.'); }
    const command = nodeHostProcessPath(host, args.command, rawArgs, cwd); const isBundledNode = path.resolve(command) === path.resolve(process.execPath); if (!isBundledNode && permLoad().nativeCode !== 'allow') throw new Error('This extension needs to launch a native executable. Set Native extension code to Allow only after trusting the publisher.'); let argv = rawArgs; if (isBundledNode) argv = ['--permission','--max-old-space-size=256','--allow-fs-read='+host.extensionDir,'--allow-fs-read='+(ROOT||host.extensionDir),'--allow-fs-write='+host.stateDir,'--disable-proto=throw',...rawArgs];
    if (argv.some(x => x.length > 8192)) throw new Error('A process argument exceeds the safety limit.');
    const env = {}; for (const k of ['PATH','TEMP','TMP','SystemRoot','WINDIR','HOME','USERPROFILE']) if (process.env[k]) env[k]=process.env[k];
    if (args.env && typeof args.env==='object') for (const [k,v] of Object.entries(args.env)) if (/^[A-Z_][A-Z0-9_]{0,63}$/i.test(k) && !/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|NODE_.*|ELECTRON_.*|LD_.*|DYLD_.*)$/i.test(k)) env[k]=String(v).slice(0,4096);
    const child = spawn(command, argv, { cwd, env, windowsHide:true, shell:false, stdio:['pipe','pipe','pipe'] });
    const processId = 'p-' + crypto.randomBytes(8).toString('hex'); let outputBytes = 0;
    const forward = (stream, chunk) => { outputBytes += chunk.length; if (outputBytes > 16e6) { try { child.kill(); } catch {} nodeHostLog(host,'warning','Managed extension process exceeded the 16 MB output cap and was stopped.'); return; } try { nodeHostSend(host,{type:'processOutput',processId,stream,data:chunk.toString('base64')}); } catch {} };
    child.stdout.on('data',c=>forward('stdout',c)); child.stderr.on('data',c=>forward('stderr',c));
    child.on('error',e=>{ host.processes.delete(processId); try { nodeHostSend(host,{type:'processExit',processId,code:-1,signal:null,error:e.message}); } catch {} });
    child.on('close',(code,signal)=>{ host.processes.delete(processId); try { nodeHostSend(host,{type:'processExit',processId,code,signal}); } catch {} });
    host.processes.set(processId,child); const timeout=setTimeout(()=>{ if(host.processes.has(processId)){nodeHostLog(host,'warning','Managed extension process reached its 30 minute limit and was stopped.');try{child.kill();}catch{}} },30*60*1000); timeout.unref?.(); child.once('close',()=>clearTimeout(timeout));
    return { processId, pid: child.pid };
  }
  const id=String(args.processId||''), child=host.processes.get(id); if(!child) throw new Error('Managed extension process not found.');
  if (method==='process.write') { const data=String(args.data||''); if(data.length>1e6)throw new Error('Process input exceeds 1 MB.'); if(!child.stdin.destroyed)child.stdin.write(data); return {ok:true}; }
  if (method==='process.end') { child.stdin.end(); return {ok:true}; }
  if (method==='process.kill') { child.kill(String(args.signal||'SIGTERM')); return {ok:true}; }
  throw new Error('Unsupported managed process operation.');
}
function nodeHostTerminalRpc(host, method, args) {
  if (permLoad().terminal !== 'allow') throw new Error('Terminal permission must be set to Allow before an extension can create or control terminals.');
  if (method==='terminal.create') { const cwd=args.cwd ? nodeHostWorkspacePath({path:String(args.cwd)}) : ROOT || host.extensionDir; const t=termStart({cwd,name:String(args.name||'Extension Terminal').slice(0,80)}); host.terminals.add(t.id); return {id:t.id,pid:t.proc.pid}; }
  const id=String(args.id||''); if(!host.terminals.has(id))throw new Error('This extension does not own that terminal.');
  if(method==='terminal.write'){termWrite({id,data:String(args.data||'').slice(0,100000)});return {ok:true};}
  if(method==='terminal.show')return {ok:true,show:true,id};
  if(method==='terminal.close'){const t=termGet(id);termStop(t,true);host.terminals.delete(id);return {ok:true};}
  throw new Error('Unsupported terminal API operation.');
}
function nodeHostWebviewRpc(host, method, args) {
  const id=String(args.panelId||'');
  if(method==='webview.create'){if(!/^wv-[0-9]+$/.test(id))throw new Error('Invalid webview id');if(host.webviews.size>=4)throw new Error('An extension can open at most four webview panels.');host.webviews.set(id,{panelId:id,title:String(args.title||'Extension View').slice(0,120),viewType:String(args.viewType||'extension'),html:'',visible:true,options:args.options||{},messages:[]});return {ok:true,panelId:id};}
  const view=host.webviews.get(id);if(!view)throw new Error('Webview panel not found.');
  if(method==='webview.update'){const html=String(args.html||'');if(html.length>2e6)throw new Error('Webview HTML exceeds the 2 MB limit.');view.html=html;view.title=String(args.title||view.title).slice(0,120);return {ok:true};}
  if(method==='webview.post'){view.messages=view.messages||[];view.messages.push(args.message);if(view.messages.length>50)view.messages.shift();return {ok:true};}
  if(method==='webview.reveal'){view.visible=true;return {ok:true};}
  if(method==='webview.dispose'){host.webviews.delete(id);return {ok:true};}
  throw new Error('Unsupported webview operation.');
}
async function nodeHostDebugRpc(host, method, args) {
  if(permLoad().terminal!=='allow')throw new Error('Terminal permission must be set to Allow before an extension can launch a debugger.');
  if(method==='debug.start'){const started=nodeHostProcessRpc(host,'process.spawn',{command:args.command,args:args.args||[],cwd:args.cwd});const sessionId='dbg-'+crypto.randomBytes(8).toString('hex');host.debugSessions.set(sessionId,{sessionId,type:String(args.type||''),name:String(args.configuration&&args.configuration.name||args.type||'Debug session'),processId:started.processId,state:'adapter-started'});nodeHostLog(host,'info','Debug adapter launched for '+String(args.type||'unknown')+'. The Debug Adapter Protocol initialize/launch handshake is managed by CodeSpace.');return {sessionId,processId:started.processId};}
  const session=host.debugSessions.get(String(args.sessionId||''));if(!session)throw new Error('Debug session not found.');
  if(method==='debug.request'){const proc=host.processes.get(session.processId);if(!proc)throw new Error('Debug adapter process is not running.');const command=String(args.command||'');if(!/^[a-z][a-zA-Z0-9]{0,80}$/.test(command))throw new Error('Invalid debug protocol request.');const frame={seq:Date.now()%1000000000,type:'request',command,arguments:args.args||{}};const body=Buffer.from(JSON.stringify(frame));proc.stdin.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]));return {sent:true};}
  if(method==='debug.stop'){const proc=host.processes.get(session.processId);if(proc)proc.kill();host.debugSessions.delete(session.sessionId);return {ok:true};}
  throw new Error('Unsupported debug API operation.');
}
function nodeHostMessage(host, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') {
    host.ready = true; host.commands = new Map((msg.commands || []).map(command => [String(command), { command: String(command), title: String(command) }]));
    if (host.readyResolve) host.readyResolve();
  } else if (msg.type === 'commandRegistered') {
    const command = String(msg.command || ''); if (/^[\w.-]{2,160}$/.test(command)) host.commands.set(command, { command, title: command });
  } else if (msg.type === 'commandRemoved') host.commands.delete(String(msg.command || ''));
  else if (msg.type === 'featureRegistered') { const id=String(msg.id||''); if(/^feature-\d+$/.test(id)) (host.features||(host.features=new Map())).set(id,{id,name:String(msg.name||'')}); }
  else if (msg.type === 'featureUnregistered') { if(host.features)host.features.delete(String(msg.id||'')); }
  else if (msg.type === 'webviewViewRegistered') { const viewType=String(msg.viewType||''); if(/^[\w.-]{1,120}$/.test(viewType))(host.viewProviders||(host.viewProviders=new Map())).set(viewType,{viewType}); }
  else if (msg.type === 'webviewViewUnregistered') { if(host.viewProviders)host.viewProviders.delete(String(msg.viewType||'')); }
  else if (msg.type === 'diagnostics') { const key=String(msg.collection||'default')+'|'+String(msg.uri||''); const list=Array.isArray(msg.diagnostics)?msg.diagnostics.slice(0,200):[]; if(list.length)(host.diagnostics||(host.diagnostics=new Map())).set(key,{collection:String(msg.collection||''),uri:String(msg.uri||''),diagnostics:list}); else if(host.diagnostics)host.diagnostics.delete(key); }
  else if (msg.type === 'diagnosticsClear') { if(host.diagnostics){ if(msg.uri){const prefix=String(msg.collection||'default')+'|'+String(msg.uri);host.diagnostics.delete(prefix);} else for(const k of [...host.diagnostics.keys()])if(k.startsWith(String(msg.collection||'default')+'|'))host.diagnostics.delete(k); } }
  else if (msg.type === 'featureResult') { const pending=host.featurePending&&host.featurePending.get(String(msg.requestId||'')); if(pending){clearTimeout(pending.timer);host.featurePending.delete(String(msg.requestId));msg.error?pending.reject(new Error(msg.error)):pending.resolve(msg.result);} }
  else if (msg.type === 'terminalCreated') { if (/^t\d+$/.test(String(msg.id || ''))) host.terminals.add(String(msg.id)); }
  else if (msg.type === 'terminalClosed') host.terminals.delete(String(msg.id || ''));
  else if (msg.type === 'debugStarted') { const sessionId=String(msg.sessionId||''); if(/^dbg-/.test(sessionId))host.debugSessions.set(sessionId,{sessionId,type:String(msg.debugType||''),name:String(msg.name||'Debug session'),state:'running'}); }
  else if (msg.type === 'debugTerminated') host.debugSessions.delete(String(msg.sessionId||''));
  else if (msg.type === 'webviewCreated') { /* Webview state is held by the host RPC service. */ }
  else if (msg.type === 'activationError' || msg.type === 'error') {
    const text = String(msg.error || 'Extension activation failed').slice(0, 3000); nodeHostLog(host, 'error', text);
    if (msg.type === 'activationError' || !host.ready) { host.error = text; if (host.readyReject) host.readyReject(new Error(text)); }
  } else if (msg.type === 'log' || msg.type === 'notification' || msg.type === 'output' || msg.type === 'statusBar' || msg.type === 'progress') {
    nodeHostLog(host, msg.level || msg.type, msg.message || msg.text || JSON.stringify(msg));
  } else if (msg.type === 'rpc') {
    Promise.resolve().then(() => nodeHostRpc(host, String(msg.method || ''), msg.args || {})).then(result => nodeHostSend(host, { type: 'rpcResult', requestId: msg.requestId, result: result === undefined ? null : result })).catch(error => nodeHostSend(host, { type: 'rpcResult', requestId: msg.requestId, error: error.message || String(error) }));
  } else if (msg.type === 'commandResult') {
    const p = host.pending.get(String(msg.requestId || '')); if (p) { clearTimeout(p.timer); host.pending.delete(String(msg.requestId)); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); }
  }
}
function prepareCodeSpaceVscodeEsmShim(extensionDir) {
  const nodeModules = path.join(extensionDir, 'node_modules'), pkgDir = path.join(nodeModules, 'vscode');
  if (fs.existsSync(pkgDir)) throw new Error('This ES module extension contains its own runtime dependency named "vscode"; CodeSpace cannot safely replace it with the VS Code API bridge.');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name:'vscode', version:'1.90.0-codespace', type:'module', exports:{ import:'./index.mjs', require:'./index.cjs' } }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), `const api = globalThis.__codespaceVscode;
if (!api) throw new Error('CodeSpace VS Code API bridge was not initialized');
export default api;
${['commands','workspace','window','env','languages','extensions','debug','Uri','Position','Range','Selection','Location','Diagnostic','DiagnosticSeverity','CompletionItem','CompletionItemKind','TextEdit','WorkspaceEdit','MarkdownString','CancellationTokenSource','Disposable','EventEmitter','ExtensionMode','ExtensionKind','FileType','FileSystemError','StatusBarAlignment','ProgressLocation','ConfigurationTarget','CodeActionKind','DebugAdapterExecutable'].map(k=>`export const ${k} = api.${k};`).join('\n')}
`);
  fs.writeFileSync(path.join(pkgDir, 'index.cjs'), `module.exports = globalThis.__codespaceVscode;
`);
}
async function nodeHostStart(b) {
  const key = String(b.key || ''); if (!/^[a-f0-9]{24}$/.test(key)) throw new Error('Invalid installed extension key');
  const existing = VSCODE_NODE_HOSTS.get(key); if (existing && existing.child.exitCode === null && !existing.error) return { ok: true, ...nodeHostInfo(key) };
  if (existing) nodeHostStop(key);
  const dir = path.resolve(VSCODE_EXT_DIR, key), state = readJson(path.join(dir, 'codespace-install.json'), null), pkg = readJson(path.join(dir, 'package.json'), {});
  if (!inside(VSCODE_EXT_DIR, dir) || !state || state.hostType !== 'node' || !state.mainPath) throw new Error('This extension is not installed for the Node.js Extension Host.');
  if ((state.requiresNativeCode || state.requiresNativeAddons) && permLoad().nativeCode !== 'allow') throw new Error('This extension includes native binaries or Node add-ons. Set the Native extension code permission to Allow only after trusting this publisher.');
  const nodeVersion = process.versions.node.split('.').map(Number); if (nodeVersion[0] < 22 || nodeVersion[0] === 22 && nodeVersion[1] < 15) throw new Error('The CodeSpace Node Extension Host requires Node.js 22.15 or newer for the safe ESM module hooks. Rebuild CodeSpace with its bundled Node 22 runtime.');
  fs.mkdirSync(VSCODE_NODE_STATE, { recursive: true }); const stateDir = path.join(VSCODE_NODE_STATE, key); fs.mkdirSync(stateDir, { recursive: true });
  const activeHosts = [...VSCODE_NODE_HOSTS.values()].filter(h => h.child && h.child.exitCode === null && !h.error).length;
  if (activeHosts >= 8) throw new Error('CodeSpace allows at most 8 active Node.js extension hosts at once. Stop another extension first.');
  const args = ['--permission', '--max-old-space-size=384', '--allow-fs-read=' + dir, '--allow-fs-read=' + VSCODE_NODE_RUNNER, '--allow-fs-read=' + stateDir, '--allow-fs-write=' + stateDir, ...(state.requiresNativeAddons ? ['--allow-addons'] : []), '--disable-proto=throw', '--disallow-code-generation-from-strings', VSCODE_NODE_RUNNER, dir, state.mainPath, key, ROOT || '-', stateDir, state.id, state.requiresNativeAddons ? '1' : '0'];
  const childEnv = {};
  for (const k of ['PATH','TEMP','TMP','SystemRoot','WINDIR']) if (process.env[k]) childEnv[k] = process.env[k];
  const child = spawn(process.execPath, args, { cwd: dir, env: childEnv, windowsHide: true, stdio: ['pipe','pipe','pipe','pipe'] });
  const host = { key, id: state.id, child, ready: false, error: '', commands: new Map(), features: new Map(), viewProviders: new Map(), diagnostics: new Map(), featurePending: new Map(), pending: new Map(), logs: [], lineBuffer: '', extensionDir: dir, stateDir, processes: new Map(), terminals: new Set(), webviews: new Map(), debugSessions: new Map() };
  VSCODE_NODE_HOSTS.set(key, host);
  host.readyPromise = new Promise((resolve, reject) => { host.readyResolve = resolve; host.readyReject = reject; });
  const parse = chunk => {
    host.lineBuffer += chunk.toString('utf8');
    if (host.lineBuffer.length > 2e6) { host.error = 'Extension host IPC buffer exceeded its size limit'; nodeHostStop(key); return; }
    let cut; while ((cut = host.lineBuffer.indexOf('\n')) >= 0) { const line = host.lineBuffer.slice(0, cut); host.lineBuffer = host.lineBuffer.slice(cut + 1); try { nodeHostMessage(host, JSON.parse(line)); } catch (e) { nodeHostLog(host, 'error', 'Extension host message error: ' + e.message); } }
  };
  child.stdio[3].setEncoding('utf8'); child.stdio[3].on('data', parse);
  child.stdout.on('data', c => nodeHostLog(host, 'stdout', c.toString('utf8')));
  child.stderr.on('data', c => nodeHostLog(host, 'stderr', c.toString('utf8')));
  child.on('error', e => { host.error = e.message; if (host.readyReject) host.readyReject(e); });
  child.on('exit', (code, signal) => {
    if (VSCODE_NODE_HOSTS.get(key) === host) VSCODE_NODE_HOSTS.delete(key);
    host.stopped = true; if (!host.ready && host.readyReject) host.readyReject(new Error(host.error || 'Node extension host exited (' + code + ', ' + signal + ')'));
    for (const p of host.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Node extension host exited')); } host.pending.clear();
  });
  const timeout = new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Node extension activation timed out after 20 seconds')), 20000); t.unref?.(); host.readyPromise.then(() => clearTimeout(t), () => clearTimeout(t)); });
  try { await Promise.race([host.readyPromise, timeout]); }
  catch (e) { nodeHostLog(host, 'error', e.message); nodeHostStop(key); throw e; }
  auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/node/activate', ok: true, status: 200, ms: 0, d: state.id + '@' + state.version });
  return { ok: true, ...nodeHostInfo(key), runtime: 'CodeSpace Node.js Extension Host', permissionModel: true };
}
async function nodeHostFeatureRequest(b) {
  const key=String(b.key||''), feature=String(b.feature||''); if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key); if(!host||!host.ready)throw new Error('Node extension host is not active');
  const allowed=new Set(['completion','hover','definition','references','formatting','rangeFormatting','codeActions','rename','signatureHelp','documentSymbols','codeLens']); if(!allowed.has(feature))throw new Error('Unsupported language feature request');
  const providers=[...(host.features||new Map()).values()].filter(x=>x.name===feature); if(!providers.length)return {results:[]};
  const params=b.params&&typeof b.params==='object'?{...b.params}:{}; if(params.path) { const file=nodeHostWorkspacePath({path:String(params.path)}); params.path=path.relative(ROOT,file).replace(/\\/g,'/'); } const results=[];
  for(const provider of providers.slice(0,8)) {
    const requestId='feat-'+crypto.randomBytes(8).toString('hex');
    const resultPromise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{host.featurePending.delete(requestId);reject(new Error('Language feature provider timed out'));},5000);host.featurePending.set(requestId,{resolve,reject,timer});});
    nodeHostSend(host,{type:'featureRequest',requestId,featureId:provider.id,params});
    try { const result=await resultPromise; if(Array.isArray(result))results.push(...result.slice(0,100)); else if(result!==undefined&&result!==null)results.push(result); } catch(e) { nodeHostLog(host,'warning','Language feature '+feature+' failed: '+e.message); }
  }
  return {results:results.slice(0,100)};
}
function nodeHostOpenWebviewView(b) {
  const key=String(b.key||''), viewType=String(b.viewType||''); if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key); if(!host||!host.ready||!host.viewProviders||!host.viewProviders.has(viewType))throw new Error('This extension has not registered that webview view');
  nodeHostSend(host,{type:'openWebviewView',viewType}); return {ok:true};
}
function nodeHostDocumentSync(b) {
  const key=String(b.key||''); if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key); if(!host||!host.ready)return {ok:false};
  const event=String(b.event||''); if(!['open','change','save','close'].includes(event))throw new Error('Invalid document synchronization event');
  const file=String(b.path||''); if(!file||file.length>2048)throw new Error('Invalid workspace document path');
  const full=nodeHostWorkspacePath({path:file});
  const rel=path.relative(ROOT,full).replace(/\\/g,'/');
  if(event!=='close' && typeof b.text!=='string')throw new Error('Document text is required');
  if(String(b.text||'').length>1000000)throw new Error('Document exceeds the 1 MB extension synchronization limit');
  nodeHostSend(host,{type:'documentSync',event,path:rel,text:String(b.text||''),languageId:String(b.languageId||path.extname(file).slice(1)),version:Math.max(1,Number(b.version)||1)});
  return {ok:true};
}
async function nodeHostCommand(b) {
  const key = String(b.key || ''), command = String(b.command || '');
  if (!/^[a-f0-9]{24}$/.test(key) || !/^[\w.-]{2,160}$/.test(command)) throw new Error('Invalid extension command');
  if (permDenyOnly('ext')) throw new Error('Extension execution is blocked by CodeSpace permission settings.');
  const host = VSCODE_NODE_HOSTS.get(key); if (!host || !host.ready || host.error) throw new Error('Node extension host is not running.');
  if (!host.commands.has(command)) throw new Error('This extension has not registered that command.');
  const requestId = 'cmd-' + crypto.randomBytes(10).toString('hex');
  const args = Array.isArray(b.args) ? b.args.slice(0, 20) : [];
  const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { host.pending.delete(requestId); nodeHostStop(key); reject(new Error('Extension command timed out; the unresponsive extension host was stopped.')); }, 60000); host.pending.set(requestId, { resolve, reject, timer }); });
  nodeHostSend(host, { type: 'runCommand', requestId, command, args });
  const result = await response; auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/node/command', ok: true, status: 200, ms: 0, d: host.id + ' → ' + command });
  return { ok: true, result, logs: host.logs.slice(-10) };
}

function nodeHostDebugStop(b) {
  const key=String(b.key||''), sessionId=String(b.sessionId||'');
  if(!/^[a-f0-9]{24}$/.test(key) || !/^dbg-/.test(sessionId)) throw new Error('Invalid extension debug session');
  if(permLoad().terminal!=='allow') throw new Error('Terminal permission must be set to Allow before stopping an extension debugger.');
  const host=VSCODE_NODE_HOSTS.get(key);
  if(!host || !host.debugSessions.has(sessionId)) return {ok:true,stopped:false};
  nodeHostSend(host,{type:'stopDebug',sessionId});
  return {ok:true,stopping:true,sessionId};
}
function nodeHostWebviewMessage(b) {
  const key=String(b.key||''), panelId=String(b.panelId||''); if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key), view=host&&host.webviews.get(panelId); if(!view)throw new Error('Webview panel not found.');
  const message=b.message; const encoded=JSON.stringify(message===undefined?null:message); if(encoded.length>100000)throw new Error('Webview message exceeds 100 KB.');
  nodeHostSend(host,{type:'webviewMessage',panelId,message:message===undefined?null:message}); return {ok:true};
}
function nodeHostWebviewClose(b) {
  const key=String(b.key||''),panelId=String(b.panelId||'');if(!/^[a-f0-9]{24}$/.test(key))throw new Error('Invalid extension key');
  const host=VSCODE_NODE_HOSTS.get(key);if(!host||!host.webviews.has(panelId))return {ok:true};
  host.webviews.delete(panelId);nodeHostSend(host,{type:'webviewDisposed',panelId});return {ok:true};
}
function mktUninstall(b) {
  const key = String(b.key || '');
  if (!/^[a-f0-9]{24}$/.test(key)) throw new Error('Invalid installed extension key');
  const dir = path.resolve(VSCODE_EXT_DIR, key);
  if (!inside(VSCODE_EXT_DIR, dir)) throw new Error('Invalid extension path');
  nodeHostStop(key);
  fs.rmSync(dir, { recursive: true, force: true });
  auditWrite({ t: new Date().toISOString(), ep: '/ext/marketplace/uninstall', ok: true, status: 200, ms: 0, d: key });
  return { ok: true };
}

async function extInstall(b) {
  fs.mkdirSync(EXT_DIR, { recursive: true });
  const write = (name, manifest, copyFrom) => {
    if (!VALID_NAME.test(name)) throw new Error('Extension names may only use letters, numbers, dot, dash and underscore');
    validManifest(manifest);
    const dir = path.join(EXT_DIR, name);
    if (MCPS.has(name)) { MCPS.get(name).stop(); MCPS.delete(name); }
    if (copyFrom) fs.cpSync(copyFrom, dir, { recursive: true, force: true, filter: p => path.basename(p) !== '.git' }); else fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ ...manifest, name }, null, 2));
    return name;
  };
  if (b.manifest && typeof b.manifest === 'object') return { installed: [write(String(b.name || b.manifest.name || ''), b.manifest)] };
  const src = String(b.source || '').trim();
  if (!src) throw new Error('Give a source or a manifest');
  if (/^npm:/i.test(src)) {
    const pkg = src.slice(4).trim();
    if (!/^(@[\w.-]+\/)?[\w.-]+(@[\w.-]+)?$/.test(pkg)) throw new Error('Invalid npm package name');
    const extra = Array.isArray(b.args) ? b.args : String(b.args || '').split(/\s+/).filter(Boolean);
    const name = String(b.name || pkg.replace(/^@/, '').replace(/@[\w.-]+$/, '').replace(/[^\w.-]+/g, '-'));
    return { installed: [write(name, { description: 'MCP server from npm: ' + pkg, installSource: 'npm:' + pkg, installArgs: extra, mcp: { command: 'npx', args: ['-y', pkg, ...extra] } })] };
  }
  let url = /^[\w.-]+\/[\w.-]+$/.test(src) ? 'https://github.com/' + src : src;
  if (!/^https:\/\//i.test(url)) throw new Error('Source must be npm:package, an https link, or owner/repo');
  const blob = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (blob) url = 'https://raw.githubusercontent.com/' + blob[1] + '/' + blob[2] + '/' + blob[3];
  if (/\.json(\?|$)/i.test(url)) {
    const r = await fetch(url); if (!r.ok) throw new Error('Download failed: ' + r.status);
    const m = await r.json();
    return { installed: [write(String(b.name || m.name || ''), m)] };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ext-'));
  try {
    const { via } = await repoToDir(url, tmp);   /* 3.13.4: git when present, ZIP fallback otherwise */
    const repo = path.join(tmp, 'repo');
    const found = [];
    (function find(dir, depth) {
      if (depth > 3) return;
      if (fs.existsSync(path.join(dir, 'extension.json'))) found.push(dir);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') find(path.join(dir, e.name), depth + 1);
    })(repo, 0);
    if (!found.length) throw new Error('No extension.json found in that repository');
    const installed = [];
    for (const dir of found.slice(0, 10)) {
      const m = readJson(path.join(dir, 'extension.json'), null);
      installed.push(write(String(b.name && found.length === 1 ? b.name : (m && m.name) || path.basename(dir)), m, dir));
    }
    return { installed, via };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function extToggle(b) {
  const x = extFind(String(b.name || '')), st = readJson(EXT_STATE, {});
  st[x.name] = { enabled: !!b.enabled }; writeJson(EXT_STATE, st);
  if (!b.enabled && MCPS.has(x.name)) { MCPS.get(x.name).stop(); MCPS.delete(x.name); }
  return { ok: true };
}
function extRemove(b) {
  const x = extFind(String(b.name || ''));
  if (MCPS.has(x.name)) { MCPS.get(x.name).stop(); MCPS.delete(x.name); }
  fs.rmSync(x.dir, { recursive: true, force: true });
  const st = readJson(EXT_STATE, {}); delete st[x.name]; writeJson(EXT_STATE, st);
  return { removed: x.name };
}

/* ---------- workspace folder (Open folder) ---------- */
/* ---------- Browser Bridge: the CodeSpace Bridge Chrome extension long-polls here; the AI's browser_* tools queue commands for it ---------- */
const BRIDGE = { lastPoll: 0, ever: false, queue: [], waiter: null, pending: new Map(), seq: 0 };
const BRIDGE_ACTIONS = new Set(['tabs', 'open', 'read', 'click', 'type', 'scroll', 'screenshot', 'eval', 'console', 'network', 'close']);
const bridgeConnected = () => Date.now() - BRIDGE.lastPoll < 45000;
const bridgeStatus = () => ({ connected: bridgeConnected(), ever: BRIDGE.ever, lastSeenMs: BRIDGE.lastPoll ? Date.now() - BRIDGE.lastPoll : null, pending: BRIDGE.pending.size });
function bridgeDeliver() {
  if (BRIDGE.waiter && BRIDGE.queue.length) { const w = BRIDGE.waiter; BRIDGE.waiter = null; clearTimeout(w.timer); w.finish({ cmd: BRIDGE.queue.shift() }); }
}
function bridgePoll(req, res) {
  BRIDGE.lastPoll = Date.now(); BRIDGE.ever = true;
  if (BRIDGE.waiter) { const old = BRIDGE.waiter; BRIDGE.waiter = null; clearTimeout(old.timer); old.finish({ cmd: null }); }
  let done = false;
  const finish = obj => { if (done) return; done = true; BRIDGE.lastPoll = Date.now(); try { send(res, 200, obj); } catch {} };
  const w = { finish, timer: setTimeout(() => { if (BRIDGE.waiter === w) BRIDGE.waiter = null; finish({ cmd: null }); }, 20000) };
  res.once('close', () => { if (BRIDGE.waiter === w) { BRIDGE.waiter = null; clearTimeout(w.timer); } done = true; });
  BRIDGE.waiter = w; bridgeDeliver();
}
function bridgeResult(b) {
  const id = String(b.id || ''), p = BRIDGE.pending.get(id);
  if (!p) return { ok: false, error: 'Unknown or expired command' };
  BRIDGE.pending.delete(id); clearTimeout(p.timer);
  if (b.ok === false) p.resolve({ ok: false, error: String(b.error || 'The extension reported an error').slice(0, 2000) });
  else p.resolve({ ok: true, result: b.result === undefined ? null : b.result });
  return { ok: true };
}
function bridgeCall(b) {
  if (!BRIDGE_ACTIONS.has(String(b.action))) throw new Error('Unsupported browser bridge action');
  if (!bridgeConnected()) throw new Error('The CodeSpace Bridge extension is not connected. Open its popup in Chrome, paste the bridge token, and turn it on.');
  const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
  if (JSON.stringify(args).length > 200000) throw new Error('Browser bridge arguments are too large');
  const id = 'c' + (++BRIDGE.seq) + '-' + crypto.randomBytes(4).toString('hex');
  const timeoutMs = Math.max(3000, Math.min(Number(b.timeoutMs) || 40000, 90000));
  return new Promise(resolve => {
    const timer = setTimeout(() => { BRIDGE.pending.delete(id); BRIDGE.queue = BRIDGE.queue.filter(c => c.id !== id); resolve({ ok: false, error: 'The browser did not answer in time. Check that Chrome is open and the CodeSpace Bridge extension is on.' }); }, timeoutMs);
    BRIDGE.pending.set(id, { resolve, timer });
    BRIDGE.queue.push({ id, action: String(b.action), args }); bridgeDeliver();
  });
}

const infoObj = () => ({ root: ROOT, platform: process.platform, shell: process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh'), node: process.version, python: PYTHON, git: GIT_OK, skillsDir: SKILLS_USER, browser: !!CHROME || BRIDGE.ever || process.env.MY_AGENT_DISABLE_EXTERNAL_BROWSER === '1', bridge: bridgeConnected(), browserShown: SHOW_BROWSER, shells: SHELLS.map(x => ({ id: x.id, label: x.label })), ptyAvailable: !!ptyLib, terminalEmulator: !!ptyLib, dataDir: DATA, configFile: CONFIG_FILE, mysql: !!findMysql2() || MYSQL_CLI, mysqlVia: findMysql2() ? 'mysql2' : (MYSQL_CLI ? 'mysql CLI' : '') });
function codespaceInstallationLocation() {
  return getInstallLocation({
    appRoot: process.env.CODESPACE_APP_ROOT || __dirname,
    backendRoot: __dirname,
    backendFile: __filename,
    launcherPath: process.env.CODESPACE_LAUNCHER_PATH || process.execPath,
    portableDirectory: process.env.CODESPACE_PORTABLE_DIR || '',
    resourcesDirectory: process.env.CODESPACE_RESOURCES_PATH || '',
    packaged: process.env.CODESPACE_PACKAGED === '1'
  });
}
function wsSave() {
  const w = readJson(WORKSPACE_FILE, {});
  writeJson(WORKSPACE_FILE, { path: ROOT, recent: [ROOT, ...(w.recent || []).filter(x => x !== ROOT)].filter(Boolean).slice(0, 8) });
}
function wsDirs(b) {
  const p = path.resolve(String(b.path || '').trim() || os.homedir());
  if (!isDir(p)) throw new Error('Folder not found: ' + p);
  let dirs = [];
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      let d = e.isDirectory(); if (!d && e.isSymbolicLink()) d = isDir(path.join(p, e.name));
      if (d) dirs.push(e.name);
    }
  } catch (e) { throw new Error('Cannot read this folder: ' + e.message); }
  dirs.sort((x, y) => x.localeCompare(y)); const truncated = dirs.length > 500; dirs = dirs.slice(0, 500);
  const places = [{ name: 'Home', path: os.homedir() }];
  for (const n of ['Desktop', 'Documents', 'Downloads', 'Projects', 'source', 'code', 'dev']) { const q = path.join(os.homedir(), n); if (isDir(q)) places.push({ name: n, path: q }); }
  if (WIN) { for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (isDir(d)) places.push({ name: d, path: d }); } } else places.push({ name: '/', path: '/' });
  return { path: p, sep: path.sep, parent: path.dirname(p) === p ? null : path.dirname(p), dirs, truncated, places, recent: (readJson(WORKSPACE_FILE, {}).recent || []).filter(isDir), current: ROOT };
}
function wsSet(b) {
  const p = path.resolve(String(b.path || ''));
  if (!isDir(p)) throw new Error('That folder does not exist');
  ROOT = fs.realpathSync(p); invalidateCodeIndex('workspace changed'); wsSave(); return infoObj();
}
function wsClose() { ROOT = null; invalidateCodeIndex('workspace closed'); writeJson(WORKSPACE_FILE, { recent: readJson(WORKSPACE_FILE, {}).recent || [] }); return infoObj(); }
/* 3.13.5: the OS folder picker. The explorer's "Open folder" button opens the platform's own
   folder dialog (PowerShell FolderBrowserDialog on Windows, AppleScript on macOS, zenity on
   Linux) when the bridge is local. One dialog at a time; async so the server stays responsive
   while the dialog is open. Returns { path } or { cancelled: true } (also when no picker exists). */
let NATIVE_PICK_BUSY = false;
function nativeFolderPick() {
  if (NATIVE_PICK_BUSY) return Promise.resolve({ cancelled: true, note: 'A folder dialog is already open.' });
  const cmd = process.platform === 'win32'
    ? { file: 'powershell', args: ['-NoProfile', '-STA', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Choose a folder to open in CodeSpace"; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'] }
    : process.platform === 'darwin'
      ? { file: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Choose a folder to open in CodeSpace")'] }
      : { file: 'zenity', args: ['--file-selection', '--directory', '--title', 'Choose a folder to open in CodeSpace'] };
  return new Promise(resolve => {
    NATIVE_PICK_BUSY = true;
    let out = '', done = false;
    const finish = v => { if (done) return; done = true; NATIVE_PICK_BUSY = false; try { ch.kill(); } catch {} resolve(v); };
    const ch = spawn(cmd.file, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.on('data', c => { out += c; });
    ch.on('error', e => finish({ cancelled: true, note: 'No native folder picker on this computer (' + (e.message || cmd.file) + ').' }));
    ch.on('close', () => { const p = out.trim(); finish(p ? { path: p.replace(/\/$/, '') || p, native: true } : { cancelled: true }); });
    const timer = setTimeout(() => finish({ cancelled: true, note: 'The folder dialog stayed open too long.' }), 600000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/* ---------- git ---------- */
function git(args, o = {}) {
  if (!GIT_OK) throw new Error('git is not installed on this computer');
  if (!ROOT) throw new Error('No folder is open. Use File > Open Folder in the app first.');
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: o.timeout || 30000, maxBuffer: 20e6, env: { ...cmdEnv(o.conn), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || (r.error && r.error.message) || '' };
}
function gitOk(r, what) {
  if (r.code !== 0) throw new Error((what ? what + ': ' : '') + (r.err.trim() || r.out.trim() || 'git failed').slice(0, 500));
  return r;
}
const relPaths = list => (Array.isArray(list) ? list : [list]).map(p => path.relative(ROOT, safe(p)) || '.');
function gitStatus() {
  if (!GIT_OK) return { isRepo: false, gitMissing: true };
  if (git(['rev-parse', '--is-inside-work-tree']).code !== 0) return { isRepo: false };
  const r = gitOk(git(['status', '--porcelain=v1', '-b', '-z', '-uall']));
  const parts = r.out.split('\0'), head = parts.shift() || '';
  let branch = '', upstream = '', ahead = 0, behind = 0;
  const m = head.match(/^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
  if (m) { branch = m[1]; upstream = m[2] || ''; const a = (m[3] || '').match(/ahead (\d+)/), b = (m[3] || '').match(/behind (\d+)/); ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0; }
  branch = branch.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
  if (/^HEAD \(no branch\)/.test(branch)) branch = 'HEAD (detached)';
  const files = [];
  for (let i = 0; i < parts.length && files.length < 800; i++) {
    const e = parts[i]; if (!e) continue;
    const x = e[0], y = e[1], p = e.slice(3);
    if (x === 'R' || x === 'C') i++; // the next entry is the old name
    const untracked = x === '?';
    files.push({ path: p, index: untracked || x === ' ' ? '' : x, work: untracked ? 'U' : (y === ' ' ? '' : y), untracked });
  }
  return { isRepo: true, branch, upstream, ahead, behind, files };
}
function gitDiff(b) {
  let r;
  if (b.all) { r = git(['diff', '--no-color', ...(b.staged ? ['--cached'] : ['HEAD'])]); if (r.code !== 0 && !b.staged) r = git(['diff', '--no-color', '--cached']); }
  else {
    const p = relPaths(b.path)[0];
    r = b.untracked ? git(['diff', '--no-index', '--no-color', '--', os.devNull, p]) : git(['diff', '--no-color', ...(b.staged ? ['--cached'] : []), '--', p]);
  }
  if (r.code > 1) throw new Error(r.err.trim().slice(0, 300) || 'git diff failed');
  return { patch: r.out.slice(0, Number(b.max) || 300000) };
}
function gitStage(b) { gitOk(git(['add', '--', ...relPaths(b.paths)])); return { ok: true }; }
function gitUnstage(b) {
  const p = relPaths(b.paths);
  if (git(['restore', '--staged', '--', ...p]).code !== 0) gitOk(git(['rm', '--cached', '-r', '-q', '--', ...p]));
  return { ok: true };
}
function gitDiscard(b) {
  const p = relPaths(b.path)[0];
  if (b.untracked) { fs.rmSync(safe(b.path), { recursive: true, force: true }); invalidateCodeIndex('git discard'); return { ok: true }; }
  if (git(['restore', '--source=HEAD', '--staged', '--worktree', '--', p]).code !== 0) gitOk(git(['rm', '-f', '-q', '--', p]));
  invalidateCodeIndex('git discard');
  return { ok: true };
}
function gitCommit(b) {
  const msg = String(b.message || '').trim();
  if (!msg) throw new Error('Write a commit message first');
  if (b.all) gitOk(git(['add', '-A']));
  const r = git(['commit', '-m', msg]), t = r.err + r.out;
  if (r.code !== 0) {
    if (/Author identity unknown|Please tell me who you are/i.test(t)) throw new Error('Git does not know who you are yet. Run these once in a terminal:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"');
    if (/nothing (added )?to commit|no changes added/i.test(t)) throw new Error('Nothing is staged to commit.');
    throw new Error(t.trim().slice(0, 400));
  }
  return { ok: true, out: r.out.trim().split('\n')[0] };
}
function gitLog(b) {
  const r = git(['log', '-n', String(Math.min(Number(b.n) || 15, 50)), '--pretty=format:%h%x1f%s%x1f%an%x1f%cr']);
  if (r.code !== 0) return { commits: [] };
  return { commits: r.out.split('\n').filter(Boolean).map(l => { const [hash, subject, author, when] = l.split('\x1f'); return { hash, subject, author, when }; }) };
}
function gitInit() { gitOk(git(['init'])); return { ok: true }; }
function gitSync(kind) {
  let r = git(kind === 'push' ? ['push'] : ['pull', '--ff-only'], { conn: true, timeout: 120000 });
  if (kind === 'push' && r.code !== 0 && /no upstream branch|--set-upstream/i.test(r.err)) r = git(['push', '-u', 'origin', 'HEAD'], { conn: true, timeout: 120000 });
  gitOk(r, kind === 'push' ? 'Push failed' : 'Pull failed');
  if (kind === 'pull') invalidateCodeIndex('git pull');
  return { out: (r.out + r.err).trim().slice(0, 600) || 'Done.' };
}
function gitBranches() {
  const r = git(['branch', '--format=%(refname:short)']);
  return { branches: r.code === 0 ? r.out.split('\n').map(x => x.trim()).filter(Boolean) : [] };
}
function gitCheckout(b) {
  const name = String(b.branch || '');
  if (!/^[\w./-]{1,100}$/.test(name) || name.startsWith('-')) throw new Error('Invalid branch name');
  gitOk(git(b.create ? ['checkout', '-b', name] : ['checkout', name]));
  invalidateCodeIndex('git checkout');
  return { ok: true };
}
function fsDelete(b) {
  const f = safe(b.path);
  if (f === ROOT) throw new Error('Refusing to delete the workspace folder');
  if (fs.statSync(f).isDirectory()) {
    if (!b.recursive) throw new Error('Refusing to delete a folder');
    fs.rmSync(f, { recursive: true, force: false, maxRetries: 2 });
  } else fs.unlinkSync(f);
  invalidateCodeIndex('file delete'); return { deleted: true };
}
/* 3.13.5: explorer right-click menu — rename/move and new folder. Both go through safe() so
   they stay inside the workspace jail; rename doubles as drag-and-drop move. */
function fsRename(b) {
  const from = safe(b.path);
  if (from === ROOT) throw new Error('Refusing to rename the workspace folder');
  const to = safe(b.to);
  if (from === to) return { renamed: true };
  if (fs.existsSync(to)) throw new Error('Something already exists at "' + path.relative(ROOT, to) + '" — choose a different name.');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  invalidateCodeIndex('file rename');
  return { renamed: true, path: path.relative(ROOT, to).replace(/\\/g, '/') };
}
function fsMkdir(b) {
  const d = safe(b.path);
  if (fs.existsSync(d)) throw new Error('Already exists: ' + path.relative(ROOT, d));
  fs.mkdirSync(d, { recursive: true });
  invalidateCodeIndex('folder create');
  return { created: true, path: path.relative(ROOT, d).replace(/\\/g, '/') };
}

/* ---------- workspace checkpoints ---------- */
const CHECKPOINT_DIR = path.join(DATA, 'checkpoints');
const CP_MAX_FILES = 5000;
const CP_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const cpHash = data => crypto.createHash('sha256').update(data).digest('hex');
const cpRootKey = root => crypto.createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
function cpWorkspace() {
  if (!ROOT) throw new Error('No folder is open. Open a workspace before using checkpoints.');
  return fs.realpathSync(ROOT);
}
function cpBucket(root = cpWorkspace()) {
  const dir = path.join(CHECKPOINT_DIR, cpRootKey(root));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CHECKPOINT_DIR, 0o700); fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}
function cpRel(input) {
  const rel = String(input || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error('Invalid checkpoint file path');
  const parts = rel.split('/');
  if (parts.some(x => !x || x === '.' || x === '..')) throw new Error('Invalid checkpoint file path');
  if (parts.some(x => IGNORE.has(x))) throw new Error('Checkpoint path is in an excluded directory');
  if (parts.some(x => /^\.env(?:$|\.)/i.test(x) || /^\.(?:npmrc|pypirc)$/i.test(x) || /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i.test(x) || /^(?:credentials|secrets?)(?:\.[^.]+)?$/i.test(x) || /\.(?:pem|key|p12|pfx)$/i.test(x))) {
    throw new Error('Sensitive paths are excluded from checkpoints');
  }
  return rel;
}
function cpIsSensitive(rel) {
  try { cpRel(rel); return false; } catch { return true; }
}
function cpInside(base, target) {
  const r = path.relative(base, target);
  return r === '' || (r.split(path.sep)[0] !== '..' && !path.isAbsolute(r));
}
async function cpCurrentFiles(root = cpWorkspace()) {
  const files = new Map();
  const skipped = { sensitive: 0, tooLarge: 0, limit: 0, unreadable: 0 };
  let totalBytes = 0, scanned = 0;
  const fsp = fs.promises;
  for (const f of walk(root)) {
    // Yield to the event loop periodically so checkpointing never blocks other bridge requests.
    if ((++scanned & 15) === 0) await new Promise(r => setImmediate(r));
    const rel = path.relative(root, f.full).split(path.sep).join('/');
    if (cpIsSensitive(rel)) { skipped.sensitive++; continue; }
    if (files.size >= CP_MAX_FILES) { skipped.limit++; continue; }
    try {
      const st = fs.lstatSync(f.full);
      if (!st.isFile() || st.isSymbolicLink()) { skipped.unreadable++; continue; }
      const real = fs.realpathSync(f.full);
      if (!cpInside(root, real)) { skipped.unreadable++; continue; }
      if (st.size > CP_MAX_FILE_BYTES) { skipped.tooLarge++; continue; }
      const data = await fsp.readFile(real);
      if (data.length > CP_MAX_FILE_BYTES) { skipped.tooLarge++; continue; }
      totalBytes += data.length;
      if (totalBytes > CP_MAX_TOTAL_BYTES) { skipped.limit++; totalBytes -= data.length; continue; }
      files.set(rel, { path: rel, full: f.full, size: data.length, sha256: cpHash(data), mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
    } catch { skipped.unreadable++; }
  }
  return { files, skipped, totalBytes, complete: skipped.tooLarge === 0 && skipped.limit === 0 && skipped.unreadable === 0 };
}
function cpIdValid(id) { return /^cp_\d+_[a-f0-9]{8}$/.test(String(id || '')); }
function cpDir(id) {
  if (!cpIdValid(id)) throw new Error('Invalid checkpoint ID');
  const bucket = cpBucket();
  const dir = path.resolve(bucket, String(id));
  if (!cpInside(bucket, dir)) throw new Error('Invalid checkpoint ID');
  return dir;
}
function cpRead(id) {
  const dir = cpDir(id);
  const manifest = readJson(path.join(dir, 'manifest.json'), null);
  if (!manifest || manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.files)) throw new Error('Checkpoint manifest is missing or invalid');
  const root = cpWorkspace();
  const same = process.platform === 'win32' ? String(manifest.workspace).toLowerCase() === root.toLowerCase() : manifest.workspace === root;
  if (!same) throw new Error('This checkpoint belongs to a different workspace');
  return { dir, manifest };
}
function cpFileOnDisk(cp, rel) {
  const valid = cpRel(rel);
  const filesDir = path.join(cp.dir, 'files');
  const f = path.resolve(filesDir, ...valid.split('/'));
  if (!cpInside(filesDir, f)) throw new Error('Checkpoint path escaped its storage directory');
  return f;
}
function cpAssertNoSymlinkComponents(root, rel) {
  const parts = cpRel(rel).split('/');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error('Refusing to restore through a symbolic link: ' + parts.slice(0, i + 1).join('/'));
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error('A parent path is not a directory: ' + parts.slice(0, i + 1).join('/'));
  }
}
function cpList() {
  const root = cpWorkspace(), bucket = cpBucket(root);
  const items = [];
  for (const e of fs.readdirSync(bucket, { withFileTypes: true })) {
    if (!e.isDirectory() || !cpIdValid(e.name)) continue;
    const m = readJson(path.join(bucket, e.name, 'manifest.json'), null);
    if (!m || m.version !== 1 || m.id !== e.name) continue;
    const same = process.platform === 'win32' ? String(m.workspace).toLowerCase() === root.toLowerCase() : m.workspace === root;
    if (!same) continue;
    items.push({ id: m.id, note: m.note || '', createdAt: m.createdAt, fileCount: m.files.length, totalBytes: m.totalBytes || 0, complete: m.complete !== false, skipped: m.skipped || {} });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { checkpoints: items.slice(0, 200), total: items.length };
}
async function cpCreate(b = {}) {
  const root = cpWorkspace(), bucket = cpBucket(root);
  const id = 'cp_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(bucket, id), filesDir = path.join(dir, 'files');
  const note = String(b.note || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); fs.chmodSync(filesDir, 0o700); } catch {}
  const records = [], skipped = { sensitive: 0, tooLarge: 0, limit: 0, unreadable: 0 };
  let totalBytes = 0, scanned = 0;
  const fsp = fs.promises;
  try {
    for (const f of walk(root)) {
      // Async, yielding copy loop: this used to read and hash the whole workspace
      // synchronously before the first AI edit of each turn, freezing the bridge.
      if ((++scanned & 15) === 0) await new Promise(r => setImmediate(r));
      const rel = path.relative(root, f.full).split(path.sep).join('/');
      if (cpIsSensitive(rel)) { skipped.sensitive++; continue; }
      if (records.length >= CP_MAX_FILES) { skipped.limit++; continue; }
      try {
        const st = fs.lstatSync(f.full);
        if (!st.isFile() || st.isSymbolicLink()) { skipped.unreadable++; continue; }
        const real = fs.realpathSync(f.full);
        if (!cpInside(root, real)) { skipped.unreadable++; continue; }
        if (st.size > CP_MAX_FILE_BYTES) { skipped.tooLarge++; continue; }
        const data = await fsp.readFile(real);
        if (data.length > CP_MAX_FILE_BYTES) { skipped.tooLarge++; continue; }
        if (totalBytes + data.length > CP_MAX_TOTAL_BYTES) { skipped.limit++; continue; }
        const relSafe = cpRel(rel), dest = path.resolve(filesDir, ...relSafe.split('/'));
        if (!cpInside(filesDir, dest)) { skipped.unreadable++; continue; }
        await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await fsp.writeFile(dest, data, { mode: 0o600 });
        try { await fsp.chmod(dest, 0o600); } catch {}
        records.push({ path: relSafe, size: data.length, sha256: cpHash(data), mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
        totalBytes += data.length;
      } catch { skipped.unreadable++; }
    }
    const complete = skipped.tooLarge === 0 && skipped.limit === 0 && skipped.unreadable === 0;
    const manifest = { version: 1, id, workspace: root, note, createdAt: new Date().toISOString(), fileCount: records.length, totalBytes, complete, skipped, files: records };
    writeJson(path.join(dir, 'manifest.json'), manifest);
    return { id, note, createdAt: manifest.createdAt, fileCount: records.length, totalBytes, complete, skipped };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
async function cpCompareFull(b) {
  const cp = cpRead(b.id), root = cpWorkspace();
  const snap = new Map(cp.manifest.files.map(f => [cpRel(f.path), f]));
  const curr = await cpCurrentFiles(root);
  const modified = [], missing = [], added = [];
  for (const [rel, old] of snap) {
    const now = curr.files.get(rel);
    if (!now) missing.push(rel);
    else if (now.sha256 !== old.sha256) modified.push(rel);
  }
  for (const rel of curr.files.keys()) if (!snap.has(rel)) added.push(rel);
  const sorted = a => a.sort((x, y) => x.localeCompare(y));
  sorted(modified); sorted(missing); sorted(added);
  return {
    id: cp.manifest.id, note: cp.manifest.note || '', createdAt: cp.manifest.createdAt,
    modifiedCount: modified.length, missingCount: missing.length, addedCount: added.length,
    modified, missing, added,
    complete: cp.manifest.complete !== false && curr.complete,
    checkpointComplete: cp.manifest.complete !== false, currentScanComplete: curr.complete,
    checkpointSkipped: cp.manifest.skipped || {}, currentSkipped: curr.skipped,
    totalBytes: cp.manifest.totalBytes || 0, fileCount: cp.manifest.files.length
  };
}
function cpPublicCompare(cmp) {
  return { ...cmp, modified: cmp.modified.slice(0, 200), missing: cmp.missing.slice(0, 200), added: cmp.added.slice(0, 200) };
}
async function cpCompare(b) { return cpPublicCompare(await cpCompareFull(b)); }

async function cpRestore(b) {
  const cp = cpRead(b.id);
  const cmpFull = await cpCompareFull({ id: b.id });
  const cmp = cpPublicCompare(cmpFull);
  // 3.11: approval is enforced by the destructive-permission guard on this endpoint; the
  // client-declared confirmed flag is no longer trusted (the page shows the comparison itself).
  const removeAdded = b.removeAdded === true;
  if (removeAdded && !cmpFull.complete) throw new Error('Cannot delete post-checkpoint files because this checkpoint/current scan is incomplete. Restore files without deleting added files, or create a complete checkpoint first.');
  const wanted = new Set([...(cmpFull.modified || []), ...(cmpFull.missing || [])]);
  const allowed = new Set(cp.manifest.files.map(f => cpRel(f.path)));
  if (Array.isArray(b.paths) && b.paths.length) {
    wanted.clear();
    for (const p of b.paths) { const r = cpRel(p); if (!allowed.has(r)) throw new Error('Requested restore path is not in this checkpoint: ' + r); wanted.add(r); }
  }
  const added = removeAdded ? new Set(cmpFull.added || []) : new Set();
  if (!wanted.size && !added.size) return { ok: true, restoredCount: 0, removedAddedCount: 0, safetyCheckpointId: null, incompleteCheckpoint: !cmp.complete, comparison: cmp };

  const safety = await cpCreate({ note: 'Automatic safety before restore ' + b.id });
  const records = new Map(cp.manifest.files.map(f => [cpRel(f.path), f]));
  let restoredCount = 0, removedAddedCount = 0;
  try {
    for (const rel of wanted) {
      const rec = records.get(rel); if (!rec) continue;
      const source = cpFileOnDisk(cp, rel), raw = fs.readFileSync(source);
      if (cpHash(raw) !== rec.sha256) throw new Error('Checkpoint data failed integrity verification: ' + rel);
      cpAssertNoSymlinkComponents(ROOT, rel);
      const target = safe(rel, ROOT);
      if (fs.existsSync(target)) {
        const st = fs.lstatSync(target);
        if (st.isSymbolicLink() || !st.isFile()) throw new Error('Refusing to overwrite a non-regular file: ' + rel);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.my-agent-restore-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.tmp';
      let fd;
      try {
        fd = fs.openSync(tmp, 'wx', rec.mode || 0o600);
        fs.writeFileSync(fd, raw);
        fs.fsyncSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      try { fs.chmodSync(tmp, rec.mode || 0o600); } catch {}
      try { fs.renameSync(tmp, target); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      restoredCount++;
    }
    if (removeAdded) {
      for (const rel of added) {
        cpAssertNoSymlinkComponents(ROOT, rel);
        const target = safe(rel, ROOT);
        if (!fs.existsSync(target)) continue;
        const st = fs.lstatSync(target);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        fs.unlinkSync(target); removedAddedCount++;
      }
    }
  } catch (e) {
    throw new Error('Restore did not finish. Safety checkpoint ID: ' + safety.id + '. Some files may already have been restored; compare/restore this safety checkpoint if needed. Details: ' + (e.message || String(e)));
  }
  invalidateCodeIndex('checkpoint restore');
  return { ok: true, restoredCount, removedAddedCount, safetyCheckpointId: safety.id, safetyCheckpointComplete: safety.complete, incompleteCheckpoint: !cmpFull.complete, comparison: cmp };
}
function cpDelete(b) {
  const cp = cpRead(b.id);
  fs.rmSync(cp.dir, { recursive: true, force: true });
  return { deleted: b.id };
}

/* ---------- low-latency SSE streams (authenticated; no third-party packages) ---------- */
function streamHeaders(res) { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': connected\n\n'); }
function previewStream(req, res) {
  streamHeaders(res); BR.frameClients.add(res);
  if (BR.latestFrame) sendSse(res, BR.latestFrame);
  const heartbeat = setInterval(() => { try { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); } catch {} }, 15000);
  const cleanup = () => { clearInterval(heartbeat); BR.frameClients.delete(res); if (!BR.frameClients.size && BR.cdp && BR.screencastOn) { BR.cdp.send('Page.stopScreencast').catch(() => {}); BR.screencastOn = false; } };
  req.on('close', cleanup); res.on('close', cleanup);
}
function terminalStream(req, res, u) {
  const id = String(u.searchParams.get('id') || ''), t = termGet(id);
  streamHeaders(res);
  const sinceArg = Number(u.searchParams.get('since')) || 0, since = Math.max(t.base, sinceArg);
  sendSse(res, { type: 'terminal', id, data: t.buf.slice(Math.max(0, since - t.base)), next: t.base + t.buf.length, exited: t.exited, code: t.code });
  const clients = TERM_STREAMS.get(id) || new Set(); clients.add(res); TERM_STREAMS.set(id, clients);
  const heartbeat = setInterval(() => { try { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n'); } catch {} }, 15000);
  const cleanup = () => { clearInterval(heartbeat); clients.delete(res); if (!clients.size) TERM_STREAMS.delete(id); };
  req.on('close', cleanup); res.on('close', cleanup);
}

/* ================= 3.10/3.11: web research tools + SSRF-hardened outbound fetch ================= */
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 CodeSpaceAgent/3.12';
/* 3.11 shared secure outbound HTTP layer (used by web_search / web_open / web_fetch / web_extract /
   web_find / web_crawl / http_request / API collections / robots.txt):
   - validates the URL scheme (http/https only)
   - resolves IPv4 AND IPv6 (A + AAAA) and blocks private, loopback, link-local, multicast,
     reserved, unspecified, ULA, CGNAT, documentation and IPv4-mapped-IPv6 ranges
   - connects to a VALIDATED address (the resolved IP) instead of check-then-fetch, which closes
     the DNS-rebinding window; TLS keeps verifying the hostname via SNI
   - revalidates EVERY redirect destination individually and caps the redirect chain
   - connection/response timeouts and request/response size limits
   - loopback/dev endpoints require explicit configuration (MY_AGENT_ALLOW_LOOPBACK=1) or the
     per-call allowLoopback opt-in used by the test suite
   - DNS resolution is injectable (MY_AGENT_DNS_OVERRIDE='{"host":"1.2.3.4"}') for deterministic tests */
const netMod = require('net');
const ALLOW_LOOPBACK = process.env.MY_AGENT_ALLOW_LOOPBACK === '1';
const DNS_OVERRIDE = (() => { try { return JSON.parse(process.env.MY_AGENT_DNS_OVERRIDE || '{}'); } catch { return {}; } })();
const MAX_REDIRECTS = 5;
function isPrivateIpv4(s) {
  const m = String(s).split('.').map(Number);
  if (m.length !== 4 || m.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = m;
  if (a === 0 || a === 10 || a === 127) return true;                                    // this-network / private / loopback
  if (a === 169 && b === 254) return true;                                              // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;                                     // private
  if (a === 192 && b === 168) return true;                                              // private
  if (a === 100 && b >= 64 && b <= 127) return true;                                    // CGNAT 100.64/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;                        // 192.0.0/24 + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;      // benchmarking + TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;                                   // TEST-NET-3
  if (a >= 224) return true;                                                            // multicast + reserved + broadcast
  return false;
}
function expandIpv6(str) {
  let s = String(str || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = s.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  let tail = [];
  if (v4 && netMod.isIPv4(v4[1])) {
    const n = v4[1].split('.').map(Number);
    tail = [((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16)];
    s = s.slice(0, v4.index);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const rest = parts.length === 2 ? (parts[1] ? parts[1].split(':').filter(Boolean) : []) : [];
  if (parts.length === 2 && s.includes('::') === false) return null;
  const pad = 8 - head.length - rest.length - tail.length;
  if (parts.length === 1 && pad !== 0) return null;   // no '::' → must have exactly 8 groups
  if (pad < 0) return null;
  // Strip leading zeros so '0000'/'0001'/'00ff' compare like '0'/'1'/'ff' below (padded forms used to look public).
  return [...head, ...Array(pad).fill('0'), ...rest, ...tail].map(x => x.replace(/^0+(?=.)/, ''));
}
function isPrivateIp(ip) {
  const s = String(ip || '').trim();
  if (netMod.isIPv4(s)) return isPrivateIpv4(s);
  if (!netMod.isIPv6(s)) return true;                 // not an IP at all → refuse
  const g = expandIpv6(s);
  if (!g || g.length !== 8) return true;              // unparseable → refuse
  const n = g.map(x => parseInt(x, 16) || 0);
  if (g.every(x => x === '0')) return true;           // :: unspecified
  if (g.slice(0, 7).every(x => x === '0') && g[7] === '1') return true;          // ::1 loopback
  if (g.slice(0, 6).every(x => x === '0') && g[6] === '0' && g[7] === '0') return true; // ::/96 IPv4-compatible
  if (g.slice(0, 5).every(x => x === '0') && g[5] === 'ffff') {                   // ::ffff:x.y.z.w mapped
    const v4 = [(n[6] >> 8) & 255, n[6] & 255, (n[7] >> 8) & 255, n[7] & 255];
    return isPrivateIpv4(v4.join('.'));
  }
  if (g[0] === '64' && g[1] === 'ff9b' && g.slice(2, 6).every(x => x === '0')) {  // NAT64 64:ff9b::/96
    const v4 = [(n[6] >> 8) & 255, n[6] & 255, (n[7] >> 8) & 255, n[7] & 255];
    return isPrivateIpv4(v4.join('.'));
  }
  if (/^f[cd]/.test(g[0])) return true;                // fc00::/7 ULA
  if ((n[0] & 0xffc0) === 0xfe80) return true;                     // fe80::/10 link-local
  if ((n[0] & 0xff00) === 0xff00) return true;         // ff00::/8 multicast
  if (g[0] === '2001' && g[1] === 'db8') return true;  // documentation
  return false;
}
async function resolveHostIps(hostname) {
  const ov = DNS_OVERRIDE[String(hostname).toLowerCase()];
  if (ov) return Array.isArray(ov) ? ov.map(String) : [String(ov)];
  return (await dnsProm.lookup(hostname, { all: true, verbatim: true })).map(a => a.address);
}
function isLocalHostname(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}
async function assertPublicHost(u, { allowLoopback = false } = {}) {
  const host = String(u.hostname || '').toLowerCase();
  if (isLocalHostname(host) && !allowLoopback) {
    throw new Error('Blocked: ' + host + ' is a local hostname. Web tools only reach public internet hosts.');
  }
  if (LLM_BLOCK_HOST.test(host)) throw new Error('Blocked: ' + host + ' is a private, loopback or metadata address. Web tools only reach public internet hosts.');
  const lit = host.replace(/^\[|\]$/g, '');
  if (netMod.isIP(lit)) {
    if (isPrivateIp(lit)) {
      if (allowLoopback) return;
      throw new Error('Blocked: ' + host + ' is a private, loopback or reserved address. Web tools only reach public internet hosts.');
    }
    return;
  }
  let addrs;
  try { addrs = await resolveHostIps(lit); } catch { throw new Error('DNS lookup failed for ' + host); }
  if (!addrs.length) throw new Error('DNS lookup failed for ' + host);
  const bad = addrs.find(a => isPrivateIp(a));
  if (bad && !allowLoopback) throw new Error('Blocked: ' + host + ' resolves to a private or loopback address (' + bad + ').');
}
// One HTTP(S) request to a validated address. Resolves DNS, checks every address, then connects
// to the checked IP so a later DNS rotation cannot redirect the connection (rebinding defense).
function pinnedRequest(u, { method = 'GET', headers = {}, body = null, timeout = 20000, allowLoopback = false, dnsPin = null } = {}) {
  return new Promise((resolve, reject) => {
    (async () => {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      await assertPublicHost(u, { allowLoopback });
      let ip = dnsPin;
      if (!ip) {
        let ips;
        try { ips = await resolveHostIps(host); } catch { return reject(new Error('DNS lookup failed for ' + host)); }
        const bad = ips.find(a => isPrivateIp(a));
        if (bad && !allowLoopback) return reject(new Error('Blocked: ' + host + ' resolves to a private or loopback address (' + bad + ').'));
        if (!ips.length) return reject(new Error('DNS lookup failed for ' + host));
        ip = ips[0];
      }
      if (isPrivateIp(ip) && !allowLoopback) return reject(new Error('Blocked: ' + ip + ' is a private or loopback address.'));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: u.protocol, hostname: ip, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method, headers: { ...headers, host: u.host },
        servername: u.protocol === 'https:' ? host : undefined, rejectUnauthorized: true, setHost: false
      }, res => resolve(res));
      req.setTimeout(timeout, () => req.destroy(new Error('The request timed out after ' + Math.round(timeout / 1000) + 's')));
      req.on('error', e => {
        const m = String(e && e.message || e);
        reject(new Error(m.includes('timed out') ? m : 'Could not reach ' + u.host + ' (' + m.slice(0, 160) + ')'));
      });
      if (body != null) req.write(body);
      req.end();
    })().catch(reject);
  });
}
function readCap(r, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    r.on('data', c => { n += c.length; if (n > cap) { try { r.destroy(); } catch {} return reject(new Error('Response exceeded the ' + Math.round(cap / 1024) + ' KB download limit')); } chunks.push(c); });
    r.on('end', () => resolve(Buffer.concat(chunks)));
    r.on('error', reject);
  });
}
async function secFetch(urlStr, { method = 'GET', headers = {}, body = null, timeout = 20000, maxBytes = 3e6, allowLoopback = ALLOW_LOOPBACK, maxRedirects = MAX_REDIRECTS } = {}) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('Invalid URL: ' + urlStr); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are supported');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');
  let current = u, hops = 0;
  for (;;) {
    const r = await pinnedRequest(current, { method, headers, body, timeout, allowLoopback });
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
      r.resume();
      if (hops >= maxRedirects) return { url: current.href, status: r.statusCode, headers: r.headers, res: r, redirected: hops > 0 };
      const next = new URL(r.headers.location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Redirect to a non-http(s) address is not allowed: ' + next.protocol);
      if ([301, 302, 303].includes(r.statusCode) && method !== 'HEAD') { method = 'GET'; body = null; }   // never re-send a body cross-origin
      current = next; hops++;
      continue;    // every hop is revalidated from scratch (scheme, host, DNS, private ranges)
    }
    return { url: current.href, status: r.statusCode, headers: r.headers, res: r, redirected: hops > 0 };
  }
}
async function webGet(urlStr, { timeout = 20000, maxBytes = 3e6, accept } = {}) {
  const { url, status, headers, res } = await secFetch(urlStr, {
    timeout, maxBytes,
    headers: { 'User-Agent': WEB_UA, 'Accept': accept || 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7', 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const declared = Number(headers['content-length']) || 0;
  if (declared > maxBytes) { try { res.destroy(); } catch {} throw new Error('Page too large (' + Math.round(declared / 1024) + ' KB, limit ' + Math.round(maxBytes / 1024) + ' KB)'); }
  const buf = await readCap(res, maxBytes);
  return { url, status, contentType: headers['content-type'] || '', buf };
}
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', laquo: '«', raquo: '»', times: '×', bull: '•', dagger: '†', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶' };
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, c) => {
    if (c[0] === '#') { const n = (c[1] === 'x' || c[1] === 'X') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return n > 0 && n < 1114112 ? String.fromCodePoint(n) : m; }
    return named[c.toLowerCase()] || m;
  });
}
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/header|\/footer|\/blockquote|\/pre|\/table|\/ul|\/ol)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function extractPage(html, url) {
  const src = String(html || '');
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const desc = (src.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || src.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1];
  let main = src;
  const art = src.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (art && art[2] && art[2].length > 500) main = art[2];
  else { const b = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i); if (b) main = b[1]; }
  main = main.replace(/<(nav|footer|aside|form|script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const text = htmlToText(main);
  const links = [];
  const re = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(src)) && links.length < 200) {
    try { const abs = new URL(decodeEntities(m[1]), url).href; if (/^https?:/i.test(abs)) links.push({ url: abs, text: htmlToText(m[2]).slice(0, 120) }); } catch {}
  }
  return { url, title: decodeEntities(title || '').trim().replace(/\s+/g, ' ').slice(0, 300), description: decodeEntities(desc || '').trim().replace(/\s+/g, ' ').slice(0, 500), text: text.slice(0, 50000), textLength: text.length, links };
}
async function ddgSearch(q, page) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + (page > 0 ? '&s=' + (page * 30) : '') + '&kl=wt-wt';
  const { buf, status } = await webGet(url, { timeout: 20000, accept: 'text/html' });
  const html = buf.toString('utf8');
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 30) {
    let href = decodeEntities(m[1]);
    const uudd = href.match(/[?&]uddg=([^&]+)/); if (uudd) href = decodeURIComponent(uudd[1]);
    if (!/^https?:/i.test(href)) continue;
    results.push({ title: htmlToText(m[2]).slice(0, 200), url: href, snippet: '' });
  }
  const snre = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi; let i = 0;
  while ((m = snre.exec(html)) && i < results.length) results[i++].snippet = htmlToText(m[1]).slice(0, 300);
  if (!results.length && /anomaly|captcha|unfortunately|detected unusual/i.test(html)) throw new Error('The search provider is rate-limiting this network. Try again later or configure another provider.');
  if (!results.length && status !== 200) throw new Error('Search provider returned HTTP ' + status);
  return results;
}
async function webSearch(b) {
  const q = String(b.query || '').trim().slice(0, 400);
  if (!q) throw new Error('Missing search query');
  const page = Math.max(0, Math.min(20, parseInt(b.page, 10) || 0));
  const app = readJson(CONFIG_FILE, {}) || {};
  const provider = String(b.provider || app.searchProvider || 'duckduckgo').toLowerCase();
  if (provider !== 'duckduckgo' && provider !== 'ddg') throw new Error('Unknown search provider "' + provider + '". Available: duckduckgo (configurable via config searchProvider).');
  const results = await ddgSearch(q, page);
  return { query: q, provider, page, count: results.length, results, note: results.length && page === 0 ? 'Pass page=1,2,… for more results.' : '' };
}
async function webFetch(b) {
  const timeout = Math.min(Math.max((Number(b.timeout_seconds) || 20) * 1000, 5000), 60000);
  const { buf, contentType, status, url: finalUrl } = await webGet(String(b.url || ''), { timeout, maxBytes: 3e6, accept: b.accept });
  const text = buf.toString('utf8');
  const isText = /text\/|json|xml|javascript/i.test(contentType) || !contentType;
  return { url: finalUrl, status, contentType, bytes: buf.length, content: isText ? clipMidText(text, 60000) : '(binary content: ' + contentType + ', ' + buf.length + ' bytes — use web_screenshot or the browser tools to view it)' };
}
function clipMidText(s, n) { if (s.length <= n) return s; const h = Math.floor(n * 0.5); return s.slice(0, h) + '\n…[' + (s.length - n) + ' chars omitted]…\n' + s.slice(-(n - h)); }
async function webExtract(b) {
  const { buf, contentType, status, url: finalUrl } = await webGet(String(b.url || ''), { timeout: 25000, maxBytes: 3e6 });
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    const raw = buf.toString('utf8');
    return { ...extractPage('<title></title><body>' + raw.replace(/[<>]/g, '') + '</body>', finalUrl), status, contentType, note: 'Not HTML — returned as plain text.' };
  }
  const page = extractPage(buf.toString('utf8'), finalUrl);
  if (b.max_chars && Number(b.max_chars) > 500) page.text = clipMidText(page.text, Math.min(Number(b.max_chars), 50000));
  return { ...page, status, contentType };
}
async function webFind(b) {
  const { buf, contentType, url: finalUrl } = await webGet(String(b.url || ''), { timeout: 25000, maxBytes: 3e6 });
  const raw = buf.toString('utf8');
  const text = /text\/html|application\/xhtml/i.test(contentType) ? htmlToText(raw) : raw;
  const q = String(b.query || '');
  if (!q) throw new Error('Missing query');
  let re;
  try { re = b.regex ? new RegExp(q, 'gi') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { throw new Error('Invalid regex: ' + e.message); }
  const lines = text.split('\n'), hits = [];
  for (let i = 0; i < lines.length && hits.length < 40; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 300) });
  }
  return { url: finalUrl, query: q, regex: !!b.regex, matches: hits, totalLines: lines.length, truncated: hits.length >= 40 };
}
async function webCrawl(b, onProgress) {
  const start = String(b.url || '');
  const maxPages = Math.min(Math.max(parseInt(b.max_pages, 10) || 5, 1), 10);
  const maxDepth = Math.min(Math.max(parseInt(b.max_depth, 10) || 1, 1), 3);
  const first = await webGet(start, { timeout: 25000, maxBytes: 3e6 });
  if (!/text\/html|application\/xhtml/i.test(first.contentType)) throw new Error('The start URL is not an HTML page');
  const startUrl = new URL(first.url);
  const allow = await robotsAllows(startUrl.origin);
  const seen = new Set([startUrl.href]), queue = [{ url: startUrl.href, depth: 0 }], pages = [];
  const t0 = Date.now();
  while (queue.length && pages.length < maxPages && Date.now() - t0 < 90000) {
    const { url, depth } = queue.shift();
    if (onProgress) onProgress(pages.length, maxPages, 'crawling ' + url.slice(0, 100));
    let buf, ct, status;
    if (pages.length === 0) { buf = first.buf; ct = first.contentType; status = first.status; }
    else {
      try { const r = await webGet(url, { timeout: 20000, maxBytes: 2e6 }); buf = r.buf; ct = r.contentType; status = r.status; } catch (e) { pages.push({ url, status: 0, error: String(e.message || e).slice(0, 200) }); continue; }
      await sleep(350);
    }
    const page = extractPage(buf.toString('utf8'), url);
    pages.push({ url, status, title: page.title, text: clipMidText(page.text, Math.max(1500, Math.floor(12000 / maxPages))), textLength: page.textLength });
    if (depth < maxDepth && !b.extract_only) {
      for (const l of page.links) {
        if (pages.length + queue.length >= maxPages * 3 || seen.size > 150) break;
        let u2; try { u2 = new URL(l.url); } catch { continue; }
        if (u2.hostname !== startUrl.hostname || !/^https?:$/.test(u2.protocol) || seen.has(u2.href)) continue;
        if (/\.(png|jpe?g|gif|webp|svg|pdf|zip|gz|mp[34]|avi|woff2?|css|js)$/i.test(u2.pathname)) continue;
        if (!allow(u2.pathname)) continue;
        u2.hash = ''; seen.add(u2.href); queue.push({ url: u2.href, depth: depth + 1 });
      }
    }
  }
  return { start: startUrl.href, maxPages, maxDepth, crawled: pages.length, pages, truncated: queue.length > 0 };
}
async function robotsAllows(origin) {
  try {
    const { buf, status } = await webGet(origin + '/robots.txt', { timeout: 8000, maxBytes: 200000 }).catch(e => { throw e; });
    if (status !== 200) return () => true;
    const lines = buf.toString('utf8').split('\n'); let star = false; const dis = [];
    for (const l of lines) {
      const m = l.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i); if (!m) continue;
      if (m[1].toLowerCase() === 'user-agent') star = m[2].trim() === '*';
      else if (star && m[2].trim()) dis.push(m[2].trim());
    }
    return p => !dis.some(d => d !== '' && p.startsWith(d));
  } catch { return () => true; }
}
async function webScreenshot(b) {
  if (b.url) {
    const r = await browserOpen({ url: b.url, approved: b.approved, visible: b.visible, persist: b.persist });
    if (r.needsApproval) return r;
    await sleep(700);
  }
  return browserShot({ fullPage: !!b.full_page, quality: b.quality });
}

/* ================= 3.10: HTTP and API tools ================= */
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HTTP_MAX_RESPONSE = 2e6;
const HTTP_LAST = []; let httpSeq = 0;
function jsonPathGet(obj, pathStr) {
  return String(pathStr || '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : (Array.isArray(o) ? o[Number(k)] : o[k])), obj);
}
function validateResponse(r, expect) {
  const fails = [];
  try {
    if (expect.status != null && !(Array.isArray(expect.status) ? expect.status.map(Number).includes(r.status) : r.status === Number(expect.status))) fails.push('expected status ' + expect.status + ', got ' + r.status);
    if (expect.ok === true && !(r.status >= 200 && r.status < 300)) fails.push('expected a 2xx response, got ' + r.status);
    if (typeof expect.contains === 'string' && !r.body.includes(expect.contains)) fails.push('body does not contain: ' + expect.contains.slice(0, 100));
    if (typeof expect.not_contains === 'string' && r.body.includes(expect.not_contains)) fails.push('body must not contain: ' + expect.not_contains.slice(0, 100));
    if (expect.json_path != null) {
      const v = jsonPathGet(r.json, String(expect.json_path));
      if (v === undefined) fails.push('json path not found: ' + expect.json_path);
      else if (expect.equals !== undefined && JSON.stringify(v) !== JSON.stringify(expect.equals)) fails.push('json path ' + expect.json_path + ' = ' + JSON.stringify(v).slice(0, 120) + ', expected ' + JSON.stringify(expect.equals).slice(0, 120));
    }
    if (expect.max_ms != null && r.durationMs > Number(expect.max_ms)) fails.push('took ' + r.durationMs + 'ms (max ' + expect.max_ms + 'ms)');
    if (expect.header && typeof expect.header === 'object') for (const [k, v] of Object.entries(expect.header).slice(0, 10)) if (String(r.headers[String(k).toLowerCase()] || '') !== String(v)) fails.push('header ' + k + ' expected ' + v + ', got ' + (r.headers[String(k).toLowerCase()] || '(absent)').slice(0, 80));
  } catch (e) { fails.push('validation error: ' + e.message); }
  return { passed: !fails.length, failures: fails };
}
async function httpRequest(b) {
  const method = String(b.method || 'GET').toUpperCase();
  if (!HTTP_METHODS.includes(method)) throw new Error('Unsupported method: ' + method + ' (allowed: ' + HTTP_METHODS.join(', ') + ')');
  let u; try { u = new URL(String(b.url || '')); } catch { throw new Error('Invalid URL: ' + b.url); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https URLs are supported');
  if (LLM_BLOCK_HOST.test(u.hostname)) throw new Error('That address is not allowed.');
  // 3.11: private/loopback targets require explicit configuration (MY_AGENT_ALLOW_LOOPBACK=1);
  // plain http to a public host is still refused (cleartext to the internet is never wanted).
  const litHost = u.hostname.replace(/^\[|\]$/g, '');
  const isLoopbackTarget = isLocalHostname(u.hostname) || (netMod.isIP(litHost) && isPrivateIp(litHost));
  if (isLoopbackTarget && !ALLOW_LOOPBACK) throw new Error('Blocked: ' + u.hostname + ' is a private or loopback address. Set MY_AGENT_ALLOW_LOOPBACK=1 to reach local development servers.');
  if (u.protocol === 'http:' && !isLoopbackTarget) throw new Error('Plain http is only allowed for localhost/dev servers; use https for public APIs.');
  const headers = {};
  if (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) {
    for (const [k, v] of Object.entries(b.headers).slice(0, 40)) {
      const key = String(k).toLowerCase();
      if (typeof v !== 'string' || !/^[a-z0-9-]{1,60}$/.test(key) || LLM_DROP_HEADERS.has(key) || /[\r\n]/.test(v)) continue;
      headers[key] = v.slice(0, 8000);
    }
  }
  if (!headers['user-agent']) headers['user-agent'] = WEB_UA;
  if (b.query && typeof b.query === 'object' && !Array.isArray(b.query)) for (const [k, v] of Object.entries(b.query).slice(0, 40)) if (k && v != null) u.searchParams.set(String(k).slice(0, 100), String(v).slice(0, 2000));
  let body = null;
  if ((b.body != null || b.form != null) && method !== 'GET' && method !== 'HEAD') {
    if (typeof b.body === 'string') { body = b.body; if (!headers['content-type']) headers['content-type'] = 'text/plain; charset=utf-8'; }
    else if (b.form && typeof b.form === 'object' && !Array.isArray(b.form)) { body = new URLSearchParams(Object.entries(b.form).map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 10000)])).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    else { body = JSON.stringify(b.body); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
    if (Buffer.byteLength(body) > 5e6) throw new Error('Request body exceeds 5 MB');
  }
  const timeoutMs = Math.min(Math.max((Number(b.timeout_seconds) || 30) * 1000, 2000), 120000);
  const t0 = Date.now();
  let r, text, truncated = false;
  try {
    // 3.11: SSRF-hardened transport — every redirect hop is revalidated, the connection goes to
    // the validated address, TLS hostname verification stays on.
    const resp = await secFetch(u.href, { method, headers, body, timeout: timeoutMs, maxBytes: HTTP_MAX_RESPONSE, maxRedirects: b.follow_redirects === false ? 0 : MAX_REDIRECTS });
    r = resp; const buf = await readCap(resp.res, HTTP_MAX_RESPONSE);
    truncated = buf.length >= HTTP_MAX_RESPONSE; text = buf.toString('utf8');
  } catch (e) {
    if (e && /timed out/i.test(e.message || '')) throw new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's');
    throw new Error('Request failed: ' + ((e && e.message) || e));
  }
  const durationMs = Date.now() - t0;
  const respHeaders = {}; for (const [k, v] of Object.entries(r.headers)) respHeaders[k] = String(v).slice(0, 500);
  const ct = r.headers['content-type'] || '';
  let parsed; try { if (/json/i.test(ct) || /^\s*[[{]/.test(text)) parsed = JSON.parse(text); } catch {}
  const out = { ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusMessage || '', url: r.url, redirected: !!r.redirected, headers: respHeaders, contentType: ct, durationMs, size: Buffer.byteLength(text), body: clipMidText(text, 100000), bodyTruncated: truncated || text.length > 100000, json: parsed === undefined ? null : parsed };
  if (b.expect && typeof b.expect === 'object' && !Array.isArray(b.expect)) out.validation = validateResponse(out, b.expect);
  HTTP_LAST.unshift({ id: 'r' + (++httpSeq), t: Date.now(), method, url: u.href, requestHeaders: headers, ...out });
  if (HTTP_LAST.length > 10) HTTP_LAST.pop();
  out.responseId = HTTP_LAST[0].id;
  return out;
}
function httpInspect(b) {
  const rec = b.response_id ? HTTP_LAST.find(x => x.id === b.response_id) : HTTP_LAST[0];
  if (!rec) throw new Error('No stored response' + (b.response_id ? ' with id ' + b.response_id : ' yet — make an http_request first'));
  const out = { id: rec.id, method: rec.method, url: rec.url, status: rec.status, durationMs: rec.durationMs, size: rec.size, contentType: rec.contentType, headers: rec.headers, requestHeaderNames: Object.keys(rec.requestHeaders || {}), bodyPreview: rec.body.slice(0, 20000), jsonValid: rec.json !== null };
  if (b.path != null) { const v = jsonPathGet(rec.json, String(b.path)); out.path = String(b.path); out.found = v !== undefined; out.value = v === undefined ? null : v; }
  if (b.search) { const i = rec.body.indexOf(String(b.search)); out.search = { term: String(b.search).slice(0, 200), found: i >= 0, position: i >= 0 ? i : undefined, context: i >= 0 ? rec.body.slice(Math.max(0, i - 120), i + 240) : undefined }; }
  return out;
}
const API_COLLECTION_FILE = path.join(DATA, 'api-collection.json');
async function apiCollection(b) {
  const data = readJson(API_COLLECTION_FILE, { requests: [] });
  if (!Array.isArray(data.requests)) data.requests = [];
  const action = String(b.action || 'list');
  if (action === 'list') return { requests: data.requests.map(r => ({ id: r.id, name: r.name, method: r.method, url: r.url, updatedAt: r.updatedAt })) };
  if (action === 'save') {
    const name = String(b.name || '').trim();
    if (!name) throw new Error('Missing collection item name');
    const item = { id: b.id ? String(b.id).replace(/[^\w-]/g, '').slice(0, 64) : 'a' + crypto.randomBytes(6).toString('hex'), name: name.slice(0, 100), method: String(b.method || 'GET').toUpperCase().slice(0, 10), url: String(b.url || '').slice(0, 2000), headers: (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) ? b.headers : {}, query: (b.query && typeof b.query === 'object') ? b.query : null, body: b.body ?? null, expect: (b.expect && typeof b.expect === 'object') ? b.expect : null, updatedAt: Date.now() };
    const i = data.requests.findIndex(r => r.id === item.id || r.name === name);
    if (i >= 0) data.requests[i] = item; else data.requests.push(item);
    if (data.requests.length > 100) data.requests = data.requests.slice(-100);
    writeJson(API_COLLECTION_FILE, data);
    return { saved: item.id, name: item.name, count: data.requests.length };
  }
  if (action === 'delete') { const before = data.requests.length; data.requests = data.requests.filter(r => r.id !== String(b.id || '') && r.name !== String(b.name || '')); writeJson(API_COLLECTION_FILE, data); return { deleted: before - data.requests.length }; }
  if (action === 'run') {
    const item = data.requests.find(r => r.id === String(b.id || '') || r.name === String(b.name || ''));
    if (!item) throw new Error('Collection item not found: ' + (b.id || b.name));
    return httpRequest({ ...item, expect: b.expect || item.expect, timeout_seconds: b.timeout_seconds });
  }
  throw new Error('Unknown action "' + action + '" (list, save, delete, run)');
}

/* ================= 3.10: developer intelligence ================= */
let TOOLCHAIN = null, TOOLCHAIN_AT = 0;
function pythonBin() {
  for (const c of ['python3', 'python', 'py']) { const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 }); if (r.status === 0) return c; }
  return '';
}
function toolchain(force) {
  if (TOOLCHAIN && !force && Date.now() - TOOLCHAIN_AT < 120000) return TOOLCHAIN;
  const probe = (cmd, args) => {
    try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, shell: WIN }); return r.status === 0 ? (((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0].slice(0, 120)) : ''; } catch { return ''; }
  };
  const has = (cmd, args, name) => { const v = cmd ? probe(cmd, args) : ''; return { name, cmd, available: !!v, version: v }; };
  const py = pythonBin();
  const list = [
    has('node', ['--version'], 'node'), has('npm', ['--version'], 'npm'), has('npx', ['--version'], 'npx'),
    has('tsc', ['--version'], 'typescript'), has('eslint', ['--version'], 'eslint'), has('prettier', ['--version'], 'prettier'),
    has('jest', ['--version'], 'jest'), has('vitest', ['--version'], 'vitest'),
    has(py, ['--version'], 'python'), has(py, ['-m', 'pip', '--version'], 'pip'), has(py, ['-m', 'pytest', '--version'], 'pytest'),
    has(py, ['-m', 'ruff', '--version'], 'ruff'), has(py, ['-m', 'black', '--version'], 'black'),
    has('php', ['--version'], 'php'), has('composer', ['--version'], 'composer'), has('go', ['version'], 'go'),
    has('cargo', ['--version'], 'cargo'), has('java', ['-version'], 'java'), has('git', ['--version'], 'git')
  ];
  TOOLCHAIN = list; TOOLCHAIN_AT = Date.now();
  return list;
}
const tcGet = name => toolchain().find(t => t.name === name);
function devTestDiscovery() {
  if (!ROOT) throw new Error('Open a workspace first');
  const pj = readJson(path.join(ROOT, 'package.json'), null);
  const cmds = [];
  if (pj && pj.scripts && typeof pj.scripts === 'object') {
    for (const [k, v] of Object.entries(pj.scripts)) {
      if (!/^(test|test:.+|e2e|e2e:.+)$/.test(k) && !/\b(vitest|jest|playwright|mocha|cypress)\b/i.test(String(v))) continue;
      cmds.push({ source: 'package.json', label: k, command: 'npm run ' + k, script: String(v).slice(0, 200) });
      if (cmds.length >= 12) break;
    }
  }
  const py = pythonBin();
  if (py && (fs.existsSync(path.join(ROOT, 'pytest.ini')) || fs.existsSync(path.join(ROOT, 'pyproject.toml')) || fs.existsSync(path.join(ROOT, 'tests')))) cmds.push({ source: 'pytest', label: 'pytest', command: py + ' -m pytest' });
  if (fs.existsSync(path.join(ROOT, 'go.mod'))) cmds.push({ source: 'go', label: 'go test', command: 'go test ./...' });
  if (fs.existsSync(path.join(ROOT, 'Cargo.toml'))) cmds.push({ source: 'cargo', label: 'cargo test', command: 'cargo test' });
  if (fs.existsSync(path.join(ROOT, 'composer.json'))) cmds.push({ source: 'composer', label: 'composer test', command: 'composer test' });
  return { commands: cmds.slice(0, 12), note: 'Detected only — nothing was run. Pass a command to run_tests to execute one.' };
}
function parseTestOutput(text) {
  const t = String(text || '');
  const num = re => { const m = t.match(re); return m ? parseInt(m[1], 10) : null; };
  const out = {};
  // pytest
  if (/=+ .*pytest.* =+|passed|failed/i.test(t) && /\bpassed\b|\bfailed\b/.test(t)) {
    out.passed = num(/(\d+) passed/); out.failed = num(/(\d+) failed/); out.skipped = num(/(\d+) skipped/); out.errors = num(/(\d+) error/);
  }
  // jest / vitest
  const jest = t.match(/Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*skipped,\s*)?(\d+)\s*passed(?:,\s*(\d+)\s*total)?/i);
  if (jest) { out.failed = jest[1] ? parseInt(jest[1], 10) : (out.failed || 0); out.skipped = jest[2] ? parseInt(jest[2], 10) : out.skipped; out.passed = parseInt(jest[3], 10); }
  const vitest2 = t.match(/Test Files\s+(?:(\d+)\s*failed[^|]*\|)?[^|]*\|\s*(?:(\d+)\s*skipped[^|]*\|)?[^|]*\|\s*(?:(\d+)\s*passed[^|]*\|)?/i);
  if (vitest2 && out.passed == null) out.passed = vitest2[3] ? parseInt(vitest2[3], 10) : 0;
  // go
  if (/\bok\b\s+\S+\s+[\d.]+s/.test(t)) out.passed = (out.passed || 0) + (t.match(/\bok\b\s+\S+/g) || []).length;
  if (/\bFAIL\b/.test(t) && !out.failed) out.failed = (t.match(/^--- FAIL/mg) || t.match(/\bFAIL\b/mg) || []).length;
  if (/\bcargo test\b|^test result:/mi.test(t)) { const c = t.match(/test result: .*?(\d+) passed.*?(\d+) failed/i); if (c) { out.passed = parseInt(c[1], 10); out.failed = parseInt(c[2], 10); } }
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  if (out.passed != null || out.failed != null) out.total = (out.passed || 0) + (out.failed || 0) + (out.skipped || 0) + (out.errors || 0);
  return Object.keys(out).length ? out : null;
}
function parseTestFailures(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (!out.length || out.length < 30) {
      if (/^(FAIL|FAILED|ERROR|--- FAIL|AssertionError|Error:|✕|×|\s+FAIL\s)/i.test(l) || /^\s+at /.test(l) === false && /(AssertionError|Expected|Received|expect\()/.test(l)) out.push(l.trim().slice(0, 240));
    }
    if (out.length >= 30) break;
  }
  return [...new Set(out)].slice(0, 30);
}
function execCapture(command, opts = {}) {
  return new Promise(resolve => {
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : (ROOT || os.homedir());
    const sh = SHELLS[0];
    let child;
    try { child = opts.argv ? spawn(opts.argv[0], opts.argv.slice(1), { cwd, env: cmdEnv(opts.useConnections), windowsHide: true, detached: !WIN, shell: false }) : (sh && sh.one) ? spawn(sh.exe, sh.one(command), { cwd, env: cmdEnv(opts.useConnections), windowsHide: true, detached: !WIN }) : spawn(command, { cwd, shell: true, env: cmdEnv(opts.useConnections), windowsHide: true, detached: !WIN }); }
    catch (e) { return resolve({ exitCode: -1, timedOut: false, durationMs: 0, stdout: '', stderr: String(e.message || e) }); }
    if (opts.onSpawn) opts.onSpawn(child);
    let stdout = '', stderr = '', done = false, timedOut = false; const CAP = 200000, t0 = Date.now();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeout || 600000);
    child.stdout.on('data', c => { if (stdout.length < CAP) stdout += c.toString('utf8'); });
    child.stderr.on('data', c => { if (stderr.length < CAP) stderr += c.toString('utf8'); });
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: -1, timedOut: false, durationMs: Date.now() - t0, stdout, stderr: (stderr + '\n' + e.message).slice(0, CAP) }); });
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code == null ? -1 : code, timedOut, durationMs: Date.now() - t0, stdout, stderr }); });
  });
}
async function devRunTests(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const gate = permGuard('terminal', 'Run tests: ' + String(b.command || '(auto-discover)'), b);
  if (gate) return gate;
  if (!b.command) return { ...devTestDiscovery(), ran: false };
  const command = String(b.command).trim().slice(0, 600);
  if (!bApproved_command(command)) throw new Error('Command looks dangerous and was refused by run_tests. Use run_command with explicit approval instead.');
  const r = await execCapture(command, { cwd: b.cwd ? safe(b.cwd) : ROOT, timeout: Math.min(Math.max((Number(b.timeout_seconds) || 300) * 1000, 10000), 900000) });
  const combined = r.stdout + '\n' + r.stderr;
  return { ran: true, command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, summary: parseTestOutput(combined), failures: parseTestFailures(combined), outputTail: combined.slice(-15000) };
}
const DEV_RUN_BLOCK = [/\brm\s+-[rf]/i, /\bgit\s+push\b/i, /\bsudo\b/i, /\bdocker\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, /curl[^|]*\|\s*(sh|bash)/i, /\b(npm|pip|pip3|yarn|pnpm)\s+(install|add|i)\b/i, /\bmv\b.*\s\/etc/i, />{1,2}\s*\/etc\//i];
const bApproved_command = c => !DEV_RUN_BLOCK.some(r => r.test(String(c || '')));
async function devDiagnostics(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const gate = permGuard('terminal', 'Run project diagnostics (' + String(b.tool || 'auto') + ')', b);
  if (gate) return gate;
  const diags = [], used = [], notes = [];
  const pushDiag = (file, line, col, severity, message, source) => { if (diags.length < 200) diags.push({ file, line: Number(line) || 0, col: Number(col) || 0, severity: severity || 'error', message: String(message || '').slice(0, 300), source: source || '' }); };
  const runParse = async (label, cmd, args, re, sev) => {
    const tool = tcGet(label); if (!tool || !tool.available) { notes.push(label + ' not installed — skipped'); return; }
    used.push(label);
    const r = await execCapture([cmd, ...args].join(' '), { cwd: ROOT, timeout: 240000 });
    for (const line of (r.stdout + '\n' + r.stderr).split(/\r?\n/)) {
      const m = line.match(re);
      if (m) pushDiag(m[1], m[2], m[3], sev(m), m[4], label);
    }
  };
  const want = String(b.tool || 'auto').toLowerCase();
  if (want === 'auto' || want === 'tsc' || want === 'typescript') {
    const pj = readJson(path.join(ROOT, 'package.json'), null);
    const tsFiles = [];
    for (const f of walk(ROOT)) if (/\.(ts|tsx)$/i.test(f.rel) && tsFiles.length < 3) tsFiles.push(f.rel);
    if ((pj && ((pj.dependencies || {}).typescript || (pj.devDependencies || {}).typescript)) || tsFiles.length) await runParse('typescript', 'tsc', ['--noEmit', '--pretty', 'false'], /^([^\s(]+)\((\d+),(\d+)\):\s*(?:error|warning)\s*[^:]*:\s*(.*)$/i, m => /warning/i.test(m[0]) ? 'warning' : 'error');
    else notes.push('No TypeScript sources detected — tsc skipped');
  }
  if (want === 'auto' || want === 'eslint') {
    const pj = readJson(path.join(ROOT, 'package.json'), null);
    if (pj && ((pj.dependencies || {}).eslint || (pj.devDependencies || {}).eslint) && (fs.existsSync(path.join(ROOT, '.eslintrc')) || fs.existsSync(path.join(ROOT, '.eslintrc.js')) || fs.existsSync(path.join(ROOT, '.eslintrc.json')) || fs.existsSync(path.join(ROOT, 'eslint.config.js')) || fs.existsSync(path.join(ROOT, 'eslint.config.mjs')))) {
      await runParse('eslint', 'eslint', ['.', '--format', 'unix', '--no-error-on-unmatched-pattern'], /^(.+?):(\d+):(\d+):\s*(.+?)\s*\[(Error|Warning)\]$/i, m => (m[5] || '').toLowerCase() || 'warning');
    } else notes.push('ESLint config not found in workspace — skipped (dependencies are never installed automatically)');
  }
  if (want === 'auto' || want === 'python' || want === 'ruff') {
    const py = pythonBin();
    if (py && tcGet('ruff') && tcGet('ruff').available) await runParse('ruff', py, ['-m', 'ruff', 'check', '--output-format=concise', '.'], /^(.+?):(\d+):(\d+):\s*([A-Z]+\d+.*)$/i, () => 'warning');
    else notes.push('ruff not available for Python diagnostics — skipped');
  }
  return { diagnostics: diags, toolsUsed: used, notes, fileCount: diags.length, truncated: diags.length >= 200 };
}
async function devLint(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const gate = permGuard('terminal', 'Lint project (' + String(b.tool || 'auto') + ')', b);
  if (gate) return gate;
  const issues = [], notes = [], used = [];
  const run = async (label, cmd, re) => {
    const py = pythonBin();
    const tool = label === 'ruff' ? tcGet('ruff') : tcGet(label);
    if (!tool || !tool.available) { notes.push(label + ' not installed — skipped'); return; }
    used.push(label);
    const r = await execCapture(cmd, { cwd: ROOT, timeout: 240000 });
    for (const line of (r.stdout + '\n' + r.stderr).split(/\r?\n/)) { const m = line.match(re); if (m) issues.push({ file: m[1], line: Number(m[2]) || 0, message: String(m[3] || '').slice(0, 300), source: label }); if (issues.length >= 200) break; }
  };
  const want = String(b.tool || 'auto').toLowerCase();
  if (want === 'auto' || want === 'eslint') await run('eslint', 'eslint . --format unix --no-error-on-unmatched-pattern', /^(.+?):(\d+):(\d+):\s*(.+?)\s*\[(Error|Warning)\]$/i);
  if (want === 'auto' || want === 'ruff') { const py = pythonBin(); if (py) await run('ruff', py + ' -m ruff check --output-format=concise .', /^(.+?):(\d+):(\d+):\s*(.+)$/); }
  if (want === 'php' && tcGet('php') && tcGet('php').available) {
    used.push('php -l');
    for (const f of walk(ROOT)) {
      if (!/\.php$/i.test(f.rel) || issues.length >= 200) continue;
      const r = await execCapture('php -l ' + JSON.stringify(f.rel), { cwd: ROOT, timeout: 30000 });
      if (r.exitCode !== 0) { const m = r.stderr.match(/^(.*?) in (.+?) on line (\d+)/); issues.push({ file: f.rel, line: m ? Number(m[3]) : 0, message: (m ? m[1] : r.stderr).slice(0, 240), source: 'php' }); }
    }
  }
  return { issues, toolsUsed: used, notes, count: issues.length, truncated: issues.length >= 200 };
}
// 3.11: formatters are only ever run from a project-local install or a known global binary.
// npx is never used: it silently downloads and executes an uninstalled package.
function localFormatterBin(name) {
  const binDir = path.join(ROOT, 'node_modules', '.bin');
  for (const cand of [WIN ? name + '.cmd' : name, WIN ? name + '.exe' : name, name]) {
    const p = path.join(binDir, cand);
    if (fs.existsSync(p)) return p;
  }
  return '';
}
async function devFormat(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const tool = String(b.tool || 'auto').toLowerCase();
  const gate = permGuard('fsEdit', 'Format code — this rewrites files in the workspace', b);
  if (gate) return gate;
  const notes = [];
  let argv = null, label = '';
  const prettierLocal = localFormatterBin('prettier');
  const prettierGlobal = (tcGet('prettier') || {}).available ? 'prettier' : '';
  const blackOk = (tcGet('black') || {}).available;
  const want = tool === 'auto'
    ? ((prettierLocal || prettierGlobal) ? 'prettier' : (blackOk ? 'black' : ''))
    : tool;
  if (want === 'prettier' && (tool === 'auto' ? (prettierLocal || prettierGlobal) : (prettierLocal || prettierGlobal))) {
    if (prettierLocal) { argv = [prettierLocal, '--write', '.']; label = 'prettier (project-local)'; }
    else { argv = [prettierGlobal, '--write', '.']; label = 'prettier (globally installed)'; }
  } else if (want === 'black' && blackOk) {
    argv = [pythonBin(), '-m', 'black', '.']; label = 'black';
  } else {
    const missing = [];
    if (tool === 'prettier' || tool === 'auto') if (!prettierLocal && !prettierGlobal) missing.push('prettier (not installed in this project and not installed globally)');
    if (tool === 'black' || (tool === 'auto' && !missing.length)) if (!blackOk) missing.push('black (not available for the detected Python)');
    throw new Error('No formatter available for tool="' + tool + '". ' + (missing.join('; ') || 'Nothing to run.') + ' Install it in the project first (e.g. npm install --save-dev prettier) — CodeSpace never installs packages without your explicit permission.');
  }
  try { await cpCreate({ note: 'before format (' + tool + ')' }); } catch { notes.push('A pre-format checkpoint could not be created.'); }
  const r = await execCapture('', { argv, cwd: ROOT, timeout: 300000 });
  invalidateCodeIndex('code formatted');
  return { formatted: r.exitCode === 0, command: label, exitCode: r.exitCode, durationMs: r.durationMs, output: (r.stdout + '\n' + r.stderr).slice(-8000), notes, note: 'A checkpoint was created first — restore it from the Checkpoints view to undo. Only a locally or globally installed formatter binary was executed; nothing was downloaded.' };
}
async function devDeps(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const report = { manifests: {}, dependencies: [], devDependencies: [], counts: {}, notes: [] };
  const pj = readJson(path.join(ROOT, 'package.json'), null);
  if (pj) {
    report.manifests['package.json'] = { name: pj.name, version: pj.version, private: !!pj.private };
    report.dependencies = Object.entries(pj.dependencies || {}).map(([name, spec]) => ({ name, spec, ecosystem: 'npm' }));
    report.devDependencies = Object.entries(pj.devDependencies || {}).map(([name, spec]) => ({ name, spec, ecosystem: 'npm' }));
  }
  const req = fs.existsSync(path.join(ROOT, 'requirements.txt')) ? fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8') : '';
  if (req) for (const l of req.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')).slice(0, 200)) { const m = l.split(/[=<>~!]+/); report.dependencies.push({ name: m[0], spec: l.slice(m[0].length) || '*', ecosystem: 'pypi' }); }
  if (fs.existsSync(path.join(ROOT, 'pyproject.toml'))) report.manifests['pyproject.toml'] = { found: true };
  if (fs.existsSync(path.join(ROOT, 'composer.json'))) report.manifests['composer.json'] = { found: true };
  if (fs.existsSync(path.join(ROOT, 'go.mod'))) report.manifests['go.mod'] = { found: true };
  if (fs.existsSync(path.join(ROOT, 'Cargo.toml'))) report.manifests['Cargo.toml'] = { found: true };
  report.counts = { dependencies: report.dependencies.length, devDependencies: report.devDependencies.length };
  if (b.audit === true) {
    const gate = permGuard('terminal', 'Run npm audit (reads the registry, does not change anything)', b);
    if (gate) return gate;
    if (pj && tcGet('npm') && tcGet('npm').available) {
      const r = await execCapture('npm audit --json', { cwd: ROOT, timeout: 120000 });
      try { const a = JSON.parse(r.stdout || '{}'); const v = a.metadata && a.metadata.vulnerabilities; report.audit = v ? { info: v.info || 0, low: v.low || 0, moderate: v.moderate || 0, high: v.high || 0, critical: v.critical || 0, total: v.total || 0 } : { note: 'no audit metadata returned' }; }
      catch { report.audit = { note: 'npm audit produced no parsable output (no lockfile?)' }; }
    } else report.audit = { note: 'npm not available' };
  } else report.notes.push('Pass audit:true to also run `npm audit --json` (read-only).');
  return report;
}
async function devUnused(b) {
  if (!ROOT) throw new Error('Open a workspace first');
  const idx = ensureCodeIndex();
  if (!idx.stats.complete) return { unused: [], note: 'The index is partial (project size limits); results would be unreliable. Rebuild the index first.', symbolCount: idx.stats.symbolCount };
  const results = [];
  for (const s of idx.symbols) {
    if (!s.exported && s.kind === 'constant') continue;
    const re = new RegExp('(^|[^A-Za-z0-9_$])' + s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_$]|$)');
    let refs = 0;
    for (const l of idx.lines) { if (l.path === s.path && l.line === s.line) continue; if (re.test(l.text)) { refs++; if (refs > 2) break; } }
    if (refs === 0) results.push({ name: s.name, kind: s.kind, path: s.path, line: s.line, note: 'No indexed references outside its own file. Heuristic only — dynamic/reflective usage is not detected.' });
    if (results.length >= 50) break;
  }
  return { unused: results, scannedSymbols: idx.symbols.length, truncated: results.length >= 50, note: 'Heuristic: exported/constant symbols and string-based or dynamic references are not tracked.' };
}
async function devHealth() {
  if (!ROOT) throw new Error('Open a workspace first');
  const issues = [], checks = {};
  try { const g = gitStatus(); checks.git = { ok: true, ahead: g.ahead || 0, changed: (g.entries || []).length || Object.keys(g).length >= 0 ? (g.entries || []).length : 0 }; } catch { checks.git = { ok: false }; issues.push('git is not available or this is not a repository'); }
  try { const i = codeIndexStatus(); checks.index = i; if (!i.indexed) issues.push('Code index not built — code search will be slow or empty'); else if (i.stale) issues.push('Code index is stale — rebuild for accurate results'); } catch { checks.index = null; }
  const tc = toolchain();
  checks.tooling = { node: !!(tcGet('node') || {}).available, npm: !!(tcGet('npm') || {}).available, python: !!(tcGet('python') || {}).available, git: !!(tcGet('git') || {}).available };
  if (!checks.tooling.git) issues.push('git not installed — version control features are disabled');
  let tests = [];
  try { tests = devTestDiscovery().commands; } catch {}
  checks.tests = { detected: tests.length, commands: tests.map(t => t.command) };
  if (!tests.length) issues.push('No test commands detected — changes cannot be verified automatically');
  const manifests = ['package.json', 'requirements.txt', 'pyproject.toml', 'composer.json', 'go.mod', 'Cargo.toml'].filter(f => fs.existsSync(path.join(ROOT, f)));
  checks.manifests = manifests;
  if (!manifests.length) issues.push('No dependency manifest found (package.json, requirements.txt, …)');
  checks.permissions = permLoad();
  const score = Math.max(0, 100 - issues.length * 15);
  return { ok: true, root: ROOT, score, issues, checks, generatedAt: new Date().toISOString() };
}

/* ================= 3.10: multi-file edits, per-file undo/redo, rename symbol ================= */
const fhBucket = () => path.join(DATA, 'file-history', crypto.createHash('sha256').update(ROOT || '').digest('hex').slice(0, 16));
const fhFile = rel => path.join(fhBucket(), Buffer.from(String(rel)).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 140) + '.json');
function pushFileHistory(rel, oldContent) {
  try {
    if (typeof oldContent !== 'string' || Buffer.byteLength(oldContent) > 400000) return;
    const f = fhFile(rel), d = readJson(f, { undo: [], redo: [] });
    if (!Array.isArray(d.undo)) d.undo = []; if (!Array.isArray(d.redo)) d.redo = [];
    d.undo.push({ t: Date.now(), size: Buffer.byteLength(oldContent), content: oldContent });
    if (d.undo.length > 10) d.undo.splice(0, d.undo.length - 10);
    d.redo = [];
    writeJson(f, d);
  } catch {}
}
function fhRead(rel) { const d = readJson(fhFile(rel), null); return d && Array.isArray(d.undo) ? d : { undo: [], redo: [] }; }
function fsHistory(b) {
  const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  safe(rel);
  const d = fhRead(rel);
  return { path: rel, undo: d.undo.map(v => ({ t: v.t, size: v.size })), redo: (d.redo || []).map(v => ({ t: v.t, size: v.size })) };
}
function fsUndoRedo(b, mode) {
  const gate = permGuard('fsEdit', (mode === 'undo' ? 'Undo' : 'Redo') + ' last change to ' + b.path, b);
  if (gate) return gate;
  const rel = String(b.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const f = safe(rel), d = fhRead(rel);
  const from = mode === 'undo' ? d.undo : d.redo, to = mode === 'undo' ? d.redo : d.undo;
  const v = from.pop();
  if (!v) throw new Error('No ' + mode + ' history for this file');
  const current = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, v.content);
  to.push({ t: Date.now(), size: Buffer.byteLength(current), content: current });
  if (to.length > 10) to.splice(0, to.length - 10);
  writeJson(fhFile(rel), d);
  invalidateCodeIndex('file ' + mode);
  return { ok: true, path: rel, restoredBytes: v.size, remaining: from.length };
}
/* 3.11: serialization lock for file-mutating batch operations (multi-file edits, renames,
   undo/redo) so two concurrent operations can never interleave and corrupt each other. */
let editLock = Promise.resolve();
function withEditLock(fn) {
  const run = editLock.then(fn, fn);
  editLock = run.then(() => {}, () => {});
  return run;
}
// Atomic single-file write: temp file + rename (same directory, same filesystem), preserving mode.
function atomicWrite(f, content, mode) {
  const tmp = f + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, content, mode != null ? { mode } : { mode: 0o666 & ~process.umask(0) });
  try { fs.renameSync(tmp, f); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
async function fsEditBatch(b) {
  const edits = Array.isArray(b.edits) ? b.edits.slice(0, 50) : [];
  if (!edits.length) throw new Error('No edits given');
  const gate = permGuard('fsEdit', 'Edit ' + edits.length + ' file(s): ' + edits.map(e => String(e.path || '?')).slice(0, 6).join(', ') + (edits.length > 6 ? ', …' : ''), b);
  if (gate) return gate;
  return withEditLock(() => applyEditBatch(edits, b));
}
async function applyEditBatch(edits, b) {
  // Pre-validate every edit against current contents; nothing is written unless ALL match.
  const plan = [];
  for (const e of edits) {
    const f = safe(String(e.path || ''));
    if (f === ROOT) throw new Error('Missing file path in edit batch');
    if (BINARY.test(f)) throw new Error('Refusing to edit a binary file: ' + e.path);
    const st = fs.statSync(f);
    if (!st.isFile()) throw new Error('Not a file: ' + e.path);
    if (st.size > 2e6) throw new Error('File too large to edit (2 MB limit): ' + e.path);
    const content = fs.readFileSync(f, 'utf8');
    if (e.content != null) { plan.push({ f, rel: String(e.path), content, newContent: String(e.content), mode: st.mode }); continue; }
    const oldText = String(e.old_text ?? ''), newText = String(e.new_text ?? '');
    if (!oldText) throw new Error('old_text is required for ' + e.path);
    const n = content.split(oldText).length - 1;
    if (n === 0) throw new Error('old_text not found in ' + e.path + ' — nothing was changed');
    if (n > 1 && !e.replace_all) throw new Error('old_text appears ' + n + ' times in ' + e.path + '; pass replace_all:true or use a more unique string — nothing was changed');
    plan.push({ f, rel: String(e.path), content, newContent: e.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText), mode: st.mode });
  }
  const checkpoint = String(b && b.create_checkpoint) !== 'false' && ROOT ? await cpCreate({ note: 'before multi-file edit (' + plan.length + ' files)' }).catch(() => null) : null;
  // Stage: write atomically; if any write fails, roll back the files already written.
  const written = [];
  const rollback = () => { for (const w of written) { try { atomicWrite(w.f, w.oldContent, w.mode); } catch {} } };
  try {
    for (const p of plan) {
      pushFileHistory(p.rel, p.content);
      atomicWrite(p.f, p.newContent, p.mode & 0o7777);
      written.push({ f: p.f, oldContent: p.content, mode: p.mode & 0o7777, newContent: p.newContent });
    }
  } catch (e) {
    rollback();
    throw new Error('The batch edit failed partway and was rolled back: ' + (e.message || e));
  }
  // Verify: re-read every file; a mismatch rolls the whole batch back.
  for (const w of written) {
    let now = '';
    try { now = fs.readFileSync(w.f, 'utf8'); } catch {}
    if (now !== w.newContent) {
      rollback();
      throw new Error('Verification failed after writing ' + w.f + ' — the whole batch was rolled back.');
    }
  }
  const results = plan.map(p => ({ path: p.rel, bytes: Buffer.byteLength(p.newContent), changed: p.content !== p.newContent }));
  invalidateCodeIndex('multi-file edit (' + results.length + ' files)');
  return { applied: results.length, results, checkpoint: checkpoint ? checkpoint.id : null, allChanged: results.every(r => r.changed), atomic: true };
}
async function indexRename(b) {
  const symbol = String(b.symbol || '').trim(), newName = String(b.new_name || '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol) || !/^[A-Za-z_$][\w$]*$/.test(newName)) throw new Error('Only identifier-style names can be renamed (letters, digits, _, $).');
  if (symbol === newName) throw new Error('The new name is the same as the old one.');
  const refs = codeSymbolReferences({ symbol, limit: 120 });
  const files = [...new Set(refs.references.map(r => r.path))];
  if (!files.length) throw new Error('No indexed references found for "' + symbol + '" — rebuild the index first.');
  const gate = permGuard('fsEdit', 'Rename "' + symbol + '" to "' + newName + '" across ' + files.length + ' file(s): ' + files.slice(0, 6).join(', '), b);
  if (gate) return gate;
  return withEditLock(() => applyRename(symbol, newName, files));
}
async function applyRename(symbol, newName, files) {
  await cpCreate({ note: 'before rename ' + symbol + ' → ' + newName }).catch(() => null);
  const re = new RegExp('(^|[^A-Za-z0-9_$])' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_$])', 'g');
  const results = []; let total = 0;
  for (const rel of files) {
    const f = safe(rel);
    if (BINARY.test(f) || fs.statSync(f).size > 2e6) { results.push({ path: rel, skipped: true }); continue; }
    const content = fs.readFileSync(f, 'utf8');
    const matches = content.match(new RegExp(re.source, 'g')) || [];
    if (!matches.length) { results.push({ path: rel, changed: 0 }); continue; }
    pushFileHistory(rel, content);
    atomicWrite(f, content.replace(re, (m, pre) => pre + newName), fs.statSync(f).mode & 0o7777);
    total += matches.length;
    results.push({ path: rel, changed: matches.length });
  }
  invalidateCodeIndex('rename symbol ' + symbol);
  return { symbol, newName, files: results, totalReplacements: total, note: 'Text-based rename (index-driven). Review the diff before committing; compiler-level renames are not performed.' };
}

/* ================= 3.10: browser automation additions (existing CDP driver) ================= */
async function browserHover(b) {
  await ensureBrowser();
  const need = await externalCheck(b, 'Hover over: ' + (b.selector || ('x=' + b.x + ', y=' + b.y)));
  if (need) return need;
  let x = b.x, y = b.y;
  if (b.selector) {
    const selector = selStr(b.selector, 'selector');
    const pt = await brEval('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return null;el.scrollIntoView({block:"center",behavior:"auto"});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
    if (!pt) throw new Error('No element matches selector: ' + selector);
    x = pt.x; y = pt.y;
  }
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('Give a selector, or x and y');
  await humanMove(x, y);
  await sleep(250);
  return { hovered: { x, y }, ...(await brInfo()) };
}
async function browserSelectOption(b) {
  await ensureBrowser();
  const need = await externalCheck(b, 'Select option "' + b.value + '" in ' + b.selector);
  if (need) return need;
  const sel = JSON.stringify(selStr(b.selector, 'selector'));
  const val = JSON.stringify(String(b.value ?? '').slice(0, 500));
  const r = await brEval('(()=>{const el=document.querySelector(' + sel + ');if(!el)return {ok:false,reason:"no such element"};if(el.tagName!=="SELECT")return {ok:false,reason:"element is not a <select>"};const opt=[...el.options].find(o=>o.value===(' + val + ')||o.textContent.trim()===(' + val + '));if(!opt)return {ok:false,reason:"no option with that value or label"};el.value=opt.value;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,value:opt.value,text:opt.textContent.trim()};})()');
  if (!r || !r.ok) throw new Error('Could not select' + (r && r.reason ? ': ' + r.reason : ': ' + b.selector));
  await sleep(400);
  return { selected: r.value, text: r.text, ...(await brInfo()) };
}
async function browserUpload(b) {
  await ensureBrowser();
  const list = (Array.isArray(b.files) ? b.files : [b.file]).filter(Boolean).slice(0, 20);
  if (!list.length) throw new Error('Give a file (or files) inside the workspace to upload');
  const UPLOAD_MAX_FILE = 50 * 1024 * 1024, UPLOAD_MAX_TOTAL = 100 * 1024 * 1024;
  let total = 0;
  const paths = list.map(p => {
    const f = safe(p);
    let st; try { st = fs.statSync(f); } catch { throw new Error('Upload file not found in the workspace: ' + p); }
    if (!st.isFile()) throw new Error('Upload path is not a file: ' + p);
    if (st.size > UPLOAD_MAX_FILE) throw new Error('Upload file too large (' + Math.round(st.size / 1048576) + ' MB, limit 50 MB): ' + p);
    total += st.size;
    return f;
  });
  if (total > UPLOAD_MAX_TOTAL) throw new Error('Upload total size exceeds the 100 MB limit');
  const selector = selStr(b.selector || 'input[type=file]', 'selector');
  await BR.cdp.send('DOM.enable').catch(() => {});
  const doc = await BR.cdp.send('DOM.getDocument');
  const node = await BR.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error('No file input matches selector: ' + selector);
  await BR.cdp.send('DOM.setFileInputFiles', { files: paths, nodeId: node.nodeId });
  await sleep(400);
  return { uploaded: paths.map(p => path.basename(p)), ...(await brInfo()) };
}
async function browserDownload(b) {
  await ensureBrowser();
  const dirAbs = safe(String(b.dir || 'downloads'));
  fs.mkdirSync(dirAbs, { recursive: true });
  await BR.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dirAbs, eventsEnabled: true }).catch(() => BR.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dirAbs }));
  const before = new Set(fs.readdirSync(dirAbs));
  const DOWNLOAD_MAX = 200 * 1024 * 1024;   // 3.11: any single downloaded file larger than this is removed and reported
  if (b.selector) {
    const need = await externalCheck(b, 'Download via: ' + b.selector);
    if (need) return need;
    await pointerClickAtSelector(selStr(b.selector, 'selector'));
  } else if (b.url) {
    const r = await browserOpen({ url: b.url, approved: b.approved });
    if (r.needsApproval) return r;
  } else throw new Error('Give a selector to click or a url to download');
  const t0 = Date.now();
  let warned = false;
  while (Date.now() - t0 < 60000) {
    await sleep(600);
    let fresh = [];
    try { fresh = fs.readdirSync(dirAbs).filter(n => !before.has(n) && !n.endsWith('.crdownload') && !n.endsWith('.tmp')); } catch {}
    const oversized = fresh.filter(n => { try { return fs.statSync(path.join(dirAbs, n)).size > DOWNLOAD_MAX; } catch { return false; } });
    for (const n of oversized) { try { fs.unlinkSync(path.join(dirAbs, n)); } catch {} warned = true; }
    if (warned) return { downloaded: fresh.filter(n => !oversized.includes(n)), dir: path.relative(ROOT, dirAbs).replace(/\\/g, '/') || dirAbs, note: 'At least one downloaded file exceeded the 200 MB limit and was deleted.' };
    if (fresh.length) return { downloaded: fresh, dir: path.relative(ROOT, dirAbs).replace(/\\/g, '/') || dirAbs, bytes: fresh.map(n => { try { return fs.statSync(path.join(dirAbs, n)).size; } catch { return 0; } }) };
  }
  return { downloaded: [], dir: path.relative(ROOT, dirAbs).replace(/\\/g, '/') || dirAbs, note: 'No completed file appeared within 60s. Check browser console and network logs.' };
}
async function pointerClickAtSelector(selector) {
  const sel = selStr(selector, 'selector');
  const pt = await brEval('(()=>{const el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return null;el.scrollIntoView({block:"center",behavior:"auto"});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
  if (!pt) throw new Error('No element matches selector: ' + sel);
  await pointerClick(pt.x, pt.y, false);
}
async function browserWait(b) {
  await ensureBrowser();
  const t0 = Date.now(), timeout = Math.min(Math.max((Number(b.timeout_seconds) || 10) * 1000, 500), 30000);
  if (b.selector) {
    const sel = JSON.stringify(String(b.selector));
    for (;;) {
      const ok = await brEval('!!document.querySelector(' + sel + ')').catch(() => false);
      if (ok) return { waitedMs: Date.now() - t0, found: true, selector: b.selector };
      if (Date.now() - t0 > timeout) throw new Error('Selector not found within ' + Math.round(timeout / 1000) + 's: ' + b.selector);
      await sleep(250);
    }
  }
  if (b.text) {
    const txt = JSON.stringify(String(b.text).slice(0, 500));
    for (;;) {
      const ok = await brEval('(document.body ? document.body.innerText : "").includes(' + txt + ')').catch(() => false);
      if (ok) return { waitedMs: Date.now() - t0, found: true, text: b.text };
      if (Date.now() - t0 > timeout) throw new Error('Text not found within ' + Math.round(timeout / 1000) + 's: ' + String(b.text).slice(0, 80));
      await sleep(250);
    }
  }
  const ms = Math.min(timeout, 10000);
  await sleep(ms);
  return { waitedMs: Date.now() - t0 };
}
const DOM_SNAP_FN = function (maxNodes) {
  const out = []; let n = 0;
  const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'path', 'link', 'meta', 'template']);
  const TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'img', 'h1', 'h2', 'h3', 'h4', 'form', 'table', 'nav', 'main', 'article', 'section', 'header', 'footer', 'dialog', 'ul', 'ol']);
  const walk = (el, depth) => {
    if (n >= maxNodes || depth > 14) return;
    for (const c of el.children) {
      if (c.nodeType !== 1 || SKIP.has(c.tagName.toLowerCase())) continue;
      const tag = c.tagName.toLowerCase();
      const role = c.getAttribute('role') || '';
      const cls = typeof c.className === 'string' && c.className && c.className.length < 80 ? '.' + c.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      const txt = (c.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (c.id || role || TAGS.has(tag)) {
        out.push('  '.repeat(Math.min(depth, 12)) + tag + (c.id ? '#' + c.id : '') + cls + (role ? '[role=' + role + ']' : '') + (txt ? '  "' + txt + '"' : ''));
        n++;
        walk(c, depth + 1);
      } else walk(c, depth);
    }
  };
  if (document.body) walk(document.body, 0);
  return out.join('\n').slice(0, 30000);
};
async function browserDomSnapshot(b) {
  await ensureBrowser();
  const maxNodes = Math.min(Math.max(Number(b.max_nodes) || 400, 20), 1500);
  const snapshot = await brEval('(' + DOM_SNAP_FN.toString() + ')(' + maxNodes + ')');
  return { snapshot, ...(await brInfo()) };
}
async function browserA11yTree(b) {
  await ensureBrowser();
  await BR.cdp.send('Accessibility.enable').catch(() => {});
  const r = await BR.cdp.send('Accessibility.getFullAXTree', {}, 20000);
  const nodes = (r.nodes || []).filter(n => n && !n.ignored).slice(0, 400).map(n => ({
    role: n.role && n.role.value, name: n.name && n.name.value ? String(n.name.value).slice(0, 120) : '',
    value: n.value && n.value.value ? String(n.value.value).slice(0, 160) : '', level: typeof n.depth === 'number' ? n.depth : undefined
  }));
  return { nodes, count: nodes.length, ...(await brInfo()) };
}
function brPort() { const m = String(BR.wsUrl || '').match(/:(\d+)\//); return m ? Number(m[1]) : 0; }
let BR_BCDP = null;
async function brBrowserCdp() {
  if (BR_BCDP && !BR_BCDP.state.closed) return BR_BCDP;
  if (!BR.wsUrl) throw new Error('The browser is not running. Open a page first.');
  BR_BCDP = await cdpConnect(BR.wsUrl, () => {}, () => { BR_BCDP = null; });
  return BR_BCDP;
}
async function attachTab(targetId) {
  const port = brPort();
  if (!port) throw new Error('The browser is not running. Open a page first.');
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const t = list.find(x => x.id === targetId);
  if (!t || !t.webSocketDebuggerUrl) throw new Error('Tab not found: ' + targetId);
  if (BR.cdp) { try { BR.cdp.close(); } catch {} }
  BR.targetId = targetId;
  BR.cdp = await cdpConnect(t.webSocketDebuggerUrl, brEvent, () => { BR.cdp = null; });
  await BR.cdp.send('Page.enable'); await BR.cdp.send('Runtime.enable'); await BR.cdp.send('Log.enable'); await BR.cdp.send('Accessibility.enable').catch(() => {});
  await BR.cdp.send('Network.enable', { maxTotalBufferSize: 10000000, maxResourceBufferSize: 1000000 }).catch(() => {}); BR.networkEnabled = true;
  return { ...(await brInfo()), targetId };
}
async function browserTabsCdp(b) {
  await ensureBrowser();
  const bcdp = await brBrowserCdp();
  const action = String(b.action || 'list');
  const pages = (await bcdp.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  if (action === 'list') return { tabs: pages.map(t => ({ id: t.targetId, title: t.title, url: t.url, active: BR.targetId ? BR.targetId === t.targetId : pages.indexOf(t) === 0 })) };
  if (action === 'new') {
    const { targetId } = await bcdp.send('Target.createTarget', { url: String(b.url || 'about:blank') });
    await sleep(400);
    const info = await attachTab(targetId);
    return { created: targetId, ...info };
  }
  if (action === 'select') return attachTab(String(b.targetId || ''));
  if (action === 'close') {
    const id = String(b.targetId || '');
    if (!id) throw new Error('Missing targetId — get ids with action:"list"');
    await bcdp.send('Target.closeTarget', { targetId: id });
    if (id === BR.targetId) {
      BR.targetId = null;
      const rest = pages.filter(t => t.targetId !== id);
      if (rest.length) { await sleep(300); return { closed: id, ...(await attachTab(rest[0].targetId)) }; }
      BR.cdp = null;
      return { closed: id, note: 'That was the last tab; the browser session is idle now.' };
    }
    return { closed: id };
  }
  throw new Error('Unknown tabs action "' + action + '" (list, new, select, close)');
}

/* ================= 3.10: durable background tasks ================= */
const TASKS_DIR = path.join(DATA, 'tasks');
const JOBS = new Map(); let taskSeq = 0; let tasksLoaded = false;
function taskFile(id) { return path.join(TASKS_DIR, String(id).replace(/[^\w.-]/g, '') + '.json'); }
function taskSave(j) { try { fs.mkdirSync(TASKS_DIR, { recursive: true }); writeJson(taskFile(j.id), { ...j, ctrl: undefined, logs: (j.logs || []).slice(-40) }); } catch {} }
function taskView(j) {
  return { id: j.id, kind: j.kind, label: j.label, status: j.status, progress: j.progress || { done: 0, total: 0, message: '' }, params: j.params, createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt, attempts: j.attempts, error: j.error, result: j.result || null, logs: (j.logs || []).slice(-15), dedupeKey: j.dedupeKey || null, cancellable: j.status === 'running' || j.status === 'pending', retryable: (j.status === 'error' || j.status === 'cancelled') && j.attempts < 3 };
}
function taskLog(j, msg) {
  j.logs = j.logs || [];
  j.logs.push(new Date().toISOString().slice(11, 19) + ' ' + String(msg).slice(0, 300));
  if (j.logs.length > 60) j.logs.splice(0, j.logs.length - 40);
  taskSave(j);
}
function tasksLoadOnce() {
  if (tasksLoaded) return; tasksLoaded = true;
  try {
    for (const f of fs.readdirSync(TASKS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = readJson(path.join(TASKS_DIR, f), null);
      if (j && j.id) { if (j.status === 'running' || j.status === 'pending') { j.status = 'interrupted'; j.error = 'Interrupted by a server restart. Use task retry to run it again where safe.'; } j.ctrl = null; JOBS.set(j.id, j); }
    }
  } catch {}
  if (JOBS.size > 200) { const extra = [...JOBS.keys()].slice(0, JOBS.size - 200); for (const k of extra) JOBS.delete(k); }
}
// 3.11: every task kind maps to the permission its ACTUAL execution needs (diagnostics runs
// shell tools like tsc/eslint → terminal; crawls fetch the network → network). Permissions are
// revalidated when the task actually runs, not just when it is created.
const TASK_KINDS = {
  command: { desc: 'Run a shell command in the background', perm: 'terminal', what: 'Run a background command' },
  tests: { desc: 'Run detected project tests', perm: 'terminal', what: 'Run project tests in the background' },
  index_rebuild: { desc: 'Rebuild the codebase index', perm: null },
  web_crawl: { desc: 'Crawl a website and extract pages', perm: 'network', what: 'Crawl a website in the background' },
  diagnostics: { desc: 'Run project diagnostics', perm: 'terminal', what: 'Run project diagnostics (executes local tools such as tsc/eslint)' }
};
const TASK_MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env.CODESPACE_MAX_TASKS) || 4));
const TASK_QUEUE_MAX = 50;
const TASK_APPROVAL_MAX_AGE = APPROVAL_TTL * 10;
function taskPermRevalidate(j) {
  const cfg = TASK_KINDS[j.kind];
  if (!cfg || !cfg.perm) return;
  const mode = permLoad()[cfg.perm];
  if (mode === 'deny') throw new Error('Blocked by CodeSpace permission settings: ' + (PERM_DEFS[cfg.perm] || {}).label + ' (' + cfg.perm + ').');
  if (mode === 'ask' && Date.now() - (j.approvedAt || 0) > TASK_APPROVAL_MAX_AGE) {
    const e = new Error('The approval for this background task has expired. Retry the task to approve it again.');
    e.status = 403; throw e;
  }
}
async function taskCreate(b) {
  tasksLoadOnce();
  const kind = String(b.kind || '');
  if (!TASK_KINDS[kind]) throw new Error('Unknown task kind "' + kind + '". Available: ' + Object.keys(TASK_KINDS).join(', '));
  const p = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params : {};
  const cfg = TASK_KINDS[kind];
  if (cfg.perm) {
    const gate = permGuard(cfg.perm, cfg.what + ': ' + String(b.label || JSON.stringify(p).slice(0, 140)), b);
    if (gate) return gate;
  }
  const dedupe = String(b.dedupe_key || '');
  if (dedupe) for (const j of JOBS.values()) if (j.dedupeKey === dedupe && (j.status === 'running' || j.status === 'pending')) return { ...taskView(j), duplicate: true };
  const pending = [...JOBS.values()].filter(j => j.status === 'pending').length;
  const running = [...JOBS.values()].filter(j => j.status === 'running').length;
  if (pending >= TASK_QUEUE_MAX) throw new Error('The background task queue is full (' + TASK_QUEUE_MAX + ' pending). Cancel or delete tasks and try again.');
  const id = 'k' + Date.now().toString(36) + '_' + (++taskSeq).toString(36) + crypto.randomBytes(2).toString('hex');
  const j = { id, kind, label: String(b.label || kind).slice(0, 140), status: 'pending', progress: { done: 0, total: 0, message: '' }, params: p, createdAt: Date.now(), startedAt: null, endedAt: null, attempts: 0, error: null, result: null, logs: [], dedupeKey: dedupe || null, ctrl: null, cancelled: false, approvedAt: cfg.perm ? Date.now() : 0 };
  JOBS.set(id, j); taskSave(j);
  taskLog(j, cfg.perm ? 'queued (permission ' + cfg.perm + ' granted)' : 'queued');
  scheduleTasks();
  return taskView(j);
}
// 3.11: bounded scheduler — at most TASK_MAX_CONCURRENT tasks run at once, the rest wait as
// 'pending' and start FIFO when a slot frees up (after completion, cancellation or startup).
function scheduleTasks() {
  let running = [...JOBS.values()].filter(j => j.status === 'running').length;
  if (running >= TASK_MAX_CONCURRENT) return;
  const pending = [...JOBS.values()].filter(j => j.status === 'pending' && !j.cancelled).sort((a, b2) => a.createdAt - b2.createdAt);
  for (const j of pending) {
    if (running >= TASK_MAX_CONCURRENT) break;
    running++;
    runTask(j).catch(() => {}).finally(scheduleTasks);
  }
}
async function runTask(j) {
  if (j.status !== 'pending') return;
  // Revalidate the task's permission at the moment it actually starts running.
  try { taskPermRevalidate(j); } catch (e) {
    j.status = 'error'; j.error = String(e.message || e).slice(0, 500); j.endedAt = Date.now();
    taskLog(j, 'blocked: ' + j.error); taskSave(j); return;
  }
  j.status = 'running'; j.startedAt = Date.now(); j.attempts++; taskLog(j, 'started (attempt ' + j.attempts + ')');
  const p = j.params || {};
  try {
    let result;
    if (j.kind === 'command' || j.kind === 'tests') {
      let command = String(p.command || '');
      if (j.kind === 'tests' && !command) { const d = devTestDiscovery(); command = (d.commands[0] || {}).command || ''; }
      if (!command) throw new Error('No test command found — discover first with run_tests');
      if (!bApproved_command(command)) throw new Error('Command looks dangerous and was refused by the task runner');
      j.progress = { done: 0, total: 1, message: command.slice(0, 100) }; taskSave(j);
      const r = await execCapture(command, { cwd: p.cwd ? safe(p.cwd) : ROOT, timeout: Math.min(Math.max((Number(p.timeout_seconds) || 600) * 1000, 10000), 1800000), onSpawn: c => { j.ctrl = c; } });
      const combined = r.stdout + '\n' + r.stderr;
      result = { command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, summary: j.kind === 'tests' ? parseTestOutput(combined) : null, outputTail: combined.slice(-12000) };
      if (r.exitCode !== 0) { const e = new Error('Command exited with code ' + r.exitCode); e.result = result; throw e; }
    } else if (j.kind === 'index_rebuild') { j.progress = { done: 0, total: 1, message: 'scanning workspace' }; taskSave(j); result = buildCodeIndex(); }
    else if (j.kind === 'web_crawl') { result = await webCrawl(p, (d, t, m) => { j.progress = { done: d, total: t, message: String(m).slice(0, 120) }; taskSave(j); }); }
    else if (j.kind === 'diagnostics') { result = await devDiagnostics(p); }
    j.status = 'done'; j.result = result; j.endedAt = Date.now(); j.progress = { done: 1, total: 1, message: 'completed' }; taskLog(j, 'completed');
  } catch (e) {
    if (j.cancelled) { j.status = 'cancelled'; j.error = 'Cancelled by user'; }
    else { j.status = 'error'; j.error = String(e.message || e).slice(0, 500); if (e.result) j.result = e.result; }
    j.endedAt = Date.now(); taskLog(j, j.status === 'cancelled' ? 'cancelled' : 'failed: ' + (j.error || ''));
  }
  j.ctrl = null; taskSave(j);
}
function taskGet(b) { tasksLoadOnce(); const j = JOBS.get(String(b.id || '')); if (!j) throw new Error('Task not found: ' + b.id); return taskView(j); }
function taskList() { tasksLoadOnce(); const rows = [...JOBS.values()].sort((a, b2) => b2.createdAt - a.createdAt).slice(0, 50).map(taskView); return { tasks: rows, counts: { running: rows.filter(r => r.status === 'running').length, pending: rows.filter(r => r.status === 'pending').length, done: rows.filter(r => r.status === 'done').length, error: rows.filter(r => r.status === 'error').length } }; }
function taskCancel(b) {
  tasksLoadOnce();
  const j = JOBS.get(String(b.id || ''));
  if (!j) throw new Error('Task not found: ' + b.id);
  if (j.status !== 'running' && j.status !== 'pending') return taskView(j);
  j.cancelled = true;
  if (j.status === 'running' && j.ctrl) { try { killTree(j.ctrl); } catch {} taskLog(j, 'cancel requested (killing process)'); }
  else { j.status = 'cancelled'; j.endedAt = Date.now(); taskLog(j, j.status === 'pending' ? 'cancelled while queued' : 'cancelled before start'); taskSave(j); }
  try { SANDBOX.onTaskCancelled(j.id); } catch {}
  return taskView(j);
}
async function taskRetry(b) {
  tasksLoadOnce();
  const j = JOBS.get(String(b.id || ''));
  if (!j) throw new Error('Task not found: ' + b.id);
  if (j.status !== 'error' && j.status !== 'cancelled' && j.status !== 'interrupted') throw new Error('Only failed, cancelled or interrupted tasks can be retried (status: ' + j.status + ')');
  if (j.attempts >= 3) throw new Error('This task already ran 3 times — create a new task instead');
  const cfg = TASK_KINDS[j.kind];
  if (cfg && cfg.perm) {
    // A retry always needs a fresh approval — it never inherits the original one.
    const gate = permGuard(cfg.perm, 'Retry task ' + j.id + ' (' + j.label + ')', b);
    if (gate) return gate;
    j.approvedAt = Date.now();
  }
  j.status = 'pending'; j.error = null; j.cancelled = false; taskSave(j);
  scheduleTasks();
  return taskView(j);
}
function taskDelete(b) { tasksLoadOnce(); const j = JOBS.get(String(b.id || '')); if (!j) throw new Error('Task not found: ' + b.id); if (j.status === 'running') throw new Error('Cancel the task before deleting it'); JOBS.delete(j.id); try { fs.unlinkSync(taskFile(j.id)); } catch {} return { deleted: j.id }; }

/* ================= 3.12: Universal Sandbox Engine (backend subsystem) ================= */
const SANDBOX = require('./sandbox-manager.js')({
  DATA, WIN, sleep, safe, permGuard, permLoad, writeJson, readJson,
  cpCreate, atomicWrite, invalidateCodeIndex, withEditLock,
  ROOT: () => ROOT,
  taskAlive: id => { const j = JOBS.get(String(id || '')); return !!j && (j.status === 'running' || j.status === 'pending'); },
  walkWorkspace: dir => walk(dir)
});
const SBX_ROUTES = SANDBOX.sandboxRoutes();
SANDBOX.startSweeper();

/* ================= 3.13.5: built-in browsing proxy for the CodeSpace Browser panel =================
   Web/PWA mode shows websites in an <iframe>. Sites like Google/Gmail send X-Frame-Options/CSP,
   which turns that iframe into a blank page. The panel's "Proxy" mode loads every page through
   /browse on this local server instead: framing headers are stripped, absolute URLs are rewritten
   to stay inside the proxy, upstream cookies are kept in a server-side jar (so logins survive),
   and a small patch script routes fetch/XHR/form/history URLs through the proxy too. Everything
   runs on the user's own machine; no agent tool routes through this — it is a user-facing panel. */
const BROWSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BROWSE_JARS = new Map();                       // jar id -> { c: Map(key -> cookie), t: lastUsed }
const BROWSE_JAR_COOKIE = 'csb_jar';
const BROWSE_MAX_HTML = 12e6, BROWSE_MAX_BODY = 25e6, BROWSE_TIMEOUT = 60000;
const BROWSE_SKIP_URL = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|ws:|wss:|#|\{\{|\s*$)/i;
function browseJar(req, res) {
  let id = null;
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === BROWSE_JAR_COOKIE) id = part.slice(eq + 1).trim();
  }
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id) || !BROWSE_JARS.has(id)) {
    id = crypto.randomBytes(16).toString('hex');
    BROWSE_JARS.set(id, { c: new Map(), t: Date.now() });
    if (BROWSE_JARS.size > 60) { let old = null; for (const [k, v] of BROWSE_JARS) if (!old || v.t < old.v.t) old = { k, v }; if (old) BROWSE_JARS.delete(old.k); }
    try { res.setHeader('Set-Cookie', BROWSE_JAR_COOKIE + '=' + id + '; Path=/; HttpOnly; SameSite=Lax'); } catch {}
  }
  return BROWSE_JARS.get(id);
}
function browseCookieHeader(jar, host) {
  const out = [];
  for (const c of jar.values()) if (host === c.domain || host.endsWith('.' + c.domain)) out.push(c.name + '=' + c.value);
  return out.join('; ');
}
function browseStoreCookies(jar, host, lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    const segs = String(line).split(';');
    const nv = segs[0] || '', eq = nv.indexOf('=');
    if (eq < 1) continue;
    const name = nv.slice(0, eq).trim(), value = nv.slice(eq + 1).trim();
    if (!name) continue;
    let domain = String(host || '').toLowerCase();
    let expires = false;
    for (const s of segs.slice(1)) {
      const e2 = s.indexOf('='); const k = (e2 < 0 ? s : s.slice(0, e2)).trim().toLowerCase(); const v = e2 < 0 ? '' : s.slice(e2 + 1).trim();
      if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
      if (k === 'expires' && v) expires = true;
      if (k === 'max-age' && /^-\d/.test(v)) expires = true;
    }
    const key = name + '|' + domain;
    if (expires || value === '') jar.delete(key);
    else { jar.set(key, { name, value, domain }); if (jar.size > 400) { const fk = jar.keys().next().value; jar.delete(fk); } }
  }
}
function browseAbs(u, base) { try { const a = new URL(String(u).trim(), base); return /^https?:$/.test(a.protocol) ? a.href : null; } catch { return null; } }
function browsePx(u, base) { const abs = browseAbs(u, base); return abs ? '/browse?url=' + encodeURIComponent(abs) : String(u); }
function browseRewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => (BROWSE_SKIP_URL.test(u.trim()) ? m : 'url(' + q + browsePx(u, base) + q + ')'))
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => (BROWSE_SKIP_URL.test(u.trim()) ? m : '@import ' + q + browsePx(u, base) + q));
}
function browseRewriteAttrs(seg, base) {
  return seg
    .replace(/(\s(?:href|src|action|formaction|poster|background|data-src)\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, v) => pre + q + (BROWSE_SKIP_URL.test(v.trim()) ? v : browsePx(v, base)) + q)
    // unquoted attribute values (minified HTML): src=/s.js — the proxy URL never contains spaces, so it stays legal unquoted
    .replace(/(\s(?:href|src|action|formaction|poster|background|data-src)\s*=\s*)([^\s"'=<>`]+)/gi, (m, pre, v) => (BROWSE_SKIP_URL.test(v) ? m : pre + browsePx(v, base)))
    .replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, v) => pre + q + v.split(',').map(p => { const t = p.trim().split(/\s+/); return t.length && t[0] && !BROWSE_SKIP_URL.test(t[0]) ? browsePx(t[0], base) + (t[1] ? ' ' + t.slice(1).join(' ') : '') : p.trim(); }).join(', ') + q)
    .replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*)([^"'>\s]+)/gi, (m, pre, v) => pre + browsePx(v, base))
    .replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, '')          // rewritten URLs break SRI hashes
    .replace(/(\starget\s*=\s*)(["'])_blank\2/gi, '$1$2_self$2')  // keep new tabs inside the panel
    .replace(/\scrossorigin(\s*=|\s|>)/gi, '$1');
}
function browseRewriteHtml(html, base) {
  const parts = html.split(/(<script\b[\s\S]*?<\/script\s*>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (/^<script\b/i.test(parts[i])) {
      // rewrite the opening tag's attributes (external script src!) but never the script body
      const gt = parts[i].indexOf('>');
      if (gt > 0) parts[i] = browseRewriteAttrs(parts[i].slice(0, gt), base) + parts[i].slice(gt);
      continue;
    }
    let seg = browseRewriteAttrs(parts[i], base);
    seg = browseRewriteCss(seg, base);              // inline style="…url(…)" + <style> blocks
    parts[i] = seg;
  }
  return parts.join('');
}
/* Patch injected into every proxied page: route JS-driven URLs through the proxy. Kept ES5-ish
   and self-contained because it is embedded verbatim; no template literals so the outer file
   stays free of nested backticks. */
const BROWSE_PATCH = '<script>(function(){' +
  'var UP=window.__csbUpstream||location.href,OF=window.fetch;' +
  'function fix(u){try{if(u==null)return u;' +
  'if(typeof u==="string"||u instanceof URL){var s=String(u);' +
  'if(/^https?:/i.test(s)){var a=new URL(s);if(a.origin===location.origin){if(a.pathname==="/browse"){var w=a.searchParams.get("url");if(w)return fix(w);}return s;}return "/browse?url="+encodeURIComponent(a.href);}' +
  'if(s.indexOf("/browse?")===0){var c=new URL(s,location.href);if(c.origin===location.origin&&c.pathname==="/browse"){var w2=c.searchParams.get("url");if(w2)return fix(w2);}}' +
  'var b=new URL(s,UP);if(/^https?:$/.test(b.protocol))return "/browse?url="+encodeURIComponent(b.href);}' +
  'return u;}catch(e){return u;}}' +
  'if(OF)window.fetch=function(input,init){try{' +
  'if(input&&typeof input==="object"&&"url" in input&&!(input instanceof URL)){var nu=fix(input.url);if(nu!==input.url)input=new Request(nu,input);}' +
  'else{var f=fix(input);if(f!==input)input=f;}}catch(e){}return OF.call(this,input,init);};' +
  'var XO=XMLHttpRequest.prototype.open;' +
  'XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);a[1]=fix(a[1]);return XO.apply(this,a);};' +
  'var WO=window.open;' +
  'window.open=function(u){try{var f=fix(u);if(f&&f!==u){location.href=f;return null;}}catch(e){}return WO?WO.apply(this,arguments):null;};' +
  'try{var PS=history.pushState,RS=history.replaceState;' +
  'history.pushState=function(s,t,u){try{if(u!=null)u=fix(String(u));}catch(e){}return PS.call(history,s,t,u);};' +
  'history.replaceState=function(s,t,u){try{if(u!=null)u=fix(String(u));}catch(e){}return RS.call(history,s,t,u);};}catch(e){}' +
  'try{var LA=location.assign.bind(location),LR=location.replace.bind(location);' +
  'location.assign=function(u){LA(fix(u));};location.replace=function(u){LR(fix(u));};}catch(e){}' +
  'try{if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.reject(new Error("disabled inside the CodeSpace proxy"));};}catch(e){}' +
  '})();</script>';
function browseInject(html, upstreamUrl) {
  const tag = '<script>window.__csbUpstream=' + JSON.stringify(upstreamUrl) + ';</script>' + BROWSE_PATCH;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
}
function browseErrorPage(res, status, title, detail) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title></head><body style="font:14px/1.6 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px"><h2>' + esc(title) + '</h2><p>' + esc(detail) + '</p><p style="opacity:.65">CodeSpace Browser panel — switch the rendering mode to try another way to load this site.</p></body></html>');
}
async function browseProxy(req, res) {
  let t;
  try {
    const u = new URL(req.url || '/browse', 'http://127.0.0.1');
    t = new URL(u.searchParams.get('url') || '');
  } catch { return browseErrorPage(res, 400, 'Nothing to open', 'Use the Browser panel address bar — the proxy needs a complete http(s) website address.'); }
  if (!/^https?:$/.test(t.protocol)) return browseErrorPage(res, 400, 'Unsupported address', 'Only http and https websites can be opened through the proxy.');
  if ((req.headers.host || '') === t.host) return browseErrorPage(res, 400, 'That is this app', 'The CodeSpace app itself cannot be opened through its own proxy.');
  const jar = browseJar(req, res); jar.t = Date.now();
  const method = (req.method || 'GET').toUpperCase();
  let body = null;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const chunks = []; let size = 0, tooBig = false;
    await new Promise(resolve => {
      req.on('data', c => { size += c.length; if (size > BROWSE_MAX_BODY) { tooBig = true; req.destroy(); return; } chunks.push(c); });
      req.on('end', resolve); req.on('error', resolve); req.on('close', resolve);
    });
    if (tooBig) return browseErrorPage(res, 413, 'Upload too large', 'The proxy accepts request bodies up to 25 MB.');
    body = Buffer.concat(chunks);
  }
  const fwd = { 'user-agent': BROWSE_UA, 'accept-encoding': 'gzip, deflate', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'upgrade-insecure-requests': '1', 'sec-ch-ua': '"Not-A.Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' };
  for (const h of ['accept', 'accept-language', 'range']) { const v = req.headers[h]; if (v) fwd[h] = Array.isArray(v) ? v.join(', ') : v; }
  if (!fwd.accept) fwd.accept = '*/*';
  if (req.headers.referer) { try { const ru = new URL(req.headers.referer, 'http://127.0.0.1').searchParams.get('url'); if (ru) fwd.referer = ru; } catch {} }
  const cookie = browseCookieHeader(jar.c, t.hostname);
  if (cookie) fwd.cookie = cookie;
  if (body && body.length) {
    fwd['content-length'] = String(body.length);
    if (!fwd['content-type']) fwd['content-type'] = 'application/x-www-form-urlencoded';
    // 3.13.6: sign-in and other CSRF-checked POSTs expect an Origin that matches the site.
    // Through the proxy the browser sends this app's origin and sites reject it; send the
    // upstream origin instead, which is what a same-site form post would carry.
    fwd.origin = t.origin;
    try { if (fwd.referer && new URL(fwd.referer).host === t.host) fwd['sec-fetch-site'] = 'same-origin'; } catch {}
  }
  let resp;
  try {
    resp = await fetch(t.href, { method, headers: fwd, body: body && body.length ? body : undefined, redirect: 'manual', signal: AbortSignal.timeout(BROWSE_TIMEOUT) });
  } catch (e) {
    return browseErrorPage(res, 502, 'Could not reach the website', String((e && e.message) || e) + ' — the site may be down, offline, or the address may be wrong.');
  }
  // redirects are handed back to the browser so the iframe URL (and history) stays in sync
  if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
    const loc = browseAbs(resp.headers.get('location'), t.href);
    if (loc) { res.writeHead([301, 302, 307, 308].includes(resp.status) ? resp.status : 302, { Location: '/browse?url=' + encodeURIComponent(loc), 'Cache-Control': 'no-store' }); return res.end(); }
  }
  try { const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []; if (sc.length) browseStoreCookies(jar.c, t.hostname, sc); } catch {}
  const ct = (resp.headers.get('content-type') || 'application/octet-stream').toLowerCase();
  const outHeaders = { 'Content-Type': resp.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' };
  for (const h of ['content-disposition', 'accept-ranges', 'content-range']) { const v = resp.headers.get(h); if (v) outHeaders[h] = v; }
  const status = resp.status === 204 || resp.status === 304 ? 200 : resp.status;
  if (/^text\/html|application\/xhtml/.test(ct)) {
    let html = await resp.text();
    if (html.length > BROWSE_MAX_HTML) html = html.slice(0, BROWSE_MAX_HTML);
    res.writeHead(status, outHeaders);
    return res.end(browseInject(browseRewriteHtml(html, t.href), t.href));
  }
  if (/^text\/css/.test(ct)) {
    res.writeHead(status, outHeaders);
    return res.end(browseRewriteCss(await resp.text(), t.href));
  }
  res.writeHead(status, outHeaders);
  if (!resp.body) return res.end();
  try { const reader = resp.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } } catch {}
  res.end();
}

/* ---------- server ---------- */
process.on('exit', () => { for (const key of [...VSCODE_NODE_HOSTS.keys()]) { try { VSCODE_NODE_HOSTS.get(key).child.kill(); } catch {} } });
process.on('SIGTERM', () => { for (const key of [...VSCODE_NODE_HOSTS.keys()]) { try { VSCODE_NODE_HOSTS.get(key).child.kill(); } catch {} } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref?.(); });

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');

  const hostOnly = h => String(h || '').toLowerCase().replace(/:\d+$/, '');
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  const publicHost = (!!PUBLIC_HOST && hostOnly(req.headers.host) === hostOnly(PUBLIC_HOST))
    || isCodespaceForwardedHost(req.headers.host);
  if (!localHost && !publicHost) return send(res, 403, { error: 'Bad host header' });
  // Public health check for Render/Docker. Deliberately leaks no paths, tokens, or workspace data.
  if (req.method === 'GET' && new URL(req.url || '/', 'http://127.0.0.1').pathname === '/healthz') return send(res, 200, { ok: true, service: 'codespace-agent' });
  // 3.13.5: the Browser panel's Proxy mode. Runs before auth: iframe navigations carry no token,
  // and it is a plain user-facing website fetcher on the user's own machine (all real APIs stay token-gated).
  // Hosted mode disables it by default because it would otherwise be an unauthenticated open proxy.
  if (req.method === 'GET' || req.method === 'POST') {
    try {
      if (new URL(req.url || '/', 'http://127.0.0.1').pathname === '/browse') {
        if (!ALLOW_BROWSE_PROXY) return send(res, 403, { error: 'The /browse proxy is disabled in hosted mode. Set CODESPACE_ALLOW_BROWSE_PROXY=1 only if you understand the risk.' });
        return await browseProxy(req, res);
      }
    } catch (e) { return send(res, 500, { error: e.message || 'Proxy failed' }); }
  }
  // Phase 3R: public, read-only PWA shell (the app HTML contains no token; every bridge call still needs the token)
  if (req.method === 'GET') {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname.startsWith('/extension-host/assets/')) {
      if (u.searchParams.get('token') !== TOKEN) return send(res, 401, { error: 'Wrong or missing extension asset token' });
      const parts = u.pathname.slice('/extension-host/assets/'.length).split('/').map(x => { try { return decodeURIComponent(x); } catch { return ''; } });
      const key = parts.shift(), rel = parts.join('/');
      if (!/^[a-f0-9]{24}$/.test(key) || !rel || rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..') || !/\.js$/i.test(rel)) return send(res, 400, { error: 'Invalid extension asset path' });
      const root = path.resolve(VSCODE_EXT_DIR, key), state = readJson(path.join(root, 'codespace-install.json'), null);
      if (!state || (state.hostType && state.hostType !== 'web')) return send(res, 404, { error: 'This extension does not have a web runtime.' });
      const file = path.resolve(root, ...rel.split('/'));
      if (!inside(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Extension asset not found' });
      try { if (!inside(fs.realpathSync(root), fs.realpathSync(file))) return send(res, 403, { error: 'Extension asset path is outside its installation folder' }); } catch { return send(res, 404, { error: 'Extension asset not found' }); }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  if (req.method === 'GET') {
    const pu = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    // 3.13.1: the app is split into css/ + src-js/ fragments; js/app.js is rebuilt from the
    // fragments automatically whenever one of them is newer than the built file.
    try { require('./tools/build-web.cjs').ensure(); } catch { /* serve whatever is built */ }
    const PWA = {
      '/': ['my-chat-agent-v3.html', 'text/html; charset=utf-8'], '/index.html': ['my-chat-agent-v3.html', 'text/html; charset=utf-8'], '/my-chat-agent-v3.html': ['my-chat-agent-v3.html', 'text/html; charset=utf-8'],
      '/css/01-base.css': ['css/01-base.css', 'text/css; charset=utf-8'],
      '/css/02-steps.css': ['css/02-steps.css', 'text/css; charset=utf-8'],
      '/css/03-chat.css': ['css/03-chat.css', 'text/css; charset=utf-8'],
      '/css/04-editor.css': ['css/04-editor.css', 'text/css; charset=utf-8'],
      '/css/05-composer-plan.css': ['css/05-composer-plan.css', 'text/css; charset=utf-8'],
      '/css/06-panels.css': ['css/06-panels.css', 'text/css; charset=utf-8'],
      '/css/07-extras.css': ['css/07-extras.css', 'text/css; charset=utf-8'],
      '/css/08-layout.css': ['css/08-layout.css', 'text/css; charset=utf-8'],
      '/js/app.js': ['js/app.js', 'text/javascript; charset=utf-8'],
      '/manifest.webmanifest': ['pwa/manifest.webmanifest', 'application/manifest+json; charset=utf-8'], '/sw.js': ['pwa/sw.js', 'text/javascript; charset=utf-8'],
      '/icons/icon-192.png': ['pwa/icons/icon-192.png', 'image/png'], '/icons/icon-512.png': ['pwa/icons/icon-512.png', 'image/png'],
      '/icons/icon-maskable-512.png': ['pwa/icons/icon-maskable-512.png', 'image/png'], '/icons/apple-touch-icon.png': ['pwa/icons/apple-touch-icon.png', 'image/png']
    };
    if (Object.prototype.hasOwnProperty.call(PWA, pu)) {
      const [rel, type] = PWA[pu], file = path.join(__dirname, ...rel.split('/'));
      if (!fs.existsSync(file)) return send(res, 404, { error: 'App file missing: ' + rel });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return fs.createReadStream(file).pipe(res);
    }
  }
  if (req.method === 'GET') { const u = new URL(req.url || '/', 'http://127.0.0.1'); const assets = { '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'], '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'], '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'] }; if (assets[u.pathname]) { const [rel, type] = assets[u.pathname]; const file = path.join(__dirname, 'node_modules', ...rel.split('/')); if (!fs.existsSync(file)) return send(res, 404, { error: 'Terminal assets not installed. Run npm install in the package folder.' }); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return fs.createReadStream(file).pipe(res); } }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!authorized(req)) return send(res, 401, { error: 'Wrong or missing token' });
  if (req.method === 'GET') {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/preview/stream') return previewStream(req, res);
    if (u.pathname === '/term/stream') { try { return terminalStream(req, res, u); } catch (e) { return send(res, 404, { error: e.message || 'Terminal not found' }); } }
    return send(res, 405, { error: 'Unsupported GET endpoint' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });

  try {
    const reqPath = (req.url || '').split('?')[0];
    const bodyLimit = reqPath === '/sandbox/copy_in' ? 40 * 1024 * 1024 : 5 * 1024 * 1024;
    const b = await readBody(req, bodyLimit);
    const auditEp = (req.url || '').split('?')[0];
    // 3.12: request-scoped permission-gate collector (see GATE_PLAN above). Cleared by send() on
    // completion; streaming routes get the same treatment via the 'finish' handler below.
    CURRENT_GATES = new Set();
    res.once('finish', () => { if (CURRENT_GATES && !CURRENT_GATES.lastWasChallenge) gatePlanClear(); });
    if (AUDITED.test(auditEp)) {
      const t0 = Date.now();
      res.once('close', () => auditWrite({ t: new Date(t0).toISOString(), ep: auditEp, ok: res.statusCode < 400, status: res.statusCode, ms: Date.now() - t0, approved: !!(b.approved || b.confirmed || b.autoApprove), ws: ROOT || '', d: auditSummary(auditEp, b || {}) }));
    }
    switch ((req.url || '').split('?')[0]) {
      case '/audit/list': return send(res, 200, auditList(b));
      case '/tools/installed': return send(res, 200, toolsList());
      case '/tools/record': return send(res, 200, toolsRecord(b));
      case '/tools/update-status': return send(res, 200, toolsUpdateStatus(b));
      case '/tools/remove-record': return send(res, 200, toolsRemove(b));
      case '/info': return send(res, 200, infoObj());
      case '/codespace/install-location': return send(res, 200, codespaceInstallationLocation());
      case '/opencode/status': return send(res, 200, openCodeStatus());
      case '/chat-zai/status': return send(res, 200, chatZaiStatus());
      case '/chat-zai/token': rateLimit(auditEp); return send(res, 200, chatZaiSetToken(b.token));
      case '/chat-zai/start': rateLimit(auditEp); try { return send(res, 200, await chatZaiStart()); } catch (e) { return send(res, 503, { ...chatZaiStatus(), error: e.message || String(e) }); }
      case '/chat-zai/stop': return send(res, 200, await chatZaiStop());
      case '/opencode/run': { const g = permGuard('terminal', 'Run the OpenCode agent (it can read files and run commands)', b); if (g) return send(res, 200, g); return openCodeRun(req, res, b); }
      case '/llm/proxy': return llmProxy(req, res, b);
      case '/opencode/install': rateLimit(auditEp); { const g = permGuard('terminal', 'Download and install the OpenCode CLI (runs its installer)', b); if (g) return send(res, 200, g); return ocInstallRoute(req, res); }
      case '/opencode/auth/get': return send(res, 200, ocAuthView());
      case '/opencode/auth/set': return send(res, 200, ocAuthSet(b));
      case '/workspace/dirs': return send(res, 200, wsDirs(b));
      case '/workspace/set': return send(res, 200, wsSet(b));
      case '/workspace/close': return send(res, 200, wsClose());
      case '/workspace/native-pick': return send(res, 200, await nativeFolderPick());
      case '/run': { const g = permGuard('terminal', 'Run command: ' + String(b.command || '').slice(0, 240), b); if (g) return send(res, 200, g); return b.background ? send(res, 200, await runBackground(b)) : runCommand(b, res); }
      case '/fs/list': return send(res, 200, fsList(b));
      case '/fs/read': return send(res, 200, fsRead(b));
      case '/fs/delete': { const g = permGuard('destructive', 'Delete ' + (b.recursive ? 'folder' : 'file') + ' ' + b.path, b); if (g) return send(res, 200, g); return send(res, 200, fsDelete(b)); }
      case '/fs/rename': { const g = permGuard('fsEdit', 'Rename or move "' + b.path + '" to "' + b.to + '"', b); if (g) return send(res, 200, g); return send(res, 200, fsRename(b)); }
      case '/fs/mkdir': { const g = permGuard('fsEdit', 'Create folder ' + b.path, b); if (g) return send(res, 200, g); return send(res, 200, fsMkdir(b)); }
      case '/git/status': return send(res, 200, gitStatus());
      case '/git/diff': return send(res, 200, gitDiff(b));
      case '/git/stage': { const g = permGuard('git', 'Stage files for commit: ' + JSON.stringify(b.paths || b.path || '').slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, gitStage(b)); }
      case '/git/unstage': { const g = permGuard('git', 'Unstage files: ' + JSON.stringify(b.paths || b.path || '').slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, gitUnstage(b)); }
      case '/git/discard': { const g = permGuard('destructive', 'Discard git changes' + (b.path ? ' in ' + b.path : ''), b); if (g) return send(res, 200, g); return send(res, 200, gitDiscard(b)); }
      case '/git/commit': { const g = permGuard('git', 'Commit staged changes: ' + String(b.message || '').slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, gitCommit(b)); }
      case '/git/log': return send(res, 200, gitLog(b));
      case '/git/init': { const g = permGuard('git', 'Initialize a new git repository in the workspace', b); if (g) return send(res, 200, g); return send(res, 200, gitInit()); }
      case '/git/push': { const g = permGuard('destructive', 'Push to the remote (git push)', b); if (g) return send(res, 200, g); return send(res, 200, gitSync('push')); }
      case '/git/pull': { const g = permGuard('git', 'Pull from the remote (git pull)', b); if (g) return send(res, 200, g); return send(res, 200, gitSync('pull')); }
      case '/git/branches': return send(res, 200, gitBranches());
      case '/git/checkout': { const g = permGuard('git', 'Checkout/switch branch: ' + String(b.branch || '').slice(0, 80), b); if (g) return send(res, 200, g); return send(res, 200, gitCheckout(b)); }
      case '/fs/write': { const g = permGuard('fsEdit', 'Write file ' + b.path, b); if (g) return send(res, 200, g); return send(res, 200, fsWrite(b)); }
      case '/fs/search': return send(res, 200, await fsSearch(b));
      case '/index/status': return send(res, 200, codeIndexStatus());
      case '/index/rebuild': rateLimit(auditEp); return send(res, 200, buildCodeIndex());
      case '/index/search': return send(res, 200, codeIndexSearch(b));
      case '/index/symbols': return send(res, 200, findCodeSymbols(b));
      case '/index/references': return send(res, 200, codeSymbolReferences(b));
      case '/index/related': return send(res, 200, relatedCodeFiles(b));
      case '/index/map': return send(res, 200, codeProjectMap());
      case '/checkpoints/list': return send(res, 200, cpList());
      case '/checkpoints/create': rateLimit(auditEp); return send(res, 200, await cpCreate(b));
      case '/checkpoints/compare': return send(res, 200, await cpCompare(b));
      case '/checkpoints/restore': { const g = permGuard('destructive', 'Restore checkpoint ' + b.id + ' (overwrites current workspace files)', b); if (g) return send(res, 200, g); rateLimit(auditEp); return send(res, 200, await cpRestore(b)); }
      case '/checkpoints/delete': { const g = permGuard('destructive', 'Delete checkpoint ' + b.id, b); if (g) return send(res, 200, g); return send(res, 200, cpDelete(b)); }
      case '/browser/open': { const g = permGuard('browser', 'Open ' + String(b.url || '').slice(0, 200) + ' in the browser', b); if (g) return send(res, 200, g); return send(res, 200, await browserOpen(b)); }
      case '/browser/screenshot': { const g = permGuard('browser', 'Take a browser screenshot', b); if (g) return send(res, 200, b.ifRunning ? { running: false, permission: 'browser' } : g); return send(res, 200, await browserShot(b)); }
      case '/browser/stream/start': { const g = permGuard('browser', 'Start live browser streaming', b); if (g) return send(res, 200, g); return send(res, 200, await browserStreamStart()); }
      case '/browser/stream/stop': { const g = permGuard('browser', 'Stop live browser streaming', b); if (g) return send(res, 200, g); return send(res, 200, await browserStreamStop()); }
      case '/browser/viewport': { const g = permGuard('browser', 'Change the browser viewport', b); if (g) return send(res, 200, g); return send(res, 200, await browserViewport(b)); }
      case '/browser/diagnostics': return send(res, 200, await browserDiagnostics());
      case '/browser/read': return send(res, 200, await browserRead());
      case '/browser/eval': { const g = permGuard('browser', 'Run JavaScript in the page: ' + String(b.expression || '').slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, await browserEval(b)); }
      case '/browser/click': { const g = permGuard('browser', 'Click ' + String(b.selector || (b.x != null ? 'x=' + b.x + ', y=' + b.y : '')).slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, await browserClick(b)); }
      case '/browser/type': { const g = permGuard('browser', 'Type text into ' + String(b.selector || '').slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, await browserType(b)); }
      case '/browser/key': { const g = permGuard('browser', 'Press key ' + String(b.key || '').slice(0, 40), b); if (g) return send(res, 200, g); return send(res, 200, await browserKey(b)); }
      case '/browser/scroll': { const g = permGuard('browser', 'Scroll the page', b); if (g) return send(res, 200, g); return send(res, 200, await browserScroll(b)); }
      case '/bridge/status': return send(res, 200, bridgeStatus());
      case '/bridge/poll': return bridgePoll(req, res);
      case '/bridge/result': return send(res, 200, bridgeResult(b));
      case '/bridge/call': { const g = permGuard('browser', 'Browser bridge call: ' + String(b.action || ''), b); if (g) return send(res, 200, g); return send(res, 200, await bridgeCall(b)); }
      case '/browser/nav': { const g = permGuard('browser', 'Navigate to ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await browserNav(b)); }
      case '/browser/close': await closeBrowserGraceful(); return send(res, 200, { closed: true });
      case '/config/get': return send(res, 200, configGet());
      case '/config/set': return send(res, 200, configSet(b));
      case '/sessions/save': return send(res, 200, sessSave(b));
      case '/sessions/list': return send(res, 200, sessList());
      case '/sessions/get': return send(res, 200, sessGet(b));
      case '/sessions/delete': return send(res, 200, sessDelete(b));
      case '/term/start': rateLimit(auditEp); { const g = permGuard('terminal', 'Start a terminal (' + String(b.shell || 'default shell') + ')', b); if (g) return send(res, 200, g); return send(res, 200, termInfo(termStart(b))); }
      case '/term/list': return send(res, 200, { terminals: [...TERMS.values()].map(termInfo) });
      case '/project-memory/get': return send(res, 200, projectMemoryGet());
      case '/project-memory/set': return send(res, 200, projectMemorySet(b));
      case '/project/understand': return send(res, 200, projectUnderstand());
      case '/project/understand/draft-memory': return send(res, 200, projectUnderstandMemoryDraft(b));
      case '/workflow/status': return send(res, 200, workflowStatus());
      case '/workflow/diagnostics': return send(res, 200, workflowDiagnostics());
      case '/term/read': return send(res, 200, termRead(b));
      case '/term/write': { const g = permGuard('terminal', 'Send input to terminal ' + String(b.id || ''), b); if (g) return send(res, 200, g); return send(res, 200, termWrite(b)); }
      case '/term/resize': return send(res, 200, termResize(b));
      case '/term/kill': { const g = permGuard('terminal', 'Kill terminal ' + String(b.id || ''), b); if (g) return send(res, 200, g); const t = termGet(b.id); termStop(t, true); return send(res, 200, { ok: true }); }
      case '/term/close': { const g = permGuard('terminal', 'Close terminal ' + String(b.id || ''), b); if (g) return send(res, 200, g); const t = TERMS.get(String(b.id)); if (t) { termStop(t, true); TERMS.delete(t.id); } return send(res, 200, { ok: true }); }
      case '/conn/status': return send(res, 200, connStatus());
      case '/conn/set': return send(res, 200, await connSet(b));
      case '/conn/remove': return send(res, 200, connRemove(b));
      case '/conn/github': return send(res, 200, await connGithub(b));
      case '/conn/vercel': return send(res, 200, await connVercel(b));
      case '/db/query': return send(res, 200, await dbQuery(b));
      case '/db/tables': return send(res, 200, await dbTables());
      case '/db/describe': return send(res, 200, await dbDescribe(b));
      case '/ext/list': return send(res, 200, await extList());
      case '/ext/catalog/search': return send(res, 200, await extCatalogSearch(b));
      case '/ext/package/inspect': return send(res, 200, await extPackageInspect(b));
      case '/ext/marketplace/search': { rateLimit(auditEp); const g = permGuard('network', 'Search the CodeSpace-compatible VS Code extension marketplace', b); if (g) return send(res, 200, g); return send(res, 200, await mktSearch(b)); }
      case '/ext/marketplace/install': { rateLimit(auditEp); const g = permGuard('ext', 'Install VS Code extension ' + String(b.id || '') + '@' + String(b.version || ''), b); if (g) return send(res, 200, g); return send(res, 200, await mktInstall(b)); }
      case '/ext/marketplace/installed': return send(res, 200, mktInstalled());
      case '/ext/marketplace/node/activate': { const g = permGuard('ext', 'Run VS Code extension ' + String(b.key || ''), b); if (g) return send(res, 200, g); return send(res, 200, await nodeHostStart(b)); }
      case '/ext/marketplace/node/command': return send(res, 200, await nodeHostCommand(b));
      case '/ext/marketplace/node/stop': return send(res, 200, nodeHostStop(String(b.key || '')));
      case '/ext/marketplace/node/status': return send(res, 200, nodeHostInfo(String(b.key || '')));
      case '/ext/marketplace/node/debug/stop': return send(res, 200, nodeHostDebugStop(b));
      case '/ext/marketplace/node/feature': return send(res, 200, await nodeHostFeatureRequest(b));
      case '/ext/marketplace/node/document': return send(res, 200, nodeHostDocumentSync(b));
      case '/ext/marketplace/node/view/open': return send(res, 200, nodeHostOpenWebviewView(b));
      case '/ext/marketplace/node/webview/message': return send(res, 200, nodeHostWebviewMessage(b));
      case '/ext/marketplace/node/webview/close': return send(res, 200, nodeHostWebviewClose(b));
      case '/ext/marketplace/uninstall': { const g = permGuard('destructive', 'Uninstall VS Code extension ' + String(b.key || ''), b); if (g) return send(res, 200, g); return send(res, 200, mktUninstall(b)); }
      case '/ext/marketplace/open-vscode': rateLimit(auditEp); if (permDenyOnly('ext')) { const e = new Error('Blocked by CodeSpace permission settings: extensions (ext).'); e.status = 403; throw e; } return send(res, 200, mktOpenInVscode(b));
      case '/ext/install': rateLimit(auditEp); { const g = permGuard('ext', 'Install extension: ' + String(b.source || ''), b); if (g) return send(res, 200, g); return send(res, 200, await extInstall(b)); }
      case '/ext/toggle': { const g = permGuard('ext', 'Toggle extension: ' + String(b.name || ''), b); if (g) return send(res, 200, g); return send(res, 200, extToggle(b)); }
      case '/ext/remove': { const g = permGuard('destructive', 'Remove extension: ' + String(b.name || ''), b); if (g) return send(res, 200, g); return send(res, 200, extRemove(b)); }
      case '/ext/restart': { const g = permGuard('ext', 'Restart extension: ' + String(b.name || ''), b); if (g) return send(res, 200, g); return send(res, 200, extRestart(b)); }
      case '/ext/call': { const g = permGuard('mcp', 'Call MCP tool ' + String(b.name || '') + ' → ' + String(b.tool || ''), b); if (g) return send(res, 200, g); return send(res, 200, await extCall(b)); }
      case '/skills/list': return send(res, 200, { skills: listSkills() });
      case '/skills/get': return send(res, 200, skillGet(b));
      case '/skills/install': rateLimit(auditEp); { const g = permGuard('ext', 'Install skill: ' + String(b.source || b.name || ''), b); if (g) return send(res, 200, g); return send(res, 200, await skillInstall(b)); }
      case '/skills/remove': { const g = permGuard('ext', 'Remove skill: ' + String(b.name || ''), b); if (g) return send(res, 200, g); return send(res, 200, skillRemove(b)); }
      /* ---- 3.10 additions ---- */
      case '/perm/get': return send(res, 200, permGet());
      case '/perm/set': return send(res, 200, permSet(b));
      case '/web/search': rateLimit(auditEp); { const g = permGuard('network', 'Web search: ' + String(b.query || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webSearch(b)); }
      case '/web/fetch': rateLimit(auditEp); { const g = permGuard('network', 'Fetch web page: ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webFetch(b)); }
      case '/web/extract': rateLimit(auditEp); { const g = permGuard('network', 'Extract web page content: ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webExtract(b)); }
      case '/web/find': rateLimit(auditEp); { const g = permGuard('network', 'Search inside a web page: ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webFind(b)); }
      case '/web/crawl': rateLimit(auditEp); { const g = permGuard('network', 'Crawl website: ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webCrawl(b)); }
      case '/web/screenshot': rateLimit(auditEp); { const g = permGuard('network', 'Screenshot website: ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await webScreenshot(b)); }
      case '/http/request': rateLimit(auditEp); { const g = permGuard('network', 'HTTP ' + String(b.method || 'GET').toUpperCase() + ' ' + String(b.url || '').slice(0, 200), b); if (g) return send(res, 200, g); return send(res, 200, await httpRequest(b)); }
      case '/http/inspect': return send(res, 200, httpInspect(b));
      case '/http/collection': { if (String(b.action || 'list') === 'run') { const g = permGuard('network', 'Run saved API request ' + String(b.id || b.name || ''), b); if (g) return send(res, 200, g); } return send(res, 200, await apiCollection(b)); }
      case '/dev/tooling': return send(res, 200, { tools: toolchain(b.refresh === true) });
      case '/dev/tests': rateLimit(auditEp); return send(res, 200, await devRunTests(b));
      case '/dev/diagnostics': rateLimit(auditEp); return send(res, 200, await devDiagnostics(b));
      case '/dev/lint': rateLimit(auditEp); return send(res, 200, await devLint(b));
      case '/dev/format': rateLimit(auditEp); return send(res, 200, await devFormat(b));
      case '/dev/deps': rateLimit(auditEp); return send(res, 200, await devDeps(b));
      case '/dev/unused': return send(res, 200, await devUnused(b));
      case '/dev/health': return send(res, 200, await devHealth());
      case '/fs/editbatch': return send(res, 200, await fsEditBatch(b));
      case '/fs/history': return send(res, 200, fsHistory(b));
      case '/fs/undo': return send(res, 200, fsUndoRedo(b, 'undo'));
      case '/fs/redo': return send(res, 200, fsUndoRedo(b, 'redo'));
      case '/index/rename': return send(res, 200, await indexRename(b));
      case '/browser/hover': { const g = permGuard('browser', 'Hover over ' + String(b.selector || (b.x != null ? 'x=' + b.x + ', y=' + b.y : 'the page')).slice(0, 160), b); if (g) return send(res, 200, g); return send(res, 200, await browserHover(b)); }
      case '/browser/select': { const g = permGuard('browser', 'Select "' + String(b.value || '').slice(0, 80) + '" in ' + String(b.selector || '').slice(0, 120), b); if (g) return send(res, 200, g); return send(res, 200, await browserSelectOption(b)); }
      case '/browser/upload': { const g = permGuard('browser', 'Attach file(s) ' + JSON.stringify(b.files || b.file || []).slice(0, 200) + ' to a file input', b); if (g) return send(res, 200, g); return send(res, 200, await browserUpload(b)); }
      case '/browser/download': { const g = permGuard('browser', 'Download a file via the browser to ' + String(b.dir || 'downloads'), b); if (g) return send(res, 200, g); return send(res, 200, await browserDownload(b)); }
      case '/browser/wait': { const g = permGuard('browser', 'Wait for the page (' + String(b.selector || b.text || 'delay').slice(0, 120) + ')', b); if (g) return send(res, 200, g); return send(res, 200, await browserWait(b)); }
      case '/browser/dom_snapshot': { const g = permGuard('browser', 'Take a DOM snapshot', b); if (g) return send(res, 200, g); return send(res, 200, await browserDomSnapshot(b)); }
      case '/browser/a11y_tree': { const g = permGuard('browser', 'Read the accessibility tree', b); if (g) return send(res, 200, g); return send(res, 200, await browserA11yTree(b)); }
      case '/browser/tabs': { const g = permGuard('browser', 'List or switch browser tabs', b); if (g) return send(res, 200, g); return send(res, 200, await browserTabsCdp(b)); }
      case '/task/create': return send(res, 200, await taskCreate(b));
      case '/task/get': return send(res, 200, taskGet(b));
      case '/task/list': return send(res, 200, taskList());
      case '/task/cancel': return send(res, 200, taskCancel(b));
      case '/task/retry': return send(res, 200, await taskRetry(b));
      case '/task/delete': return send(res, 200, taskDelete(b));
      default: { const h = SBX_ROUTES[auditEp]; if (h) return send(res, 200, await h(b)); return send(res, 404, { error: 'Unknown endpoint' }); }
    }
  } catch (e) {
    if (!res.headersSent) send(res, e && e.status ? e.status : 400, { error: e.message || String(e) });
  }
});

/* A stray rejected promise (a background task, a client that vanished mid-response) must not take the whole backend down
   with it. Startup failures such as EADDRINUSE are still fatal: they are handled by server.on('error') below. */
process.on('unhandledRejection', e => { try { console.error('[bridge] unhandled rejection:', (e && e.stack) || e); } catch {} });
process.on('uncaughtException', e => { try { console.error('[bridge] uncaught exception:', (e && e.stack) || e); } catch {} });
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use. Try --port ' + (PORT + 1) : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const shownHost = PUBLIC_HOST || (HOST === '0.0.0.0' ? '127.0.0.1' : HOST);
  const shownUrl = (PUBLIC_HOST ? 'https://' : 'http://') + shownHost + (PUBLIC_HOST ? '' : ':' + PORT);
  console.log('\nCodeSpace bridge is running');
  console.log('  URL:        ' + shownUrl);
  console.log('  Token:      ' + (HOSTED ? 'set via CODESPACE_API_TOKEN (hidden)' : TOKEN));
  console.log('  Listen:     ' + HOST + ':' + PORT);
  console.log('  Workspace:  ' + (ROOT || '(none yet: choose one with File > Open Folder in the app)'));
  console.log('  Node:       ' + process.version + '   Python: ' + (PYTHON || 'not found') + '   git: ' + (GIT_OK ? 'yes' : 'no'));
  console.log('  Browser:    ' + (CHROME ? CHROME + (SHOW_BROWSER ? '  (visible window)' : '  (hidden, shown inside the chat page)') : 'not found. Install Chrome or Edge, or use --chrome "path"'));
  console.log('  Shells:     ' + (SHELLS.map(x => x.label).join(', ') || 'none found') + '   MySQL: ' + (findMysql2() ? 'mysql2' : MYSQL_CLI ? 'mysql CLI' : 'not installed (npm install mysql2)'));
  console.log('  Saved data: ' + DATA);
  console.log('  Skills:     ' + SKILLS_USER + '  (and <workspace>/.agent/skills)');
  console.log('\nPaste the URL and token into Settings > Bridge in the chat page.');
  console.log('Anyone with the token can run commands on this computer. Keep it private. Ctrl+C to stop.\n');
});
