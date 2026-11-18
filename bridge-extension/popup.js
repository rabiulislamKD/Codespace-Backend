'use strict';
const $ = id => document.getElementById(id);
const send = m => new Promise(r => chrome.runtime.sendMessage(m, x => r(x || {})));
async function refresh() {
  const s = await send({ type: 'state' });
  $('url').value = s.bridgeUrl || 'http://127.0.0.1:8787'; $('enabled').checked = !!s.enabled;
  if (s.hasToken && !$('token').value) $('token').placeholder = '•••••••• (saved)';
  const st = $('status');
  if (!s.enabled) { st.className = ''; st.textContent = 'Off. Tick “Allow the agent to use Chrome” and Save.'; }
  else if (!s.hasToken) { st.className = 'bad'; st.textContent = 'Paste the bridge token and Save.'; }
  else if (s.server && s.server.error) { st.className = 'bad'; st.textContent = 'Cannot reach CodeSpace: ' + s.server.error; }
  else if (s.server && s.server.connected) { st.className = 'ok'; st.textContent = 'Connected to CodeSpace.'; }
  else { st.className = ''; st.textContent = 'Connecting…'; }
  const ul = $('tabs'); ul.textContent = '';
  (s.tabs || []).forEach(t => {
    const li = document.createElement('li'), sp = document.createElement('span'), b = document.createElement('button');
    sp.textContent = (t.current ? '● ' : '') + (t.title || t.url) + (t.owned ? ' (opened by agent)' : ' (shared)'); sp.title = t.url;
    b.textContent = 'Remove'; b.onclick = async () => { await send({ type: 'unshare', tabId: t.id }); refresh(); };
    li.append(sp, b); ul.appendChild(li);
  });
  if (!(s.tabs || []).length) { const li = document.createElement('li'); li.textContent = 'None yet'; ul.appendChild(li); }
}
$('save').onclick = async () => {
  const cur = await chrome.storage.local.get({ token: '' });
  await chrome.storage.local.set({ bridgeUrl: $('url').value.trim() || 'http://127.0.0.1:8787', token: $('token').value.trim() || cur.token, enabled: $('enabled').checked });
  $('token').value = ''; await send({ type: 'wake' }); setTimeout(refresh, 600);
};
$('share').onclick = async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); if (t) { await send({ type: 'share', tabId: t.id }); refresh(); } };
$('stop').onclick = async () => { await send({ type: 'stopAll' }); refresh(); };
refresh(); setInterval(refresh, 3000);
