# CHANGELOG 3.13.4 — No-Git GitHub Fallback, Extension Details View

Version: 3.13.4
Date: 2026-11-04
Based on: 3.13.3 (recommended extensions, + GitHub install, workspace jail)

## 1. GitHub repo installs work without git

The complaint behind this release: `/ext/install` and `/skills/install` refused to install
anything from GitHub when git was not on PATH ("git is not installed, so repositories
cannot be cloned"). Fixed with a real fallback, not a message:

- New `repoToDir(url, tmp)` is the single way both installers put a repository on disk.
  It runs `git clone --depth 1` when git exists; otherwise — and also when a clone fails —
  it downloads the repository archive from `https://codeload.github.com/<owner>/<repo>/zip/HEAD`
  and unpacks it with Node's built-in zlib. No new dependencies, no shell.
- The ZIP extractor (`unzipArchive`) is a small central-directory reader in the same style
  as the VSIX metadata reader. Hardened by design:
  - only stored (0) and deflate (8) entries; symlinks are never created;
  - zip-slip guard — entries containing `..` or absolute paths are skipped;
  - limits: 200 MB archive, 100 MB per file, 400 MB total uncompressed, 20 000 entries;
  - zip64 entries are skipped rather than mis-read.
  Nothing in the archive is ever executed — the flows still just scan for
  `extension.json` / `SKILL.md`.
- `owner/repo`, full GitHub URLs and `…​.git` URLs all fall back; non-GitHub URLs without
  git keep the original clear error. If git clone fails AND the archive download fails,
  the error names both failures.
- Both installers now return `via: 'git' | 'zip'` so the UI/tests can tell which path ran.
- `CODESPACE_DISABLE_GIT=1` simulates a machine without git (support/debugging); the
  splash `git:` status and `/info` report it faithfully.
- The "+ GitHub" box hint now says the fallback exists.

## 2. Clicking an installed VS Code extension now shows what it actually is

The report: "I downloaded GitHub Copilot Chat, clicking it should open Copilot Chat but
nothing happens." The honest truth is that it *cannot* open — marketplace downloads are
stored `.vsix` packages, and VS Code extensions need VS Code's own extension host (plus,
for Copilot Chat, a VS Code sign-in and a Copilot subscription). CodeSpace extensions are
the MCP ones (`extension.json`). The old card did nothing on click and never said any of
this. Now:

- Clicking an installed `.vsix` card opens an inline **details view**: the extension's
  description, publisher · version · package file · size, the required VS Code engine
  (e.g. "Requires VS Code ^1.95.0"), and a clear note that VS Code extensions cannot run
  inside CodeSpace, pointing to "+ GitHub"/`npm:` MCP extensions as the ones that do.
  Clicking again closes it; a caret shows the state.
- Server: `vsixMeta` now also reads the description (vsixmanifest `<Description>` /
  package.json `description`) and `engines.vscode`, merging both manifest entries in
  whatever order they appear in the archive; `/ext/marketplace/installed` returns
  `description` and `engines` per card.
- The Installed section got a one-line hint up front (MCP extensions run here; .vsix
  downloads are stored packages) so expectations are set before clicking.

## Verification

- New unit tests (`scripts/test-unzip.js`): deflate + stored + nested dirs extract;
  `../` and `..\` zip-slip entries skipped; symlink-only archive throws without creating
  anything; corrupt archive throws; EOCD still found with a trailing ZIP comment.
- Live end-to-end, real backend + real GitHub, twice per scenario (approval-token
  handshake included): with `CODESPACE_DISABLE_GIT=1` the real `anthropics/skills`
  repository installs through the archive path (`via: 'zip'`), SKILL.md files land intact
  on disk, the token is single-use (replay refused), the ext flow correctly reports
  "No extension.json found" after extracting, and a non-GitHub URL keeps the git-missing
  error. With git enabled the same install runs `via: 'git'`. Marketplace download and
  the enriched card meta verified live (Python extension: description + engines
  `^1.95.0`).
- Real-browser check (headless Chromium): the fixture card renders as
  "GitHub Copilot Chat · v0.27.1 (1 KB)", clicking opens the details view (description,
  "GitHub · v0.27.1 · …vsix · 1 KB", "Requires VS Code ^1.95.0", the stored-package note),
  toggling works, Uninstall removes the card and deletes the package file.
- Suites: verify.cjs **173/173** (7 new 3.13.4 checks), server hardening **31/31**,
  sandbox **74**, bridge **89/89**. `node --check agent-server.js` clean; web bundle and
  the portable single-file HTML rebuilt (syntax-checked in the build).
- Splash line: `v3.13.4 — No-Git GitHub Fallback, Extension Details View`; PWA cache
  version bumped.
