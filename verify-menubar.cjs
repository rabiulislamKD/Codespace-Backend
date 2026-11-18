'use strict';
/* 3.13.17: in-app menu bar. Every menu entry must call something that exists. */
const fs = require('fs'), assert = require('assert/strict');
const menu = fs.readFileSync('src-js/22-menubar.js', 'utf8');
const all = fs.readdirSync('src-js').filter(f => f.endsWith('.js') && f !== '22-menubar.js').map(f => fs.readFileSync('src-js/' + f, 'utf8')).join('\n');
const html = fs.readFileSync('my-chat-agent-v3.html', 'utf8');
const man = JSON.parse(fs.readFileSync('src-js/manifest.json', 'utf8'));
const checks = [];
const t = (n, ok) => checks.push([n, !!ok]);
t('menu bar element exists in the page', /<nav id="menubar"/.test(html));
t('menu module is part of the bundle', man.core.includes('22-menubar.js') && fs.readFileSync('js/app.js', 'utf8').includes('application menu bar'));
for (const title of ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Debug', 'Help']) t('menu "' + title + '" is defined', new RegExp("\\['" + title + "', \\[").test(menu));
const used = ['newSession', 'ctxNewFile', 'ctxNewFolder', 'openQuickOpen', 'openFolder', 'saveTab', 'closeTab', 'openSettings', 'openView', 'showView', 'attachEditorSelection', 'compressNow', 'toggleTerminal', 'showTerminal', 'newTerm', 'changeTheme', 'showPanel', 'reloadPreview', 'toggleDiag', 'activeFileTab', 'addErr', 'addNote'];
for (const fn of used) t('menu action target "' + fn + '" exists', new RegExp('(function\\s+' + fn + '\\b|(const|let)\\s+' + fn + '\\b)').test(all));
for (const id of ['termClear', 'termKill', 'termCmd', 'stopBtn', 'codeQuery', 'edTa', 'input']) t('element #' + id + ' used by the menu exists', new RegExp('id="' + id + '"').test(html));
t('palette no longer calls the undefined showPreviewDiagnostics', !/showPreviewDiagnostics/.test(all));
t('Run Active File quotes the file path for the shell', /function shellQuote/.test(menu) && !/'"' \+ p\.replace/.test(menu));
t('status bar uses a theme-derived dark surface, not bright blue', !/--status-bg:#0078d4|--status-bg:#005fb8/.test(fs.readFileSync('css/01-base.css', 'utf8')));
let bad = 0; for (const [n, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; }
console.log('\n' + (checks.length - bad) + '/' + checks.length + ' menu bar checks passed.'); process.exit(bad ? 1 : 0);
