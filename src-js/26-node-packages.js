/* ================= Android Local Node.js package manager =================
   Installs verified registry tarballs and dependencies into app-private
   node_modules. Native code enforces approval and archive/integrity limits. */
const csNodePackages = { loading: false, items: [] };
function csNodePackagesLocal() {
  return typeof androidLspLocal === 'function' && androidLspLocal() && !!(B && B.ok);
}
function csNodePackagesShow(open = true) {
  const panel = $('csDebugPanel'); if (!panel) return;
  panel.hidden = false;
  const packages = $('csNodePackagesPanel'), python = $('csPythonPackagesPanel'), lsp = $('csLspSetupPanel'), body = panel.querySelector('.cs-debug-body');
  if (packages) packages.hidden = !open;
  if (python) python.hidden = true; if (lsp) lsp.hidden = true;
  if (body) body.hidden = !!open;
  const button = $('csNodePackagesOpen'); if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  const debugButton = $('csDebugOpen'); if (debugButton) debugButton.setAttribute('aria-expanded', 'true');
}
function csNodePackagesMessage(message, error = false) {
  const host = $('csNodePackageList'); if (!host) return;
  host.replaceChildren(); const row = document.createElement('div');
  row.className = 'cs-debug-empty' + (error ? ' err' : ''); row.textContent = String(message || '').slice(0, 1200); host.appendChild(row);
}
function csNodePackagesRender(rows) {
  const host = $('csNodePackageList'); if (!host) return;
  host.replaceChildren();
  if (!rows.length) { csNodePackagesMessage('No project dependencies installed yet.'); return; }
  rows.forEach(item => {
    const row = document.createElement('div'); row.className = 'cs-node-package-row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name || '(unknown package)';
    const version = document.createElement('span'); version.className = 'version'; version.textContent = item.version || '';
    const description = document.createElement('span'); description.className = 'description'; description.textContent = item.description || '';
    const remove = document.createElement('button'); remove.className = 'btn sm'; remove.type = 'button'; remove.textContent = 'Remove'; remove.title = 'Remove this project dependency';
    remove.addEventListener('click', async () => {
      if (csNodePackages.loading) return;
      csNodePackages.loading = true; remove.disabled = true;
      try {
        await bcall('/runtime/node/packages/remove', { name: item.name });
        await csNodePackagesRefresh();
      } catch (e) { csNodePackagesMessage(e.message || 'Package removal failed', true); }
      finally { csNodePackages.loading = false; }
    });
    row.append(name, version, description, remove); host.appendChild(row);
  });
}
async function csNodePackagesRefresh() {
  if (!csNodePackagesLocal()) throw new Error('Node package management is available in Android Local mode only.');
  const result = await bcall('/runtime/node/packages/list', {});
  csNodePackages.items = Array.isArray(result.packages) ? result.packages : [];
  csNodePackagesRender(csNodePackages.items);
  return result;
}
async function csNodePackagesInstall() {
  if (csNodePackages.loading) return;
  if (!csNodePackagesLocal()) throw new Error('Node package management is available in Android Local mode only.');
  const input = $('csNodePackageSpec'), raw = String(input?.value || '').trim();
  const specs = raw.split(',').map(x => x.trim()).filter(Boolean);
  if (!specs.length) throw new Error('Enter a package name, for example express@^5.');
  if (specs.length > 12) throw new Error('Install up to 12 direct packages per operation.');
  csNodePackages.loading = true;
  const install = $('csNodePackageInstall'), refresh = $('csNodePackageRefresh');
  if (install) { install.disabled = true; install.textContent = 'Installing…'; }
  if (refresh) refresh.disabled = true;
  csNodePackagesMessage('Resolving packages from the official npm registry…');
  try {
    const result = await bcall('/runtime/node/packages/install', { packages: specs });
    input.value = '';
    const failed = Array.isArray(result.failed) ? result.failed : [];
    await csNodePackagesRefresh();
    if (failed.length) {
      const summary = failed.map(x => (x.name || 'package') + ': ' + (x.error || 'failed')).join('\n');
      const note = document.createElement('div'); note.className = 'cs-debug-empty'; note.textContent = 'Some packages were not installed:\n' + summary; $('csNodePackageList')?.prepend(note);
    }
    if (result.count > 0) feedPush('Installed ' + result.count + ' Node.js package(s). Lifecycle scripts were not run.', { force: true });
  } catch (e) { csNodePackagesMessage(e.message || 'Package installation failed', true); }
  finally { csNodePackages.loading = false; if (install) { install.disabled = false; install.textContent = 'Install'; } if (refresh) refresh.disabled = false; }
}
$('csNodePackagesOpen')?.addEventListener('click', () => {
  csNodePackagesShow(true);
  if (!csNodePackages.loading) csNodePackagesRefresh().catch(e => csNodePackagesMessage(e.message || 'Could not load packages', true));
});
$('csNodePackagesBack')?.addEventListener('click', () => csNodePackagesShow(false));
$('csNodePackageRefresh')?.addEventListener('click', () => csNodePackagesRefresh().catch(e => csNodePackagesMessage(e.message || 'Could not refresh packages', true)));
$('csNodePackageInstall')?.addEventListener('click', () => csNodePackagesInstall());
$('csNodePackageSpec')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); csNodePackagesInstall(); } });
