# CodeSpace 3.13.14

## Installed Tools Manager
- Added a dedicated Installed Tools activity-bar page.
- AI tool installations are recorded in the local CodeSpace data directory with source, detected version output, optional uninstall/update-check/update commands, and timestamps.
- Added update checks and optional update actions. Every terminal command is shown for approval and still passes through the server-side terminal permission gate.
- Added installation, update-check, update and uninstall history.
- Uninstall removes the manager record only after the approved uninstall command succeeds.

## Extensions page cleanup
- Removed VS Code Marketplace/VSIX results from the CodeSpace Extensions page because those packages require VS Code's extension host and cannot run inside CodeSpace.
- The page now installs CodeSpace-compatible extensions from repositories containing `extension.json`.
- Installed extension rows show only name, version and Uninstall.
