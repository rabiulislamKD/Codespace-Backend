# 3.9.2

- New agent tool `browser_network` (embedded browser, Chrome bridge, Agent Chrome): method, address, status, type, timing, failures. No headers/cookies/bodies; secrets in query strings masked. Options: all, clear, filter, failed_only.
- Embedded browser Network button now shows captured requests (main process reports them; receive-only preload channel `onNetwork`).
- Chrome bridge extension 1.2.0: in-page fetch/XHR + Resource Timing hook, no new permissions. Reload the extension after updating.
- Console / Network buttons: second click on the active button minimises the panel.
- Model selector: models fetched from the provider after saving a key, grouped by provider; background refresh every 6 h; "Refresh models" button in Settings > Providers.
- OpenCode: "Install OpenCode for CodeSpace" (npm registry, integrity-checked, no admin rights; mirror via CODESPACE_NPM_REGISTRY), saved OpenCode API key + default model (private 0600 file, never returned to the page, passed via environment/inline config).
- Tests: verify-opencode-install.cjs (new), verify-bridge.cjs (+35 network checks).
