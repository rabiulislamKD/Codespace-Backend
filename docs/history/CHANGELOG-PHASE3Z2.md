# Phase 3Z2 — Clean Chat Replies & Multi-agent Activity

- Removed the large Multi-agent preflight report from visible chat and from the normal transcript sent to the implementer. Specialist findings are passed as bounded internal system context instead.
- Removed the separate QA review bubble; review outcome remains in internal run metadata.
- Strengthened implementer instructions not to repeat internal advisory content as a user-facing response.
- Fixed activity-panel re-render behavior so the animated Multi-agent thinking/working bubble remains visible and is reattached under the active user turn if chat history redraws.
- Preserved OpenCode CLI bridge, PWA assets, extension marketplace, task plan, and existing theme/UI.

Validation performed: Node server syntax, HTML inline script syntax, source-level regression checks, mock OpenCode bridge tests, and ZIP integrity. No live model/provider or full multi-agent end-to-end task was run.
