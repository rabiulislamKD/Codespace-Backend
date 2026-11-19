# OpenCode model case fix — v47.2

## Reported error (v47.1)

`Model unavailable: Opencode/big-pickle (provider.no-route)`

The v47.1 classifier was correct — this is a model-selection problem, not quota — but the CLI
still rejected the run.

## Root cause (confirmed with the real CLI)

OpenCode model ids are **case-sensitive in the provider prefix**:

| Id passed to CLI | Result |
|---|---|
| `Opencode/big-pickle` | exit 1, `provider.no-route`, `Model unavailable: Opencode/big-pickle` |
| `opencode/big-pickle` | exit 0, normal answer (`OK`) |

The discovered list contains lowercase `opencode/big-pickle`. A capitalized `Opencode/` prefix
cannot be routed. The model part may still contain uppercase (e.g. `…-Free`), so the whole id
must not be lowercased.

## Fixes in v47.2

- On save, `openCodeAuthSet()` maps the entered id to the **exact** id from the last model
  discovery when they match case-insensitively; otherwise it lowercases only the provider prefix.
- `openCodeModels()` self-heals an existing saved mis-cased id on the next model refresh, so
  `Opencode/big-pickle` in an already-installed app becomes `opencode/big-pickle` without you
  re-entering it.
- `fillOpenCodeQuick()` resolves a mis-cased current/previous selection to the exact discovered
  option instead of showing it as unavailable.
- `provider.no-route` gets a specific diagnosis: "no provider route — check the exact id and
  casing", plus "Ids are case-sensitive and the provider prefix is lowercase". It is still
  classified as a model error — no key rotation, no quota advice.

## Device action

Install the v47.2 APK, open the OpenCode model selector (refresh once if needed), and confirm
`opencode/big-pickle` is selected. The saved value is corrected automatically on refresh.

## Verification

- Controlled real-CLI runs: `Opencode/big-pickle` → `provider.no-route`;
  `opencode/big-pickle` → exit 0 with a text answer.
- `node --test tests/opencode-silent-execution-v47.test.js` — 28/28 pass (`[7i]`, `[7j]` added).
- Full suite — 260/260 pass. Android debug build successful.
