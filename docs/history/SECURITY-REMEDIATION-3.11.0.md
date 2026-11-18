# CodeSpace 3.11.0 — Security Remediation Report

Audit: `SECURITY-AUDIT-3.11.0.md` (Phase 0, findings verified against code, not changelogs).
Implementation: git commit "3.11.0 phases 1-8" + this release. Tests: `verify-3.11.0.cjs`.

## 1. Protected backend endpoints (final state)

### Permission classes and enforcement points

| Endpoint | Permission | Guard location | Audit-logged |
|---|---|---|---|
| /run (foreground + background) | terminal | dispatcher | ✓ |
| /term/start | terminal | dispatcher | ✓ |
| /term/write | terminal | dispatcher | ✓ |
| /term/kill | terminal | dispatcher | ✓ |
| /term/close | terminal | dispatcher | ✓ |
| /opencode/run | terminal | dispatcher | ✓ |
| /opencode/install | terminal | dispatcher | ✓ |
| /dev/tests | terminal | in-function | ✓ |
| /dev/diagnostics | terminal | in-function | ✓ |
| /dev/lint | terminal | in-function | ✓ |
| /dev/format | fsEdit | in-function | ✓ |
| /dev/deps (audit:true) | terminal | in-function | ✓ |
| /web/search /web/fetch /web/extract /web/find /web/crawl /web/screenshot | network | dispatcher | ✓ |
| /http/request | network | dispatcher | ✓ |
| /http/collection (action=run) | network | dispatcher | ✓ |
| /llm/proxy | network (deny-only) | in-function | ✗ (secret-bearing, never logged) |
| /ext/catalog/search, /ext/package/inspect | network (deny-only) | in-function | ✗ (read-only lookups) |
| /fs/write | fsEdit | dispatcher | ✓ |
| /fs/editbatch | fsEdit | in-function | ✓ |
| /fs/undo, /fs/redo | fsEdit | in-function | ✓ |
| /index/rename | fsEdit | in-function | ✓ |
| /fs/delete | destructive | dispatcher | ✓ |
| /git/discard, /git/push | destructive | dispatcher | ✓ |
| /checkpoints/restore, /checkpoints/delete | destructive | dispatcher | ✓ |
| /ext/remove | destructive | dispatcher | ✓ |
| /db/query (write SQL) | destructive | in-function (confirmed-flag removed) | ✓ |
| /ext/install, /ext/toggle, /ext/restart | ext | dispatcher | ✓ |
| /skills/install, /skills/remove | ext | dispatcher | ✓ |
| /ext/call | mcp | dispatcher | ✓ |
| /git/commit, /git/pull, /git/checkout, /git/stage, /git/unstage, /git/init | git (new) | dispatcher | ✓ |
| /browser/open /nav /click /type /key /scroll /hover /select /upload /download /screenshot /dom_snapshot /a11y_tree /eval /wait /tabs /viewport /stream/start /stream/stop | browser | dispatcher | ✓ (all in AUDITED regex) |
| /bridge/call | browser | dispatcher | ✓ |
| /task/create | terminal/network per kind | in-function + run-time revalidation | ✓ |
| /task/retry | per kind, fresh approval | in-function | ✓ |

Read-only / status endpoints (no permission class, bearer-token required): `/info`, `/perm/get|set`,
`/config/*`, `/sessions/*`, `/term/list|read|resize`, `/term/stream` (GET, token-checked),
`/preview/stream`, `/bridge/status|poll|result`, `/browser/read`, `/browser/diagnostics`,
`/browser/close`, `/workspace/dirs`, `/workspace/set|close` (audited), `/audit/list`,
`/checkpoints/list|compare|create`, `/git/status|diff|log|branches`, `/index/*`, `/fs/list|read|search|history`,
`/dev/tooling|unused|health`, `/http/inspect`, `/task/get|list|delete`, `/skills/list|get`,
`/ext/list`, `/opencode/status`, `/opencode/auth/get|set`, `/project-memory/*`, `/project/understand*`,
`/workflow/*`, `/conn/status|set|remove|github|vercel` (conn mutations audited; github/vercel validate
tokens over the network and respect network `deny` via their provider calls being part of user settings).

## 2. Permission test matrix (from verify-3.11.0.cjs — 147 checks, all passing)

For each of 19 endpoint classes spanning all 8 permission categories:

| Scenario | Result |
|---|---|
| `allow` permits execution (real side effect verified, e.g. command runs, file written) | PASS ×19 |
| `deny` rejects with HTTP 403 — also when the caller sends `approved:true`, `confirmed:true` and a forged token | PASS ×19 |
| `ask` returns `{needsApproval:true, permission, approvalToken:'apr_…', expiresInMs}` | PASS ×19 |
| Resending the same body + token completes exactly the intended operation | PASS ×19 |
| Approval **replay** (same token twice) fails with "already used" | PASS ×19 |
| Token bound to arguments (different body for the same endpoint rejected: "does not match") | PASS (editbatch) |
| Expired approval (TTL 6 s) fails with "expired" | PASS |
| Rejection prevents side effects (no file written without approval) | PASS |
| New permission file defaults: ext/mcp/destructive/git = `ask`, fsEdit/terminal/network/browser = `allow` | PASS |

Tested endpoint classes: `/run`, `/term/start`, `/term/write`, `/term/kill`, `/opencode/run`,
`/dev/diagnostics` (terminal); `/web/fetch`, `/http/request` (network); `/browser/open`,
`/browser/screenshot`, `/browser/eval`, `/bridge/call` (browser); `/fs/editbatch` (fsEdit);
`/fs/delete`, `/checkpoints/delete` (destructive); `/skills/install` (ext); `/git/commit`,
`/git/pull`, `/git/checkout` (git).

## 3. SSRF test results (mock servers, injectable DNS; no public internet required)

| Case | Result |
|---|---|
| IPv4 loopback `127.0.0.1` via web_fetch | refused (400) |
| IPv6 loopback `[::1]` | refused (400) |
| Private IPv4 `10.1.2.3`, `172.16.0.9`, `192.168.1.1` | refused (400) |
| Link-local / cloud metadata `169.254.169.254` | refused (400) |
| IPv6 ULA `[fc00::1]`, link-local `[fe80::1]` | refused (400) |
| IPv4-mapped IPv6 `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.1]` | refused (400) |
| Invalid scheme `ftp:`, `file:` | refused (400) |
| Embedded credentials `http://user:pass@…` | refused (400) |
| `http_request` to loopback in default config | refused (400) |
| `localhost` hostname in default config | refused (400) |
| DNS name resolving to a private address (`rebind.test` → 127.0.0.1 via injectable DNS) | refused ("resolves to a private…") |
| DNS rebinding window | closed — connection goes to the validated IP (pin verified: pinned request served the mock site) |
| Redirect chain cap | enforced (looping redirect terminates) |
| Redirect target revalidation | every hop re-checked (scheme/host/DNS/private ranges) |
| Control: opt-in server reaches the mock dev site and gets correct content | PASS |
| Cleartext rule: plain http to a public host via http_request | refused (carried over from 3.10) |

## 4. Functional test results (verify-3.11.0.cjs)

Multi-file edit atomic + rollback (3 checks), ambiguous-edit protection, web_fetch/web_extract/
http_request/web_crawl on mock servers, redirect-loop cap, task create/dedupe/cancel/dangerous-
command refusal, restart recovery (`running` → `interrupted`), diagnostics task blocked when
terminal = deny, git init/stage/commit/status, browser-unavailable structured diagnostics,
screenshot not-running state, dev_format missing-dependency report (never npx), audit coverage of
guarded endpoints, secrets kept out of the audit log.

Regression (all green, none weakened, none removed):
`verify-server-hardening` 27 · `verify-providers` 25 · `verify.cjs` all checks ·
`verify-3.10.0` 64 (4 outdated assertions strengthened) · `verify-3.11.0` 147 ·
`verify-bridge` 89 · `verify-desktop` 25 · inline-JS syntax check ALL OK ·
`test_fill_quick` / `test_ext_catalog` all assertions passed.

## 5. Remaining limitations

See CHANGELOG section 8 (terminal-panel per-batch prompts in ask mode; ask→allow carve-outs for
the chat relay and registry lookups; browser navigation governed by the browser, not the bridge;
user-settings endpoints audited but not permission-classified; OS-level resolver trust).
