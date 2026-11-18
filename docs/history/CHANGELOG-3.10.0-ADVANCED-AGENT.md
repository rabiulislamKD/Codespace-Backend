# CodeSpace 3.10.0 — Advanced AI Agent Upgrade

Release date: 2026-11-02 · Base: 3.9.8 · Files changed: `my-chat-agent-v3.html`, `agent-server.js`, `package.json`, `pwa/sw.js` · New: `verify-3.10.0.cjs`

Every tool listed below has a real backend implementation, a JSON schema, permission checks, error handling and a passing verification test. Nothing is a UI stub.

---

## 1. New tools (30)

### Web research (public internet; private/loopback/metadata hosts are blocked, DNS is checked for rebinding)
| Tool | Endpoint | What it does |
|---|---|---|
| `web_search` | `/web/search` | DuckDuckGo search, pagination via `page`, provider configurable (`config.searchProvider`) |
| `web_open` | `/web/fetch` | Fetch a page's raw content (aliases: `web_fetch`) |
| `web_extract` | `/web/extract` | Title/description/main-text/link extraction (article heuristic) |
| `web_find` | `/web/find` | Locate query/regex lines in a page with line numbers |
| `web_crawl` | `/web/crawl` | Same-host BFS crawl (≤10 pages, depth ≤3, robots.txt respected, per-run 90 s cap) |
| `web_screenshot` | `/web/screenshot` | Open + screenshot via the existing browser infrastructure |

### HTTP / API
| Tool | Endpoint | Notes |
|---|---|---|
| `http_request` | `/http/request` | GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, headers/query/JSON/form, redirects, timeouts (2–120 s), 2 MB response cap, status+headers+body+duration+parsed JSON. Plain http only for localhost dev servers |
| `api_test` | `/http/request` | Same call + `expect:{status,ok,contains,not_contains,json_path,equals,max_ms,header}` → pass/fail verdict |
| `api_collection` | `/http/collection` | Persisted named requests (list/save/run/delete); secrets stored 0600, never listed |
| `inspect_response` | `/http/inspect` | Inspect the last 10 responses: headers, timing, dot-path lookup, text search |

### Developer intelligence (never installs anything; missing toolchains are reported as skipped)
| Tool | Endpoint | Notes |
|---|---|---|
| `run_tests` | `/dev/tests` | Discovers npm/pytest/go/cargo/composer test commands; runs one; parses pass/fail (jest, vitest, pytest, go, cargo); dangerous/install commands refused |
| `get_diagnostics` | `/dev/diagnostics` | tsc `--noEmit`, eslint, ruff when installed; file:line:col diagnostics, cap 200 |
| `lint_project` | `/dev/lint` | eslint / ruff / `php -l` |
| `format_code` | `/dev/format` | prettier / black; auto-checkpoint before rewriting |
| `dependency_analysis` | `/dev/deps` | Manifests + optional read-only `npm audit --json` |
| `find_unused_code` | `/dev/unused` | Index-driven heuristic for exported symbols with no external references |
| `inspect_package` | `/ext/package/inspect` | Reuses the existing registry inspector (no duplicate) |
| `project_health_check` | `/dev/health` | git, index, toolchain, tests, manifests, permissions → score + issues |

### File & code operations
| Tool | Endpoint | Notes |
|---|---|---|
| `multi_edit` | `/fs/editbatch` | Up to 50 coordinated edits; ALL matches pre-validated (atomic: any failure writes nothing); auto-checkpoint |
| `rename_symbol` | `/index/rename` | Index-driven word-boundary rename with checkpoint and per-file counts |
| `undo_file` / `redo_file` / `file_history` | `/fs/undo` `/fs/redo` `/fs/history` | Per-file ring of the last 10 versions, captured automatically before every write |

### Browser additions (existing CDP driver, no duplicate implementation)
`browser_hover`, `browser_select`, `browser_upload` (DOM.setFileInputFiles from workspace files), `browser_download` (setDownloadBehavior + 60 s wait), `browser_press_key` (Space + ctrl/alt/shift/meta modifiers; alias `browser_key`), `browser_wait` (selector/text, ≤30 s), `browser_dom_snapshot`, `browser_accessibility_tree` (Accessibility.getFullAXTree). Agent-Chrome mode only; the embedded Desktop webview returns a clear routing hint.

### Background tasks
`task_create` (kinds: command, tests, index_rebuild, web_crawl, diagnostics; dedupe keys), `task_list`, `task_cancel` (kills the process), `task_retry` (≤3 attempts). Tasks persist in `~/.my-agent/tasks/`, interrupted tasks are marked after restart and retryable. The compact task bar (with animated pulse, cancel/retry buttons) sits under the latest message and polls every 4 s; completions surface in the live activity feed.

## 2. Improved tools
- `run_command` — now also gated by the **server-side** terminal permission; `approved:true` is sent after the normal dialog.
- `edit_file`/`write_file` — every write now snapshots the previous version for per-file undo (server-side).
- `browser_key` — Space + modifier combos.
- `browser_tabs` — real CDP multi-tab (list/new/select/close) in Agent Chrome mode; the old extension-bridge `tabs` behaviour is untouched.
- `toolDefs()` — new groups (`web`, `dev`) with smart-gating + exact-tool group detection; delegate tool only in multi-agent mode.
- `workflowDiagnostics` — **fixed double-escaped regex bug** that made error-line extraction silently never match.
- `bcall` — hard 11-minute default timeout (AbortSignal.any) so a hung bridge call can never freeze the loop forever.
- `fsWrite` — explicit 5 MB content cap + folder-vs-file guard + undo snapshot.

## 3. Multi-agent (7 roles)
Planner · Architect · Researcher (real web tools in preflight) · QA Engineer · Coder (tool loop) · Debugger · Reviewer — each with its own model routing select in Settings. New `delegate_subtask` tool spawns bounded sub-agents (max 4 rounds) restricted to a read-only toolset, so delegation can never conflict with the Coder's file edits. Internal reports stay out of the chat UI; the animated activity strip shows who is working.

## 4. Security (backend-enforced)
- Server-side permission system for 7 capabilities (fsEdit, terminal, network, browser, ext, mcp, destructive) stored in `~/.my-agent/permissions.json`; modes **allow / ask / deny**, enforced in `agent-server.js` regardless of what the page does. Editor in Settings ▸ Bridge ▸ Server permissions (`/perm/get`, `/perm/set`, audited).
- Gates wired into: `/run`, `/fs/write`, `/fs/delete`, `/fs/editbatch`, `/fs/undo|redo`, `/index/rename`, `/git/discard`, `/git/push`, `/checkpoints/restore|delete`, `/ext/install|remove|restart`, `/ext/call` (MCP), `/bridge/call`, all `/dev/*` runners, `/task/create|retry`, and every new web/http endpoint.
- Rate limiting (429) on expensive endpoints: index rebuild, checkpoints, web/search/fetch/extract/find/crawl/screenshot, http/request, ext/install, dev runners.
- SSRF protection in web tools: private/loopback/link-local/metadata IPs blocked **including DNS-resolved addresses**; plain http only for loopback; cloud-metadata blocklist shared with the LLM relay.
- Secret handling: HTTP header **values** are never audited (names only); `Authorization`-style values are redacted by the existing hash-chained audit log; API collection stores headers in a 0600 file and never returns them in `list`.
- Output/size limits on every new tool (2–3 MB downloads, 100 k body, 200-diagnostic cap, 50-file edit batch).
- Audit log extended to all new mutating endpoints (`/web/*`, `/http/*`, `/dev/*`, `/task/*`, `/fs/editbatch|undo|redo`, `/index/rename`, `/perm/set`, new browser routes).

## 5. Partially implemented (honest status)
- **web_search provider choice** — only DuckDuckGo HTML is wired; `provider`/`config.searchProvider` is validated but other engines need API keys (not bundled).
- **browser_download** — works for normal click/navigate downloads; no streaming progress events, 60 s poll window, no pause/resume.
- **find_unused_code / rename_symbol** — index-driven heuristics (word boundaries), not compiler-grade; dynamic/string-based usage is flagged in the output.
- **get_diagnostics** — CLI toolchains (tsc/eslint/ruff); no LSP server integration yet (none installed by default; the bridge stays dependency-free).
- **Task resume** — interrupted tasks are detected and retryable, but not auto-resumed mid-flight (commands cannot be safely resumed).
- **Browser additions in Desktop embedded mode** — routed with a clear message; switch the Browser panel to "Agent Chrome stream" to use them.

## 6. Unavailable integrations (dependencies not bundled)
Playwright/Puppeteer (the CDP driver stays dependency-free), LSP servers, Postgres/SQLite (MySQL only, unchanged), Bing/Google search APIs (keys required), Chrome itself (the same requirement as 3.9.x — Chrome/Edge must be installed).

## 7. Test results (this release)
- `verify-3.10.0.cjs` (new): **60/60 passed** — boots the real bridge + loopback test site; covers permission deny/ask/allow, rate limiting, http_request + expect validation + collections + inspect, SSRF blocks, editbatch atomicity, undo/redo, index rename, test discovery/run/refusals, diagnostics/lint/deps/unused/health, task create/dedupe/complete/cancel/retry/persist, graceful browser degradation, workflowDiagnostics fix, audit coverage.
- Existing suites: `verify.cjs` 114/114 · `verify-providers.cjs` 25/25 · `verify-bridge.cjs` 89/89 · `verify-server-hardening.cjs` 27/27 · `verify-desktop.cjs` 25/25 · `verify-opencode-install.cjs` 18/18 · `check_js.py` syntax OK · `test_fill_quick.js`, `test_ext_catalog.js`, `test_agent_perf.js` all pass.

## 8. Known limitations
- Web tools cannot reach localhost/Intranet hosts by design (use the browser tools or `http_request` for dev servers).
- The multi-agent preflight Researcher performs real web requests; if your network blocks DuckDuckGo, it degrades to reasoning-only with a note.
- Server permissions default to **allow** (identical behaviour to 3.9.8) — tighten them in Settings ▸ Bridge; `ask` adds a second (server-side) confirmation for the affected endpoint class.
- Task history is capped at 200 entries / 40 log lines per task.

## 9. Migration
None required: settings schema stays `v:6`, all existing endpoints, tools, rules and sessions are unchanged. New files appear only in `~/.my-agent/` (`permissions.json`, `tasks/`, `file-history/`, `api-collection.json`). To adopt: replace `my-chat-agent-v3.html`, `agent-server.js`, `pwa/sw.js`, `package.json` and restart the bridge (the PWA service worker picks up cache version `codespace-pwa-19-advanced-agent-310`). Rollback: restore the 3.9.8 files — the new data files are simply ignored.
