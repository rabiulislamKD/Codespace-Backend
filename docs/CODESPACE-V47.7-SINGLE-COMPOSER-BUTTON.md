# CodeSpace Android v47.7 — one 2-in-1 composer button

## What you asked
The chat box showed two buttons while the AI was working. You wanted one button that acts as **Send** when you have typed a message, and **Stop** when the composer is empty.

## What changed
- Removed the separate `stopBtn` from both the Android and desktop HTML shells. There is now exactly one `sendBtn`.
- The single button contains both send and stop icons and switches between them:
  - **Composer empty + AI working:** red square **Stop** icon. Tap it to cancel the run and clear queued messages.
  - **Text or attachments present + AI working:** **Send** icon. Tapping it queues your message; the button title reads “Queue message”.
  - **AI idle:** normal **Send** icon.
- Typing, clearing text, adding/removing attachments, and queue-count changes update the button immediately.
- Enter follows the same rule: with text it sends/queues; with an empty composer during a run it stops.
- The Run menu’s “Stop Agent” action now calls the same stop routine.

## Queue behaviour preserved
Messages sent while the AI is working are still queued in order and auto-sent when the current turn finishes. Stop still clears that queue so nothing is sent unexpectedly.

## Verification
- Unit tests: **290/290 passed** (2 new v47.7 single-button tests).
- Debug APK: **BUILD SUCCESSFUL**, versionCode 31857 / `3.19.1-android-v47.7`.
- Physical device verification was **not** performed.

## Artifacts
- `/sdcard/Download/CodeSpace-v47.7.apk`
- `/sdcard/Download/CodeSpace-v47.7-full-source.zip` (383 files)
- `/sdcard/Download/CodeSpace-v47.7-changed-files.zip`
- `/sdcard/Download/CODESPACE-V47.7-SINGLE-COMPOSER-BUTTON.md`
