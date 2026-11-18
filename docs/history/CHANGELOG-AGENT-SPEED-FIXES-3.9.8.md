# CodeSpace 3.9.8 — Agent & multi-agent speed: root-cause fixes

Deep investigation of the full execution path (browser agent loop → model adapters →
bridge HTTP layer → agent-server tool implementations) found six performance bugs.
All are fixed in this release.

## Bugs found and fixed

### 1. (Major, server) Code index rebuilt synchronously after every edit
Every `fsWrite` marks the local code index stale, and the next index tool call
(`code_search`, `find_symbol`, `symbol_references`, `related_files`, `project_map`)
used to trigger a **full synchronous rebuild** (up to 2500 files / 50 MB parsed and
tokenized) inside the bridge request handler. That froze *every* other bridge request —
parallel file reads, `git status`, terminal output — for seconds, repeatedly, mid-turn.
**Fix:** the index is built once per workspace; a stale index is searched as-is and the
result explicitly tells the model it is stale and to call `codebase_index_rebuild`.
Tool description, result text and the AGENT_NOTE speed rules were updated so the model
rebuilds deliberately instead of the app blocking under it.

### 2. (Major, server) Auto-checkpoint scan froze the bridge before the first edit
`/checkpoints/create` walked the whole workspace and SHA-256-hashed up to 5000 files /
200 MB **synchronously** on the bridge's main thread before the first AI edit or command
of each turn. **Fix:** the scan and copy loops are now async (`fs.promises`) and yield to
the event loop every 16 files, so checkpointing no longer blocks file reads, git status
or streaming while it runs. `cpCompare`/`cpRestore`/`fsSearch` converted the same way.

### 3. (Medium, browser) Refresh storm after every write/edit/command
Each write/edit fired `refreshExplorer()` + `reloadPreview()` + `gitRefresh()`
immediately, and each command also re-read **all** open editor tabs. A 10-edit turn
meant 10 explorer re-lists, 10 git status spawns, 10 preview reloads and 10 full tab
re-reads between tool rounds. **Fix:** `scheduleWriteRefresh()` /
`scheduleCommandRefresh()` coalesce each burst into one refresh set (500 ms debounce);
the edited file's tab still opens immediately.

### 4. (Medium, browser) Every agent `read_file` triggered a second bridge read
After each agent read, `openFile()` re-fetched the same file over the bridge to show it
in an editor tab. **Fix:** `openFile` accepts `opt.content`; untruncated `read_file`
results are reused directly (truncated/unchanged markers fall back to a disk read), so
agent exploration no longer doubles the file I/O.

### 5. (Medium, multi-agent) Advisory agents ran without output limits
The planner, architect and test-strategist calls (and the independent QA reviewer) used
the full default generation limits, so long-winded models stretched the preflight and
the post-run review. **Fix:** `callModel` accepts `{ maxTokens }`; advisory calls are
capped at 1100 tokens and the QA review at 800 (both well above their required output).
On Anthropic providers, advisory calls also skip extended thinking. A 400 fallback
removes `max_tokens` for the rare OpenAI-compatible server that rejects the parameter.

### 6. (Hygiene, tests) Stale verify assertions
`verify.cjs` still pinned the PWA cache string to a 3.8-era version and required the
"Refresh package" button that 3.9.7 removed by design. Updated to assert current
behavior (versioned cache present; minimal installed card with Uninstall only).

## What was checked and deliberately left alone
- Multi-agent preflight already runs its three advisors in parallel (`Promise.allSettled`).
- Read-only tool batching in the agent loop already executes concurrently; consecutive
  read-only calls in one model reply share one parallel batch.
- `maybeCompress` context summarization and the QA review are extra model calls by design;
  with the caps they add minimal latency.
- Provider retry/backoff behavior (1500 ms doubling, transient-status retries) is intact.

## Files
- `agent-server.js` — async checkpoint/search, non-rebuilding stale index search, awaited routes.
- `my-chat-agent-v3.html` — afterTool coalescing, openFile content reuse, callModel
  `{ maxTokens }` support, advisory/reviewer caps, code_search staleness text,
  code_search tool description, AGENT_NOTE speed rule.
- `verify.cjs` — 6 new regression checks + stale assertions modernized.
- `package.json` — 3.9.8; `pwa/sw.js` — cache `codespace-pwa-18-agent-speed-fixes`.

## Verification
- `node --check agent-server.js`; inline script passes `node --check`.
- `scripts/test_agent_perf.js`: refresh storm coalesced (4→2 / 3→1 / 4→2 refresh sets),
  openFile content reuse with disk fallback, server guarantees (async routes awaited,
  yielding checkpoint scan, stale search without rebuild, caps present).
- `node verify.cjs` — 114/114 checks passed; server-hardening 27; providers 25;
  bridge 89/89; desktop 25/25.
