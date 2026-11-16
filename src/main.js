const APP_NAME = 'needit Deck Cue';
const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut, Menu, systemPreferences, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const IS_MAC = process.platform === 'darwin';
// Windows portable build: keep settings and autosave next to the .exe so the show travels with it.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'needit Deck Cue Data'));
}

// A second copy on the same computer (e.g. testing main + backup) needs its own settings: --profile=name.
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const PROFILE = (profileArg ? profileArg.slice('--profile='.length) : process.env.DECKCUE_PROFILE || '').replace(/[^\w-]/g, '');
if (PROFILE) app.setPath('userData', `${app.getPath('userData')} (${PROFILE})`);

const presenters = require('./presenters');
const { createControlServer, localAddresses } = require('./control/server');
const { createFollower } = require('./control/follower');
const preflight = require('./preflight');
const showmode = require('./showmode');
const { createVersionWatcher } = require('./versions');
const { createThumbnailer } = require('./thumbs');
const timerScreen = require('./timerScreen');
const { createManage } = require('./control/manage');
const { createBeacon } = require('./control/beacon');

let win = null;
let show = null;
let showPath = null;
let dirty = false;
let shortcutReport = {};
// Per-machine settings (not part of the show file).
const DEFAULT_CONTROL = { enabled: true, allowNetwork: false, httpPort: 9640, oscPort: 9641, oscFeedbackHost: '', oscFeedbackPort: 9642 };
// Main/backup: a backup follows the main machine's cues, slides, blackout, timer and messages.
const DEFAULT_SYNC = { role: 'standalone', mainHost: '', mainPort: 9640, mirrorBlackout: true, mirrorTimer: true };
const DEFAULT_SHOWMODE = { autoStart: false };
const newPin = () => String(Math.floor(1000 + Math.random() * 9000));
const DEFAULT_PRESENTER = { enabled: false, pin: '' };
// MIDI input (handled in the main window with Web MIDI). map: action -> learned message { type, ch, num }.
// Command Center: lets one computer on the network send files to this player and manage its cues.
// folder = where received files are kept (outside Documents, so macOS asks for no extra permission).
const DEFAULT_CENTER = { accept: false, folder: '', key: '', name: '', id: '' };
// Files dropped into the app are copied into the show folder (prefs.center.folder), so the USB stick they
// came from can be removed and there is one place that holds the latest version of every file.
const DEFAULT_FILES = { copy: true };
const DEFAULT_MIDI = { enabled: false, input: 'all', channel: 0, notes: true, noteBase: 60, programChange: true, msc: true, map: {} };
let prefs = { control: { ...DEFAULT_CONTROL }, sync: { ...DEFAULT_SYNC }, showMode: { ...DEFAULT_SHOWMODE }, presenter: { ...DEFAULT_PRESENTER }, midi: { ...DEFAULT_MIDI }, center: { ...DEFAULT_CENTER }, files: { ...DEFAULT_FILES } };
let beacon = null;
let centers = []; // names of Command Centers connected to this player
let control = null;
let follower = null;
let followers = [];       // names of backups following this machine
let lastFollowAction = 0; // when the backup last fired/stopped to follow the main (debounces state checks)
let lastBlackoutSync = 0;
let lastSlideSync = 0;
// After the link to the main drops, the backup may be the one on screen. Don't let a restarted main (with
// nothing live) stop it: hold until the main does something deliberate (any event).
let followHeld = false;
const state = {
  liveCueId: null, live: null, armedCueId: null, busyCueId: null, blackout: false, message: null, messageLevel: null,
  // Speaker countdown: while running, endsAt is the wall-clock end; while paused, remaining holds the time left.
  timer: { duration: 0, remaining: 0, endsAt: null, running: false },
  stageMessage: { text: '', flash: false }, // shown on the stage display
  preflight: {}, // cueId -> { level: ok|info|warn|error, items: [{ level, text }] }
  showMode: false, // show-machine mode (no sleep, notifications quiet)
  presenterMuted: false, // operator paused the presenter phone remote
  versions: {}, // cueId -> { changedAt, newer: { path, name, mtime } } (see versions.js)
  // Timer on the output: forced = the Full screen button; preview = show the overlay while its editor is open.
  timerScreen: { forced: false, forcedContent: 'timer', preview: false, mode: 'off', content: 'timer', display: null, note: null },
};
const blackoutWins = new Map();

const userFile = (name) => path.join(app.getPath('userData'), name);

// Accessibility (UI scripting) only exists on macOS; Windows drivers use COM and need no permission.
const axTrusted = (prompt = false) => (IS_MAC ? systemPreferences.isTrustedAccessibilityClient(prompt) : true);
const MOD_TEXT = IS_MAC ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt';

function defaultShow() {
  return {
    schemaVersion: 1,
    showName: 'Untitled Show',
    settings: {
      defaultOutput: 'auto',          // 'auto' = let PowerPoint choose, or a display ref {id,label,width,height}
      defaultAutoSlideshow: true,
      timerAutoStart: true,           // start the speaker timer when a cue with a duration fires
      newerVersions: 'ask',           // a newer version of a cue's file in its folder: 'ask' | 'auto' | 'off'
      // Saved timers: one click sets and starts them. name is optional ("Keynote", "Q&A").
      timerPresets: [5, 10, 15, 20, 30].map((minutes) => ({ name: '', minutes })),
      // Timer on the output screen (see timerScreen.js).
      timerScreen: {
        idle: 'off',                  // full screen between presentations: 'off' | 'timer' | 'clock' (time of day)
        livePip: false,               // corner overlay while a presentation is live
        display: 'output',            // 'output' = follow the show's output, or a display ref
        title: '',                    // line above the full-screen figure, e.g. "Starting in"
        showClock: false,             // time of day under the full-screen timer
        // Overlay layout: centre (x, y) and height h as fractions of the screen.
        pip: { x: 0.9, y: 0.1, h: 0.12, bg: 'solid', label: '', content: 'timer' },
      },
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

function cleanPresets(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 10)
    .map((p) => ({ name: String((p && p.name) || '').slice(0, 24), minutes: Math.round(Number(p && p.minutes) * 100) / 100 }))
    .filter((p) => p.minutes > 0 && p.minutes <= 1440);
}

function normalizeShow(s) {
  const d = defaultShow();
  const settings = { ...d.settings, ...(s.settings || {}) };
  settings.globalKeys = { ...d.settings.globalKeys, ...((s.settings || {}).globalKeys || {}) };
  settings.timerPresets = cleanPresets((s.settings || {}).timerPresets) || d.settings.timerPresets;
  const ts = (s.settings || {}).timerScreen || {};
  settings.timerScreen = { ...d.settings.timerScreen, ...ts, pip: { ...d.settings.timerScreen.pip, ...(ts.pip || {}) } };
  return { ...d, ...s, settings, cues: Array.isArray(s.cues) ? s.cues : [] };
}

// ---------- persistence ----------
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function autosave() {
  try {
    fs.writeFileSync(userFile('autosave.deckcue'), JSON.stringify(show, null, 2));
    fs.writeFileSync(userFile('prefs.json'), JSON.stringify({ ...prefs, showPath, dirty }));
  } catch (e) { console.error('autosave failed', e); }
}

function loadInitial() {
  const saved = readJSON(userFile('prefs.json')) || {};
  prefs = {
    ...saved,
    control: { ...DEFAULT_CONTROL, ...(saved.control || {}) },
    sync: { ...DEFAULT_SYNC, ...(saved.sync || {}) },
    showMode: { ...DEFAULT_SHOWMODE, ...(saved.showMode || {}) },
    presenter: { ...DEFAULT_PRESENTER, ...(saved.presenter || {}) },
    midi: { ...DEFAULT_MIDI, ...(saved.midi || {}) },
    center: { ...DEFAULT_CENTER, ...(saved.center || {}) },
    files: { ...DEFAULT_FILES, ...(saved.files || {}) },
  };
  if (!prefs.center.id) prefs.center.id = crypto.randomUUID();
  if (!prefs.center.folder) prefs.center.folder = path.join(os.homedir(), 'needit Deck Cue');
  if (!prefs.presenter.pin) prefs.presenter.pin = newPin();
  const auto = readJSON(userFile('autosave.deckcue'));
  show = normalizeShow(auto || defaultShow());
  showPath = saved.showPath && fs.existsSync(saved.showPath) ? saved.showPath : null;
  dirty = !!saved.dirty;
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
  autosave(); registerShortcuts(); sendShow(); broadcast(); schedulePreflight();
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

// on: true/false to set, undefined to toggle.
function setBlackout(on) {
  if (on === undefined || on !== state.blackout) toggleBlackout();
}

function toggleBlackout() {
  if (state.blackout) {
    hideBlack(); state.blackout = false;
  } else {
    const targets = blackoutTargets();
    if (!targets.length) return setMessage('Blackout needs an output display (only the main display is connected).', 'warn');
    showBlack(targets); state.blackout = true;
  }
  emit({ type: 'blackout', on: state.blackout });
  broadcast();
}

// ---------- cues ----------
function setMessage(msg, level = 'info') {
  state.message = msg; state.messageLevel = level; broadcast();
}

function cueAutoSlideshow(cue) {
  return cue.autoSlideshow === true || cue.autoSlideshow === false ? cue.autoSlideshow : show.settings.defaultAutoSlideshow;
}

// ---------- live slide position ----------
// Asks PowerPoint / Keynote / WPS (Windows) which slide is showing, once a second while their cue is live.
let positionBusy = false;
async function pollPosition() {
  if (positionBusy || !state.live || state.busyCueId || state.live.app === 'pdf') return;
  positionBusy = true;
  try {
    const app = state.live.app;
    const p = await presenters.position(app).catch(() => null);
    if (p && state.live && state.live.app === app && (p.slide !== state.liveSlide || p.slides !== state.liveSlides)) {
      state.liveSlide = p.slide;
      state.liveSlides = p.slides;
      state.liveDetail = `slide ${p.slide}/${p.slides}`;
      broadcast();
    }
  } finally {
    positionBusy = false;
  }
}

// ---------- thumbnails ----------
let thumbnailer = null;
let thumbs = {}; // cueId -> data: URL of the first slide

async function refreshThumbs() {
  if (!thumbnailer) return;
  const next = {};
  for (const cue of show.cues) {
    const f = cue.file && cue.file.path;
    if (f && fs.existsSync(f)) next[cue.id] = await thumbnailer.thumbnail(f);
  }
  const changed = JSON.stringify(Object.keys(next).map((k) => [k, (next[k] || '').length])) !== JSON.stringify(Object.keys(thumbs).map((k) => [k, (thumbs[k] || '').length]))
    || Object.keys(next).some((k) => next[k] !== thumbs[k]);
  thumbs = next;
  if (changed && win && !win.isDestroyed()) win.webContents.send('thumbs', thumbs);
}

// ---------- version management ----------
let versions = null;

function onVersions(snap) {
  const mode = show.settings.newerVersions || 'ask';
  const liveId = state.liveCueId;
  const before = state.versions[liveId];
  if (liveId && snap[liveId] && snap[liveId].changedAt && (!before || before.changedAt !== snap[liveId].changedAt)) {
    setMessage(`The live cue's file changed on disk. The show still runs the old version; fire the cue again to load the new one.`, 'warn');
  }
  for (const [id, v] of Object.entries(snap)) {
    if (!v.newer) continue;
    if (mode === 'off') snap[id] = { ...v, newer: null };
    else if (mode === 'auto') { useNewerVersion(id); return; } // the swap triggers a fresh snapshot
  }
  state.versions = snap;
  broadcast();
  schedulePreflight(); // a changed file needs re-checking (and a new thumbnail)
}

function useNewerVersion(cueId) {
  const cue = show.cues.find((c) => c.id === cueId);
  const newer = versions.newerFor(cueId);
  if (!cue || !newer) return;
  const old = cue.file ? path.basename(cue.file.path) : '';
  cue.file = { path: newer.path };
  dirty = true;
  autosave(); sendShow(); schedulePreflight();
  setMessage(`Cue ${show.cues.indexOf(cue) + 1} now uses ${newer.name} (was ${old}).${state.liveCueId === cueId ? ' Fire it again to load it.' : ''}`, 'info');
  versions.scan();
}

// ---------- presenter remote ----------
function presenterAction(kind, pin) {
  const p = prefs.presenter;
  if (!p.enabled) return { ok: false, code: 409, error: 'Presenter remote is off.' };
  if (String(pin) !== String(p.pin)) return { ok: false, code: 403, error: 'Wrong PIN.' };
  if (kind === 'check') return { ok: true };
  if (state.presenterMuted) return { ok: false, code: 409, error: 'Paused by the operator.' };
  const liveCue = state.liveCueId && show.cues.find((c) => c.id === state.liveCueId);
  if (!liveCue) return { ok: false, code: 409, error: 'Nothing is live.' };
  if (liveCue.presenterControl === false) return { ok: false, code: 409, error: 'The operator controls this cue.' };
  navSlide(kind === 'next' ? 'next' : 'previous');
  return { ok: true };
}

function setPresenterMuted(on) {
  state.presenterMuted = on === undefined ? !state.presenterMuted : !!on;
  broadcast();
}

async function presenterInfo() {
  const host = localAddresses()[0] || '127.0.0.1';
  const url = `http://${host}:${prefs.control.httpPort}/remote`;
  const QRCode = require('qrcode');
  const qr = await QRCode.toDataURL(`${url}?pin=${prefs.presenter.pin}`, { margin: 1, width: 220 });
  return { ...prefs.presenter, url, qr, networkOk: prefs.control.allowNetwork };
}

// ---------- show-machine mode ----------
async function setShowMode(on) {
  const want = on === undefined ? !state.showMode : !!on;
  const r = await showmode.setActive(want);
  state.showMode = r.active;
  broadcast();
  return r;
}

// ---------- preflight ----------
// The screen a cue would play on: its output, else the show default, else (for "let the app choose")
// the first external display, which is where the apps normally put the slideshow.
function preflightContext(cue) {
  const filePath = cue.file && cue.file.path;
  const file = resolveCueFile(cue);
  const appName = presenters.appFor(cue.app, file || filePath || 'x.pptx', show.settings.pptApp);
  const outRef = !cue.output || cue.output === 'default' ? show.settings.defaultOutput : cue.output;
  let display = null;
  let outputMissing = null;
  let programWarning = null;
  if (outRef === 'window') {
    // The program window is 16:9; only PDF cues can play into it.
    display = { id: 'program', bounds: { width: 1920, height: 1080 } };
    if (appName !== 'pdf') programWarning = true;
  } else if (outRef && outRef !== 'auto') {
    display = resolveOutput(outRef);
    if (!display) outputMissing = outRef.label;
  }
  if (!display) {
    const primary = screen.getPrimaryDisplay();
    display = screen.getAllDisplays().find((d) => d.id !== primary.id) || primary;
  }
  const label = display.id === 'program' ? { label: 'program window' } : listDisplays().find((d) => d.id === display.id);
  return {
    file,
    filePath,
    appName,
    appLabel: presenters.APPS[appName] ? presenters.APPS[appName].name : appName,
    appInstalled: presenters.isInstalled(appName),
    needsAccessibility: cueAutoSlideshow(cue) && presenters.needsAccessibility(appName, false),
    accessibilityOk: axTrusted(),
    display,
    displayLabel: label ? label.label : 'main display',
    outputMissing: programWarning ? `Program window (only PDF cues can play into it; ${presenters.APPS[appName] ? presenters.APPS[appName].name : appName} will use a screen)` : outputMissing,
    startSlide: Number(cue.startSlide) || 1,
  };
}

let preflightTimer = null;
let preflightRun = 0;
function schedulePreflight(delay = 400) {
  clearTimeout(preflightTimer);
  preflightTimer = setTimeout(runPreflight, delay);
}

async function runPreflight() {
  const run = ++preflightRun;
  const results = {};
  for (const cue of show.cues) {
    try { results[cue.id] = await preflight.checkCue(preflightContext(cue)); } catch (e) { results[cue.id] = { level: 'warn', items: [{ level: 'warn', text: `Preflight failed: ${e.message}` }] }; }
    if (run !== preflightRun) return; // a newer run started (the show changed)
  }
  state.preflight = results;
  broadcast();
  refreshThumbs();
}

// ---------- timer on the output screen ----------
// The display it uses: its own choice, else the show's output, else the first external display.
function timerScreenDisplay() {
  const ts = show.settings.timerScreen;
  let d = ts.display && ts.display !== 'output' ? resolveOutput(ts.display) : null;
  if (!d) d = resolveOutput(show.settings.defaultOutput);
  if (!d) {
    const primary = screen.getPrimaryDisplay();
    d = screen.getAllDisplays().find((x) => x.id !== primary.id) || primary;
  }
  return d;
}

// Decides what the output shows and pushes it to the timer window. Called on every state change.
function updateTimerScreen() {
  const ts = show.settings.timerScreen;
  const rt = state.timerScreen;
  const d = timerScreenDisplay();
  const operator = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const coversOperator = d.id === operator.id;
  let mode = 'off';
  let content = 'timer';
  let note = null;
  if (rt.forced) {
    mode = 'full';
    content = rt.forcedContent === 'clock' ? 'clock' : 'timer';
  } else if (!state.live && ts.idle !== 'off') {
    // Never cover the operator's own screen automatically (DECKCUE_TEST_COVER is for single-screen testing).
    if (coversOperator && !process.env.DECKCUE_TEST_COVER) note = 'Full screen between presentations needs a second screen. On this one it would cover Deck Cue.';
    else { mode = 'full'; content = ts.idle === 'clock' ? 'clock' : 'timer'; }
  } else if (state.live && ts.livePip) {
    mode = 'pip';
  }
  if (mode === 'off' && rt.preview) mode = 'pip';
  const label = listDisplays().find((x) => x.id === d.id);
  state.timerScreen = {
    ...rt, mode, content, note,
    display: { label: label ? label.label : 'Display', width: d.bounds.width, height: d.bounds.height, coversOperator },
  };
  timerScreen.update({
    // Only the Full screen button can cover the operator's own screen; a click on the timer then hides it.
    mode, display: d, clickToClose: mode === 'full' && coversOperator && rt.forced,
    payload: { content, timer: state.timer, config: ts },
  }).catch((e) => console.error('timer screen', e));
}

// content: 'timer' or 'clock' (time of day).
function setTimerScreenForced(on, content) {
  const rt = state.timerScreen;
  // Asking for the other content while it is already up switches it instead of hiding it.
  const switching = on === undefined && rt.forced && content && content !== rt.forcedContent;
  rt.forced = switching ? true : on === undefined ? !rt.forced : !!on;
  if (content) rt.forcedContent = content;
  broadcast();
}

// ---------- show folder: bringing files in, keeping only the latest ----------
const samePath = (a, b) => path.resolve(a) === path.resolve(b);

function inShowFolder(file) {
  const rel = path.relative(prefs.center.folder, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Positions (1-based) of the cues that use this file.
function cuesUsing(file) {
  return show.cues.map((c, i) => (c.file && c.file.path && samePath(c.file.path, file) ? i + 1 : 0)).filter(Boolean);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function sameContent(a, b) {
  const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
  if (sa.size !== sb.size) return false;
  // Very large decks: comparing dates is enough (hashing gigabytes would stall the drop).
  if (sa.size > 512 * 1024 * 1024) return Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000;
  return (await hashFile(a)) === (await hashFile(b));
}

// Copies a dropped file into the show folder. Returns { path } to use for the cue, or { conflict } when a
// different file with that name is already there and replacing it has not been confirmed yet.
async function importFile(src, overwrite) {
  if (!prefs.files.copy) return { path: src, usedBy: [] };
  const folder = prefs.center.folder;
  await fs.promises.mkdir(folder, { recursive: true });
  const name = path.basename(src);
  const dest = path.join(folder, name);
  if (samePath(src, dest)) return { path: dest, usedBy: cuesUsing(dest) };
  const exists = fs.existsSync(dest);
  if (exists) {
    if (await sameContent(src, dest)) return { path: dest, same: true, usedBy: cuesUsing(dest) };
    if (!overwrite) return { conflict: true, name, usedBy: cuesUsing(dest) };
  }
  const part = path.join(folder, `.${name}.${process.pid}.part`);
  try {
    await fs.promises.copyFile(src, part);
    const st = fs.statSync(src);
    await fs.promises.utimes(part, st.atime, st.mtime); // keep the file's own date
    await fs.promises.rename(part, dest);
  } catch (e) {
    fs.rm(part, { force: true }, () => {});
    return { error: exists ? `${name} is in use and could not be replaced. Stop its cue and try again.` : `Could not copy ${name}: ${e.message}` };
  }
  if (versions) versions.scan();
  return { path: dest, replaced: exists, usedBy: cuesUsing(dest) };
}

// After a cue got a new file: the old one leaves the show folder (to the Trash), unless another cue
// still uses it or it was never ours.
async function retireFile(oldPath, newPath) {
  if (!oldPath || !prefs.files.copy || (newPath && samePath(oldPath, newPath))) return false;
  if (!inShowFolder(oldPath) || cuesUsing(oldPath).length || !fs.existsSync(oldPath)) return false;
  try { await shell.trashItem(oldPath); return true; } catch { return false; }
}

// ---------- Command Center (files and cue management from another computer) ----------
function playerName() {
  return prefs.center.name || `${os.hostname().replace(/\.local$/, '')}${PROFILE ? ` (${PROFILE})` : ''}`;
}

function playerInfo() {
  return { app: APP_NAME, id: prefs.center.id, name: playerName(), platform: process.platform, version: app.getVersion(), show: show.showName };
}

function showChanged() {
  dirty = true;
  autosave(); registerShortcuts(); sendShow(); broadcast(); schedulePreflight();
  if (versions) versions.scan();
}

const CUE_FIELDS = ['label', 'autoSlideshow', 'startSlide', 'duration', 'notes', 'color', 'output', 'presenterControl'];
const manageActions = {
  info: playerInfo,
  addCue({ file, index, label, autoSlideshow, duplicate }) {
    // A file that a cue already uses was just replaced in place: it is the new version of that cue,
    // not another cue. (duplicate: true is for copying a whole list, which may hold a file twice.)
    const used = duplicate ? [] : cuesUsing(file);
    if (used.length) return { id: show.cues[used[0] - 1].id, number: used[0], existing: true };
    const cue = {
      id: crypto.randomUUID().slice(0, 8), label: label ? String(label).slice(0, 120) : '', file: { path: file }, app: 'auto',
      autoSlideshow: autoSlideshow === true || autoSlideshow === false ? autoSlideshow : null,
      startSlide: 1, output: 'default', shortcut: null, color: '#3a4150', notes: '',
    };
    const at = Number.isInteger(index) ? Math.min(show.cues.length, Math.max(0, index - 1)) : show.cues.length;
    show.cues.splice(at, 0, cue);
    if (!state.armedCueId && !state.live) state.armedCueId = show.cues[0].id;
    showChanged();
    return { id: cue.id, number: at + 1 };
  },
  setCueFile(ref, file) {
    const cue = cueByRef(ref);
    const old = cue.file ? cue.file.path : null;
    cue.file = { path: file };
    showChanged();
    retireFile(old, file);
    return { id: cue.id };
  },
  // The file of a cue, for a Command Center that copies this list to another computer.
  cuePath(ref) {
    const cue = cueByRef(ref);
    if (!cue.file || !fs.existsSync(cue.file.path)) throw Object.assign(new Error('That cue has no file here'), { code: 404 });
    return cue.file.path;
  },
  clearCues() {
    if (state.live || state.busyCueId) throw Object.assign(new Error('Something is live on that computer. Stop it first.'), { code: 409 });
    show.cues = [];
    state.armedCueId = null;
    showChanged();
    return {};
  },
  updateCue(ref, patch) {
    const cue = cueByRef(ref);
    for (const k of CUE_FIELDS) {
      if (!(k in patch)) continue;
      if (k === 'autoSlideshow') cue.autoSlideshow = patch[k] === true || patch[k] === false ? patch[k] : null;
      else if (k === 'startSlide') cue.startSlide = Math.max(1, parseInt(patch[k], 10) || 1);
      else if (k === 'duration') cue.duration = Math.max(0, Number(patch[k]) || 0) || null;
      else if (k === 'output') cue.output = ['default', 'auto', 'window'].includes(patch[k]) ? patch[k] : cue.output;
      else if (k === 'presenterControl') cue.presenterControl = patch[k] !== false;
      else cue[k] = String(patch[k] == null ? '' : patch[k]).slice(0, k === 'notes' ? 4000 : 120);
    }
    showChanged();
    return { id: cue.id };
  },
  moveCue(ref, to) {
    const cue = cueByRef(ref);
    if (!Number.isInteger(to) || to < 1) throw Object.assign(new Error('Give the new position as ?to=<number>'), { code: 400 });
    show.cues.splice(show.cues.indexOf(cue), 1);
    show.cues.splice(Math.min(show.cues.length, to - 1), 0, cue);
    showChanged();
    return { number: show.cues.indexOf(cue) + 1 };
  },
  deleteCue(ref) {
    const cue = cueByRef(ref);
    if (cue.id === state.liveCueId || cue.id === state.busyCueId) throw Object.assign(new Error('That cue is live. Stop it first.'), { code: 409 });
    show.cues = show.cues.filter((c) => c.id !== cue.id);
    if (state.armedCueId === cue.id) state.armedCueId = null;
    showChanged();
    return {};
  },
  setTimerPresets(body) {
    const list = cleanPresets(body && body.presets);
    if (!list) throw Object.assign(new Error('Send { presets: [{ name, minutes }] }'), { code: 400 });
    show.settings.timerPresets = list;
    showChanged();
    return {};
  },
  timerScreenConfig(patch) {
    const ts = show.settings.timerScreen;
    if (['off', 'timer', 'clock'].includes(patch.idle)) ts.idle = patch.idle;
    if ('livePip' in patch) ts.livePip = !!patch.livePip;
    if ('showClock' in patch) ts.showClock = !!patch.showClock;
    if ('title' in patch) ts.title = String(patch.title || '').slice(0, 60);
    showChanged();
    return {};
  },
};

function startBeacon() {
  if (!beacon) beacon = createBeacon(() => (prefs.center.accept && prefs.control.enabled ? { ...playerInfo(), port: prefs.control.httpPort } : null));
  if (prefs.center.accept) beacon.start(); else beacon.stop();
}

// ---------- speaker timer and stage message ----------
function timerRemaining() {
  const t = state.timer;
  return t.running ? t.endsAt - Date.now() : t.remaining;
}

function timerCommand(cmd, seconds) {
  const t = state.timer;
  if (cmd === 'set') {
    const ms = Math.max(0, Math.round(Number(seconds) || 0) * 1000);
    state.timer = { duration: ms, remaining: ms, endsAt: t.running ? Date.now() + ms : null, running: t.running };
  } else if (cmd === 'start') {
    if (!t.running) state.timer = { ...t, running: true, endsAt: Date.now() + t.remaining };
  } else if (cmd === 'pause') {
    if (t.running) state.timer = { ...t, running: false, remaining: t.endsAt - Date.now(), endsAt: null };
  } else if (cmd === 'reset') {
    state.timer = { ...t, running: false, remaining: t.duration, endsAt: null };
  } else if (cmd === 'add') {
    // Changing the time on the fly also moves the total, so progress bars stay meaningful.
    const ms = Math.round(Number(seconds) || 0) * 1000;
    const duration = Math.max(0, t.duration + ms);
    state.timer = t.running ? { ...t, duration, endsAt: t.endsAt + ms } : { ...t, duration, remaining: t.remaining + ms };
  } else if (cmd === 'preset') {
    // A saved timer: set it and start it in one go. `seconds` carries its position, 1-based.
    const p = show.settings.timerPresets[Math.round(Number(seconds)) - 1];
    if (!p) throw Object.assign(new Error('No such saved timer'), { code: 404 });
    const ms = Math.round(p.minutes * 60000);
    state.timer = { duration: ms, remaining: ms, endsAt: Date.now() + ms, running: true };
  } else if (cmd === 'until') {
    // Count down to a time of day ("15:30"); tomorrow if that time has passed today.
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(seconds || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw Object.assign(new Error('Give the time as HH:MM'), { code: 400 });
    const target = new Date();
    target.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    const ms = target.getTime() - Date.now();
    state.timer = { duration: ms, remaining: ms, endsAt: target.getTime(), running: true };
  } else {
    throw Object.assign(new Error(`Unknown timer command ${cmd}`), { code: 404 });
  }
  broadcast();
}

function setStageMessage(text, flash = false) {
  state.stageMessage = { text: String(text || '').slice(0, 280), flash: !!flash && !!text };
  broadcast();
}

async function fireCue(id) {
  const cue = show.cues.find((c) => c.id === id);
  if (!cue) return;
  if (state.busyCueId) return setMessage('Another cue is still loading…', 'warn');
  emit({ type: 'fire', cueId: cue.id, number: show.cues.indexOf(cue) + 1, name: cueName(cue) });
  const file = resolveCueFile(cue);
  if (!file) return setMessage(`Cue “${cueName(cue)}”: file is missing (${cue.file ? cue.file.path : 'no file'})`, 'error');

  const appName = presenters.appFor(cue.app, file, show.settings.pptApp);
  if (!presenters.isInstalled(appName)) return setMessage(`${presenters.APPS[appName].name} is not installed on this Mac. Pick another app in the cue or in Settings.`, 'error');

  const auto = cueAutoSlideshow(cue);
  const outRef = !cue.output || cue.output === 'default' ? show.settings.defaultOutput : cue.output;
  let display = null;
  let warning = null;
  let program = false;
  if (outRef === 'window') {
    if (appName === 'pdf') program = true;
    else warning = `${presenters.APPS[appName].name} can't play into the program window, so it chose a screen. Capture that screen for NDI instead.`;
  } else if (outRef && outRef !== 'auto') {
    display = resolveOutput(outRef);
    if (!display) warning = `Output “${outRef.label}” is not connected, so PowerPoint chose the display.`;
  }
  if (presenters.needsAccessibility(appName, false) && !axTrusted()) {
    axTrusted(true);
    return setMessage('WPS Office is controlled through its menus, so Deck Cue needs Accessibility permission (System Settings › Privacy & Security › Accessibility). Then fire the cue again.', 'error');
  }
  if (display && auto && presenters.needsAccessibility(appName, true) && !axTrusted()) {
    axTrusted(true);
    warning = 'To send slideshows to a chosen output, allow Deck Cue under Privacy & Security › Accessibility. Using PowerPoint’s default display for now.';
    display = null;
  }
  if (display && auto && appName === 'wps' && !IS_MAC) {
    warning = 'WPS Office on Windows chooses its own display. Set it in WPS under Slide Show › Set Up Show.';
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
    const result = await presenters.fire(appName, { file, startSlide: Number(cue.startSlide) || 1, auto, bounds: display ? display.bounds : null, program });
    if (closePrev && !closeFirst) await presenters.close(prev.app, prev.file).catch(() => {});
    state.live = { cueId: id, app: appName, file };
    if (versions) versions.clearChanged(id); // the freshly loaded file is the current one
    const minutes = Number(cue.duration) || 0;
    if (minutes > 0 && show.settings.timerAutoStart !== false) {
      state.timer = { duration: minutes * 60000, remaining: minutes * 60000, endsAt: Date.now() + minutes * 60000, running: true };
    }
    // The PDF player reports its first page before the cue is live, so take it from the result.
    const pdf = appName === 'pdf' && result && result.page ? result : null;
    state.liveDetail = pdf ? `page ${pdf.page}/${pdf.pages}` : null;
    state.liveSlide = pdf ? pdf.page : null;
    state.liveSlides = pdf ? pdf.pages : null;
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
  emit({ type: 'stop' });
  await Promise.all(Object.keys(presenters.APPS).map((a) => presenters.stop(a).catch(() => {})));
  state.liveCueId = null; state.live = null; registerShortcuts(); broadcast();
}

async function navSlide(dir) {
  if (!state.live) return setMessage('Nothing is live.', 'warn');
  emit({ type: 'nav', dir });
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
    if (!globalAllowed(accel)) { shortcutReport[key] = `Global shortcuts need ${MOD_TEXT}, or an F-key`; return; }
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
// ---------- remote control ----------
function cueByRef(ref) {
  // An id wins (ids can happen to be all digits), then a position, then a name.
  const n = typeof ref === 'number' ? ref : /^\d+$/.test(String(ref)) ? Number(ref) : null;
  const cue = show.cues.find((c) => c.id === ref)
    || (n !== null ? show.cues[n - 1] : show.cues.find((c) => cueName(c).toLowerCase() === String(ref).toLowerCase()));
  if (!cue) throw Object.assign(new Error(`No cue ${ref}`), { code: 404 });
  return cue;
}

function setArmed(id) {
  state.armedCueId = id;
  emit({ type: 'arm', cueId: id });
  broadcast();
}

// ---------- main / backup sync ----------
function emit(ev) {
  if (control) control.event(ev);
}

// The backup's cue for one of the main's: same id (same show file), else same number and name, else same number.
function localCueFor(remote) {
  if (!remote) return null;
  return show.cues.find((c) => c.id === (remote.id || remote.cueId))
    || show.cues.find((c, i) => i + 1 === remote.number && cueName(c) === remote.name)
    || show.cues[remote.number - 1] || null;
}

function isBackup() {
  return prefs.sync.role === 'backup';
}

function onMainEvent(ev) {
  if (!isBackup()) return;
  if (followHeld) { followHeld = false; sendSync(); }
  if (process.env.DECKCUE_DEBUG) console.log(`[sync] main event ${JSON.stringify(ev)}`);
  if (ev.type === 'fire') {
    const cue = localCueFor(ev);
    if (!cue) return setMessage(`Main fired cue ${ev.number} “${ev.name}”, which this backup doesn't have.`, 'error');
    lastFollowAction = Date.now();
    fireCue(cue.id);
  } else if (ev.type === 'stop') {
    lastFollowAction = Date.now();
    stopAll();
  } else if (ev.type === 'nav') {
    if (state.live) navSlide(ev.dir);
  } else if (ev.type === 'blackout') {
    if (prefs.sync.mirrorBlackout) setBlackout(ev.on);
  } else if (ev.type === 'arm') {
    const cue = show.cues.find((c) => c.id === ev.cueId);
    if (cue) { state.armedCueId = cue.id; broadcast(); }
  }
}

// State comparison catches anything the events missed (a backup that connects mid-show, a cue that was
// still loading when the next one fired, a clicker that went straight to the main's PDF player).
function onMainState(main) {
  if (!isBackup()) return;
  let changed = false;
  if (!followHeld && prefs.sync.mirrorTimer) {
    const offset = (main.now || Date.now()) - Date.now();
    state.timer = { ...main.timer, endsAt: main.timer.endsAt ? main.timer.endsAt - offset : null };
    state.stageMessage = main.stageMessage || { text: '', flash: false };
    if (main.timerScreen) state.timerScreen.forced = !!main.timerScreen.forced;
    changed = true;
  }
  const want = main.live ? localCueFor(main.live) : null;
  const settled = !followHeld && !main.loading && !state.busyCueId && Date.now() - lastFollowAction > 4000;
  if (settled) {
    if (main.live && want && state.liveCueId !== want.id) {
      lastFollowAction = Date.now();
      fireCue(want.id);
    } else if (!main.live && state.live) {
      lastFollowAction = Date.now();
      stopAll();
    } else if (want && main.live.slide && state.live && state.liveSlide && state.liveSlide !== main.live.slide && Date.now() - lastSlideSync > 2500) {
      // Exact slide: PDF always; PowerPoint/WPS on Windows and Keynote when they report their position.
      lastSlideSync = Date.now();
      presenters.goto(state.live.app, main.live.slide);
    }
  }
  if (!followHeld && prefs.sync.mirrorBlackout && main.blackout !== state.blackout && Date.now() - lastBlackoutSync > 4000) {
    lastBlackoutSync = Date.now();
    setBlackout(main.blackout);
  }
  const next = main.next ? localCueFor(main.next) : null;
  if (!followHeld && next && state.armedCueId !== next.id) { state.armedCueId = next.id; changed = true; }
  // Tell the operator when the two shows don't line up.
  const diffs = main.cues.filter((rc) => {
    const c = show.cues[rc.number - 1];
    return !c || cueName(c) !== rc.name;
  }).map((rc) => rc.number);
  const extra = show.cues.length - main.cues.length;
  const issue = diffs.length || extra > 0
    ? `Backup show differs from main${diffs.length ? ` (cue ${diffs.slice(0, 5).join(', ')}${diffs.length > 5 ? '…' : ''})` : ''}${extra > 0 ? ` (${extra} extra cue${extra > 1 ? 's' : ''} here)` : ''}. Use “Copy show from main”.`
    : null;
  if (issue !== state.syncIssue) {
    state.syncIssue = issue;
    changed = true;
    if (process.env.DECKCUE_DEBUG) console.log(`[sync] issue: ${issue}`);
    sendSync();
  }
  if (changed) broadcast();
}

function syncStatus() {
  return {
    role: prefs.sync.role,
    link: follower ? follower.getStatus() : { state: 'off' },
    followers,
    issue: isBackup() ? state.syncIssue || null : null,
    held: isBackup() && followHeld,
  };
}

function sendSync() {
  if (win && !win.isDestroyed()) win.webContents.send('sync', syncStatus());
  updateTitle();
}

function startSync() {
  followHeld = false;
  if (isBackup() && prefs.sync.mainHost) follower.start(prefs.sync.mainHost, prefs.sync.mainPort);
  else follower.stop();
  if (!isBackup()) state.syncIssue = null;
  sendSync();
}

// Replace this computer's show with the main's. Files are expected in the same place, or under a folder
// the operator picks (matched by file name), since the show folder is usually copied to both machines.
async function pullShowFromMain() {
  const { mainHost, mainPort } = prefs.sync;
  if (!mainHost) throw new Error('Set the main computer first.');
  const res = await fetch(`http://${mainHost}:${mainPort}/api/show`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Main answered ${res.status}`);
  const pulled = normalizeShow(await res.json());
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `Replace this computer's show with the main's “${pulled.showName}” (${pulled.cues.length} cues)?`,
  });
  if (r.response !== 0) return { replaced: false };
  const missing = () => pulled.cues.filter((c) => c.file && c.file.path && !fs.existsSync(c.file.path));
  const relinkFrom = (dir, depth = 4) => {
    const want = new Map(missing().map((c) => [path.basename(c.file.path), c]));
    const walk = (d, level) => {
      if (!want.size || level > depth) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) walk(full, level + 1);
        else if (want.has(e.name)) { want.get(e.name).file.path = full; want.delete(e.name); }
      }
    };
    walk(dir, 0);
  };
  if (missing().length && showPath) relinkFrom(path.dirname(showPath));
  if (missing().length) {
    const pick = await dialog.showOpenDialog(win, {
      message: `${missing().length} file(s) aren't at the same place on this computer. Choose the folder that holds the show files.`,
      properties: ['openDirectory'],
    });
    if (!pick.canceled && pick.filePaths[0]) relinkFrom(pick.filePaths[0]);
  }
  show = pulled; showPath = null; dirty = true;
  state.liveCueId = null; state.live = null;
  autosave(); registerShortcuts(); sendShow(); broadcast(); schedulePreflight();
  return { replaced: true, missing: missing().length };
}

function armStep(delta) {
  if (!show.cues.length) return;
  const i = show.cues.findIndex((c) => c.id === state.armedCueId);
  const n = Math.min(show.cues.length - 1, Math.max(0, (i < 0 ? 0 : i + delta)));
  setArmed(show.cues[n].id);
}

function remoteState() {
  const ref = (c) => (c ? { number: show.cues.indexOf(c) + 1, id: c.id, name: cueName(c) } : null);
  const liveCue = state.liveCueId && show.cues.find((c) => c.id === state.liveCueId);
  const nextCue = (state.armedCueId && show.cues.find((c) => c.id === state.armedCueId)) || (!liveCue && show.cues[0]) || null;
  return {
    app: APP_NAME,
    show: show.showName,
    now: Date.now(), // lets clients correct for clock differences when counting down
    live: liveCue ? {
      ...ref(liveCue),
      app: state.live && state.live.app,
      slide: state.liveSlide || null,
      slides: state.liveSlides || null,
      notes: liveCue.notes || '',
      presenterAllowed: liveCue.presenterControl !== false,
      // PDF cues can be previewed on the stage display.
      file: state.live && state.live.app === 'pdf' ? `/api/cue/${encodeURIComponent(liveCue.id)}/file` : null,
    } : null,
    role: prefs.sync.role,
    showMode: state.showMode,
    presenter: { enabled: !!prefs.presenter.enabled, muted: !!state.presenterMuted },
    timerScreen: {
      mode: state.timerScreen.mode, content: state.timerScreen.content, forced: !!state.timerScreen.forced,
      idle: show.settings.timerScreen.idle, livePip: !!show.settings.timerScreen.livePip,
    },
    player: { id: prefs.center.id, name: playerName(), platform: process.platform },
    timer: { duration: state.timer.duration, remaining: timerRemaining(), running: state.timer.running, endsAt: state.timer.endsAt },
    timerPresets: show.settings.timerPresets,
    stageMessage: state.stageMessage,
    next: ref(nextCue),
    loading: ref(state.busyCueId && show.cues.find((c) => c.id === state.busyCueId)),
    blackout: !!state.blackout,
    message: state.message || null,
    cues: show.cues.map((c, i) => {
      const missing = !c.file || !fs.existsSync(c.file.path);
      const st = c.id === state.busyCueId ? 'loading' : c.id === state.liveCueId ? 'live' : nextCue && c.id === nextCue.id ? 'next' : missing ? 'missing' : 'idle';
      const pf = state.preflight[c.id];
      const ver = state.versions[c.id] || {};
      const cueApp = c.file ? presenters.appFor(c.app, c.file.path, show.settings.pptApp) : null;
      return {
        number: i + 1, id: c.id, name: cueName(c), color: c.color || null, state: st, missing,
        file: c.file ? path.basename(c.file.path) : null, fullscreen: cueAutoSlideshow(c), duration: c.duration || null,
        app: cueApp && presenters.APPS[cueApp] ? presenters.APPS[cueApp].short : null,
        preflight: pf ? pf.level : null, changed: !!ver.changedAt, newer: ver.newer ? ver.newer.name : null,
      };
    }),
  };
}

function startControl() {
  control.start(prefs.control);
}

function sendShow() {
  if (win && !win.isDestroyed()) win.webContents.send('show', { show, showPath, dirty, shortcutReport });
  updateTitle();
  if (control) control.update();
}

function broadcast() {
  updateTimerScreen();
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  if (control) control.update();
}

function updateTitle() {
  if (!win) return;
  const role = prefs.sync.role === 'main' ? ' [MAIN]' : prefs.sync.role === 'backup' ? ' [BACKUP]' : '';
  win.setTitle(`${APP_NAME}${PROFILE ? ` (${PROFILE})` : ''}${role} — ${showPath ? path.basename(showPath) : show.showName}${dirty ? ' •' : ''}`);
  if (IS_MAC) win.setDocumentEdited(dirty);
}

function setupIpc() {
  ipcMain.handle('show:get', () => ({ show, showPath, dirty, shortcutReport, state }));
  ipcMain.handle('show:update', (_e, s) => {
    show = normalizeShow(s); dirty = true;
    if (state.armedCueId && !show.cues.some((c) => c.id === state.armedCueId)) state.armedCueId = null;
    autosave(); registerShortcuts(); updateTitle();
    updateTimerScreen();
    if (control) control.update();
    schedulePreflight();
    return { shortcutReport, dirty };
  });
  ipcMain.handle('show:file', (_e, cmd) => fileCommand(cmd));
  ipcMain.handle('displays:list', () => listDisplays());
  ipcMain.handle('displays:identify', () => identifyDisplays());
  ipcMain.handle('cue:fire', (_e, id) => fireCue(id));
  ipcMain.handle('cue:arm', (_e, id) => setArmed(id));
  ipcMain.handle('cue:go', () => go());
  ipcMain.handle('cue:stop', () => stopAll());
  ipcMain.handle('cue:nav', (_e, dir) => navSlide(dir));
  ipcMain.handle('blackout:toggle', () => toggleBlackout());
  ipcMain.handle('message:clear', () => { state.message = null; broadcast(); });
  ipcMain.handle('sync:get', () => ({ config: prefs.sync, status: syncStatus() }));
  ipcMain.handle('sync:set', (_e, config) => {
    prefs.sync = { ...DEFAULT_SYNC, ...config };
    autosave();
    startSync();
    return { config: prefs.sync, status: syncStatus() };
  });
  ipcMain.handle('sync:pull', async () => {
    try { return await pullShowFromMain(); } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('preflight:run', () => schedulePreflight(0));
  ipcMain.handle('thumbs:get', () => thumbs);
  const centerInfo = () => ({ config: prefs.center, name: playerName(), centers, addresses: localAddresses(), port: prefs.control.httpPort });
  ipcMain.handle('center:get', centerInfo);
  ipcMain.handle('center:set', (_e, patch) => {
    prefs.center = { ...prefs.center, ...patch, id: prefs.center.id };
    if (!prefs.center.folder) prefs.center.folder = path.join(os.homedir(), 'needit Deck Cue');
    // A Command Center is another computer, so the player must be reachable on the network.
    if (prefs.center.accept && (!prefs.control.allowNetwork || !prefs.control.enabled)) {
      prefs.control.allowNetwork = true; prefs.control.enabled = true; startControl();
    }
    autosave();
    startBeacon();
    if (control) control.update();
    return centerInfo();
  });
  ipcMain.handle('center:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: prefs.center.folder });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('center:openFolder', () => { fs.mkdirSync(prefs.center.folder, { recursive: true }); return shell.openPath(prefs.center.folder); });
  ipcMain.handle('timerscreen:force', () => setTimerScreenForced(!state.timerScreen.forced, 'timer'));
  ipcMain.handle('timerscreen:preview', (_e, on) => { state.timerScreen.preview = !!on; broadcast(); });
  ipcMain.handle('midi:get', () => prefs.midi);
  ipcMain.handle('midi:set', (_e, config) => { prefs.midi = { ...DEFAULT_MIDI, ...config }; autosave(); return prefs.midi; });
  ipcMain.handle('presenter:get', () => presenterInfo());
  ipcMain.handle('presenter:set', async (_e, patch) => {
    prefs.presenter = { ...prefs.presenter, ...patch };
    if (patch.newPin) { prefs.presenter.pin = newPin(); delete prefs.presenter.newPin; }
    // Phones are other devices: the remote needs network access.
    if (prefs.presenter.enabled && !prefs.control.allowNetwork) { prefs.control.allowNetwork = true; startControl(); }
    autosave();
    broadcast();
    return presenterInfo();
  });
  ipcMain.handle('presenter:mute', (_e, on) => setPresenterMuted(on));
  ipcMain.handle('version:use', (_e, cueId) => useNewerVersion(cueId));
  ipcMain.handle('version:ignore', (_e, cueId) => versions.ignoreNewer(cueId));
  ipcMain.handle('version:clear', (_e, cueId) => versions.clearChanged(cueId));
  ipcMain.handle('showmode:set', (_e, on) => setShowMode(on));
  ipcMain.handle('showmode:readiness', () => showmode.readiness());
  ipcMain.handle('showmode:quitApps', (_e, labels) => showmode.quitApps(labels));
  ipcMain.handle('showmode:config', (_e, patch) => {
    if (patch) { prefs.showMode = { ...prefs.showMode, ...patch }; autosave(); }
    return { ...prefs.showMode, focusOn: showmode.FOCUS_ON, focusOff: showmode.FOCUS_OFF, platform: process.platform };
  });
  ipcMain.handle('showmode:openShortcuts', () => shell.openPath('/System/Applications/Shortcuts.app'));
  ipcMain.handle('timer:cmd', (_e, cmd, seconds) => timerCommand(cmd, seconds));
  ipcMain.handle('stage:message', (_e, text, flash) => setStageMessage(text, flash));
  ipcMain.handle('stage:open', (_e, view) => shell.openExternal(`http://127.0.0.1:${prefs.control.httpPort}/stage${view === 'timer' ? '?view=timer' : ''}`));
  ipcMain.handle('files:status', (_e, paths) => Object.fromEntries(paths.map((p) => [p, fs.existsSync(p)])));
  ipcMain.handle('files:resolve', () => { show.cues.forEach((c) => resolveCueFile(c)); return show; });
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Presentations', extensions: presenters.SUPPORTED_EXT.map((e) => e.slice(1)) }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('files:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('files:import', (_e, src, overwrite) => importFile(src, !!overwrite).catch((e) => ({ error: e.message })));
  ipcMain.handle('files:retire', (_e, oldPath, newPath) => retireFile(oldPath, newPath));
  ipcMain.handle('files:prefs', (_e, patch) => {
    if (patch) { prefs.files = { ...prefs.files, ...patch }; autosave(); }
    return { ...prefs.files, folder: prefs.center.folder };
  });
  ipcMain.handle('control:get', () => ({ config: prefs.control, status: control.getStatus(), addresses: localAddresses() }));
  ipcMain.handle('control:set', (_e, config) => {
    prefs.control = { ...DEFAULT_CONTROL, ...config };
    autosave();
    startControl();
    return { config: prefs.control, status: control.getStatus(), addresses: localAddresses() };
  });
  ipcMain.handle('env:status', () => ({
    platform: process.platform,
    accessibility: IS_MAC ? axTrusted() : null,
    apps: Object.entries(presenters.APPS).map(([id, a]) => ({ id, name: a.name, short: a.short, installed: presenters.isInstalled(id) })),
    pptApp: presenters.pptApp(show.settings.pptApp),
    supportedExt: presenters.SUPPORTED_EXT,
  }));
  ipcMain.handle('env:requestAccessibility', () => {
    if (!IS_MAC) return;
    axTrusted(true);
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
}

function buildMenu() {
  const send = (cmd) => () => fileCommand(cmd);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Show', accelerator: 'Command+N', click: send('new') },
      { label: 'Open Show…', accelerator: 'Command+O', click: send('open') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'Command+S', click: send('save') },
      { label: 'Save As…', accelerator: 'Shift+Command+S', click: send('saveAs') },
      ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit' }]),
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
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    // backgroundThrottling off: timers, sync and the remote API must keep full speed when the window is hidden.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));
  win.on('close', async (e) => {
    if (state.showMode && !app.isQuitting && !app.showModeQuitConfirmed) {
      e.preventDefault();
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Show mode is on. Quit needit Deck Cue?' });
      if (r.response !== 0) return;
      app.showModeQuitConfirmed = true;
      win.close();
      return;
    }
    if (dirty && show.cues.length && !app.isQuitting) {
      e.preventDefault();
      if (await confirmDiscard()) { app.isQuitting = true; app.quit(); }
    }
  });
  // Hidden helper windows (PDF probe, PDF player) must not keep the app running.
  win.on('closed', () => { win = null; app.quit(); });
  updateTitle();
}

app.whenReady().then(() => {
  require('./about').setupAbout(APP_NAME);
  // Web MIDI (incl. SysEx for MIDI Show Control) for the main window; nothing else is granted.
  const allowed = new Set(['midi', 'midiSysex']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  presenters.pdfPlayer.on('status', (s) => {
    if (process.env.DECKCUE_DEBUG) console.log(`[pdf] page ${s.page}/${s.pages}`);
    if (state.live && state.live.app === 'pdf') {
      state.liveDetail = `page ${s.page}/${s.pages}`;
      state.liveSlide = s.page;
      state.liveSlides = s.pages;
      broadcast();
    }
  });
  presenters.pdfPlayer.on('closed', () => {
    if (state.live && state.live.app === 'pdf') { state.live = null; state.liveCueId = null; state.liveDetail = null; registerShortcuts(); broadcast(); }
  });
  loadInitial();
  follower = createFollower({
    onEvent: onMainEvent,
    onState: onMainState,
    onStatus: (st) => {
      if (st.state === 'lost') followHeld = true;
      if (process.env.DECKCUE_DEBUG) console.log(`[sync] link ${st.state}${followHeld ? ' (held)' : ''}`);
      sendSync();
      broadcast();
    },
  });
  control = createControlServer({
    getState: remoteState,
    getShow: () => show,
    onFollowers: (names) => { followers = names; sendSync(); },
    onCenters: (names) => { centers = names; if (win && !win.isDestroyed()) win.webContents.send('centers', centers); },
    manage: createManage({ getConfig: () => prefs.center, extensions: presenters.SUPPORTED_EXT, actions: manageActions }),
    actions: {
      go,
      stop: stopAll,
      nav: navSlide,
      blackout: setBlackout,
      fire: (ref) => { fireCue(cueByRef(ref).id); },
      arm: (ref) => setArmed(cueByRef(ref).id),
      armStep,
      timer: timerCommand,
      stageMessage: setStageMessage,
      showMode: (on) => setShowMode(on),
      presenter: presenterAction,
      presenterMute: (on) => setPresenterMuted(on),
      timerScreen: (on, content) => setTimerScreenForced(on, content),
      cueThumb: (ref) => {
        const t = thumbs[cueByRef(ref).id];
        const m = t && /^data:([^;]+);base64,(.*)$/.exec(t);
        if (!m) throw Object.assign(new Error('No thumbnail for that cue'), { code: 404 });
        return { type: m[1], data: Buffer.from(m[2], 'base64') };
      },
      cueFile: (ref) => {
        const c = cueByRef(ref);
        const f = c.file && c.file.path;
        if (!f || path.extname(f).toLowerCase() !== '.pdf' || !fs.existsSync(f)) throw Object.assign(new Error('No PDF for that cue'), { code: 404 });
        return f;
      },
    },
    onStatus: (status) => { if (win && !win.isDestroyed()) win.webContents.send('control-status', status); },
  });
  setupIpc();
  buildMenu();
  createWindow();
  registerShortcuts();
  startControl();
  startBeacon();
  startSync();
  schedulePreflight(1500);
  if (prefs.showMode.autoStart) setShowMode(true);
  thumbnailer = createThumbnailer({ cacheDir: userFile('thumbs'), probePdf: preflight.probePdf });
  timerScreen.onDismiss(() => setTimerScreenForced(false));
  versions = createVersionWatcher({ getCues: () => show.cues, onChange: onVersions });
  versions.start();
  setInterval(pollPosition, 1000);
  // While a backup is connected, re-send the state every few seconds so it can correct any drift
  // (e.g. its own clicker moved a slide) even when nothing changes on the main.
  setInterval(() => { if (followers.length && control) control.update(); }, 3000);
  const onDisplays = () => { if (win) win.webContents.send('displays', listDisplays()); schedulePreflight(); broadcast(); };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); hideBlack(); preflight.closeProbe(); timerScreen.close(); if (beacon) beacon.stop(); if (control) control.stop(); if (follower) follower.stop(); });
app.on('window-all-closed', () => app.quit());
// Turn show mode off before quitting so notification settings are restored.
app.on('before-quit', async (e) => {
  if (!showmode.isActive()) return;
  e.preventDefault();
  if (!app.showModeQuitConfirmed) {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Show mode is on. Quit needit Deck Cue?' });
    if (r.response !== 0) return;
    app.showModeQuitConfirmed = true;
  }
  await showmode.setActive(false).catch(() => {});
  app.quit();
});
