#!/usr/bin/env node
'use strict';
/* ================= CodeSpace 3.12: Universal Sandbox Engine =================
   A backend subsystem (not a separate app) that creates isolated, disposable
   environments, runs commands/tests inside them, and exports reviewed changes.

   Design rules implemented here:
   - Provider adapter architecture: detect / capabilities / healthCheck / create /
     inspect / exec / copyIn / copyOut / readLogs / stop / destroy.
   - Capability detection only — the agent can never select an unavailable provider,
     and there is NO silent fallback to unisolated host execution.
   - Network access is disabled by default (--network none). Other policies require
     the sandboxNetwork permission and report their enforcement level honestly.
   - The workspace is transferred as a filtered snapshot (secrets excluded) into the
     sandbox; nothing is written back to the real workspace without the sandboxExport
     permission, an approval token, a recovery checkpoint and path-safety checks.
   - Resource limits are enforced where the provider supports them and REPORTED as
     unenforced where it does not.
   - Orphan recovery: sandbox records persist; on boot and on a periodic sweep any
     container not owned by a live task is removed.
   - A mock provider exists ONLY for deterministic tests (MY_AGENT_SANDBOX_MOCK=1) and
     is clearly labelled NON-ISOLATED; it is never selected automatically. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

module.exports = function createSandboxManager(ctx) {
  const {
    DATA, WIN, sleep, safe, permGuard, permLoad, writeJson, readJson,
    cpCreate, atomicWrite, invalidateCodeIndex, auditNote, walkWorkspace, taskAlive
  } = ctx;
  const withEditLock = typeof ctx.withEditLock === 'function' ? ctx.withEditLock : (fn => fn());

  /* ---------- state ---------- */
  const SBX_DIR = path.join(DATA, 'sandboxes');
  const STAGING_DIR = path.join(DATA, 'sandbox-staging');
  const SANDBOXES = new Map();          // id -> record
  let sandboxesLoaded = false;
  let sbxSeq = 0;
  const MAX_CONCURRENT = Math.max(1, Math.min(8, Number(process.env.CODESPACE_MAX_SANDBOXES) || 1));
  // Optional hard caps for free-tier hosts. These only LOWER resolved limits, never raise them,
  // and are applied after profile limits so per-language settings survive when below the cap.
  const ENV_CPU_CAP = Number(process.env.CODESPACE_SANDBOX_CPU_LIMIT) > 0 ? Math.max(1, Number(process.env.CODESPACE_SANDBOX_CPU_LIMIT)) : 0;
  const ENV_MEM_CAP = Number(process.env.CODESPACE_SANDBOX_MEMORY_MB) > 0 ? Math.max(128, Number(process.env.CODESPACE_SANDBOX_MEMORY_MB)) : 0;
  const MOCK_ALLOWED = process.env.MY_AGENT_SANDBOX_MOCK === '1';
  const CAP_CACHE_MS = 30000;
  let capCache = null, capCacheAt = 0;

  /* ---------- environment profiles (versioned manifest) ---------- */
  // Image references are pinned to specific version tags (never `latest`). After the first
  // pull the manager records the registry digest (RepoDigests) and re-uses it, so runs are
  // reproducible on a given machine. Aliases below resolve to concrete tags, not floats.
  const PROFILES_MANIFEST_VERSION = 1;
  const PROFILES = [
    { id: 'python-3.10', provider: 'docker', image: 'python:3.10-slim-bookworm', language: 'python', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['python', 'test'] },
    { id: 'python-3.11', provider: 'docker', image: 'python:3.11-slim-bookworm', language: 'python', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['python', 'test'] },
    { id: 'python-3.12', provider: 'docker', image: 'python:3.12-slim-bookworm', language: 'python', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['python', 'test'] },
    { id: 'python-3.13', provider: 'docker', image: 'python:3.13-slim-bookworm', language: 'python', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['python', 'test'] },
    { id: 'node-20', provider: 'docker', image: 'node:20-bookworm-slim', language: 'node', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 512, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['node', 'javascript', 'test'] },
    { id: 'node-22', provider: 'docker', image: 'node:22-bookworm-slim', language: 'node', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 512, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['node', 'javascript', 'test'] },
    { id: 'node-24', provider: 'docker', image: 'node:24-bookworm-slim', language: 'node', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 512, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['node', 'javascript', 'test'] },
    { id: 'php-8.3', provider: 'docker', image: 'php:8.3-cli-bookworm', language: 'php', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['php', 'test'] },
    { id: 'java-21', provider: 'docker', image: 'eclipse-temurin:21-jdk-bookworm', language: 'java', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 2048, pidsLimit: 384, diskMb: 3072 }, timeoutSec: 180, cleanup: 'destroy', tags: ['java', 'compile', 'test'] },
    { id: 'java-17', provider: 'docker', image: 'eclipse-temurin:17-jdk-bookworm', language: 'java', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 2048, pidsLimit: 384, diskMb: 3072 }, timeoutSec: 180, cleanup: 'destroy', tags: ['java', 'compile', 'test'] },
    { id: 'golang-1.23', provider: 'docker', image: 'golang:1.23-bookworm', language: 'go', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 3072 }, timeoutSec: 180, cleanup: 'destroy', tags: ['go', 'compile', 'test'] },
    { id: 'rust-stable', provider: 'docker', image: 'rust:1.83-slim-bookworm', language: 'rust', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 4096 }, timeoutSec: 300, cleanup: 'destroy', tags: ['rust', 'compile'] },
    { id: 'cpp-gcc', provider: 'docker', image: 'gcc:14-bookworm', language: 'cpp', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 180, cleanup: 'destroy', tags: ['cpp', 'c', 'compile'] },
    { id: 'dotnet-9', provider: 'docker', image: 'mcr.microsoft.com/dotnet/sdk:9.0', language: 'dotnet', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 3072 }, timeoutSec: 180, cleanup: 'destroy', tags: ['dotnet', 'csharp', 'test'] },
    { id: 'ruby-3.3', provider: 'docker', image: 'ruby:3.3-slim-bookworm', language: 'ruby', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['ruby', 'test'] },
    { id: 'linux-ubuntu', provider: 'docker', image: 'ubuntu:24.04', language: 'shell', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['shell', 'bash', 'linux'] },
    { id: 'linux-debian', provider: 'docker', image: 'debian:12-slim', language: 'shell', workdir: '/workspace', network: 'none', resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 2048 }, timeoutSec: 120, cleanup: 'destroy', tags: ['shell', 'bash', 'linux'] },
    { id: 'wasm-module', provider: 'wasmtime', image: '(local .wasm module)', language: 'wasm', workdir: '/', network: 'none', resources: { cpus: null, memoryMb: 512, pidsLimit: null, diskMb: 256 }, timeoutSec: 60, cleanup: 'destroy', tags: ['wasm', 'wasi'], note: 'Runs WASI modules with no preopened host directories unless sandboxMount is granted; cannot run native Python/Node/PHP/Java/C/C++ applications.' },
    { id: 'windows-powershell', provider: 'windows-sandbox', image: '(Windows Sandbox base image)', language: 'powershell', workdir: 'C:\\workspace', network: 'none', resources: { cpus: null, memoryMb: null, pidsLimit: null, diskMb: null }, timeoutSec: 300, cleanup: 'destroy', tags: ['windows', 'powershell'], note: 'Requires the Windows Sandbox feature on Windows Pro/Enterprise. Isolation depends on the host feature set; limitations are reported per session.' }
  ];
  const profileById = id => PROFILES.find(p => p.id === id);
  const RES_DEFAULTS = { cpus: 1, memoryMb: 1536, pidsLimit: 256, diskMb: 2048, timeoutSec: 120 };
  const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
  function resolveResources(p, over) {
    // Defaults are the fallback, not an overwrite: profile-specific limits (for example
    // Java's 2048 MB / 3072 MB) must survive resolution.
    const profileLimits = p && p.resources && typeof p.resources === 'object' ? p.resources : {};
    const base = { ...RES_DEFAULTS, ...(p && p.timeoutSec != null ? { timeoutSec: p.timeoutSec } : {}), ...profileLimits };
    const o = over && typeof over === 'object' ? over : {};
    const choose = key => o[key] !== undefined && o[key] !== null ? o[key] : (base[key] !== undefined && base[key] !== null ? base[key] : RES_DEFAULTS[key]);
    const hostMemMb = Math.max(128, Math.round(os.totalmem() / 1048576));
    const hostCpus = Math.max(1, os.cpus().length);
    const mem = clamp(choose('memoryMb'), 128, Math.max(128, Math.min(8192, hostMemMb)), RES_DEFAULTS.memoryMb);
    return {
      cpus: Math.min(clamp(choose('cpus'), 1, hostCpus, RES_DEFAULTS.cpus), ENV_CPU_CAP || Number.POSITIVE_INFINITY),
      memoryMb: Math.min(mem, ENV_MEM_CAP || Number.POSITIVE_INFINITY),
      pidsLimit: clamp(choose('pidsLimit'), 16, 2048, RES_DEFAULTS.pidsLimit),
      diskMb: clamp(choose('diskMb'), 64, 20480, RES_DEFAULTS.diskMb),
      timeoutSec: clamp(choose('timeoutSec'), 5, 1800, RES_DEFAULTS.timeoutSec)
    };
  }

  /* ---------- low-level process capture ---------- */
  // Commands frequently launch grandchildren (for example sh -> node). Killing only
  // the shell leaves its child alive with stdout/stderr pipes open, so the caller never
  // receives `close` and sandbox timeouts can hang forever. Use a process group on POSIX
  // and taskkill /T on Windows, with a direct-child fallback on both platforms.
  function killProcessTree(child) {
    if (!child || !child.pid) return;
    if (WIN) {
      try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (!e || e.code !== 'ESRCH') { try { child.kill('SIGKILL'); } catch {} } }
    try { child.kill('SIGKILL'); } catch {}
  }
  function runCapture(argv, opts = {}) {
    return new Promise(resolve => {
      let child;
      try { child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd || undefined, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: false, detached: !WIN }); }
      catch (e) { return resolve({ exitCode: -1, timedOut: false, stdout: '', stderr: String(e.message || e) }); }
      let stdout = '', stderr = '', done = false, timedOut = false;
      const CAP = 200000, t0 = Date.now();
      const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, opts.timeout || 30000);
      child.stdout.on('data', c => { if (stdout.length < CAP) stdout += c.toString('utf8'); });
      child.stderr.on('data', c => { if (stderr.length < CAP) stderr += c.toString('utf8'); });
      child.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: -1, timedOut, durationMs: Date.now() - t0, stdout, stderr: (stderr + '\n' + e.message).slice(0, CAP) }); });
      child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code == null ? -1 : code, timedOut, durationMs: Date.now() - t0, stdout, stderr }); });
    });
  }
  function probe(argv, timeout = 15000) {
    try {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout, windowsHide: true, shell: false });
      return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error ? String(r.error.message) : null };
    } catch (e) { return { ok: false, stdout: '', stderr: '', error: String(e.message || e) }; }
  }

  /* ---------- persistence + records ---------- */
  const sbxFile = id => path.join(SBX_DIR, String(id).replace(/[^\w.-]/g, '') + '.json');
  function sbxSave(j) { try { fs.mkdirSync(SBX_DIR, { recursive: true }); writeJson(sbxFile(j.id), j); } catch {} }
  function sbxView(j) {
    return {
      id: j.id, provider: j.provider, profile: j.profile, image: j.image, imageDigest: j.imageDigest || null,
      state: j.state, createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt, taskOwner: j.taskOwner || null,
      resources: j.resources, networkPolicy: j.networkPolicy, networkEnforcement: j.networkEnforcement || null,
      isolation: j.isolation || null, filesIn: j.filesIn || 0, filesOut: j.filesOut || 0,
      lastExitCode: j.lastExitCode, lastCommand: j.lastCommand, error: j.error, note: j.note || null,
      exportPending: j.exportPending || null, logs: (j.logs || []).slice(-15)
    };
  }
  function sbxLog(j, msg) {
    j.logs = j.logs || [];
    j.logs.push(new Date().toISOString().slice(11, 19) + ' ' + String(msg).slice(0, 300));
    if (j.logs.length > 60) j.logs.splice(0, j.logs.length - 40);
    sbxSave(j);
  }
  function sandboxesLoadOnce() {
    if (sandboxesLoaded) return; sandboxesLoaded = true;
    try {
      for (const f of fs.readdirSync(SBX_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = readJson(path.join(SBX_DIR, f), null);
        if (j && j.id) {
          if (j.state === 'running' || j.state === 'creating') j.state = 'interrupted';
          SANDBOXES.set(j.id, j);
        }
      }
    } catch {}
  }
  const sbxGet = id => { sandboxesLoadOnce(); const j = SANDBOXES.get(String(id || '')); if (!j) throw new Error('Sandbox not found: ' + id); return j; };
  function activeCount() { sandboxesLoadOnce(); return [...SANDBOXES.values()].filter(j => j.state === 'running' || j.state === 'creating').length; }

  /* ================================================================
     PROVIDER ADAPTERS
     ================================================================ */

  /* ---------- Docker / OCI provider (Docker Engine, Docker Desktop, rootless, Podman CLI) ---------- */
  const dockerCli = (() => {
    for (const c of ['docker', 'podman']) { const p = probe([c, '--version'], 8000); if (p.ok) return { cli: c, version: p.stdout.trim().slice(0, 80) }; }
    return null;
  })();
  const DOCKER = dockerCli ? dockerCli.cli : null;
  const PODMAN = dockerCli && dockerCli.cli === 'podman';

  function dockerDetect() {
    if (!DOCKER) return { available: false, reason: 'Docker (or Podman) CLI not found on PATH. Install Docker Desktop or Podman and start the daemon.' };
    const v = probe([DOCKER, 'version', '--format', '{{json .}}'], 15000);
    if (!v.ok) return { available: false, reason: 'Docker CLI found but the daemon did not answer: ' + ((v.stderr || v.error || 'is the daemon running?').trim().slice(0, 200)) };
    let server = null; try { server = JSON.parse(v.stdout); } catch {}
    const info = probe([DOCKER, 'info', '--format', '{{json .}}'], 15000);
    let inf = {}; try { inf = JSON.parse(info.stdout || '{}'); } catch {}
    const security = Array.isArray(inf.SecurityOptions) ? inf.SecurityOptions : [];
    return {
      available: true, healthy: true, cli: DOCKER, cliVersion: dockerCli.version,
      serverVersion: server && server.Server && server.Server.Version || null,
      rootless: security.some(s => /rootless/i.test(s)),
      osType: inf.OSType || null, cpus: inf.NCPU || null, memoryMb: inf.MemTotal ? Math.round(inf.MemTotal / 1048576) : null,
      runtimes: inf.Runtimes ? Object.keys(inf.Runtimes) : [],
      gvisorRuntime: !!(inf.Runtimes && inf.Runtimes['runsc']),
      podmanCompatible: PODMAN
    };
  }
  const containerName = id => 'csbx_' + String(id).replace(/[^\w]/g, '');
  // Hardened docker arguments constructed ONLY from validated policy fields — never raw model flags.
  function dockerCreateArgs(rec, profile) {
    const r = rec.resources;
    if (rec.networkPolicy !== 'none') throw new Error('Docker sandbox network policies other than none are not available until CodeSpace provides a verified egress proxy. Refusing unrestricted bridge networking.');
    const args = [DOCKER, 'create', '--name', containerName(rec.id),
      '--workdir', profile.workdir || '/workspace',
      '--user', '1000:1000', // fixed non-root identity; never model-controlled
      '--memory', r.memoryMb + 'm', '--memory-swap', r.memoryMb + 'm',   // hard memory cap (no swap)
      '--cpus', String(r.cpus), '--pids-limit', String(r.pidsLimit),
      '--network', rec.networkPolicy === 'none' ? 'none' : 'bridge',     // none is the default and enforced
      '--read-only',                                                     // immutable root filesystem
      '--tmpfs', '/workspace:rw,exec,size=' + Math.max(64, r.diskMb) + 'm,uid=1000,gid=1000,mode=0770',
      '--tmpfs', '/tmp:rw,size=128m',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', // only needed for manager-controlled ownership normalization after docker cp
      '--security-opt', 'no-new-privileges',
      '--label', 'codespace.sandbox=' + rec.id,
      '--entrypoint', '/bin/sh'];
    if (rec.gvisor) args.push('--runtime', 'runsc');
    args.push(rec.imageDigest || rec.image, '-c', 'trap "exit 0" TERM; while :; do sleep 2; done');
    return args;
  }
  const dockerProvider = {
    id: 'docker',
    capabilities() {
      const d = dockerDetect();
      return { provider: 'docker', ...d, isolation: d.available ? 'container (namespaces, cgroups, caps-dropped, read-only rootfs, no network by default)' : null, enforcedLimits: d.available ? ['cpu', 'memory', 'pids', 'disk(tmpfs quota)', 'execTimeout'] : [] };
    },
    async healthCheck() { const d = dockerDetect(); return { healthy: !!d.available, detail: d.available ? 'daemon ok (server ' + (d.serverVersion || '?') + ')' : d.reason }; },
    async create(rec, profile) {
      const img = rec.imageDigest || rec.image;
      let ins = probe([DOCKER, 'image', 'inspect', img], 20000);
      if (!ins.ok) {
        // Pulling needs the network permission; it is checked by the route before create.
        const pull = await runCapture([DOCKER, 'pull', rec.image], { timeout: 600000 });
        if (pull.exitCode !== 0) throw new Error('Could not pull image ' + rec.image + ': ' + ((pull.stderr || pull.stdout).trim().slice(0, 300)));
        ins = probe([DOCKER, 'image', 'inspect', img], 20000);
        if (!ins.ok) throw new Error('Image pulled but inspect failed for ' + rec.image);
      }
      // Pin the digest so runs are reproducible (never a floating reference).
      try { const doc = JSON.parse(ins.stdout || '[]'); const digests = (doc[0] && doc[0].RepoDigests) || []; if (digests.length) rec.imageDigest = String(digests[0]).split('@')[0] + '@' + String(digests[0]).split('@')[1]; } catch {}
      const createArgs = dockerCreateArgs(rec, profile);
      const cr = await runCapture(createArgs, { timeout: 120000 });
      if (cr.exitCode !== 0) throw new Error('docker create failed: ' + ((cr.stderr || cr.stdout).trim().slice(0, 300)));
      const st = await runCapture([DOCKER, 'start', containerName(rec.id)], { timeout: 60000 });
      if (st.exitCode !== 0) { try { await runCapture([DOCKER, 'rm', '-f', containerName(rec.id)], { timeout: 30000 }); } catch {} throw new Error('docker start failed: ' + ((st.stderr || st.stdout).trim().slice(0, 300))); }
      rec.container = containerName(rec.id);
      return { container: rec.container };
    },
    async inspect(rec) {
      const r = await runCapture([DOCKER, 'inspect', '--format', '{{json .State}}', containerName(rec.id)], { timeout: 15000 });
      if (r.exitCode !== 0) return { state: 'gone' };
      try { const s = JSON.parse(r.stdout); return { state: s.Running ? 'running' : (s.OOMKilled ? 'oom-killed' : 'exited'), exitCode: s.ExitCode, oomKilled: !!s.OOMKilled, pid: s.Pid }; } catch { return { state: 'unknown' }; }
    },
    async exec(rec, { command, cwd, env, timeoutSec }) {
      const args = [DOCKER, 'exec', '-w', cwd || '/workspace'];
      for (const [k, v] of Object.entries(env || {}).slice(0, 20)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[\r\n]/.test(String(v))) args.push('-e', k + '=' + String(v).slice(0, 4000));
      args.push(containerName(rec.id), '/bin/sh', '-c', String(command));
      const r = await runCapture(args, { timeout: Math.max(1000, (timeoutSec || 120) * 1000) });
      return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.slice(0, 200000), stderr: r.stderr.slice(0, 200000), durationMs: r.durationMs };
    },
    async copyIn(rec, files) {
      // files: [{path (workspace-relative), content (string|Buffer)}] → staged in a temp dir, then docker cp.
      const stage = path.join(STAGING_DIR, 'in-' + rec.id + '-' + crypto.randomBytes(3).toString('hex'));
      fs.mkdirSync(stage, { recursive: true });
      try {
        for (const f of files) {
          const dest = path.resolve(stage, '.' + path.sep + String(f.path).replace(/\\/g, '/'));
          if (!dest.startsWith(stage + path.sep) && dest !== stage) throw new Error('Path traversal rejected: ' + f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, f.content);
        }
        const r = await runCapture([DOCKER, 'cp', stage + '/.', containerName(rec.id) + ':/workspace'], { timeout: 120000 });
        if (r.exitCode !== 0) throw new Error('docker cp in failed: ' + ((r.stderr || r.stdout).trim().slice(0, 200)));
        // Docker archive extraction commonly creates root-owned files. Normalize the copied
        // project to the fixed unprivileged runtime user, using only the narrowly added CHOWN
        // capability; all agent commands still execute as 1000:1000.
        const owner = await runCapture([DOCKER, 'exec', '-u', '0', containerName(rec.id), '/bin/sh', '-c', 'chown -R 1000:1000 /workspace'], { timeout: 30000 });
        if (owner.exitCode !== 0) throw new Error('Could not normalize sandbox workspace ownership for UID 1000: ' + ((owner.stderr || owner.stdout).trim().slice(0, 200)));
        return { copied: files.length, owner: '1000:1000' };
      } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
    },
    async copyOut(rec, remoteDir) {
      const stage = path.join(STAGING_DIR, 'out-' + rec.id + '-' + crypto.randomBytes(3).toString('hex'));
      fs.mkdirSync(stage, { recursive: true });
      const r = await runCapture([DOCKER, 'cp', containerName(rec.id) + ':/workspace/.', stage + '/'], { timeout: 180000 });
      if (r.exitCode !== 0) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} throw new Error('docker cp out failed: ' + ((r.stderr || r.stdout).trim().slice(0, 200))); }
      return stage;
    },
    async readLogs(rec, since) { const r = await runCapture([DOCKER, 'logs', '--tail', '200', containerName(rec.id)], { timeout: 20000 }); return { stdout: r.stdout.slice(0, 100000), stderr: r.stderr.slice(0, 100000) }; },
    async stop(rec) { await runCapture([DOCKER, 'stop', '-t', '5', containerName(rec.id)], { timeout: 30000 }); return { stopped: true }; },
    async destroy(rec) { const r = await runCapture([DOCKER, 'rm', '-f', containerName(rec.id)], { timeout: 30000 }); return { destroyed: r.exitCode === 0 || /No such container/i.test(r.stderr || '') }; }
  };

  /* ---------- Wasmtime provider (WASI modules only) ---------- */
  const WASMTIME = (() => { const p = probe(['wasmtime', '--version'], 8000); return p.ok ? { bin: 'wasmtime', version: p.stdout.trim().slice(0, 80) } : null; })();
  const wasmtimeProvider = {
    id: 'wasmtime',
    capabilities() {
      if (!WASMTIME) return { provider: 'wasmtime', available: false, reason: 'wasmtime was not found on PATH. Install Wasmtime to run WASI modules (https://wasmtime.dev).' };
      return { provider: 'wasmtime', available: true, healthy: true, version: WASMTIME.version, isolation: 'WASI capability-based: no network, no preopened host directories unless explicitly granted', enforcedLimits: ['memory (wasm max-memory)', 'execTimeout', 'no network', 'no host filesystem by default'], limitations: 'Runs WASM/WASI modules only — not native Python/Node/PHP/Java/C/C++ applications.' };
    },
    async healthCheck() { return { healthy: !!WASMTIME, detail: WASMTIME ? 'wasmtime ' + WASMTIME.version : 'not installed' }; },
    async create(rec) { return { scratch: true }; },
    async inspect(rec) { return { state: rec.state === 'running' ? 'running' : rec.state }; },
    async exec(rec, { command, timeoutSec }) {
      if (!WASMTIME) throw new Error('wasmtime is not installed on this machine.');
      // The only executable input is a regular .wasm file copied into this sandbox.
      // Never accept a host path from the model as a module path.
      const [moduleHint, ...rest] = String(command).split('---').map(s => s.trim());
      // The selected module must come from copyIn(), never from a model-supplied path.
      // Treat moduleHint only as an optional consistency check, not as a filesystem path.
      const modulePath = rec.scratchModule || null;
      if (!modulePath || !isInsidePath(rec.scratchDir, modulePath)) throw new Error('Copy a .wasm module into this sandbox before executing it. Host paths are not accepted.');
      if (moduleHint && path.basename(moduleHint) !== path.basename(modulePath)) throw new Error('Requested WASM module does not match the module copied into this sandbox.');
      let moduleStat;
      try { moduleStat = fs.lstatSync(modulePath); } catch { throw new Error('The copied WASM module was not found in this sandbox.'); }
      if (moduleStat.isSymbolicLink() || !moduleStat.isFile() || !/\.wasm$/i.test(modulePath)) throw new Error('WASM execution requires a regular .wasm file inside the sandbox scratch directory.');
      const moduleReal = fs.realpathSync(modulePath);
      if (!isInsidePath(fs.realpathSync(rec.scratchDir), moduleReal)) throw new Error('WASM module resolves outside the sandbox scratch directory.');
      const args = [WASMTIME.bin, 'run', '--wasm', 'max-memory=' + (rec.resources.memoryMb || 512) * 1048576];
      if (rec.mountGranted) args.push('--dir', rec.scratchDir);   // only with sandboxMount permission
      args.push(moduleReal);
      if (rest.length) args.push.apply(args, rest.slice(0, 32).map(s => String(s).slice(0, 500)));
      const r = await runCapture(args, { timeout: Math.max(1000, (timeoutSec || 60) * 1000), cwd: rec.scratchDir });
      return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.slice(0, 200000), stderr: r.stderr.slice(0, 200000), durationMs: r.durationMs };
    },
    async copyIn(rec, files) {
      fs.mkdirSync(rec.scratchDir, { recursive: true });
      for (const f of files) {
        if (!/\.wasm$/i.test(String(f.path))) throw new Error('The wasmtime provider only accepts .wasm modules (got: ' + f.path + ')');
        const dest = path.join(rec.scratchDir, path.basename(String(f.path)));
        fs.writeFileSync(dest, f.content);
        rec.scratchModule = dest;
      }
      return { copied: files.length };
    },
    async copyOut(rec) {
      // Export/copy-out consumers own and delete their staging directory. Always hand them
      // a fresh copy so the live Wasmtime sandbox survives repeated exports.
      const copy = path.join(STAGING_DIR, 'wasm-out-' + rec.id + '-' + crypto.randomBytes(4).toString('hex'));
      copyTreeNoLinks(rec.scratchDir, copy);
      return copy;
    },
    async readLogs(rec) { return { stdout: '', stderr: '' }; },
    async stop(rec) { return { stopped: true }; },
    async destroy(rec) { try { fs.rmSync(rec.scratchDir, { recursive: true, force: true }); } catch {} return { destroyed: true }; }
  };

  /* ---------- Windows Sandbox provider (config generation + session control) ---------- */
  function buildWsbConfig(rec, profile) {
    // Networking OFF, clipboard redirection off, only a READ-ONLY mapped folder and a
    // separate writable staging folder. Never maps the user profile or host filesystem.
    const hostIn = rec.hostInDir || 'C:\\CodeSpaceSandbox\\in';
    const hostOut = rec.hostOutDir || 'C:\\CodeSpaceSandbox\\out';
    const lines = [
      '<Configuration>',
      '  <Networking>' + (rec.networkPolicy === 'none' ? 'Disable' : 'Default') + '</Networking>',
      '  <ClipboardRedirection>Disable</ClipboardRedirection>',
      '  <PrinterRedirection>Disable</PrinterRedirection>',
      '  <AudioInput>Disable</AudioInput>',
      '  <VideoInput>Disable</VideoInput>',
      '  <ProtectedClient>' + (rec.harden === false ? 'Disable' : 'Enable') + '</ProtectedClient>',
      '  <MappedFolders>',
      '    <MappedFolder><ReadOnly>true</ReadOnly><HostFolder>' + hostIn + '</HostFolder></MappedFolder>',
      '    <MappedFolder><ReadOnly>false</ReadOnly><HostFolder>' + hostOut + '</HostFolder></MappedFolder>',
      '  </MappedFolders>',
      '  <LogonCommand><Command>powershell.exe -ExecutionPolicy Bypass -File ' + hostOut + '\\csbx-runner.ps1</Command></LogonCommand>',
      '</Configuration>'
    ];
    return lines.join('\r\n');
  }
  const winSandboxProvider = {
    id: 'windows-sandbox',
    capabilities() {
      if (!WIN) return { provider: 'windows-sandbox', available: false, reason: 'Windows Sandbox is a Windows Pro/Enterprise feature; this host is not Windows.' };
      const feat = probe(['powershell.exe', '-NoProfile', '-Command', '(Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM).State'], 30000);
      const enabled = feat.ok && /Enabled/i.test(feat.stdout);
      const vt = probe(['powershell.exe', '-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent'], 30000);
      if (!enabled) return { provider: 'windows-sandbox', detected: false, available: false, executable: false, reason: 'The Windows Sandbox feature (Containers-DisposableClientVM) is not enabled. Enable "Windows Sandbox" in Windows Features (requires Windows Pro/Enterprise and virtualization); CodeSpace never changes system features automatically.' };
      return { provider: 'windows-sandbox', detected: true, available: false, executable: false, healthy: !!vt.ok, hypervisorPresent: vt.ok, isolation: 'Windows Sandbox configuration generation is available; guest lifecycle execution is not implemented in this release', reason: 'Windows Sandbox was detected, but create/exec/copy lifecycle support is not implemented. This provider is not selectable yet.', limitations: 'Resource limits (CPU/RAM) inside the sandbox are NOT individually enforceable from the .wsb config; process/PID caps are not available.' };
    },
    async healthCheck() { const c = this.capabilities(); return { healthy: !!c.available, detail: c.available ? 'feature enabled' : c.reason }; },
    async create(rec, profile) { throw new Error('Windows Sandbox sessions are created only on a Windows host with the feature enabled (detected: ' + (WIN ? 'feature check in capabilities' : 'not Windows') + ').'); },
    async inspect() { return { state: 'unavailable' }; },
    async exec() { throw new Error('Windows Sandbox execution requires a running guest-runner session (Windows host only).'); },
    async copyIn() { throw new Error('Windows Sandbox copyIn requires a running session (Windows host only).'); },
    async copyOut() { throw new Error('Windows Sandbox copyOut requires a running session (Windows host only).'); },
    async readLogs() { return { stdout: '', stderr: '' }; },
    async stop() { return { stopped: false }; },
    async destroy() { return { destroyed: true }; }
  };

  /* ---------- Hyper-V provider (detection + clear reporting) ---------- */
  const hyperVProvider = {
    id: 'hyperv',
    capabilities() {
      if (!WIN) return { provider: 'hyperv', available: false, reason: 'Hyper-V is a Windows feature; this host is not Windows.' };
      const feat = probe(['powershell.exe', '-NoProfile', '-Command', '(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State'], 30000);
      if (!feat.ok || !/Enabled/i.test(feat.stdout)) return { provider: 'hyperv', available: false, reason: 'Hyper-V is not enabled (or this Windows edition does not support it). CodeSpace never enables Windows features or changes firmware settings automatically.' };
      const vms = probe(['powershell.exe', '-NoProfile', '-Command', '(Get-VM | Select-Object -First 20 Name,State | ConvertTo-Json)'], 30000);
      return { provider: 'hyperv', detected: true, available: false, executable: false, healthy: !!vms.ok, authorizedVms: vms.ok ? vms.stdout.slice(0, 4000) : '', reason: 'Hyper-V is enabled, but CodeSpace does not yet implement the authorized VM create/guest-exec/copy lifecycle. This provider is not selectable.', note: 'Detection only; VMs are not started or modified.' };
    },
    async healthCheck() { const c = this.capabilities(); return { healthy: !!c.available, detail: c.available ? 'Hyper-V enabled' : c.reason }; },
    async create() { throw new Error('Hyper-V test VMs require a user-approved VM image; none has been authorized. See the sandbox documentation for the authorization flow.'); },
    async inspect() { return { state: 'unavailable' }; },
    async exec() { throw new Error('Hyper-V guest execution requires an authorized VM image and PowerShell Direct credentials provided by the user.'); },
    async copyIn() { throw new Error('Hyper-V copyIn requires an authorized VM.'); },
    async copyOut() { throw new Error('Hyper-V copyOut requires an authorized VM.'); },
    async readLogs() { return { stdout: '', stderr: '' }; },
    async stop() { return { stopped: false }; },
    async destroy() { return { destroyed: true }; }
  };

  /* ---------- WSL2 provider (detection; NOT a strong isolation boundary) ---------- */
  const wslProvider = {
    id: 'wsl2',
    capabilities() {
      if (!WIN) return { provider: 'wsl2', available: false, reason: 'WSL2 is a Windows feature; this host is not Windows.' };
      const w = probe(['wsl.exe', '--status'], 15000);
      if (!w.ok) return { provider: 'wsl2', available: false, reason: 'WSL is not installed. Install it manually with "wsl --install" (CodeSpace never installs system components).' };
      const list = probe(['wsl.exe', '-l', '-v'], 15000);
      return {
        provider: 'wsl2', available: true, healthy: list.ok, distributions: list.ok ? list.stdout.replace(/\0/g, '').slice(0, 2000) : '',
        isolation: 'NONE — a WSL2 distribution shares the Windows host trust boundary. CodeSpace will NOT run untrusted code directly in your distributions and will not offer WSL2 as an isolated sandbox; use Docker inside WSL2 or Windows Sandbox instead.',
        usableFor: 'detection and Docker backend integration only in 3.12.0'
      };
    },
    async healthCheck() { const c = this.capabilities(); return { healthy: !!c.available, detail: c.available ? 'WSL present' : c.reason }; },
    async create() { throw new Error('WSL2 distributions are not used as sandboxes: they are not strongly isolated. Use the Docker provider (which can run inside WSL2) or Windows Sandbox.'); },
    async inspect() { return { state: 'unavailable' }; },
    async exec() { throw new Error('WSL2 is not offered as an execution sandbox (not strongly isolated).'); },
    async copyIn() { throw new Error('WSL2 is not offered as an execution sandbox.'); },
    async copyOut() { throw new Error('WSL2 is not offered as an execution sandbox.'); },
    async readLogs() { return { stdout: '', stderr: '' }; },
    async stop() { return { stopped: false }; },
    async destroy() { return { destroyed: true }; }
  };

  /* ---------- Mock provider (tests only; NON-ISOLATED, never auto-selected) ---------- */
  const mockProvider = {
    id: 'mock',
    testOnly: true,
    capabilities() {
      return { provider: 'mock', available: MOCK_ALLOWED, testOnly: true, isolation: 'NONE — NON-ISOLATED test provider. Commands run on the host in a scratch directory. Never selected automatically; enable with MY_AGENT_SANDBOX_MOCK=1 for the test suite only.', enforcedLimits: ['execTimeout', 'output cap'], unenforcedLimits: ['cpu', 'memory', 'pids', 'disk', 'network'] };
    },
    async healthCheck() { return { healthy: MOCK_ALLOWED, detail: MOCK_ALLOWED ? 'mock enabled for tests' : 'mock disabled (set MY_AGENT_SANDBOX_MOCK=1)' }; },
    async create(rec) { fs.mkdirSync(rec.scratchDir, { recursive: true }); return { scratch: rec.scratchDir }; },
    async inspect(rec) { return { state: rec.state === 'running' ? 'running' : rec.state }; },
    async exec(rec, { command, cwd, env, timeoutSec }) {
      const sh = WIN ? 'cmd.exe' : 'sh';
      const args = WIN ? ['/d', '/s', '/c', String(command)] : ['-c', String(command)];
      let workDir = rec.scratchDir;
      if (cwd) {
        const rel = String(cwd).replace(/^[a-zA-Z]:\\|^\//, '').replace(/\\/g, '/');
        const cand = path.resolve(rec.scratchDir, '.' + path.sep + rel);
        if (cand.startsWith(rec.scratchDir + path.sep) && fs.existsSync(cand)) workDir = cand;   // profile workdir (/workspace) maps to the scratch root
      }
      return await new Promise(resolve => {
        let child;
        try { child = spawn(sh, args, { cwd: workDir, env: { ...process.env, ...(env || {}) }, windowsHide: true, shell: false, detached: !WIN }); }
        catch (e) { return resolve({ exitCode: -1, timedOut: false, stdout: '', stderr: String(e.message || e) }); }
        let stdout = '', stderr = '', done = false, timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, Math.max(1000, (timeoutSec || 60) * 1000));
        child.stdout.on('data', c => { if (stdout.length < 200000) stdout += c.toString('utf8'); });
        child.stderr.on('data', c => { if (stderr.length < 200000) stderr += c.toString('utf8'); });
        child.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: -1, timedOut, stdout, stderr: (stderr + e.message).slice(0, 200000) }); });
        child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ exitCode: code == null ? -1 : code, timedOut, stdout, stderr, durationMs: 0 }); });
      });
    },
    async copyIn(rec, files) {
      fs.mkdirSync(rec.scratchDir, { recursive: true });
      for (const f of files) {
        const dest = path.resolve(rec.scratchDir, '.' + path.sep + String(f.path).replace(/\\/g, '/'));
        if (!dest.startsWith(rec.scratchDir + path.sep) && dest !== rec.scratchDir) throw new Error('Path traversal rejected: ' + f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content);
      }
      return { copied: files.length };
    },
    async copyOut(rec) {
      // Return a COPY of the scratch dir — the live sandbox state must never be moved/deleted
      // by an export or copyOut (the manager renames/stages the returned directory).
      const copy = rec.scratchDir + '.copy-' + crypto.randomBytes(3).toString('hex');
      try { fs.cpSync(rec.scratchDir, copy, { recursive: true }); } catch {}
      return copy;
    },
    async readLogs(rec) { return { stdout: (rec.logs || []).join('\n'), stderr: '' }; },
    async stop(rec) { return { stopped: true }; },
    async destroy(rec) { try { fs.rmSync(rec.scratchDir, { recursive: true, force: true }); } catch {} return { destroyed: true }; }
  };

  const PROVIDERS = { docker: dockerProvider, wasmtime: wasmtimeProvider, 'windows-sandbox': winSandboxProvider, hyperv: hyperVProvider, wsl2: wslProvider };
  const providerFor = id => { if (id === 'mock') return MOCK_ALLOWED ? mockProvider : null; return PROVIDERS[id] || null; };

  /* ---------- capability report (real checks, cached) ---------- */
  function sandboxCapabilities(force) {
    sandboxesLoadOnce();
    if (!force && capCache && Date.now() - capCacheAt < CAP_CACHE_MS) return capCache;
    const providers = {};
    for (const [id, p] of Object.entries(PROVIDERS)) providers[id] = p.capabilities();
    providers.mock = mockProvider.capabilities();
    // WSL2 Docker backend integration note
    if (providers.wsl2.available && providers.docker.available) providers.docker.viaWsl2 = true;
    const out = {
      platform: process.platform, architecture: process.arch, node: process.version,
      hostMemoryMb: Math.round(os.totalmem() / 1048576), hostCpus: os.cpus().length,
      providers,
      profiles: PROFILES_MANIFEST_VERSION,
      maxConcurrent: MAX_CONCURRENT,
      activeSandboxes: activeCount(),
      autoSelection: {
        policy: 'capability-based; a provider is selected only when its capabilities report available:true and healthy (where applicable)',
        noFallbackToHost: true,
        mockProvider: 'test-only, never auto-selected'
      },
      generatedAt: new Date().toISOString()
    };
    capCache = out; capCacheAt = Date.now();
    return out;
  }

  /* ---------- workspace snapshot: secret exclusion + manifest ---------- */
  const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.ssh|\.aws|\.azure|\.gcloud|\.config\/gcloud|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials?\..*|secret.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|\.git\/config|\.docker\/config\.json|.*browser.*profile.*)(\/|$)/i;
  const SECRET_CONTENT = /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,})/;
  const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.idea', '.vscode', '.my-agent']);
  const MAX_SNAP_FILE = 2 * 1024 * 1024, MAX_SNAP_TOTAL = 64 * 1024 * 1024, MAX_SNAP_FILES = 3000;
  function snapshotWorkspace(relWhitelist) {
    const root = safe('.');
    const manifest = {}; const files = []; let total = 0, excluded = [], truncated = false;
    for (const f of walkWorkspace(root)) {
      if (files.length >= MAX_SNAP_FILES) { truncated = true; break; }
      const rel = f.rel.replace(/\\/g, '/');
      if (relWhitelist && Array.isArray(relWhitelist) && relWhitelist.length && !relWhitelist.includes(rel)) continue;
      if (IGNORE_DIRS.has(rel.split('/')[0]) || SECRET_FILE.test(rel) || /\.git\//.test(rel)) { excluded.push(rel); continue; }
      let st; try { st = fs.statSync(f.full); } catch { continue; }
      if (!st.isFile() || st.size > MAX_SNAP_FILE) { if (st.isFile() && st.size > MAX_SNAP_FILE) excluded.push(rel + ' (too large)'); continue; }
      if (total + st.size > MAX_SNAP_TOTAL) { truncated = true; break; }
      let content; try { content = fs.readFileSync(f.full); } catch { continue; }
      if (content.length < 2e6 && SECRET_CONTENT.test(content.toString('utf8'))) { excluded.push(rel + ' (looks like a secret)'); continue; }
      total += st.size;
      manifest[rel] = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
      files.push({ path: rel, content });
    }
    return { files, manifest, excluded: excluded.slice(0, 100), truncated, totalBytes: total };
  }
  const relSafe = p => {
    const s = String(p || '').replace(/\\/g, '/');
    const parts = s.split('/');
    const winReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || parts.some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe sandbox file path: ' + p);
    if (/[\u0000-\u001f<>:\"|?*]/.test(s) || parts.some(x => /[ .]$/.test(x) || winReserved.test(x))) throw new Error('Unsafe or non-portable characters in sandbox path: ' + p);
    return s;
  };
  const MAX_EXPORT_FILES = 1000, MAX_EXPORT_TOTAL = 64 * 1024 * 1024, MAX_EXPORT_FILE = 8 * 1024 * 1024;
  function isInsidePath(base, target) {
    const rel = path.relative(path.resolve(base), path.resolve(target));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  }
  function workspaceBindingNow() {
    const opened = ctx.ROOT && ctx.ROOT();
    if (!opened) return null;
    const canonical = fs.realpathSync(opened);
    const st = fs.statSync(canonical);
    if (!st.isDirectory()) throw new Error('The active workspace is not a directory');
    return { path: canonical, dev: String(st.dev), ino: String(st.ino) };
  }
  function sameWorkspaceBinding(a, b) {
    if (!a || !b || !a.path || !b.path) return false;
    const ap = process.platform === 'win32' ? String(a.path).toLowerCase() : String(a.path);
    const bp = process.platform === 'win32' ? String(b.path).toLowerCase() : String(b.path);
    if (ap !== bp) return false;
    // dev/ino catches a workspace directory replaced in place where the platform supplies them.
    const aIdentity = a.dev && a.ino && a.ino !== '0';
    const bIdentity = b.dev && b.ino && b.ino !== '0';
    return !(aIdentity && bIdentity) || (String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino));
  }
  function assertSandboxWorkspace(rec, pending) {
    if (!rec.workspaceBinding) throw new Error('This sandbox has no captured workspace identity. Recreate it from the current workspace before exporting.');
    const current = workspaceBindingNow();
    if (!sameWorkspaceBinding(rec.workspaceBinding, current)) throw new Error('The active workspace has changed since this sandbox was created. Switch back to the original workspace or recreate the sandbox; no files were exported.');
    if (pending && !sameWorkspaceBinding(pending.workspaceBinding, rec.workspaceBinding)) throw new Error("The pending export is not bound to the sandbox's original workspace. Re-collect changes before exporting.");
    return current;
  }
  function assertStageDirectory(stage) {
    if (!stage) throw new Error('Sandbox provider returned no staging directory');
    const base = fs.realpathSync(STAGING_DIR);
    const raw = path.resolve(String(stage));
    const lst = fs.lstatSync(raw);
    if (lst.isSymbolicLink() || !lst.isDirectory()) throw new Error('Sandbox staging path must be a real directory, not a symlink');
    const real = fs.realpathSync(raw);
    if (!isInsidePath(base, real) || real === base) throw new Error('Sandbox staging directory escaped its private staging root');
    return real;
  }
  function clearPendingExport(rec) {
    const pendingDir = rec && rec.exportPending && rec.exportPending.dir;
    if (rec) rec.exportPending = null;
    if (!pendingDir) return;
    const absolute = path.resolve(String(pendingDir));
    const staging = path.resolve(STAGING_DIR);
    if (!isInsidePath(staging, absolute) || absolute === staging) return;
    // Resolve and validate the directory itself before recursive cleanup. A corrupted
    // persisted record must never make cleanup traverse an ancestor symlink outside staging.
    try {
      const safeDir = assertStageDirectory(absolute);
      fs.rmSync(safeDir, { recursive: true, force: true });
    } catch {}
  }
  function copyTreeNoLinks(source, dest) {
    const srcRoot = fs.realpathSync(source);
    const srcStat = fs.lstatSync(source);
    if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) throw new Error('Sandbox scratch path is not a real directory');
    fs.mkdirSync(dest, { recursive: false, mode: 0o700 });
    let count = 0, total = 0;
    const copyDir = (from, to, prefix) => {
      for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, ent.name), out = path.join(to, ent.name), rel = prefix ? prefix + '/' + ent.name : ent.name;
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) throw new Error('Refusing to copy a symbolic link from sandbox scratch: ' + rel);
        if (st.isDirectory()) { fs.mkdirSync(out, { mode: 0o700 }); copyDir(src, out, rel); continue; }
        if (!st.isFile()) throw new Error('Refusing to copy a special file from sandbox scratch: ' + rel);
        if (++count > MAX_EXPORT_FILES || st.size > MAX_EXPORT_FILE || total + st.size > MAX_EXPORT_TOTAL) throw new Error('Sandbox copy-out exceeds file or size limits');
        const real = fs.realpathSync(src);
        if (!isInsidePath(srcRoot, real)) throw new Error('Sandbox scratch file resolves outside its root: ' + rel);
        fs.copyFileSync(real, out, fs.constants.COPYFILE_EXCL);
        total += st.size;
      }
    };
    try { copyDir(srcRoot, dest, ''); }
    catch (e) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch {} throw e; }
    return dest;
  }
  function walkStaged(stage) {
    const root = assertStageDirectory(stage);
    const out = []; let total = 0;
    const rec = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.sandbox-manifest.json') continue;
        const rel = prefix ? prefix + '/' + ent.name : ent.name;
        const full = path.join(dir, ent.name), st = fs.lstatSync(full);
        if (st.isSymbolicLink()) throw new Error('Sandbox export contains a symbolic link; refusing export: ' + rel);
        if (st.isDirectory()) { rec(full, rel); continue; }
        if (!st.isFile()) throw new Error('Sandbox export contains a special file; refusing export: ' + rel);
        if (++out.length > MAX_EXPORT_FILES || st.size > MAX_EXPORT_FILE || total + st.size > MAX_EXPORT_TOTAL) throw new Error('Sandbox export exceeds file or size limits');
        const real = fs.realpathSync(full);
        if (!isInsidePath(root, real)) throw new Error('Sandbox export file resolves outside staging root: ' + rel);
        total += st.size;
        out[out.length - 1] = { rel, full: real, size: st.size };
      }
    };
    rec(root, '');
    return out;
  }
  function inspectWorkspaceTarget(root, rel) {
    const safeRel = relSafe(rel), rootReal = fs.realpathSync(root), parts = safeRel.split('/');
    let cursor = rootReal, missing = false;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      if (missing) continue;
      let st;
      try { st = fs.lstatSync(cursor); }
      catch (e) { if (e.code === 'ENOENT') { missing = true; continue; } throw e; }
      if (st.isSymbolicLink()) throw new Error('Refusing sandbox export through a workspace symbolic link: ' + safeRel);
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error('Workspace parent is not a directory: ' + safeRel);
      if (i === parts.length - 1 && !st.isFile()) throw new Error('Workspace export target exists but is not a regular file: ' + safeRel);
      const real = fs.realpathSync(cursor);
      if (!isInsidePath(rootReal, real)) throw new Error('Workspace export target resolves outside the workspace: ' + safeRel);
    }
    const dest = path.resolve(rootReal, ...parts);
    if (!isInsidePath(rootReal, dest)) throw new Error('Workspace export path escapes the workspace: ' + safeRel);
    return { rel: safeRel, dest, exists: !missing };
  }
  function ensureWorkspaceParents(root, rel) {
    const rootReal = fs.realpathSync(root), parts = relSafe(rel).split('/');
    let cursor = rootReal;
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      try { fs.mkdirSync(cursor); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Workspace parent changed during sandbox export: ' + rel);
      if (!isInsidePath(rootReal, fs.realpathSync(cursor))) throw new Error('Workspace parent escaped during sandbox export: ' + rel);
    }
    return inspectWorkspaceTarget(rootReal, rel);
  }
  function inspectStageFile(stage, rel) {
    const root = assertStageDirectory(stage), parts = relSafe(rel).split('/');
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      let st;
      try { st = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      if (st.isSymbolicLink()) throw new Error('Refusing to read a staged symbolic link: ' + rel);
      if (i < parts.length - 1 && !st.isDirectory()) return null;
      if (i === parts.length - 1 && !st.isFile()) return null;
      if (!isInsidePath(root, fs.realpathSync(cursor))) throw new Error('Staged path escapes export directory: ' + rel);
    }
    return cursor;
  }

  /* ---------- create / lifecycle ---------- */
  async function sandboxCreate(b) {
    sandboxesLoadOnce();
    const profileId = String(b.profile || '');
    const providerId = String(b.provider || '');
    const profile = profileId ? profileById(profileId) : null;
    if (profileId && !profile) throw new Error('Unknown sandbox profile: ' + profileId + '. Use sandbox_profiles_list.');
    const copyWorkspace = b.copyWorkspace !== false && (!profile || profile.language !== 'wasm');
    const networkPolicy = String(b.networkPolicy || (profile ? profile.network : 'none') || 'none');
    if (!['none', 'package-registries', 'approved-domains', 'restricted-egress'].includes(networkPolicy)) throw new Error('Invalid networkPolicy (none | package-registries | approved-domains | restricted-egress)');
    // 3.12: ALL approvals are collected BEFORE any environment is created, so an 'ask' mode
    // never leaves a half-created sandbox behind. Re-sending the same body with the token
    // replays the exact same validated plan.
    const createGate = permGuard('sandboxCreate', 'Create a sandbox environment (' + (profile ? profile.id : providerId || 'adhoc') + ', network policy: ' + networkPolicy + ', resources: ' + JSON.stringify(resolveResources(profile, b.resources)) + ')' + (copyWorkspace ? '\nand copy a filtered workspace snapshot into it (secrets and ignored files are excluded)' : ''), b);
    if (createGate) return createGate;
    if (copyWorkspace) {
      const mountGate = permGuard('sandboxMount', 'Copy a filtered workspace snapshot (' + (b.paths && b.paths.length ? b.paths.length + ' selected files' : 'excluding secrets and ignored files') + ') into the new sandbox', b);
      if (mountGate) return mountGate;
    }
    if (networkPolicy !== 'none') {
      const netGate = permGuard('sandboxNetwork', 'Create the sandbox with network policy "' + networkPolicy + '" (outbound access from the sandbox; default is network-disabled)', b);
      if (netGate) return netGate;
    }
    let provider = providerId ? providerFor(providerId) : (profile ? providerFor(profile.provider) : null);
    if (providerId === 'mock' && !MOCK_ALLOWED) throw new Error('The mock provider is test-only and disabled. Enable MY_AGENT_SANDBOX_MOCK=1.');
    if (!provider) throw new Error(profile ? 'The provider "' + (profile.provider) + '" for profile ' + profile.id + ' is not implemented/available on this host.' : 'Specify a profile (sandbox_profiles_list) or a provider.');
    const caps = provider.capabilities();
    if (!caps.available || caps.executable === false) throw new Error('Provider "' + provider.id + '" is not available for execution on this host: ' + (caps.reason || 'capability check failed'));
    if (networkPolicy !== 'none') {
      throw new Error('Network policy "' + networkPolicy + '" is not safely enforceable in this release. Only networkPolicy "none" is available until a verified sandbox egress proxy is configured; unrestricted bridge networking is refused.');
    }
    // Pulling an absent Docker image uses the HOST daemon's network before the container is
    // created. Require a separate, explicit network approval for this side effect.
    if (provider.id === 'docker') {
      const image = profile ? profile.image : String(b.image || '');
      if (image && !probe([DOCKER, 'image', 'inspect', image], 20000).ok) {
        const pullGate = permGuard('sandboxNetwork', 'Download Docker sandbox image from its registry: ' + image + ' (host Docker daemon network access)', b);
        if (pullGate) return pullGate;
      }
    }
    if (activeCount() >= MAX_CONCURRENT) throw new Error('Concurrent sandbox limit reached (' + MAX_CONCURRENT + '). Stop or destroy a sandbox first, or raise CODESPACE_MAX_SANDBOXES.');
    const resources = resolveResources(profile, b.resources);
    const id = 'sbx' + Date.now().toString(36) + (++sbxSeq).toString(36) + crypto.randomBytes(2).toString('hex');
    // Capture the workspace identity and snapshot synchronously before the provider performs
    // any external side effect. A later workspace switch must never redirect this sandbox's export.
    const initialWorkspaceBinding = workspaceBindingNow();
    let initialSnapshot = null;
    if (copyWorkspace) {
      if (!initialWorkspaceBinding) throw new Error('Open a workspace before creating a sandbox with workspace copy enabled.');
      initialSnapshot = snapshotWorkspace(b.paths);
      const afterSnapshotBinding = workspaceBindingNow();
      if (!sameWorkspaceBinding(initialWorkspaceBinding, afterSnapshotBinding)) throw new Error('Workspace changed while the sandbox snapshot was being created. Retry from the active workspace.');
    }
    const rec = {
      id, provider: provider.id, profile: profile ? profile.id : null, image: profile ? profile.image : '(adhoc)',
      state: 'creating', createdAt: Date.now(), startedAt: null, endedAt: null,
      taskOwner: b.ownerTaskId ? String(b.ownerTaskId).replace(/[^\w.-]/g, '').slice(0, 64) : null,
      resources, networkPolicy, runUser: '1000:1000', workspaceBinding: initialWorkspaceBinding,
      gvisor: b.useGvisor === true, logs: [], lastCommand: null, lastExitCode: null, error: null,
      manifest: null, filesIn: 0, scratchDir: path.join(STAGING_DIR, 'sbx-' + id)
    };
    if (b.useGvisor === true) {
      const dc = dockerProvider.capabilities();
      if (!dc.available || !dc.gvisorRuntime) throw new Error('gVisor (runsc runtime) is not available in this Docker installation.' + (process.platform === 'win32' ? ' gVisor is not supported on Windows hosts.' : ''));
      rec.isolation = 'container + gVisor user-space kernel';
    }
    SANDBOXES.set(id, rec); sbxSave(rec);
    try {
      if (provider.id === 'mock') rec.scratchDir = path.join(STAGING_DIR, 'sbx-' + id);
      const meta = await provider.create(rec, profile);
      rec.state = 'running'; rec.startedAt = Date.now();
      rec.isolation = rec.isolation || (caps.isolation || 'provider-reported');
      rec.networkEnforcement = 'enforced (' + (provider.id === 'docker' ? '--network none' : provider.id === 'wasmtime' ? 'WASI: no network capability' : 'provider default off') + ')';
      sbxLog(rec, 'created on provider ' + provider.id + (meta && meta.container ? ' as ' + meta.container : ''));
      if (copyWorkspace) {
        // The filtered snapshot was captured before provider creation and is bound to the
        // original workspace identity above; do not rescan a potentially different workspace.
        rec.manifest = initialSnapshot.manifest;
        const ci = await provider.copyIn(rec, initialSnapshot.files);
        rec.filesIn = ci.copied || initialSnapshot.files.length;
        sbxLog(rec, 'workspace snapshot copied: ' + rec.filesIn + ' file(s)' + (initialSnapshot.excluded.length ? ', ' + initialSnapshot.excluded.length + ' secret/ignored entries excluded' : '') + (initialSnapshot.truncated ? ' (SNAPSHOT TRUNCATED at size/file caps)' : ''));
      }
      sbxSave(rec);
      const view = sbxView(rec);
      if (rec.manifest) view.manifestFiles = Object.keys(rec.manifest).length;
      return view;
    } catch (e) {
      rec.state = 'error'; rec.error = String(e.message || e).slice(0, 400); rec.endedAt = Date.now();
      sbxLog(rec, 'create failed: ' + rec.error);
      try { await provider.destroy(rec); } catch {}
      sbxSave(rec);
      throw e;
    }
  }

  async function sandboxExec(b) {
    const command = String(b.command || '').trim();
    if (!command) throw new Error('Missing command');
    if (command.length > 20000) throw new Error('Command too long');
    // Gate BEFORE the existence check (deny/ask must win; what-string derives from the body only).
    const gate = permGuard('sandboxExec', 'Execute in sandbox ' + String(b.id || '') + ':\n$ ' + command.slice(0, 400), b);
    if (gate) return gate;
    const rec = sbxGet(b.id);
    if (rec.state !== 'running') throw new Error('Sandbox ' + rec.id + ' is not running (state: ' + rec.state + ')');
    const provider = providerFor(rec.provider);
    if (!provider) throw new Error('Provider missing for sandbox ' + rec.id);
    const profile = rec.profile ? profileById(rec.profile) : null;
    const timeoutSec = Math.min(Math.max(Number(b.timeout_seconds) || (profile ? profile.timeoutSec : 120), 1), 1800);
    rec.state = 'busy'; sbxSave(rec);
    try {
      const r = await provider.exec(rec, { command, cwd: b.cwd ? relSafe(b.cwd) : (profile ? profile.workdir : undefined), env: b.env && typeof b.env === 'object' ? b.env : {}, timeoutSec });
      rec.state = 'running'; rec.lastCommand = command.slice(0, 200); rec.lastExitCode = r.exitCode;
      sbxLog(rec, 'exec (' + r.durationMs + 'ms, exit ' + r.exitCode + (r.timedOut ? ', TIMED OUT' : '') + '): ' + command.slice(0, 120));
      return { ...r, sandbox: rec.id, timeoutSec, truncated: r.stdout.length >= 200000 || r.stderr.length >= 200000 };
    } catch (e) {
      rec.state = 'running'; rec.lastExitCode = -1;
      sbxLog(rec, 'exec error: ' + String(e.message || e).slice(0, 200));
      throw e;
    } finally { sbxSave(rec); }
  }

  async function sandboxCopyIn(b) {
    const rec = sbxGet(b.id);
    if (rec.state !== 'running' && rec.state !== 'awaiting-mount-approval') throw new Error('Sandbox ' + rec.id + ' is not running');
    const provider = providerFor(rec.provider);
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 500).map(f => ({ path: relSafe(f.path), content: String(f.content ?? '') }));
    if (!files.length) throw new Error('No files given');
    const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    if (total > 32 * 1024 * 1024) throw new Error('copyIn payload too large (32 MB limit)');
    const gate = permGuard('sandboxMount', 'Copy ' + files.length + ' file(s) (' + Math.round(total / 1024) + ' KB) into sandbox ' + rec.id + ': ' + files.slice(0, 6).map(f => f.path).join(', ') + (files.length > 6 ? ', …' : ''), b);
    if (gate) return gate;
    const r = await provider.copyIn(rec, files);
    for (const f of files) if (rec.manifest) rec.manifest[f.path] = 'sha256:' + crypto.createHash('sha256').update(f.content).digest('hex');
    rec.filesIn += files.length;
    sbxLog(rec, 'copyIn ' + files.length + ' file(s)');
    sbxSave(rec);
    return { ...r, sandbox: rec.id };
  }

  async function sandboxCopyOut(b) {
    const rec = sbxGet(b.id);
    if (rec.state !== 'running' && rec.state !== 'busy') throw new Error('Sandbox ' + rec.id + ' is not running');
    const provider = providerFor(rec.provider);
    const want = (Array.isArray(b.paths) ? b.paths : []).slice(0, 100).map(relSafe);
    if (!want.length) throw new Error('Give paths to copy out (workspace-relative)');
    const gate = permGuard('sandboxMount', 'Copy out of sandbox ' + rec.id + ': ' + want.join(', ').slice(0, 300), b);
    if (gate) return gate;
    const stage = await provider.copyOut(rec);
    try {
      const stageRoot = assertStageDirectory(stage);
      const files = [];
      for (const rel of want) {
        const f = inspectStageFile(stageRoot, rel);
        if (!f) { files.push({ path: rel, missing: true }); continue; }
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.size > 2 * 1024 * 1024) { files.push({ path: rel, error: st.isFile() ? 'too large (2 MB limit per file)' : 'not a file' }); continue; }
        files.push({ path: rel, content: fs.readFileSync(f, 'utf8'), bytes: st.size });
      }
      rec.filesOut += files.filter(f => f.content != null).length;
      sbxLog(rec, 'copyOut ' + files.length + ' path(s)');
      return { sandbox: rec.id, files };
    } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
  }

  async function sandboxExportChanges(b) {
    const rec = sbxGet(b.id);
    if (rec.state !== 'running' && rec.state !== 'busy') throw new Error('Sandbox ' + rec.id + ' is not running');
    const provider = providerFor(rec.provider);
    const gate = permGuard('sandboxExport', 'Collect changed files from sandbox ' + rec.id + ' for review (nothing is applied yet)', b);
    if (gate) return gate;
    const rootBinding = assertSandboxWorkspace(rec);
    const stage = await provider.copyOut(rec);
    try {
      const staged = walkStaged(stage);
      const changes = { added: [], modified: [], deleted: [], unchanged: 0 };
      const manifest = rec.manifest || {};
      for (const f of staged) {
        const rel = relSafe(f.rel);
        if (SECRET_FILE.test(rel) || IGNORE_DIRS.has(rel.split('/')[0])) { fs.rmSync(f.full, { force: true }); continue; }
        const content = fs.readFileSync(f.full);
        const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
        if (manifest[rel] === undefined) changes.added.push(rel);
        else if (manifest[rel] !== hash) changes.modified.push(rel);
        else { changes.unchanged++; fs.rmSync(f.full, { force: true }); }
      }
      for (const rel of Object.keys(manifest)) {
        if (!staged.some(f => f.rel === rel)) changes.deleted.push(rel);
      }
      const outDir = path.join(STAGING_DIR, 'export-' + rec.id + '-' + crypto.randomBytes(5).toString('hex'));
      let retainedOutDir = null;
      const previousPending = rec.exportPending || null;
      const previousPendingDir = previousPending && previousPending.dir;
      try {
        fs.mkdirSync(path.dirname(outDir), { recursive: true });
        fs.renameSync(stage, outDir);
        retainedOutDir = outDir;
        // Re-validate the retained review directory after moving it under the private staging root.
        walkStaged(outDir);
        const nextPending = { dir: outDir, changes, workspaceBinding: rootBinding, collectedAt: Date.now() };
        rec.exportPending = nextPending;
        sbxLog(rec, 'export collected: +' + changes.added.length + ' ~' + changes.modified.length + ' -' + changes.deleted.length);
        sbxSave(rec);
        if (previousPendingDir && previousPendingDir !== outDir) { try { fs.rmSync(previousPendingDir, { recursive: true, force: true }); } catch {} }
        return { sandbox: rec.id, changes, files: changes.added.length + changes.modified.length, note: 'Nothing has been applied to the real workspace. Review the changes, then call sandbox export-apply (it requires sandboxExport permission, an approval, a complete recovery checkpoint, original workspace identity, and safe regular-file paths).' };
      } catch (e) {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
        if (retainedOutDir) { try { fs.rmSync(retainedOutDir, { recursive: true, force: true }); } catch {} }
        rec.exportPending = previousPending;
        throw e;
      }
    } catch (e) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  async function sandboxExportApply(b) {
    return withEditLock(async () => {
      const rec = sbxGet(b.id);
      const pending = rec.exportPending;
      if (!pending || !pending.dir || !fs.existsSync(pending.dir)) throw new Error('No pending export for sandbox ' + rec.id + '. Call sandbox_export_changes first.');
      const allowDeletes = b.apply_deletions === true;
      const gate = permGuard('sandboxExport', 'Apply sandbox changes to the real workspace: +' + pending.changes.added.length + ' added, ~' + pending.changes.modified.length + ' modified' + (allowDeletes ? ', -' + pending.changes.deleted.length + ' DELETED' : ', deletions kept') + ' (a complete recovery checkpoint is created first)', b);
      if (gate) return gate;
      const workspace = assertSandboxWorkspace(rec, pending);
      const root = workspace.path;
      const staged = walkStaged(pending.dir);
      const stagedByRel = new Map();
      for (const f of staged) {
        const rel = relSafe(f.rel);
        if (SECRET_FILE.test(rel) || IGNORE_DIRS.has(rel.split('/')[0])) throw new Error('Sandbox export includes a protected or ignored path: ' + rel);
        stagedByRel.set(rel, f);
      }
      const expected = new Set([...(pending.changes.added || []), ...(pending.changes.modified || [])].map(relSafe));
      if (stagedByRel.size !== expected.size || [...expected].some(rel => !stagedByRel.has(rel))) throw new Error('Pending sandbox export manifest no longer matches its staged files. Re-collect changes before applying.');

      const writeOps = [];
      let transactionBytes = 0;
      for (const rel of expected) {
        const f = stagedByRel.get(rel);
        const srcStat = fs.lstatSync(f.full);
        if (srcStat.isSymbolicLink() || !srcStat.isFile() || srcStat.size > MAX_EXPORT_FILE) throw new Error('Refusing unsafe staged file: ' + rel);
        const content = fs.readFileSync(f.full);
        transactionBytes += content.length;
        const target = inspectWorkspaceTarget(root, rel);
        let previous = null, previousMode = null;
        if (target.exists) {
          const st = fs.lstatSync(target.dest);
          if (st.isSymbolicLink() || !st.isFile()) throw new Error('Refusing to overwrite a non-regular workspace target: ' + rel);
          previous = fs.readFileSync(target.dest);
          previousMode = st.mode & 0o777;
          transactionBytes += previous.length;
        }
        writeOps.push({ rel, content, previous, previousMode });
      }
      const deleteOps = [];
      if (allowDeletes) for (const rawRel of pending.changes.deleted || []) {
        const rel = relSafe(rawRel);
        if (SECRET_FILE.test(rel) || IGNORE_DIRS.has(rel.split('/')[0])) throw new Error('Refusing to delete a protected or ignored workspace path: ' + rel);
        const target = inspectWorkspaceTarget(root, rel);
        if (!target.exists) continue;
        const st = fs.lstatSync(target.dest);
        if (st.isSymbolicLink() || !st.isFile()) throw new Error('Refusing to delete a non-regular workspace target: ' + rel);
        const previous = fs.readFileSync(target.dest);
        transactionBytes += previous.length;
        deleteOps.push({ rel, previous, previousMode: st.mode & 0o777 });
      }
      if (transactionBytes > MAX_EXPORT_TOTAL * 2) throw new Error('Sandbox export transaction exceeds the rollback safety limit (128 MB).');

      // Checkpoint must succeed and be complete before the first workspace mutation.
      const checkpoint = await cpCreate({ note: 'before sandbox export apply (' + rec.id + ')' });
      if (!checkpoint || !checkpoint.id || checkpoint.complete !== true) throw new Error('A complete recovery checkpoint could not be created. Sandbox export was aborted without changing workspace files.');
      // Workspace identity and all path components are rechecked after the asynchronous checkpoint.
      const workspaceAfterCheckpoint = assertSandboxWorkspace(rec, pending);
      const rootAfterCheckpoint = workspaceAfterCheckpoint.path;
      if (!sameWorkspaceBinding(workspace, workspaceAfterCheckpoint)) throw new Error('Workspace changed while the recovery checkpoint was being created. No sandbox changes were applied.');

      const applied = [], deleted = [], skipped = [], appliedOps = [];
      try {
        for (const op of writeOps) {
          const target = ensureWorkspaceParents(rootAfterCheckpoint, op.rel);
          // Re-check after parent creation immediately before each atomic replacement.
          inspectWorkspaceTarget(rootAfterCheckpoint, op.rel);
          atomicWrite(target.dest, op.content, op.previousMode == null ? 0o644 : op.previousMode);
          appliedOps.push({ ...op, kind: 'write' });
          applied.push(op.rel);
        }
        if (allowDeletes) for (const op of deleteOps) {
          const target = inspectWorkspaceTarget(rootAfterCheckpoint, op.rel);
          if (target.exists) {
            fs.unlinkSync(target.dest);
            appliedOps.push({ ...op, kind: 'delete' });
            deleted.push(op.rel);
          }
        }
      } catch (applyError) {
        const rollbackErrors = [];
        for (const op of appliedOps.slice().reverse()) {
          try {
            const target = ensureWorkspaceParents(rootAfterCheckpoint, op.rel);
            if (op.kind === 'delete' || op.previous != null) atomicWrite(target.dest, op.previous, op.previousMode == null ? 0o644 : op.previousMode);
            else if (target.exists) fs.unlinkSync(target.dest);
          } catch (rollbackError) { rollbackErrors.push(op.rel + ': ' + String(rollbackError.message || rollbackError)); }
        }
        const suffix = rollbackErrors.length ? ' Rollback was incomplete: ' + rollbackErrors.join('; ').slice(0, 1000) : ' All applied file changes were rolled back.';
        throw new Error('Sandbox export failed: ' + String(applyError.message || applyError) + '.' + suffix + ' Recovery checkpoint: ' + checkpoint.id);
      }

      invalidateCodeIndex('sandbox export applied (' + applied.length + ' files)');
      clearPendingExport(rec);
      sbxLog(rec, 'export applied: ' + applied.length + ' file(s), ' + deleted.length + ' deleted');
      sbxSave(rec);
      return { sandbox: rec.id, applied, deleted, skipped, checkpoint: checkpoint.id, note: 'A complete recovery checkpoint was created before applying the reviewed sandbox changes.' };
    });
  }

  async function sandboxStop(b) {
    // Gate BEFORE the existence check: deny/ask must win, and the what-string stays stable
    // across the challenge/resend cycle because it derives from the request body only.
    const gate = permGuard('sandboxDestroy', 'Stop sandbox ' + String(b.id || ''), b);
    if (gate) return gate;
    const rec = sbxGet(b.id);
    const provider = providerFor(rec.provider);
    if (rec.state === 'running' || rec.state === 'busy' || rec.state === 'awaiting-mount-approval') {
      const r = await provider.stop(rec);
      rec.state = 'stopped'; rec.endedAt = Date.now();
      sbxLog(rec, 'stopped');
      sbxSave(rec);
      return { sandbox: rec.id, ...r, state: rec.state };
    }
    return { sandbox: rec.id, state: rec.state, note: 'Already stopped.' };
  }

  async function sandboxDestroy(b) {
    const gate = permGuard('sandboxDestroy', 'Destroy sandbox ' + String(b.id || '') + ' and delete its files', b);
    if (gate) return gate;
    const rec = sbxGet(b.id);
    const provider = providerFor(rec.provider);
    let r = { destroyed: true };
    try { r = await provider.destroy(rec); } catch (e) { r = { destroyed: false, error: String(e.message || e) }; }
    rec.state = 'destroyed'; rec.endedAt = Date.now();
    clearPendingExport(rec);
    sbxLog(rec, 'destroyed');
    sbxSave(rec);
    return { sandbox: rec.id, ...r, state: rec.state };
  }

  /* ---------- orphan sweep ---------- */
  let sweepTimer = null;
  async function sweepOrphans() {
    sandboxesLoadOnce();
    for (const rec of [...SANDBOXES.values()]) {
      if (!['running', 'busy', 'creating', 'awaiting-mount-approval', 'interrupted'].includes(rec.state)) continue;
      const ownerAlive = rec.taskOwner && taskAlive && taskAlive(rec.taskOwner);
      if (ownerAlive) continue;
      const provider = providerFor(rec.provider);
      if (!provider) continue;
      try {
        if (rec.provider === 'docker') { await runCapture([DOCKER, 'rm', '-f', containerName(rec.id)], { timeout: 30000 }); }
        else await provider.destroy(rec);
        rec.state = rec.state === 'interrupted' ? 'interrupted' : 'destroyed';
        rec.endedAt = rec.endedAt || Date.now();
        sbxLog(rec, 'orphan sweep: cleaned up (owner ' + (rec.taskOwner || 'none') + (ownerAlive ? ' alive' : ' gone') + ')');
      } catch (e) { sbxLog(rec, 'orphan sweep failed: ' + String(e.message || e).slice(0, 160)); }
      sbxSave(rec);
    }
  }
  function startSweeper() {
    sandboxesLoadOnce();
    sweepOrphans().catch(() => {});
    if (!sweepTimer) sweepTimer = setInterval(() => { sweepOrphans().catch(() => {}); }, 5 * 60000);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  /* ---------- automatic profile suggestion from the workspace ---------- */
  function sandboxSuggest() {
    if (!ctx.ROOT()) throw new Error('Open a workspace first');
    const root = safe('.');
    const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
    const caps = sandboxCapabilities();
    const suggestions = [];
    const push = (profile, why) => { const p = profileById(profile); if (p) { const prov = (caps.providers[p.provider] || {}); suggestions.push({ profile: p.id, provider: p.provider, providerAvailable: !!prov.available, why }); } };
    const pj = (() => { try { return JSON.parse(read('package.json')); } catch { return null; } })();
    if (pj) {
      const eng = (pj.engines || {}).node || '';
      const m = eng.match(/(\d+)\s*(\.\d+)?/);
      const major = m ? Number(m[1]) : 22;
      const nearest = [20, 22, 24].sort((a, b) => Math.abs(a - major) - Math.abs(b - major))[0];
      push('node-' + nearest, 'package.json found (engines.node: ' + (eng || 'unspecified') + ')');
    }
    const pyVer = read('.python-version').trim() || (read('requirements.txt').match(/python_requires|python\s*=\s*"?(\d\.\d+)/i) || [])[1];
    const pyAvail = ['python-3.10', 'python-3.11', 'python-3.12', 'python-3.13'];
    if (pyVer) { const want = 'python-' + pyVer; push(pyAvail.includes(want) ? want : 'python-3.12', '.python-version / manifest indicates Python ' + pyVer + (pyAvail.includes(want) ? '' : ' (no exact profile; nearest LTS profile suggested)')); }
    else if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) push('python-3.12', 'Python project files found (no version pinned — default 3.12)');
    if (fs.existsSync(path.join(root, 'composer.json'))) push('php-8.3', 'composer.json found');
    if (fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'build.gradle'))) push('java-21', 'Maven/Gradle build found');
    if (fs.existsSync(path.join(root, 'go.mod'))) push('golang-1.23', 'go.mod found');
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) push('rust-stable', 'Cargo.toml found');
    if (fs.existsSync(path.join(root, 'CMakeLists.txt')) || fs.existsSync(path.join(root, 'Makefile'))) push('cpp-gcc', 'C/C++ build files found');
    if (fs.existsSync(path.join(root, '*.csproj')) || fs.readdirSync(root).some(f => f.endsWith('.csproj'))) push('dotnet-9', '.NET project found');
    if (!suggestions.length) push('linux-ubuntu', 'No language manifest detected — generic Linux shell profile');
    return { suggestions, manifestVersion: PROFILES_MANIFEST_VERSION, note: 'Suggestions come from workspace manifests only. Provider availability is checked per suggestion; unavailable providers are never selected.' };
  }

  /* ---------- routes ---------- */
  function sandboxRoutes() {
    return {
      '/sandbox/capabilities': b => sandboxCapabilities(b && b.refresh === true),
      '/sandbox/profiles': () => ({ manifestVersion: PROFILES_MANIFEST_VERSION, profiles: PROFILES.map(p => ({ id: p.id, provider: p.provider, image: p.image, language: p.language, network: p.network, resources: p.resources, timeoutSec: p.timeoutSec, tags: p.tags, note: p.note || null })) }),
      '/sandbox/profile': b => { const p = profileById(String(b.id || '')); if (!p) throw new Error('Unknown profile: ' + b.id); return { manifestVersion: PROFILES_MANIFEST_VERSION, profile: p }; },
      '/sandbox/profiles/validate': b => {
        const pg = permGuard('sandboxProfiles', 'Validate a project sandbox profile', b);
        if (pg) return pg;
        const p = b.profile && typeof b.profile === 'object' ? b.profile : null;
        if (!p) throw new Error('Give a project profile object');
        const errs = [];
        if (!p.id || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(p.id))) errs.push('id must be a short identifier');
        if (!PROFILES.some(x => x.id === p.extends) && !providerFor(String(p.provider || ''))) errs.push('provider must be an available provider id (or extend a built-in profile with "extends")');
        if (p.image && /:latest$/i.test(String(p.image))) errs.push('floating "latest" image references are not allowed — pin a version tag');
        if (p.resources && p.resources.memoryMb && (Number(p.resources.memoryMb) < 128 || Number(p.resources.memoryMb) > 8192)) errs.push('memoryMb must be 128..8192');
        return { valid: !errs.length, errors: errs, note: 'Project profiles are validated before every execution; invalid profiles are refused.' };
      },
      '/sandbox/suggest': () => sandboxSuggest(),
      '/sandbox/create': b => sandboxCreate(b),
      '/sandbox/list': () => { sandboxesLoadOnce(); return { sandboxes: [...SANDBOXES.values()].sort((a, b2) => b2.createdAt - a.createdAt).slice(0, 50).map(sbxView), counts: { active: activeCount(), max: MAX_CONCURRENT } }; },
      '/sandbox/inspect': b => { const rec = sbxGet(b.id); return sbxView(rec); },
      '/sandbox/exec': b => sandboxExec(b),
      '/sandbox/logs': b => { const rec = sbxGet(b.id); const p = providerFor(rec.provider); return p ? p.readLogs(rec, b.since).then(r => ({ sandbox: rec.id, logs: (rec.logs || []).slice(-40), provider: r })) : { sandbox: rec.id, logs: rec.logs || [] }; },
      '/sandbox/copy_in': b => sandboxCopyIn(b),
      '/sandbox/copy_out': b => sandboxCopyOut(b),
      '/sandbox/export': b => sandboxExportChanges(b),
      '/sandbox/export/apply': b => sandboxExportApply(b),
      '/sandbox/stop': b => sandboxStop(b),
      '/sandbox/destroy': b => sandboxDestroy(b),
      '/sandbox/cleanup': async () => { await sweepOrphans(); return { swept: true, counts: { active: activeCount(), max: MAX_CONCURRENT } }; }
    };
  }

  /* ---------- task-manager hook ---------- */
  function onTaskCancelled(taskId) {
    sandboxesLoadOnce();
    for (const rec of SANDBOXES.values()) {
      if (rec.taskOwner === String(taskId) && ['running', 'busy', 'creating', 'awaiting-mount-approval'].includes(rec.state)) {
        const provider = providerFor(rec.provider);
        if (provider) provider.stop(rec).catch(() => {});
        rec.state = 'stopped'; rec.endedAt = Date.now();
        sbxLog(rec, 'stopped: owning task ' + taskId + ' was cancelled');
        sbxSave(rec);
      }
    }
  }

  return { sandboxRoutes, sandboxCapabilities, startSweeper, onTaskCancelled, buildWsbConfig, sandboxSuggest, PROFILES, sbxView };
};
