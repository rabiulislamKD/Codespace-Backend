'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src-js/23-task-center.js', 'utf8');
function harness() {
  const context = {
    sessions: [{ id: 's1', title: 'Test chat', messages: [], tasks: [] }], curId: 's1',
    uid: (() => { let n=0; return () => 'id'+(++n); })(),
    persistSession() {}, saveSessionsLocal() {},
    $() { return null; }, ctrl: null, addNote() {}, switchSession() {}, runAgent() {},
    Date, String, Number, Array, Math, Set, Object, JSON
  };
  vm.createContext(context);
  vm.runInContext(source + `\n;globalThis.api={taskLedger,claimTaskForRun,updateTaskRecord,markRecoveredTasksInterrupted,allTaskEntries,setPending:(v)=>{pendingTaskLaunch=v;}};`, context);
  return { context, api: context.api };
}
test('new agent runs create persistent task records', () => {
  const {context,api}=harness();
  const task=api.claimTaskForRun(context.sessions[0],'Build a feature',1000);
  assert.equal(task.status,'running'); assert.equal(task.prompt,'Build a feature'); assert.equal(task.sessionId,'s1');
});
test('progress updates keep lifecycle state and execution evidence', () => {
  const {context,api}=harness();
  const task=api.claimTaskForRun(context.sessions[0],'Test task',1000);
  api.updateTaskRecord(context.sessions[0],task.id,{phase:'Running tests',toolCalls:4,changedFiles:['src/a.js']});
  assert.equal(task.phase,'Running tests'); assert.equal(task.toolCalls,4); assert.deepEqual(Array.from(task.changedFiles),['src/a.js']);
});
test('restart reconciliation marks only stale running tasks interrupted', () => {
  const {context,api}=harness();
  context.sessions[0].tasks=[{id:'a',status:'running'},{id:'b',status:'queued'},{id:'c',status:'completed'}];
  api.markRecoveredTasksInterrupted();
  assert.equal(context.sessions[0].tasks[0].status,'interrupted');
  assert.equal(context.sessions[0].tasks[1].status,'queued');
  assert.equal(context.sessions[0].tasks[2].status,'completed');
});
test('task history aggregates records across chats', () => {
  const {context,api}=harness();
  context.sessions.push({id:'s2',title:'Second chat',tasks:[{id:'b',status:'queued',updatedAt:2000}]});
  api.claimTaskForRun(context.sessions[0],'First task',1000);
  assert.equal(api.allTaskEntries().length,2);
  assert.equal(api.allTaskEntries()[0]._sessionId,'s2');
});
test('resuming a queued or interrupted record reuses its task identity', () => {
  const {context,api}=harness();
  const original=api.claimTaskForRun(context.sessions[0],'Original task',1000);
  api.setPending({id:original.id,sessionId:'s1'});
  const resumed=api.claimTaskForRun(context.sessions[0],'Resume instructions',2000);
  assert.equal(resumed.id,original.id);
  assert.equal(resumed.prompt,'Original task');
});
