# CodeSpace 3.13.24 — installation self-discovery

## Find the running installation
- Added `codespace_locate_installation`, a read-only agent tool that reports the exact running CodeSpace app root, launcher executable, backend file, portable EXE directory, Electron resources and known source-file inventory.
- The desktop process passes its real Electron paths to the local backend. The backend does not guess from the current project or search the user's drives/home directory.
- `codespace_runtime_check` now includes the discovered installation root, launcher, portable directory and whether the editable source tree is present.
- The agent is instructed to use the discovered path when CodeSpace itself needs repair. If the source root is outside the opened workspace, it asks the user to open that exact folder; the workspace jail is not bypassed.
- Reports whether the install root appears writable, without writing a test file or modifying the installation.

## Verification
- `verify-install-location.cjs` tests the path resolver, portable-build metadata, known source inventory, bounded discovery and tool/route wiring.
- Existing permissions and approval prompts continue to govern commands and edits.
