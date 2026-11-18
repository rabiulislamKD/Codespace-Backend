# CHANGELOG 3.13.1 — Dot-Timeline Steps, Icon-Free Chat, Multi-File App

Version: 3.13.1
Date: 2026-11-03
Based on: 3.13.0

## Why (user feedback on 3.13.0)

1. **"In chat do not use any icon… still work step design not good — not use any icon here, you can use point here."**
   The working steps still used tool icon chips (emoji), ✓/!/✕ status glyphs and a "›" chevron. All of it is gone. Every status in the chat is now a colored **point** (dot).
2. **"In website show icon — not need to change it."**
   Icons outside the chat (activity bar, toolbar, dialogs, terminal, provider lists, the agent activity log) are untouched.
3. **"We should split my-chat-agent-v3.html into multiple files so it is easy to maintain and fix bug error."**
   The 7,608-line single file is now a small entry page + real CSS files + JS source fragments with an automatic builder.

## Chat is now icon-free — the dot language

- **Working steps = dot timeline.** Each step is a row on a vertical connector rail with one status point:
  running = pulsing accent dot with a soft ping ring (tinted by action kind: edit amber / command violet / browser blue),
  done = green dot, warning = amber dot, error = red dot (with a subtle glow). Points pop in with a spring animation; new steps slide in.
- **No icon chips, no ✓/!/✕, no emoji** in step rows (`buildStep`/`fillStep` render CSS dots), no "›" glyph — expand/collapse affordances are geometric chevrons drawn with CSS borders (steps card, thinking blocks, task plan).
- **Steps summary** shows `Working · 4 steps · 1 file edited` with the shimmer effect while running, plus the animated progress rail on the card edge.
- **Live activity feed**: status orb is a dot (pulsing while working, solid green when done, red on failure, hollow when cancelled); feed rows use dots (live pulsing, green done, red error, hollow skipped); the close "✕" is drawn with two CSS bars. No glyphs anywhere.
- **Task plan panel**: `☷` glyph → accent dot; `⌄` → CSS chevron; ✓/●/!/○ marks → CSS points (green done / pulsing in-progress / red blocked / hollow pending).
- **Message actions**: `⧉ Copy` → **Copy**, `✏️ Edit` → **Edit**, `✓ Copied` → **Copied** (green). Plain words only.
- **Change bar** ("N files changed") lost its ✏️; background-task feed lines lost their ✔/✕ prefixes.
- The AI avatar is now a clean gradient dot (the ✦ glyph was removed).

## Multi-file architecture

    my-chat-agent-v3.html      entry page — 603 lines (was 7,608)
    css/01-base.css … 07-extras.css     7 stylesheets, split at section boundaries
    src-js/01…21 + 99          22 JS source fragments (the real source of truth)
    js/app.js                  built bundle — assembled from src-js automatically
    tools/build-web.cjs        builder (dependency-free; syntax-checks before writing)
    BUILD-APP.bat              one-click rebuild on Windows
    CodeSpace-single-file.html optional export with everything inlined

- **Byte-identical rebuild**: `header + fragments + footer` reproduces the original script exactly — the split changed zero runtime behavior (verified: reassembly equality + acorn parse of every fragment + browser boot with no console errors).
- **Auto-rebuild**: `agent-server.js` calls `tools/build-web.cjs` `ensure()` before serving `/js/app.js`; edit any fragment, refresh the app (or restart) — no manual step. A syntax error fails loudly instead of silently shipping.
- **Static routes** added for `/css/*` and `/js/app.js`; the PWA service worker caches them offline (`SHELL` updated, cache version bumped).
- **Electron packaging** unchanged (`asar:false`, `**/*` includes the new folders).
- Verify scripts (`verify.cjs`, `verify-desktop.cjs`, `verify-bridge.cjs`, `verify-providers.cjs`, `verify-models-thinking.cjs`) now read the combined sources, so `npm run verify:all` still passes — **161/161 checks green**.
- Four stale verify checks were updated to assert the 3.13.x live-feed behavior (every line readable, 8s readable window after the run) instead of the old collapse-at-finish design.

## Keep

Everything from 3.13.0: full-text live feed with own scrollbar and auto-follow, Edit-only (no auto-regenerate) with Copy on user and AI messages, glass activity card with elapsed timer.

## Notes

- Splash line: `v3.13.1 — Dot-Timeline Steps, Icon-Free Chat, Multi-File App`.
- A standalone animated preview is at `preview/index.html` (CSS inlined verbatim from the real files; Replay / theme toggle).
