'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const tools = read('src-js/08-tools.js');
const bridge = read('src-js/09-browser-bridge.js');
const server = read('agent-server.js');
const bundle = read('js/app.js');
const html = read('my-chat-agent-v3.html');
const checks = [
  ['runtime tool declared', tools.includes("name: 'codespace_runtime_check'")],
  ['installation locator tool declared', tools.includes("name: 'codespace_locate_installation'")],
  ['runtime tool available without an open project', /if \(B\.ok\) \{\s*t\.push\(\.\.\.RUNTIME_TOOLS\)/.test(tools)],
  ['runtime tool included in full tool definitions', /\.\.\.RUNTIME_TOOLS/.test(tools.slice(tools.indexOf('function allToolDefs')))],
  ['runtime dispatcher implemented', bridge.includes("case 'codespace_runtime_check':")],
  ['dispatcher reads runtime and workflow status', bridge.includes("'/info'") && bridge.includes("'/workflow/diagnostics'")],
  ['dispatcher reads Installed Tools and OpenCode status', bridge.includes("'/tools/installed'") && bridge.includes("'/opencode/status'")],
  ['server exposes required read-only routes', ['/info','/codespace/install-location','/workflow/diagnostics','/tools/installed','/opencode/status'].every(r => server.includes("case '" + r + "'"))],
  ['self-repair guidance present', tools.includes('CODESPACE SELF-REPAIR')],
  ['built app bundle contains runtime tool', bundle.includes('codespace_runtime_check')],
  ['splash is clean and omits version metadata', !html.includes('v3.15.1') && html.includes('Open CodeSpace')]
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; }
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
