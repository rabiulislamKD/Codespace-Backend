# CodeSpace 3.13.25 — One-click Repair

## Run menu
- Added a clean, text-only `Repair CodeSpace` action to the Run menu.
- Added a subtle `?` hover hint; instructions remain hidden until the user hovers the hint/menu item.
- The action starts the agent directly with a complete CodeSpace + opened-workspace diagnosis and repair workflow.
- The workflow checks the running installation path, bridge, tools, providers, terminal sessions, browser integrations and project health; it then plans, repairs and verifies the smallest safe changes.
- Existing workspace boundaries, Git-aware preservation, checkpoints and tool/file/command approval gates remain in force. It never silently edits an external source folder or packaged binary.

## Verification
- See `verify-one-click-repair.cjs` and `verify-menubar.cjs` for UI and wiring checks.
