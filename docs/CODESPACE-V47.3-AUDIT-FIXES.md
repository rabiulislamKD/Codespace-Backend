# CodeSpace Android v47.3 — multi-area audit and fixes

## Scope

This release addresses the reported problems:

- AI in a server sandbox (Render / GitHub) cannot use device-local tools or the integrated browser.
- Tapping the menu raises the soft keyboard first.
- The chat input/transcript is covered by the soft keyboard.
- The integrated (native WebView) browser overlaps other UI elements.
- Broken browser bridge navigation, approval handling, capability gating, devtools/CDP and screenshots.

## Root causes found

### 1. Sandbox modes routed device tools to the remote server
`bridgeUrl` was used as a proxy for “where the tool lives”. In Render/GitHub modes every browser,
bridge and terminal call went over HTTPS to the remote `agent-server.js`, even though the Android
app already implements those endpoints in `MainActivity.localApiCall()`.

The app also advertised or hid browser tools purely from remote `/info.browser`, which is normally
`false` on a headless Render/Codespace server. A late Chrome-extension connection never refreshed
that capability.

### 2. Soft keyboard and layout
- No `windowSoftInputMode` was declared; WebView defaults allowed the keyboard to appear over the UI.
- `setBusy(false)` unconditionally focused the composer at startup and after every turn.
- The menubar did not blur a focused field on touch devices (the model menu already did).
- `#app`/`#chatPane` did not adapt to an IME-resized viewport; the transcript was clipped.

### 3. Native browser overlap
The native browser is a real Android view drawn above every DOM layer, so DOM `z-index` cannot cover
it. The occlusion list missed `.cs-touch-context` and the absolutely-positioned mobile sidebar,
bounds used `window.innerWidth/innerHeight` instead of `visualViewport`, and `html.browser-fs`
had no CSS implementation.

### 4. Browser bridge / devtools / screenshot
- `browser_back`, `browser_forward`, `browser_reload` were dispatched but rejected as unsupported
  by the server and the Chrome extension.
- `bridgeRun()` ignored `needsApproval` challenges from `/bridge/call`, so the model could be told
  an action ran when the permission gate had blocked it.
- The native Android `web_screenshot` branch was unreachable: the generic switch case returned first.
- CDP could attach to the app UI WebView instead of the browser tab; UI-thread body draining could
  outlive its 5-second caller budget.
- `full_page` screenshots were silently treated as viewport screenshots.

## Changes

- Added explicit `deviceCapabilities` (browser/terminal/localFiles) to native `bridgeConfig()` and
  copied them into `L` in `nativeBridgeConfig()`.
- Routed `/bridge/status`, `/bridge/call`, `/browser/close`, `/browser/diagnostics` to the device in
  all sandbox modes; routed `/run` and `/term/*` to the device when an Android folder is active.
- Browser tools are now advertised from the device capability as well as `/info.browser`.
- Replaced Local-only browser/CDP gates with device-capability checks; late bridge connections
  refresh `/info`.
- Added `back`/`forward`/`reload` to server `BRIDGE_ACTIONS` and extension `HANDLERS`.
- `bridgeRun()` completes the single-use browser permission handshake and never reports a challenge
  as success.
- `web_screenshot` now falls through to the native Android browser path and reports that full-page
  capture is not available there.
- CDP target selection prefers an exact URL match and excludes `android_asset` app-UI targets;
  CDP enable retries briefly; body capture has a 3s total / 600ms per-request budget.
- Added `windowSoftInputMode="adjustResize|stateHidden"`, touch-menu blur, no auto-focus of the
  composer on coarse pointers, keyboard-safe CSS and real `html.browser-fs` CSS.
- Added occlusion handling for `.cs-touch-context`, the mobile sidebar drawer and `visualViewport`.

## Verification

- Unit tests: **273/273 passed** (`node --test tests/*.test.js`), including 11 new v47.3 tests and
  expanded native-bridge routing tests.
- `verify-android-browser-agent.cjs`: 12/12
- `verify-android-editor-debugger.cjs`: 16/16
- `verify-android-browser-devtools.cjs`: 29/29
- `verify-desktop.cjs` (core): 22/22
- `verify-android-touch-interactions.cjs`: 13/13
- Debug APK: **BUILD SUCCESSFUL**, versionCode 31853 / versionName 3.19.1-android-v47.3.

Nine project verification scripts still fail on **pre-existing stale assertions** (hard-coded
3.18.5 version labels, canonical-vs-Android HTML drift, ABI expectations) unrelated to this change.
`verify.cjs` still reports the known desktop-Chromium failures. No physical device verification was
performed.

## Artifacts

- `/sdcard/Download/CodeSpace-v47.3.apk`
- `/sdcard/Download/CodeSpace-v47.3-full-source.zip` (378 files)
- `/sdcard/Download/CodeSpace-v47.3-changed-files.zip` (22 changed/new files)

## Device checklist

1. Install the v47.3 APK.
2. Open a server sandbox (Render/GitHub) and ask the AI to use `browser_open` /
   `browser_screenshot`. It should drive the on-device CodeSpace Browser.
3. Open the menubar: the keyboard should not appear first.
4. Focus the chat input: the composer and typed text should stay visible above the keyboard.
5. Open a menu/dialog over the browser: the native browser should hide behind it.
6. Try `browser_devtools action=enable` after opening a browser tab.
7. If anything still fails, share `/sdcard/Download/codespace-diagnostics.txt` and
   `/sdcard/Download/.codespace-opencode/opencode-exec-v44.log`.

## GitHub push status

**Not pushed.** The temporary clone/credentials from earlier releases are gone and no GitHub token
is available in this environment. The previously pasted PAT must be treated as compromised and
revoked. Provide a freshly generated token (repo scope on `rabiulislamKD/Codespace-Backend`) and the
v47.3 changes will be committed and pushed to `main`.
