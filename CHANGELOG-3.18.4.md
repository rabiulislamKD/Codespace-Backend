# 3.18.4 — text tool calls, plus a project-wide bug fix pass

## Tool calls written as text no longer end up in the report
- Some models (Qwen/GLM style, especially through the Chat Z.ai bridge) write a tool call as plain text instead of using the
  structured tool channel, and CodeSpace showed the raw XML as the final report without running it.
- `extractTextToolCalls()` in `src-js/10-model-adapters.js` now converts these into real tool calls and removes them from the
  visible text. Supported: `<tool_call><function=…><parameter=…>`, the Hermes JSON form `<tool_call>{…}</tool_call>`, and the
  bridge's own `[Called tool NAME with {json}]` form. Only tools that were offered are accepted; parameter text is converted
  to the types in the tool schema. Test: `node verify-text-tool-calls.cjs`.

## Bugs fixed
- `/project/understand` threw a ReferenceError on any project that had files (variable out of scope in `agent-server.js`).
- Multi-file edit (`/fs/editbatch`) interpreted `$&`, `$1`, `$$` in the new text as replacement patterns and corrupted code.
- Symbol rename corrupted names that contain `$` (for example `$$el`, `$1x`).
- `isPrivateIp` treated zero-padded IPv6 spellings (`0000:…:0001`, `::ffff` forms, NAT64) as public addresses.
- The backend had no `unhandledRejection` / `uncaughtException` handler, so one stray rejected promise could stop the server.
  Port-in-use at startup still exits as before.
- `parseArgs` accepted JSON `null`, scalars and arrays as tool arguments; only plain objects are accepted now.
- The sandbox sweeper's first run at startup had no `.catch`.
- Removed a duplicate `type` key in the VS Code debug-session object.

## Tests and housekeeping
- New `verify-3.18.4-fixes.cjs` (9 checks, includes an end-to-end run against a real server). It fails on 3.18.3 and passes now.
- `verify-ui-cleanup.cjs` and three version checks no longer hardcode an old cache name / version number.
- `package.json` version 3.18.4; PWA cache `codespace-pwa-61-text-tool-calls-31804`; `js/app.js` rebuilt.
- Known: `verify-vscode-node-host.cjs` is timing-sensitive on Linux (it also fails intermittently on the 3.18.3 code), and
  `verify-3.11.0.cjs` needs Chrome/Edge installed for its screenshot cases.

### Android Local Python package workflow
- Added a Python Packages dock and native PyPI wheel installer for verified universal pure-Python wheels.
- Added app-private package storage/import-path activation, package listing/removal, approval prompts, and wheel size/hash/path validation.
- This constrained workflow is not pip; dependencies are manual and native/source distributions are not supported.
