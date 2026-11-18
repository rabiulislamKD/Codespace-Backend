const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const core = path.join(root, 'codespace-core-3.18.4');
const assets = path.join(root, 'app', 'src', 'main', 'assets', 'codespace-web');

test('Android package preserves the CodeSpace 3.18.4 HTML shell with native UI adaptations', () => {
  const coreHtml = fs.readFileSync(path.join(core, 'my-chat-agent-v3.html'), 'utf8');
  const androidHtml = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  // Keep the shared application shell and feature surface. Android intentionally adds
  // native-only controls (Open folder, browser minimize/fullscreen, sandbox selector)
  // and removes the address/navigation row handled by the native WebView.
  for (const marker of ['id="titlebar"', 'id="side"', 'id="tree"', 'id="chatPane"', 'id="composer"', 'id="provQuick"']) {
    assert.ok(coreHtml.includes(marker), `desktop shell retains ${marker}`);
    assert.ok(androidHtml.includes(marker), `Android shell retains ${marker}`);
  }
  for (const marker of ['id="expOpen"', 'id="bMin"', 'id="bMax"', 'id="sandboxSel"']) {
    assert.ok(androidHtml.includes(marker), `Android shell adds ${marker}`);
  }
  assert.doesNotMatch(androidHtml, /id="bAddr"/);
});

test('Android bundle retains the core CodeSpace feature surface with explicit native adaptations', () => {
  const coreBundle = fs.readFileSync(path.join(core, 'js', 'app.js'), 'utf8');
  const androidBundle = fs.readFileSync(path.join(assets, 'js', 'app.js'), 'utf8');
  // The Android bundle intentionally diverges only where native Local adapters/UI are needed.
  // Verify the major original feature entry points still exist in both bundles without asking
  // assert.deepEqual to print hundreds of kilobytes of source when a native-only patch is added.
  const featureMarkers = [
    'function toolDefs()', 'function renderProviders()',
    'function drawGit()', 'function runJs('
  ];
  for (const marker of featureMarkers) {
    assert.ok(coreBundle.includes(marker), `desktop core retains ${marker}`);
    assert.ok(androidBundle.includes(marker), `Android bundle retains ${marker}`);
  }
  assert.match(androidBundle, /gitRemoteSync\('fetch'\)/);
  assert.match(androidBundle, /gitRemoteSync\('pull'\)/);
  assert.match(androidBundle, /gitRemoteSync\('push'\)/);
});

test('Android source package retains all modular CodeSpace client feature sources', () => {
  const source = path.join(core, 'src-js');
  const files = fs.readdirSync(source).filter(name => /^\d{2}-.+\.js$/.test(name));
  assert.equal(files.length, 29);
  assert.ok(files.includes('25-editor-debugger.js'), 'editor-integrated Android Local debugger module is included');
  assert.ok(files.includes('26-node-packages.js'), 'Android Local Node package manager module is included');
  assert.ok(files.includes('27-python-packages.js'), 'Android Local Python package manager module is included');
  assert.ok(files.includes('28-language-servers.js'), 'Android Local language-server setup module is included');
  for (const file of files) assert.ok(fs.statSync(path.join(source, file)).size > 0, `${file} is present`);
});

test('Android parity ledger clearly distinguishes UI preservation from Local runtime parity', () => {
  const ledger = fs.readFileSync(path.join(root, 'ANDROID-FEATURE-PARITY-3.18.4.md'), 'utf8');
  assert.match(ledger, /not a claim that every feature already executes in Android Local mode/i);
  assert.match(ledger, /acceptance rule for full feature parity/i);
  assert.match(ledger, /must fail explicitly as unsupported/i);
});
