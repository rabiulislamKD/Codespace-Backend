# CodeSpace 3.9.6 — Free / Paid model groups in the chat composer

## What changed

The model selector in the chat composer (`#provQuick`) now groups every model into two
top-level `<optgroup>` sections instead of one section per provider:

- **Free models** — providers whose input and output prices are both 0 (the typical
  setup for llama.cpp, Ollama, LM Studio, vLLM and other local servers), plus any
  OpenRouter-style `:free` model that appears inside a paid provider.
- **Paid models** — every provider with per-token prices configured
  (Settings → provider → Input/Output price, USD per 1M tokens).

Details:

- Because the two groups span providers, each option is prefixed with the provider
  name (`OpenRouter · anthropic/claude-sonnet-4`); the option tooltip explains the
  free/paid classification.
- Group labels show a model count: `Free models (4)`, `Paid models (2)`.
- Empty groups are hidden: if nothing is free, only the Paid section is rendered,
  and vice versa.
- Option values are unchanged (`providerId::model`), so saved settings, active-model
  restoration and the status bar (`Model: …`) keep working without migration.
- The selector tooltip now documents the grouping.

## Files

- `my-chat-agent-v3.html` — rewrote `fillQuick()`; added `FREE_MODEL_ID` pattern and
  `isFreeProvider()` helper; updated the `#provQuick` title.
- `package.json` — version 3.9.6.
- `pwa/sw.js` — cache version bumped to `codespace-pwa-16-free-paid-model-groups`
  so PWA clients pick up the new shell.

## Verification

- Inline script block passes `node --check`.
- Functional test (`scripts/test_fill_quick.js`, run against the extracted
  `fillQuick()` with a stubbed DOM): unpriced providers land in Free, `:free`
  models inside paid providers land in Free, priced models/providers land in
  Paid, no model appears in both groups, the active selection is preserved.
- `node verify.cjs` — 106 checks PASS (no regressions).
- `node verify-providers.cjs` — 25 checks PASS.
