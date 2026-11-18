async function consumeSSE(pathname, signal, onData) {
  const r = await fetch(L.bridgeUrl.replace(/\/+$/, '') + pathname, {
    method: 'GET', signal, headers: { Authorization: 'Bearer ' + L.bridgeToken, Accept: 'text/event-stream' }, cache: 'no-store'
  });
  if (!r.ok || !r.body) throw new Error('Stream connection failed (' + r.status + ')');
  const reader = r.body.getReader(), decoder = new TextDecoder(); let buf = '';
  while (!signal.aborted) {
    const part = await reader.read(); if (part.done) break;
    buf += decoder.decode(part.value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const packet = buf.slice(0, at); buf = buf.slice(at + 2);
      for (const line of packet.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { onData(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  }
}

/* ================= bridge client ================= */
