// needit Command Center: finds every needit Deck Cue player on the network, sends presentations to
// them, and runs them from one place. It talks to each player's own API (src/control/server.js and
// manage.js); the players keep their shows, so they carry on if the Command Center goes away.
const APP_NAME = 'needit Command Center';
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { listenForBeacons } = require('../control/beacon');
const { createUpdater } = require('../update');

const IS_MAC = process.platform === 'darwin';
// In development both apps share one Electron, so give the Command Center its own settings folder.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'needit Command Center (dev)'));
// One Command Center per settings folder.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.setName(APP_NAME);

const PRESENTATION_EXT = ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'dps', 'key', 'pdf'];
const prefsFile = () => path.join(app.getPath('userData'), 'center.json');
let prefs = { key: '', manual: [], linked: [], update: { check: true, auto: false, lastVersion: '' } }; // manual: [{ host, port }] added by address; linked: player ids
let updater = null;
const updating = new Map(); // player id -> { stage, percent } while this Command Center is updating that player
let win = null;
const nodes = new Map(); // player id -> node
const myName = os.hostname().replace(/\.local$/, '');

function loadPrefs() {
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { /* first run */ }
}
function savePrefs() {
  try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch (e) { console.error('prefs', e); }
}

// ---------- talking to a player ----------
// The key is sent percent-encoded: a header cannot carry Greek or other non-Latin letters as they are.
const keyHeader = () => (prefs.key ? { 'X-DeckCue-Key': encodeURIComponent(prefs.key) } : {});
function request(node, method, urlPath, body, timeout = 8000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    let req;
    try {
    req = http.request({
      host: node.address, port: node.port, method, path: urlPath, timeout,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...keyHeader() },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve(res.statusCode >= 200 && res.statusCode < 300 ? { ok: true, ...json } : { ...json, ok: false, error: json.error || `The computer answered ${res.statusCode}` });
      });
    });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('timeout', () => req.destroy(new Error('No answer')));
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'That computer is not reachable.' : e.message }));
    req.end(data || undefined);
  });
}

// Send one file. `as` is the name it gets on the player (to keep two different files with one name apart).
function upload(node, file, onProgress, as, base = '/api/files/') {
  return new Promise((resolve) => {
    let total = 0;
    let date = 0;
    try { const st = fs.statSync(file); total = st.size; date = Math.round(st.mtimeMs); } catch { return resolve({ ok: false, error: 'The file could not be read.' }); }
    let finished = false;
    let stream = null;
    const done = (r) => { if (finished) return; finished = true; if (stream) stream.destroy(); resolve(r); };
    let req;
    try {
      req = http.request({
        host: node.address, port: node.port, method: 'PUT', path: `${base}${encodeURIComponent(as || path.basename(file))}`,
        headers: { 'Content-Length': total, 'X-File-Date': String(date), ...keyHeader() },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          done(res.statusCode === 200 ? { ok: true, ...json } : { ok: false, error: json.error || `The computer answered ${res.statusCode}` });
        });
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    // A computer that froze or lost the network must not leave "Sending…" on screen for ever.
    req.setTimeout(25000, () => req.destroy(new Error(`${node.name} stopped answering, so the file was not sent.`)));
    req.on('error', (e) => done({ ok: false, error: /EPIPE|ECONNRESET|socket hang up/.test(e.message) ? `${node.name} went away while the file was being sent.` : e.message }));
    let sent = 0;
    stream = fs.createReadStream(file);
    stream.on('data', (c) => { sent += c.length; onProgress(sent, total); });
    stream.on('error', (e) => { req.destroy(); done({ ok: false, error: e.message }); });
    stream.pipe(req);
  });
}

// Pass an update package on to a player. The player checks the signed list and the file itself before using them.
function uploadUpdate(node, pkg, asset, onProgress) {
  return new Promise((resolve) => {
    const req = http.request({
      host: node.address, port: node.port, method: 'PUT', path: `/api/update/package/${encodeURIComponent(asset)}`,
      headers: {
        'Content-Length': pkg.size, 'X-Update-List': pkg.raw.toString('base64'), 'X-Update-Signature': pkg.signature,
        ...keyHeader(),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve(res.statusCode === 200 ? { ok: true, ...json } : { ...json, ok: false, error: json.error || `The computer answered ${res.statusCode}` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    let sent = 0;
    const stream = fs.createReadStream(pkg.file);
    stream.on('data', (c) => { sent += c.length; onProgress(Math.floor((sent / pkg.size) * 100)); });
    stream.on('error', (e) => { req.destroy(); resolve({ ok: false, error: e.message }); });
    stream.pipe(req);
  });
}

// Update one player. It fetches the new version itself when it can; when it has no internet, this computer
// downloads the build once and sends it over the show network.
async function updateNode(id) {
  const node = nodes.get(id);
  if (!node || !node.online) return { ok: false, error: 'That computer is not connected.' };
  if (updating.has(id)) return { ok: true };
  let last = -10;
  const note = (stage, percent = 0) => {
    if (updating.get(id) && updating.get(id).stage === stage && percent < last + 3 && percent < 100) return;
    last = percent;
    updating.set(id, { stage, percent });
    pushNodes();
  };
  try {
    note('asking');
    let r = await request(node, 'POST', '/api/update/install', undefined, 30000);
    if (!r.ok && r.need === 'package' && r.asset) {
      if (!updater.latest()) await updater.check({ manual: true });
      if (!updater.latest()) return { ok: false, error: `Neither this computer nor ${node.name} can reach the download server.` };
      last = -10; note('downloading', 0);
      const pkg = await updater.packageFor(r.asset, (p) => note('downloading', p));
      last = -10; note('sending', 0);
      const up = await uploadUpdate(node, pkg, r.asset, (p) => note('sending', p));
      if (!up.ok) return up;
      r = await request(node, 'POST', '/api/update/install', undefined, 30000);
    }
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    updating.delete(id);
    pushNodes();
  }
}

function download(node, urlPath, dest) {
  return new Promise((resolve) => {
    const req = http.get({ host: node.address, port: node.port, path: urlPath, headers: keyHeader() }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          resolve({ ok: false, error: json.error || `The computer answered ${res.statusCode}` });
        });
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => {
        // The copy on this computer keeps the file's own date, so it is passed on unchanged.
        const date = Number(res.headers['x-file-date']);
        if (Number.isFinite(date) && date > 0) { try { fs.utimesSync(dest, date / 1000, date / 1000); } catch { /* the date is a nicety */ } }
        resolve({ ok: true });
      });
      out.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

// ---------- players ----------
let pushTimer = null;
function pushNodes() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('nodes', snapshot());
  }, 60);
}

function snapshot() {
  return [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name)).map((n) => ({
    id: n.id, name: n.name, platform: n.platform, version: n.version, address: n.address, port: n.port,
    online: n.online, manage: n.manage, keyRequired: n.keyRequired, keyOk: n.keyOk, manual: n.manual, state: n.state,
    clockOffset: n.clockOffset || 0, updating: updating.get(n.id) || null, clash: !!n.clash, copying: copying.has(n.id),
  }));
}

async function refreshInfo(node) {
  const info = await request(node, 'GET', '/api/info', undefined, 4000);
  if (!info.ok) return false;
  node.name = info.name || node.name;
  node.platform = info.platform; node.version = info.version;
  node.manage = !!info.manage; node.keyRequired = !!info.keyRequired; node.keyOk = info.keyOk !== false;
  return info;
}

function connect(node) {
  if (node.ws) return;
  const ws = new WebSocket(`ws://${node.address}:${node.port}/api/ws?role=center&name=${encodeURIComponent(myName)}`, { handshakeTimeout: 3000 });
  node.ws = ws;
  let alive = true;
  const beat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; try { ws.ping(); } catch { /* closing */ } }, 3000);
  ws.on('pong', () => { alive = true; });
  ws.on('open', async () => { node.online = true; await refreshInfo(node); pushNodes(); });
  ws.on('message', (data) => {
    alive = true;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'state') {
        node.state = msg.state;
        // The player's clock minus ours, so its countdown reads right here even if the clocks differ.
        node.clockOffset = msg.state.now ? msg.state.now - Date.now() : 0;
        if (msg.state.player && msg.state.player.name) node.name = msg.state.player.name;
        pushNodes();
      }
    } catch { /* ignore */ }
  });
  ws.on('error', () => {});
  ws.on('close', () => { clearInterval(beat); if (node.ws === ws) { node.ws = null; node.online = false; pushNodes(); } });
}

function upsert(info, address, manual = false) {
  let node = nodes.get(info.id);
  if (!node) {
    node = { id: info.id, name: info.name || address, platform: info.platform, version: info.version, address, port: info.port, online: false, manage: true, keyRequired: false, keyOk: true, manual, state: null, ws: null, lastSeen: 0 };
    nodes.set(info.id, node);
  }
  // Two computers that announce the same identity (settings copied from one to the other) would share one card
  // and the Command Center would be wired to only one of them. Each run of Deck Cue has its own mark.
  if (info.run) {
    node.runs = node.runs || new Map();
    node.runs.set(info.run, Date.now());
    for (const [run, seen] of node.runs) if (Date.now() - seen > 7000) node.runs.delete(run);
    const clash = node.runs.size > 1;
    if (clash !== !!node.clash) { node.clash = clash; pushNodes(); }
  }
  // Keep the address that works; switch only when the player is not connected (it moved or restarted).
  if (!node.ws) { node.address = address; node.port = info.port; }
  node.lastSeen = Date.now();
  if (manual) node.manual = true;
  if (info.name) node.name = info.name;
  connect(node);
  pushNodes();
  return node;
}

async function addByAddress(text) {
  // Accepts 192.168.1.20, 192.168.1.20:9640 and a pasted http://192.168.1.20:9640/
  const m = /^\s*([^\s:/]+)(?::(\d+))?\s*$/.exec(String(text || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  if (!m) return { ok: false, error: 'Type an address like 192.168.1.20' };
  const target = { address: m[1], port: Number(m[2]) || 9640 };
  const info = await request(target, 'GET', '/api/info', undefined, 4000);
  if (!info.ok || !info.id) return { ok: false, error: `No needit Deck Cue answered at ${target.address}:${target.port}. Check that it is open and that "Connect to Command Center" is on.` };
  upsert({ ...info, port: target.port }, target.address, true);
  if (!prefs.manual.some((x) => x.host === target.address && x.port === target.port)) { prefs.manual.push({ host: target.address, port: target.port }); savePrefs(); }
  return { ok: true, name: info.name };
}

// Players added by address don't need to announce themselves; try them again while they are away.
async function probeManual() {
  for (const m of prefs.manual) {
    if ([...nodes.values()].some((n) => n.online && n.address === m.host && n.port === m.port)) continue;
    const target = { address: m.host, port: m.port };
    const info = await request(target, 'GET', '/api/info', undefined, 2500);
    if (info.ok && info.id) upsert({ ...info, port: m.port }, m.host, true);
  }
}

// Drop players that announced themselves once and have been gone for two minutes.
function prune() {
  const now = Date.now();
  for (const n of nodes.values()) {
    // A linked computer stays on the board when it drops out: the operator must see that the backup is gone.
    if (!n.online && !n.manual && !(prefs.linked || []).includes(n.id) && now - n.lastSeen > 120000) { nodes.delete(n.id); pushNodes(); }
    else if (!n.online && now - n.lastSeen < 10000) connect(n);
  }
}

// ---------- sending files ----------
// files: paths, or { file, as } to give a file another name on the player.
async function sendFiles(id, files, target) {
  const node = nodes.get(id);
  if (!node) return { ok: false, error: 'That computer is gone.' };
  const report = (u) => { if (win && !win.isDestroyed()) win.webContents.send('upload', { id, ...u }); };
  let index = target && Number.isInteger(target.index) ? target.index : null;
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    const item = typeof files[i] === 'string' ? { file: files[i] } : files[i];
    const file = item.file;
    const name = item.as || path.basename(file);
    if (!PRESENTATION_EXT.includes(path.extname(name).slice(1).toLowerCase())) { errors.push(`${name} is not a presentation`); continue; }
    report({ name, sent: 0, total: 1 });
    let last = 0;
    const up = await upload(node, file, (sent, total) => { if (Date.now() - last > 150 || sent === total) { last = Date.now(); report({ name, sent, total }); } }, item.as);
    if (!up.ok) { errors.push(`${name}: ${up.error}`); report({ name, done: true, error: up.error }); continue; }
    // The first file dropped on a cue replaces that cue's file; everything else becomes a new cue.
    const res = i === 0 && target && target.replaceCueId
      ? await request(node, 'POST', `/api/cue/${encodeURIComponent(target.replaceCueId)}/file`, { file: up.name })
      : await request(node, 'POST', '/api/cues', { file: up.name, ...(index ? { index: index++ } : {}) });
    if (!res.ok) errors.push(`${name}: ${res.error}`);
    report({ name, done: true, error: res.ok ? null : res.error });
  }
  return errors.length ? { ok: false, error: errors.join('\n') } : { ok: true };
}

// Makes the target computers the same as the source: its presentations, cues (with their settings),
// saved timers and screen settings. Files travel source -> here -> target.
// Make the targets identical to the source: files, cues with their settings, saved timers, and which cue is next.
// Everything is fetched and sent before a target's list is touched, so a copy that fails halfway leaves the
// target as it was. One copy per target at a time.
const copying = new Set();
async function copyShow(sourceId, targetIds) {
  const src = nodes.get(sourceId);
  if (!src) return { ok: false, error: 'That computer is gone.' };
  const busy = targetIds.filter((t) => copying.has(t)).map((t) => (nodes.get(t) || {}).name);
  if (busy.length) return { ok: false, error: `A copy to ${busy.join(' and ')} is still running. Wait for it to finish.` };
  targetIds.forEach((t) => copying.add(t));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckcue-copy-'));
  const errors = [];
  const lastReport = new Map();
  const report = (id, u) => {
    // A big file means tens of thousands of progress events: pass on a few per second.
    const key = `${id}/${u.name}`;
    if (!u.done && u.sent !== u.total && Date.now() - (lastReport.get(key) || 0) < 150) return;
    lastReport.set(key, Date.now());
    if (win && !win.isDestroyed()) win.webContents.send('upload', { id, ...u });
  };
  try {
    const showRes = await request(src, 'GET', '/api/show');
    if (!showRes.ok || !Array.isArray(showRes.cues)) return { ok: false, error: `Could not read the list of ${src.name}.` };
    // 1. Fetch every file from the source once.
    const items = [];
    for (let i = 0; i < showRes.cues.length; i++) {
      const cue = showRes.cues[i];
      const name = cue.file && cue.file.path ? cue.file.path.split(/[\\/]/).pop() : null;
      if (!name) continue;
      let local = items.find((x) => x.name === name && x.local);
      local = local ? local.local : null;
      if (!local) {
        const dir = path.join(tmp, String(i));
        fs.mkdirSync(dir);
        const got = await download(src, `/api/cue/${encodeURIComponent(cue.id)}/download`, path.join(dir, name));
        if (got.ok) local = path.join(dir, name);
      }
      items.push({ cue, name, local });
    }
    const missing = items.filter((x) => !x.local);
    // The source's event card, if it has one.
    let cardLocal = null;
    const cardName = src.state && src.state.timerScreen && src.state.timerScreen.card;
    if (cardName) {
      fs.mkdirSync(path.join(tmp, 'card'));
      const got = await download(src, '/api/card', path.join(tmp, 'card', cardName));
      if (got.ok) cardLocal = path.join(tmp, 'card', cardName);
    }
    for (const tid of targetIds) {
      const t = nodes.get(tid);
      if (!t || !t.online) { errors.push(`${t ? t.name : 'A computer'} is not connected, so nothing was copied to it.`); continue; }
      // 2. Send the files. The target's list is not touched yet.
      let sentAll = true;
      const sentNames = new Set();
      for (const x of items) {
        if (!x.local || sentNames.has(x.name)) continue;
        report(tid, { name: x.name, sent: 0, total: 1 });
        const up = await upload(t, x.local, (sent, total) => report(tid, { name: x.name, sent, total }));
        report(tid, { name: x.name, done: true, error: up.ok ? null : up.error });
        if (!up.ok) { errors.push(`${t.name}, ${x.name}: ${up.error} Its list was left as it was.`); sentAll = false; break; }
        sentNames.add(x.name);
      }
      if (!sentAll) continue;
      // 3. Now replace the list.
      const cleared = await request(t, 'POST', '/api/cues/clear');
      if (!cleared.ok) { errors.push(`${t.name}: ${cleared.error}`); continue; }
      for (const x of items) {
        const cue = x.cue;
        // A cue whose file is missing on the source keeps its place, so the positions stay the same on both.
        const res = await request(t, 'POST', '/api/cues', { file: x.name, label: cue.label || '', autoSlideshow: cue.autoSlideshow, duplicate: true, ...(x.local ? {} : { missing: true }) });
        if (res.ok) {
          await request(t, 'POST', `/api/cue/${encodeURIComponent(res.id)}/update`, {
            startSlide: cue.startSlide || 1, duration: cue.duration || 0, notes: cue.notes || '', color: cue.color || '#3a4150',
            output: ['default', 'auto', 'window'].includes(cue.output) ? cue.output : 'default', presenterControl: cue.presenterControl !== false,
          });
        } else errors.push(`${t.name}, ${x.name}: ${res.error}`);
      }
      const st = showRes.settings || {};
      if (Array.isArray(st.timerPresets)) await request(t, 'POST', '/api/timer/presets', { presets: st.timerPresets });
      // The event card travels with the list (before the settings, so "show the card between presentations" finds it).
      if (cardLocal) {
        const up = await upload(t, cardLocal, () => {}, null, '/api/card/');
        if (!up.ok) errors.push(`${t.name}: the event card was not copied (${up.error}).`);
      }
      if (st.timerScreen) await request(t, 'POST', '/api/timerscreen/config', { idle: st.timerScreen.idle, livePip: st.timerScreen.livePip, title: st.timerScreen.title, showClock: st.timerScreen.showClock, pip: st.timerScreen.pip });
      // The same cue is next on both.
      const next = src.state && src.state.next;
      if (next && next.number) await request(t, 'POST', `/api/cue/${next.number}/arm`);
      // A file that is missing on the source keeps its place in the list. Say what the copy has for it.
      for (const x of missing) {
        const has = await request(t, 'POST', '/api/files/check', { name: x.name });
        errors.push(has.ok && has.exists
          ? `“${x.name}” is missing on ${src.name}. ${t.name} still has an older file with that name, so its cue plays that one. The two computers do not have the same file there.`
          : `“${x.name}” is missing on ${src.name}, so its cue is marked missing on ${t.name} too.`);
      }
    }
  } finally {
    targetIds.forEach((t) => copying.delete(t));
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
  return errors.length ? { ok: false, error: errors.join('\n') } : { ok: true };
}

// ---------- editing a presentation ----------
// "Edit" on a cue fetches that cue's file from its computer into a folder here and opens it in this computer's
// presentation app. The operator changes it and saves as usual; the save is noticed here, and one click sends the
// new version to the show computers. Nothing is sent by itself: apps also save on their own, half-way through a change.
// (The two DECKCUE_ variables are for tests: another folder, and no app window popping up.)
const EDIT_DIR = process.env.DECKCUE_EDIT_DIR || path.join(os.homedir(), 'needit Command Center', 'Editing');
const openFile = (file) => (process.env.DECKCUE_TEST_NO_OPEN ? Promise.resolve('') : shell.openPath(file));
const edits = new Map(); // "nodeId|cueId" -> session
let editTimer = null;
const stampOf = (file) => { try { const st = fs.statSync(file); return `${Math.round(st.mtimeMs)}:${st.size}`; } catch { return null; } };
const folderName = (s) => String(s || 'computer').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'computer';

function editList() {
  return [...edits.values()].map((e) => ({ key: e.key, nodeId: e.nodeId, cueId: e.cueId, name: e.name, state: e.state, savedAt: e.savedAt, sentAt: e.sentAt, error: e.error || null }));
}
function pushEdits() {
  if (win && !win.isDestroyed()) win.webContents.send('edits', editList());
}
// Look at the files that are open for editing: has one been saved since it was fetched or last sent?
function watchEdits() {
  if (!edits.size) { clearInterval(editTimer); editTimer = null; return; }
  let changed = false;
  for (const e of edits.values()) {
    if (e.state === 'sending' || e.state === 'fetching') continue;
    const now = stampOf(e.file);
    if (!now) continue; // apps save by writing a new file and swapping it in: it can be missing for a moment
    // Wait until two looks in a row see the same file, so a save that is still being written is not offered.
    const settled = now === e.seen;
    e.seen = now;
    if (settled && now !== e.base && (e.state !== 'changed' || e.savedAt !== Number(now.split(':')[0]))) {
      e.state = 'changed'; e.savedAt = Number(now.split(':')[0]); e.error = null; changed = true;
    }
  }
  if (changed) pushEdits();
}

async function startEdit(nodeId, cueId, again) {
  const node = nodes.get(nodeId);
  const cue = node && node.state ? node.state.cues.find((c) => c.id === cueId) : null;
  if (!node || !cue) return { ok: false, error: 'That cue is gone.' };
  if (!cue.file || cue.missing) return { ok: false, error: `${node.name} does not have that file, so there is nothing to open.` };
  const key = `${nodeId}|${cueId}`;
  const had = edits.get(key);
  // Changes that were saved here but never sent: do not throw them away without being told to.
  if (had && had.state === 'changed' && !again) return { ok: false, unsent: true, name: had.name };
  const dir = path.join(EDIT_DIR, folderName(node.name));
  const file = path.join(dir, cue.file);
  const session = { key, nodeId, cueId, number: cue.number, name: cue.file, file, state: 'fetching', base: null, seen: null, savedAt: null, sentAt: null, error: null };
  if (had && had.state === 'open' && !again && stampOf(had.file)) {
    // Already fetched and not changed: just bring it up again.
    const err = await openFile(had.file);
    return err ? { ok: false, error: `The file could not be opened: ${err}` } : { ok: true };
  }
  edits.set(key, session);
  pushEdits();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const got = await download(node, `/api/cue/${encodeURIComponent(cueId)}/download`, file);
    if (!got.ok) throw new Error(got.error);
    session.base = stampOf(file); session.seen = session.base; session.state = 'open';
    const err = await openFile(file);
    if (err) throw new Error(`The file is in ${dir}, but no app opened it: ${err}`);
  } catch (e) {
    edits.delete(key);
    pushEdits();
    return { ok: false, error: /EBUSY|EPERM|EACCES/.test(e.message) ? `${cue.file} is still open in an app on this computer. Close it there, then press Edit again.` : e.message };
  }
  pushEdits();
  if (!editTimer) editTimer = setInterval(watchEdits, 1500);
  return { ok: true };
}

// Send the saved file to the computers (the one it came from and the linked ones that have that presentation).
async function sendEdit(key, targetIds) {
  const e = edits.get(key);
  if (!e) return { ok: false, error: 'That file is not open for editing any more.' };
  const stamp = stampOf(e.file);
  if (!stamp) return { ok: false, error: 'The file is being saved right now. Try again in a moment.' };
  e.state = 'sending'; e.error = null; pushEdits();
  const errors = [];
  for (const tid of targetIds) {
    const t = nodes.get(tid);
    if (!t || !t.online) { errors.push(`${t ? t.name : 'A computer'} is not connected, so it still has the old version.`); continue; }
    const report = (u) => { if (win && !win.isDestroyed()) win.webContents.send('upload', { id: tid, ...u }); };
    let last = 0;
    report({ name: e.name, sent: 0, total: 1 });
    const up = await upload(t, e.file, (sent, total) => { if (Date.now() - last > 150 || sent === total) { last = Date.now(); report({ name: e.name, sent, total }); } }, e.name);
    report({ name: e.name, done: true, error: up.ok ? null : up.error });
    if (!up.ok) errors.push(`${t.name}: ${up.error}`);
  }
  if (errors.length) { e.state = 'changed'; e.error = errors.join('\n'); pushEdits(); return { ok: false, error: e.error }; }
  e.base = stamp; e.seen = stamp; e.state = 'sent'; e.sentAt = Date.now();
  pushEdits();
  return { ok: true };
}

// One linked computer has a different version of a presentation (someone changed it there): pass that file on.
async function copyVersion(sourceId, number, targetIds) {
  const src = nodes.get(sourceId);
  const cue = src && src.state ? src.state.cues[number - 1] : null;
  if (!src || !cue || !cue.file) return { ok: false, error: 'That cue is gone.' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckcue-version-'));
  const errors = [];
  try {
    const local = path.join(tmp, cue.file);
    const got = await download(src, `/api/cue/${encodeURIComponent(cue.id)}/download`, local);
    if (!got.ok) return { ok: false, error: `${src.name}: ${got.error}` };
    for (const tid of targetIds) {
      const t = nodes.get(tid);
      if (!t || !t.online) { errors.push(`${t ? t.name : 'A computer'} is not connected.`); continue; }
      const report = (u) => { if (win && !win.isDestroyed()) win.webContents.send('upload', { id: tid, ...u }); };
      let last = 0;
      report({ name: cue.file, sent: 0, total: 1 });
      const up = await upload(t, local, (sent, total) => { if (Date.now() - last > 150 || sent === total) { last = Date.now(); report({ name: cue.file, sent, total }); } }, cue.file);
      report({ name: cue.file, done: true, error: up.ok ? null : up.error });
      if (!up.ok) errors.push(`${t.name}: ${up.error}`);
    }
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
  return errors.length ? { ok: false, error: errors.join('\n') } : { ok: true };
}

// ---------- window ----------
function setupIpc() {
  ipcMain.handle('edit:list', () => editList());
  ipcMain.handle('edit:start', (_e, nodeId, cueId, again) => startEdit(String(nodeId), String(cueId), !!again));
  ipcMain.handle('edit:send', (_e, key, targetIds) => sendEdit(String(key), (targetIds || []).map(String)));
  ipcMain.handle('edit:done', (_e, key) => { edits.delete(String(key)); pushEdits(); return { ok: true }; });
  ipcMain.handle('edit:open', async (_e, key) => { const e = edits.get(String(key)); const err = e ? await openFile(e.file) : 'gone'; return err ? { ok: false, error: `The file could not be opened: ${err}` } : { ok: true }; });
  ipcMain.handle('edit:reveal', (_e, key) => { const e = edits.get(String(key)); if (e) shell.showItemInFolder(e.file); });
  ipcMain.handle('version:copy', (_e, sourceId, number, targetIds) => copyVersion(String(sourceId), Number(number), (targetIds || []).map(String)));
  ipcMain.handle('nodes:get', () => snapshot());
  ipcMain.handle('node:action', (_e, id, method, urlPath, body) => {
    const node = nodes.get(id);
    if (!node) return { ok: false, error: 'That computer is gone.' };
    if (!/^\/api\//.test(urlPath) || !['GET', 'POST'].includes(method)) return { ok: false, error: 'Not allowed' };
    return request(node, method, urlPath, body);
  });
  ipcMain.handle('node:send', (_e, id, files, target) => sendFiles(id, files, target));
  ipcMain.handle('node:copyShow', (_e, sourceId, targetIds) => copyShow(sourceId, targetIds));
  ipcMain.handle('node:add', (_e, address) => addByAddress(address));
  ipcMain.handle('node:remove', (_e, id) => {
    const node = nodes.get(id);
    if (!node) return;
    if (node.ws) { const ws = node.ws; node.ws = null; ws.terminate(); }
    prefs.manual = prefs.manual.filter((m) => !(m.host === node.address && m.port === node.port));
    savePrefs();
    nodes.delete(id);
    pushNodes();
  });
  // The event card: an image sent to a computer, which then shows it on its output when asked to.
  ipcMain.handle('card:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('node:card', (_e, id, file) => {
    const node = nodes.get(id);
    if (!node) return { ok: false, error: 'That computer is gone.' };
    return upload(node, String(file), () => {}, null, '/api/card/');
  });
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Presentations', extensions: PRESENTATION_EXT }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('update:get', () => updater.state());
  ipcMain.handle('update:latest', () => updater.latest());
  ipcMain.handle('update:set', (_e, patch) => updater.setSettings(patch || {}));
  ipcMain.handle('update:check', () => updater.check({ manual: true }));
  ipcMain.handle('update:install', () => updater.install().catch((e) => ({ ...updater.state(), error: e.message })));
  ipcMain.handle('update:seen', () => updater.seen());
  ipcMain.handle('node:update', (_e, id) => updateNode(String(id)));
  // Before a file is sent: is one with that name already on that computer, and which cues use it?
  ipcMain.handle('files:check', async (_e, id, name) => {
    const node = nodes.get(String(id));
    if (!node) return { ok: false, error: 'That computer is gone.' };
    return request(node, 'POST', '/api/files/check', { name: String(name) });
  });
  ipcMain.handle('files:info', (_e, file) => { try { const st = fs.statSync(String(file)); return { size: st.size, date: st.mtimeMs }; } catch { return null; } });
  ipcMain.handle('prefs:get', () => ({ key: prefs.key, name: myName, linked: prefs.linked }));
  ipcMain.handle('prefs:set', async (_e, patch) => {
    if ('linked' in patch) prefs.linked = Array.isArray(patch.linked) ? patch.linked.map(String) : [];
    if ('key' in patch) {
      prefs.key = String(patch.key || '');
      for (const n of nodes.values()) if (n.online) await refreshInfo(n);
      pushNodes();
    }
    savePrefs();
    return { key: prefs.key, name: myName, linked: prefs.linked };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, backgroundColor: '#17181b', title: APP_NAME,
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[center] ${message} (${source}:${line})`); });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  loadPrefs();
  setupIpc();
  require('../about').setupAbout(APP_NAME);
  updater = createUpdater({
    prefix: 'needit-Command-Center',
    getSettings: () => prefs.update || {},
    saveSettings: (patch) => { prefs.update = { ...(prefs.update || {}), ...patch }; savePrefs(); },
    // Not while it is sending files or updating a show computer.
    isBusy: () => updating.size > 0,
    busyReason: () => 'A show computer is being updated. Wait until that has finished.',
    onChange: (u) => { if (win && !win.isDestroyed()) win.webContents.send('update', u); },
  });
  updater.start();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow();
  listenForBeacons((info, address) => upsert(info, address), (e) => console.error('discovery', e.message));
  probeManual();
  setInterval(probeManual, 5000);
  // Test hook: DECKCUE_CENTER_SEND="Player name|/path/a.pptx|/path/b.pdf" sends those files once that
  // player is connected (drag and drop from the Finder can't be automated).
  if (process.env.DECKCUE_CENTER_SEND) {
    const [name, ...files] = process.env.DECKCUE_CENTER_SEND.split('|');
    const wait = setInterval(() => {
      const node = [...nodes.values()].find((n) => n.name === name && n.online && n.state);
      if (!node) return;
      clearInterval(wait);
      sendFiles(node.id, files, null).then((r) => console.log('[test send]', JSON.stringify(r)));
    }, 500);
  }
  setInterval(prune, 3000);
  // "Connect to Command Center" or the key can change on a player while it is connected: ask again now and then.
  setInterval(async () => { for (const n of nodes.values()) if (n.online) { const before = `${n.manage}${n.keyRequired}${n.keyOk}`; await refreshInfo(n); if (before !== `${n.manage}${n.keyRequired}${n.keyOk}`) pushNodes(); } }, 5000);
});

app.on('will-quit', () => { if (updater) updater.onQuit(); });
app.on('window-all-closed', () => app.quit());
