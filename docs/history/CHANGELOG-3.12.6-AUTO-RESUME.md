# CodeSpace 3.12.6 — Auto-Resume Engine + Source Coder Credit

## What you reported

1. "The agent repeated an identical tool call with the same result 5 times. It was stopped to
   avoid a loop." — and the AI just stopped working.
2. "The model ended without a visible final answer. Review the steps or send a follow-up." —
   and the AI just stopped working.
3. You want the system to **auto-start the AI and resume working** when this type of stop
   happens, instead of leaving the turn dead.
4. Branding: project name **CodeSpace**, source coder name **Rabiul Islam**.

## What changed

### Auto-resume (the agent continues by itself)

Both stop conditions now auto-resume instead of killing the turn:

- **Identical-tool-call deadlock** (the "5 times" stop): the agent resumes with a private
  continuation instruction — change approach, use a different tool/arguments/path, finish with
  a visible final answer. The repeat counter is reset so the model gets a fair, fully-warned
  chance to actually change approach.
- **Empty reply / no visible final answer**: the agent resumes and asks the model for the
  final answer based on the work and tool results already collected.

Safety rails:

- Bounded: at most **2 auto-resumes per turn** (`AUTO_RESUME_MAX`). After that, the turn stops
  with a clear message that says the resume attempts were already made.
- Stop always wins: pressing **Stop** cancels instantly; no resume is ever started after Stop.
- Transparent: every auto-resume is announced in the chat ("Auto-resume 1 of 2: … the agent
  continues working automatically — press Stop if you want it to stop") and in the live feed.
- Private: the continuation instructions travel as internal messages — they reach the model
  but never appear as fake user bubbles in your chat, and they are dropped from later turns.

### Bug found and fixed during E2E: late session hydration wiped live notes

The asynchronous IndexedDB session hydration rebuilt the whole chat when it landed — even in
the middle of a running turn — wiping transient notes (like "Auto-resume 1 of 2") and errors
that had just been shown. Hydration now still merges the session data but skips the DOM
rebuild while a turn is active.

### Branding

- Welcome splash now shows: **"Project: CodeSpace · Source Coder: Rabiul Islam"** (and the
  version line was refreshed from the stale v3.12.0 text).
- `package.json` now carries `"author": "Rabiul Islam"`.

### Also in this cycle (3.12.5, included in the same build)

- Live detail text (writing tail, tool labels, specialist stages, "Still thinking · Ns" heart-
  beat) is painted on the activity line for every engine: agent, multi-agent and OpenCode.
- Provider "overloaded" errors that kill a stream mid-answer are retried automatically (with
  the retry surfaced in the feed), so multi-agent turns survive provider overload.
- The independent multi-agent QA review actually runs now (a `childSignal` scope bug used to
  crash it before it started and turn finished multi-agent turns into "Request failed").
- Multi-agent preflight specialists launch with a 350 ms stagger to avoid provider overload
  bursts; a flaky task-dedupe verification test was made deterministic.

## Verification

- Live browser E2E (mock provider, real UI):
  - Ask mode: model answers with a fully empty reply → "Auto-resume 1 of 2" note appears →
    agent produces the final answer; no "Request failed".
  - Agent mode: model makes the identical `list_files` tool call 5 times (the exact deadlock)
    → auto-resume → the model changes approach and finishes; the old hard-stop error never
    appears; tool steps and the final answer all render.
  - (3.12.5 E2E: in-stream overload mid-answer → auto-retry → answer completes, in both ask
    and multi-agent modes, with the QA review running.)
- `npm run verify:all` — **583/583 checks passed**.
- PWA cache bumped (`codespace-pwa-29-auto-resume-3126`).

## Upgrade

Same portable flow: replace the folder, run `Start CodeSpace`.
