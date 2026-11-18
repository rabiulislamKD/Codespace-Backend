# CodeSpace 3.13.20 — Chat Z.ai empty-reply fix (native request signature)

## 1. What you saw

Sending any chat message with the **Chat Z.ai** provider enabled failed with

> Request failed. Check the server, Base URL, model name and key in Settings. (The model returned an empty reply.)

The message was misleading: nothing was wrong with your Base URL, model or key — and the model
never actually answered.

## 2. Root cause

The Chat Z.ai bridge (local adapter on `127.0.0.1:9876`) signed its requests to `chat.z.ai` by
importing a **pinned CDN signature chunk** from frontend build `prod-fe-1.0.252`
(`_app/immutable/chunks/CAm9rDEa.js`). chat.z.ai has since moved to frontend `prod-fe-1.1.128`
(Vite bundle) **and rotated its signing algorithm**:

- old: signature helpers exported from a SvelteKit CDN chunk (`b0`/`b1`)
- new: an obfuscated inline signer —
  - payload = `{ timestamp, requestId, user_id }`, sorted by key, flattened with commas
  - `message = payload + '|' + base64(utf8(prompt)) + '|' + timestamp`
  - `window = floor(timestamp / 300000)` (5-minute window)
  - `k1 = HMAC-SHA256("key-@@@@)))()((9))-xxxx&&&%%%%%", window)`
  - `signature = HMAC-SHA256(k1, message)`

The old chunk still exists on the CDN and still exports `b0`/`b1`, so bridge startup **succeeded**
— but every signature was computed with the retired algorithm. The server answered with
HTTP 200 and a stream whose events the old parser did not recognise (error payloads and
full-content snapshots were silently dropped), so the bridge forwarded a valid-but-empty
OpenAI stream and the app threw *"The model returned an empty reply."*

## 3. Fixes in `chat-zai-proxy.js`

- **Native signer**: the current site algorithm is implemented directly with `node:crypto`
  (`HMAC-SHA256`, secret template + 5-minute window). No CDN chunk import remains, so a frontend
  update can no longer break the bridge.
- **Dynamic frontend version**: `X-FE-Version` is discovered at runtime from the live site
  (`prod-fe-X.Y.Z`) with `prod-fe-1.1.128` kept as last-known-good fallback.
- **Query parity**: the signed payload (`timestamp`, `requestId`, `user_id`) and the device query
  string are built inside the logged-in bridge page exactly like the site does; `user_id` comes
  from `/api/v1/auths/` and is cached/refreshed with the session.
- **Per-model endpoint**: `/api/models` metadata is retained; a model reporting
  `completion_version: "1"` is sent to `/api/chat/completions` with `model_item`, everything else
  to `/api/v2/chat/completions` (with a one-shot retry on the alternate path on 404).
- **Full stream parsing**: the consumer mirrors the site's own handler — `delta_content` appends,
  `content` is a full snapshot, `edit_content` splices at `edit_index` (site semantics) or appends
  the post-`</details>` part (legacy), thinking-phase deltas become `reasoning_content`, usage and
  tool calls are forwarded, web-search/citation events become references.
- **Errors are never silent again**: upstream error events (`data.error`, `type:"error"`), non-SSE
  error bodies and empty streams now surface as real errors that CodeSpace displays verbatim, e.g.
  *"Chat Z.ai returned no usable completion (Chat Z.ai reported: Signature validation failed)"* —
  with a hint to re-sign in via the integrated browser when the session is the problem.
- **Deferred stream headers**: nothing is written to the client until the upstream stream proves
  usable, so an empty upstream can no longer be delivered as a 200 with no content.

## 4. Verification

- New unit suite (`scripts/test-chat-zai-proxy.js`): 31 assertions covering the signer
  (determinism, message layout, multibyte prompts, window sensitivity), both legacy delta and
  full-snapshot stream formats, edit splices, error capture, tool calls, references and
  diagnostics. **31/31 pass.**
- `verify-desktop.cjs` gained three regression suites: no pinned CDN chunk + native signer,
  runtime frontend-version discovery, and full-snapshot parsing + empty-reply surfacing.
- All existing desktop packaging suites still pass.

## 5. Packaging

PWA cache bumped to `codespace-pwa-46-zaisign-31320`; app version 3.13.20. No renderer bundle
changes were required for this fix.
