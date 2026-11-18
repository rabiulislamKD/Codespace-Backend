# Portable EXE packaging setup — 3.7.1

- Added an Electron desktop shell for Windows x64.
- On launch, the shell starts `agent-server.js` using a bundled, standalone Node.js runtime; the user does not need to start the server manually.
- The app waits for the authenticated loopback API to become ready before opening the window.
- A generated per-run bridge token is injected through an isolated Electron preload; page code gets no Node.js APIs.
- The UI's saved bridge settings are overridden by the desktop-provided local URL/token so the UI automatically connects.
- `MY_AGENT_DATA_DIR` lets the server persist `.my-agent` data beside the portable executable.
- Added a build script that downloads official Node.js 22 x64 `node.exe` and checks its SHA-256 manifest before packaging.
- Added `BUILD-PORTABLE-EXE.bat`, electron-builder configuration, and desktop package checks.

No Windows EXE was built in this Linux session. Packaging must be run on Windows x64 as described in `README-PORTABLE-EXE-BN.md`.

## CodeSpace 3.12.9 — Model Groups & Thinking-Level Reliability

See `CHANGELOG-3.12.9-MODEL-GROUPS-THINKING.md` for strict `:free` model grouping, model-aware thinking controls, Cline/OpenRouter request handling, explicit provider rejection status, and updated model/thinking verification. The portable Windows EXE must still be built on Windows x64 using `BUILD-PORTABLE-EXE.bat`.

## CodeSpace 3.12.8 — Sandbox Security & Reliability

See `CHANGELOG-3.12.8-SANDBOX-SECURITY-RELIABILITY.md` and `SECURITY-REMEDIATION-3.12.8.md` for the full sandbox-export hardening, provider corrections, Docker workspace ownership handling, and verification limitations. The Windows portable EXE itself must still be built on Windows x64 using `BUILD-PORTABLE-EXE.bat`.
