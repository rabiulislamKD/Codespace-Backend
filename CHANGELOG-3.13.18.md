# CodeSpace 3.13.18 — startup fix (splash stuck)

## Fixed
- **Desktop app stayed on the welcome/splash page and never opened the workspace.** The bundle
  crashed during startup with `Uncaught TypeError: Cannot assign to read only property 'hidden'
  of object '#<Object>'` at js/app.js 3834.
  - Cause: `src-js/15-editor.js` called `updateBrowserModeUI()` at bundle top level, and it
    assigned `window.myAgentDesktop.browser.hidden = …`. Electron's contextBridge exposes every
    property to the renderer as a read-only snapshot (getter/setter accessors are flattened), so
    the assignment threw and the app IIFE aborted at fragment 15 — before the splash-close code
    in fragment 21 and before `loadAll()` / `connectBridge()` ever ran. Web (non-Electron) tests
    never saw it because `DESKTOP_EMBED` is false there.
  - Fix: all three `browser.hidden = …` assignments now call the bridge-safe `setVisible()`
    (already the convention in `syncNativeBrowserBounds`), and the dead `get/set hidden`
    accessor was removed from `desktop/preload.cjs` so the trap cannot come back.

## Hardening
- Startup safety net in `my-chat-agent-v3.html`: if any future startup error kills the bundle,
  an inline script force-closes the splash after 8s so the workspace is never permanently
  hidden behind the welcome screen.
- `verify-desktop.cjs` gained a regression check: the renderer must never assign to a
  contextBridge-exposed `myAgentDesktop` property, and the preload must not re-introduce the
  `hidden` accessor.

## Verification
- Real Electron 45 run (Xvfb): splash closes, menu bar / explorer / chat / status bar render,
  bridge connects, zero console or page errors.
- `node verify-desktop.cjs` → 15/15 passed (incl. the new guard).
- `node verify-menubar.cjs` → 43/43 passed.
