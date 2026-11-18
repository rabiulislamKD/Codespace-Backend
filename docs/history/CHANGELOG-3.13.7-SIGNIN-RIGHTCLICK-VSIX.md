# 3.13.7 — Google sign-in hand-off, right-click everywhere, Install in VS Code

## Google "This browser or app may not be secure"
Google blocks sign-in inside every embedded browser (Electron, webviews, iframes); this is
Google's own policy, so CodeSpace does not try to disguise itself further. In Desktop the
`↗` button (and the "Open in your browser" hint) only copied the address to the clipboard.
It now really opens the page in the computer's default browser (Chrome/Edge/Firefox), where
Google sign-in works. The hint also appears while the embedded browser is on a Google page.
- `desktop/main.cjs`: `codespace:open-external` IPC (http/https only) using `shell.openExternal`.
- `desktop/preload.cjs`: `myAgentDesktop.openExternal(url)`.
- Website popups still never reach the system browser (verified by `verify-desktop.cjs`).

## Right-click works everywhere
Electron shows no context menu on its own, so only the file explorer and website pages had one.
The app UI now gets a native menu everywhere (chat box, editor, terminal, address bar, settings):
Undo/Redo, Cut/Copy/Paste/Select all, spelling suggestions, Copy link / Open link in your
default browser, Reload app, Inspect. The explorer keeps its own menu.

## VS Code Marketplace extensions
VS Code extensions need VS Code's own extension host and cannot run inside CodeSpace.
Each downloaded package card now has **Install in VS Code**, which runs
`code --install-extension <file>.vsix --force` against the real VS Code on this PC
(`POST /ext/marketplace/open-vscode`; file name validated, path must be inside the extensions folder).
