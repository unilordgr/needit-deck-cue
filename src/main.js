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
// One copy per settings folder: a second one would share the autosave and silently have no remote control.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

const presenters = require('./presenters');
const { createControlServer, localAddresses } = require('./control/server');
const { createFollower } = require('./control/follower');
const preflight = require('./preflight');
const showmode = require('./showmode');
const { createVersionWatcher } = require('./versions');
const { createThumbnailer } = require('./thumbs');
const timerScreen = require('./timerScreen');
const { createManage } = require('./control/manage');
const { createUpdater } = require('./update');
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
// Updates: look for a new version at start (on unless switched off); install by itself only if the operator asks for that.
const DEFAULT_UPDATE = { check: true, auto: false, lastVersion: '' };
const DEFAULT_MIDI = { enabled: false, input: 'all', channel: 0, notes: true, noteBase: 60, programChange: true, msc: true, map: {} };
let prefs = { control: { ...DEFAULT_CONTROL }, sync: { ...DEFAULT_SYNC }, showMode: { ...DEFAULT_SHOWMODE }, presenter: { ...DEFAULT_PRESENTER }, midi: { ...DEFAULT_MIDI }, center: { ...DEFAULT_CENTER }, files: { ...DEFAULT_FILES } };
let beacon = null;
let centers = []; // names of Command Centers connected to this player
let control = null;
let follower = null;
let followers = [];       // names of backups following this machine
let followerDetails = []; // what each of them says about itself: { name, issue, held }
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
  update: null, // what the updater knows (see update.js)
};
const blackoutWins = new Map();
let updater = null;

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
        idle: 'off',                  // full screen between presentations: 'off' | 'timer' | 'clock' (time of day) | 'card'
        card: '',                     // the event card: an image shown full screen on the output (see cardFile)
        livePip: false,               // corner overlay while a presentation is live
        display: 'output',            // 'output' = follow the show's output, or a display ref
        title: '',                    // line above the full-screen figure, e.g. "Starting in"
        showClock: false,             // time of day under the full-screen timer
        // Overlay layout: centre (x, y) and height h as fractions of the screen.
        pip: { x: 0.9, y: 0.1, h: 0.12, bg: 'solid', label: '', content: 'timer' },
      },
      pptApp: 'auto',                 // app for .ppt/.pptx: 'auto' (first installed) | 'powerpoint' | 'wps' | 'keynote'
      closePrevious: true,            // close the previous cue's presentation after the new one starts
      closeOnStop: true,              // Stop also closes the presentation (otherwise every played deck stays open in the app)
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

// Written to a temporary file first, so a power cut in the middle of a save cannot leave an empty show.
function writeSafe(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function autosave() {
  try {
    writeSafe(userFile('autosave.deckcue'), JSON.stringify(show, null, 2));
    writeSafe(userFile('prefs.json'), JSON.stringify({ ...prefs, showPath, dirty }));
  } catch (e) { console.error('autosave failed', e); }
}

// Where the show was: the next cue, the speaker timer, the stage message and the presenter pause. After a
// crash or a restart in the middle of an event, Deck Cue comes back there instead of at cue 1 with 00:00.
let runtimeSaved = '';
let runtimeTimer = null;
function saveRuntime() {
  clearTimeout(runtimeTimer);
  runtimeTimer = setTimeout(() => {
    const text = JSON.stringify({ armedCueId: state.armedCueId, timer: state.timer, stageMessage: state.stageMessage, presenterMuted: state.presenterMuted, savedAt: Date.now() });
    if (text.replace(/"savedAt":\d+/, '') === runtimeSaved) return;
    runtimeSaved = text.replace(/"savedAt":\d+/, '');
    try { writeSafe(userFile('runtime.json'), text); } catch { /* not worth stopping for */ }
  }, 400);
}
// A copy or an upload that was cut off (a crash, a pulled cable) leaves a hidden ".name.part" file behind.
function removeStaleParts() {
  try {
    for (const n of fs.readdirSync(prefs.center.folder)) {
      if (/^\..+\.part$/.test(n)) fs.rm(path.join(prefs.center.folder, n), { recursive: true, force: true }, () => {});
    }
  } catch { /* no show folder yet */ }
}

function restoreRuntime() {
  const r = readJSON(userFile('runtime.json'));
  if (!r) return;
  if (r.armedCueId && show.cues.some((c) => c.id === r.armedCueId)) state.armedCueId = r.armedCueId;
  const t = r.timer;
  // A countdown that ended more than two hours ago belongs to another day.
  if (t && Number.isFinite(t.duration) && !(t.running && t.endsAt && t.endsAt < Date.now() - 2 * 3600 * 1000)) {
    state.timer = { duration: t.duration || 0, remaining: Number.isFinite(t.remaining) ? t.remaining : 0, endsAt: t.running ? t.endsAt : null, running: !!t.running && !!t.endsAt };
  }
  if (r.stageMessage && typeof r.stageMessage.text === 'string') state.stageMessage = { text: r.stageMessage.text, flash: !!r.stageMessage.flash };
  state.presenterMuted = !!r.presenterMuted;
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
    update: { ...DEFAULT_UPDATE, ...(saved.update || {}) },
  };
  // Settings copied to another computer (a portable folder, a disk image) must not make two computers one.
  if (prefs.center.host && prefs.center.host !== os.hostname()) prefs.center.id = '';
  prefs.center.host = os.hostname();
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
  // A show made on another computer carries that computer's paths. The files are usually here already, in
  // this computer's show folder, under the same name.
  const here = nameInFolder(prefs.center.folder, cue.file.path.split(/[\\/]/).pop());
  if (here) { cue.file.path = path.join(prefs.center.folder, here); dirty = true; autosave(); sendShow(); return cue.file.path; }
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

// The show's output as a Command Center sees it: 'auto', 'window', or the screen (id: null when it is not connected).
function outputState() {
  const ref = show.settings.defaultOutput;
  if (!ref || typeof ref !== 'object') return ref === 'window' ? 'window' : 'auto';
  const d = resolveOutput(ref);
  return { id: d ? d.id : null, label: ref.label || 'Screen' };
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
let messageTimer = null;
function setMessage(msg, level = 'info') {
  state.message = msg; state.messageLevel = level; broadcast();
  // Information goes away by itself; a warning or an error stays until it is dismissed or replaced.
  clearTimeout(messageTimer);
  if (msg && level === 'info') messageTimer = setTimeout(() => { if (state.message === msg) { state.message = null; state.messageLevel = null; broadcast(); } }, 12000);
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

// ---------- closed by hand ----------
// When the operator closes a presentation themselves (or quits PowerPoint / WPS / Keynote), its cue is no
// longer live. Asked every two seconds; it takes two "gone" answers in a row, and "cannot tell" changes nothing.
let aliveBusy = false;
let goneCount = 0;
async function pollAlive() {
  const live = state.live;
  if (!live || live.app === 'pdf') { goneCount = 0; return; }
  if (aliveBusy || state.busyCueId || Date.now() - (live.since || 0) < 6000) return;
  aliveBusy = true;
  try {
    const answer = await presenters.alive(live.app, live.file).catch(() => null);
    if (state.live !== live || state.busyCueId) { goneCount = 0; return; }
    goneCount = answer === false ? goneCount + 1 : 0;
    if (goneCount < 2) return;
    goneCount = 0;
    const cue = show.cues.find((c) => c.id === live.cueId);
    state.live = null; state.liveCueId = null; state.liveDetail = null; state.liveSlide = null; state.liveSlides = null;
    registerShortcuts();
    setMessage(`${cue ? `“${cueName(cue)}”` : 'The presentation'} was closed, so it is no longer live.`, 'info');
  } finally {
    aliveBusy = false;
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

// ---------- a file that disappears ----------
// The stick was pulled out, or someone moved the file: say so within seconds, not when the window is next clicked.
let missingKey = '';
function checkMissing() {
  const key = show.cues.filter((c) => !c.file || !fs.existsSync(c.file.path)).map((c) => c.id).join(',');
  if (key === missingKey) return;
  missingKey = key;
  if (win && !win.isDestroyed()) win.webContents.send('files-changed');
  if (control) control.update();
  schedulePreflight();
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
    onlyOwnScreen: screen.getAllDisplays().length === 1,
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
  const card = cardFile();
  const noCard = ts.card ? 'The event card image is missing. Choose it again under On screen…' : 'No event card yet. Choose its image under On screen…';
  if (rt.forced) {
    content = CONTENTS.includes(rt.forcedContent) ? rt.forcedContent : 'timer';
    if (content === 'card' && !card) note = noCard; else mode = 'full';
  } else if (!state.live && ts.idle !== 'off') {
    const want = CONTENTS.includes(ts.idle) ? ts.idle : 'timer';
    if (want === 'card' && !card) note = noCard;
    // Never cover the operator's own screen automatically (DECKCUE_TEST_COVER is for single-screen testing).
    else if (coversOperator && !process.env.DECKCUE_TEST_COVER) note = 'Full screen between presentations needs a second screen. On this one it would cover Deck Cue.';
    else { mode = 'full'; content = want; }
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
    payload: { content, timer: state.timer, config: ts, card: card ? cardUrl(card) : '' },
  }).catch((e) => console.error('timer screen', e));
}

// The event card: one image for the output (the event's own holding slide). It can be sent to the output at any
// time, or shown by itself whenever no presentation is playing. Its file lives in the show folder.
const CARD_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const CONTENTS = ['timer', 'clock', 'card'];
function cardFile() {
  const c = show.settings.timerScreen.card;
  if (!c) return null;
  if (fs.existsSync(c)) return c;
  // A show from another computer: the image is found here by its name, like the presentations.
  const here = nameInFolder(prefs.center.folder, String(c).split(/[\\/]/).pop());
  return here ? path.join(prefs.center.folder, here) : null;
}
// The date in the address makes the output load the image again when a new one replaces it.
function cardUrl(file) {
  let v = 0;
  try { v = Math.round(fs.statSync(file).mtimeMs); } catch { /* shown as it is */ }
  return `${require('url').pathToFileURL(file).href}?v=${v}`;
}
// src: an image anywhere on this computer, or '' to take the card away.
async function setCard(src) {
  const ts = show.settings.timerScreen;
  if (!src) {
    ts.card = '';
    if (ts.idle === 'card') ts.idle = 'off';
    if (state.timerScreen.forced && state.timerScreen.forcedContent === 'card') state.timerScreen.forced = false;
    showChanged();
    return { card: '' };
  }
  if (!CARD_EXT.includes(path.extname(src).toLowerCase())) throw new Error('The event card must be an image: PNG or JPG.');
  let dest = src;
  if (prefs.files.copy && !inShowFolder(src)) {
    const folder = prefs.center.folder;
    await fs.promises.mkdir(folder, { recursive: true });
    dest = path.join(folder, nameInFolder(folder, path.basename(src)) || path.basename(src));
    await fs.promises.copyFile(src, dest); // a new card with the same name takes the old one's place
  }
  ts.card = dest;
  showChanged();
  return { card: path.basename(dest) };
}

// content: 'timer', 'clock' (time of day) or 'card' (the event card).
function setTimerScreenForced(on, content) {
  const rt = state.timerScreen;
  // Asking for the other content while it is already up switches it instead of hiding it.
  const switching = on === undefined && rt.forced && content && content !== rt.forcedContent;
  const was = rt.forced;
  rt.forced = switching ? true : on === undefined ? !rt.forced : !!on;
  if (content) rt.forcedContent = CONTENTS.includes(content) ? content : 'timer';
  else if (rt.forced && !was) rt.forcedContent = 'timer'; // turned on without saying what: the timer
  broadcast();
}

// What a file looks like on disk right now: changes when a new version replaces it.
function fileStamp(file) {
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return null; }
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

// A short fingerprint of a cue's file, so a Command Center can tell whether two computers really have the same
// presentation: the name does not say, and someone may have changed it on one of them. It is worked out in the
// background, one file at a time, and remembered until the file changes. Very large files are told apart by size
// and date instead of being read through.
const sigCache = new Map(); // path -> { stamp, sig, retryAt }
let sigQueue = Promise.resolve();
function fileSig(file) {
  const stamp = fileStamp(file);
  if (!stamp) return null;
  const known = sigCache.get(file);
  if (known && known.stamp === stamp && !(known.retryAt && Date.now() > known.retryAt)) return known.sig;
  const entry = { stamp, sig: null, retryAt: 0 };
  sigCache.set(file, entry);
  const [mtime, size] = stamp.split(':').map(Number);
  if (size > 512 * 1024 * 1024) { entry.sig = `big-${size}-${Math.round(mtime / 2000)}`; return entry.sig; }
  sigQueue = sigQueue.then(() => hashFile(file)).then((h) => {
    if (sigCache.get(file) !== entry) return;
    if (fileStamp(file) !== stamp) { sigCache.delete(file); return; } // it changed while it was being read
    entry.sig = h.slice(0, 16);
    if (control) control.update();
  }).catch(() => { entry.retryAt = Date.now() + 5000; }); // in use just now: try again in a while
  return null;
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
// The name a file has in the show folder, whatever capitals it was typed with. Mac and Windows folders do
// not tell "Deck.pptx" from "deck.pptx", so neither may this.
function nameInFolder(folder, name) {
  try {
    const low = name.toLowerCase();
    return fs.readdirSync(folder).find((n) => n.toLowerCase() === low) || null;
  } catch { return null; }
}

// "Deck.pptx" -> "Deck (2).pptx": the first name that is free in the folder.
function freeName(folder, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; i < 500; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!nameInFolder(folder, candidate)) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

// Copy a presentation into the show folder. A different file with the same name is never overwritten
// without a decision: mode 'replace' (a new version: the old one goes to the Trash) or 'keep' (both stay,
// the new one as "Name (2)"). Without a mode the caller gets the facts to ask the operator with.
async function importFile(src, mode) {
  if (mode === true) mode = 'replace';
  if (!prefs.files.copy) return { path: src, usedBy: [] };
  const folder = prefs.center.folder;
  await fs.promises.mkdir(folder, { recursive: true });
  const name = path.basename(src);
  const existing = nameInFolder(folder, name);
  let dest = path.join(folder, existing || name);
  if (samePath(src, dest)) return { path: dest, usedBy: cuesUsing(dest) };
  let info;
  try { info = fs.statSync(src); } catch (e) { return { error: `Could not read ${name}: ${e.message}` }; }
  const isFolder = info.isDirectory(); // a Keynote package is a folder
  if (existing) {
    if (!isFolder && await sameContent(src, dest).catch(() => false)) return { path: dest, same: true, usedBy: cuesUsing(dest) };
    if (mode !== 'replace' && mode !== 'keep') {
      const mine = fs.statSync(dest);
      return { conflict: true, name: existing, usedBy: cuesUsing(dest), existingDate: mine.mtimeMs, incomingDate: info.mtimeMs, older: info.mtimeMs < mine.mtimeMs - 2000 };
    }
    if (mode === 'keep') dest = path.join(folder, freeName(folder, name));
  }
  const replacing = !!existing && mode === 'replace';
  const part = path.join(folder, `.${path.basename(dest)}.${process.pid}.part`);
  try {
    if (isFolder) await fs.promises.cp(src, part, { recursive: true });
    else await fs.promises.copyFile(src, part);
    await fs.promises.utimes(part, info.atime, info.mtime); // keep the file's own date
    // The version that is being replaced goes to the Trash first, so it can be brought back.
    if (replacing) await shell.trashItem(dest).catch(() => {});
    if (replacing && isFolder) await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(part, dest);
  } catch (e) {
    fs.rm(part, { recursive: true, force: true }, () => {});
    return { error: replacing ? `${path.basename(dest)} is in use and could not be replaced. Stop its cue and try again.` : `${name} could not be copied into the show folder. ${e.code === 'ENOSPC' ? 'The disk is full.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'The folder cannot be written to.' : e.message}` };
  }
  const media = await copyLinkedMedia(src, dest);
  if (versions) versions.scan();
  return { path: dest, replaced: replacing, kept: !!existing && mode === 'keep', usedBy: cuesUsing(dest), media };
}

// Videos and sounds that a deck links to (rather than embeds) sit beside it on the stick. Without them the
// deck plays with black boxes, so they are copied along, into the same place beside the copy.
async function copyLinkedMedia(src, dest) {
  if (!['.pptx', '.pptm', '.ppsx', '.ppsm'].includes(path.extname(src).toLowerCase())) return [];
  let info;
  try { info = require('./preflight/pptx').analyzePptx(src); } catch { return []; }
  const copied = [];
  for (const m of info.media || []) {
    if (!m.linked || m.web || !m.exists) continue;
    const rel = path.relative(path.dirname(src), m.target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // only what is beside the deck, or in a folder beside it
    const to = path.join(path.dirname(dest), rel);
    try {
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      if (!fs.existsSync(to) || !(await sameContent(m.target, to).catch(() => false))) await fs.promises.copyFile(m.target, to);
      copied.push(rel);
    } catch { /* preflight will say it is missing */ }
  }
  return copied;
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

const RUN_ID = crypto.randomUUID().slice(0, 8); // this run of the app; a Command Center uses it to spot two computers with one identity
function playerInfo() {
  return { app: APP_NAME, id: prefs.center.id, run: RUN_ID, name: playerName(), platform: process.platform, version: app.getVersion(), show: show.showName, update: updateSummary() };
}

// What a Command Center needs to know about this computer's version.
function updateSummary() {
  const u = updater ? updater.state() : null;
  if (!u) return null;
  return { current: u.current, available: u.available, status: u.status, percent: u.percent, asset: u.asset, blocked: u.blocked, canInstall: u.canInstall, busy: u.busy, busyWhy: u.busyWhy, error: u.error };
}

function showChanged() {
  dirty = true;
  autosave(); registerShortcuts(); sendShow(); broadcast(); schedulePreflight();
  if (versions) versions.scan();
}

const CUE_FIELDS = ['label', 'autoSlideshow', 'startSlide', 'duration', 'notes', 'color', 'output', 'presenterControl'];
const manageActions = {
  info: playerInfo,
  // A Command Center asked this computer to update. It answers at once; the progress shows in the state.
  async updateInstall() {
    let u = updater.state();
    if (u.blocked) throw Object.assign(new Error(u.blocked), { code: 409 });
    if (u.busy) throw Object.assign(new Error(u.busyWhy), { code: 409 });
    if (!u.canInstall) {
      // Look for it here first. A show computer without internet says so, and the Command Center sends the package.
      u = await updater.check({ manual: true });
      if (!u.available || u.error) throw Object.assign(new Error(u.available ? u.error : 'This computer could not find the update by itself.'), { code: 409, extra: { need: 'package', asset: u.asset } });
    }
    updater.install().catch(() => {});
    return { update: updateSummary() };
  },
  // What a Command Center needs to know before it sends a file with this name.
  fileCheck(name) {
    const folder = prefs.center.folder;
    const existing = nameInFolder(folder, name);
    if (!existing) return { exists: false, name, usedBy: [] };
    const file = path.join(folder, existing);
    const st = fs.statSync(file);
    return { exists: true, name: existing, usedBy: cuesUsing(file), size: st.size, date: st.mtimeMs };
  },
  nameInFolder: (name) => nameInFolder(prefs.center.folder, name),
  trash: (file) => shell.trashItem(file).catch(() => {}),
  updateAsset: () => (updater ? updater.state().asset : null),
  updateTempFile: () => {
    const folder = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(folder, { recursive: true });
    return path.join(folder, `incoming-${process.pid}-${Date.now()}.part`);
  },
  async updateReceive(pkg) {
    await updater.receive(pkg);
    return { update: updateSummary() };
  },
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
  // The event card, sent by a Command Center (the file is in the show folder already), or taken away.
  cardExtensions: CARD_EXT,
  setCard: (file) => setCard(file),
  cardPath() {
    const f = cardFile();
    if (!f) throw Object.assign(new Error('This computer has no event card.'), { code: 404 });
    return f;
  },
  // Which screen the slideshows go to: 'auto' (the app chooses), 'window' (program window), or a screen's id.
  setOutput(body) {
    const v = body && body.output;
    if (v === 'auto' || v === 'window') show.settings.defaultOutput = v;
    else {
      const d = listDisplays().find((x) => String(x.id) === String(v));
      if (!d) throw Object.assign(new Error('That screen is not connected to this computer any more.'), { code: 404 });
      show.settings.defaultOutput = { id: d.id, label: d.label, width: d.bounds.width, height: d.bounds.height };
    }
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
    if (['off', 'timer', 'clock', 'card'].includes(patch.idle)) ts.idle = patch.idle;
    if ('livePip' in patch) ts.livePip = !!patch.livePip;
    // Where the small timer sits and how big it is: centre x, y and height h, as parts of the screen (0 to 1).
    if (patch.pip && typeof patch.pip === 'object') {
      const num = (v, lo, hi, cur) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : cur);
      ts.pip.x = num(patch.pip.x, 0, 1, ts.pip.x);
      ts.pip.y = num(patch.pip.y, 0, 1, ts.pip.y);
      // place: one of nine places on the screen (t/m/b + l/c/r). The box is tucked into it with a small gap, worked
      // out here because only this computer knows its screen. A new size keeps the place the box is in.
      const cell = () => `${ts.pip.y < 1 / 3 ? 't' : ts.pip.y > 2 / 3 ? 'b' : 'm'}${ts.pip.x < 1 / 3 ? 'l' : ts.pip.x > 2 / 3 ? 'r' : 'c'}`;
      const place = /^[tmb][lcr]$/.test(String(patch.pip.place)) ? patch.pip.place : 'h' in patch.pip ? cell() : null;
      ts.pip.h = num(patch.pip.h, 0.04, 0.5, ts.pip.h);
      if (place) {
        const d = timerScreenDisplay();
        const halfW = (2.1 * ts.pip.h * (d.bounds.height / d.bounds.width)) / 2; // the box is about 2.1 times as wide as high
        const halfH = ts.pip.h / 2;
        const gap = 0.03;
        ts.pip.x = place[1] === 'l' ? gap + halfW : place[1] === 'r' ? 1 - gap - halfW : 0.5;
        ts.pip.y = place[0] === 't' ? gap * 1.6 + halfH : place[0] === 'b' ? 1 - gap * 1.6 - halfH : 0.5;
      }
      if (['solid', 'glass', 'none'].includes(patch.pip.bg)) ts.pip.bg = patch.pip.bg;
      if (['timer', 'clock'].includes(patch.pip.content)) ts.pip.content = patch.pip.content;
    }
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
  const bad = (text) => Object.assign(new Error(text), { code: 400 });
  if (cmd === 'set' || cmd === 'setstart') {
    // An empty or unreadable time must not wipe a running countdown.
    if (seconds === null || seconds === undefined || String(seconds).trim() === '' || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) throw bad('Give the time in seconds, for example 300.');
    const ms = Math.round(Number(seconds)) * 1000;
    const running = cmd === 'setstart' ? ms > 0 : t.running;
    state.timer = { duration: ms, remaining: ms, endsAt: running ? Date.now() + ms : null, running };
  } else if (cmd === 'start') {
    if (!t.running && t.duration <= 0 && t.remaining <= 0) throw bad('Set a time first.');
    if (!t.running) state.timer = { ...t, running: true, endsAt: Date.now() + t.remaining };
  } else if (cmd === 'pause') {
    if (t.running) state.timer = { ...t, running: false, remaining: t.endsAt - Date.now(), endsAt: null };
  } else if (cmd === 'reset') {
    state.timer = { ...t, running: false, remaining: t.duration, endsAt: null };
  } else if (cmd === 'add') {
    // Changing the time on the fly also moves the total, so progress bars stay meaningful.
    if (!Number.isFinite(Number(seconds))) throw bad('Give the seconds to add or take off.');
    const ms = Math.round(Number(seconds)) * 1000;
    const duration = Math.max(0, t.duration + ms);
    // Taking time off stops at zero: it never turns a countdown into "over time" by itself.
    if (t.running) {
      const left = t.endsAt - Date.now();
      state.timer = { ...t, duration, endsAt: ms < 0 && left > 0 ? Math.max(Date.now(), t.endsAt + ms) : t.endsAt + ms };
    } else {
      state.timer = { ...t, duration, remaining: ms < 0 && t.remaining > 0 ? Math.max(0, t.remaining + ms) : t.remaining + ms };
    }
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
  if (!presenters.isInstalled(appName)) return setMessage(`${presenters.APPS[appName].name} is not installed on this computer. Pick another app in the cue or in Settings.`, 'error');

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
    // The same cue fired again after its file changed on disk (a new version arrived while it was live): the
    // app still has the old version open, and opening the file again would only bring that one forward.
    // Close it first, so the new version is loaded. Compared by date and size as they were when it was loaded,
    // because a file sent from another computer keeps its own, possibly older, date.
    const reload = !!prev && prev.file === file && prev.app === appName && appName !== 'pdf' && !!prev.stamp && fileStamp(file) !== prev.stamp;
    // WPS can't close a document while a slideshow is running, and switching its tabs pulls the editor
    // in front of the show, so close the previous deck before starting the next one.
    const closeFirst = (closePrev && prev.app === 'wps') || reload;
    if (closeFirst) {
      if (auto || reload) await presenters.stop(prev.app).catch(() => {});
      await presenters.close(prev.app, prev.file).catch(() => {});
    }
    const result = await presenters.fire(appName, { file, startSlide: Number(cue.startSlide) || 1, auto, bounds: display ? display.bounds : null, program });
    if (closePrev && !closeFirst) await presenters.close(prev.app, prev.file).catch(() => {});
    state.live = { cueId: id, app: appName, file, since: Date.now(), stamp: fileStamp(file) };
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

let lastGo = 0;
function go() {
  // A held key, a double press or a bouncing button must not run through two cues.
  const now = Date.now();
  if (now - lastGo < 700) return;
  lastGo = now;
  const armed = state.armedCueId && show.cues.find((c) => c.id === state.armedCueId);
  if (armed) return fireCue(armed.id);
  // Nothing is next. At the end of the show GO does nothing; before the show it starts the first cue.
  if (state.liveCueId || state.busyCueId) return setMessage('That was the last cue. Nothing is next.', 'info');
  if (show.cues[0]) fireCue(show.cues[0].id);
}

async function stopAll() {
  emit({ type: 'stop' });
  const live = state.live;
  const results = await Promise.all(Object.keys(presenters.APPS).map((a) => presenters.stop(a).then(() => null, (e) => ({ app: a, error: e.message }))));
  // If the app with the live show could not be stopped, the show is still up: do not pretend otherwise.
  const failed = live && results.find((r) => r && r.app === live.app);
  if (failed) {
    // Only when the show can still be seen running. An app that merely complained (nothing was playing) is not live.
    const still = await presenters.position(live.app).catch(() => null);
    if (still) return setMessage(`${presenters.APPS[failed.app] ? presenters.APPS[failed.app].name : failed.app} could not be stopped: ${failed.error}`, 'error');
    setMessage(`Stop: ${presenters.APPS[failed.app] ? presenters.APPS[failed.app].name : failed.app} answered with an error (${failed.error}). Check the output screen.`, 'warn');
  }
  state.liveCueId = null; state.live = null; registerShortcuts(); broadcast();
  // Stop ends the slideshow; the presentation itself would stay open in its app, and after fifteen cues there
  // are fifteen open windows. Close the one that was live (the app stays open, ready for the next cue).
  if (live && live.app !== 'pdf' && show.settings.closeOnStop !== false) await presenters.close(live.app, live.file).catch(() => {});
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
  // While Deck Cue itself is in front the arrows are left alone: there they belong to the cue list and to the
  // text boxes, and the window passes Left / Right on to the slides itself. Page Up / Page Down, which is what
  // most clickers send, stay taken either way.
  if (state.live && state.live.app === 'pdf') {
    const own = !!win && !win.isDestroyed() && win.isFocused();
    for (const [accel, dir] of CLICKER_KEYS) {
      if (own && !accel.startsWith('Page')) continue;
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
    if (main.timerScreen) {
      state.timerScreen.forced = !!main.timerScreen.forced;
      if (main.timerScreen.forced && CONTENTS.includes(main.timerScreen.content)) state.timerScreen.forcedContent = main.timerScreen.content;
    }
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
    followerTrouble: followerDetails.filter((d) => d.issue || d.held),
    issue: isBackup() ? state.syncIssue || null : null,
    held: isBackup() && followHeld,
  };
}

function sendSync() {
  if (win && !win.isDestroyed()) win.webContents.send('sync', syncStatus());
  updateTitle();
  reportToMain();
}

// A backup tells its main when it is not following: its show differs, or it is holding after the main came back.
// Otherwise the main shows a green "backup connected" while the backup would do something else.
function reportToMain() {
  if (follower && isBackup()) follower.send({ type: 'backup-status', issue: state.syncIssue || null, held: !!followHeld });
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
      card: cardFile() ? path.basename(cardFile()) : '',
      note: state.timerScreen.note || null,
      pip: { x: show.settings.timerScreen.pip.x, y: show.settings.timerScreen.pip.y, h: show.settings.timerScreen.pip.h },
    },
    // The screens of this computer and the one the slideshows go to, so a Command Center can choose it.
    outputs: listDisplays().map((d) => ({ id: d.id, label: d.label, primary: d.primary, internal: d.internal, width: d.bounds.width, height: d.bounds.height })),
    output: outputState(),
    player: { id: prefs.center.id, name: playerName(), platform: process.platform, version: app.getVersion() },
    manage: { accept: !!prefs.center.accept, keyRequired: !!prefs.center.key },
    update: updateSummary(),
    timer: { duration: state.timer.duration, remaining: timerRemaining(), running: state.timer.running, endsAt: state.timer.endsAt },
    timerPresets: show.settings.timerPresets,
    stageMessage: state.stageMessage,
    next: ref(nextCue),
    loading: ref(state.busyCueId && show.cues.find((c) => c.id === state.busyCueId)),
    blackout: !!state.blackout,
    message: state.message || null,
    messageLevel: state.message ? state.messageLevel || 'info' : null,
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
        // Which version of the file this computer has (see fileSig), and when it was last saved.
        sig: missing ? null : fileSig(c.file.path), fileDate: missing ? null : Math.round(Number((fileStamp(c.file.path) || '').split(':')[0])) || null,
      };
    }),
  };
}

function startControl() {
  try {
    control.start(prefs.control);
  } catch (e) {
    setMessage(`Remote control could not start: ${e.message}`, 'error');
  }
}

function sendShow() {
  if (win && !win.isDestroyed()) win.webContents.send('show', { show, showPath, dirty, shortcutReport });
  updateTitle();
  if (control) control.update();
}

function broadcast() {
  updateTimerScreen();
  saveRuntime();
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
    const policy = show.settings.newerVersions;
    show = normalizeShow(s); dirty = true;
    // "Ignore it" or "switch automatically" applies to what is already on screen, not only to the next change.
    if (versions && show.settings.newerVersions !== policy) setImmediate(() => versions.refresh());
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
  // The Full screen button (timer) and the Event card button: each puts its own thing up, or takes it down again.
  ipcMain.handle('timerscreen:force', (_e, content) => {
    const rt = state.timerScreen;
    const card = content === 'card';
    const up = rt.forced && (rt.forcedContent === 'card') === card;
    setTimerScreenForced(!up, card ? 'card' : 'timer');
  });
  ipcMain.handle('card:choose', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: CARD_EXT.map((e) => e.slice(1)) }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return setCard(r.filePaths[0]).catch((e) => ({ error: e.message }));
  });
  ipcMain.handle('card:clear', () => setCard(''));
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
  ipcMain.handle('timer:cmd', (_e, cmd, seconds) => { try { timerCommand(cmd, seconds); } catch (e) { setMessage(`Timer: ${e.message}`, 'warn'); } });
  ipcMain.handle('stage:message', (_e, text, flash) => setStageMessage(text, flash));
  ipcMain.handle('stage:open', (_e, view) => shell.openExternal(`http://127.0.0.1:${prefs.control.httpPort}/stage${view === 'timer' ? '?view=timer' : ''}`));
  ipcMain.handle('files:status', (_e, paths) => Object.fromEntries(paths.map((p) => [p, fs.existsSync(p)])));
  ipcMain.handle('files:resolve', () => { show.cues.forEach((c) => resolveCueFile(c)); return show; });
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Presentations', extensions: presenters.SUPPORTED_EXT.map((e) => e.slice(1)) }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('files:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('update:get', () => updater.state());
  ipcMain.handle('update:set', (_e, patch) => updater.setSettings(patch || {}));
  ipcMain.handle('update:check', () => updater.check({ manual: true }));
  ipcMain.handle('update:install', () => updater.install().catch((e) => ({ ...updater.state(), error: e.message })));
  ipcMain.handle('update:seen', () => updater.seen());
  ipcMain.handle('files:import', (_e, src, mode) => importFile(src, mode).catch((e) => ({ error: e.message })));
  ipcMain.handle('files:retire', (_e, oldPath, newPath) => retireFile(oldPath, newPath));
  ipcMain.handle('files:prefs', (_e, patch) => {
    if (patch) { prefs.files = { ...prefs.files, ...patch }; autosave(); }
    return { ...prefs.files, folder: prefs.center.folder };
  });
  ipcMain.handle('control:get', () => ({ config: prefs.control, status: control.getStatus(), addresses: localAddresses() }));
  ipcMain.handle('control:set', (_e, config) => {
    const next = { ...DEFAULT_CONTROL, ...config };
    // A port that cannot exist would leave remote control off after the next start, without a word.
    for (const key of ['httpPort', 'oscPort', 'oscFeedbackPort']) {
      const n = Number(next[key]);
      next[key] = Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : (Number(prefs.control[key]) || DEFAULT_CONTROL[key]);
    }
    prefs.control = next;
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
      { label: 'New Show', accelerator: 'CmdOrCtrl+N', click: send('new') },
      { label: 'Open Show…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: send('saveAs') },
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
    // No "save changes?" here: the show is autosaved and comes back as it was the next time Deck Cue opens.
  });
  // Hidden helper windows (PDF probe, PDF player) must not keep the app running.
  // The clicker keys are held only while another app is in front (see registerShortcuts).
  const refocus = () => { if (state.live && state.live.app === 'pdf') registerShortcuts(); };
  win.on('focus', refocus);
  win.on('blur', refocus);
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
  restoreRuntime();
  removeStaleParts();
  updater = createUpdater({
    prefix: 'needit-Deck-Cue',
    getSettings: () => prefs.update || DEFAULT_UPDATE,
    saveSettings: (patch) => { prefs.update = { ...prefs.update, ...patch }; autosave(); },
    // Never in the middle of a show.
    isBusy: () => !!state.liveCueId || !!state.busyCueId || showmode.isActive(),
    busyReason: () => (showmode.isActive() ? 'Show mode is on. Turn it off, then update.' : 'A presentation is live. Stop it, then update.'),
    onChange: (u) => { state.update = u; broadcast(); },
  });
  state.update = updater.state();
  updater.start();
  follower = createFollower({
    onEvent: onMainEvent,
    onState: onMainState,
    onStatus: (st) => {
      if (st.state === 'lost') followHeld = true;
      if (st.state === 'connected') setTimeout(reportToMain, 300);
      if (process.env.DECKCUE_DEBUG) console.log(`[sync] link ${st.state}${followHeld ? ' (held)' : ''}`);
      sendSync();
      broadcast();
    },
  });
  control = createControlServer({
    getState: remoteState,
    getShow: () => show,
    onFollowers: (names, details) => { followers = names; followerDetails = details || []; sendSync(); },
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
  setInterval(pollAlive, 2000);
  setInterval(checkMissing, 3000);
  // While a backup is connected, re-send the state every few seconds so it can correct any drift
  // (e.g. its own clicker moved a slide) even when nothing changes on the main.
  setInterval(() => { if (followers.length && control) control.update(); }, 3000);
  const onDisplays = () => { if (win) win.webContents.send('displays', listDisplays()); schedulePreflight(); broadcast(); };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);
});

app.on('will-quit', () => { if (updater) updater.onQuit(); globalShortcut.unregisterAll(); hideBlack(); preflight.closeProbe(); timerScreen.close(); if (beacon) beacon.stop(); if (control) control.stop(); if (follower) follower.stop(); });
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
