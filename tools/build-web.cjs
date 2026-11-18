#!/usr/bin/env node
/* CodeSpace web app builder.
 *
 * Source of truth:  my-chat-agent-v3.html (entry) + css/*.css + src-js/*.js
 * Built artifact:   js/app.js                (the IIFE app bundle served to the browser)
 *
 * Rebuild:  node tools/build-web.cjs          (force rebuild)
 * Optional: node tools/build-web.cjs --single (also export CodeSpace-single-file.html:
 *           everything inlined into one portable HTML; regenerable, not stored in the repo)
 * API:      require('.../tools/build-web.cjs').ensure()  → rebuilds only when a fragment is newer
 *                        than js/app.js (called by agent-server.js before serving the file).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src-js');
const MANIFEST = path.join(SRC_DIR, 'manifest.json');
const OUT_DIR = path.join(ROOT, 'js');
const OUT_APP = path.join(OUT_DIR, 'app.js');

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function assemble() {
  const man = readManifest();
  const parts = [man.header];
  for (const f of man.core) parts.push(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
  parts.push(man.footer);
  parts.push(fs.readFileSync(path.join(SRC_DIR, man.pwa), 'utf8'));
  parts.push(man.tail);
  return parts.join('');
}

/* Build js/app.js from the src-js fragments. Throws on syntax errors so a broken
   edit can never silently ship to the browser. */
function build() {
  const code = assemble();
  try { new vm.Script(code, { filename: 'js/app.js' }); }
  catch (e) {
    throw new Error('src-js has a syntax error — fix it and rebuild:\n' + e.message +
      '\n(Hint: check the fragment you edited last. Each fragment is a plain JS script.)');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_APP, code);
  return { bytes: Buffer.byteLength(code), out: OUT_APP };
}

/* Optional single-file export (only with --single): css + js inlined into one portable HTML. */
function buildSingleFile() {
  const entry = path.join(ROOT, 'my-chat-agent-v3.html');
  let html = fs.readFileSync(entry, 'utf8');
  // inline the css link lines
  html = html.replace(/[ \t]*<link rel="stylesheet" href="css\/([^"]+)">[^\n]*\n/g, (m, name) => {
    const css = fs.readFileSync(path.join(ROOT, 'css', name), 'utf8');
    return '<style>\n' + css + '</style>\n';
  });
  // inline the app script
  html = html.replace(/[ \t]*<script src="js\/app\.js"><\/script>/, () => '<script>\n' + fs.readFileSync(OUT_APP, 'utf8') + '</script>');
  const out = path.join(ROOT, 'CodeSpace-single-file.html');
  fs.writeFileSync(out, html);
  return out;
}

function newestSrcMtime() {
  let newest = 0;
  for (const f of fs.readdirSync(SRC_DIR)) {
    const st = fs.statSync(path.join(SRC_DIR, f));
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

/* Rebuild only when needed. Safe to call on every request: two stat calls when fresh. */
function ensure() {
  let builtM = 0;
  try { builtM = fs.statSync(OUT_APP).mtimeMs; } catch { /* not built yet */ }
  if (builtM && builtM >= newestSrcMtime()) return false;
  build();
  return true;
}

module.exports = { build, ensure, buildSingleFile, assemble };

if (require.main === module) {
  try {
    const r = build();
    console.log('OK  js/app.js rebuilt from src-js/ (' + r.bytes + ' bytes)');
    if (process.argv.includes('--single')) {
      try { const sf = buildSingleFile(); console.log('OK  single-file export → ' + path.basename(sf)); }
      catch (e) { console.log('WARN single-file export failed: ' + e.message); }
    }
  } catch (e) {
    console.error('BUILD FAILED: ' + e.message);
    process.exit(1);
  }
}
