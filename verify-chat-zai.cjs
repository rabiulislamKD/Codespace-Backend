'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('my-chat-agent-v3.html');
const composer = read('src-js/19-activitybar-composer.js');
const state = read('src-js/01-core-helpers-state.js');
const adapter = read('src-js/10-model-adapters.js');
const server = read('agent-server.js');
const proxy = read('chat-zai-proxy.js');
const pkg = JSON.parse(read('package.json'));
let passed = 0;
const ok = label => { passed++; console.log('PASS', label); };

const topStart = html.indexOf('<div class="crow crow-top">');
const botStart = html.indexOf('<div class="crow crow-bot">');
const zaiPos = html.indexOf('data-route="zai"', topStart);
assert.ok(topStart >= 0 && botStart > topStart && zaiPos > topStart && zaiPos < botStart);
assert.ok(!/id="chatZaiBtn"|id="opencodeBtn"/.test(html), 'the separate OpenCode / Chat Z.ai switches are replaced by the engine dropdown');
ok('Chat Z.ai is selectable from the composer engine dropdown');

assert.match(state, /chatZaiCLI:\s*false/);
assert.match(state, /chatZaiPrevId:\s*''/);
assert.match(composer, /bcall\('\/chat-zai\/start'\)/);
assert.match(composer, /bcall\('\/chat-zai\/stop'\)/);
assert.match(composer, /applyChatZaiModels\(p, result\.models\)/);
assert.match(composer, /S\.activeId = p\.id; S\.chatZaiCLI = true/);
assert.match(composer, /S\.chatZaiPrevId/);
ok('Toggle starts and stops the local service, populates the model selector, and restores the prior provider');
assert.match(composer, /providerKey === 'chat-zai' \|\| x\.id === 'chat-zai' \|\| x\.id === 'chat-zai-local'/);
assert.match(adapter, /p\.id === 'chat-zai' \|\| p\.id === 'chat-zai-local'/);
ok('The dedicated local bridge provider is selected without repurposing other custom Z.ai endpoints');

assert.match(adapter, /isChatZaiProvider\(p\) && L\.bridgeToken/);
assert.match(adapter, /body\.enable_thinking = !!thinkLevel/);
assert.match(adapter, /const url = p\.format === 'custom' \? p\.base\.trim\(\) : p\.base\.replace/);
ok('Normal CodeSpace OpenAI-compatible streaming adapter sends authenticated Chat Z.ai requests');

assert.match(server, /case '\/chat-zai\/start'/);
assert.match(server, /case '\/chat-zai\/stop'/);
assert.match(server, /CODESPACE_CHAT_ZAI_TOKEN:\s*TOKEN/);
assert.match(server, /CODESPACE_CHAT_ZAI_PROFILE_DIR:\s*path\.join\(DATA, 'chat-zai-browser-profile'\)/);
assert.match(server, /190000/);
assert.match(proxy, /userDataDir:\s*PROFILE_DIR/);
assert.match(proxy, /headless:\s*process\.env\.CODESPACE_CHAT_ZAI_HEADLESS === '1'/);
assert.match(proxy, /LOGIN_WAIT_MS/);
assert.doesNotMatch(proxy, /localStorage\.removeItem\('token'\)/);
assert.match(proxy, /persistentProfile:\s*true/);
assert.match(server, /stdio:\s*\['ignore', 'pipe', 'pipe', 'ipc'\]/);
assert.match(proxy, /server\.listen\(PORT, '127\.0\.0\.1'/);
assert.match(proxy, /function authorized\(req\)/);
assert.match(proxy, /timingSafeEqual/);
assert.match(proxy, /\/api\/v2\/chat\/completions/);
assert.match(proxy, /\/api\/models/);
assert.match(pkg.dependencies['puppeteer-core'], /^\^24\./);
ok('Protected bridge uses a persistent dedicated browser profile, first-run interactive sign-in, session-preserving reload, and loopback-only API routes');

assert.match(read('pwa/sw.js'), /codespace-pwa-\d+-/);
assert.ok(fs.existsSync(path.join(root, 'CHAT-ZAI-INTEGRATION.md')));
ok('PWA cache is bumped and the integration requirements/limitations are documented');

console.log(`chat-zai: ${passed} checks passed`);
