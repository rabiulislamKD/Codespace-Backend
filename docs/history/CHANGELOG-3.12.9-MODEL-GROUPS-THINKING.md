# CodeSpace 3.12.9 — Strict Model Groups & Thinking-Level Reliability

Release: **3.12.9**  
Base: **3.12.8**  
Scope: correct Free/Paid model classification and make reasoning/thinking controls explicit, model-aware, and observable. Existing agent, browser, sandbox, MCP, extension, Git, and task architecture is preserved.

## Model group correction

- Free models now means **only model IDs whose final suffix is exactly `:free`** (case-insensitive).
- Provider tags such as Cline `free tier`, zero/missing manually entered prices, local endpoints, and model IDs that merely contain the word `free` no longer put a model in the Free group.
- All other model IDs appear under **Paid models (no :free suffix)**. This is intentionally not a billing claim: local and provider free-tier models may still appear in this group if their ID does not end in `:free`.
- The selected model is preserved; model IDs and provider IDs are not changed.

## Thinking-level behavior

- `Think: Off` sends no global reasoning-effort field.
- `Think: Fast`, `Balanced`, and `Deep` map to `low`, `medium`, and `high`.
- OpenRouter Chat Completions use the documented unified `reasoning: { effort }` field.
- Other OpenAI-compatible providers, including the Cline provider adapter, receive `reasoning_effort`.
- Provider model-catalog metadata is retained where available (`reasoning.supported_efforts`, `supported_parameters`, and common explicit reasoning capability flags).
- OpenRouter models without advertised reasoning controls are marked unsupported; per-model allowed effort levels are enforced.
- OpenRouter dynamic `openrouter/free` and `openrouter/auto` routers reject manual effort selection because their underlying model is not stable.
- A provider/model rejection of reasoning parameters is now surfaced explicitly. CodeSpace no longer silently retries without the requested thinking parameter.
- A compact composer status reports: unsupported, reasoning data returned, or not verified. A successful response without reasoning data is not described as proof that the requested effort was applied.
- Capped multi-agent advisory calls skip extended reasoning to keep helper calls fast.

## Verification

- Added `verify-models-thinking.cjs` and included it in `npm run verify:all`.
- Coverage includes strict `:free` suffix classification, zero-price provider misclassification, catalog reasoning metadata, Cline/OpenAI-compatible request fields, OpenRouter reasoning fields, unsupported effort blocking, Think Off, explicit rejection handling, reasoning-token feedback, and advisory-call behavior.
- The new deterministic model/thinking suite passes **28/28** in the packaging environment.
- Cline's public API model documentation exposes `supportsReasoning` and documents streamed `delta.reasoning` / `delta.reasoning_details`; its Chat Completions parameter table does not explicitly document a reasoning-effort input field. CodeSpace sends the OpenAI-compatible `reasoning_effort` hint, surfaces an explicit rejection (including HTTP 200 SSE errors), and reports reasoning as unverified unless reasoning data/tokens are returned. Exact effort-level enforcement still requires a live Cline API key and model/provider confirmation; this cannot be proven by a local request-construction test alone.

## UI and packaging

- Add a compact thinking-status indicator beside the Think selector.
- Update selector labels/tooltips to describe suffix-based grouping and provider-dependent reasoning support. The paid-side label means only 'not marked with :free', not an authoritative billing classification.
- The selected Think control now takes precedence over conflicting `extraBody` reasoning fields; Think Off removes global reasoning fields.
- Treat reasoning-parameter rejection inside HTTP 200 SSE as non-retryable and report it instead of retrying as a transient network error.
- Recognize Cline `delta.reasoning` and opaque `delta.reasoning_details` as returned reasoning signals without rendering encrypted details.
- Correct an IPv6 `fe80::/10` link-local classification error in the existing SSRF guard and strengthen its regression assertion.
- Bump package version to 3.12.9 and PWA cache identifier.
- Update the portable EXE build script and Bengali build guide output filename.

## Important behavior note

The Free group is now based on the literal `:free` model-ID suffix, as requested. It is not a general real-world billing detector. A provider's separate Free-tier badge in the provider gallery is unchanged and does not classify every model from that provider as free. Cline's documented model capability indicates whether a model supports reasoning output; it does not by itself prove that a selected effort value (low/medium/high) was honored.
