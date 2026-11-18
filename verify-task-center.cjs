'use strict';
const fs=require('fs'),assert=require('assert/strict');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const manifest=JSON.parse(fs.readFileSync('src-js/manifest.json','utf8'));
const tasks=fs.readFileSync('src-js/23-task-center.js','utf8');
const agent=fs.readFileSync('src-js/13-multi-agent-orchestration.js','utf8');
const state=fs.readFileSync('src-js/01-core-helpers-state.js','utf8');
const html=fs.readFileSync('my-chat-agent-v3.html','utf8');
const menu=fs.readFileSync('src-js/22-menubar.js','utf8');
const bundle=fs.readFileSync('js/app.js','utf8');
const checks=[
 ['release version is a valid 3.x release',/^3\.\d+\.\d+$/.test(pkg.version)],
 ['task center fragment is bundled',manifest.core.includes('23-task-center.js')&&bundle.includes('persistent autonomous task center')],
 ['tasks persist inside each session',/function taskLedger\(session\)/.test(tasks)&&/tasks:/.test(tasks)===false],
 ['task records are created for normal agent runs',/claimTaskForRun\(sess, text, run.startedAt\)/.test(agent)],
 ['task records receive progress snapshots',/updateTaskRecord\(sess, run.taskId, \{ status: 'running'/.test(agent)],
 ['final task outcome is persisted',/updateTaskRecord\(sess, run.taskId, \{ status: run.stopReason/.test(agent)],
 ['interrupted runs are recovered as interrupted',/markRecoveredTasksInterrupted/.test(state)&&/App closed before task completion/.test(tasks)],
 ['queued tasks require explicit Run action',/launchQueuedTask/.test(tasks)&&/Run next/.test(html)],
 ['resume uses saved task and workspace context',/function resumeTask/.test(tasks)&&/Do not restart completed work/.test(tasks)],
 ['task center is available from Run menu',/Task Center', run: \(\) => showTaskCenter/.test(menu)],
 ['task queue is bounded',/list.length > 50/.test(tasks)],
 ['task UI has responsive layout',/task-center-dialog/.test(fs.readFileSync('css/07-extras.css','utf8'))],
 ['queued task removal does not affect running tasks',/if \(task.status === 'queued'\) addAction\('Remove'/.test(tasks)],
 ['no automatic execution of queued tasks',!/setTimeout\([^\n]*launchQueuedTask/.test(tasks)],
 ['task history and actions are rendered from stored records',/function allTaskEntries/.test(tasks)&&/function renderTaskCenter/.test(tasks)]
];
let bad=0;for(const [name,ok] of checks){console.log((ok?'PASS ':'FAIL ')+name);if(!ok)bad++;}
console.log(`\n${checks.length-bad}/${checks.length} task-center checks passed.`);process.exit(bad?1:0);
