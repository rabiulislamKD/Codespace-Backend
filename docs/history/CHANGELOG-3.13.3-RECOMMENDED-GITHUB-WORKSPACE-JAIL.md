# CHANGELOG 3.13.3 — Recommended Extensions, Add from GitHub, Workspace-Only AI

Version: 3.13.3
Date: 2026-11-04
Based on: 3.13.2 (resizable side panel, VS Code Marketplace search + VSIX install)

## 1. Recommended extensions show immediately (Add Extension page)

- The page no longer opens onto an empty list that only fills after a search. The moment the
  Extensions view opens, the most-installed VS Code Marketplace extensions are loaded
  automatically and rendered under a small **Recommended** caption.
- Data source: the same public gallery API as before, queried with `sortBy: 4` (InstallCount,
  descending), target `Microsoft.VisualStudio.Code` only — i.e. the extension list VS Code
  itself shows in its default Extensions view.
- Typing a query switches to normal search; clearing the search box falls back to the
  recommended list. A stale-response sequence guard prevents an older search answer from
  overwriting a newer result.
- Server: `POST /ext/marketplace/search` accepts `{ recommended: true }` (no query) and caches
  the recommendation payload for 10 minutes in memory, so opening the page repeatedly does not
  hammer the gallery. Rate limit unchanged (40/min).

## 2. Installed extensions show their real name (+ Uninstall)

- Downloaded `.vsix` packages are now parsed and the **display name from the extension's own
  manifest** is shown, e.g. `Prettier — Code formatter · v11.0.0 (1.0 MB)` instead of the file
  name `prettier.prettier-11.0.0  (1.0 MB)`.
- Hovering a card shows the publisher and the package file name on the tooltip, so the
  identity is still available but never clutters the list.
- **Uninstall** button on every card (existing) deletes the package; both behaviors confirmed
  live end-to-end.
- Server: `POST /ext/marketplace/installed` reads `extension.vsixmanifest` (falls back to
  `extension/package.json`) out of each VSIX (a plain ZIP) with a small dependency-free
  central-directory reader + built-in zlib; the result is cached per file (size + mtime).
  Unparseable packages fall back to the file name. Nothing is executed — read-only parsing.

## 3. "+ GitHub" — clone an extension or skill repository

- A small **+ GitHub** button sits next to the Marketplace search box. It opens a compact
  "Add from GitHub" box with one input (full `https://github.com/owner/repo` URL or
  `owner/repo`) and two actions:
  - **Install as extension** — reuses the existing `/ext/install` git installer: clones the
    repo (depth 1), looks for `extension.json` in the repo root or up to 3 levels deep, and
    registers the MCP extension(s). Same approval flow as every other install
    (`ext` permission, dialog + server token).
  - **Install as skill** — reuses `/skills/install` with the repository source; the bridge
    clones the repo and installs the `SKILL.md` skills it finds. Same skill approval flow as
    the Skills page.
- Both flows are the exact code paths the Settings/Skills pages already used — no new
  server endpoints, no new trust surface; cloned repositories never run automatically.

## 4. The AI works ONLY in the folder you opened first (workspace jail)

The complaint: the model went searching in other folders when it could not find a file, even
though a folder was open in CodeSpace. Fixed on three layers:

- **System prompt**: a strict `WORKSPACE SCOPE` block is appended to the agent system prompt
  whenever a folder is open: work only inside the workspace root, never list/read/search/write
  outside it, use workspace-relative paths, and if something is not in the workspace say so
  and ask the user instead of wandering.
- **Server enforcement (read-only escape hatch)**: `/fs/list`, `/fs/read` and `/fs/search`
  now go through a workspace access check. Inside the opened folder everything works exactly
  as before. A path that resolves **outside** the opened folder is served only after the user
  approves it — new `outside` permission (default **ask**, listed in Permissions as
  "Work outside the opened folder"). The challenge flows through the standard single-use
  approval-token handshake, so the AI's request shows the regular approval dialog and the
  user decides per access.
- **Writes stay blocked**: `/fs/write`, `/fs/delete`, `/fs/editbatch`, undo/redo and history
  keep the hard workspace jail — outside paths are refused unconditionally with an
  `OUTSIDE_WORKSPACE: …` message that tells the model to stop and ask the user, never to
  search other folders. `run_command` cwd outside the workspace is refused the same way; the
  AI cannot change the workspace root (`/workspace/set` is not exposed as a tool).
- Client: the AI's `read_file` / `list_files` / `search_files` tool wrappers route through the
  approval helper, so an outside-path challenge becomes the standard dialog
  ("Read a file outside the opened folder?"); denial returns a clear message to the model.

## Verification

- `node --check agent-server.js` clean; web bundle rebuilt via `tools/build-web.cjs`
  (syntax-checked in the build) and the portable single-file HTML regenerated.
- All verification suites green: verify.cjs **166/166** (5 new 3.13.3 feature checks), server
  hardening **31/31** (5 new workspace-jail checks: challenge flow, single-use token, replay
  refusal, outside write still blocked, symlink asks), providers 25, models/thinking 28,
  sandbox 74, bridge 89, desktop 25, 3.10/3.11/3.12.8 suites unchanged. (The only 3.11
  failures are pre-existing environmental ones — no Chrome binary on the test host.)
- Live end-to-end (real backend + headless browser): Extensions page shows the Recommended
  list on open (Python 244M installs, Pylance, C/C++, …), search switches and clearing
  restores recommendations; installed card shows the manifest display name
  `Live Server · v5.7.9 (5.3 MB)` with tooltip publisher/file and a working Uninstall
  (real 5.4 MB `ritwickdey.liveserver-5.7.9.vsix` downloaded and removed); + GitHub box opens
  and the skill flow hits the real approval dialog ("Install this skill (server permission)?")
  with a clean denial message; outside-path `/fs/read` and `/fs/list` return
  `needsApproval (permission: outside)` and complete after one-time approval, while outside
  `/fs/write` stays refused (HTTP 400). Marketplace rows restructured: installs + rating moved
  onto the publisher line so full extension names stay readable in the narrow sidebar
  (titles clamp to two lines).
- Splash line: `v3.13.3 — Recommended Extensions, Add from GitHub, Workspace-Only AI`;
  PWA cache version bumped.
