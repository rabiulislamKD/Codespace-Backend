# CodeSpace 3.11.0 — Source Audit & Remediation Checklist (Phase 0)

Audit date: 2026-11-02. Baseline: git tag `3.10.0-baseline` (commit 701b36d, working tree clean).
Files inspected in full: `agent-server.js` (3,641 lines — route dispatcher, permission manager,
terminals, browser/CDP, extensions/MCP, tasks, git, checkpoints, web/HTTP tools, fs tools),
`my-chat-agent-v3.html` (6,956 lines — bcall, approve(), agent tool executor, panels),
all verification scripts (`verify.cjs`, `verify-server-hardening.cjs`, `verify-3.10.0.cjs`,
`verify-providers.cjs`, `verify-bridge.cjs`, `verify-desktop.cjs`, `verify-opencode-*.cjs`).

Previous changelog statements were NOT trusted; every claim below was verified against code.

## Confirmed findings (must fix in 3.11.0)

### P0-1 Backend permission bypasses (agent-server.js route dispatcher, ~line 3481–3637)
| Endpoint(s) | Required permission | Status before 3.11.0 |
|---|---|---|
| `/run` (incl. background) | terminal | guarded ✓ |
| `/term/start` `/term/write` `/term/kill` `/term/close` | terminal | **NO GUARD — bypass** |
| `/opencode/run` `/opencode/install` | terminal | **NO GUARD — bypass** |
| `/web/search|fetch|extract|find|crawl|screenshot` | network | **NO GUARD (rate-limit only)** |
| `/http/request`, `/http/collection` (action `run`) | network | **NO GUARD** |
| all `/browser/*` (open/nav/click/type/key/scroll/hover/select/upload/download/screenshot/dom_snapshot/a11y_tree/eval/wait/tabs/stream/viewport/read/diagnostics) | browser | **NO GUARD** |
| `/bridge/call` | browser | guarded as `mcp` (wrong category) |
| `/git/commit` `/git/pull` `/git/checkout` `/git/stage` `/git/unstage` `/git/init` | git (new category) | **NO GUARD** |
| `/fs/editbatch` `/fs/undo` `/fs/redo` `/index/rename` `/dev/format` | fsEdit | guarded inside functions ✓ (keep) |
| `/skills/install` `/skills/remove` `/ext/toggle` | ext | **NO GUARD** |
| `/db/query` (write SQL) | destructive | uses forgeable `b.confirmed` flag |
| task `diagnostics` kind | terminal | `perm: null` **and** `runTask` forces `approved:true` — **bypass** |
| `runTask` for command/tests/web_crawl | terminal/network | guarded only at creation; **not revalidated at run time** |

### P0-2 Forgeable approval handshake (permGuard, ~line 217)
`permGuard` returns `{needsApproval}` and accepts a client-declared `approved:true` flag on the
next request. No server-issued token: replayable, not bound to operation/arguments, never expires,
works identically for background tasks. Several frontend call sites pre-send `approved:true`
(html lines ~2406, ~2859, ~2864, ~3067, ~4904, ~1661), silently passing every `ask` gate.
`externalCheck()` (line 1468) uses the same forgeable `b.approved` flag.

### P0-3 Incomplete SSRF protection
- `webGet` (line 2545): single `assertPublicHost` check-then-`fetch(redirect:'follow')` →
  DNS rebinding + redirect-to-private-IP both succeed.
- `httpRequest` (line 2731): HTTPS to a hostname resolving to a private IP is never checked
  (literal check only); redirects not revalidated.
- `isPrivateIpLiteral` (line 2518): missing IPv6 ULA spelling variants, `100.64/10` CGNAT,
  IPv4-mapped IPv6 (`::ffff:127.0.0.1`), multicast/reserved ranges, `0.17/16` etc.
- `ddgSearch`, `robotsAllows`, `extCatalogSearch`, `extPackageInspect` fetch fixed public hosts
  (acceptable), but `ocHttpsGet` redirect targets are re-checked against registry host ✓ (keep).

### P1-4 Task manager reliability (line 3338–3435)
No concurrency limit, no bounded queue, `runTask` never revalidates permissions at run time,
diagnostics task force-approves itself (`approved:true`), no scheduler for pending tasks.

### P1-5 fsEditBatch / formatter
`fsEditBatch` (line 3097): prevalidates all files ✓ but writes non-atomically with no rollback,
no mode preservation, no post-write verification, no concurrent-edit lock.
`devFormat` (line 2977): runs `npx prettier --write .` — npx silently downloads prettier when
it is not installed locally.

### P1-6 Browser hardening
`browserUpload`/`browserDownload`: no file-size caps; selector length unvalidated; `browserEval`
expression unbounded. Session/timeout handling otherwise sound.

### P2-7 Misc
`AUDITED` regex missing newer browser endpoints; rate limits missing for `/term/start`,
`/task/create`, `/task/retry`, `/fs/editbatch`; CORS/PNA kept as-is (localhost app, bearer-token
gated) — documented, not changed.

## Remediation plan → implemented in 3.11.0
1. Single-use, expiring (120 s), operation-and-argument-bound approval tokens issued by the
   server; `approved:true` no longer accepted anywhere; deny blocks regardless of tokens.
2. `git` permission category added; safer defaults for NEW permission files
   (ext/mcp/destructive/git = `ask`); existing permission files preserved verbatim.
3. Guards on every endpoint listed P0-1; task kinds remapped (diagnostics → terminal) and
   revalidated at run time; task concurrency limit + bounded queue + scheduler.
4. Shared SSRF-hardened outbound fetch (`secFetch`): scheme check, A+AAAA resolution, full
   private/reserved range blocking incl. IPv4-mapped IPv6, connect-to-validated-IP (rebinding
   protection), per-redirect revalidation with hop cap, timeouts, size caps, injectable DNS for
   tests, explicit loopback opt-in for dev/test use.
5. fsEditBatch: edit mutex, tmp+rename atomic writes, mode preservation, mid-batch rollback,
   post-write verification. devFormat: local/global formatter binaries only — never npx.
6. Browser endpoint hardening (selector caps, upload/download size caps, eval cap).
7. New `verify-3.11.0.cjs` (permission matrix × allow/ask/deny, replay, expiry, SSRF battery on
   mock servers, functional integration) + `npm run verify:311` and `verify:all`.
