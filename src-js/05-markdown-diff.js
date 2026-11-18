const KW = {
  js: new Set('const let var function return if else for while switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of null true false undefined this super static yield do void delete interface type enum implements public private package int string bool float'.split(' ')),
  py: new Set('def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda pass break continue yield global nonlocal async await del assert self'.split(' ')),
  json: new Set(['true', 'false', 'null'])
};
const RX = {
  cb: /\/\*[\s\S]*?\*\//, ch: /<!--[\s\S]*?-->/, cl: /\/\/[^\n]*/, hc: /#[^\n]*/,
  tq: /"{3}[\s\S]*?"{3}|'{3}[\s\S]*?'{3}/,
  sq: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/,
  sqj: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/,
  tag: /<\/?[A-Za-z][\w:-]*|\/?>/, num: /\b\d[\d_.]*\b/, id: /[A-Za-z_$][\w$]*/
};
function langOf(path) {
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'kt', 'swift', 'javascript', 'typescript'].includes(ext)) return 'js';
  if (ext === 'json') return 'json';
  if (ext === 'py' || ext === 'python') return 'py';
  if (['html', 'htm', 'xml', 'svg', 'vue'].includes(ext)) return 'markup';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'rb', 'env', 'conf', 'shell'].includes(ext)) return 'hash';
  return 'plain';
}
function highlightLines(text, lang) {
  if (lang === 'plain') return text.split('\n').map(esc);
  const parts = [];
  if (lang === 'markup') parts.push(['c', RX.ch]); else if (lang !== 'py' && lang !== 'hash') parts.push(['c', RX.cb]);
  if (lang === 'js') parts.push(['c', RX.cl]);
  if (lang === 'py' || lang === 'hash') parts.push(['c', RX.hc]);
  if (lang === 'py') parts.push(['s', RX.tq]);
  parts.push(['s', lang === 'js' ? RX.sqj : RX.sq]);
  if (lang === 'markup') parts.push(['t', RX.tag]);
  parts.push(['n', RX.num]);
  if (KW[lang]) parts.push(['k', RX.id]);
  const re = new RegExp(parts.map(p => '(' + p[1].source + ')').join('|'), 'g');
  const lines = ['']; let last = 0, m;
  const push = (cls, str) => {
    str.split('\n').forEach((seg, i) => {
      if (i) lines.push('');
      if (seg) lines[lines.length - 1] += cls ? '<span class="t-' + cls + '">' + esc(seg) + '</span>' : esc(seg);
    });
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push('', text.slice(last, m.index));
    let gi = 1; while (m[gi] === undefined) gi++;
    let cls = parts[gi - 1][0];
    if (cls === 'k' && !KW[lang].has(m[0])) cls = '';
    push(cls, m[0]); last = re.lastIndex;
  }
  if (last < text.length) push('', text.slice(last));
  return lines;
}

const stripThink = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
function splitThink(t) {
  t = String(t || ''); const th = [];
  const text = t.replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (m, g) => { th.push(g.trim()); return ''; }).trim();
  return { think: th.join('\n\n').trim(), text };
}
function codeBlock(code, lang) {
  const l = langOf(lang || '');
  const html = l === 'plain' ? esc(code) : highlightLines(code, l).join('\n');
  return '<div class="cb"><div class="cbh"><span>' + esc(lang || 'text') + '</span><span class="sp"></span><button class="btn sm copy" type="button">Copy</button></div><pre><code>' + html + '</code></pre></div>';
}
function inlineMd(s) {
  return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function mdText(src) {
  const out = []; let para = [], list = null;
  const flushP = () => { if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push('<' + list.t + '>' + list.items.map(i => '<li>' + inlineMd(i) + '</li>').join('') + '</' + list.t + '>'); list = null; } };
  for (const line of src.split('\n')) {
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); out.push('<h' + (m[1].length < 3 ? 4 : 5) + '>' + inlineMd(m[2]) + '</h' + (m[1].length < 3 ? 4 : 5) + '>'); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line); }
  }
  flushP(); flushL();
  return out.join('');
}
function md(text) {
  return String(text).split(/```/).map((p, i) => {
    if (i % 2) { const nl = p.indexOf('\n'); return codeBlock((nl >= 0 ? p.slice(nl + 1) : p).replace(/\n$/, ''), nl >= 0 ? p.slice(0, nl).trim() : ''); }
    return mdText(p);
  }).join('');
}

function diffOps(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), Bm = b.slice(s, eb); let mid = [];
  if (A.length * Bm.length > 400000) mid = [...A.map(t => ['-', t]), ...Bm.map(t => ['+', t])];
  else {
    const n = A.length, m = Bm.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === Bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === Bm[j]) { mid.push([' ', A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push(['-', A[i++]]); else mid.push(['+', Bm[j++]]); }
    while (i < n) mid.push(['-', A[i++]]); while (j < m) mid.push(['+', Bm[j++]]);
  }
  return [...a.slice(0, s).map(t => [' ', t]), ...mid, ...a.slice(ea).map(t => [' ', t])];
}
function compactDiff(ops, ctx = 2) {
  let add = 0, del = 0; const show = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o[0] !== ' ') { if (o[0] === '+') add++; else del++; for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) show[k] = true; } });
  const lines = []; let gap = false;
  ops.forEach((o, i) => { if (show[i]) { gap = false; if (lines.length < 400) lines.push(o[0] + o[1]); } else if (!gap) { gap = true; lines.push('~'); } });
  return { add, del, lines };
}
const renderDiff = d => '<div class="diff">' + d.lines.map(l => l[0] === '~' ? '<div class="dl gap">⋯</div>' : '<div class="dl ' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '') + '">' + esc(l[0] === ' ' ? '  ' + l.slice(1) : l[0] + ' ' + l.slice(1)) + '</div>').join('') + '</div>';

/* ================= chat rendering ================= */
