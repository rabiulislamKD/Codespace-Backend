# CodeSpace 3.13.16 — Copilot without time limit, clean UI

## CodeSpace Copilot (auto fallback)
- **No cooldown / no time limit.** When a model reaches its limit, CodeSpace switches to the next available model immediately. Nothing is blocked for minutes any more.
- New selectable model **CodeSpace Copilot · Auto fallback** (top of the model list). Any `:free` model, and Chat Z.ai models while Chat Z.ai is ON, can be used as a replacement. Paid models are never added automatically.
- Selecting a normal `:free` model still falls back automatically; selecting a paid model never switches silently.
- Fixed: with a single free model, one rate limit no longer locks out every following message.
- Fixed: mid-stream errors (busy, timeout, network error) now switch model instead of failing the turn.
- Also switches on "model not found / no endpoints" (404). Invalid API keys never switch provider.
- The last model that answered is tried first (kept in memory only, no timer), so a limited model is not hit again on every round.

## Clean interface
- Removed the instruction/description paragraphs from Checkpoints, Codebase, Models, Skills, Plan, Settings and the Browser.
- The browser blank tab is now empty; the desktop app no longer shows a render-mode picker.

## Cleanup and security
- Removed 12 unused `chat-zai-api-*` files (old API attempt, referenced by nothing).
- Chat Z.ai Chrome now runs with its sandbox ON (it is only disabled for root on Linux).

## Verification
- `verify-copilot-fallback.cjs`: 10 checks (immediate switch, no lockout, single model, in-stream errors, auth, abort, auto mode).
- Not exercised: live providers and live chat.z.ai (need network and your accounts).
