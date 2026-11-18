'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('This helper prepares the Windows x64 portable EXE. Run it in Windows PowerShell / CMD.');
  process.exit(2);
}

const outDir = path.resolve(__dirname, '..', 'runtime');
const outFile = path.join(outDir, 'node.exe');
const tmpFile = outFile + '.download';
const base = 'https://nodejs.org/dist/latest-v22.x/';

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many download redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed (' + res.statusCode + '): ' + url)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function download(url, dest) {
  const response = await get(url);
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    response.pipe(stream);
    stream.on('finish', () => stream.close(resolve));
    stream.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const url = base + 'win-x64/node.exe';
  console.log('Downloading the official Node.js 22 x64 runtime…');
  await download(url, tmpFile);
  const size = fs.statSync(tmpFile).size;
  if (size < 15 * 1024 * 1024) throw new Error('Downloaded node.exe is unexpectedly small (' + size + ' bytes).');

  // Verify against the SHA-256 published with the same official Node.js release.
  const sumsResponse = await get(base + 'SHASUMS256.txt');
  let sums = '';
  for await (const chunk of sumsResponse) sums += chunk.toString('utf8');
  const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(parts => parts.length >= 2 && parts[1].replace(/^\*/, '') === 'win-x64/node.exe');
  if (!expected) throw new Error('Could not find win-x64/node.exe in official SHA256 manifest.');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tmpFile)).digest('hex');
  if (hash.toLowerCase() !== expected[0].toLowerCase()) throw new Error('SHA-256 verification failed for downloaded Node.js runtime.');

  fs.rmSync(outFile, { force: true });
  fs.renameSync(tmpFile, outFile);
  const version = execFileSync(outFile, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^v22\./.test(version)) throw new Error('Expected Node.js 22, got ' + version);
  console.log('Verified official runtime:', version, '(' + Math.round(size / 1024 / 1024) + ' MB)');
  console.log('Ready:', outFile);
})().catch(err => {
  try { fs.rmSync(tmpFile, { force: true }); } catch {}
  console.error('Runtime download failed:', err.message || err);
  process.exit(1);
});
