# CodeSpace v47 — OpenCode Android silent execution fix

Baseline: v46 (`versionCode 31849`, `3.19.1-android-v46`)
Target: v47 (`versionCode 31850`, `3.19.1-android-v47`)

## 1. Confirmed problems and root causes

### 1.1 Managed background service is the zero-byte cause (NEW, confirmed)

A controlled experiment was run with the installed real CLI
(`opencode vv2.0.32-android-termux.1`, binary
`/data/data/com.tom.rv2ide/files/home/opencode-test/opencode2.bin`, 2026-11-19):

| command | rc | stdout | stderr |
|---|---:|---:|---:|
| `opencode models` | 1 | **0 bytes** | 1381 bytes |
| `opencode models --standalone` | 0 | 1004 bytes | 0 |
| `opencode run --standalone --format json -- 'Say OK'` | 0 | 558 bytes | 0 |

Without `--standalone`, this CLI tries to attach to a **managed background service**
(`port 28570 on 127.0.0.1`). A one-shot Termux shell cannot reliably own that service. When the
service cannot be reached/started the CLI exits or stalls while stdout stays empty — exactly the
reported "starts, writes start marker, zero-byte stdout/stderr for minutes" symptom.

**Fix:** both the run command and the model-discovery command now use `--standalone` (private
server per invocation).

A second end-to-end check used the **exact v47 launcher shape** (background subshell + `exec env`
+ two-PID atomic marker + `wait` + exit file) with the real binary:

```
start shell=7914 cli=7917   (distinct PIDs)
exit=0  out=558 bytes  err=0 bytes
{"type":"step_start", ...}
{"type":"text", ..., "text":"OK", ...}
```

### 1.2 Only the launcher shell PID was recorded

v46 ran the CLI in the foreground inside the shell and wrote only `$$` to the start marker.
`childPid` stayed empty, so kill/probe could not see the actual OpenCode process.

**Fix:** `( cd … || exit 78 ; exec env … opencode … ) > out 2> err & cli=$!`.
Because the subshell `exec`s the command, `$!` **is** the real CLI PID. Both PIDs are written to a
temp file and atomically renamed into the start marker. The parent `wait`s for `$cli` and writes
the child's real exit code. The command now uses `env VAR=… binary …` because bash's `exec`
builtin cannot take a bare assignment prefix.

### 1.3 `lastOutputAt` initialized to zero

A silent run reported `sinceOutputMs = elapsed` via a fallback guard, and the no-output diagnostic
logic was misleading.

**Fix:** `lastOutputAt = launchedAt` in the `Session` constructor; `sinceOutputMs` is now always
`t - s.lastOutputAt` (no conditional fallback).

### 1.4 Diagnostics probed the shell, not the CLI

**Fix:** `probeSession` probes `childPid` (falling back to `pid`), enumerates all descendants from
`/proc/<pid>/task/<pid>/children`, and reports `procClass` (DEAD / SLEEPING / BLOCKED / ACTIVE /
UNKNOWN), `waitReason`, `ppid`, `wchan`, `accessible`, `known`, `outSize`, `errSize`, and times.
An unreadable/failed `/proc` probe is **UNKNOWN**, never "dead".

### 1.5 Unsafe watchdog / unverified cancellation

**Fix:** the no-output watchdog requires BOTH a sustained silence above a configurable threshold
(`setNoOutputWatchdogMs`, default 5 min, route `/opencode/run/watchdog`) AND a real process probe
classifying the run as DEAD or BLOCKED. A sleeping provider/network wait is never killed merely
for having produced no text. A genuinely stuck run gets exit code `125`, a structured
`diagnosis`, and a `CODESPACE_STUCK` stderr line.

Cancellation now signals the shell **and** CLI PID trees, waits for the parent shell to reap the
child (exit file) or a definitive `/proc` disappearance, and returns
`{ok, verified, childPid, observedExitCode}` — success is never claimed before verification.

### 1.6 Free quota (critical correction, v46 behavior hardened)

The exact device event is parsed field-for-field (`type`, `status`, `message`, `retryAfterMs`,
`response.body`). `provider.free-limit` returns `state: 'FAILED'` immediately without waiting for
the 30-minute timeout, shows "Free quota exhausted… Try again in about 6h 23m", never rotates
credentials for an account-wide limit, and never changes the selected model. The **first**
structured error is locked, so a later wrapper error or an exit-130 cancellation cannot replace
the original provider error.

## 2. Changed files

1. `app/build.gradle` — v47 version metadata.
2. `app/src/main/java/com/codespace/android/AndroidOpenCodeRuntime.kt` — process tracking,
   atomic two-PID marker, real child exit, timing, watchdog, verified cancellation, safe probes.
3. `app/src/main/java/com/codespace/android/MainActivity.kt` — `--standalone` for run and models,
   `env` command prefix, `/opencode/run/watchdog`, new cancel response, watchdog restore.
4. `codespace-core-3.18.4/src-js/19-activitybar-composer.js` — original-error locking, explicit
   free-quota message, diagnosis plumbing, exit-125 explanation.
5. `codespace-core-3.18.4/js/app.js` — rebuilt desktop bundle.
6. `app/src/main/assets/codespace-web/js/app.js` — rebuilt Android bundle.
7. `codespace-core-3.18.4/tests/opencode-silent-execution-v47.test.js` — **new**, 23 tests.
8. `codespace-core-3.18.4/tests/opencode-exec-lifecycle-v44.test.js` — wrapper updated to v47 shape.
9. `codespace-core-3.18.4/tests/opencode-cli-no-dir-flag-v43.test.js` — wrapper + argv updated.
10. `codespace-core-3.18.4/tests/termux-execution-v39.test.js` — command assertion updated.
11. `codespace-core-3.18.4/tests/opencode-model-display-v43.test.js` — parallel-load flake fix (tests only).
12. `OPENCODE-SILENT-EXECUTION-V47.md` and `DEVICE-VERIFICATION-V47.md` — new reports.

No UI markup, Free/Paid grouping logic, model configuration, credential set, or Termux/workspace
permission checks were changed.

## 3. Test report

- `node --test tests/*.test.js`: **256 tests, 256 pass, 0 fail** (three consecutive clean runs after
  the build). Before the build the only failure was `termux-integration.test.js` asserting a merged
  manifest exists ("build first"). One v43 DOM test with fixed 40/80 ms sleeps was made flake-free
  under parallel load.
- `node --test tests/opencode-silent-execution-v47.test.js`: **23/23 pass**, covering all 11
  required scenarios plus the free-quota correction:
  shell/child PID tracking, successful output+exit, zero-output process, provider init failure,
  auth error, network timeout, free-model quota, child cancellation, multiple sessions, no orphans,
  timing, process classification, diagnostics hygiene, original-error preservation and UI delivery.
- `verify-models-thinking.cjs`: 38/38 pass.
- `verify.cjs`: 2 pre-existing failures identical to v46 (desktop Chromium-default checks),
  unrelated to this change.

## 4. Physical device verification — NOT performed

No physical Android device was used for this build. The APK must be installed and a silent task run
to confirm the fix. See `DEVICE-VERIFICATION-V47.md`.

## 4b. Build and APK verification

- `gradle --no-daemon :app:assembleDebug` → **BUILD SUCCESSFUL in 5m 57s**.
- APK: `/sdcard/Download/CodeSpace-v47.apk`, 59,011,461 bytes.
- `aapt dump badging`: `versionCode='31850' versionName='3.19.1-android-v47'`.
- Embedded `assets/codespace-web/js/app.js` extracted from the APK (849,459 bytes) contains the
  v47 original-error lock, diagnosis plumbing and "Free quota exhausted" message.

## 5. Security note

Diagnostics keep the exact `[OPENCODE_EXEC_V44]` prefix and never log prompts, API keys, auth
headers or tokens. The previously exposed GitHub PAT and OpenCode keys still require rotation.
