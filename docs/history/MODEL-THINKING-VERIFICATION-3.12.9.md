# CodeSpace 3.12.9 — Model Groups & Thinking Verification

## Model grouping

The model selector classifies a model as Free only when its model ID ends in `:free` (case-insensitive). Every other model ID is placed in the separate `Paid models (no :free suffix)` group. The latter label describes the literal ID rule; it is not a billing guarantee. A local endpoint or a provider's separate free-tier offer can still be free while appearing in the second group.

## Thinking control

- Off removes the global reasoning-control fields.
- Fast / Balanced / Deep map to `low` / `medium` / `high`.
- OpenRouter Chat Completions receives `reasoning: { effort }`.
- Other OpenAI-compatible providers, including the Cline adapter, receive `reasoning_effort`.
- If model metadata says reasoning is unsupported, the request is blocked before dispatch.
- A provider rejection is shown to the user; CodeSpace does not silently retry with thinking disabled.
- The UI distinguishes returned reasoning data from unverified effort application. A reasoning delta/token signal confirms that reasoning data was returned, but it does not prove that the provider honored the exact requested effort level.

Cline's documented model capability and response fields can indicate reasoning support/output, but its Chat Completions parameter table does not explicitly document a standard effort-control field. Therefore, exact low/medium/high enforcement through Cline remains provider/model dependent and must be verified with the user's live Cline endpoint and selected model. Local deterministic tests verify request construction and handling, not upstream acceptance.

## Verification executed in the packaging environment

| Suite | Result |
|---|---:|
| Model grouping and thinking | 28 passed, 0 failed |
| Server hardening | 27 passed |
| Provider verification | 25 passed |
| Main verification | 161 passed |
| 3.10 regression | 62 passed, 0 failed, 1 skipped (public network test unavailable) |
| 3.11 security | 147 passed, 0 failed |
| Sandbox | 74 passed; Docker end-to-end unavailable because no Docker daemon is installed on this host |
| 3.12.8 regression | 16 passed |
| Bridge | 89 passed |
| Desktop | 25 passed |
| OpenCode installation checks | 18 passed |

JavaScript syntax checks passed for the server, sandbox manager, and new model/thinking verification suite.

`npm run verify:all` did not complete reliably in this audit environment when all suites were chained; it hung during the 3.11 suite. The suites listed above were run individually. Do not interpret the independent results as a successful aggregate run.

No live request was made with the user's Cline API key. OpenRouter and Cline upstream acceptance of the requested effort must be tested in the user's configured environment.

No Windows portable EXE was compiled in this Linux packaging environment. Run `BUILD-PORTABLE-EXE.bat` on Windows x64 to build it.
