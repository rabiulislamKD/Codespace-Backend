# CodeSpace Android v47.6 — browser address bar, blank screen, long-press fix

## What you reported
- The browser address bar could not be tapped or typed into.
- Resizing the page or tapping in the browser made the page area blank.
- Long-pressing text showed both Android's copy menu and CodeSpace's own “Attach to chat” popup.

## Root causes
1. **Address bar:** the Android HTML shell removed the DOM address row (`bAddr`/`bGo`) and relied on a native `EditText` that was never attached to the view hierarchy. The JavaScript navigation handlers existed, but there was no visible input to trigger them.
2. **Blank page:** the native WebView was hidden whenever `browserPanelShown()` reported a collapsed/zero rectangle or any overlay was detected. A resize, fullscreen toggle, keyboard shift or transient layout pass produced a zero rect, so the WebView was set to `GONE` and only the white `#bview` background was left. The fullscreen CSS rule also targeted `html.browser-fs #bview .chrome-ui`, which never matches because the chrome is a sibling of `#bview`.
3. **Double menu:** `WebView.setOnLongClickListener` opened a custom CodeSpace `PopupMenu` and returned `false`, so Android's native selection/context menu appeared at the same time.

## Fixes
- Restored the browser address/nav row in the Android HTML: Back, Forward, Reload, an editable **address field**, Go, and a new **📎 Attach** button. Enter in the address field navigates. The lock/info icon now follows the loaded URL. The native page WebView is bounded strictly below this row, so it cannot cover the input.
- Browser visibility is now stateful. A transient zero-size rect reuses the last known-good bounds instead of hiding the native page. When a real menu/dialog must cover the page, a snapshot of the current frame is shown in place of the WebView, then removed when the overlay closes. Fullscreen preview no longer clips the page to scrollable ancestors, and the fullscreen chrome CSS selector is corrected.
- Removed the custom long-press popup for page text/elements. Long press now produces only Android's normal copy/selection menu. To attach content, select text and tap **📎**, or tap **📎** with no selection to attach a bounded page excerpt. Long-pressing a browser tab still closes that tab as before.

## Verification
- Unit tests: **288/288 passed** (3 new v47.6 browser-UI tests).
- Debug APK: **BUILD SUCCESSFUL**, versionCode 31856 / `3.19.1-android-v47.6`.
- Physical device verification was **not** performed.

## Artifacts
- `/sdcard/Download/CodeSpace-v47.6.apk`
- `/sdcard/Download/CodeSpace-v47.6-full-source.zip` (382 files)
- `/sdcard/Download/CodeSpace-v47.6-changed-files.zip`
- `/sdcard/Download/CODESPACE-V47.6-BROWSER-UI-FIX.md`

## What to test
Install v47.6, open the preview panel, type `example.com` in the address field and press Enter. Resize/rotate the panel, tap in the page, and toggle fullscreen — the page should stay visible. Long-press text: only Android's copy/selection menu should appear. Select text and tap 📎 to attach it to chat.
