// Timer on the output screen: one transparent, click-through window covering a display, drawn above the
// slideshow (PowerPoint, WPS, Keynote, the PDF player) but below Blackout. It shows either a full-screen
// timer or a small corner overlay; the page (src/timer/screen.*) counts down on its own between updates.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let win = null;
let loaded = null;
let displayId = null;
let visible = false;
let onDismiss = () => {};

ipcMain.on('timerscreen:dismiss', () => onDismiss());

function ensure(display) {
  if (win && !win.isDestroyed() && displayId === display.id) return loaded;
  if (win && !win.isDestroyed()) win.destroy();
  displayId = display.id;
  visible = false;
  win = new BrowserWindow({
    ...display.bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    focusable: false, skipTaskbar: true, resizable: false, show: false, enableLargerThanScreen: true,
    title: 'needit Deck Cue — Timer',
    webPreferences: { preload: path.join(__dirname, 'timer', 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver', 1); // above the PDF player (0), below Blackout (2)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[timer screen]', message); });
  win.on('closed', () => { win = null; loaded = null; displayId = null; visible = false; });
  loaded = win.loadFile(path.join(__dirname, 'timer', 'screen.html'));
  return loaded;
}

let latest = 0;
// mode: 'off' | 'full' | 'pip'. clickToClose: the full-screen timer covers the operator's own screen,
// so a click on it must be able to dismiss it.
async function update({ mode, display, clickToClose, payload }) {
  const run = ++latest;
  if (mode === 'off' || !display) {
    if (win && !win.isDestroyed() && visible) { win.hide(); visible = false; }
    return;
  }
  await ensure(display);
  if (run !== latest || !win || win.isDestroyed()) return; // a newer update took over
  win.setBounds(display.bounds);
  win.setIgnoreMouseEvents(!clickToClose);
  win.webContents.send('timerscreen:state', { ...payload, mode, clickToClose: !!clickToClose });
  if (!visible) { win.showInactive(); win.setBounds(display.bounds); visible = true; }
}

function close() {
  if (win && !win.isDestroyed()) win.destroy();
}

module.exports = { update, close, onDismiss: (fn) => { onDismiss = fn; } };
