# CodeSpace 3.9.5 — Composer redesign, thinking level, faster agent tool loop

## 1. Chat box (composer) redesign

- The composer is now a rounded card with a subtle shadow and an accent focus ring when the input has focus.
- New circular gradient send button (round red Stop button while the agent works), consistent 24 px toolbar controls, clearer hover states.
- Shorter placeholder (`Ask the agent… (@ to attach)`) so it never clips to a second line.
- The toolbar under the input is reorganized into two fixed rows:
  - Row 1: Mode (Agent / Multi / Ask) · Agent permissions · Model · OpenCode toggle
  - Row 2: Attach (＋) · Thinking level · Saver toggle · status text · context ring

## 2. All options always visible, no wrapping

- Removed the old container-query rules that **hid** controls (model selector, Saver, mode, context ring) when the chat pane was narrow.
- The chat pane can be dragged down to its 320 px minimum and every option stays visible; the toolbar rows use `flex-wrap: nowrap` and `white-space: nowrap`, so no control or label ever wraps to a new line.
- At minimum width the model name and the status text shrink with ellipsis instead of disappearing (hover a control for its full tooltip).

## 3. Thinking level selector

- New **Think** dropdown in the composer toolbar: `Off · Fast · Balanced · Deep` (saved in settings, restored on start).
- OpenAI-compatible providers: the level is sent as `reasoning_effort` (`low` / `medium` / `high`). If a provider rejects the parameter, it is removed automatically and the request is retried once.
- Anthropic models: the level maps to an extended-thinking budget (`Fast` = 2,048 · `Balanced` = 8,192 · `Deep` = 16,384 tokens). `Off` keeps the previous behavior (per-provider extended-thinking checkbox in Settings → provider details still works).
- Disabled while OpenCode CLI mode is active (OpenCode manages its own model and reasoning).

## 4. Faster file inspection / read / write

- `read_file` now returns up to **1,100 lines / 56 KB** in one call (was 400 lines / 20 KB), so large files no longer need three read rounds.
- The `read_file` tool description tells the model about the larger window so it reads the range it needs in a single call.
- New SPEED RULES in the agent system note:
  - read a file once with the full range instead of several small reads;
  - batch independent read-only calls (`list_files`, `read_file`, `search_files`, `code_search`) in the same round so they run in parallel;
  - skip narration for routine read-only calls (narration is now only requested before edits/commands);
  - never re-read a file that was already read.
