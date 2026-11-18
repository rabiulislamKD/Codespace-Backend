const fs = require('fs');
/* 3.13.1: the app is split across the entry html + css/ + js/app.js — verify against all of it */
try { require(__dirname + '/tools/build-web.cjs').ensure(); } catch {}
const html = ['my-chat-agent-v3.html', ...fs.readdirSync(__dirname + '/css').sort().map(f => 'css/' + f), 'js/app.js'].map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');
const server = fs.readFileSync(__dirname + '/agent-server.js', 'utf8');
const checks = [
 ['Install source persisted for npm packages', /installSource: 'npm:' \+ pkg/.test(server)],
 ['Install source exposed to UI', /installSource: x\.manifest\.installSource/.test(server)],
 ['Registry endpoint', /case '\/ext\/catalog\/search': return send\(res, 200, await extCatalogSearch\(b\)\)/.test(server)],
 ['Registry timeout', /setTimeout\(\(\) => controller\.abort\(\), 12000\)/.test(server)],
 ['Existing extension removal retained', /case '\/ext\/remove': \{ const g = permGuard\('destructive', 'Remove extension: ' \+ String\(b\.name \|\| ''\)/.test(server)],
 ['Existing install approval retained', /approve\('Install extension\?'/i.test(html)],
 ['Package safety endpoint', /case '\/ext\/package\/inspect'/.test(server)],
 ['PWA manifest linked', /rel="manifest" href="\/manifest\.webmanifest"/.test(html)],
 ['Service worker registered on secure http(s) only', /serviceWorker\.register\('\/sw\.js'\)/.test(html) && /isSecureContext/.test(html)],
 ['Server serves PWA shell', /'\/manifest\.webmanifest'/.test(server) && /'\/sw\.js'/.test(server)],
 ['Service worker never caches POST or Authorization requests', /req\.method !== 'GET'/.test(fs.readFileSync(__dirname + '/pwa/sw.js','utf8')) && /headers\.has\('authorization'\)/.test(fs.readFileSync(__dirname + '/pwa/sw.js','utf8'))],
 ['Server audit log endpoint + hash chain', /case '\/audit\/list'/.test(server) && /auditWrite/.test(server) && /createHash\('sha256'\)/.test(server)],
 ['Audit redacts secrets', /const redact = /.test(server) && /textLength/.test(server)],
 ['Activity search/filter/export UI', /id="logQ"/.test(html) && /id="logCsv"/.test(html) && /loadServerAudit/.test(html)],
 ['Retries provider overload errors sent inside a 200 stream', /e\.inStream/.test(html) && /isTransientModelError/.test(html) && /Retrying in/.test(html)],
 ['Marketplace uses Open VSX registry and compatible extension probing', /https:\/\/open-vsx\.org\/api/.test(server) && /inspectOpenVsxItem/.test(server) && /vscodeExtSupport\.inspectVsix/.test(server)],
 ['Marketplace installs only validated VSIX packages for supported CodeSpace runtimes', /VSCODE_EXT_DIR = path\.join\(DATA, 'vscode-extensions', 'codespace-installed'\)/.test(server) && /extractVsix\(bytes, temp\)/.test(server) && /inspectVsixForCodeSpace/.test(server) && /hostType/.test(server)],
 ['Marketplace permission gates protect search, install and uninstall', /permGuard\('network', 'Search the CodeSpace-compatible VS Code extension marketplace'/.test(server) && /permGuard\('ext', 'Install VS Code extension /.test(server) && /permGuard\('destructive', 'Uninstall VS Code extension /.test(server)],
 ['Marketplace only returns candidates that pass either supported runtime check', /inspectVsixForCodeSpace\(bytes\)/.test(server) && /compatible: true/.test(server) && /No extensions passed the CodeSpace compatibility checks/.test(fs.readFileSync(__dirname + '/src-js/24-vscode-marketplace.js', 'utf8')) && /Node.js compatible/.test(server)],
 ['Marketplace asset serving requires the local bridge token', /extension-host\/assets\//.test(server) && /Wrong or missing extension asset token/.test(server)],
 ['No per-message model-round setting', !/id="steps"/.test(html) && !/Max model rounds per message/i.test(html)],
 ['Agent loop has no fixed model-round cap', /for \(let step = 1; ; step\+\+\)/.test(html) && !/DEFAULT_MAX_AGENT_STEPS|HARD_MAX_AGENT_STEPS|step-limit/.test(html)],
 ['Interface carries no model-round instruction text (clean UI)', !/no fixed per-message limit/i.test(html)],
 ['CodeSpace-compatible VS Code marketplace UI is present', /id="extMktQuery"/.test(html) && /id="extMktResults"/.test(html) && /Installed VS Code Extensions/.test(html)],
 /* 3.13.4: no-git GitHub fallback + extension details view */
 ['Repo installs fall back to the codeload ZIP archive when git is missing', /async function repoToDir/.test(server) && /codeload\.github\.com/.test(server) && /await repoToDir\(url, tmp\)/.test(server) && /await repoToDir\(src, tmp\)/.test(server)],
 ['The ZIP fallback extractor is hard against malicious archives', /0xa000\) continue/.test(server) && /zip-slip/.test(server) && /maxArchive: 200e6/.test(server) && /0x04034b50/.test(server)],
 ['git can be disabled for testing via CODESPACE_DISABLE_GIT', /CODESPACE_DISABLE_GIT/.test(server)],
 ['Both installers report which path was used (via=git|zip)', /return \{ installed, via \};/.test(server) && /return \{ installed, via \};/.test(server)],
 ['GitHub extension install box is present', /id="extGitSrc"/.test(html) && /id="extGitExt"/.test(html)],
 ['Outside-workspace reads go through the approval handshake', /outsideApproved\('\/fs\/read'/.test(html) && /outsideApproved\('\/fs\/list'/.test(html) && /outsideApproved\('\/fs\/search'/.test(html)],
 ['System prompt pins the agent to the opened workspace', /WORKSPACE SCOPE \(strict\)/.test(html) && /never\s+list,\s+read,\s+search/i.test(html)],
 ['Side panel is resizable and persisted', /id="sideSplit"/.test(html) && /agent3\.sidew/.test(html) && /--sidew/.test(html)],
 ['Side panel resizer hidden on mobile and when sidebar is closed', /#split,#sideSplit\{display:none\}/.test(html) && /#app\.nosidebar\{--sidew:0px!important\}/.test(html)],
 ['Task plan renders inside latest chat turn, not as a fixed top panel', /anchor\.insertAdjacentElement\('afterend', panel\)/.test(html) && /const turn = ui\.turn && chatBox\.contains\(ui\.turn\)/.test(html)],
 ['Task plan has a one-line compact summary with progress', /plan-summary-count/.test(html) && /plan-mini-track/.test(html) && /plan-summary-current/.test(html)],
 ['Task plan expands to detailed status rows', /plan-body/.test(html) && /plan-list/.test(html) && /PLAN_STATUS_LABELS/.test(html)],
 ['Task plan hides when all steps finish or completion is locked for this turn', /const hasUnfinishedSteps = plan.length > 0 && plan.some\(x => x.status !== 'completed'\)/.test(html) && /if \(!hasUnfinishedSteps \|\| \(sess && sess.planCompletedForTurn\)\)/.test(html)],
 ['A new My Chat Agent turn clears a stale previous plan', /resetPlanForNewTurn\(sess\);\s*chatAutoFollowActiveTurn = true;\s*h\.push\(\{ role: 'user', content: text, images: \(images \|\| \[\]\)\.slice\(0, 4\) \}\)/.test(html)],
 ['OpenCode chat clears previous My Chat Agent plan', /async function runOpenCodeChat\(text, userDisplayText = text, privateContext = \'\'\) \{[\s\S]*?resetPlanForNewTurn\(sess\);[\s\S]*?h\.push\(\{ role: \'user\', content: userDisplayText, images: \[\] \}\)/.test(html)],
 ['Task plan toggles through its summary and header Plan button', /summary\.addEventListener\('click', togglePlanExpanded\)/.test(html) && /\$\('planBtn'\)\.onclick = togglePlanExpanded/.test(html)],
 ['Task plan retains status styles for all states', /data-status=\"completed\"/.test(html) && /data-status=\"in_progress\"/.test(html) && /data-status=\"blocked\"/.test(html) && /Pending/.test(html)],
 ['Multi-agent planner resets to collapsed mode and uses shared plan renderer', /sess\.planExpanded = false;\s*renderPlanPanel\(\);/.test(html) && /renderPlanPanel\(\);\s*try \{ persistSession\(\); \}/.test(html)],
 ['Task plan is reattached after history/session transcript rebuild', /function renderHistory\(\) \{[\s\S]*?const planPanel = \$\('planPanel'\);/.test(html) && /\$\('chatTitle'\)\.textContent = cur\(\)\.title;\s*renderPlanPanel\(\);[\s\S]*?chat\.scrollTop/.test(html)],
 ['OpenCode CLI is selectable from the composer engine dropdown', /id="routeBtn"/.test(html) && /data-route="opencode"/.test(html) && /Uses OpenCode&#8217;s own login/.test(html)],
 ['OpenCode auto-approval is disabled by default', /openCodeAutoApprove: false/.test(html) && /openCodeAutoApprove: \$\('openCodeAutoApprove'\)\.checked/.test(html)],
 ['OpenCode status endpoint exists', /case '\/opencode\/status': return send\(res, 200, openCodeStatus\(\)\)/.test(server)],
 ['OpenCode run endpoint exists', /case '\/opencode\/run': \{ const g = permGuard\('terminal', 'Run the OpenCode agent/.test(server)],
 ['OpenCode invokes official non-interactive CLI JSON mode', /'run', '--format', 'json', '--dir', ROOT/.test(server)],
 ['OpenCode invocation does not use a shell', /spawn\(binary\.command, args, \{ cwd: ROOT, detached: !WIN, windowsHide: true, env: runCfg\.env, stdio: \['ignore', 'pipe', 'pipe'\] \}\)/.test(server)],
 ['OpenCode sessions continue per My Chat Agent conversation', /sessionId: sess\.openCodeSessionId \|\| ''/.test(html) && /sess\.openCodeSessionId = result\.sessionId/.test(html)],
 ['OpenCode progress streams back to the chat', /Content-Type': 'text\/event-stream/.test(server) && /type: 'progress'/.test(server) && /OpenCode CLI: starting/.test(html)],
 ['OpenCode prompt size and null-byte validated', /prompt\.length > 100000/.test(server) && /prompt\.includes\('\\0'\)/.test(server)],
 ['OpenCode cancellation kills the child process', /res\.on\('close', \(\) => \{ if \(!done && child\) killTree\(child, true\); \}\)/.test(server)],
 ['Image attachments are not silently dropped in OpenCode mode', /OpenCode CLI mode currently accepts text and file context, not image attachments/.test(html)],
 ['OpenCode own provider and agent are called out in the UI', /provider\/model configured inside OpenCode/.test(html) && /mode selector is paused/.test(html)],
 ['OpenCode actions are recorded in audit log without saving prompt', server.includes('opencode') && /promptLength = b\.prompt\.length/.test(server)],
 ['PWA cache stays versioned so clients refresh', /codespace-pwa-\d+-/.test(fs.readFileSync(__dirname + '/pwa/sw.js', 'utf8'))],
 ['Animated activity starts in ordinary single-agent mode', /else startAssistantActivity\('AI assistant'/.test(html) && /updateTurnActivity\('implementer', 'thinking'/.test(html)],
 ['OpenCode progress updates the same live activity indicator', /startAssistantActivity\('OpenCode CLI'/.test(html) && /updateTurnActivity\('assistant', 'working', progress\)/.test(html)],
 ['Activity completion uses terminal state and scheduled auto-hide', /setMultiAgentActivity\('assistant', activityStatus/.test(html) && /scheduleMultiAgentAutoHide\(active.length\)/.test(html)],
 ['Completed plans remain locked until next user turn', /sess.planCompletedForTurn = plan.length > 0 && plan.every\(x => x.status === 'completed'\)/.test(html) && /sess.planCompletedForTurn = false/.test(html) && /if \(sess.planCompletedForTurn\) return/.test(html)]
 ,
 ['Multi-agent preflight findings are kept out of visible chat history', /run\.multiAgentAdvisoryContext = roles\.map/.test(html) && !/h\.push\(msg\); appendItem\(msg, true\);/.test(html.slice(html.indexOf('async function runMultiAgentPreflight'), html.indexOf('async function runMultiAgentFinalReview')))],
 ['Multi-agent findings are injected as private context, not a visible reply', /PRIVATE SPECIALIST FINDINGS — INTERNAL CONTEXT ONLY; DO NOT QUOTE OR DISPLAY AS A SEPARATE RESPONSE/.test(html)],
 ['QA review is internal and does not append an extra assistant bubble', /QA is an internal quality gate; do not append a second non-user-facing assistant bubble/.test(html)],
 ['Animated multi-agent activity survives history redraw during an active turn', /keepActivityVisible = !!\(activityPanel && maActivityState\.visible && !maActivityState\.dismissed && ctrl && !ctrl\.signal\.aborted\)/.test(html) && /if \(keepActivityVisible && activityPanel\)/.test(html)],
 ['Smart retrieval and memory are no longer appended to visible chat text', /const privateContext = contextParts\.join\('\\n\\n'\);[\s\S]*?runAgent\(userDisplayText, imgs, privateContext\)/.test(html) && /runOpenCodeChat\(userDisplayText, userDisplayText, privateContext\)/.test(html)],
 ['Private workspace context is added only as protected model context', /buildSystem\(\) \+ privateWorkspaceContextNote \+ multiAgentContextNote/.test(html) && /PRIVATE WORKSPACE REFERENCE \(not the user message\)/.test(html) && /Never quote it verbatim; answer the user directly/.test(html) && /Never output retrieval labels, context headers, excerpt markers, file lists, or source snippets/.test(html)],
 ['OpenCode receives only manually attached context, not automatic retrieval dumps', /body: JSON\.stringify\(\{ prompt: text \+ privatePromptContext/.test(html) && /INTERNAL ATTACHMENT REFERENCE/.test(html) && /if \(!S\.openCodeCLI\) \{[\s\S]*?wfMemoryContext\(v\)[\s\S]*?wfSmartContext\(v\)/.test(html) && /h\.push\(\{ role: 'user', content: userDisplayText, images: \[\] \}\)/.test(html)],
 ['Legacy context dumps are trimmed from saved user messages', /function stripLegacyInjectedUserContext\(content\)/.test(html) && /cleanLegacyInjectedUserContext\(sessions\)/.test(html) && /cleanLegacyInjectedUserContext\(list\)/.test(html)],
 ['Verbose smart-retrieval banner removed', !/Smart code retrieval: request-focused excerpts/.test(html) && !/Relevant workspace project memory — supporting context only/.test(html)],
 ['PWA cache stays versioned (duplicate guard for retrieval-dump fix)', /codespace-pwa-\d+-/.test(fs.readFileSync(__dirname + '/pwa/sw.js', 'utf8'))],
 ['Workspace visibility questions skip automatic retrieval', /function wfShouldRetrieveContext\(userRequest\)/.test(html) && /did you see\|can you see\|do you see/.test(html) && /!wfShouldRetrieveContext\(userRequest\)/.test(html)],
 ['AI activity keeps every feed line readable until the run ends', /MA_FEED_MAX_ROWS = 400/.test(html) && /MA_FEED_MAX_CHARS = 4000/.test(html) && /ma-feed-txt\{min-width:0;flex:1;overflow-wrap:break-word;word-break:break-word;white-space:pre-wrap/.test(html) && /ma-activity-detail[^}]*white-space:nowrap/.test(html)],
 ['Activity line paints the real live detail text for every engine', /3\.13\.0: the header keeps a compact status word \+ live detail/.test(html) && /const detail = String\(stage\.detail \|\| ''\)\.trim\(\) \|\| MA_ACTIVITY_LABELS\[stage\.status\] \|\| 'Working'/.test(html) && /\$\('maActivityDetail'\)\.textContent = detail/.test(html) && /\$\('maActivityPanel'\)\.title = detail/.test(html)],
 ['Detail text is maintained for agent, multi-agent and OpenCode stages', /setMultiAgentActivity\(agent\.id, 'thinking', agent\.id === 'planner'/.test(html) && /updateTurnActivity\('implementer', 'working', 'Working · '/.test(html) && /updateTurnActivity\('assistant', 'working', live\)/.test(html)],
 ['In-stream provider overload retries even after partial output', /retrying after a partial stream is safe/.test(html) && /if \(!allowRetries \|\| !transient \|\| !e\.inStream \|\| attempt >= 4 \|\| \(signal && signal\.aborted\)\) throw e;/.test(html) && !/let started = false/.test(html)],
 ['Mid-stream connection drops are tagged retryable instead of killing the turn', /A mid-stream connection drop \(reader failure\) is retryable/.test(html) && /if \(e && e\.name !== 'AbortError'\) e\.inStream = true;/.test(html)],
 ['Provider retries are surfaced in the live activity feed', /Provider busy · retrying \(try ' \+ \(attempt \+ 1\) \+ ' of 4\)/.test(html) && /try \{ await sleepAbortable\(wait, signal\); \} finally \{ feedEnd\(row, 'skip'\); \}/.test(html)],
 ['Multi-agent preflight staggers specialist launches to avoid overload bursts', /if \(i > 0\) await sleepAbortable\(350 \* i, signal\);/.test(html) && /soften the simultaneous burst/.test(html)],
 ['Identical-tool-call loop stop auto-resumes instead of killing the turn', /AUTO_RESUME_MAX = 2/.test(html) && /autoResumes\+\+; stuck = false; repeatCounts\.clear\(\);/.test(html) && /AUTO_RESUME_REPEAT_PROMPT/.test(html) && /h\.push\(\{ role: 'user', content: AUTO_RESUME_REPEAT_PROMPT, agentMeta: \{ type: 'auto-resume' \} \}\);/.test(html)],
 ['Empty or final-answer-less replies auto-resume instead of stopping the turn', /content: AUTO_RESUME_EMPTY_PROMPT, agentMeta: \{ type: 'auto-resume' \} \}\);/.test(html) && /the model ended without a visible final answer\./.test(html) && /the model returned an empty reply\./.test(html)],
 ['Auto-resume is bounded and respects user Stop', (html.match(/autoResumes < AUTO_RESUME_MAX && !ctrl\.signal\.aborted/g) || []).length === 3],
 ['Auto-resume turns are announced in the chat and kept out of later context', /Auto-resume ' \+ autoResumes \+ ' of ' \+ AUTO_RESUME_MAX/.test(html) && /\['preflight', 'qa-review', 'auto-resume'\]/.test(html)],
 ['Splash keeps CodeSpace branding and setup message while omitting the old editor welcome', /class="cs-splash-wordmark">CodeSpace<\/h1>/.test(html) && /Setup Your Workspace\.\.\.\./.test(html) && /Developer: Rabiul Islam/.test(html) && !/id="welcome"/.test(html)],
 ['Late session hydration does not rebuild the chat during an active turn', /wiping transient notes \(e\.g\. "Auto-resume 1 of 2"\) mid-run/.test(html) && /if \(ctrl\) \{ renderSessions\(\); updateMeters\(\); \}/.test(html)],
 ['Generic workspace question does not append project excerpts to user prompt', /const smartContext = await wfSmartContext\(v\)/.test(html) && /const userDisplayText = visibleParts\.filter\(Boolean\)\.join/.test(html) && /const privateContext = contextParts\.join/.test(html)],
 ['Assistant and OpenCode replies strip automatic context-dump headers', /function stripInternalContextDump\(content, userPrompt = ''\)/.test(html) && /reply\.text = stripInternalContextDump\(reply\.text, text\)/.test(html) && /stripInternalContextDump\(String\(result\.text\)\.trim\(\), userDisplayText\)/.test(html)],
 ['Workspace visibility questions receive a concise one-word fallback', /function isWorkspaceVisibilityQuestion\(prompt\)/.test(html) && /return B\.ok && B\.info && B\.info\.root \? 'Yes\.' : 'No\.'/.test(html)],
 ['Live response does not stream reasoning or raw context into a second card', /function liveBegin\(\) \{[\s\S]*?The unified activity line is the only live indicator[\s\S]*?update\(a\) \{ last = a; \}/.test(html) && !/const blk = document\.createElement\('details'\); blk\.className = 'thinkblk live'/.test(html)],
 ['Cancelled partial output is sanitized before being shown', /stripInternalContextDump\(splitThink\(snap\.text\)\.text, text\)/.test(html)],
 ['Private reasoning is not rendered as a persistent chat block', /Never render raw model reasoning as a persistent chat block/.test(html) && !/addThinkBlock\(turn, think, label\)/.test(html) && !/addThinkRow\(box, think, label\)/.test(html)],
 ['Active turn auto-follow pins new assistant/tool updates to the latest visible area', /let chatAutoFollowActiveTurn = false/.test(html) && /chatAutoFollowActiveTurn \|\| chatIsNearBottom\(\)/.test(html) && /if \(followChat\) pinChatToLatest\(true\)/.test(html)],
 ['Chat reserves modest space below latest reply so it sits above the bottom edge', html.includes('padding:14px 14px clamp(110px,18vh,220px);scroll-padding-bottom:clamp(110px,18vh,220px)')],
 ['User can manually scroll up without auto-follow fighting navigation', /if \(e\.deltaY < -4\) chatAutoFollowActiveTurn = false/.test(html) && /if \(dy > 18\) chatAutoFollowActiveTurn = false/.test(html)],
 ['Auto-follow lifecycle starts and finishes for both agent and OpenCode turns', /chatAutoFollowActiveTurn = true;[\s\S]*?h\.push\(\{ role: 'user', content: text/.test(html) && /finishChatAutoFollow\(\); collapseSteps\(\)/.test(html) && /finishChatAutoFollow\(\); finishTurn\(\)/.test(html)],
 ['Activity begins synchronously before asynchronous context retrieval', /sendPreparing = true;[\s\S]*?startAssistantActivity\(S\.openCodeCLI \? 'OpenCode CLI' : 'AI assistant',[\s\S]*?placeActivityBeforeTranscript\(\);[\s\S]*?await wfMemoryContext\(v\)/.test(html)],
 ['Fast replies keep the spinner active long enough to be seen', /MA_ACTIVITY_MIN_SPINNER_MS = 650/.test(html) && /if \(elapsed < MA_ACTIVITY_MIN_SPINNER_MS\)/.test(html) && /setTimeout\(\(\) => \{[\s\S]*?generation === maActivityGeneration/.test(html)],
 ['Activity preparation disables duplicate sends and releases the send lock', /if \([^\n]*\|\| sendPreparing\) return/.test(html) && /sendPreparing = false; \$\('sendBtn'\)\.disabled = false/.test(html)],
 ['Live process feed container sits under the spinner inside the activity panel', /<div id="maActivityFeed" class="ma-feed"/.test(html)],
 ['Feed shows tool calls and thinking rounds, stays readable after the run finishes', /feedPush\(toolFeedLabel\(c\)/.test(html) && /const fr = feedRound\(step\)/.test(html) && /panel\.classList\.toggle\('is-done', runFinished\)/.test(html) && /#maActivityPanel\.is-done \.ma-feed\{border-left-color:var\(--line\)\}/.test(html) && /}, 8000\)/.test(html)],
 ['Feed is cleared at the start of every run and uses textContent only', /beginActivityCycle\(\); feedClear\(\);/.test(html) && !/maActivityFeed[^\n]*innerHTML/.test(html) && !/ma-feed-txt[^\n]*innerHTML/.test(html)],
 ['PWA cache stays versioned so clients refresh (activity indicator)', /codespace-pwa-\d+-/.test(fs.readFileSync(__dirname + '/pwa/sw.js', 'utf8'))],
 ['Stale code index is searched without a blocking rebuild', /if \(!CODE_INDEX\.builtAt \|\| CODE_INDEX\.root !== realRoot\) buildCodeIndex\(\);/.test(server) && !/CODE_INDEX\.stale\) buildCodeIndex\(\)/.test(server)],
 ['Checkpoint creation no longer blocks the bridge event loop', /async function cpCreate\(b = \{\}\) \{/.test(server) && /await cpCreate\(b\)\)/.test(server) && /setImmediate\(r\)/.test(server)],
 ['Per-write refresh storm is coalesced', /function scheduleWriteRefresh\(\)/.test(html) && /scheduleWriteRefresh\(\);/.test(html)],
 ['read_file results are reused for the editor tab instead of re-read', /content: \/\^\(\\\[lines \|Unchanged since \)\//.test(html)],
 ['Multi-agent advisory and reviewer calls are output-capped', /\{ maxTokens: 1100 \}/.test(html) && /\{ maxTokens: 800 \}/.test(html)],
 ['HTML page and PWA use CodeSpace branding', /<title>CodeSpace<\/title>/.test(html) && /"name": "CodeSpace"/.test(fs.readFileSync(__dirname + '/pwa/manifest.webmanifest', 'utf8'))],
 ['Startup splash shows workspace setup message and dismisses automatically without a second welcome screen', /id="codespaceSplash"/.test(html) && /Setup Your Workspace\.\.\.\./.test(html) && !/id="welcome"/.test(html) && /setTimeout\(closeCodeSpaceSplash, 3600\)/.test(html)],
 ['Desktop app defaults to native Integrated Chromium with persistent session', /let browserRenderMode = DESKTOP_EMBED \? 'embedded' : 'proxy'/.test(html) && /<option value="embedded">Integrated Browser · Chromium<\/option>/.test(html) && /persist:codespace-browser/.test(fs.readFileSync(__dirname + '/desktop/main.cjs', 'utf8'))],
 ['Electron enables main-owned WebContentsView behind a secure preload proxy', /new WebContentsView\(/.test(fs.readFileSync(__dirname + '/desktop/main.cjs', 'utf8')) && /isDesktop: true/.test(fs.readFileSync(__dirname + '/desktop/preload.cjs', 'utf8')) && /navigateEmbedded/.test(html)],
 ['Old settings migrate to visible browser and persistent cookies', /if \(\(o\.v \|\| 0\) < 6\) \{ o\.browserVisible = true; o\.browserPersist = true; o\.v = 6; \}/.test(html)],
 ['Cloudflare challenge is surfaced for user completion rather than bypassed', /Security verification required\. Complete it manually in the CodeSpace Browser panel/.test(html) && /does not bypass Cloudflare or CAPTCHA checks/.test(html)],
 ['CodeSpace PWA icons are present', ['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png'].every(n => fs.existsSync(__dirname + '/pwa/icons/' + n))],
 ['Portable builds can keep settings, browser profile and skills in the app data directory', /const DATA = path\.resolve\(process\.env\.MY_AGENT_DATA_DIR \|\| path\.join\(os\.homedir\(\), '\.my-agent'\)\)/.test(server) && /const WORKSPACE_FILE = path\.join\(DATA, 'workspace\.json'\)/.test(server)],
 
 ['Browser launch does not disable extensions or background networking', !/--disable-extensions|--disable-background-networking/.test(server)],
 ['Browser launch does not spoof user-agent or timezone', !/Emulation\.setUserAgentOverride|Emulation\.setTimezoneOverride/.test(server)],
 ['Browser profile persists when enabled', /path\.join\(DATA, 'browser-profile'\)/.test(server)],
 ['Desktop removes legacy iframe and Agent Chrome modes', /filter\(o => o\.value !== 'embedded' && o\.value !== 'proxy'\)/.test(html)],
 ['Desktop browser_open uses embedded webview rather than legacy CDP API', (() => { const block=html.slice(html.indexOf("if (call.name.startsWith('browser_'))"), html.indexOf('function runJs(code)')); return /if \(DESKTOP_EMBED\)[\s\S]*?navigateEmbedded\(url, true\)/.test(block) && !/bcall\('\/browser\/open'/.test(block.slice(0, block.indexOf('    setAgentChromeMode();'))); })()],
 ['Desktop agent browser read/click/type/scroll/JS operate on embedded webview', (() => { const block=html.slice(html.indexOf("if (call.name.startsWith('browser_'))"), html.indexOf('function runJs(code)')); return ['embeddedReadPage','embeddedClickElement','embeddedTypeInto','embeddedScrollPage','embeddedRunPageJS'].every(name=>block.includes(name)); })()],
 ['Desktop external Chrome launcher is blocked by backend environment guard', /MY_AGENT_DISABLE_EXTERNAL_BROWSER === '1'[\s\S]*?External Chrome process is disabled in CodeSpace Desktop/.test(server)],
 ['Electron backend starts with external browser disabled', /MY_AGENT_DISABLE_EXTERNAL_BROWSER: '1'/.test(fs.readFileSync(__dirname + '/desktop/main.cjs', 'utf8'))],
 ['Desktop website links and OAuth redirects remain inside the native browser', (() => { const main=fs.readFileSync(__dirname + '/desktop/main.cjs', 'utf8'); return /new WebContentsView/.test(main) && /browser-nav/.test(main) && /guest\.on\('will-redirect'/.test(main) && !/handoffGoogleSignIn/.test(main); })()],
];
// Exercise the small privacy helpers, not just source-string presence.
try {
  const vm = require('vm');
  const a = html.indexOf('function stripLegacyInjectedUserContext');
  const b = html.indexOf('const cur =', a);
  const context = { B: { ok: true, info: { root: 'C:/workspace' } } };
  vm.createContext(context);
  vm.runInContext(html.slice(a, b), context);
  const dump = '[Smart code retrieval: internal]\n[Relevant project context: app.html]\nEXCERPT';
  checks.push(['Context dump sanitizer drops dump-only answers at runtime', context.stripInternalContextDump(dump, 'did you see my workspace') === '']);
  checks.push(['Context dump sanitizer preserves concise answer before a dump', context.stripInternalContextDump('Yes, I can see it.\n' + dump, 'did you see my workspace') === 'Yes, I can see it.']);
  checks.push(['Context dump sanitizer preserves explicitly requested excerpts', context.stripInternalContextDump(dump, 'show the project excerpts') === dump]);
  checks.push(['Workspace visibility helper returns short grounded answer', context.isWorkspaceVisibilityQuestion('did you see my workspace') && context.workspaceVisibilityAnswer() === 'Yes.']);
} catch (e) { checks.push(['Runtime privacy-helper tests initialize', false]); console.error(e); }
// 3.12.2: every engine must ask the model for a structured work report, not a one-line answer.
try {
  const vm = require('vm');
  checks.push(['Work-report rules constant lists the required report sections', /const REPORT_NOTE = /.test(html) && ['What I found', 'What I changed', 'What I verified', 'What to improve', 'Suggested next steps'].every(s => html.includes(s))]);
  checks.push(['buildSystem appends work-report rules in every mode', /let s = \(S\.sys \|\| ''\) \+ REPORT_NOTE;/.test(html)]);
  checks.push(['Agent note routes the final answer through the work-report rules', html.includes('For the final answer, follow the WORK REPORT RULES above') && !html.includes('Keep the final answer concise')]);
  checks.push(['OpenCode prompts carry the matching reporting requirement', /const OC_REPORT_NOTE = /.test(server) && /args\.push\(prompt \+ OC_REPORT_NOTE\)/.test(server) && ['What I found', 'What I changed', 'What I verified', 'What to improve', 'Suggested next steps'].every(s => server.includes(s))]);
  // Runtime: buildSystem must include the report rules with tools off and on.
  const a = html.indexOf('const AGENT_NOTE = '), b = html.indexOf('const BOT_NOTE', a);
  const ctx = { S: { sys: 'Base persona.', agentOn: false }, B: { ok: false } };
  vm.createContext(ctx); vm.runInContext(html.slice(a, b) + '\nglobalThis.ask = buildSystem(); S.agentOn = true; globalThis.agent = buildSystem();', ctx);
  checks.push(['Ask-mode system prompt includes work-report rules', ctx.ask.includes('WORK REPORT RULES')]);
  checks.push(['Agent-mode system prompt keeps report rules and agent rules', ctx.agent.includes('WORK REPORT RULES') && ctx.agent.includes('careful coding agent with tools')]);
} catch (e) { checks.push(['Work-report rule tests initialize', false]); console.error(e); }
// 3.12.3: live-details parity for every model + safe speedups.
try {
  checks.push(['Live feed shows the writing tail for all models', /feedSet\(writeId, 'Writing response · ' \+ \(tail\.length > 1500 \? '…' \+ tail\.slice\(-1480\) : tail\)\)/.test(html)]);
  checks.push(['Live feed has an elapsed-time heartbeat when the model is silent', /Still (thinking|writing your answer)/.test(html) && /clearInterval\(beat\)/.test(html)]);
  checks.push(['Multi-agent specialists run on a child abort signal', /const childSignal = signal =>/.test(html) && /ac\.signal, sess, agent\.id/.test(html)]);
  checks.push(['Slow specialists hit a soft 90 s deadline, not a stalled turn', /SPECIALIST_TIMEOUT_MS = 90000/.test(html) && /did not finish in 90 s/.test(html)]);
  checks.push(['QA review also has a soft deadline and survives it as a warning', /Independent QA review did not finish in 90 s/.test(html) && /the 90 s review deadline is a soft failure/.test(html)]);
  checks.push(['OpenCode pre-run version check is cached briefly', /let ocRunCheck = \{ ok: false, until: 0 \}/.test(server) && /ocRunCheck = \{ ok: true, until: Date\.now\(\) \+ 5 \* 60000 \}/.test(server) && /if \(exitCode === -1\) ocRunCheck = \{ ok: false, until: 0 \}/.test(server)]);
  checks.push(['Provider retries and read-only batching are still in place', /retry-after/.test(html) && /READONLY\.has\(calls\[ci\]\.name\)/.test(html)]);
} catch (e) { checks.push(['Speed/live-parity tests initialize', false]); console.error(e); }
// 3.12.4: QA-review soft-failure regression fix — the review catch must never crash on its own scope.
async function verifyQaReviewSoftFailure() {
  try {
    const vm = require('vm');
    const frA = html.indexOf('async function runMultiAgentFinalReview');
    const frB = html.indexOf('agent loop', frA);
    const fr = frA >= 0 && frB > frA ? html.slice(frA, frB).replace(/\/\*[\s\S]*$/, '') : '';
    const tryAt = fr.indexOf('\n  try {'), acAt = fr.indexOf('const ac = childSignal(signal);'), dlAt = fr.indexOf('const deadline = setTimeout(');
    checks.push(['QA review deadline + abort signal are declared outside the try block', tryAt >= 0 && acAt >= 0 && dlAt >= 0 && acAt < tryAt && dlAt < tryAt]);
    // 3.12.5: childSignal must be declared once, at module scope, BEFORE runMultiAgentPreflight
    // (it used to be a local const inside preflight, so the QA review crashed with
    // "childSignal is not defined" before its try/catch and escaped into the agent loop).
    const csA = html.indexOf('const childSignal = signal =>');
    const csB = csA >= 0 ? html.indexOf('};', csA) : -1;
    const csSrc = csA >= 0 && csB > csA ? html.slice(csA, csB + 2) : '';
    checks.push(['QA review abort helper is declared once at module scope, shared with preflight', csA >= 0 && (html.match(/const childSignal = signal =>/g) || []).length === 1 && csA < html.indexOf('async function runMultiAgentPreflight')]);
    // Runtime: a failing QA review must be a soft failure ("Review unavailable"), not a ReferenceError.
    // NOTE: childSignal is NOT stubbed here on purpose — the page's real definition is prepended,
    // so a scope regression fails this test instead of being masked by a mock.
    const rctx = {
      setTimeout, clearTimeout, AbortController,
      setMultiAgentActivity: () => {}, setBusy: () => {},
      multiAgentProvider: () => ({ name: 'TestProvider', model: 'test-model' }),
      callModel: async () => { throw new Error('provider down'); },
      recordUsageCost: () => {}, P: () => ({ name: 'TestProvider' })
    };
    vm.createContext(rctx);
    vm.runInContext(csSrc + '\n' + fr + '\nglobalThis.__review = runMultiAgentFinalReview;', rctx);
    const runner = vm.runInContext(`(async (run, signal) => { await __review(null, [], 0, signal, {}, run); return run; })`, rctx);
    const run = await runner({ agentStages: [], reviewSummary: '', internalWarnings: [] }, new AbortController().signal);
    checks.push(['Failing QA review degrades softly to "Review unavailable"', run.reviewSummary.startsWith('Review unavailable: provider down')]);
    checks.push(['Failing QA review records the failed stage and an internal warning', run.agentStages.some(s => s.name === 'Independent QA Reviewer' && s.status === 'failed') && run.internalWarnings.length === 1]);
    // Runtime: user Stop during the review must still rethrow as cancellation.
    const rctx2 = { ...rctx, callModel: async () => { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; } };
    vm.createContext(rctx2);
    vm.runInContext(csSrc + '\n' + fr + '\nglobalThis.__review2 = runMultiAgentFinalReview;', rctx2);
    const runner2 = vm.runInContext(`(async (run, ac) => { try { await __review2(null, [], 0, ac.signal, {}, run); return 'no-throw'; } catch (e) { return e.name; } })`, rctx2);
    const ac2 = new AbortController(); ac2.abort();
    const outcome = await runner2({ agentStages: [], reviewSummary: '', internalWarnings: [] }, ac2);
    checks.push(['User Stop during the QA review still cancels the turn', outcome === 'AbortError']);
  } catch (e) { checks.push(['QA-review soft-failure regression tests initialize', false]); console.error(e); }
}
(async () => {
  await verifyQaReviewSoftFailure();
  // 3.12.7: "if ai stopped i send continue it likely not get previous work chat properly".
  // A stopped turn (Stop, provider error, tool/repeat limit, empty final) must hand its work
  // state to the next turn instead of leaving the model a bare "continue" on trimmed history.
  try {
    const vm = require('vm');
    checks.push(['A stopped turn records its stop reason for the next turn', /sess\.lastRunReport = reportText;\s*\n\s*sess\.lastRunStop = run\.stopReason;/.test(html)]);
    checks.push(['Next turn after a stopped turn builds a private continuation note', /function buildContinuationNote\(sess, h\)/.test(html) && /CONTINUATION CONTEXT \(internal system note/.test(html) && /do NOT restart the task from scratch/.test(html)]);
    checks.push(['Continuation note reaches the model system context for every built-in engine', /buildSystem\(\) \+ privateWorkspaceContextNote \+ multiAgentContextNote \+ continuationNote/.test(html)]);
    checks.push(['OpenCode continue prompts carry the same continuation context', /prompt: text \+ privatePromptContext \+ continuationNote/.test(html)]);
    checks.push(['OpenCode turn end also records the stop reason', /sess\.lastRunStop = ctrl && ctrl\.signal\.aborted \? 'cancelled' : \(openCodeSuccess \? 'completed' : 'error'\);/.test(html)]);
    checks.push(['Continuation note is computed before the new user message is pushed', html.indexOf('buildContinuationNote(sess, h)') < html.indexOf("h.push({ role: 'user', content: text, images: (images || []).slice(0, 4) })")]);
    // Runtime: exercise the helper exactly as the page would call it.
    const cnA = html.indexOf('function buildContinuationNote');
    const cnB = html.indexOf('/* ================= live multi-agent activity UI', cnA);
    const cnSrc = cnA >= 0 && cnB > cnA ? html.slice(cnA, cnB) : '';
    checks.push(['Continuation helper is cleanly extractable for runtime testing', cnSrc.includes('CONTINUATION CONTEXT') && cnSrc.trim().endsWith('}')]);
    const cctx = { stripThink: s => String(s || '') };
    vm.createContext(cctx);
    vm.runInContext(cnSrc + '\nglobalThis.buildContinuationNote = buildContinuationNote;', cctx);
    const hist = [
      { role: 'user', content: 'Fix the login bug' },
      { role: 'assistant', content: 'Working on it', toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'src/login.js' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'edit_file', content: 'Edited src/login.js' }
    ];
    const done = { lastRunStop: 'completed', lastRunReport: 'Run report: Agent returned a final response.' };
    checks.push(['A completed previous turn injects no continuation note', cctx.buildContinuationNote(done, hist) === '']);
    const stopped = { lastRunStop: 'cancelled', lastRunReport: 'Run report: Cancelled by the user.\nFiles changed: src/login.js' };
    const note = cctx.buildContinuationNote(stopped, hist);
    checks.push(['A stopped previous turn yields a private continuation note', note.includes('CONTINUATION CONTEXT') && note.includes('Cancelled by the user') && note.includes('src/login.js')]);
    checks.push(['Continuation note includes the most recent work items', note.includes('Last assistant message: Working on it') && note.includes('Tool result [edit_file]: Edited src/login.js')]);
    checks.push(['Continuation note instructs to resume, not restart, and to answer unrelated asks normally', note.includes('do NOT restart the task from scratch') && note.includes('clear final answer') && note.includes('different request')]);
    checks.push(['Continuation note is injected exactly once, then cleared', stopped.lastRunStop === '' && cctx.buildContinuationNote(stopped, hist) === '']);
    const errored = { lastRunStop: 'error', lastRunReport: '' };
    const note2 = cctx.buildContinuationNote(errored, hist);
    checks.push(['An errored turn without a report still yields a usable note', note2.includes('stopped by an error') && note2.includes('No run report was recorded.')]);
  } catch (e) { checks.push(['Continuation-note tests initialize', false]); console.error(e); }
  // 3.12.7: Stop pressed mid-stream must be detected even when the aborted reader resolves
  // cleanly (done=true) instead of rejecting with AbortError — otherwise the partial answer
  // was recorded as a COMPLETED turn and the next "continue" lost the unfinished-work state.
  try {
    const rsA = html.indexOf('async function readSSE(res, onData, signal)');
    const rsB = html.indexOf('const imageKeep = ', rsA);
    const rsSrc = rsA >= 0 && rsB > rsA ? html.slice(rsA, rsB) : '';
    checks.push(['readSSE receives and watches the abort signal', rsA >= 0 && /if \(signal && signal\.aborted\) \{ const e = new DOMException\('Aborted', 'AbortError'\); throw e; \}/.test(rsSrc)]);
    const openA = html.indexOf('async function callOpenAI('), openB = html.indexOf('async function callAnthropic(', openA);
    const anthA = openB, anthB = html.indexOf('const TRANSIENT_RE =', anthA);
    const openSrc = openA >= 0 && openB > openA ? html.slice(openA, openB) : '';
    const anthSrc = anthA >= 0 && anthB > anthA ? html.slice(anthA, anthB) : '';
    const openPass = /readSSE\(res,[\s\S]*?\}, signal\);/.test(openSrc);
    const anthPass = /readSSE\(res,[\s\S]*?\}, signal\);/.test(anthSrc);
    checks.push(['Both model engines pass the signal to readSSE', openPass && anthPass]);
    checks.push(['OpenCode stream end also re-checks the abort signal', /if \(buf\.trim\(\)\) eventPacket\(buf\);\s*\n[^\n]*3\.12\.7[^\n]*\n[^\n]*\n[^\n]*\n\s*if \(ctrl\.signal\.aborted\) throw new DOMException\('Aborted', 'AbortError'\);/.test(html)]);
    // Runtime: a clean stream end while the signal is aborted must throw AbortError.
    const vm2 = require('vm');
    const rctx = { TextDecoder, DOMException };
    vm2.createContext(rctx);
    vm2.runInContext(rsSrc + '\nglobalThis.readSSE = readSSE;', rctx);
    const stream = (chunks) => new ReadableStream({
      start(c) { let i = 0; const t = setInterval(() => { if (i >= chunks.length) { clearInterval(t); c.close(); return; } c.enqueue(new TextEncoder().encode(chunks[i++])); }, 30); }
    });
    const run1 = rctx.readSSE({ body: stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']) }, () => {}, null); // no signal: clean end resolves
    await run1;
    checks.push(['Without a signal a clean stream end still resolves (no behavior change)', true]);
    const ac3 = new AbortController();
    const run2 = rctx.readSSE({ body: stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" more"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" text"}}]}\n\n', 'data: {"choices":[{"delta":{"content":" here"}}]}\n\n']) }, () => {}, ac3.signal);
    setTimeout(() => ac3.abort(), 60); // abort mid-stream; the reader will end cleanly
    let outcome3 = 'resolved';
    await run2.then(() => {}, e => { outcome3 = e.name; });
    checks.push(['Abort during a cleanly-ending stream is surfaced as AbortError', outcome3 === 'AbortError']);
  } catch (e) { checks.push(['Stop-mid-stream tests initialize', false]); console.error(e); }
  let failed=0; for(const [n,ok] of checks){console.log((ok?'PASS ':'FAIL ')+n);if(!ok)failed++;} if(failed)process.exit(1);
  console.log(`\n${checks.length}/${checks.length} checks passed.`);
})();
