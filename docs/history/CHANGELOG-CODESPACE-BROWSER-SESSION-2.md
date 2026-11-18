# CodeSpace Browser Session Update

- Removed `--disable-extensions` and `--disable-background-networking` from Agent Chrome launch.
- Removed CDP user-agent and timezone overrides; do not disguise browser identity.
- Kept persistent profile support for cookies/session continuity.
- Bumped PWA service worker cache to `codespace-pwa-12-browser-session`.
- Added regression checks for browser launch flags, identity overrides, and persistent profile.
- Cloudflare/CAPTCHA remains user-verified; no challenge bypass added.
