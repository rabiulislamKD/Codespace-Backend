# CodeSpace Android v47.4 — write/checkpoint blocker fix

## Reported failure

Every write tool (`write_file`, `edit_file`, `multi_edit`, `rename_symbol`) failed with:

```
Error: No folder is open. Open a workspace before using checkpoints.
```

while `list_files`, `read_file` and `codespace_runtime_check` worked and reported
`Workspace: saf://workspace`.

## Root cause

All write tools call `ensureTurnCheckpoint()` before modifying a file. That helper calls
`/checkpoints/create` through the normal bridge client. The checkpoint endpoint was **not** in the
list of workspace-owned endpoints that route to the Android device adapter when an SAF/Android
folder is active. In a server sandbox mode it was therefore sent to the remote `agent-server.js`,
which has no workspace root and throws `No folder is open. Open a workspace before using
checkpoints.` The write never happened.

The same routing gap affected `/fs/editbatch` (used by `multi_edit`) and `/index/*` (used by
`rename_symbol`). The Android adapter additionally had no native implementations of `/fs/editbatch`
or `/index/rename`.

## Fixes

- Extended the local-workspace endpoint list to include `/checkpoints/*`, `/fs/editbatch` and
  `/index/*`. With an Android/SAF folder active they now go to the device adapter in every sandbox
  mode.
- `ensureTurnCheckpoint()` no longer throws: a checkpoint backend failure is reported as a visible
  warning and the write proceeds. A checkpoint is a safety net, not write permission.
- Added native Android implementations of `/fs/editbatch` (atomic pre-validation, then batch write)
  and `/index/rename` (word-boundary rename across supported text files), both using SAF or the
  app-private workspace as appropriate.
- `rename_symbol` now creates a checkpoint explicitly before renaming, matching the other write
  tools.

## Verification

- Unit tests: **278/278 passed**, including 5 new v47.4 regression tests.
- Debug APK: **BUILD SUCCESSFUL**, versionCode 31854 / `3.19.1-android-v47.4`.
- No physical device verification was performed.

## Artifacts

- `/sdcard/Download/CodeSpace-v47.4.apk`
- `/sdcard/Download/CodeSpace-v47.4-full-source.zip` (379 files)
- `/sdcard/Download/CodeSpace-v47.4-changed-files.zip` (7 files)

## What to do

Install v47.4 and reopen the same workspace. The AI should now be able to write
`products-data.js`, update `data.js` and finish the 60-product clone. If a checkpoint cannot be
created, the app will show a warning but the file write will still succeed.

## GitHub push status

**Not pushed.** No GitHub token is available in this environment. The previously pasted PAT must be
revoked. Provide a fresh token for `rabiulislamKD/Codespace-Backend` to push v47.3 and v47.4.
