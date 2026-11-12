const APP_NAME = 'needit Deck Cue';
const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Menu, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const presenters = require('./presenters');

let win = null;
let show = null;
let showPath = null;
let dirty = false;
let shortcutReport = {};
const state = { liveCueId: null, live: null, armedCueId: null, busyCueId: null, blackout: false, message: null, messageLevel: null };
const blackoutWins = new Map();

const userFile = (name) => path.join(app.getPath('userData'), name);

function defaultShow() {
  return {
    schemaVersion: 1,
    showName: 'Untitled Show',
    settings: {
      defaultOutput: 'auto',          // 'auto' = let PowerPoint choose, or a display ref {id,label,width,height}
      defaultAutoSlideshow: true,
      pptApp: 'auto',                 // app for .ppt/.pptx: 'auto' (first installed) | 'powerpoint' | 'wps' | 'keynote'
      closePrevious: true,            // close the previous cue's presentation after the new one starts
      refocusAfterFire: false,        // bring Deck Cue back to front after a cue starts
      backdropDuringChangeover: false,// black window on the output while switching cues
      locked: false,
      globalKeys: { go: '', stop: '', blackout: '', next: '', prev: '' },
    },
    cues: [],
  };
}

function normalizeShow(s) {
  const d = defaultShow();
  const settings = { ...d.settings, ...(s.settings || {}) };
  settings.globalKeys = { ...d.settings.globalKeys, ...((s.settings || {}).globalKeys || {}) };
  return { ...d, ...s, settings, cues: Array.isArray(s.cues) ? s.cues : [] };
}

// ---------- persistence ----------
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function autosave() {
  try {
    fs.writeFileSync(userFile('autosave.deckcue'), JSON.stringify(show, null, 2));
    fs.writeFileSync(userFile('prefs.json'), JSON.stringify({ showPath, dirty }));
  } catch (e) { console.error('autosave failed', e); }
}

function loadInitial() {
  const prefs = readJSON(userFile('prefs.json')) || {};
  const auto = readJSON(userFile('autosave.deckcue'));
  show = normalizeShow(auto || defaultShow());
  showPath = prefs.showPath && fs.existsSync(prefs.showPath) ? prefs.showPath : null;
  dirty = !!prefs.dirty;
}

function withRelativePaths(s, file) {
  const dir = path.dirname(file);
  return {
    ...s,
    cues: s.cues.map((c) => (c.file && c.file.path ? { ...c, file: { ...c.file, rel: path.relative(dir, c.file.path) } } : c)),
  };
}

function writeShow(file) {
  fs.writeFileSync(file, JSON.stringify(withRelativePaths(show, file), null, 2));
  showPath = file;
  dirty = false;
  autosave();
  sendShow();
}

async function fileCommand(cmd) {
  if (cmd === 'new') {
    if (!(await confirmDiscard())) return;
    show = defaultShow(); showPath = null; dirty = false;
  } else if (cmd === 'open') {
    if (!(await confirmDiscard())) return;
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Deck Cue Show', extensions: ['deckcue', 'cueshow'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return;
    const data = readJSON(r.filePaths[0]);
    if (!data) { dialog.showErrorBox('Could not open show', 'The file is not a valid Deck Cue show.'); return; }
    show = normalizeShow(data); showPath = r.filePaths[0]; dirty = false;
    show.cues.forEach((c) => resolveCueFile(c));
  } else if (cmd === 'save' && showPath) {
    return writeShow(showPath);
  } else if (cmd === 'save' || cmd === 'saveAs') {
    const r = await dialog.showSaveDialog(win, { defaultPath: `${show.showName || 'Show'}.deckcue`, filters: [{ name: 'Deck Cue Show', extensions: ['deckcue'] }] });
    if (r.canceled || !r.filePath) return;
    return writeShow(r.filePath);
  }
  state.liveCueId = null; state.live = null; state.armedCueId = show.cues[0] ? show.cues[0].id : null;
  autosave(); registerShortcuts(); sendShow(); broadcast();
}

async function confirmDiscard() {
  if (!dirty || show.cues.length === 0) return true;
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2, message: 'Save changes to the current show?' });
  if (r.response === 2) return false;
  if (r.response === 0) { await fileCommand('save'); return !dirty; }
  return true;
}

// Missing files: try the stored relative path, then the same filename next to the show file.
function resolveCueFile(cue) {
  if (!cue.file || !cue.file.path) return null;
  if (fs.existsSync(cue.file.path)) return cue.file.path;
  if (showPath) {
    const dir = path.dirname(showPath);
    const candidates = [cue.file.rel && path.resolve(dir, cue.file.rel), path.join(dir, path.basename(cue.file.path))].filter(Boolean);
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) { cue.file.path = found; dirty = true; autosave(); sendShow(); return found; }
  }
  return null;
}

// ---------- displays ----------
function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, label: d.label || `Display ${i + 1}`, bounds: d.bounds, primary: d.id === primary, internal: !!d.internal, scaleFactor: d.scaleFactor,
  }));
}

function resolveOutput(ref) {
  if (!ref || ref === 'auto' || ref === 'default') return null;
  const ds = screen.getAllDisplays();
  const byId = ds.find((d) => d.id === ref.id);
  if (byId) return byId;
  const sameName = ds.filter((d) => d.label === ref.label);
  return sameName.find((d) => d.bounds.width === ref.width && d.bounds.height === ref.height) || (sameName.length === 1 ? sameName[0] : null);
}

function identifyDisplays() {
  listDisplays().forEach((d, i) => {
    const w = new BrowserWindow({
      x: d.bounds.x + Math.round(d.bounds.width / 2 - 260), y: d.bounds.y + Math.round(d.bounds.height / 2 - 160),
      width: 520, height: 320, frame: false, transparent: true, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false,
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const html = `<body style="margin:0;font-family:-apple-system;background:rgba(10,12,16,.92);color:#fff;border:4px solid #f5b400;border-radius:24px;height:312px;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div style="font-size:150px;font-weight:800;line-height:1">${i + 1}</div>
      <div style="font-size:22px;opacity:.85">${escapeHtml(d.label)}${d.primary ? ' · main' : ''}</div>
      <div style="font-size:16px;opacity:.6">${d.bounds.width}×${d.bounds.height}</div></body>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    setTimeout(() => !w.isDestroyed() && w.close(), 2500);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- blackout ----------
function blackoutTargets() {
  const d = resolveOutput(show.settings.defaultOutput);
  if (d) return [d];
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().filter((x) => x.id !== primary);
}

function showBlack(displays) {
  displays.forEach((d) => {
    if (blackoutWins.has(d.id)) return;
    const w = new BrowserWindow({
      ...d.bounds, frame: false, backgroundColor: '#000000', alwaysOnTop: true, focusable: false, skipTaskbar: true,
      hasShadow: false, enableLargerThanScreen: true, show: false,
    });
    w.setAlwaysOnTop(true, 'screen-saver', 2); // above the PDF player window
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.loadURL('data:text/html,<body style="background:#000;cursor:none"></body>');
    w.once('ready-to-show', () => { w.setBounds(d.bounds); w.showInactive(); });
    blackoutWins.set(d.id, w);
  });
}

function hideBlack() {
  for (const w of blackoutWins.values()) if (!w.isDestroyed()) w.close();
  blackoutWins.clear();
}

function toggleBlackout() {
  if (state.blackout) {
    hideBlack(); state.blackout = false;
  } else {
    const targets = blackoutTargets();
    if (!targets.length) return setMessage('Blackout needs an output display (only the main display is connected).', 'warn');
    showBlack(targets); state.blackout = true;
  }
  broadcast();
}

// ---------- cues ----------
function setMessage(msg, level = 'info') {
  state.message = msg; state.messageLevel = level; broadcast();
}

function cueAutoSlideshow(cue) {
  return cue.autoSlideshow === true || cue.autoSlideshow === false ? cue.autoSlideshow : show.settings.defaultAutoSlideshow;
}

async function fireCue(id) {
  const cue = show.cues.find((c) => c.id === id);
  if (!cue) return;
  if (state.busyCueId) return setMessage('Another cue is still loading…', 'warn');
  const file = resolveCueFile(cue);
  if (!file) return setMessage(`Cue “${cueName(cue)}”: file is missing (${cue.file ? cue.file.path : 'no file'})`, 'error');

  const appName = presenters.appFor(cue.app, file, show.settings.pptApp);
  if (!presenters.isInstalled(appName)) return setMessage(`${presenters.APPS[appName].name} is not installed on this Mac. Pick another app in the cue or in Settings.`, 'error');

  const auto = cueAutoSlideshow(cue);
  const outRef = !cue.output || cue.output === 'default' ? show.settings.defaultOutput : cue.output;
  let display = null;
  let warning = null;
  if (outRef && outRef !== 'auto') {
    display = resolveOutput(outRef);
    if (!display) warning = `Output “${outRef.label}” is not connected, so PowerPoint chose the display.`;
  }
  if (appName === 'wps' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true);
    return setMessage('WPS Office is controlled through its menus, so Deck Cue needs Accessibility permission (System Settings › Privacy & Security › Accessibility). Then fire the cue again.', 'error');
  }
  if (display && auto && appName === 'powerpoint' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true);
    warning = 'To send slideshows to a chosen output, allow Deck Cue under Privacy & Security › Accessibility. Using PowerPoint’s default display for now.';
    display = null;
  }
  if (display && appName === 'keynote') {
    warning = 'Keynote chooses its own display. Press X during the show to move it to another screen.';
    display = null;
  }

  state.busyCueId = id; state.message = null; broadcast();
  const prev = state.live;
  const backdrop = show.settings.backdropDuringChangeover && auto && !state.blackout;
  if (backdrop) showBlack(display ? [display] : blackoutTargets());
  try {
    const closePrev = show.settings.closePrevious && prev && prev.file !== file;
    if (prev && prev.app !== appName && auto) await presenters.stop(prev.app).catch(() => {});
    // WPS can't close a document while a slideshow is running, and switching its tabs pulls the editor
    // in front of the show, so close the previous deck before starting the next one.
    const closeFirst = closePrev && prev.app === 'wps';
    if (closeFirst) {
      if (auto) await presenters.stop('wps').catch(() => {});
      await presenters.close(prev.app, prev.file).catch(() => {});
    }
    await presenters.fire(appName, { file, startSlide: Number(cue.startSlide) || 1, auto, bounds: display ? display.bounds : null });
    if (closePrev && !closeFirst) await presenters.close(prev.app, prev.file).catch(() => {});
    state.live = { cueId: id, app: appName, file };
    state.liveDetail = null;
    registerShortcuts();
    state.liveCueId = id;
    const idx = show.cues.findIndex((c) => c.id === id);
    state.armedCueId = show.cues[idx + 1] ? show.cues[idx + 1].id : null;
    state.message = warning; state.messageLevel = warning ? 'warn' : null;
    if (show.settings.refocusAfterFire && win) setTimeout(() => { app.focus({ steal: true }); win.focus(); }, 400);
  } catch (e) {
    state.message = `Cue “${cueName(cue)}” failed: ${e.message}`; state.messageLevel = 'error';
  } finally {
    if (backdrop) setTimeout(() => { if (!state.blackout) hideBlack(); }, 350);
    state.busyCueId = null;
    broadcast();
  }
}

function cueName(cue) {
  return cue.label || (cue.file ? path.basename(cue.file.path, path.extname(cue.file.path)) : 'Untitled');
}

function go() {
  const id = state.armedCueId || (show.cues[0] && show.cues[0].id);
  if (id) fireCue(id);
}

async function stopAll() {
  await Promise.all(Object.keys(presenters.APPS).map((a) => presenters.stop(a).catch(() => {})));
  state.liveCueId = null; state.live = null; registerShortcuts(); broadcast();
}

async function navSlide(dir) {
  if (!state.live) return setMessage('Nothing is live.', 'warn');
  try { await presenters.nav(state.live.app, dir); } catch (e) { setMessage(`Slide ${dir} failed: ${e.message}`, 'error'); }
}

// ---------- shortcuts ----------
const GLOBAL_BLOCKLIST = ['Command+Q', 'Command+W', 'Command+Tab', 'Command+Space', 'Command+H', 'Command+M'];
function globalAllowed(accel) {
  if (!accel || GLOBAL_BLOCKLIST.includes(accel)) return false;
  const parts = accel.split('+');
  const key = parts[parts.length - 1];
  return parts.some((p) => ['Command', 'Control', 'Alt'].includes(p)) || /^F\d{1,2}$/.test(key);
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutReport = {};
  const used = new Set();
  const reg = (accel, key, fn) => {
    if (!accel) return;
    if (!globalAllowed(accel)) { shortcutReport[key] = 'Global shortcuts need ⌘, ⌃ or ⌥, or an F-key'; return; }
    if (used.has(accel)) { shortcutReport[key] = 'Duplicate shortcut'; return; }
    let ok = false;
    try { ok = globalShortcut.register(accel, fn); } catch { ok = false; }
    if (ok) used.add(accel); else shortcutReport[key] = 'Already used by another app or macOS';
  };
  const g = show.settings.globalKeys;
  reg(g.go, 'go', go);
  reg(g.stop, 'stop', stopAll);
  reg(g.blackout, 'blackout', toggleBlackout);
  reg(g.next, 'next', () => navSlide('next'));
  reg(g.prev, 'prev', () => navSlide('previous'));
  show.cues.forEach((c) => {
    if (c.shortcut && c.shortcut.accel && c.shortcut.global) reg(c.shortcut.accel, c.id, () => fireCue(c.id));
  });
  // While a PDF is live, take the keys a presentation clicker sends from whichever app has focus.
  // (PowerPoint/WPS/Keynote handle them themselves, so this applies to the built-in player only.)
  if (state.live && state.live.app === 'pdf') {
    for (const [accel, dir] of CLICKER_KEYS) {
      if (!used.has(accel)) { try { globalShortcut.register(accel, () => navSlide(dir)); } catch { /* ignore */ } }
    }
  }
}
const CLICKER_KEYS = [['PageDown', 'next'], ['PageUp', 'previous'], ['Right', 'next'], ['Left', 'previous'], ['Down', 'next'], ['Up', 'previous']];

// ---------- ipc ----------
function sendShow() {
  if (win && !win.isDestroyed()) win.webContents.send('show', { show, showPath, dirty, shortcutReport });
  updateTitle();
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
}

function updateTitle() {
  if (!win) return;
  win.setTitle(`${APP_NAME} — ${showPath ? path.basename(showPath) : show.showName}${dirty ? ' •' : ''}`);
  win.setDocumentEdited(dirty);
}

function setupIpc() {
  ipcMain.handle('show:get', () => ({ show, showPath, dirty, shortcutReport, state }));
  ipcMain.handle('show:update', (_e, s) => {
    show = normalizeShow(s); dirty = true;
    if (state.armedCueId && !show.cues.some((c) => c.id === state.armedCueId)) state.armedCueId = null;
    autosave(); registerShortcuts(); updateTitle();
    return { shortcutReport, dirty };
  });
  ipcMain.handle('show:file', (_e, cmd) => fileCommand(cmd));
  ipcMain.handle('displays:list', () => listDisplays());
  ipcMain.handle('displays:identify', () => identifyDisplays());
  ipcMain.handle('cue:fire', (_e, id) => fireCue(id));
  ipcMain.handle('cue:arm', (_e, id) => { state.armedCueId = id; broadcast(); });
  ipcMain.handle('cue:go', () => go());
  ipcMain.handle('cue:stop', () => stopAll());
  ipcMain.handle('cue:nav', (_e, dir) => navSlide(dir));
  ipcMain.handle('blackout:toggle', () => toggleBlackout());
  ipcMain.handle('message:clear', () => { state.message = null; broadcast(); });
  ipcMain.handle('files:status', (_e, paths) => Object.fromEntries(paths.map((p) => [p, fs.existsSync(p)])));
  ipcMain.handle('files:resolve', () => { show.cues.forEach((c) => resolveCueFile(c)); return show; });
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Presentations', extensions: presenters.SUPPORTED_EXT.map((e) => e.slice(1)) }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('files:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('env:status', () => ({
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    apps: Object.entries(presenters.APPS).map(([id, a]) => ({ id, name: a.name, short: a.short, installed: presenters.isInstalled(id) })),
    pptApp: presenters.pptApp(show.settings.pptApp),
    supportedExt: presenters.SUPPORTED_EXT,
  }));
  ipcMain.handle('env:requestAccessibility', () => {
    systemPreferences.isTrustedAccessibilityClient(true);
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
}

function buildMenu() {
  const send = (cmd) => () => fileCommand(cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'New Show', accelerator: 'Command+N', click: send('new') },
      { label: 'Open Show…', accelerator: 'Command+O', click: send('open') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'Command+S', click: send('save') },
      { label: 'Save As…', accelerator: 'Shift+Command+S', click: send('saveAs') },
    ] },
    { role: 'editMenu' },
    { label: 'Show', submenu: [
      { label: 'Identify Displays', click: identifyDisplays },
      { label: 'Stop All Slideshows', click: stopAll },
      { label: 'Toggle Blackout', click: toggleBlackout },
    ] },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560, backgroundColor: '#0e1014', title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));
  win.on('close', async (e) => {
    if (dirty && show.cues.length && !app.isQuitting) {
      e.preventDefault();
      if (await confirmDiscard()) { app.isQuitting = true; app.quit(); }
    }
  });
  win.on('closed', () => { win = null; });
  updateTitle();
}

app.whenReady().then(() => {
  presenters.pdfPlayer.on('status', (s) => {
    if (process.env.DECKCUE_DEBUG) console.log(`[pdf] page ${s.page}/${s.pages}`);
    if (state.live && state.live.app === 'pdf') { state.liveDetail = `page ${s.page}/${s.pages}`; broadcast(); }
  });
  presenters.pdfPlayer.on('closed', () => {
    if (state.live && state.live.app === 'pdf') { state.live = null; state.liveCueId = null; state.liveDetail = null; registerShortcuts(); broadcast(); }
  });
  loadInitial();
  setupIpc();
  buildMenu();
  createWindow();
  registerShortcuts();
  const onDisplays = () => { if (win) win.webContents.send('displays', listDisplays()); };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); hideBlack(); });
app.on('window-all-closed', () => app.quit());
