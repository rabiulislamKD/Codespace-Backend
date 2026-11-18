# CodeSpace 3.13.9 — Chat Z.ai persistent session

- Added a dedicated persistent Chrome/Edge profile under the CodeSpace data directory.
- First use opens a visible Chat Z.ai browser window so the user can sign in once; no manual session-token copying is needed.
- Later runs reuse the saved browser profile and read the current session token only inside the browser context.
- HTTP 401 recovery reloads chat.z.ai without deleting localStorage, preserving account login and allowing first-party renewal.
- Updated startup timeout and user-facing reauthentication guidance.
- Does not borrow the user's normal browser profile or expose session tokens through the local API.
- Limitation: website-required CAPTCHA, verification, expired credentials or undocumented API changes can still require manual sign-in.
