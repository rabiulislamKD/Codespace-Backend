# CHANGELOG 3.13.0 — Live Activity Feed, Modern Steps & Message Actions

Version: 3.13.0
Date: 2026-11-03
File changed: `my-chat-agent-v3.html` (single-file app)

## Why

User feedback on 3.12.9:

1. The live AI working preview showed only ONE line: the feed kept only **6 rows**, truncated every line to **160 characters**, forced one-line ellipsis, faded old rows to 25% opacity, and collapsed as soon as the run finished — so you could not read what the AI was doing.
2. The working-step design looked dated (plain bordered rows, no animation, no status feedback).
3. The single **"Edit & regenerate"** button both edited AND auto-ran the agent (deleting later history after a confirm). The user wants Edit to ONLY edit, plus a Copy action on user messages and AI replies.

## Live activity feed (`#maActivityPanel` / `ma-feed`)

- **Every line stays.** `MA_FEED_MAX_ROWS` raised from 6 → 400 (a safety bound, not a visible cap). No line disappears while the model works.
- **Full text.** The 160-char `slice()` in `feedPush`/`feedSet` removed; new `MA_FEED_MAX_CHARS = 4000` per line (~25x more readable text). Feed rows now `white-space:pre-wrap` + `word-break:break-word` instead of one-line ellipsis, so reasoning tails, tool details and the "Writing response" tail wrap across multiple lines and are actually readable.
- **Stays until the model stops.** The card never hides while a run is active. After the run ends it stays fully readable for **8 seconds** (auto-hide moved from 1.5s → 8s), then slides away. The feed also only clears when the NEXT run starts, not while you read.
- **Readable thinking.** `reasoningSnippet` now shows a long tail (≈900 chars) of the reasoning instead of a 110-char crumb; the writing tail in `feedRound` keeps ≈1500 chars.
- **Modern card design.** Glass-style rounded card with soft shadow, accent status orb with pop-in ✓/! states, status word pill (Thinking / Working / Reviewing / Done…), a live **elapsed-time counter** (`maActivityElapsed` + `startMaElapsedTicker`), and a slim close button.
- **Own scrollbar.** The feed has a thin custom scrollbar (`max-height:min(42vh,380px)`), auto-follows the newest line, and stops auto-following when you scroll up to read (`feedPinScroll` + `overscroll-behavior:contain`). Chat auto-scroll no longer fights the user (`chatIsNearBottom()` guard in `feedPush`).
- Panel markup simplified (hidden kicker/mark/name/dot/counter elements removed; elapsed counter added). `paintMultiAgentLine` updated to match.

## Working steps (`.steps` / `.step`)

- **Modern animated cards**: rounded 11px card with soft shadow, gradient summary bar, chevron rotate transition, slide-in animation for every new step (`step-in`), fade-slide for step bodies (`step-body-in`).
- **Running state is visible**: animated accent **progress rail** on top of the card while any step runs (`.steps:has(.spin)::after`), running-step row gets a soft accent gradient glow, spinner redrawn in accent color.
- **Status icons animate**: ✓ / ! / ✕ pop in with a springy scale animation (`st-pop`).
- **Icon chips**: tool icons sit in rounded 22px chips, color-coded by action kind (edit = amber, command = violet, browser = blue) via `data-kind`.
- **Badges polished**: diff `+N / −N` badges now tinted green/red pills; duration badge pill style.
- Works in both the base theme and the Copilot-style chat layout (the old border-stripping override was replaced so the card survives there too).

## Message actions

- **"Edit & regenerate" → "Edit"** (user messages): `editMessageOnly(m)` loads the message text back into the composer, focuses it, and stops there. No history deletion, no confirm dialogs, no automatic regeneration. (The old `editAndRegenerate` remains in the file unused, in case a separate "Regenerate" action is wanted later.)
- **Copy on user messages**: `copyMessageText` writes the raw text to the clipboard, shows "✓ Copied" for 1.4s, falls back to `execCommand('copy')` on non-secure contexts (portable EXE / http).
- **Copy on AI replies**: every `addAssistantText` message gets a Copy button that copies the raw markdown source (not the rendered HTML).
- New `.uact` ghost-button styling (quiet pills, hover reveal, focus ring, `.is-copied` success state).

## Notes

- Splash version line updated to `v3.13.0 — Live Activity Feed, Modern Steps & Message Actions`.
- All JS re-validated (`node --check` on the full script block: pass). Stale-element check: no JS references removed DOM ids.
- A standalone animated preview is available at `preview/index.html` (simulated run, real buttons, dark/light toggle, replay) — it uses the exact CSS shipped in this version.
