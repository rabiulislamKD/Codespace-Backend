# CodeSpace 3.12.2 — Detailed Work Reports From Every Engine

## Problem you saw

You asked the AI: **"Find and fix bugs in this project"** (through the OpenCode CLI agent), and the
answer came back as **one short line** — "The fixes have been applied (…)" — with no report of
where the bugs were, why they needed fixing, what was actually changed, what is worth improving,
or what to do next.

Two causes:

1. The agent instructions actively pushed answers to be short: the built-in agent note ended with
   *"Keep the final answer concise"*, and the OpenCode path sent your raw prompt with **no reporting
   requirement at all**, so terse models answered tersely.
2. The same rules existed nowhere for Ask mode or Multi-agent mode either — behaviour depended on
   whichever model you had selected.

## Fix: one shared "WORK REPORT RULES" block for all engines

Every engine now asks the model for a structured, actionable report whenever the turn involved real
work (finding/fixing bugs, editing code, running commands, analyzing the project):

- **What I found** — each issue with its file path and why it is a problem
- **What I changed** — file by file, with the reason for each change
- **What I verified** — checks/tests actually run with their observed results, and what was *not* run
- **What to improve** — weak spots worth addressing and why
- **Suggested next steps** — concrete, prioritized actions for this project

Applied to:

| Engine | Where the rules are injected |
| --- | --- |
| Ask mode (any model) | `buildSystem()` appends `REPORT_NOTE` |
| Agent mode (any model) | `buildSystem()` + updated agent note (replaced "keep it concise") |
| Multi-agent (any model) | Implementer inherits `buildSystem()`; specialist agents stay internal |
| OpenCode CLI (its own model) | Server appends `OC_REPORT_NOTE` to every `/opencode/run` prompt |

Guardrails kept: rules only apply to work tasks (simple questions still get normal answers), models
must reference real file paths and must never invent files, line numbers, or test results.

## Also in this release (from the earlier fix, now shipped)

- **Live "working" details stay visible**: while OpenCode/agents stream, one live row keeps updating
  with the model's writing tail instead of stacking lines or freezing on a single line, plus a
  45-second heartbeat ("still working… 1m 30s elapsed") while the model thinks.
- **Plain-text fallback**: if an older OpenCode build prints non-JSON output, its raw output is now
  shown as the answer instead of "no visible text answer".

## Verification

- `npm run verify:all` — **560/560 checks passed** (6 new: report-rules constant, `buildSystem`
  injection in both modes, agent-note rewording, OpenCode server suffix, runtime prompt tests)
- End-to-end browser test with a real server and a scripted OpenCode binary: toggling OpenCode,
  sending "Find and fix bugs in this project", and confirming the CLI received the full reporting
  requirement and the chat rendered the structured report

## Upgrade

Same portable flow as before: close the old app, replace the folder with this one, run
`Start CodeSpace`. The PWA cache version was bumped (`codespace-pwa-25-work-reports-3122`), so the
browser picks up the new UI on the next open.
