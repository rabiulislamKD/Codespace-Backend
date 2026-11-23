'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const androidPath = p => {
  for (const base of ['../app', 'android/app']) {
    const f = path.join(root, base, p);
    if (fs.existsSync(f)) return f;
  }
  return path.join(root, '../app', p);
};
const readAndroid = p => fs.readFileSync(androidPath(p), 'utf8');
const manifest = readAndroid('src/main/AndroidManifest.xml');
const mainSrc = readAndroid('src/main/java/com/codespace/android/MainActivity.kt');
const cdpSrc = readAndroid('src/main/java/com/codespace/android/AndroidWebViewCdp.kt');
const serviceFile = androidPath('src/main/java/com/codespace/android/AiRuntimeService.kt');
const serviceExists = fs.existsSync(serviceFile);
const serviceSrc = serviceExists ? fs.readFileSync(serviceFile, 'utf8') : '';
const metersSrc = read('src-js/07-meters-approvals.js');
const composerSrc = read('src-js/19-activitybar-composer.js');
const clientSrc = read('src-js/03-bridge-client.js');
const bridgeSrc = read('src-js/09-browser-bridge.js');

test('[1] manifest declares wake lock and the AI background service', () => {
  assert.match(manifest, /android\.permission\.WAKE_LOCK/);
  assert.match(manifest, /android:name="\.AiRuntimeService"/);
  assert.match(manifest, /foregroundServiceType="dataSync"/);
});

test('[2] the AI foreground service holds a partial wake lock', () => {
  assert.ok(serviceExists, 'AiRuntimeService.kt is missing');
  assert.match(serviceSrc, /startForeground\(NOTIFICATION_ID/);
  assert.match(serviceSrc, /PowerManager\.PARTIAL_WAKE_LOCK/);
  assert.match(serviceSrc, /ACTION_START/);
  assert.match(serviceSrc, /ACTION_STOP/);
});

test('[3] native bridge exposes background control to the app and remote mode', () => {
  assert.match(mainSrc, /@JavascriptInterface fun setAiBackground\(active: Boolean, label: String\)/);
  assert.match(mainSrc, /AiRuntimeService\.start\(this@MainActivity, label\)/);
  assert.match(mainSrc, /"\/?ai\/background" ->/);
  assert.ok(clientSrc.includes('ai\\/background'), 'remote-mode routing must include /ai/background');
});

test('[4] screenshots use DevTools first and validate pixels before accepting a frame', () => {
  assert.match(cdpSrc, /fun capturePageJpeg\(/);
  assert.match(cdpSrc, /command\("Page\.captureScreenshot"/);
  assert.match(mainSrc, /private fun cdpBrowserScreenshot\(/);
  assert.match(mainSrc, /private fun drawBrowserScreenshot\(/);
  assert.match(mainSrc, /private fun browserImageHasContent\(/);
  assert.match(mainSrc, /val viaCdp = try \{ cdpBrowserScreenshot\(url\) \}/);
  assert.match(mainSrc, /browserHost\.visibility = View\.VISIBLE/);
  assert.match(mainSrc, /Browser screenshot is blank after both DevTools and visible-view capture/);
});

test('[5] the composer stays usable during a run', () => {
  assert.match(metersSrc, /function csSetAiBackground\(/);
  assert.match(metersSrc, /\$\('sendBtn'\)\.hidden = false;.*\$\('input'\)\.disabled = false;/);
  assert.match(metersSrc, /csFlushQueuedMessages\(\);/);
});

test('[6] messages sent during a run are queued in order and flushed afterwards', () => {
  assert.match(metersSrc, /const CS_QUEUED_MESSAGES = \[\];/);
  assert.match(metersSrc, /async function csFlushQueuedMessages\(\)/);
  assert.match(composerSrc, /async function send\(queued\)/);
  assert.match(composerSrc, /if \(ctrl \|\| sendPreparing \|\| \(typeof ocRunActive/);
  assert.match(composerSrc, /csQueueMessage\(\{/);
  assert.match(metersSrc, /await send\(next\)/);
  assert.match(metersSrc, /function csStopActiveRun\(\)[\s\S]{0,160}CS_QUEUED_MESSAGES\.length = 0; csRenderQueueHint\(\)/);
});

test('[7] remote sandbox screenshots fall back between device, sandbox and browser bridge', () => {
  assert.match(bridgeSrc, /Device screenshot failed\. Capture the page in the remote sandbox instead\?/);
  assert.match(bridgeSrc, /Screenshot failed in the remote sandbox/);
  assert.match(bridgeSrc, /!\['browser', 'cdp', 'browser-draw'\]\.includes\(r\.source\)/);
});
