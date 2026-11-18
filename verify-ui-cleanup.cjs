'use strict';
const fs = require('fs');
const assert = require('assert/strict');
const html = fs.readFileSync('my-chat-agent-v3.html', 'utf8');
const css = fs.readFileSync('css/07-extras.css', 'utf8');
const permissions = fs.readFileSync('src-js/20-git-permissions.js', 'utf8');
const tasks = fs.readFileSync('src-js/23-task-center.js', 'utf8');
const bundle = fs.readFileSync('js/app.js', 'utf8');
const sw = fs.readFileSync('pwa/sw.js', 'utf8');
const checks = [
  ['permission control is in the composer second row', html.indexOf('id="permWrap"') > html.indexOf('<div class="crow crow-bot">') && html.indexOf('id="permWrap"') < html.indexOf('<select id="thinkSel"')],
  ['permission choices use compact labels', /<b>Default<\/b>/.test(html) && /<b>Allow all<\/b>/.test(html) && /<b>Autopilot<\/b>/.test(html)],
  ['permission explanations are hover tooltips, not question-mark badges', (html.match(/class="perm-option" title="/g) || []).length === 3],
  ['long permission descriptions are not printed in menu', !/Automatically handle routine workspace actions|Skip approval prompts\. Can overwrite/.test(html)],
  ['permission runtime no longer expects removed description elements', !/permExplain|permAllWarning|PERM_TEXT/.test(permissions)],
  ['permission mode selection still requires confirmation for Allow all', /Enable Allow all\?[\s\S]*?if \(!ok\)/.test(permissions)],
  ['task queue helper is a tooltip rather than visible instruction', /<label[^>]*title="Add a task to the queue[^>]*for="taskQueuePrompt"|<label for="taskQueuePrompt"[^>]*title="Add a task to the queue/.test(html) && !/Queued tasks wait for your approval/.test(html)],
  ['task empty state is concise', /task-empty">No tasks<\/div>/.test(tasks)],
  ['no question-mark help badges remain anywhere in the UI', !/class="qh|class="mb-help|class="ext-help|mkHelp/.test(html + fs.readFileSync('src-js/18-sidebar-connections.js','utf8') + fs.readFileSync('src-js/22-menubar.js','utf8'))],
  ['desktop shows a small native splash window before the full window', (() => { const m = fs.readFileSync('desktop/main.cjs','utf8'); return /function showSplash/.test(m) && /width: 320, height: 330, frame: false/.test(m) && /show: false/.test(m) && /closeSplash\(\);\n}/.test(m) && fs.existsSync('desktop/splash.html') && /Setup Your Workspace\.{6}/.test(fs.readFileSync('desktop/splash.html','utf8')); })()],
  ['one logo everywhere: svg sources, png icons, ico and menubar mark exist', ['codespace-logo.svg','codespace-icon.svg','codespace.png','codespace.ico'].every(n => fs.existsSync('assets/' + n)) && /class="mb-brand"/.test(html)],
  ['help badge tooltip code and styles are removed', !/\.qh\b|qh-tip|initHelpTips/.test(css + fs.readFileSync('src-js/18-sidebar-connections.js','utf8'))],
  ['splash has no promotional subtitle or source-credit copy', !/AI-powered coding workspace|Source Coder: Rabiul Islam|class="cs-splash-note"/.test(html)],
  ['skill panel uses concise headings and tooltip help', /<h4>Install skill<\/h4>/.test(html) && /<h4>SKILL\.md<\/h4>/.test(html) && /<label for="skOnly" title="[^"]+">Skill folder<\/label>/.test(html)],
  ['instructional title attributes are removed when the control label is sufficient', !/title="Drag to resize the side panel"|title="Ask every provider for its current model list"|title="Open this page in your system browser"/.test(html)],
  ['built app bundle contains updated permission behavior', bundle.includes('Agent permissions: ') && !bundle.includes('permAllWarning')],
  ['PWA shell cache is bumped for the clean UI', /codespace-pwa-\d+-/.test(sw)]
];
let failed = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failed++; }
console.log(`\n${checks.length - failed}/${checks.length} UI cleanup checks passed.`);
process.exit(failed ? 1 : 0);
