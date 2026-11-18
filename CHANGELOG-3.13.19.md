# CodeSpace 3.13.19 — Integrated Browser fixes and Chat Z.ai inside CodeSpace

## 1. Fixed: the Integrated Browser covered other panels (occlusion bug)

The Integrated Browser is a native `WebContentsView` owned by the main process. By design it
draws **above every DOM layer** of the window, so whenever it stayed visible while the user was
looking at something else, that something else was hidden behind the website.

What could go wrong before this release:

- Calling `updateBrowserModeUI()` set the native view's visibility from the render mode alone.
  Agent tools call this through `bShow()` even when another tab is active (`web_screenshot` does
  `showPanel(false); bShow(r)`), which floated the website over the file editor until something
  else re-synced visibility.
- Modal dialogs, the command palette and open menu dropdowns have no layout event of their own,
  so nothing ever hid the native view while they were open — the website covered them.

Fixes in `src-js/15-editor.js`:

- New single source of truth `browserPanelVisible()`: the native view may only be visible when
  the render mode is `embedded`, **and** the Preview tab is the active tab with the panel shown,
  **and** the browser surface has real dimensions, **and** no overlay is open.
- New `browserOverlayOpen()` detects open `<dialog>` elements and the menubar dropdown.
- `updateBrowserModeUI()` now uses `browserPanelVisible()` instead of the bare render mode.
- A 400 ms audit tick re-syncs bounds and visibility even when no resize/scroll/tab event fired;
  an internal change-detection cache (`lastNativeSync`) makes it free when nothing changed.

Result: switching to any other panel, opening Settings, using the command palette or a menu now
always takes visual precedence over the website; the browser returns automatically when you go
back to the Preview tab.

## 2. chat.z.ai now opens inside CodeSpace (no external browser window)

- New **Run > Open chat.z.ai** menu item opens `https://chat.z.ai/` in the CodeSpace Integrated
  Browser panel (web/PWA mode falls back to a normal new tab).
- Clicking the **Chat Z.ai** toggle no longer needs a visible external Chrome window for
  sign-in. If the bridge cannot start because no session is known yet, CodeSpace opens
  chat.z.ai in the Browser panel automatically with instructions; sign-in happens there.
- On desktop the Chat Z.ai bridge Chrome now runs **headless** (invisible) whenever a captured
  session exists, so no external window ever appears.

## 3. Automatic chat.z.ai session capture

- While the Integrated Browser is on any `z.ai` page, CodeSpace checks the site's own
  `localStorage` session token every 2.5 s (desktop only). When the user signs in — or the
  session renews — the new token is pushed once to the local agent-server via the authenticated
  bridge (`POST /chat-zai/token`) and a chat note confirms the capture. The token is never
  rendered, logged, or stored in the chat transcript.
- The agent-server keeps the token **in memory only**, exposes just a boolean
  (`sessionCaptured`) in `/chat-zai/status`, validates the JWT shape, and rate-limits the
  endpoint (30/min). It forwards the token to the bridge process: via environment on start and
  via IPC (`session-token` message) while the bridge is already running — a fresh sign-in
  revives a running bridge without restarting it.
- `chat-zai-proxy.js` seeds the harvested token into its own invisible profile before use and
  accepts live session updates from the server.

## 4. Packaging and verification

- `verify-desktop.cjs` gained four regression suites: overlay-aware native-view visibility,
  integrated chat.z.ai opening + harvester wiring, the `/chat-zai/token` endpoint (including a
  "token is never logged" check), and headless bridge operation with the harvested token.
- PWA cache version bumped to `codespace-pwa-45-zaibrowser-31319`; app version 3.13.19.
