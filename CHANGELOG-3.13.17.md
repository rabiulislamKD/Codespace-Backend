# CodeSpace 3.13.17 — menu bar, polished theme

## New
- **Menu bar** (File, Edit, Selection, View, Go, Run, Terminal, Debug, Help). Every entry calls an existing action; mouse and keyboard (arrows, Enter, Esc) both work.
  - Run > **Run Active File** saves the file and runs it in the terminal (node, python, bash, PowerShell, cmd, go, ruby, php, perl, lua; HTML opens in the browser). File names are shell-quoted, so a hostile file name cannot run commands.
  - Debug: browser console, network requests, action history, reload app.
- **Status bar** now uses the theme: a slightly darker shade than the sidebar (dark and light), with readable text and an accent hover. No more bright blue.
- **Readable text colors** in both themes (higher contrast body and muted text), themed scrollbars, selection color, focus rings, softer buttons and dialogs.
- Removed the last two empty-state descriptions (chat, code viewer).

## Bugs fixed
- Command palette "Preview console" and "Preview network" called a function that did not exist.
- Desktop: the default Electron menu is removed (it would duplicate the new menu bar); F12 and Ctrl+Shift+I still open DevTools.

## Verification
- New `verify-menubar.cjs` (43 checks). Tested in headless Chromium against the real bridge: connect, open/edit/save/run a file, all 50 menu items, keyboard navigation, theme switch, phone width. No JavaScript errors.
