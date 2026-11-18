const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'app/src/main/java/com/codespace/android/MainActivity.kt'), 'utf8');

test('Android Local adapter implements persistent session CRUD with bounded ids and payloads', () => {
  for (const route of ['/sessions/save', '/sessions/list', '/sessions/get', '/sessions/delete']) assert.ok(source.includes(`"${route}" ->`), `missing ${route}`);
  assert.match(source, /A-Za-z0-9_-/);
  assert.match(source, /8 \* 1024 \* 1024/);
  assert.match(source, /localSessionsDir/);
});

test('Android Local adapter persists bounded project memory with explicit approval', () => {
  assert.ok(source.includes('"/project-memory/get" -> localProjectMemoryGet()'));
  assert.ok(source.includes('"/project-memory/set" -> localProjectMemorySet(body)'));
  assert.ok(source.includes('incoming.length() <= 80'));
  assert.ok(source.includes('requestLocalApproval("Save project memory"'));
  assert.ok(source.includes('.agent/project-memory.json'));
});

test('Android Local filesystem search is bounded and stays inside the app workspace', () => {
  assert.ok(source.includes('"/fs/search" -> if (hasSafWorkspace()) safFsSearch'));
  assert.ok(source.includes('++scanned > 400'));
  assert.ok(source.includes('matches.length() < 60'));
  assert.ok(source.includes('safeFile(path)'));
});

test('unsupported Android Local routes fail explicitly rather than falling back to Render', () => {
  assert.ok(source.includes('UnsupportedOperationException'));
  assert.ok(source.includes('put("status", 501)'));
});

test('Android Local configuration is persisted with a strict size bound', () => {
  assert.ok(source.includes('"/config/get" -> localConfigGet()'));
  assert.ok(source.includes('"/config/set" -> localConfigSet(body)'));
  assert.ok(source.includes('encoded.toByteArray(Charsets.UTF_8).size <= 1_000_000'));
  assert.ok(source.includes('app-private/config/app.json'));
});

test('Android Local project understanding scans manifests without executing suggested commands', () => {
  assert.ok(source.includes('"/project/understand" -> localProjectUnderstand()'));
  assert.ok(source.includes('"/project/understand/draft-memory" -> localProjectUnderstandDraft()'));
  assert.ok(source.includes('maxFiles: Int = 1800'));
  assert.ok(source.includes('Detected commands are suggestions only; none were executed.'));
});

test('Android Local source index is bounded and exposes search, symbols, references and related-file routes', () => {
  for (const route of ['/index/status', '/index/rebuild', '/index/search', '/index/symbols', '/index/references', '/index/related', '/index/map']) assert.ok(source.includes(`"${route}" ->`), `missing ${route}`);
  assert.ok(source.includes('supported.take(1200)'));
  assert.ok(source.includes('it.size <= 180_000L'));
  assert.ok(source.includes('Workspace files changed since the last index build'));
});

test('Android Local task lifecycle runs approved bounded command, test and crawl jobs with retry/cancellation', () => {
  for (const route of ['/task/list', '/task/create', '/task/retry', '/task/cancel']) assert.ok(source.includes(`"${route}" ->`), `missing ${route}`);
  assert.ok(source.includes('localTaskSave()'));
  assert.ok(source.includes('localTaskCancels[id]?.set(true)'));
  assert.ok(source.includes('setOf("index_rebuild", "diagnostics", "command", "tests", "test", "build", "lint", "web_crawl")'));
  assert.ok(source.includes('retryOf'));
  assert.ok(source.includes('savedParams'));
  assert.ok(source.includes('AndroidLocalWebCrawler.crawl'));
  assert.ok(source.includes('requestLocalApproval("Start Android background task: $kind"'));
  assert.ok(source.includes('Task working directory must be inside the Local workspace'));
  assert.ok(source.includes('previousAttempts < 3'));
  assert.ok(source.includes('requestLocalApproval("Crawl public website"'));
});


test('Android Local file history supports bounded undo/redo for text edits and file deletion', () => {
  for (const route of ['/fs/history', '/fs/undo', '/fs/redo']) assert.ok(source.includes(`"${route}" ->`), `missing ${route}`);
  assert.ok(source.includes('undo.length() > 10'));
  assert.ok(source.includes('content.toByteArray(Charsets.UTF_8).size > 400_000'));
  assert.ok(source.includes('localFsUndoRedo(body.optString("path", ""), "undo")'));
  assert.ok(source.includes('localHistoryWrite(path, restoreExists, restored)'));
});
