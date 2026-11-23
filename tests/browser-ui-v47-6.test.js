const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pathFor = (...parts) => {
  const bases = [
    path.join(root, '..', 'app', 'src', 'main', 'assets', 'codespace-web'),
    path.join(root, 'android', 'app', 'src', 'main', 'assets', 'codespace-web')
  ];
  for (const base of bases) {
    const candidate = path.join(base, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(bases[0], ...parts);
};
const javaPath = () => {
  const candidates = [
    path.join(root, '..', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt'),
    path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'codespace', 'android', 'MainActivity.kt')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
};
const html = fs.readFileSync(pathFor('index.html'), 'utf8');
const bundle = fs.readFileSync(pathFor('js', 'app.js'), 'utf8');
const panelsCss = fs.readFileSync(pathFor('css', '06-panels.css'), 'utf8');
const layoutCss = fs.readFileSync(pathFor('css', '08-layout.css'), 'utf8');
const mainSrc = fs.readFileSync(javaPath(), 'utf8');

test('v47.6 keeps a usable browser address bar and navigation row on Android', () => {
  for (const marker of ['id="bAddr"', 'id="bGo"', 'id="bAttach"', 'id="bSecureIcon"', 'inputmode="url"']) {
    assert.ok(html.includes(marker), `Android browser UI retains ${marker}`);
  }
  assert.match(bundle, /\$\('bGo'\)\.onclick/);
  assert.match(bundle, /\$\('bAddr'\)\.addEventListener\('keydown'/);
  assert.match(bundle, /window\.CodeSpaceNative\?\.attachBrowserSelection/);
  assert.match(panelsCss, /\.chrome-omnibox\{/);
  assert.match(panelsCss, /#bAddr\{/);
  assert.match(panelsCss, /#bGo\{/);
});

test('v47.6 never blanks the native browser on resize, fullscreen or transient collapsed rects', () => {
  assert.match(bundle, /function browserPanelActive\(\)/);
  assert.match(bundle, /lastAndroidSync/);
  assert.match(bundle, /captureAndroidBrowserSnapshot/);
  assert.match(bundle, /Reuse the\s+\/\/*\s*last known-good rectangle|last known-good rectangle/);
  assert.match(bundle, /fullscreenBrowser/);
  assert.doesNotMatch(layoutCss, /html\.browser-fs #bview \.chrome-ui/);
  assert.match(layoutCss, /html\.browser-fs \.chrome-ui\{border-radius:0\}/);
  assert.match(mainSrc, /setAndroidBrowserBounds/);
});

test('v47.6 long press shows only Android copy/selection actions, with an explicit attach button', () => {
  // The tab strip still uses long press to close a tab; only the old page-content popup is gone.
  assert.doesNotMatch(mainSrc, /web\.hitTestResult\.type != WebView\.HitTestResult\.UNKNOWN_TYPE/);
  assert.doesNotMatch(mainSrc, /showSelectionMenu/);
  assert.doesNotMatch(mainSrc, /showBrowserElementMenu/);
  assert.doesNotMatch(mainSrc, /popup\.menu\.add\("Attach to chat"\)/);
  assert.match(mainSrc, /@JavascriptInterface fun attachBrowserSelection\(\)/);
  assert.match(mainSrc, /window\.CodeSpaceReceiveBrowserAttachment/);
  assert.match(mainSrc, /Nothing to attach from this page/);
  assert.match(html, /title="Attach page or selected text to chat"/);
});
