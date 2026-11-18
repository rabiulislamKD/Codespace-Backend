# 3.18.3 — folder opening, browser white flash, composer overlap

- **Open folder** — the Explorer header "Open folder" button is removed. Folders are now opened from one place,
  `openFolder()`: **File > Open Folder…**, the Explorer's empty state and the command palette all call it. It uses the
  operating system's folder dialog (Electron dialog in the desktop app, platform picker through the bridge, browser
  directory picker without the bridge); the in-app folder dialog is only a last-resort fallback. A second click while a
  dialog is open is ignored. Hint texts and server error messages now say "File > Open Folder".
- **White screen over websites** — opening a menu, a dialog or dragging a splitter has to hide the native browser view
  (it always paints above page content), which left a blank white panel. The main process now captures the current
  frame, hides the view and returns the frame (`browser.hideWithSnapshot()`); the page shows it in `#bSnap` until the
  overlay closes, then removes it after the native view is visible again.
- **Chat composer** — the option rows (mode / model / thinking / toggles / context ring) wrap instead of running under
  the send button. The permission menu is anchored to the composer card and sized to it, and the shield button no longer
  carries a page-level `z-index`, so neither can overlap neighbouring windows.
- PWA cache bumped to `codespace-pwa-60-…` so installed copies pick up the new UI.
- **Composer toolbar redesign** — row 1: `Mode · Model · Engine`, row 2: `Attach · Permissions · Think · Saver · Context ring`.
  - **Engine dropdown**: the separate OpenCode and Chat Z.ai switches are merged into one dropdown (CodeSpace / OpenCode / Chat Z.ai).
    The existing start-up, install and switch-back logic is unchanged (`toggleOpenCode`, `toggleChatZai`, new `setRoute`).
  - **Think** is shown only when the active model supports a thinking mode (catalog data, then provider type, then known reasoning
    model names) and is hidden while OpenCode answers. When it is hidden, no reasoning parameter is sent.
  - **No status text** in the toolbar: "Think: … · reasoning returned" and "Working… round n" are gone (details moved into tooltips).
  - One 26 px pill style; the model name shrinks with an ellipsis, labels collapse to icons in narrow panes, wrapping is the last resort.
