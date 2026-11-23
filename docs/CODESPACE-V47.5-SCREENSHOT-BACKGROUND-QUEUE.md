# CodeSpace Android v47.5 — screenshot, background AI, and queued messages

## Problems found

1. **Blank AI screenshots.** The Android screenshot tool used `WebView.draw(Canvas)`. The in-app browser is a native view that is `GONE` whenever the panel is hidden or a dialog/overlay is open. A hidden WebView can still report non-zero width/height while having no live compositor frame, so `draw()` returned a white/blank JPEG. There was no pixel validation and no DevTools capture path.
2. **No app-owned background keepalive.** The AI orchestration runs inside `MainActivity`'s WebView. The app only had narrow foreground services for Node scripts and the UWB file bridge. Nothing held the CodeSpace process/CPU alive while an AI turn was active, so Android could freeze timers and native callbacks after the screen turned off or the user left the app.
3. **Second messages were dropped.** The composer's single-flight guard returned immediately when `ctrl` (an active run) or `sendPreparing` was set. The input was disabled, so users could not type, and pressing Enter during preparation did nothing. There was no queue.
4. **Remote sandbox gap.** Device screenshot failures had no server fallback, and server screenshot failures had no Chrome-extension fallback. `browser_screenshot` also rejected the new capture source labels.

## Fixes

### Screenshots
- Added `AndroidWebViewCdp.capturePageJpeg()` using `Page.captureScreenshot` (JPEG, 70 quality, 12s budget).
- Added CDP target reuse/reconnect so the capture targets the AI-opened page, not the app's own UI WebView.
- Screenshot action now tries **CDP first** (works even when the browser overlay is hidden), then forces the WebView visible for one frame and uses `View.draw()` as a fallback, restoring the prior visibility afterwards.
- Added luminance-spread validation. A flat/white/black frame is rejected instead of being returned to the AI as a successful screenshot.
- `browser_screenshot` accepts `browser`, `cdp`, and `browser-draw` sources.
- Remote sandbox fallbacks: device → remote `/web/screenshot` → connected Chrome extension.

### Background AI
- Added `AiRuntimeService`, a data-sync foreground service with a partial wake lock.
- Every AI turn starts it via `setBusy(true, …)` and stops it via `setBusy(false, …)`. Works in Local, Free-server, and GitHub sandbox modes; available through both the native JS interface and `/ai/background`.
- Added `POST_NOTIFICATIONS` request on Android 13+, `WAKE_LOCK` permission, and service declaration in the manifest.
- The notification says the AI agent is working. For aggressive OEM battery managers, disable battery optimization for CodeSpace if a long background run still stalls.

### Messages during a run
- The composer stays enabled while the agent works.
- Sending a message during an active run queues it **in order**; the hint shows `N queued message(s)` and “you can keep typing”.
- Queued messages are sent automatically as soon as the current run finishes.
- Pressing **Stop** cancels the active run and clears the queue, so nothing is sent unexpectedly.

So: your message will be **waiting (queued)**, not sent immediately into the live run. This avoids two runs mutating the same workspace at once.

## Verification

- Unit suite: **285/285 passed**, including 7 new v47.5 regression tests.
- Debug APK: **BUILD SUCCESSFUL**, versionCode 31855 / `3.19.1-android-v47.5`.
- No physical Android device verification was performed.

## Artifacts

- `/sdcard/Download/CodeSpace-v47.5.apk`
- `/sdcard/Download/CodeSpace-v47.5-full-source.zip` (381 files)
- `/sdcard/Download/CodeSpace-v47.5-changed-files.zip`
- `/sdcard/Download/CODESPACE-V47.5-SCREENSHOT-BACKGROUND-QUEUE.md`

## Device instructions

Install v47.5, open the app, answer the notification permission prompt, and allow battery optimization exemption if requested by your device. Ask the AI to open a page and take a screenshot; it should now return the page image even if the browser panel is hidden. While it works, type another message and press Send — it will be queued and sent automatically when the run ends.
