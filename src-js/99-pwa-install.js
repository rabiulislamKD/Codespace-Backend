(function () {
  const btn = document.getElementById('pwaInstallBtn'), hint = document.getElementById('pwaHint'), st = document.getElementById('pwaStatus');
  if (!btn || !hint) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferred = null;
  if (standalone) { hint.textContent = 'You are running the installed app.'; return; }
  if (!/^https?:$/.test(location.protocol) || !window.isSecureContext) {
    hint.textContent = 'Open this page from the bridge address (for example http://127.0.0.1:8787) or an HTTPS address to install it. Browsers only allow installing from localhost or HTTPS, not from a saved file.';
  } else if (ios) {
    hint.textContent = 'On iPhone/iPad: tap Share, then Add to Home Screen.';
  } else {
    hint.textContent = 'If no Install button appears, use your browser menu (Install app / Add to Home screen).';
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) st.textContent = 'Update ready. Reload to use the new version.'; }); });
    }).catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; btn.hidden = false; hint.textContent = 'Install this workspace as an app with its own window.'; });
  btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); const r = await deferred.userChoice.catch(() => null); st.textContent = r && r.outcome === 'accepted' ? 'Installed.' : ''; deferred = null; btn.hidden = true; });
  window.addEventListener('appinstalled', () => { st.textContent = 'Installed.'; btn.hidden = true; });
})();