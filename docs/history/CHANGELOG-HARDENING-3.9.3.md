# 3.9.3

Fixes
- A request body of `null` or a JSON array crashed into an internal error message; now a clear 400 ("must be a JSON object").
- A non-text or NUL-containing `path` was accepted (creating names like "[object Object]"); now rejected.
- A request over 5 MB dropped the connection with no explanation; now a proper 413 and nothing is written.
- OpenCode key endpoint silently ignored a non-text key; now an error. A provider id such as `constructor` no longer hides from the saved-keys list (prototype lookup).
- Embedded-browser "new requests only" could miss a request that finished in the same millisecond as the last check (counter instead of timestamps).

Improvement
- If the computer has no Node.js on PATH, commands and terminals can still run `node` from the Node that runs CodeSpace (appended last, so an installed Node wins). The bundled Node has no npm.

Tests: verify-server-hardening.cjs (new, 16 checks).
