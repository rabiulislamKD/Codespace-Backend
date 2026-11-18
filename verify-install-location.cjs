'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { getInstallLocation } = require('./codespace-install-location.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codespace-install-location-'));
try {
  for (const p of [
    'src-js/manifest.json', 'css/01-base.css', 'desktop/main.cjs',
    'agent-server.js', 'my-chat-agent-v3.html', 'package.json', 'js/app.js'
  ]) {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'test');
  }
  const resources = path.join(root, 'resources');
  fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'runtime', 'node.exe'), 'test');
  const launcher = path.join(root, 'CodeSpace.exe');
  fs.writeFileSync(launcher, 'test');
  const result = getInstallLocation({
    appRoot: root,
    backendFile: path.join(root, 'agent-server.js'),
    launcherPath: launcher,
    portableDirectory: root,
    resourcesDirectory: resources,
    packaged: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.installType, 'packaged-desktop');
  assert.equal(result.paths.installRoot, root);
  assert.equal(result.paths.launcherExecutable, launcher);
  assert.equal(result.paths.portableDirectory, root);
  assert.equal(result.source.sourceTreePresent, true);
  assert.equal(result.source.files.bundledNodeRuntime, true);
  assert.equal(result.access.installRootExists, true);
  assert.match(result.discovery, /no drive or home-directory scan/);
  console.log('PASS actual process paths are surfaced');
  console.log('PASS portable executable and resources paths are surfaced');
  console.log('PASS known source inventory is detected');
  console.log('PASS discovery stays bounded and read-only');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const read = p => fs.readFileSync(p, 'utf8');
const server = read('agent-server.js');
const desktop = read('desktop/main.cjs');
const tools = read('src-js/08-tools.js');
const bridge = read('src-js/09-browser-bridge.js');
const checks = [
  ['desktop forwards real Electron installation paths', /CODESPACE_APP_ROOT: appRoot/.test(desktop) && /CODESPACE_LAUNCHER_PATH: process\.execPath/.test(desktop) && /CODESPACE_PORTABLE_DIR: portableDir/.test(desktop)],
  ['backend exposes authenticated read-only install route', /case '\/codespace\/install-location': return send\(res, 200, codespaceInstallationLocation\(\)\)/.test(server)],
  ['dedicated locator is an agent runtime tool', /name: 'codespace_locate_installation'/.test(tools)],
  ['runtime check includes installation details', /'\/codespace\/install-location'/.test(bridge) && /CodeSpace install root:/.test(bridge)],
  ['agent guidance uses discovered path and preserves workspace jail', /call codespace_locate_installation first/.test(tools) && /workspace jail remains in force/.test(tools)]
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} static integration checks passed`);
process.exitCode = failed ? 1 : 0;
