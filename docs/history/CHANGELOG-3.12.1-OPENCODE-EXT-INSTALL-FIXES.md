# CodeSpace 3.12.1 — OpenCode Toggle & Extension Install Fixes

Patch release on top of 3.12.0 (Universal Sandbox Engine). No new features; two user-reported
bugs fixed, plus the approval-handshake gaps that caused them. No security rules were weakened —
these fixes complete the frontend side of the 3.11.0 permission handshake that some panels missed.

## Fix 1 — OpenCode button did nothing when clicked ("not started / not open")

**Cause:** `syncOpenCodeUI()` hard-disabled the OpenCode toggle whenever the terminal bridge was
not connected or no workspace folder was open. A disabled `<button>` swallows click events, so
clicking it produced no message, no dialog, nothing.

**Changes (my-chat-agent-v3.html):**
- The toggle is never hard-disabled. Until the bridge + workspace are ready it stays clickable
  (visually dimmed via a new `.tgl.notready` style) and clicking it shows exactly what is missing:
  - bridge not connected → instructions to connect in Settings > Bridge;
  - no folder open → instructions to open a workspace folder.
- Cancelling the OpenCode install prompt or the auto-approval warning now shows a note instead of
  returning silently.
- The success note now states explicitly that OpenCode mode opens nothing extra — the next chat
  message is routed through the OpenCode agent in the open workspace, using OpenCode's own
  provider/model and login.

## Fix 2 — Extension install crashed: "Cannot read properties of undefined (reading 'join')"

**Cause:** since 3.11.0 the `/ext/install` endpoint is server-guarded (`ext` permission). With the
default "ask" mode the server replies `{needsApproval:true, approvalToken, preview, …}` instead of
installing. The Extensions panel still read `r.installed.join(', ')` from that reply — `installed`
is undefined on an approval reply → TypeError, nothing was installed.

**Changes (my-chat-agent-v3.html), all four affected call sites converted to the single-use-token
handshake (`bApproved`), matching how every other guarded panel already works:**
- Install (manual source, npm catalog, JSON manifest): completes the server approval handshake
  (shows the server's own preview in the dialog, then re-sends the single-use token). `r.installed`
  is only read when it is actually an array. The starter pack only counts real installs.
- Starter pack (Auto-add): previously reported "Auto-added" even when the server asked for
  approval and nothing was installed. Now reports honestly per package.
- Uninstall: `/ext/remove` is guarded by the `destructive` permission; the button now completes
  that handshake instead of silently doing nothing.
- Agent extension-tool calls (`/ext/call`, `mcp` guard): previously reported "(no output)" while
  nothing ran. Now reports that the tool was not run when approval is not granted.

## Fix 3 — OpenCode live progress showed almost nothing while the model worked

**Report:** "AI model live working not showing in details, it just shows a line."

**Cause:** while OpenCode ran, the bridge only forwarded a generic progress line per parseable
JSON event ("OpenCode is writing a response…" with no content), and if OpenCode's output was not
parseable JSON (older build, different `--format` support), no live detail ever appeared — just
the single "Starting OpenCode CLI…" line for the whole run.

**Changes (agent-server.js):**
- Live writing: the bridge now streams the growing answer as `live` events (a short tail of the
  model's current text, deduplicated), so you can watch what it is writing.
- Tool details: tool/step events now include OpenCode's own state title, e.g.
  "OpenCode is using bash · ls -la…".
- Heartbeat: if the model thinks for 45+ seconds without emitting anything, a "still working
  (elapsed)" update is sent instead of a frozen line.
- Plain-text fallback: if no JSON answer was parsed but OpenCode printed readable output, that
  output is now delivered as the answer instead of "finished without a visible text answer".

**Changes (my-chat-agent-v3.html):**
- `live` events update a single live row in the activity feed (with the newest text tail / elapsed
  time) instead of stacking a new line on every event; the row is closed with its duration when
  the run ends.

## Housekeeping

- `package.json` version → 3.12.1.
- PWA service worker cache version bumped (`codespace-pwa-24-opencode-live-details-3121`) so PWA
  clients refresh the app shell on next load.

## Verification

- Full regression suite: `npm run verify:all` — 554/554 checks passed (server hardening, LLM
  providers, core, 3.10.0, 3.11.0 security, sandbox, bridge, desktop). No test was deleted,
  skipped or weakened; one existing static assertion ("OpenCode own provider and agent are called
  out in the UI") is still satisfied by the reworded enable note.
- End-to-end in a real browser against a live `agent-server.js`:
  - OpenCode toggle: dead-click scenario → clear guidance; bridge connected → toggle enables;
    chat message sent through `/opencode/run`; toggle off returns cleanly.
  - Extensions: Install → client consent dialog → server permission dialog (with preview) →
    package genuinely installed and listed; Uninstall → confirm → destructive-permission dialog →
    extension removed.
