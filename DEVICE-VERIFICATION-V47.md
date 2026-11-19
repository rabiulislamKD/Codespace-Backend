# Physical device verification — CodeSpace v47 (NOT yet performed)

Install `/sdcard/Download/CodeSpace-v47.apk` on a physical Android device with Termux and the
external-command permission already granted. Do **not** rotate or replace credentials before the
first run — preserve the exact failing configuration.

## A. Confirm the silent-execution fix

1. Open CodeSpace → Settings → OpenCode CLI → verify the CLI is detected and the selected model is
   the same one that previously went silent (for example `opencode/beam-free`,
   `opencode/hy4-flash-free`).
2. Start a normal chat task. Observe the feed:
   - expected: `OpenCode CLI is running…` followed by writing/tool events, then an answer;
   - failure: no output after 60 s with no new diagnostic lines.
3. Share these two files from `/sdcard/Download`:
   - `codespace-diagnostics.txt`
   - `.codespace-opencode/opencode-exec-v44.log`

## B. What to look for in the log

A **healthy** v47 run contains:

```
[OPENCODE_EXEC_V44] launch session=… exe=/data/data/com.termux/files/usr/bin/opencode serviceStarted=true cmd=env OPENCODE_CONFIG=… run --standalone --format json …
[OPENCODE_EXEC_V44] started session=… shellPid=NNN cliPid=MMM
```

`shellPid` and `cliPid` must be **different** numbers. `childPid` in the probe/read response must no
longer be empty.

If a run stays silent, the new no-output line identifies the stopping point:

```
[OPENCODE_EXEC_V44] no-output session=… shellPid=NNN cliPid=MMM alive=true known=true state=S class=SLEEPING wait=network-or-provider ppid=… children='…' elapsedMs=… sinceOutputMs=… outSize=0 errSize=0
```

Interpretation:
- `class=SLEEPING`, `wait=network-or-provider` → CLI is alive and waiting on the provider; v47
  deliberately does **not** kill it on silence alone. Wait for the run timeout or cancel manually.
- `class=DEAD` / `BLOCKED` with a silence over the watchdog threshold → v47 kills only that run's
  tree and returns exit `125` with a structured `diagnosis`.
- `known=false` → `/proc` was unreadable; this is **not** treated as a dead process.
- `outSize=0 errSize=0` with `alive=true` and `class=ACTIVE` → process running but not emitting;
  share the log unchanged.

## C. Stop button check

Press Stop on a live run. Confirm:
- the feed reports "Stopped by you" only after termination is verified;
- `/opencode/run/cancel` returns `"ok":true,"verified":true`;
- no orphan `opencode` process from that run remains (check the CLI PID from the start line with
  `[ -d /proc/<cliPid> ]` in Termux).

## D. Free-quota check (use an already-exhausted free model)

Send one task with a free model whose quota is exhausted. Expected:
- immediate `Free quota exhausted — … Try again in about Xh Ym.` message;
- no 30-minute wait, no "Starting OpenCode CLI";
- no key rotation, no model change;
- the original `provider.free-limit` detail is preserved even if the process is stopped afterwards.

## E. What would falsify the fix

- `childPid` still empty, or `shellPid == cliPid`.
- `cmd=` line lacks `--standalone`.
- zero-byte stdout continues while the probe reports `alive=true` with no wait channel.
- Stop reports success without a verified exit.
- Any log line containing a prompt, API key, or auth header (report immediately; do not paste secrets).
