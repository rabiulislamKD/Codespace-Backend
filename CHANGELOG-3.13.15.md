# CodeSpace 3.13.15 — CodeSpace Copilot Auto Fallback

- Added **CodeSpace Copilot** automatic fallback across configured free model variants.
- Fallback eligibility is strict: only model IDs ending exactly in `:free` are candidates.
- On rate-limit, quota, temporary overload, or model-unavailable responses, CodeSpace switches to the next configured free model without restarting the turn.
- Free-model HTTP rate-limit/overload responses are not held in the normal multi-retry backoff; fallback can begin immediately.
- Conversation messages, system prompt, tool definitions, thinking settings, and cancellation signal are carried into the replacement request.
- Partial failed streams are not committed as chat history or executed tool calls; the replacement model regenerates the response.
- Models that hit a limit are temporarily skipped for 10 minutes to prevent repeated selection loops.
- The status line identifies the feature as **CodeSpace Copilot** and shows the active replacement model.
- Usage attribution records the actual fallback provider/model.
- Invalid-key/authentication failures do not trigger a blind provider switch. HTTP 403 only triggers fallback when the response indicates a quota/rate limit.

## Validation

- `verify-copilot-fallback.cjs`: 5 scenario groups passed (candidate filtering, error classification, successful fallback, all-models-exhausted handling, cancellation safety).
- `npm test`: 84/84 passed.
- `tools/build-web.cjs`: bundle rebuilt successfully.
- Live provider quota exhaustion and multi-provider streaming were not exercised against real API accounts; those depend on the user's configured provider credentials and live limits.
