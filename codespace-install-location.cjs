'use strict';

const fs = require('node:fs');
const path = require('node:path');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

function isDirectory(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
}

function isWritableDirectory(p) {
  try {
    if (!isDirectory(p)) return false;
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/**
 * Resolve the location of the *currently running* CodeSpace instance.
 * This deliberately inspects only known app paths supplied by Electron/the
 * backend process. It never scans user folders, drives, PATH, or the disk.
 */
function getInstallLocation(options = {}) {
  const appRoot = path.resolve(String(options.appRoot || options.backendRoot || process.cwd()));
  const backendFile = path.resolve(String(options.backendFile || path.join(appRoot, 'agent-server.js')));
  const launcher = options.launcherPath ? path.resolve(String(options.launcherPath)) : null;
  const portableDirectory = options.portableDirectory ? path.resolve(String(options.portableDirectory)) : null;
  const resourcesDirectory = options.resourcesDirectory ? path.resolve(String(options.resourcesDirectory)) : null;
  const packaged = options.packaged === true || String(options.packaged || '') === '1';
  const runtimeNode = resourcesDirectory ? path.join(resourcesDirectory, 'runtime', 'node.exe') : null;

  const files = {
    agentServer: exists(path.join(appRoot, 'agent-server.js')),
    appHtml: exists(path.join(appRoot, 'my-chat-agent-v3.html')),
    packageManifest: exists(path.join(appRoot, 'package.json')),
    sourceFragments: exists(path.join(appRoot, 'src-js', 'manifest.json')),
    stylesheets: isDirectory(path.join(appRoot, 'css')),
    desktopMain: exists(path.join(appRoot, 'desktop', 'main.cjs')),
    webBundle: exists(path.join(appRoot, 'js', 'app.js')),
    bundledNodeRuntime: !!runtimeNode && exists(runtimeNode)
  };
  const sourceTreePresent = files.agentServer && files.appHtml && files.packageManifest &&
    files.sourceFragments && files.stylesheets && files.desktopMain;
  const rootExists = isDirectory(appRoot);
  const writable = rootExists && isWritableDirectory(appRoot);

  return {
    schemaVersion: 1,
    ok: rootExists,
    installType: packaged ? 'packaged-desktop' : 'source-or-development',
    paths: {
      installRoot: appRoot,
      launcherExecutable: launcher,
      backendFile,
      portableDirectory,
      resourcesDirectory,
      bundledNodeRuntime: runtimeNode
    },
    source: {
      files,
      sourceTreePresent,
      sourceTreeWritable: sourceTreePresent && writable,
      note: sourceTreePresent
        ? (writable ? 'CodeSpace source files are present and the installation folder appears writable.' : 'CodeSpace source files are present, but the installation folder is not writable for this process.')
        : 'The running installation does not contain the complete editable source tree. The launcher/install root is still identified.'
    },
    access: { installRootExists: rootExists, installRootWritable: writable },
    discovery: 'Resolved from the active CodeSpace process; no drive or home-directory scan was performed.'
  };
}

module.exports = { getInstallLocation };
