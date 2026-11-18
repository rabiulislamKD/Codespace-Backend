'use strict';
const fs = require('fs');
const assert = require('assert');
const tools = fs.readFileSync('src-js/08-tools.js', 'utf8');
const bridge = fs.readFileSync('src-js/09-browser-bridge.js', 'utf8');
const activity = fs.readFileSync('src-js/12-live-activity-ui.js', 'utf8');
const render = fs.readFileSync('src-js/06-chat-render.js', 'utf8');
const checks = [
  ['AI tool schema exists', /name: 'install_tool'/.test(tools)],
  ['tool accepts purpose, source and command', /purpose: \{ type: 'string'/.test(tools) && /source: \{ type: 'string'/.test(tools) && /command: \{ type: 'string'/.test(tools)],
  ['verification command supported', /verify_command: \{ type: 'string'/.test(tools)],
  ['installer exposed in complete tool catalog', /const t = \[[^\]]*\.\.\.FILE_TOOLS, \.\.\.FILE_TOOLS_310, \.\.\.CODE_TOOLS/.test(tools)],
  ['auto tool group recognizes toolchain and install needs', /installer\|toolchain\|sdk\|runtime\|compiler/.test(tools)],
  ['agent instructed to detect missing tools', /TOOLCHAIN AUTONOMY/.test(tools)],
  ['agent instructed to research official sources', /research the official documentation\/repository\/release/.test(tools)],
  ['agent instructed to require user approval', /Wait for the user's approval prompt before installation/.test(tools)],
  ['remote shell-pipe installers blocked', /curl\|wget/.test(bridge) && /unsafeInstall/.test(bridge)],
  ['admin elevation blocked', /sudo\|runas/.test(bridge)],
  ['installation uses approval-gated bridge command', /case 'install_tool'[\s\S]*bApproved\('\/run'/.test(bridge)],
  ['verification command runs only after separate approval', /Verify the installed tool\?[\s\S]*bApproved\('\/run'/.test(bridge)],
  ['activity label registered', /case 'install_tool': return 'Installing tool'/.test(activity)],
  ['chat activity label registered', /case 'install_tool': return \{ ic:/.test(render)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) failed++; }
console.log(`\\n${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
