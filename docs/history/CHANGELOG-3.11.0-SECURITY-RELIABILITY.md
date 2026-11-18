# CodeSpace 3.11.0 — Security, Reliability & Autonomous Execution Upgrade

**Release type:** security & reliability release (no UI redesign, no feature additions).
**Baseline:** 3.10.0 (git tag `3.10.0-baseline`). Audit document: `SECURITY-AUDIT-3.11.0.md`.
**Full remediation report with endpoint matrix and test results:** `SECURITY-REMEDIATION-3.11.0.md`.

## 1. Backend permission enforcement — every privileged endpoint is now protected (P0)

The 3.10.0 audit found that only `/run`, `/fs/write`, `/fs/delete`, `/git/discard`, `/git/push`,
`/checkpoints/restore|delete`, `/ext/install|remove|restart|call` and the in-function guards of the
fs/dev tools were protected. Everything else was reachable directly. 3.11.0 closes every bypass:

| Class | Endpoints now enforced server-side |
|---|---|
| Terminal | `/run` (one-shot + background), `/term/start`, `/term/write`, `/term/kill`, `/term/close`, `/opencode/run`, `/opencode/install`, `/dev/tests`, `/dev/diagnostics`, `/dev/lint`, `/dev/format`, `/dev/deps` (audit) |
| Network | `/web/search`, `/web/fetch`, `/web/extract`, `/web/find`, `/web/crawl`, `/web/screenshot`, `/http/request`, `/http/collection` (action `run`), `/conn/github`, `/conn/vercel` (token validation) |
| Network (deny-hardened) | `/llm/proxy`, `/ext/catalog/search`, `/ext/package/inspect` — `deny` blocks hard; `ask` behaves like `allow` for these read-only / user-initiated flows (documented carve-out) |
| Browser | `/browser/open|nav|click|type|key|scroll|hover|select|upload|download|screenshot|dom_snapshot|a11y_tree|eval|wait|tabs|viewport|stream/start|stream/stop`, `/bridge/call` (re-categorised `mcp` → `browser`) |
| fsEdit | `/fs/write`, `/fs/editbatch`, `/fs/undo`, `/fs/redo`, `/index/rename`, `/dev/format` |
| ext | `/ext/install`, `/ext/toggle`, `/ext/restart`, `/ext/remove`, `/skills/install`, `/skills/remove` |
| mcp | `/ext/call` |
| destructive | `/fs/delete`, `/git/discard`, `/git/push`, `/checkpoints/restore`, `/checkpoints/delete`, `/ext/remove`, `/db/query` (SQL that changes data — the forgeable `confirmed` flag was removed) |
| git (NEW category) | `/git/commit`, `/git/pull`, `/git/checkout`, `/git/stage`, `/git/unstage`, `/git/init` |

Unauthenticated/status endpoints stay open by design: `/info`, `/perm/get|set`, `/config/*`,
sessions, `/term/list|read|resize`, `/term/stream`, `/preview/stream`, `/bridge/status|poll|result`,
`/browser/read`, `/browser/diagnostics`, `/browser/close`, `/workspace/dirs`, `/audit/list`,
`/checkpoints/list|compare`, `/git/status|diff|log|branches`, `/index/*`, `/fs/list|read|search|history`,
`/dev/tooling|unused|health`, `/http/inspect`, `/task/get|list|delete`, `/skills/list|get`,
`/ext/list`, `/opencode/status`, `/opencode/auth/*`, `/project-memory/*`, `/project/understand*`,
`/workflow/*`, `/conn/status`, `/db/tables|describe`. All still require the bearer token; the
mutating ones are all in the audit log. `/workspace/set|close` and `/conn/set|remove` remain
token-gated user settings actions and are audited (documented decision).

## 2. Approval handshake rebuilt — single-use, expiring, operation-bound tokens (P0)

* In `ask` mode the server now returns `{ needsApproval, preview, permission, approvalToken, expiresInMs }`.
  The caller must resend the **same body plus that token**. Tokens are consumed on first
  presentation (replay fails with "already used"), expire (120 s default,
  `CODESPACE_APPROVAL_TTL_MS`), and are bound to permission + preview + every other body field
  (`approved`/`confirmed`/`approvalToken`/`human`/`visible`/`persist` excluded), so a token cannot
  approve a different operation or arguments.
* **`approved:true` / `confirmed:true` are ignored everywhere.** Deny blocks even when the caller
  sends both plus a forged token (tested). Six frontend call sites that pre-approved requests
  were converted to the server-challenge flow (`bApproved` shows the server-generated preview).
* Background tasks never inherit unlimited approval: task permissions are **revalidated when the
  task actually starts running**; `task_retry` always requires a fresh approval; a task whose
  permission later flips to `deny` is blocked; an approval older than 10× TTL fails.
* Safer initial defaults for **newly created** permission files: `ext`, `mcp`, `destructive`,
  `git` start in `ask` mode; `fsEdit`, `terminal`, `network`, `browser` start in `allow` so the
  everyday workflow is unchanged. **Existing permission files are preserved exactly.**

## 3. Shared SSRF-hardened outbound HTTP layer (P0)

New `secFetch`/`pinnedRequest` in `agent-server.js` is now the only outbound path for
`web_search`, `web_open/fetch/extract/find/crawl`, `robots.txt`, `http_request`, API collections,
and OpenCode registry downloads validate their targets too:

1. Scheme allow-list (http/https only); URLs with embedded credentials refused.
2. DNS resolution of **A and AAAA** records; every address checked.
3. Full range blocking: loopback (v4 + `::1`), private, link-local (`169.254/16`, `fe80::/10`),
   CGNAT `100.64/10`, ULA `fc00::/7`, multicast `ff00::/8`, reserved/broadcast, this-network `0/8`,
   documentation nets, cloud metadata, IPv4-mapped IPv6 (`::ffff:0:0/96`), IPv4-compatible `::/96`,
   NAT64 `64:ff9b::/96`, `localhost` / `.localhost` / `.local` / `.internal` hostnames.
4. **DNS-rebinding closed**: the connection is made to the validated IP (TLS SNI + Host header
   keep the hostname), so a DNS rotation after validation cannot redirect the connection.
5. Every redirect hop is revalidated from scratch; chain capped at 5; bodies never re-sent on
   301/302/303; non-http(s) redirect targets refused.
6. Timeouts, request/response size caps, correct TLS hostname verification.
7. Loopback/development endpoints require explicit configuration (`MY_AGENT_ALLOW_LOOPBACK=1`);
   DNS resolution is injectable (`MY_AGENT_DNS_OVERRIDE`) for deterministic tests.

`http_request` additionally keeps the cleartext rule: plain http to public hosts is refused.

## 4. Background task reliability (P1)

* Bounded scheduler: max 4 concurrent tasks (`CODESPACE_MAX_TASKS`, 1–8), FIFO queue capped at 50
  pending, tasks start automatically as slots free up.
* Every task kind maps to the permission of its **actual** behavior — `diagnostics` now requires
  `terminal` (it executes tsc/eslint), `web_crawl` requires `network`, `command`/`tests` require
  `terminal` — and revalidates at run time, not just at creation.
* Duplicate prevention (dedupe keys), cancellation of queued and running tasks, persistent state
  across restarts (running/pending → `interrupted`), output size limits unchanged (200 KB capture,
  12 KB tails), 3-attempt lifetime, task create/retry rate-limited.

## 5. File system & formatter reliability (P1)

* `fs_editbatch`: a serialization lock prevents concurrent edit corruption; every file is written
  through a temp-file + rename (mode preserved); if any write fails the already-written files are
  rolled back; after writing, every file is re-read and verified — any mismatch rolls the whole
  batch back. The batch can no longer leave an unexplained partial workspace.
* `format_code` never uses `npx`: it runs a project-local `node_modules/.bin` formatter binary,
  else a known global binary, else reports exactly what is missing. Nothing is downloaded or
  installed silently. Symbol rename also uses atomic writes under the same lock.

## 6. Browser hardening (P1)

Selectors/text are length- and control-character-validated; `browser_eval` capped at 100 KB;
uploads restricted to workspace files (≤20 files, ≤50 MB each, ≤100 MB total); downloads land
inside the workspace with a 200 MB per-file cap (oversized downloads are deleted and reported);
`/browser/diagnostics` returns a structured "browser unavailable" report instead of an error when
Chrome/Edge is absent. The embedded browser + Chrome Bridge architecture is unchanged and no
external Chrome window fallback was introduced.

## 7. Authorization, audit & resource protection (P1)

Rate limits added for `/term/start`, `/task/create`, `/task/retry`, `/fs/editbatch`,
`/skills/install`, `/opencode/install`; audit log extended to all browser automation endpoints
(hash-chained, secret-redacted, chain-verifiable as before); request body cap (5 MB), secret
redaction and session size caps carried over intact. CORS/`Access-Control-Allow-Private-Network`
headers are unchanged (localhost-only listener + bearer token — documented in the report).

## 8. Frontend (P2) — workflow fixes only, UI untouched

`bApproved` drives the token handshake (server preview shown in the existing dialog; expired/
replayed/invalid tokens produce clear, honest error strings instead of silent no-ops or raw
`needsApproval` objects). Updated: file write/delete, run_command (foreground + background),
run_tests, get_diagnostics, lint_project, format_code, multi_edit, undo/redo, rename_symbol,
task_create, task_retry (button + tool), all web/HTTP tools, all browser tools (agent + panel +
stream + viewport + reload), terminal panel (new/kill/close/input/command), skills install,
checkpoint restore, db query. Task bar and compact multi-agent status UI untouched.

## Verification

* New: `verify-3.11.0.cjs` — **147 checks** (permission matrix allow/ask/deny × 19 endpoint classes
  incl. replay/expiry/binding, 16-case SSRF battery on mock servers with injectable DNS,
  multi-file edit atomicity, task lifecycle + restart recovery, git ops, audit coverage,
  secrets-out-of-logs). Runs twice-clean.
* New npm scripts: `npm run verify:310`, `npm run verify:311`, `npm run verify:all`
  (server-hardening 27 + providers 25 + verify 106-area checks + 3.10 (64) + 3.11 (147) +
  bridge 89 + desktop 25). No existing test was removed; outdated assertions were strengthened
  (`approved:true passes the ask gate` → token-based approval tests; loopback web tests moved
  behind the explicit opt-in).

## Known limitations / documented carve-outs

1. `ask` mode on `/term/write` prompts per input batch in the terminal panel (first prompt can be
   remembered for the session via "don't ask again"); default `allow` mode is unaffected.
2. `/llm/proxy`, `/ext/catalog/search`, `/ext/package/inspect` enforce `deny` hard but treat `ask`
   as allow (chat streaming and read-only registry lookups cannot show a mid-stream dialog).
3. `/workspace/set|close` and `/conn/set|remove` are token-gated user settings actions — audited
   but not permission-classified (changing your own workspace/credentials is not an agent action).
4. SSRF protections cover the server's own outbound tools; the browser (CDP/Chrome) navigates
   wherever the user permits — that is the browser's own security domain, not the bridge's.
5. DNS-over-HTTPS is not used; a resolver that lies to the OS-level `dns.lookup` is outside scope
   (the connect-to-validated-IP design still prevents post-resolution rebinding).

## Migration notes

* No data migration. Existing `permissions.json` files are respected as-is; new installs get the
  safer defaults above (Settings → Bridge → Permissions shows the new **Git operations** row).
* New environment variables (all optional): `CODESPACE_APPROVAL_TTL_MS` (default 120000),
  `CODESPACE_MAX_TASKS` (default 4), `MY_AGENT_ALLOW_LOOPBACK=1` (needed by agents that must talk
  to local dev servers through web/HTTP tools), `MY_AGENT_DNS_OVERRIDE` (tests).
* PWA cache version bumped (`codespace-pwa-20`); the page will refresh itself on next load.
