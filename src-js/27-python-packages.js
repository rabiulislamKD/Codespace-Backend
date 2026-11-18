/* ================= Android Local Python package manager =================
   Installs SHA-256 verified pure-Python universal wheels from PyPI. */
const csPythonPackages = { loading: false, items: [] };
function csPythonPackagesLocal() {
  return typeof androidLspLocal === 'function' && androidLspLocal() && !!(B && B.ok);
}
function csPythonPackagesShow(open = true) {
  const panel = $('csDebugPanel'); if (!panel) return;
  panel.hidden = false;
  const python = $('csPythonPackagesPanel'), node = $('csNodePackagesPanel'), lsp = $('csLspSetupPanel'), body = panel.querySelector('.cs-debug-body');
  if (python) python.hidden = !open;
  if (node) node.hidden = true; if (lsp) lsp.hidden = true;
  if (body) body.hidden = !!open;
  $('csPythonPackagesOpen')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  $('csDebugOpen')?.setAttribute('aria-expanded', 'true');
}
function csPythonPackagesMessage(message, error = false) {
  const host = $('csPythonPackageList'); if (!host) return;
  host.replaceChildren(); const row = document.createElement('div');
  row.className = 'cs-debug-empty' + (error ? ' err' : ''); row.textContent = String(message || '').slice(0, 1200); host.appendChild(row);
}
function csPythonPackagesRender(rows) {
  const host = $('csPythonPackageList'); if (!host) return;
  host.replaceChildren();
  if (!rows.length) { csPythonPackagesMessage('No Python packages installed yet.'); return; }
  rows.forEach(item => {
    const row = document.createElement('div'); row.className = 'cs-node-package-row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name || '(unknown package)';
    const version = document.createElement('span'); version.className = 'version'; version.textContent = item.version || '';
    const description = document.createElement('span'); description.className = 'description';
    description.textContent = Array.isArray(item.dependencies) && item.dependencies.length ? 'Requires: ' + item.dependencies.join(', ') : 'Pure Python wheel';
    const remove = document.createElement('button'); remove.className = 'btn sm'; remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (csPythonPackages.loading) return;
      csPythonPackages.loading = true; remove.disabled = true;
      try { await bcall('/runtime/python/packages/remove', { name: item.name }); await csPythonPackagesRefresh(); }
      catch (e) { csPythonPackagesMessage(e.message || 'Package removal failed', true); }
      finally { csPythonPackages.loading = false; }
    });
    row.append(name, version, description, remove); host.appendChild(row);
  });
}
async function csPythonPackagesRefresh() {
  if (!csPythonPackagesLocal()) throw new Error('Python package management is available in Android Local mode only.');
  const result = await bcall('/runtime/python/packages/list', {});
  csPythonPackages.items = Array.isArray(result.packages) ? result.packages : [];
  csPythonPackagesRender(csPythonPackages.items); return result;
}
async function csPythonPackagesInstall() {
  if (csPythonPackages.loading) return;
  if (!csPythonPackagesLocal()) throw new Error('Python package management is available in Android Local mode only.');
  const input = $('csPythonPackageSpec'), specs = String(input?.value || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean);
  if (!specs.length) throw new Error('Enter a Python package, for example requests==2.32.3.');
  if (specs.length > 8) throw new Error('Install up to 8 Python packages per operation.');
  if (specs.some(x => !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*(?:==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+_-]+(?:\s*,\s*(?:==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+_-]+)*)?$/.test(x))) throw new Error('Use a package name with PEP 440 constraints, for example requests>=2.31,<3.');
  csPythonPackages.loading = true;
  const install = $('csPythonPackageInstall'), refresh = $('csPythonPackageRefresh');
  if (install) { install.disabled = true; install.textContent = 'Installing…'; }
  if (refresh) refresh.disabled = true;
  csPythonPackagesMessage('Downloading and verifying pure-Python wheels from PyPI…');
  try {
    const result = await bcall('/runtime/python/packages/install', { packages: specs });
    input.value = ''; await csPythonPackagesRefresh();
    if (Array.isArray(result.failed) && result.failed.length) {
      csPythonPackagesMessage(result.failed.map(x => (x.spec || 'package') + ': ' + (x.error || 'failed')).join('\n'), true);
    } else if (result.count > 0) feedPush('Installed ' + result.count + ' pure-Python package request(s), including compatible dependencies.', { force: true });
  } catch (e) { csPythonPackagesMessage(e.message || 'Python package installation failed', true); }
  finally { csPythonPackages.loading = false; if (install) { install.disabled = false; install.textContent = 'Install'; } if (refresh) refresh.disabled = false; }
}
$('csPythonPackagesOpen')?.addEventListener('click', () => {
  csPythonPackagesShow(true);
  if (!csPythonPackages.loading) csPythonPackagesRefresh().catch(e => csPythonPackagesMessage(e.message || 'Could not load packages', true));
});
$('csPythonPackagesBack')?.addEventListener('click', () => csPythonPackagesShow(false));
$('csPythonPackageRefresh')?.addEventListener('click', () => csPythonPackagesRefresh().catch(e => csPythonPackagesMessage(e.message || 'Could not refresh packages', true)));
$('csPythonPackageInstall')?.addEventListener('click', () => csPythonPackagesInstall());
$('csPythonPackageSpec')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); csPythonPackagesInstall(); } });
