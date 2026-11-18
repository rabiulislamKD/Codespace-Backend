# CodeSpace 3.12.8 — Sandbox Security & Reliability Patch

Release: **3.12.8**  
Base: **3.12.7**  
Scope: targeted sandbox security, lifecycle, provider correctness, and verification fixes. Existing chat, agent, browser, MCP, extension, Git, task, terminal, and continuation architecture is preserved.

## Security and correctness fixes

### Workspace export boundary

- Reject symbolic links and special files in provider copy-out staging trees.
- Validate every path component before reading or exporting staged files.
- Reject a workspace target if any existing parent component is a symbolic link, junction, or non-directory.
- Bind a sandbox and pending export to the canonical workspace path and directory identity captured at sandbox creation.
- Revalidate workspace identity and file paths after the asynchronous recovery-checkpoint operation and before writes.
- Require a complete recovery checkpoint with a durable checkpoint ID before applying any sandbox export. Checkpoint errors or incomplete checkpoints now abort the export.
- Apply reviewed files using atomic writes; retain rollback snapshots for already-applied operations.
- Put each pending export in a unique private staging directory. Clean old pending exports when replaced, clean the applied export after success, and clean pending export data when a sandbox is destroyed.
- Preserve the previous pending export if the replacement staging operation fails.
- Keep deletions opt-in and reject deletion through symlinks or non-regular files.
- Bound exported file count, per-file size, total size, and rollback data size.

### Wasmtime

- Only execute a `.wasm` module explicitly copied into the sandbox through `sandbox_copy_in`.
- Never derive a module path from a caller-supplied host path or basename.
- Reject a requested module name that does not match the staged module.
- Reject symbolic links and any module resolving outside the sandbox scratch directory.
- Return a fresh copy for `copy_out`; no longer return a directory that belongs to the live sandbox.

### Docker / OCI

- Keep network disabled by default and refuse non-`none` network policies until a verified egress proxy is implemented. Do not downgrade those policies to an unrestricted bridge network.
- Require a separate `sandboxNetwork` approval before the Docker daemon pulls a missing image, because image pulls use the host daemon's network before the container starts.
- Force container commands to run as UID/GID `1000:1000`; do not accept a model-selected root user.
- Configure the workspace tmpfs as writable by UID/GID 1000.
- Grant only the narrow `CHOWN` capability in addition to `--cap-drop ALL`, allowing the manager to normalize `docker cp`-created workspace files to `1000:1000`. Ordinary agent commands still run as the unprivileged user.
- Normalize copied workspace ownership and fail closed if that cannot be completed.
- Keep the root filesystem read-only, no network, no-new-privileges, memory/CPU/PID limits, and no privileged mode or host mounts.
- Treat `runsc` as gVisor only when that runtime is actually advertised by the Docker daemon; do not mislabel unrelated OCI runtimes as gVisor.

### Profiles and request handling

- Preserve profile-specific resource values when applying defaults; Java profiles retain their higher memory/disk/time limits.
- Fix Node.js `engines.node` auto-detection so supported profile selection no longer sorts `NaN` values.
- Increase the JSON body allowance only for the sandbox copy-in endpoint, matching its documented 32 MB file payload while retaining the global cap and smaller limits for other routes.
- Explicitly report Windows Sandbox and Hyper-V as detected but not executable when only detection/configuration exists and the lifecycle is not implemented.
- Strengthen workspace-relative path validation, including traversal, empty segments, control characters, Windows ADS characters, trailing dots/spaces, and reserved Windows device names.

## Verification improvements

- Add `verify-3.12.8.cjs` with fake CLI/runtime adapters for deterministic Docker and Wasmtime adapter-path checks. It does not claim that a real Docker daemon or Wasmtime runtime was available.
- Add regression coverage for workspace symlink export, workspace switching, incomplete checkpoints, pending-export cleanup, profile resource preservation, Node version suggestion, Docker non-root workspace ownership, Docker image-pull approval, and Wasmtime host-path rejection/copy-out preservation.
- Tighten the existing snapshot secret-exclusion assertion; it now checks the exact four ordinary fixture files and manifest entries rather than an always-true expression.
- Make the 3.10 and 3.11 browser verification cases work on hosts where Chromium is present as well as where it is absent. The tests now validate actual browser success data or a meaningful unavailable/timeout response instead of assuming that every test host has no browser.
- Add `npm run verify:3128` and include it in `npm run verify:all`.
- Ensure the 3.11 verifier terminates its bridge child processes on normal completion and failure.

## UI and release metadata

- Update the splash version label to `v3.12.8 — Sandbox Security & Reliability`.
- Bump the PWA cache identifier so clients fetch the updated shell.
- Update package version to `3.12.8`.
- Make the Windows portable-EXE build script print the current 3.12.8 release instead of stale 3.9.1 instructions; update the Bengali build guide output name.

## Known limitations

- A real Docker/Podman daemon was not available in the audit runtime. Docker CLI arguments and copy-in ownership handling were tested with a deterministic fake CLI; real container create/exec/copy/destroy still needs validation on a machine with Docker Desktop or Podman running.
- A real Wasmtime runtime was not available. The adapter was exercised with a fake executable; run a real WASI module on a host with Wasmtime before treating that provider as production-verified.
- Windows Sandbox and Hyper-V remain detected/configuration-only providers unless the relevant lifecycle operations are implemented and tested. The capability report must not advertise them as executable.
- WSL2 is compatibility infrastructure, not a strong isolation boundary.
- Docker egress policies other than `none` are intentionally refused until CodeSpace has a verified egress proxy and policy-enforcing network path. Package installation requiring internet therefore needs an approved prebuilt image or a future controlled egress implementation.
- The public-web test was skipped because this audit runtime had no internet/DNS access. That skip is reported separately from passed tests.
- Full Windows-native testing remains required on the user's Windows machine.
