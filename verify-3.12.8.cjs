#!/usr/bin/env node
'use strict';
/* CodeSpace 3.12.8 targeted regression tests.
   Exercises the new safety paths with deterministic fake runtimes; it does not claim
   that Docker or Wasmtime itself is installed or that OS-level isolation was tested. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0, skipped = 0;
const ok = (name, value, detail) => {
  if (value) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 400) : '')); }
};
const skip = (name, why) => { skipped++; console.log('SKIP ' + name + (why ? ' — ' + why : '')); };
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const atomicWrite = (f, data, mode) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(t, data, mode == null ? undefined : { mode });
  fs.renameSync(t, f);
};
function* walkWorkspace(dir, prefix = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name), rel = prefix ? prefix + '/' + ent.name : ent.name;
    if (ent.isDirectory()) yield* walkWorkspace(full, rel);
    else if (ent.isFile()) yield { full, rel };
  }
}
function makeContext(root, data, options = {}) {
  return {
    DATA: data, WIN: false, sleep: ms => new Promise(r => setTimeout(r, ms)),
    safe: p => path.resolve(root, String(p || '.')),
    permGuard: (perm, what, body) => options.permGuard ? options.permGuard(perm, what, body) : null,
    permLoad: () => ({}), writeJson, readJson,
    cpCreate: options.cpCreate || (async () => ({ id: 'cp_test_' + Date.now(), complete: true })),
    atomicWrite, invalidateCodeIndex: () => {}, ROOT: () => root,
    taskAlive: () => false, walkWorkspace: d => walkWorkspace(d)
  };
}
function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

(async () => {
  const originalPath = process.env.PATH || '';
  const originalMock = process.env.MY_AGENT_SANDBOX_MOCK;
  const work = temp('cs328-work-');
  const data = temp('cs328-data-');
  const fakeBin = temp('cs328-bin-');
  const log = path.join(data, 'fake-wasmtime.log');
  try {
    fs.writeFileSync(path.join(work, 'README.md'), 'sandbox test\n');
    if (process.platform === 'win32') {
      skip('Wasmtime provider execution with a fake executable', 'this deterministic fake-runtime harness currently uses POSIX executable scripts');
      skip('Docker CLI argument construction with a fake executable', 'this deterministic fake-runtime harness currently uses POSIX executable scripts');
    } else {
      writeExecutable(path.join(fakeBin, 'wasmtime'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'wasmtime 30.0.0-test'; exit 0; fi\nprintf '%s\\n' "$@" >> "$FAKE_WASMTIME_LOG"\necho 'fake-wasm-ok'\nexit 0\n`);
      writeExecutable(path.join(fakeBin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$DOCKER_LOG"\ncase "$1 $2" in\n  "--version ") echo 'Docker version 27.0.0, build test';;\n  "version --format") echo '{"Server":{"Version":"27.0.0"}}';;\n  "info --format") echo '{"SecurityOptions":["name=rootless"],"OSType":"linux","NCPU":4,"MemTotal":8589934592,"Runtimes":{"runc":{}}}';;\n  "image inspect") if [ "$DOCKER_IMAGE_MISSING" = "1" ]; then echo 'not found' >&2; exit 1; else echo '[{}]'; fi;;\n  "create --name") echo 'fake-container-id';;\n  "start csbx_") echo 'fake-container-id';;\n  "rm -f") echo 'fake-container-id';;\n  "stop -t") echo 'fake-container-id';;\n  "inspect --format") echo '{"Running":true,"ExitCode":0,"OOMKilled":false,"Pid":123}';;\n  *) exit 0;;\nesac\nexit 0\n`);

      process.env.PATH = fakeBin + path.delimiter + originalPath;
      process.env.FAKE_WASMTIME_LOG = log;
      process.env.DOCKER_LOG = path.join(data, 'fake-docker.log');
      delete process.env.DOCKER_IMAGE_MISSING;
      const createSandboxManager = require('./sandbox-manager.js');

      // Wasmtime: no host-absolute module may be executed; copied-in module runs; copyOut is non-destructive.
      const wasmManager = createSandboxManager(makeContext(work, path.join(data, 'wasm')));
      const wasmRoutes = wasmManager.sandboxRoutes();
      const wasmCaps = wasmManager.sandboxCapabilities(true).providers.wasmtime;
      ok('fake Wasmtime runtime is detected for adapter testing', wasmCaps.available === true && /wasmtime 30/.test(wasmCaps.version || ''), JSON.stringify(wasmCaps));
      const wasmSbx = await wasmRoutes['/sandbox/create']({ provider: 'wasmtime', profile: 'wasm-module', copyWorkspace: false });
      let hostPathRejected = false;
      try { await wasmRoutes['/sandbox/exec']({ id: wasmSbx.id, command: '/etc/host-secret.wasm' }); }
      catch (e) { hostPathRejected = /Host paths are not accepted|Copy a \.wasm module/i.test(e.message); }
      ok('Wasmtime refuses host-absolute module paths before execution', hostPathRejected, fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'runtime log empty');
      await wasmRoutes['/sandbox/copy_in']({ id: wasmSbx.id, files: [{ path: 'module.wasm', content: 'fake-wasm-bytes' }] });
      const wasmRecordPath = path.join(data, 'wasm', 'sandboxes', wasmSbx.id + '.json');
      const wasmRecord = readJson(wasmRecordPath, {});
      const liveModule = wasmRecord.scratchModule;
      const copied = await wasmRoutes['/sandbox/copy_out']({ id: wasmSbx.id, paths: ['module.wasm'] });
      ok('Wasmtime copy-out returns the copied module contents', copied.files && copied.files.some(f => f.path === 'module.wasm' && f.content === 'fake-wasm-bytes'), JSON.stringify(copied).slice(0, 200));
      ok('Wasmtime copy-out preserves the live sandbox scratch directory', fs.existsSync(liveModule) && fs.readFileSync(liveModule, 'utf8') === 'fake-wasm-bytes', liveModule);
      const wasmRun = await wasmRoutes['/sandbox/exec']({ id: wasmSbx.id, command: 'module.wasm' });
      ok('Wasmtime executes the copied sandbox module through the runtime adapter', wasmRun.exitCode === 0 && /fake-wasm-ok/.test(wasmRun.stdout || ''), JSON.stringify(wasmRun).slice(0, 180));
      await wasmRoutes['/sandbox/destroy']({ id: wasmSbx.id });

      // Docker: exercise actual argument assembly through a fake CLI; no daemon or container is used.
      const dockerManager = createSandboxManager(makeContext(work, path.join(data, 'docker')));
      const dockerRoutes = dockerManager.sandboxRoutes();
      const dockerCaps = dockerManager.sandboxCapabilities(true).providers.docker;
      ok('fake Docker CLI/daemon reports executable capability', dockerCaps.available === true && dockerCaps.healthy === true, JSON.stringify(dockerCaps).slice(0, 180));
      const dockerSbx = await dockerRoutes['/sandbox/create']({ provider: 'docker', profile: 'python-3.12', copyWorkspace: false, runUser: 'root' });
      await dockerRoutes['/sandbox/copy_in']({ id: dockerSbx.id, files: [{ path: 'sample.txt', content: 'editable by uid 1000' }] });
      const dockerLog = fs.readFileSync(process.env.DOCKER_LOG, 'utf8');
      ok('Docker container uses network none and a fixed non-root user', /--network\nnone/.test(dockerLog) && /--user\n1000:1000/.test(dockerLog), dockerLog.slice(0, 700));
      ok('Docker workspace tmpfs is writable by UID 1000', /--tmpfs\n\/workspace:rw,exec,size=\d+m,uid=1000,gid=1000,mode=0770/.test(dockerLog), dockerLog.slice(0, 900));
      ok('Docker grants only CHOWN for manager-controlled copy ownership normalization', /--cap-drop\nALL/.test(dockerLog) && /--cap-add\nCHOWN/.test(dockerLog), dockerLog.slice(0, 900));
      ok('Docker copy-in normalizes files to the unprivileged sandbox user', dockerLog.includes('chown -R 1000:1000 /workspace'), dockerLog.slice(-500));
      ok('Docker container drops all capabilities except the narrow CHOWN requirement and uses read-only root filesystem', /--cap-drop\nALL/.test(dockerLog) && /--cap-add\nCHOWN/.test(dockerLog) && /--read-only/.test(dockerLog), dockerLog.slice(0, 900));
      ok('Docker container receives hard resource flags and no privileged mode', /--memory\n1536m/.test(dockerLog) && /--cpus\n1/.test(dockerLog) && /--pids-limit\n256/.test(dockerLog) && !/--privileged/.test(dockerLog), dockerLog.slice(0, 700));
      await dockerRoutes['/sandbox/destroy']({ id: dockerSbx.id });

      // Unrestricted bridge networking is rejected, and an absent image requires a network approval before pull.
      let networkChallenges = 0;
      const gatedManager = createSandboxManager(makeContext(work, path.join(data, 'docker-gated'), {
        permGuard: perm => { if (perm === 'sandboxNetwork') { networkChallenges++; return { needsApproval: true, permission: perm, approvalToken: 'apr_fake' }; } return null; }
      }));
      process.env.DOCKER_IMAGE_MISSING = '1';
      fs.writeFileSync(process.env.DOCKER_LOG, '');
      const gatedRoutes = gatedManager.sandboxRoutes();
      const gated = await gatedRoutes['/sandbox/create']({ provider: 'docker', profile: 'python-3.12', copyWorkspace: false });
      const gatedLog = fs.readFileSync(process.env.DOCKER_LOG, 'utf8');
      ok('missing Docker image requires explicit host-network approval before create/pull', gated.needsApproval === true && gated.permission === 'sandboxNetwork' && networkChallenges === 1 && !/create\n--name/.test(gatedLog), JSON.stringify(gated));
      process.env.DOCKER_IMAGE_MISSING = '0';
      let egressRefused = false;
      try { await dockerRoutes['/sandbox/create']({ provider: 'docker', profile: 'python-3.12', copyWorkspace: false, networkPolicy: 'approved-domains' }); }
      catch (e) { egressRefused = /not safely enforceable|unrestricted bridge/i.test(e.message); }
      ok('Docker refuses unsupported egress policies instead of using unrestricted bridge mode', egressRefused);
    }

    // Source-level assertions for platform-dependent implementations not executable on this host.
    const src = fs.readFileSync(path.join(__dirname, 'sandbox-manager.js'), 'utf8');
    ok('Windows Sandbox detection does not advertise an unimplemented lifecycle as executable', /provider: 'windows-sandbox',[\s\S]{0,500}?available: false, executable: false/.test(src));
    ok('Hyper-V detection does not advertise an unimplemented lifecycle as executable', /provider: 'hyperv',[\s\S]{0,500}?available: false, executable: false/.test(src));

    console.log(`\n3.12.8 focused verification: ${pass} passed, ${fail} failed, ${skipped} skipped`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    process.env.PATH = originalPath;
    if (originalMock === undefined) delete process.env.MY_AGENT_SANDBOX_MOCK; else process.env.MY_AGENT_SANDBOX_MOCK = originalMock;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(fakeBin, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error('VERIFY ERROR: ' + (e && e.stack || e)); process.exitCode = 1; });
