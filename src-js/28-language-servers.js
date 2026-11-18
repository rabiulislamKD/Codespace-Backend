/* ================= Android Local baseline language-server setup =================
   Installs approved npm server packages and lets native code discover safe JS entrypoints. */
const csLspSetupState = { loading: false };
function csLspSetupLocal() {
  return typeof androidLspLocal === 'function' && androidLspLocal() && !!(B && B.ok);
}
function csLspSetupShow(open = true) {
  const panel = $('csDebugPanel'); if (!panel) return;
  panel.hidden = false;
  const lsp = $('csLspSetupPanel'), node = $('csNodePackagesPanel'), python = $('csPythonPackagesPanel'), body = panel.querySelector('.cs-debug-body');
  if (lsp) lsp.hidden = !open;
  if (node) node.hidden = true;
  if (python) python.hidden = true;
  if (body) body.hidden = !!open;
  $('csDebugOpen')?.setAttribute('aria-expanded', 'true');
}
function csLspSetupRender(lines, error = false) {
  const host = $('csLspSetupStatus'); if (!host) return;
  host.replaceChildren();
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'cs-debug-empty' + (error && line.error ? ' err' : '');
    row.textContent = String(line.text || '').slice(0, 1000);
    host.appendChild(row);
  }
}
async function csLspSetupInstall() {
  if (csLspSetupState.loading) return;
  if (!csLspSetupLocal()) throw new Error('Language-server setup is available in Android Local mode only.');
  csLspSetupState.loading = true;
  const button = $('csLspSetupInstall'); if (button) { button.disabled = true; button.textContent = 'Installing…'; }
  csLspSetupRender([{ text: 'Resolving the baseline servers from the official npm registry…' }]);
  try {
    const result = await bcall('/lsp/setup-baseline', {});
    const lines = [];
    const installed = Array.isArray(result.installed) ? result.installed : [];
    const configured = Array.isArray(result.configured) ? result.configured : [];
    const failures = Array.isArray(result.installFailures) ? result.installFailures : [];
    const unavailable = Array.isArray(result.unavailable) ? result.unavailable : [];
    lines.push({ text: result.message || 'Language-server setup completed.' });
    if (installed.length) lines.push({ text: 'Installed: ' + installed.map(x => (x.name || 'package') + (x.version ? '@' + x.version : '')).join(', ') });
    if (configured.length) lines.push({ text: 'Configured: ' + configured.map(x => x.language).join(', ') });
    if (failures.length) lines.push({ text: 'Install failures: ' + failures.map(x => (x.name || 'package') + ': ' + (x.error || 'failed')).join(' | '), error: true });
    if (unavailable.length) lines.push({ text: 'Not configured: ' + unavailable.map(x => (x.language || 'language') + ': ' + (x.reason || x.package || 'unavailable')).join(' | '), error: true });
    lines.push({ text: 'Configuration: ' + (result.config || '.codespace-tools/lsp.json') + ' · package scripts run: no' });
    csLspSetupRender(lines, failures.length > 0 || unavailable.length > 0);
    if (configured.length && !failures.length && !unavailable.length) feedPush('Baseline language servers configured for Android Local.', { force: true });
  } catch (e) {
    csLspSetupRender([{ text: e.message || 'Language-server setup failed.', error: true }], true);
  } finally {
    csLspSetupState.loading = false;
    if (button) { button.disabled = false; button.textContent = 'Install baseline'; }
  }
}
$('csLspSetupOpen')?.addEventListener('click', () => csLspSetupShow(true));
$('csLspSetupBack')?.addEventListener('click', () => csDebugShow(true));
$('csLspSetupInstall')?.addEventListener('click', () => csLspSetupInstall());
