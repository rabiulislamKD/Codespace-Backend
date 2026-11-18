# CodeSpace 3.13.10 — Google sign-in handoff

- Google authentication popups and top-level redirects are detected in the embedded browser.
- Instead of opening only the OAuth popup (which can break `window.opener` / `postMessage`), CodeSpace opens the originating website in the OS default browser so the complete sign-in flow runs there.
- Shows a clear notice that the user must continue using that external browser for the signed-in website; browser cookies are intentionally not copied into CodeSpace.
- Removed User-Agent and Client-Hints rewriting and retired the old `guest-patch.cjs` fingerprint modification.
- Embedded browser security settings remain sandboxed, with Node integration disabled and context isolation enabled.
- Live Google sign-in must be tested on Windows with Chrome/Edge; Google controls the final authentication policy.
