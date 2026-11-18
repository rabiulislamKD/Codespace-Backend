# CodeSpace 3.12.0 — Universal Sandbox Engine (Changelog)

Release type: major architectural capability upgrade as an ADDITIONAL backend subsystem.
Nothing from 3.11.0 was replaced, redesigned or weakened. Baseline: git 3.11.0 release.

## New: Universal Sandbox Manager (`sandbox-manager.js`)
- Provider adapter interface: `detect / capabilities / healthCheck / create / inspect / exec /
  copyIn / copyOut / readLogs / stop / destroy`.
- Real capability detection with a cached report (`/sandbox/capabilities`): Docker/OCI
  (incl. rootless + Podman CLI + WSL2-backend note), gVisor runtime detection, Wasmtime,
  Windows Sandbox (feature + hypervisor), Hyper-V, WSL2 (explicitly NOT an isolation boundary),
  and a test-only mock provider (`MY_AGENT_SANDBOX_MOCK=1`) that is never auto-selected.
- **No silent fallback**: an unavailable provider produces a clear error naming the missing
  setup; nothing ever downgrades to unisolated host execution.
- Hardened Docker container construction from validated policy only: pinned image (digest
  captured after pull), non-root user, `--network none` by default, read-only rootfs, tmpfs
  workspace with disk quota, `--cap-drop ALL`, `no-new-privileges`, hard memory cap
  (`--memory-swap` = memory), cpu + pids limits; never privileged, never a host mount, never a
  daemon socket.
- 18-version environment profile manifest (v1) + project-profile validation that rejects
  floating `latest` tags and out-of-range resources.
- Filtered workspace snapshot (secrets, `.git`, keys, `.env`, credential files excluded, plus
  content-based secret scan), bounded transfer, change manifest + review + approved export with
  recovery checkpoint, atomic writes, and no deletions without explicit `apply_deletions`.
- Resource defaults (1 CPU / 1536 MB hard / 256 PIDs / 2 GB tmpfs / 120 s) clamped to the host,
  concurrency limit (`CODESPACE_MAX_SANDBOXES`, default 1), timeouts, 200 KB output caps.
- Persistent sandbox records; boot-time + periodic (5 min) orphan sweep; task ownership —
  cancelling a task stops the sandboxes it owns; a live task's sandbox is never swept.
- Failure handling: every failure (daemon missing, pull failed, timeout, OOM-killed state,
  destroyed-while-busy…) is reported accurately; a test that could not run is never "passed".

## New: 7 granular sandbox permissions (server-side, extends 3.11)
`sandboxCreate`, `sandboxExec`, `sandboxNetwork`, `sandboxMount`, `sandboxExport`,
`sandboxDestroy`, `sandboxProfiles` — same allow/ask/deny, same single-use expiring
operation-bound approval tokens, deny blocks even with `approved:true` + forged tokens
(re-tested). New: multi-gate support — one request can cross several gates (create + mount +
network); each gate gets its own genuine approval, all approvals are collected **before**
anything is created, and the plan cache is cleared on completion so completed operations cannot
be replayed (the 3.11 replay/expiry/binding tests pass unchanged: 147/147).

## New: 13+1 agent tools (new `sandbox` tool group)
`sandbox_capabilities`, `sandbox_profiles_list`, `sandbox_profile_inspect`, `sandbox_create`,
`sandbox_inspect`, `sandbox_exec`, `sandbox_read_logs`, `sandbox_copy_in`, `sandbox_copy_out`,
`sandbox_export_changes`, `sandbox_export_apply`, `sandbox_stop`, `sandbox_destroy`,
`sandbox_list`. Existing `run_tests` / `run_command` / host terminal remain separate host
tools; nothing was renamed or removed.

## New endpoints (all audited, rate-limited where expensive)
`/sandbox/capabilities`, `/sandbox/profiles`, `/sandbox/profile`, `/sandbox/profiles/validate`,
`/sandbox/suggest`, `/sandbox/create`, `/sandbox/list`, `/sandbox/inspect`, `/sandbox/exec`,
`/sandbox/logs`, `/sandbox/copy_in`, `/sandbox/copy_out`, `/sandbox/export`,
`/sandbox/export/apply`, `/sandbox/stop`, `/sandbox/destroy`, `/sandbox/cleanup`.

## UI (minimal, existing design preserved)
- Compact sandbox status bar (same visual conventions as the task bar): profile · provider ·
  state · network policy · CPU/RAM, with a Stop control and slot counter.
- Settings → "Sandbox environments (isolated execution)" section: real provider availability +
  health + reasons, host resources, concurrency limit; "Detect providers" button.
- Settings → Server permissions now shows the 7 new sandbox rows automatically.
- Activity-log entries for create/exec/export/destroy.

## Verification
- New `verify-sandbox.cjs` (`npm run verify:sandbox`): **63 passed, 0 failed**, 1
  provider-unavailable (Docker absent on the release host — reported, not faked). Covers:
  capability detection honesty, no-silent-fallback (mock without env refused; docker without
  daemon refused), permission matrix for 4 sandbox categories × allow/deny/ask + tokens,
  network-escalation gating, mock lifecycle (create → exec → logs → copy-in/out → export →
  apply → stop → destroy), secret exclusion (`.env`, `.ssh` never reach the sandbox),
  path-traversal/absolute-path rejection, timeout kill, concurrency limit, profile manifest +
  validation + auto-suggestion, orphan record recovery + sweep, audit coverage, and a unit test
  of the Windows Sandbox `.wsb` config generation (networking/clipboard disabled, read-only
  source mapping, separate output staging, no user-profile mapping).
- Full regression: `npm run verify:all` = server-hardening 27 · providers 25 · verify 114 ·
  3.10 suite 64 · 3.11 security 147 · sandbox 63 · bridge 89 · desktop 25.
- One 3.10 assertion updated for the new permission count (8 → 15 categories) — strengthened,
  not weakened.

## Version markers
package.json 3.12.0 · PWA cache `codespace-pwa-21-sandbox-engine-312` · splash v3.12.0 ·
bridge user-agent CodeSpaceAgent/3.12.

## Documentation
`SANDBOX-ARCHITECTURE-3.12.0.md` (architecture, provider matrix, profiles, transfer system,
resources, network, permissions, install requirements, limitations) and this changelog.

## Migration notes
- No data migration. A NEW `permissions.json` starts with all sandbox categories in `ask`; an
  EXISTING file is preserved exactly as before, and unset keys in an existing file keep the
  3.11 behavior (`allow`) — review Settings → Server permissions after upgrading.
- Optional env vars: `CODESPACE_MAX_SANDBOXES` (1–8, default 1), `MY_AGENT_SANDBOX_MOCK=1`
  (test suite only — never enable on a machine you care about; the mock is NON-ISOLATED).
