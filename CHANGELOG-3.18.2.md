# CodeSpace 3.18.2 — Runtime reliability and verification fixes

- Fixed sandbox command timeout handling. Previously, terminating a shell process could leave its child processes alive and keep stdout/stderr pipes open, causing requests and verification runs to hang.
- Added process-tree termination: POSIX commands run in a dedicated process group and are terminated as a group; Windows uses `taskkill /T /F` with a direct-child fallback.
- Updated the legacy 3.10 permission-catalog assertion from 16 to the current 17 definitions, including the dedicated `nativeCode` permission. This corrects the test expectation; it does not change the user's permission settings.
- Bumped the application/PWA release versions so existing clients refresh the updated static bundle.
- Preserved the existing CodeSpace layout, extension marketplace, permission control placement and clean UI.
