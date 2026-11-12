// Preflight: checks each cue for what tends to break on show day, with plain-language results.
// File analysis is cached until the file changes; machine checks (app, output, fonts) run every time.
const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { analyzePptx, isCompoundFile } = require('./pptx');
const { installedFonts } = require('./fonts');

const OOXML = new Set(['.pptx', '.ppsx', '.potx', '.pptm', '.ppsm']);
const LEGACY = new Set(['.ppt', '.pps', '.pot', '.dps']);
// Video/audio formats PowerPoint and WPS for Mac generally can't play.
const MAC_UNPLAYABLE = new Set(['.wmv', '.wma', '.asf', '.avi', '.flv']);
const VIDEO = new Set(['.mp4', '.m4v', '.mov', '.wmv', '.avi', '.mpg', '.mpeg', '.mkv', '.webm', '.flv', '.asf']);
const LARGE_FILE = 500 * 1024 * 1024;

// ---------- PDF probe (pdf.js in a hidden window) ----------
let probeWin = null;
let probeLoaded = null;
const pending = new Map();
let token = 0;
ipcMain.on('probe:reply', (_e, r) => {
  const done = pending.get(r.token);
  if (done) { pending.delete(r.token); done(r); }
});

async function probePdf(file) {
  if (!probeWin || probeWin.isDestroyed()) {
    probeWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'probe-preload.js'), contextIsolation: true, sandbox: true } });
    probeLoaded = probeWin.loadFile(path.join(__dirname, 'probe.html'));
  }
  await probeLoaded;
  const data = await fs.promises.readFile(file);
  const t = ++token;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(t); resolve({ error: 'timed out reading the PDF' }); }, 20000);
    pending.set(t, (r) => { clearTimeout(timer); resolve(r); });
    probeWin.webContents.send('probe:request', { token: t, data });
  });
}

function closeProbe() {
  if (probeWin && !probeWin.isDestroyed()) probeWin.destroy();
  probeWin = null;
}

// ---------- file analysis ----------
const cache = new Map(); // path -> { key, result }

async function analyzeFile(file) {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.result;
  const ext = path.extname(file).toLowerCase();
  let result;
  try {
    if (OOXML.has(ext)) result = isCompoundFile(file) ? { kind: 'encrypted' } : analyzePptx(file);
    else if (LEGACY.has(ext)) result = { kind: 'legacy' };
    else if (ext === '.pdf') {
      const r = await probePdf(file);
      result = r.error === 'password' ? { kind: 'encrypted' } : r.error ? { kind: 'error', error: r.error } : { kind: 'pdf', slideCount: r.pages, width: r.width, height: r.height };
    } else result = { kind: 'other' };
  } catch (e) {
    result = { kind: 'error', error: e.message };
  }
  result.size = st.size;
  cache.set(file, { key, result });
  return result;
}

// ---------- checks ----------
const RATIOS = [[16, 9], [16, 10], [4, 3], [3, 2], [5, 4], [21, 9], [32, 9], [1, 1], [9, 16]];
function ratioName(w, h) {
  const r = w / h;
  for (const [a, b] of RATIOS) if (Math.abs(r - a / b) / (a / b) < 0.02) return `${a}:${b}`;
  return `${r.toFixed(2)}:1`;
}

const LEVELS = { ok: 0, info: 1, warn: 2, error: 3 };

// ctx: { file, appName, appLabel, appInstalled, needsAccessibility, accessibilityOk, display, displayLabel,
//        outputMissing, startSlide }
async function checkCue(ctx) {
  const items = [];
  const add = (level, text) => items.push({ level, text });

  if (!ctx.file) {
    add('error', ctx.filePath ? `File not found: ${ctx.filePath}` : 'No file on this cue.');
    return finish(items);
  }
  if (!ctx.appInstalled) add('error', `${ctx.appLabel} isn't installed on this computer.`);
  if (ctx.needsAccessibility && !ctx.accessibilityOk) add('warn', `${ctx.appLabel} needs Accessibility permission for Deck Cue (System Settings › Privacy & Security › Accessibility).`);
  if (ctx.outputMissing) add('warn', `Output “${ctx.outputMissing}” isn't connected, so the app will choose the screen.`);

  const a = await analyzeFile(ctx.file);
  if (a.kind === 'encrypted') add('error', 'Password-protected. Save a copy without a password for the show.');
  else if (a.kind === 'error') add('warn', `Couldn't inspect the file (${a.error}). Open it once to check it.`);
  else if (a.kind === 'legacy') add('info', 'Older file format: fonts and media can\'t be checked. Saving it as .pptx is safer.');

  if (a.slideCount === 0) add('error', 'The file has no slides.');
  if (a.slideCount && ctx.startSlide > a.slideCount) add('warn', `Start slide is ${ctx.startSlide} but there ${a.slideCount === 1 ? 'is 1 slide' : `are ${a.slideCount} slides`}; it will start at slide 1.`);
  if (a.hidden) add('info', `${a.hidden} hidden slide${a.hidden > 1 ? 's' : ''}; skipped during the show.`);

  if (a.fonts && a.fonts.length) {
    const have = installedFonts();
    const embedded = new Set((a.embeddedFonts || []).map((f) => f.toLowerCase()));
    const missing = a.fonts.filter((f) => !embedded.has(f.toLowerCase()) && !have.has(f.toLowerCase()));
    if (missing.length) add('warn', `Font${missing.length > 1 ? 's' : ''} not on this computer: ${missing.join(', ')}. Text will use a substitute and may reflow.`);
  }

  if (a.width && a.height && ctx.display) {
    const deck = a.width / a.height;
    const out = ctx.display.bounds.width / ctx.display.bounds.height;
    if (Math.abs(deck - out) / out > 0.03) {
      const where = deck < out ? 'black bars at the sides' : 'black bars above and below';
      add('warn', `${ratioName(a.width, a.height)} slides on a ${ratioName(ctx.display.bounds.width, ctx.display.bounds.height)} output (${ctx.displayLabel}): ${where}.`);
    }
  }

  for (const m of a.media || []) {
    if (m.linked && m.web) add('info', `Streams ${m.name || 'media'} from the internet; needs a connection at the venue.`);
    else if (m.linked && !m.exists) add('error', `Linked ${VIDEO.has(m.ext) ? 'video' : 'media'} not found: ${m.target}`);
    else if (m.linked) add('info', `Plays ${m.name} from outside the deck; copy it along with the file.`);
    if (process.platform === 'darwin' && MAC_UNPLAYABLE.has(m.ext) && (ctx.appName === 'powerpoint' || ctx.appName === 'wps')) {
      add('warn', `${m.name} (${m.ext.slice(1).toUpperCase()}) may not play on a Mac. Convert it to MP4.`);
    }
  }
  const videos = (a.media || []).filter((m) => VIDEO.has(m.ext));
  if (videos.length && ctx.appName === 'wps') add('info', `${videos.length} video${videos.length > 1 ? 's' : ''} in the deck; rehearse playback in WPS Office.`);
  if (a.size > LARGE_FILE) add('info', `Large file (${Math.round(a.size / 1048576)} MB); allow time for it to open.`);

  return finish(items);
}

function finish(items) {
  const level = items.reduce((lv, i) => (LEVELS[i.level] > LEVELS[lv] ? i.level : lv), 'ok');
  return { level, items };
}

module.exports = { checkCue, closeProbe };
