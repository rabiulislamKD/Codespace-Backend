# Phase 3Z changelog

## OpenCode from chat
- Added/retained the OpenCode composer mode that executes the official `opencode run --format json` CLI locally via the authenticated Agent Server.
- Uses the OpenCode CLI's own login/provider configuration instead of copying or proxying the OpenCode Free credential into My Chat Agent.
- Streams progress events to the chat UI and retains OpenCode session IDs per My Chat Agent conversation.
- Preserves the normal permission mode by default; `--auto` requires explicit opt-in and confirmation.
- Uses argument-array process execution without a shell, validates prompt length/NUL bytes and session ID, enforces a 60-minute safety timeout, and kills the child when the user aborts/disconnects.

## Task plan visibility
- Hides the checklist and header Plan button when there is no plan or every step is completed.
- Clears stale plan UI at the start of each new My Chat Agent/ OpenCode chat turn.
- Shows plan only when single-agent `update_plan` or Multi-agent planning creates unfinished work.
- Retains the compact/expanded toggle while an active/incomplete plan exists.

## PWA
- Bumped service-worker cache version to `v3r-pwa-3-opencode-smart-plan` to prevent old app-shell content from being reused.

## Verification
- `node --check agent-server.js`: PASS
- HTML inline JavaScript syntax: PASS
- `node verify.cjs`: 54/54 PASS
- `node verify-opencode-bridge.cjs`: 4/4 PASS using a mock CLI
- Live OpenCode/free-model test: NOT RUN; no real OpenCode authentication/provider used.
- Browser UI test: BLOCKED by the environment's Chromium navigation policy; no claim of successful visual browser verification.
