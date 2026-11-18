# CodeSpace 3.13.13 — AI Tool Installer

## Added
- Added the `install_tool` agent capability for missing CLIs, SDKs, runtimes, compilers, libraries, packages and GitHub projects.
- Agent guidance now requires environment detection, official-source research, minimal installs and post-install verification.
- Installation previews show purpose, source, working folder, exact command and optional verification command.
- Installation and verification each require separate user approval and pass through the existing server-side terminal permission gate.
- Added activity labels for tool installation.

## Safety
- The dedicated installer blocks common unreviewed remote-script pipe patterns, administrator/sudo elevation and PowerShell execution-policy weakening.
- It does not silently install tools. The user sees and approves the exact command.
- The model is instructed to prefer workspace/project-local installs and to inspect the official source first.

## Verification
- `verify-tool-installer.cjs`: 14/14 checks.
- JavaScript syntax checks and rebuilt `js/app.js`: passed.
- Full Windows Electron build and live installation against external GitHub/package registries: not run in this environment.
