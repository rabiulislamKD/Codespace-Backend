# CodeSpace 3.13.8 — Chat Z.ai composer mode

## Added
- Added a Chat Z.ai ON/OFF switch to the lower chat-composer toolbar.
- Added a local loopback adapter for the `chat.z.ai` guest web experience, with dynamic model discovery and OpenAI-compatible streaming responses.
- Added bridge-token authentication for adapter requests and lifecycle management from the existing Agent Bridge.
- Added automatic provider/model selection when enabled and restoration of the previously selected provider when disabled.
- Added integration verification for composer wiring, bridge routes, authentication, and model transport.

## Requirements and limitations
- Requires Google Chrome or Microsoft Edge and `npm install` on the build machine before creating the portable EXE.
- Uses undocumented `chat.z.ai` website internals, not the official `api.z.ai` developer API. The upstream website may change its signature module or endpoints without notice; live behavior must be checked against the current website.
- The adapter binds only to `127.0.0.1` and checks the CodeSpace bridge bearer token. Guest access is subject to the website's availability and limits.
