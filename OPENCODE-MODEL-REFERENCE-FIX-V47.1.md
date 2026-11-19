# OpenCode model-reference and discovery fix — v47.1

## Reported symptoms

1. `OpenCode model list could not be loaded: OpenCode CLI did not return a model list. Check the CLI in Settings → OpenCode CLI.`
2. `OpenCode CLI provider error. The OpenCode provider returned an error. Invalid model reference: big-pickle (unknown) Your selected model and configuration were kept. This is a provider quota/availability error, not a missing model or an installation problem.`

## What is actually wrong

- OpenCode model IDs are `provider/model`. The installed CLI's own list contains
  `opencode/big-pickle`; a bare `big-pickle` is rejected by the CLI with
  `Invalid model reference: big-pickle (unknown)`.
- The v47 error formatter appended the same closing sentence to every provider error, so an
  invalid-model error was incorrectly described as a **quota/availability** error and as
  "not a missing model". That is factually wrong and hides the real fix.
- Model discovery had no fallback: if `opencode models --standalone` produced no parseable
  `provider/model` lines (unsupported flag on some CLI builds, one-shot service issue, or
  unparseable output), the UI only saw the generic "did not return a model list" message.

## Fixes in v47.1

- `formatProviderError()` now chooses the closing advice by error category:
  - quota/rate-limit/billing → quota advice (unchanged for `provider.free-limit`);
  - credentials → check the saved API key;
  - invalid/unknown model reference → choose an available `provider/model` from the list;
  - other → neutral message.
- `looksLikeQuotaFailure()` explicitly returns `false` for model-reference errors, so **no key
  rotation** is attempted for a bad model id.
- `openCodeAuthSet()` rejects bare model names on save with the message
  `OpenCode needs a provider prefix. Use provider/model, for example opencode/big-pickle.`
  (Existing bad values are not silently changed.)
- `fillOpenCodeQuick()` warns when the saved model has no provider prefix.
- Model discovery retries once **without** `--standalone` if the first command yields no
  `provider/model` ids, and reports distinct diagnoses for "no output" vs "output but no
  provider/model entries". Diagnostics remain free of prompts, keys and auth headers.

## What to do on the device

1. Settings → OpenCode CLI → Model: enter **`opencode/big-pickle`** (not `big-pickle`).
   Use a model from the discovered list when the list loads.
2. Refresh the OpenCode model list. If it loads, Free/Paid groups appear as before.
3. If the list still fails, send `/sdcard/Download/.codespace-opencode/opencode-exec-v44.log`
   and `/sdcard/Download/codespace-diagnostics.txt`; the new `models-discovery failed ...`
   line records state, exit code, output line counts and parse count.

## Verification

- `node --test tests/opencode-silent-execution-v47.test.js` — 26/26 pass, including
  `[7g]` invalid-model classification and `[7h]` discovery/validation hardening.
- Full regression suite and Android debug build results are in the delivery message.
