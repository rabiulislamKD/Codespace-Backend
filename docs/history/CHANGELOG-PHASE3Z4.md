# Phase 3Z4 — Minimal Activity & Private Context Guard

- Replaced the activity card with a thin, monochrome, single-line indicator. Removed the second streamed-thinking card too.
- The indicator shows a small animated circle and one status word only: Thinking, Working, Reviewing, Waiting, Done, Failed, or Stopped.
- Removed colourful status pills, pulse ring, card background, border-radius, and shadow from the activity display.
- Generic workspace visibility/status questions skip automatic project-memory and smart-code retrieval.
- OpenCode mode no longer receives automatic smart-retrieval or project-memory excerpts; its own CLI can inspect the workspace directly.
- Removed persistent rendering of raw model reasoning; activity is now the only temporary thinking display.
- Added explicit private-context instructions and a response sanitizer that removes automatic retrieval/project-context dump blocks from assistant and OpenCode answers.
- If the only generated answer is a context dump in response to a workspace visibility question, the UI falls back to a concise `Yes.` / `No.` based on whether a workspace is connected.
- Legacy saved user messages are cleaned on load so prior automatic context blocks are removed from chat history.
- Completed Task Plans stay hidden for the rest of the turn. The next user turn may create a new plan.
- Bumped the service-worker cache to `v3r-pwa-7-minimal-activity-no-retrieval-dump`.

## Verification

- `node --check agent-server.js` — PASS
- `node --check verify.cjs` — PASS
- HTML inline JavaScript syntax — PASS
- `node verify.cjs` — 81/81 PASS
- `node verify-opencode-bridge.cjs` — 4/4 PASS (mock CLI)
- ZIP integrity — PASS

No live provider, browser UI end-to-end test, or live OpenCode task was run for this release.
