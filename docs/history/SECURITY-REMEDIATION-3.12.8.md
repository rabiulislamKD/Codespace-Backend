# CodeSpace 3.12.8 — Security Remediation Report

## Executive result

The 3.12.7 review identified a reproducible sandbox-export symlink escape and several related reliability/security issues. 3.12.8 closes the reproduced escape path, prevents workspace-switch export, fails closed when a complete recovery checkpoint cannot be created, and corrects provider lifecycle/path handling.

**Audit status:** source changes and deterministic regression tests are complete in this release package. This is not a claim that every execution provider has been validated on every operating system.

## Findings and remediation

| Finding in 3.12.7 | 3.12.8 remediation | Verification |
|---|---|---|
| Workspace symlink could redirect export outside workspace | Reject symlinks/special files and inspect each workspace path component | Regression creates an outside-pointing symlink and verifies no outside file is created |
| Workspace could change between sandbox creation and export | Bind sandbox and pending export to canonical workspace path plus directory identity | Switch workspace before apply; export is rejected and alternate workspace remains unchanged |
| Checkpoint failure was swallowed | Require checkpoint ID and `complete === true`; revalidate workspace after checkpoint | Incomplete checkpoint test confirms no workspace mutation |
| Wasmtime copy-out returned live scratch directory | Copy scratch into a separate staging directory | Repeated copy-out preserves live module |
| Wasmtime could resolve a caller-supplied host path | Require copied-in module; only execute recorded scratch module | Fake Wasmtime test verifies host absolute path is rejected before runtime launch |
| Node engine range parser produced `NaN` | Sort supported numeric versions rather than coercing `node-22` labels directly | Node engines fixture selects node-22 |
| Profile resource defaults overwrote Java settings | Profile values are fallback values; defaults only fill missing fields | Java memory, disk, and timeout test |
| Windows Sandbox/Hyper-V looked available although lifecycle was not executable | Report detected and executable separately; unsupported lifecycle reports unavailable | Source assertions and provider capability checks |
| Docker bridge fallback could imply unrestricted egress | Reject all non-`none` policies until a controlled egress proxy exists | Fake adapter confirms fail-closed behavior |
| Docker image pull used host daemon network without separate gate | Require `sandboxNetwork` permission before pull | Fake Docker test confirms no create/pull occurs before challenge |
| Container workspace may be unwritable to non-root runtime user | UID/GID 1000 tmpfs, narrow CHOWN capability, manager-side ownership normalization after copy-in | Fake CLI argument/command verification; real daemon still required |
| Pending export directories could accumulate | Unique staging paths and cleanup after replacement, successful apply, or destroy | Sandbox lifecycle test verifies applied staging path is removed |

## Permission and data-flow properties

- Sandbox create, execute, copy-in/out, export, stop/destroy, and profile operations continue to use the existing server-side 3.11 permission and approval-token system.
- Export apply remains approval-controlled and requires a complete recovery checkpoint before the first workspace file mutation.
- Sandbox-generated data is staged for review before it can be written to the actual workspace.
- Secrets and ignored directories are excluded from the initial snapshot and rejected from export.
- The mock provider remains explicitly test-only and is not automatically selected.
- Network remains disabled for Docker containers. Unsupported egress profiles are rejected, not silently mapped to Docker bridge networking.

## Verification results from this audit runtime

`npm run verify:all` completed with exit code **0**.

| Suite | Result |
|---|---:|
| Server hardening | 27 passed |
| Provider registry | 25 passed |
| Main application verification | 161 passed |
| 3.10 regression | 62 passed, 1 skipped |
| 3.11 security | 147 passed |
| Sandbox regression | 74 passed, 1 provider unavailable |
| 3.12.8 focused adapter tests | 16 passed |
| Browser bridge | included in full suite; all emitted checks passed |
| Desktop packaging checks | 25 passed |

**Total:** 626 passed, 0 failed, 1 skipped, and 1 provider-unavailable notice.

The skipped test requires public internet/DNS access. Docker/Podman was not installed in this audit runtime, so real Docker end-to-end execution was reported unavailable; fake CLI tests cover argument construction and manager interaction only. Fake Wasmtime tests validate the adapter contract, not a real Wasmtime installation.

## Packaging metadata

- The portable builder now prints the current `3.12.8` release version; the Bengali build guide names `CodeSpace-Portable-3.12.8.exe`.
- No Windows EXE was compiled in this Linux audit runtime.

## Remaining release acceptance on Windows

Before relying on Docker sandbox execution for untrusted code, run `npm run verify:sandbox` and `npm run verify:3128` on a Windows machine with Docker Desktop running. Confirm that the Docker daemon creates the container with the requested security options, the copied workspace is writable by UID 1000, a sample project builds/tests, and destroy removes the container and staging data.

Windows Sandbox and Hyper-V must remain marked non-executable until their full create/execute/copy-out/destroy lifecycle is implemented and verified on the target Windows edition.
