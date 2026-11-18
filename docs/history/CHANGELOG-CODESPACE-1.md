# CodeSpace — Browser & Branding Update

- Rebranded the app title, PWA manifest, browser chrome and bridge logs to **CodeSpace**.
- Added a startup splash with a vector CodeSpace mark and the requested “Wellcome Mr. Rabiul / and Your Son: Arham” message. The splash dismisses automatically and has an Open CodeSpace button.
- Agent Chrome is now the default website mode. Embedded Live page remains available for sites that allow iframe embedding.
- New/legacy settings default to a visible browser and persistent local profile so users can complete security verification themselves. Existing `.my-agent` storage paths are retained for backward compatibility.
- When Cloudflare/CAPTCHA verification is detected, the UI tells the user to complete it in the visible browser. No security-check bypass is implemented.
- Updated PWA icons and cache version.

## Validation

JavaScript syntax, project regression checks, bridge mock tests, PWA icon/manifest checks, and ZIP integrity are run before release. Live browser visits to third-party sites were not executed in this build environment.
