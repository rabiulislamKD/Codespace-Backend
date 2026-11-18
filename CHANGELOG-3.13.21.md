# CodeSpace 3.13.21 — Copilot fallback, model groups, browser overlap, Z.ai bridge

## CodeSpace Copilot
- Name is now just **CodeSpace Copilot** everywhere (model menu, status bar, messages, docs). "Auto fallback" is gone.
- **Fallback really switches now.** Root causes fixed:
  - OpenRouter-style in-stream errors carry the status in `error.code` and a generic "Provider returned error"; CodeSpace read neither, so the error was not recognised as a limit and the turn ended. Status and `metadata.raw` are now parsed.
  - An empty HTTP 200 reply was returned as success; it now switches to the next model.
  - A model that accepted the request and never answered froze the turn; a 60 s stall watchdog now abandons it.
  - Any error except Stop (including 400/422 and a bad key on one provider) moves on to the next model inside the pool. If all fail, the most useful error is reported with the list of tried models.
  - A paid active model was tried first in auto mode; it is now excluded from the pool and never swapped.
- The answering model is recorded in the chat (was always the originally selected one) and a note says when Copilot switched.
- The provider "Test connection" button tests that provider itself, not a Copilot substitute.

## Free / Paid model groups
- New grouped, searchable model menu (the native select popup was squeezed to the 96–150 px composer slot, which cut off group headers and model names). Groups: Copilot, **Free models (n)**, **Paid models (n)**; sticky headers, provider shown next to each model, keyboard navigation.
- Chat Z.ai models are Free (they were listed under Paid) and are listed only while Chat Z.ai is ON.
- The strict 3.12.9 rule is kept: only `:free` IDs (and Chat Z.ai) are Free.

## Integrated browser overlapping
- The native browser view draws above all page UI. Only dialogs and the menu bar were treated as overlays. Now also: model menu, permission menu, context popover, explorer context menu, splitter drags (side panel, chat, terminal), and the view reacts in the next frame instead of the 400 ms audit tick.
- The native rectangle is clipped to the window and to every scrolling/clipping ancestor, so a short window no longer spills the browser over the terminal, status bar and chat.
- Reloading the app hides the native view immediately instead of leaving it over the splash screen.

## Chat Z.ai bridge
- Agent history is flattened to plain turns (tool results, assistant tool calls with null content, multi-part content, `developer` role) and the latest user turn is signed.
- A rejected session (401, or 403 about signature/token) refreshes the session once and signs the request again.
- Stop now cancels the upstream request; an idle watchdog (120 s) and a 15-minute limit end stuck streams with a clear error; a mid-stream break is reported to the client instead of ending as if complete (so Copilot can switch).
- Unknown model triggers one model-list refresh. Port-in-use and server errors are reported to CodeSpace instead of a silent exit.
- Not verifiable offline: live signature acceptance by chat.z.ai (needs a signed-in session).

## Quota exhaustion (added)
- `insufficient_quota`, "Quota exceeded", credit-balance and usage-limit errors are per account. Copilot now skips the rest of that provider's models (one request instead of one per model), moves to other providers, and if every provider is out reports "Quota exhausted for <provider> … check quota/reset date or add another provider" instead of the "temporarily unavailable, try again in a minute" message.
