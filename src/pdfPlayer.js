// Built-in PDF player: a borderless black window covering the output display, rendered with pdf.js.
// Unlike the external apps it needs no permissions and can be placed on any display directly.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let win = null;
let loaded = null;        // Promise for the player page finishing its first load
let current = null;       // { file }
let pending = new Map();  // token -> { resolve, reject }
let token = 0;
let listeners = { status: () => {}, closed: () => {} };

ipcMain.on('pdf:status', (_e, s) => {
  if (s.token && pending.has(s.token)) {
    const p = pending.get(s.token);
    pending.delete(s.token);
    if (s.ok) p.resolve(s); else p.reject(new Error(s.error || 'Could not open the PDF'));
  }
  if (s.ok) listeners.status(s);
});
ipcMain.on('pdf:stop', () => stop());

function on(event, fn) { listeners[event] = fn; }

// No chosen output: prefer the first external display, else the main one.
function defaultBounds() {
  const primary = screen.getPrimaryDisplay();
  const d = screen.getAllDisplays().find((x) => x.id !== primary.id) || primary;
  return d.bounds;
}

function ensureWindow(bounds) {
  if (win && !win.isDestroyed()) {
    win.setBounds(bounds);
    return loaded;
  }
  win = new BrowserWindow({
    ...bounds, frame: false, backgroundColor: '#000000', show: false, hasShadow: false,
    enableLargerThanScreen: true, skipTaskbar: true, title: 'needit Deck Cue — PDF',
    webPreferences: { preload: path.join(__dirname, 'pdf', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[pdf]', message); });
  win.on('closed', () => {
    win = null; loaded = null; current = null;
    for (const p of pending.values()) p.reject(new Error('PDF player closed'));
    pending.clear();
    listeners.closed();
  });
  loaded = win.loadFile(path.join(__dirname, 'pdf', 'player.html'));
  return loaded;
}

function command(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('pdf:cmd', cmd);
}

async function show(file, { startPage = 1, bounds = null } = {}) {
  const target = bounds || defaultBounds();
  const data = await fs.promises.readFile(file);
  await ensureWindow(target);
  const t = ++token;
  const done = new Promise((resolve, reject) => pending.set(t, { resolve, reject }));
  command({ type: 'load', token: t, data, startPage });
  const status = await done;
  current = { file };
  win.setBounds(target);
  win.show();
  await activateApp();
  win.focus();
  return status;
}

// Activate the app, otherwise macOS keeps keyboard focus in the previous app and a presentation
// clicker's keys never reach the player. macOS 14+ ignores an app activating itself, so reopen our
// own bundle through LaunchServices (like a Dock click) and fall back to app.focus().
function activateApp() {
  if (process.platform !== 'darwin') {
    app.focus({ steal: true });
    return Promise.resolve();
  }
  const bundle = process.execPath.split('/Contents/MacOS/')[0];
  return new Promise((resolve) => {
    execFile('open', ['-a', bundle], { timeout: 5000 }, (err) => {
      if (err) app.focus({ steal: true });
      resolve();
    });
  });
}

function nav(dir) {
  if (!win) return 'no show';
  command({ type: 'nav', dir });
}

function goto(page) {
  if (!win) return 'no show';
  command({ type: 'goto', page });
}

function stop() {
  if (win && !win.isDestroyed()) win.close();
}

// Only closes when that file is still the one showing (a PDF→PDF change reuses the window).
function close(file) {
  if (current && current.file === file) stop();
}

module.exports = { on, show, nav, goto, stop, close, isOpen: () => !!win };
