// needit Command Center: finds every needit Deck Cue player on the network, sends presentations to
// them, and runs them from one place. It talks to each player's own API (src/control/server.js and
// manage.js); the players keep their shows, so they carry on if the Command Center goes away.
const APP_NAME = 'needit Command Center';
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { listenForBeacons } = require('../control/beacon');

const IS_MAC = process.platform === 'darwin';
// In development both apps share one Electron, so give the Command Center its own settings folder.
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'needit Command Center (dev)'));
app.setName(APP_NAME);

const PRESENTATION_EXT = ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'dps', 'key', 'pdf'];
const prefsFile = () => path.join(app.getPath('userData'), 'center.json');
let prefs = { key: '', manual: [], linked: [] }; // manual: [{ host, port }] added by address; linked: player ids
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
function request(node, method, urlPath, body, timeout = 8000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: node.address, port: node.port, method, path: urlPath, timeout,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(prefs.key ? { 'X-DeckCue-Key': prefs.key } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve(res.statusCode >= 200 && res.statusCode < 300 ? { ok: true, ...json } : { ok: false, error: json.error || `The computer answered ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer')));
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'That computer is not reachable.' : e.message }));
    req.end(data || undefined);
  });
}

function upload(node, file, onProgress) {
  return new Promise((resolve) => {
    let total = 0;
    try { total = fs.statSync(file).size; } catch { return resolve({ ok: false, error: 'The file could not be read.' }); }
    const req = http.request({
      host: node.address, port: node.port, method: 'PUT', path: `/api/files/${encodeURIComponent(path.basename(file))}`,
      headers: { 'Content-Length': total, ...(prefs.key ? { 'X-DeckCue-Key': prefs.key } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve(res.statusCode === 200 ? { ok: true, ...json } : { ok: false, error: json.error || `The computer answered ${res.statusCode}` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    let sent = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => { sent += c.length; onProgress(sent, total); });
    stream.on('error', (e) => { req.destroy(); resolve({ ok: false, error: e.message }); });
    stream.pipe(req);
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
    clockOffset: n.clockOffset || 0,
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
  const m = /^\s*([^\s:/]+)(?::(\d+))?\s*$/.exec(String(text || '').replace(/^https?:\/\//, ''));
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
    if (!n.online && !n.manual && now - n.lastSeen > 120000) { nodes.delete(n.id); pushNodes(); }
    else if (!n.online && now - n.lastSeen < 10000) connect(n);
  }
}

// ---------- sending files ----------
async function sendFiles(id, files, target) {
  const node = nodes.get(id);
  if (!node) return { ok: false, error: 'That computer is gone.' };
  const report = (u) => { if (win && !win.isDestroyed()) win.webContents.send('upload', { id, ...u }); };
  let index = target && Number.isInteger(target.index) ? target.index : null;
  const errors = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = path.basename(file);
    if (!PRESENTATION_EXT.includes(path.extname(name).slice(1).toLowerCase())) { errors.push(`${name} is not a presentation`); continue; }
    report({ name, sent: 0, total: 1 });
    let last = 0;
    const up = await upload(node, file, (sent, total) => { if (Date.now() - last > 100 || sent === total) { last = Date.now(); report({ name, sent, total }); } });
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

// ---------- window ----------
function setupIpc() {
  ipcMain.handle('nodes:get', () => snapshot());
  ipcMain.handle('node:action', (_e, id, method, urlPath, body) => {
    const node = nodes.get(id);
    if (!node) return { ok: false, error: 'That computer is gone.' };
    if (!/^\/api\//.test(urlPath) || !['GET', 'POST'].includes(method)) return { ok: false, error: 'Not allowed' };
    return request(node, method, urlPath, body);
  });
  ipcMain.handle('node:send', (_e, id, files, target) => sendFiles(id, files, target));
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
  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Presentations', extensions: PRESENTATION_EXT }] });
    return r.canceled ? [] : r.filePaths;
  });
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
});

app.on('window-all-closed', () => app.quit());
