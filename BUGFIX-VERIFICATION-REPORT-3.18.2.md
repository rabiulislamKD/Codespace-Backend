# CodeSpace 3.18.2 — Bug-fix and regression verification report

## Scope
Patched the uploaded `CodeSpace-3.18.0-production-cleaned-updated.zip` source, including its existing 3.18.0.1 maintenance fixes. This release fixes a reproducible sandbox timeout/process-tree defect and corrects one stale legacy verification assertion. This report records tests actually rerun in the Linux build environment. It does not claim that all possible defects in all Windows configurations have been eliminated.

## Confirmed defects fixed
- Sandbox timeout previously killed only the immediate shell process. A child process could survive, retain stdout/stderr handles, and prevent the API request from completing. The sandbox manager now starts POSIX commands in a dedicated process group and terminates the whole group on timeout; on Windows it uses `taskkill.exe /T /F`, with a direct-child fallback.
- The legacy 3.10 verification script expected 16 permissions although the current catalog correctly contains 17, including `nativeCode`. The assertion now matches the current schema.
- Existing 3.18.0.1 fixes retained: renderer startup crash, `getWordRangeAtPosition` infinite-loop regression, multi-edit application correctness, Range/Selection compatibility, extension child-process environment hardening, extension process cleanup, workspace glob matching and diagnostics regressions.

## Verification rerun
- Node unit tests: **106 passed, 0 failed**.
- Main application verification: **164/164 passed**.
- Server hardening: **31 passed**.
- Provider and relay verification: **25 passed**.
- 3.10 end-to-end verification: **62 passed, 0 failed, 1 skipped** (public-web test skipped because outbound DNS is unavailable).
- 3.11 security verification: **147 passed, 0 failed, 0 skipped**.
- Sandbox lifecycle/security verification: **74 passed, 0 failed, 0 skipped**; Docker/Podman provider end-to-end was unavailable on this host and was explicitly reported as unavailable, not counted as passed.
- 3.12.8 focused sandbox verification: **16 passed**.
- Model/thinking: **30 passed**.
- Chat Z.ai: **6 passed**.
- Browser bridge: **89/89 passed**.
- Desktop packaging checks: **22/22 passed**.
- Integrated browser checks: **8/8 passed**.
- OpenCode installer: **18 passed**.
- Tool installer: **14/14 passed**; tool manager: **12/12 passed**.
- Menubar: **43/43 passed**.
- Self-repair: **11/11 passed**; one-click repair: **11/11 passed**; agent recovery: **10/10 passed**.
- Task Center: **15/15 passed**; UI cleanup: **17/17 passed**.
- VS Code Marketplace compatibility: **23/23 passed**; Marketplace server integration: **10/10 passed**; Node extension host: **58/58 passed**.
- All **78** JavaScript/CJS files passed `node --check`.

## Environment limitations
- Docker/Podman was not installed, so a real container provider could not be exercised. The test explicitly reports this as unavailable; mock provider tests are labelled NON-ISOLATED and were not treated as production isolation.
- The Windows-specific `taskkill /T /F` branch was code-reviewed but cannot be executed on this Linux host.
- Electron/Windows visual launch was not available in this environment.
- Live Open VSX registry search/download was not verified against the live network in this environment.
- The package-level `verify:all` aggregate exceeded the execution window; constituent suites were run separately and the suite results above reflect completed individual runs. The independent npm unit-test command also completed successfully.

## Conclusion
The reproducible sandbox timeout defect found in this pass is fixed, and the completed individual regression suites reported no failing assertions. A clean run in the target Windows environment, with Docker Desktop/Podman and live network access where needed, remains necessary before claiming environment-wide compatibility.
