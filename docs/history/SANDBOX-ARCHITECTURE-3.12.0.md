# CodeSpace 3.12.0 — Universal Sandbox Engine

A backend subsystem (`sandbox-manager.js`, loaded by `agent-server.js`) that lets the AI create
isolated, disposable environments, install dependencies, build, test, debug, and export verified
changes back to the real workspace — with **no silent fallback to host execution** and **no
replacement** of any existing CodeSpace component.

## Architecture

```
agent-server.js (existing; unchanged architecture)
  └── sandbox-manager.js (new subsystem, factory + context injection)
        ├── Provider adapters (common interface: detect/capabilities/healthCheck/create/
        │   inspect/exec/copyIn/copyOut/readLogs/stop/destroy)
        │     docker/OCI · wasmtime (WASI) · windows-sandbox · hyperv · wsl2 (detect-only)
        │     mock (test-only, MY_AGENT_SANDBOX_MOCK=1, NON-ISOLATED, never auto-selected)
        ├── Versioned environment profiles (manifest v1, pinned image tags, digest capture)
        ├── Filtered workspace snapshot / transfer / export with secret exclusion
        ├── Resource + network policy enforcement and honest limitation reporting
        └── Orphan sweeper (boot + every 5 min) backed by persistent sandbox records
```

Integration points (all existing components preserved): permission manager (7 new categories,
same allow/ask/deny + single-use tokens + multi-gate plan cache), task manager (sandbox
ownership, cancellation stops owned sandboxes, orphan sweep never kills a sandbox owned by a
live task), tool registry (13 `sandbox_*` tools in a new `sandbox` group), audit log, agent UI
(compact sandbox status bar + Settings → Sandbox section using existing conventions).

## Provider compatibility matrix

| Provider | Detection | Create/Exec | Isolation level | Enforced limits | Status in 3.12.0 |
|---|---|---|---|---|---|
| Docker / OCI (Docker Engine, Docker Desktop, rootless, Podman CLI) | real (`docker version`/`info`) | ✔ implemented | container namespaces, caps dropped, read-only rootfs, tmpfs workspace, non-root user | cpu, memory (hard, no swap), pids, disk (tmpfs quota), exec timeout, network `none` | fully implemented; end-to-end tests run wherever a daemon exists (reported separately when absent) |
| gVisor (runsc) | via `docker info` runtimes | ✔ (`--runtime runsc` on request) | container + user-space kernel | as Docker | optional layer; clear error when absent; never assumed on Windows |
| Wasmtime (WASI) | real (`wasmtime --version`) | ✔ implemented | WASI capability sandbox: no network, no preopened dirs by default | wasm max-memory, exec timeout, no network | fully implemented for .wasm modules; explicitly NOT for native Python/Node/PHP/Java/C/C++ |
| Windows Sandbox | real (feature + hypervisor checks) | config generator implemented; session runner requires a Windows host with the feature | disposable VM; networking + clipboard disabled in generated `.wsb` | timeout, read-only mapping, staging folder; CPU/RAM/PID caps NOT individually enforceable (documented) | detection + hardened config generation; session execution requires the feature enabled by the user |
| Hyper-V | real (feature check) | detection + clear reporting | VM (user-authorized images only) | — | detection only; images are never created/downloaded automatically |
| WSL2 | real (`wsl --status`) | intentionally NOT offered as a sandbox | **NONE** — shares the host trust boundary | — | detection + Docker-backend integration note; untrusted code is never run in a user distribution |
| Mock | env flag | ✔ (tests) | **NONE — NON-ISOLATED** | timeout, output cap | test-only; refused unless `MY_AGENT_SANDBOX_MOCK=1`; never auto-selected |

## Environment profiles (manifest v1)

`python-3.10/3.11/3.12/3.13`, `node-20/22/24`, `php-8.3`, `java-17/21`, `golang-1.23`,
`rust-stable (1.83)`, `cpp-gcc (14)`, `dotnet-9`, `ruby-3.3`, `linux-ubuntu (24.04)`,
`linux-debian (12)`, `wasm-module`, `windows-powershell`.

Each profile pins: provider, image (concrete version tags — `latest` is rejected by the
validator), workdir, default resource limits (cpu/mem/pids/disk/timeout), network policy
(`none` by default), and cleanup policy (`destroy`). After the first pull the manager records
the registry digest (`RepoDigests`) into the sandbox record and re-uses it, so runs on a given
machine are reproducible. Project-specific profiles are accepted but **validated before
execution** (`/sandbox/profiles/validate`); invalid profiles are refused.

## Workspace isolation & file transfer

1. Snapshot: bounded walk (≤3000 files, ≤2 MB/file, ≤64 MB total) excluding `.git`, `node_modules`,
   `.env*`, `.ssh`, `.aws`, keys/certificates, credential files, and any file whose content
   matches secret patterns (token formats, private keys).
2. Transfer into the sandbox (`docker cp` from a validated staging dir; traversal, absolute
   paths, symlinks-out rejected). The sandbox rootfs is read-only; the workspace is a size-capped
   tmpfs. **No host directory is mounted into containers.**
3. Execution, then `sandbox_export_changes`: diff vs the copy-in manifest → added/modified/
   deleted manifest presented for review. Nothing is applied automatically.
4. `sandbox_export_apply`: server-side `sandboxExport` permission + approval token, recovery
   checkpoint via the existing checkpoint system, atomic writes via the 3.11 `atomicWrite`,
   path-safety re-checks, and **deletions are never applied unless `apply_deletions:true`**.
5. Cleanup on destroy/cancel/orphan sweep.

## Resource management

Defaults (clamped to host): 1 CPU, 1536 MB memory (hard cap, memory-swap = memory), 256 PIDs,
2 GB workspace tmpfs quota, 120 s command timeout (build/test profiles up to 300 s). Enforced
via Docker cgroup flags; providers that cannot enforce a boundary say so in `capabilities()`
(e.g. Windows Sandbox CPU/RAM) and the sandbox record carries `resources` + enforcement notes.
Concurrency: `CODESPACE_MAX_SANDBOXES` (default 1, max 8) with a clear error at the cap.

## Network security

`none` is the default and enforced (`--network none` / WASI no-network). Other policies
(`package-registries`, `approved-domains`, `restricted-egress`) require the `sandboxNetwork`
permission; the record and every response label their honest enforcement level:
**bridge-isolated only — domain allowlisting is NOT enforced in 3.12.0** (no bundled egress
proxy). Host/loopback reachability from a `none` sandbox is impossible by construction.

## Permissions (backend-enforced, extends the 3.11 system)

| Category | Governs |
|---|---|
| `sandboxCreate` | creating any environment (approval covers the full plan: profile, resources, network, initial snapshot) |
| `sandboxExec` | every command inside a sandbox |
| `sandboxNetwork` | any non-`none` network policy |
| `sandboxMount` | copy-in / copy-out after creation |
| `sandboxExport` | collecting changes and applying them to the workspace |
| `sandboxDestroy` | stop + destroy |
| `sandboxProfiles` | validating/managing project profiles |

All gates are server-side; approvals use the existing single-use, expiring, operation-bound
tokens; **all approvals for a multi-gate request are collected before anything is created**;
a request-scoped gate-plan cache lets sequential gates each require their own genuine approval,
and is cleared the moment an operation completes — so a completed operation can never be
replayed through a plan entry (verified by the 3.11 replay tests, which still pass unchanged).
Every sandbox lifecycle operation is audit-logged.

## Agent tools

`sandbox_capabilities`, `sandbox_profiles_list`, `sandbox_profile_inspect`, `sandbox_create`,
`sandbox_inspect`, `sandbox_exec`, `sandbox_read_logs`, `sandbox_copy_in`, `sandbox_copy_out`,
`sandbox_export_changes`, `sandbox_export_apply`, `sandbox_stop`, `sandbox_destroy`,
`sandbox_list` — strict schemas, backend implementation, permission enforcement, timeouts,
structured errors. Existing tools remain host tools (`run_tests` etc. are NOT replaced); the
agent combines them with sandbox tools and never silently falls back to the host.

## Installation requirements (never auto-installed)

- **Docker provider:** Docker Desktop (Windows/macOS) or Docker Engine, or Podman; daemon running.
- **Wasmtime provider:** `wasmtime` on PATH.
- **Windows Sandbox:** Windows Pro/Enterprise, "Windows Sandbox" feature enabled, virtualization on.
- **Hyper-V:** Windows feature + authorized VM image (user-provided).
- **WSL2:** `wsl --install` (detection/Docker backend only).
- **gVisor:** runsc runtime registered in Docker (Linux hosts).

## Known limitations

1. Domain-allowlist network policies are bridge-isolated but not content-filtered (no bundled
   egress proxy); the enforcement level is reported on every sandbox.
2. Windows Sandbox session execution requires the Windows feature; CPU/RAM/PID limits inside
   the sandbox are not individually enforceable from `.wsb` configs (documented, reported).
3. Hyper-V runs only from user-authorized images; none are created or downloaded automatically.
4. WSL2 is detection-only and explicitly refused as an execution sandbox.
5. Docker end-to-end behavior is exercised by the suite wherever a daemon exists; on hosts
   without one the suite reports `provider-unavailable` honestly instead of faking passes.
6. WASM runs WASI modules only; native runtimes are not claimed.
