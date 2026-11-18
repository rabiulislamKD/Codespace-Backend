# Phase 3Z1 — Windows OpenCode CLI Fix (Full Package)

- Fixed Windows CLI resolver handling so a native `.exe` is not accidentally passed to Node.js as JavaScript.
- Kept `.cmd`/`.bat` launchers compatible with Windows command execution.
- Preserved the complete Phase 3Z package, including `pwa/manifest.webmanifest`, `pwa/sw.js`, PWA icons, `verify.cjs`, and `verify-opencode-bridge.cjs`.
- No intended UI redesign or PWA removal.

## Validation scope
Syntax and mock CLI bridge checks are source-level/local automated checks. A live Windows OpenCode launch still must be confirmed on the user's machine.
