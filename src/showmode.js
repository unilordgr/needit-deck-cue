// Show-machine mode: keeps this computer awake and quiet during a show, and checks for what commonly
// interrupts one (pop-up apps, battery, muted sound, low disk).
const { powerSaveBlocker, powerMonitor } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// macOS has no API for Do Not Disturb, so show mode runs these two Shortcuts if the user has made them.
const FOCUS_ON = 'Deck Cue Show On';
const FOCUS_OFF = 'Deck Cue Show Off';

// Apps that pop up notifications, call windows or update prompts over a show.
const NOISY_APPS = [
  ['Slack', ['Slack'], ['slack.exe']],
  ['Microsoft Teams', ['Microsoft Teams', 'Microsoft Teams (work or school)', 'Microsoft Teams classic'], ['teams.exe', 'ms-teams.exe']],
  ['Zoom', ['zoom.us'], ['zoom.exe']],
  ['Webex', ['Webex', 'Cisco Webex Meetings'], ['webexmta.exe', 'ciscocollabhost.exe']],
  ['WhatsApp', ['WhatsApp'], ['whatsapp.exe']],
  ['Telegram', ['Telegram'], ['telegram.exe']],
  ['Signal', ['Signal'], ['signal.exe']],
  ['Discord', ['Discord'], ['discord.exe']],
  ['Skype', ['Skype'], ['skype.exe']],
  ['Messages', ['Messages'], []],
  ['FaceTime', ['FaceTime'], []],
  ['Mail', ['Mail'], []],
  ['Outlook', ['Microsoft Outlook'], ['outlook.exe', 'olk.exe']],
  ['Spotify', ['Spotify'], ['spotify.exe']],
  ['Dropbox', ['Dropbox'], ['dropbox.exe']],
  ['OneDrive', ['OneDrive'], ['onedrive.exe']],
  ['Google Drive', ['Google Drive'], ['googledrivefs.exe']],
  ['Creative Cloud', ['Creative Cloud'], ['creative cloud.exe']],
  ['Microsoft AutoUpdate', ['Microsoft AutoUpdate', 'Microsoft Update Assistant'], []],
];

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// ---------- running apps ----------
async function runningNoisyApps() {
  const found = [];
  if (IS_MAC) {
    const out = (await run('ps', ['-axo', 'pid=,comm='])) || '';
    const running = new Map(); // app bundle name -> pids
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      // Only an app's own executable (exactly one ".app/" in the path), not helpers nested inside it.
      const parts = m[2].split('.app/');
      if (parts.length !== 2 || !parts[1].startsWith('Contents/MacOS/')) continue;
      const name = parts[0].split('/').pop();
      if (!running.has(name)) running.set(name, []);
      running.get(name).push(Number(m[1]));
    }
    for (const [label, macNames] of NOISY_APPS) {
      const pids = macNames.flatMap((n) => running.get(n) || []);
      if (pids.length) found.push({ label, pids });
    }
  } else if (IS_WIN) {
    const out = (await run('tasklist', ['/FO', 'CSV', '/NH'])) || '';
    const running = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (!m) continue;
      const exe = m[1].toLowerCase();
      if (!running.has(exe)) running.set(exe, []);
      running.get(exe).push(Number(m[2]));
    }
    for (const [label, , winExes] of NOISY_APPS) {
      const pids = winExes.flatMap((n) => running.get(n) || []);
      if (pids.length) found.push({ label, pids });
    }
  }
  return found;
}

// Asks the apps to quit (SIGTERM on macOS, a normal close request on Windows) — never forced.
async function quitApps(labels) {
  const apps = (await runningNoisyApps()).filter((a) => labels.includes(a.label));
  for (const a of apps) {
    for (const pid of a.pids) {
      if (IS_WIN) await run('taskkill', ['/PID', String(pid)]);
      else { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    }
  }
  return apps.map((a) => a.label);
}

// ---------- notifications ----------
let macShortcuts = null;
async function macFocusShortcuts() {
  if (!IS_MAC) return null;
  const out = await run('shortcuts', ['list']);
  macShortcuts = out === null ? null : new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  return { on: !!(macShortcuts && macShortcuts.has(FOCUS_ON)), off: !!(macShortcuts && macShortcuts.has(FOCUS_OFF)) };
}

// Windows: the "Get notifications from apps and other senders" switch. The previous value is restored.
const WIN_TOAST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
let savedToast = undefined;

async function setNotificationsQuiet(quiet) {
  if (IS_MAC) {
    const sc = await macFocusShortcuts();
    const name = quiet ? FOCUS_ON : FOCUS_OFF;
    if (sc && (quiet ? sc.on : sc.off)) return (await run('shortcuts', ['run', name], 20000)) !== null;
    return false;
  }
  if (IS_WIN) {
    if (quiet) {
      if (savedToast === undefined) {
        const q = (await run('reg', ['query', WIN_TOAST_KEY, '/v', 'ToastEnabled'])) || '';
        const m = /ToastEnabled\s+REG_DWORD\s+0x(\d+)/i.exec(q);
        savedToast = m ? parseInt(m[1], 16) : null; // null: the value didn't exist
      }
      return (await run('reg', ['add', WIN_TOAST_KEY, '/v', 'ToastEnabled', '/t', 'REG_DWORD', '/d', '0', '/f'])) !== null;
    }
    if (savedToast === undefined) return true;
    const restore = savedToast === null
      ? run('reg', ['delete', WIN_TOAST_KEY, '/v', 'ToastEnabled', '/f'])
      : run('reg', ['add', WIN_TOAST_KEY, '/v', 'ToastEnabled', '/t', 'REG_DWORD', '/d', String(savedToast), '/f']);
    const ok = (await restore) !== null;
    savedToast = undefined;
    return ok;
  }
  return false;
}

// ---------- on / off ----------
let blockers = [];
let active = false;
let quietOk = false;

async function setActive(on) {
  if (on === active) return { active, quietOk };
  active = on;
  if (on) {
    blockers = [powerSaveBlocker.start('prevent-display-sleep'), powerSaveBlocker.start('prevent-app-suspension')];
    quietOk = await setNotificationsQuiet(true);
  } else {
    blockers.forEach((id) => powerSaveBlocker.stop(id));
    blockers = [];
    await setNotificationsQuiet(false);
    quietOk = false;
  }
  return { active, quietOk };
}

// ---------- readiness ----------
async function macVolume() {
  const out = await run('osascript', ['-e', 'get volume settings']);
  if (!out) return null;
  const vol = /output volume:(\d+|missing value)/.exec(out);
  const muted = /output muted:(true|false|missing value)/.exec(out);
  return { volume: vol && vol[1] !== 'missing value' ? Number(vol[1]) : null, muted: muted ? muted[1] === 'true' : null };
}

function freeDiskGB() {
  try {
    const st = fs.statfsSync(os.homedir());
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return null;
  }
}

async function readiness() {
  const items = [];
  const add = (level, text, fix) => items.push({ level, text, fix: fix || null });

  add(active ? 'ok' : 'info', active ? 'Display sleep and screensaver are blocked.' : 'Display sleep and screensaver are not blocked (turn on show mode).');

  if (IS_MAC) {
    const sc = await macFocusShortcuts();
    if (sc && sc.on && sc.off) add(active && quietOk ? 'ok' : 'info', active && quietOk ? 'Do Not Disturb turned on via your “Deck Cue Show On” shortcut.' : 'Your Do Not Disturb shortcuts are set up; they run when show mode turns on and off.');
    else add('warn', 'Notifications can pop up over the show. Set up the two Do Not Disturb shortcuts once, or turn on Do Not Disturb in Control Center.', 'focus-help');
  } else if (IS_WIN) {
    add(active && quietOk ? 'ok' : 'info', active && quietOk ? 'Windows app notifications are off (restored when show mode turns off).' : 'Windows app notifications will be turned off by show mode.');
  }

  const apps = await runningNoisyApps();
  if (apps.length) add('warn', `Can pop up over the show: ${apps.map((a) => a.label).join(', ')}.`, 'quit-apps');

  if (powerMonitor.isOnBatteryPower()) add('warn', 'Running on battery. Plug in the charger.');

  if (IS_MAC) {
    const v = await macVolume();
    if (v && v.muted) add('warn', 'Sound is muted. Video and audio in the decks won\'t be heard.');
    else if (v && v.volume === 0) add('warn', 'Sound volume is at 0.');
  }

  const gb = freeDiskGB();
  if (gb !== null && gb < 5) add('warn', `Only ${gb.toFixed(1)} GB free on the disk.`);

  return { active, quietOk, items, apps: apps.map((a) => a.label) };
}

module.exports = { setActive, readiness, quitApps, isActive: () => active, FOCUS_ON, FOCUS_OFF };
