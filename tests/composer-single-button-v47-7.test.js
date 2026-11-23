const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const find = (...candidates) => candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
const read = (...candidates) => fs.readFileSync(find(...candidates), 'utf8');

const androidHtml = read(
  path.join(root, '..', 'app', 'src', 'main', 'assets', 'codespace-web', 'index.html'),
  path.join(root, 'android', 'app', 'src', 'main', 'assets', 'codespace-web', 'index.html')
);
const coreHtml = read(
  path.join(root, 'my-chat-agent-v3.html'),
  path.join(root, '..', 'my-chat-agent-v3.html')
);
const androidCss = read(
  path.join(root, '..', 'app', 'src', 'main', 'assets', 'codespace-web', 'css', '07-extras.css'),
  path.join(root, 'android', 'app', 'src', 'main', 'assets', 'codespace-web', 'css', '07-extras.css')
);
const coreCss = read(path.join(root, 'css', '07-extras.css'));
const metersSrc = read(path.join(root, 'src-js', '07-meters-approvals.js'));
const composerSrc = read(path.join(root, 'src-js', '19-activitybar-composer.js'));
const menubarSrc = read(path.join(root, 'src-js', '22-menubar.js'));

test('v47.7 ships exactly one composer button with send and stop icons', () => {
  for (const html of [androidHtml, coreHtml]) {
    assert.doesNotMatch(html, /id="stopBtn"/);
    assert.equal((html.match(/id="sendBtn"/g) || []).length, 1);
    assert.match(html, /class="ico-send"/);
    assert.match(html, /class="ico-stop"/);
  }
  for (const css of [androidCss, coreCss]) {
    assert.doesNotMatch(css, /#stopBtn/);
    assert.match(css, /\.sendSlot #sendBtn\.stop/);
    assert.match(css, /\.sendSlot #sendBtn svg\[hidden\]\{display:none\}/);
  }
});

test('v47.7 switches the single button between Stop and Send/Queue based on composer content', () => {
  assert.match(metersSrc, /function csPrimaryMode\(\)/);
  assert.match(metersSrc, /csUiBusy && !csComposerHasContent\(\) \? 'stop' : 'send'/);
  assert.match(metersSrc, /function csUpdatePrimaryButton\(\)/);
  assert.match(metersSrc, /function csSetPrimaryPreparing\(value\)/);
  assert.match(metersSrc, /function csStopActiveRun\(\)/);
  assert.doesNotMatch(metersSrc, /\$\('stopBtn'\)/);
  assert.match(composerSrc, /\$\('sendBtn'\)\.onclick = \(\) => \{ if \(csPrimaryMode\(\) === 'stop'\) csStopActiveRun\(\); else send\(\); \}/);
  assert.match(composerSrc, /e\.key === 'Enter'[\s\S]{0,120}csPrimaryMode\(\) === 'stop'[\s\S]{0,80}csStopActiveRun\(\)/);
  assert.match(composerSrc, /\$\('input'\)\.addEventListener\('input', \(\) => \{ autoSize\(\); csUpdatePrimaryButton\(\); \}\)/);
  assert.match(composerSrc, /function renderAttachTray\(\)[\s\S]{0,2000}csUpdatePrimaryButton\(\);/);
  assert.doesNotMatch(composerSrc, /\$\('stopBtn'\)\.onclick/);
  assert.match(menubarSrc, /csUiBusy\) csStopActiveRun\(\)/);
});
