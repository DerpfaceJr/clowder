'use strict';
// Clowder desktop shell (the Cat Town server). Starts the existing Fastify server as a child process (Electron run as Node),
// waits for it to answer, then shows the town in a window. The server and its children stop on quit.
const {app, BrowserWindow, Menu, dialog, safeStorage, shell} = require('electron');
const {spawn, spawnSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const LOG_TAIL_LINES = 40;
// Copies of the :root tokens in public/style.css (--paper, --ink). Keep them in step.
const PAPER = '#fffdf8';
const INK = '#4b473d';
const READY_TIMEOUT_MS = 60000;

const root = app.getAppPath();
const loadingFile = path.join(root, 'desktop', 'loading.html');
const loadingUrl = pathToFileURL(loadingFile).href;
// This launch's owner session (src/access.ts, security pass H2): the server gets the key, and only this window holds the cookie. Another
// browser on this computer (the cats', or any other program) reaches the town without it, so it is not the owner.
const ownerKey = randomBytes(32).toString('base64url');
const ownerCookie = port => `town_owner_${port}`;

let win = null;
let server = null;      // { child, exited, port, origin }
let stopping = false;   // quitting: no exit is unexpected any more
let restoring = false;  // a restore is swapping files (plan 7.6)
let launchPlan = null;  // { dataDir, port, remotePort }, so a restore restarts the server the same way
let logFile = '';
const logLines = [];

function appendLog(chunk) {
  const text = String(chunk);
  try { fs.appendFileSync(logFile, text); } catch { /* log folder not writable: the tail below still shows output */ }
  for (const line of text.split(/\r?\n/)) {
    if (line) logLines.push(line);
  }
  if (logLines.length > LOG_TAIL_LINES) logLines.splice(0, logLines.length - LOG_TAIL_LINES);
}

function logTail() {
  return logLines.slice(-LOG_TAIL_LINES).join('\n');
}

// Config comes from the real loader in src/config.ts (town.config.json plus town.local.json), run through tsx.
function readConfig() {
  const script = `import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'config.ts')).href)})`
    + `.then(m=>process.stdout.write(JSON.stringify(m.loadConfig(${JSON.stringify(root)}))))`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: root,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    windowsHide: true,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`Cannot read town.config.json.\n${(r.stderr || r.error?.message || '').slice(-1200)}`);
  const cfg = JSON.parse(r.stdout);
  return {port: Number(cfg.port), remotePort: Number(cfg.remote?.port)};
}

function probePort(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({port, host: '127.0.0.1'}, () => probe.close(() => resolve(true)));
  });
}

// First free port at or after start, skipping any in `taken`.
async function freePort(start, taken = []) {
  for (let port = start; port < 65535; port++) {
    if (taken.includes(port)) continue;
    if (await probePort(port)) return port;
  }
  throw new Error(`No free port from ${start} upward.`);
}

function ping(url, port) {
  return new Promise(resolve => {
    const req = http.get(url, {timeout: 1500, headers: {cookie: `${ownerCookie(port)}=${ownerKey}`}}, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer(origin, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!server || server.exited) return false;
    if (await ping(`${origin}/api/state`, port)) return true;
    await sleep(300);
  }
  return false;
}

function startServer(dataDir, port, remotePort) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    CAT_REMOTE_PORT: String(remotePort),
    CAT_TOWN_DATA: dataDir,
    // The server's SecretStore asks this process to encrypt and decrypt over the IPC channel (serveSecrets).
    CAT_SECRETS_BROKER: '1',
    CAT_OWNER_KEY: ownerKey,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serveSecrets(child);
  const state = {child, exited: false, ready: false, stopping: false, port, origin: `http://127.0.0.1:${port}`};
  // The server staged a restore (src/restore.ts) and asks this process to stop it, swap the files and start it again.
  child.on('message', (m) => { if (m && m.restore && typeof m.restore.staging === 'string') void restoreStaged(m.restore.staging); });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.once('exit', (code) => {
    state.exited = true;
    if (stopping || state.stopping) return;
    appendLog(`[desktop] server exited with code ${code}\n`);
    // Before the window has the town, waitForServer reports the failure with this log tail.
    if (state.ready) showError('The town server stopped unexpectedly.');
  });
  child.once('error', (err) => appendLog(`[desktop] server failed to start: ${err.message}\n`));
  return state;
}

// The SecretStore's broker (src/secret-store.ts): only this process holds the OS key, through safeStorage's async API (the sync one goes in
// Electron 46). Values cross as base64 blobs. A refusal never carries the value. boot() runs after app ready, which safeStorage needs.
// ponytail: shouldReEncrypt is ignored; the value is re-encrypted the next time it is saved.
function serveSecrets(child) {
  child.on('message', async (m) => {
    if (!m || typeof m.secret !== 'number') return;
    let reply;
    try {
      const data = String(m.data ?? '');
      const result = m.op === 'available' ? await safeStorage.isAsyncEncryptionAvailable()
        : m.op === 'encrypt' ? (await safeStorage.encryptStringAsync(data)).toString('base64')
        : m.op === 'decrypt' ? (await safeStorage.decryptStringAsync(Buffer.from(data, 'base64'))).result
        : undefined;
      reply = result === undefined ? {secretReply: m.secret, ok: false, error: 'Unknown request.'} : {secretReply: m.secret, ok: true, result};
    } catch {
      reply = {secretReply: m.secret, ok: false, error: 'The system key store refused.'};
    }
    try { if (child.connected) child.send(reply); } catch { /* the server is gone */ }
  });
}

// Asks the server to shut down over IPC first, so seasons stop through their own handlers and leave no locks.
// On Windows child.kill() is TerminateProcess, so a server that has not exited within the grace period gets
// taskkill /T, which also reaches its own children (season runs, cloudflared).
const SHUTDOWN_GRACE_MS = 6000;
// quitting false: a restore stops this server to start another, so only this child's exit is expected.
async function stopServer({quitting = true} = {}) {
  if (quitting) stopping = true;
  if (!server) return;
  server.stopping = true;
  const {child} = server;server = null;
  if (child.exitCode === null && child.connected) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try { child.send('shutdown'); } catch { /* channel already closed */ }
    await Promise.race([exited, sleep(SHUTDOWN_GRACE_MS)]);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
  } else {
    child.kill('SIGTERM');
  }
}

// The server's busyReason() over the IPC channel (plan 7.10): a reason string while a task or season runs, null when idle. No server process
// means nothing can be running. A server that does not answer in time counts as busy.
const BUSY_TIMEOUT_MS = 5000;
let busySeq = 0;
function askBusy() {
  if (restoring) return Promise.resolve('A restore is running.');
  const s = server;
  if (!s || s.exited) return Promise.resolve(null);
  if (!s.ready || !s.child.connected) return Promise.resolve('The town is not ready.');
  return new Promise((resolve) => {
    const id = ++busySeq;
    const done = (reason) => { clearTimeout(timer); s.child.off('message', onMessage); resolve(reason); };
    const timer = setTimeout(() => done('The town did not answer.'), BUSY_TIMEOUT_MS);
    function onMessage(m) { if (m && m.busyReply === id) done(m.reason === null ? null : String(m.reason || 'The town did not say.')); }
    s.child.on('message', onMessage);
    try { s.child.send({busyQuery: id}); } catch { done('The town did not answer.'); }
  });
}

// Auto-update (plan 7.10), only in a release build whose app-update.yml names the publisher (updaterOff in desktop/update-gate.cjs).
// Downloads run in the background; installs go through updateGate, never electron-updater's own install on quit.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const UPDATE_OFFER_MS = 60 * 1000;
let updates = null;
async function startUpdater() {
  if (!app.isPackaged) return;
  const {updateGate, updaterOff, NOT_RELEASE} = require('./update-gate.cjs');
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')); } catch { /* no stamp: not a release */ }
  if (updaterOff(info) === NOT_RELEASE) return; // a local build never loads electron-updater
  const {autoUpdater} = require('electron-updater');
  const log = (level) => (msg) => appendLog(`[updater] ${level}: ${msg}\n`);
  autoUpdater.logger = {info: log('info'), warn: log('warn'), error: log('error'), debug: () => {}};
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // configOnDisk is the same parsed app-update.yml that NsisUpdater.verifySignature reads its publisherName from.
  const off = await autoUpdater.configOnDisk.value.then((cfg) => updaterOff(info, cfg), (err) => err.message);
  if (off) { appendLog(`[updater] off: ${off}.\n`); return; }
  updates = updateGate({
    updater: autoUpdater,
    askBusy,
    stopServer,
    quit: () => app.quit(),
    restart: () => launch(),
    offer: async (version) => {
      if (!win || win.isDestroyed()) return 'quit';
      const {response} = await dialog.showMessageBox(win, {
        type: 'info', title: 'Update ready', message: `Update ready: Clowder ${version}`,
        detail: 'The town is idle. Restart now to install it, or it installs the next time you quit Clowder while no task is running.',
        buttons: ['Restart now', 'At next quit'], defaultId: 0, cancelId: 1, noLink: true,
      });
      return response === 0 ? 'now' : 'quit';
    },
  });
  let offerTimer = null;
  autoUpdater.on('error', (err) => appendLog(`[updater] ${err && err.message || err}\n`));
  autoUpdater.on('update-downloaded', (event) => {
    updates.downloaded(event.version);
    const tryOffer = () => void updates.tryOffer().then((r) => { if (r === 'installing' || r === 'at-quit' || r === 'failed') clearInterval(offerTimer); }, () => {});
    clearInterval(offerTimer);
    offerTimer = setInterval(tryOffer, UPDATE_OFFER_MS);
    tryOffer();
  });
  const check = () => void autoUpdater.checkForUpdates().catch(() => { /* logged by the error event */ });
  check();
  setInterval(check, UPDATE_CHECK_MS).unref();
}

function showError(message) {
  console.error(message);
  if (!win || win.isDestroyed()) return;
  const tail = `${logTail()}\n\nFull log: ${logFile}`;
  win.webContents.executeJavaScript(
    `window.showError(${JSON.stringify(message)},${JSON.stringify(tail)})`,
  ).catch(() => {});
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.href === loadingUrl) return true;
    return !!server && u.origin === server.origin;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') shell.openExternal(u.href);
  } catch { /* not a URL */ }
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getNormalBounds();
  try {
    fs.mkdirSync(path.dirname(windowStateFile()), {recursive: true});
    fs.writeFileSync(windowStateFile(), JSON.stringify({...bounds, maximized: win.isMaximized()}));
  } catch { /* not remembered this time */ }
}

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow({
    title: 'Clowder',
    icon: path.join(root, 'public', 'icons', 'icon-512.png'),
    width: saved.width || 1280,
    height: saved.height || 820,
    x: Number.isInteger(saved.x) ? saved.x : undefined,
    y: Number.isInteger(saved.y) ? saved.y : undefined,
    minWidth: 800,
    minHeight: 600,
    show: false,
    // Paper colour: no white flash before the page paints. Caption buttons sit in the header's band. Windows draws no menu
    // bar for a hidden title bar, so a lone Alt press opens the application menu as a popup instead (see createWindow).
    backgroundColor: PAPER,
    titleBarStyle: 'hidden',
    titleBarOverlay: {color: PAPER, symbolColor: INK, height: 56},
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('close', saveWindowState);
  win.on('closed', () => { win = null; });

  const contents = win.webContents;
  // A lone Alt press, the Windows way to reach a hidden menu bar, opens the application menu under the header: with the
  // title bar hidden it is the only way to Devices and Restore a backup, which matters most when the town cannot open.
  let altAlone = false;
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') altAlone = input.key === 'Alt' && !input.isAutoRepeat;
    else if (input.type === 'keyUp' && input.key === 'Alt' && altAlone) {
      altAlone = false;
      Menu.getApplicationMenu()?.popup({window: win, x: 12, y: 56});
    }
  });
  contents.setWindowOpenHandler(({url}) => {
    openExternal(url);
    return {action: 'deny'};
  });
  contents.on('will-navigate', (event, url) => {
    if (isAllowedUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });
  contents.on('did-finish-load', () => {
    if (server && contents.getURL().startsWith(server.origin)) {
      console.log(`Clowder window loaded: ${contents.getURL()}`);
    }
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // The page's own <title> would replace "Cat Town" in the window title bar.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.loadFile(loadingFile);
  return win;
}

// The Devices button in the town UI opens the pairing dialog; this just clicks it.
function openDevices() {
  if (!win || win.isDestroyed()) return;
  focusWindow();
  win.webContents.executeJavaScript("document.getElementById('share')?.click()").catch(() => {});
}

// Restore (plan 7.6, src/restore.ts). The town's own dialog (public/restore-dialog.js) picks the point and the server stages it; this
// process then stops the server, swaps the files in a worker and starts it again. The recovery key is typed into that dialog and stays in
// the server: it never reaches this process, a command line or a log. When the town cannot open there is no dialog, so a local snapshot
// is picked from a native box instead and staged by the worker, which asks this process's safeStorage for the saved keys.
function openRestore() {
  if (restoring) return;
  if (server && server.ready && win && !win.isDestroyed()) {
    focusWindow();
    win.webContents.executeJavaScript('window.openRestore?.()').catch(() => {});
    return;
  }
  void rescueRestore();
}

// One worker run: src/restore.ts restoreWorker(job) under tsx, with the IPC channel so it can reach safeStorage. job carries paths and a
// snapshot name, never a key. Resolves {ok, ...result} or {ok: false, error}.
function runRestoreWorker(job) {
  const script = `import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'restore.ts')).href)})`
    + `.then(m=>m.restoreWorker(${JSON.stringify(job)}))`
    + `.then(r=>process.stdout.write(JSON.stringify({ok:true,...r})),e=>process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)})))`
    + `.finally(()=>{try{process.disconnect()}catch{}})`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: root,
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1', CAT_SECRETS_BROKER: '1'},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    serveSecrets(child);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', appendLog);
    child.once('error', (err) => resolve({ok: false, error: err.message}));
    child.once('exit', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ok: false, error: 'The restore worker stopped without an answer.'}); }
    });
  });
}

function showRestoring(text) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  return win.loadFile(loadingFile).then(() => win.webContents.executeJavaScript(
    `document.getElementById('title').textContent='Restoring your town';document.getElementById('msg').textContent=${JSON.stringify(text)};`,
  )).catch(() => {});
}

// The swap, with the server stopped, then the server again on the same port. A failed swap has put the old files back (applyRestore), so
// the town restarts as it was and says why.
async function swapAndRelaunch(job, label) {
  restoring = true;
  try {
    await showRestoring('Clowder stopped the town and is putting the files back. It starts again in a moment.');
    await stopServer({quitting: false});
    if (stopping) return;
    const r = await runRestoreWorker(job);
    appendLog(r.ok ? `[desktop] restored ${label}; the previous files are in ${r.before}\n` : `[desktop] restore failed: ${r.error}\n`);
    await launch();
    if (win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, r.ok
        ? {type: 'info', title: 'Restored', message: `Your town is back at ${label}.`, detail: `The files it replaced are in ${r.before}. Restore that snapshot to undo this.`}
        : {type: 'error', title: 'Restore failed', message: 'Nothing was changed: your town is as it was.', detail: r.error});
    }
  } finally {
    restoring = false;
  }
}

function restoreStaged(staging) {
  if (restoring || !launchPlan) return;
  // Only the folder the server makes: <data>/backups/restore-staging-<8 hex>.
  const backups = path.join(launchPlan.dataDir, 'backups');
  const resolved = path.resolve(staging);
  if (path.dirname(resolved) !== backups || !/^restore-staging-[0-9a-f]{8}$/.test(path.basename(resolved))) return;
  return swapAndRelaunch({dataDir: launchPlan.dataDir, apply: resolved}, 'the point you chose');
}

async function rescueRestore() {
  if (restoring || !launchPlan) return;
  const listed = await runRestoreWorker({dataDir: launchPlan.dataDir, list: true});
  const snapshots = listed.ok ? listed.snapshots.slice(0, 5) : [];
  const parent = win && !win.isDestroyed() ? win : undefined;
  if (!snapshots.length) {
    await dialog.showMessageBox(parent, {type: 'info', title: 'Restore a backup', message: 'There is no snapshot on this computer to restore.',
      detail: 'A backup folder is restored from the town itself, under Settings > Backups, once Clowder opens.'});
    return;
  }
  const name = s => `${s.kind === 'pre' ? `Before the update to ${s.commit}` : 'Before a restore'}, ${new Date(s.at).toLocaleString()}`;
  const {response} = await dialog.showMessageBox(parent, {
    type: 'question', title: 'Restore a backup', message: 'The town cannot open. Restore a snapshot from this computer?',
    detail: 'Clowder moves the current files to backups/before-restore-<time>/ first, so this can be undone.',
    buttons: ['Cancel', ...snapshots.map(name)], cancelId: 0, defaultId: 0, noLink: true,
  });
  if (!response) return;
  const chosen = snapshots[response - 1];
  await swapAndRelaunch({dataDir: launchPlan.dataDir, snapshot: chosen.id}, name(chosen));
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Clowder',
      submenu: [
        {label: 'Devices…', click: openDevices},
        {label: 'Restore a backup…', click: openRestore},
        {type: 'separator'},
        {role: 'quit'},
      ],
    },
    {role: 'editMenu'},
    {role: 'viewMenu'},
    {role: 'windowMenu'},
  ]);
}

function dataFolder() {
  if (process.env.CAT_TOWN_DATA) return path.resolve(process.env.CAT_TOWN_DATA);
  return app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(root, 'data');
}

// Starts the server and shows the town in the window. boot() runs it once; a restore runs it again on the same ports.
async function launch() {
  const {dataDir, port, remotePort} = launchPlan;
  server = startServer(dataDir, port, remotePort);
  const started = server;
  const ready = await waitForServer(started.origin, port);
  if (!win || win.isDestroyed()) return;
  if (!ready) {
    showError(started.exited ? 'The town server stopped before it was ready.' : 'The town server did not answer in time.');
    return;
  }
  started.ready = true;
  // A session cookie: never written to disk, and the next launch makes a new key anyway.
  await win.webContents.session.cookies.set({url: started.origin, name: ownerCookie(port), value: ownerKey, httpOnly: true, sameSite: 'strict', path: '/'});
  await win.loadURL(started.origin + '/');
}

async function boot() {
  createWindow();
  Menu.setApplicationMenu(buildMenu());
  try {
    const dataDir = dataFolder();
    fs.mkdirSync(dataDir, {recursive: true});
    const logDir = app.getPath('userData');
    fs.mkdirSync(logDir, {recursive: true});
    logFile = path.join(logDir, 'server.log');
    fs.writeFileSync(logFile, `Clowder ${new Date().toISOString()}\ndata: ${dataDir}\n`);

    const cfg = readConfig();
    const port = await freePort(Number(process.env.PORT || cfg.port));
    const remotePort = process.env.CAT_REMOTE_PORT
      ? Number(process.env.CAT_REMOTE_PORT)
      : await freePort(cfg.remotePort, [port]);

    launchPlan = {dataDir, port, remotePort};
    await launch();
    await startUpdater().catch((err) => appendLog(`[updater] off: ${err.message}\n`));
  } catch (err) {
    console.error(err);
    appendLog(`[desktop] ${err.message}\n`);
    showError(err.message);
  }
}

function focusWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  let stopped = false;
  app.on('will-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    // A downloaded update the owner left for "at next quit" installs here, only if the town is idle and after the server has stopped.
    void (updates ? updates.onQuit() : stopServer()).catch(() => stopServer()).finally(() => { stopped = true; app.quit(); });
  });
}
