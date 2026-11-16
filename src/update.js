// Updates for needit Deck Cue and needit Command Center.
//
// Every release publishes a small list (update.json) with its version and the SHA-256 of each build, and a
// signature of that list (update.json.sig) made with a key that only the release build holds. The apps carry the
// public half of that key. Nothing is installed unless the list's signature is good and the file matches the
// list, so a package is trusted for what it is, wherever it came from: GitHub, or a Command Center that passed
// it along on a show network without internet.
//
// Nothing here opens a dialog or restarts the app by itself. The host app decides when it is safe (isBusy), and
// "automatic" means: download in the background, install when the operator closes the app.
const { app, net } = require('electron');
const crypto = require('crypto');
// Electron's own fs treats an .asar file as a folder, which breaks copying and deleting an app bundle.
const fs = require('original-fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { PORTABLE_BAT, MAC_SWAP } = require('./update-scripts');

const FEED = process.env.DECKCUE_UPDATE_FEED || 'https://github.com/unilordgr/needit-deck-cue/releases/latest/download/';
const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2uWw+YtE0oyI847gNndaflwPdHB9TEKpdWFneala0n4=\n-----END PUBLIC KEY-----\n';
const LIST = 'update.json';
const MAX_LIST = 64 * 1024;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});

// 0.10.0 is newer than 0.9.3: compare the numbers, not the text.
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Throws unless the list is signed with the release key and looks like a list.
function readList(raw, signature) {
  let ok = false;
  try { ok = crypto.verify(null, raw, PUBLIC_KEY, Buffer.from(String(signature).trim(), 'base64')); } catch { ok = false; }
  if (!ok) throw fail('That update is not signed by needit Creative, so it was not used.', 400);
  let list;
  try { list = JSON.parse(raw.toString('utf8')); } catch { throw fail('The update list could not be read.', 400); }
  if (!list || !/^\d+\.\d+\.\d+$/.test(list.version) || !list.assets || typeof list.assets !== 'object') throw fail('The update list could not be read.', 400);
  return list;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

async function matches(file, info) {
  try {
    if (fs.statSync(file).size !== info.size) return false;
    return (await hashFile(file)) === String(info.sha256).toLowerCase();
  } catch { return false; }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/abort|ENOTFOUND|net::ERR_|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i.test(m)) return 'Could not reach the download server. Check the internet connection.';
  if (/HTTP 404/.test(m)) return 'No update list was found on the download server.';
  return m;
}

// Which build this copy is, and whether it can replace itself.
function installKind(prefix) {
  const source = app.isPackaged ? '' : 'This copy runs from the source code, so it cannot replace itself.';
  if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') return { how: 'none', asset: null, blocked: 'Updates are built for Apple Silicon Macs only.' };
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    let blocked = source;
    if (!blocked && !bundle.endsWith('.app')) blocked = 'The app is not in an app bundle.';
    // macOS runs an app that was opened straight from Downloads out of a hidden read-only copy.
    if (!blocked && bundle.includes('/AppTranslocation/')) blocked = 'Move the app to the Applications folder and open it again. Then it can update itself.';
    if (!blocked) {
      try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { blocked = 'This user may not change the folder the app is in.'; }
    }
    return { how: 'mac', asset: `${prefix}-mac-arm64.zip`, bundle, blocked };
  }
  if (process.platform === 'win32') {
    // The portable build runs from an unpacked temporary copy; this is the file the operator started.
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portable) return { how: 'portable', asset: `${prefix}-Portable.exe`, target: portable, blocked: source };
    return { how: 'installer', asset: `${prefix}-Setup.exe`, blocked: source };
  }
  return { how: 'none', asset: null, blocked: 'Updates are not built for this system.' };
}

function createUpdater({ prefix, getSettings, saveSettings, isBusy, busyReason, onChange }) {
  const kind = installKind(prefix);
  const dir = path.join(app.getPath('userData'), 'updates');
  const st = {
    current: app.getVersion(), how: kind.how, asset: kind.asset, blocked: kind.blocked,
    status: 'idle', // idle | checking | current | available | downloading | ready | installing
    available: null, notes: '', percent: 0, error: '', checkedAt: 0, updatedFrom: null,
  };
  let latest = null;      // the newest signed list seen, even when this copy is already that new
  let list = null;        // the signed list for st.available
  let listRaw = null;
  let listSig = null;
  let packagePath = null; // the verified file for list.version
  let staged = null;      // macOS: the unpacked new app, next to the running one
  let applying = false;
  let working = null;
  let timer = null;

  const view = () => ({
    ...st, settings: { check: getSettings().check !== false, auto: !!getSettings().auto },
    canInstall: !!packagePath && !st.blocked, busy: !!isBusy(), busyWhy: isBusy() ? busyReason() : '', willInstallOnQuit: !!packagePath && !st.blocked && !!getSettings().auto,
  });
  const set = (patch) => { Object.assign(st, patch); try { onChange(view()); } catch { /* the window may be gone */ } };

  async function fetchSmall(name, max) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await net.fetch(FEED + name, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw fail(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) throw fail('The update list is too large.');
      return buf;
    } finally { clearTimeout(t); }
  }

  // Remember a signed list that names a newer version. Returns false when this copy is already that new.
  function adopt(nextList, raw, sig) {
    if (!newer(nextList.version, st.current)) {
      list = null; packagePath = null;
      set({ status: 'current', available: null, notes: '', error: '', checkedAt: Date.now() });
      return false;
    }
    if (!list || list.version !== nextList.version) { packagePath = null; staged = null; }
    list = nextList; listRaw = raw; listSig = sig;
    set({ status: packagePath ? 'ready' : 'available', available: list.version, notes: String(list.notes || ''), error: '', checkedAt: Date.now() });
    return true;
  }

  async function check({ manual = false } = {}) {
    if (working) return working;
    if (!manual && getSettings().check === false) return view();
    if (st.status === 'downloading' || st.status === 'installing') return view();
    working = (async () => {
      const before = st.status;
      set({ status: 'checking', error: '' });
      try {
        const [raw, sig] = await Promise.all([fetchSmall(LIST, MAX_LIST), fetchSmall(`${LIST}.sig`, 2048)]);
        const text = sig.toString('utf8').trim();
        const found = readList(raw, text);
        latest = { list: found, raw, signature: text };
        adopt(found, raw, text);
      } catch (e) {
        // A show computer is often offline: say so only when the operator asked.
        set({ status: packagePath ? 'ready' : list ? 'available' : before === 'current' ? 'current' : 'idle', error: manual ? friendly(e) : '', checkedAt: Date.now() });
      }
      if (st.status === 'available' && getSettings().auto && st.asset && !st.blocked) await download().catch(() => {});
      return view();
    })();
    try { return await working; } finally { working = null; }
  }

  function keep(version) {
    // One version on disk is enough.
    try {
      for (const name of fs.readdirSync(dir)) if (name !== version) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch { /* nothing to tidy */ }
  }

  function remember() {
    // So a restart finds the package again without downloading it.
    try {
      const folder = path.join(dir, list.version);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, LIST), listRaw);
      fs.writeFileSync(path.join(folder, `${LIST}.sig`), listSig);
    } catch { /* it will be downloaded again */ }
  }

  // Download one build named in a signed list into the updates folder and check it against the list.
  async function fetchAsset(from, asset, onProgress) {
    const info = from.assets[asset];
    if (!info) throw fail(`Version ${from.version} has no build called ${asset}.`);
    const dest = path.join(dir, from.version, asset);
    if (await matches(dest, info)) return dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    try {
      // The list names where its own files are, so a release that lands mid-download cannot mix two versions.
      const base = /^https:\/\/github\.com\/unilordgr\/needit-deck-cue\/releases\/download\/v[\d.]+\/$/.test(String(from.base || '')) && !process.env.DECKCUE_UPDATE_FEED ? from.base : FEED;
      const res = await net.fetch(base + asset, { cache: 'no-store' });
      if (!res.ok || !res.body) throw fail(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      const reader = res.body.getReader();
      let got = 0;
      let shown = -5;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > info.size) throw fail('The download is larger than the signed list says.');
        hash.update(value);
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        const pct = Math.floor((got / info.size) * 100);
        if (pct >= shown + 2) { shown = pct; if (onProgress) onProgress(pct); }
      }
      await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
      if (got !== info.size || hash.digest('hex') !== String(info.sha256).toLowerCase()) throw fail('The download does not match the signed list, so it was thrown away.');
      fs.renameSync(part, dest);
      return dest;
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
  }

  async function download() {
    if (!list) throw fail('No newer version is known yet. Check for updates first.');
    if (!st.asset) throw fail(st.blocked || 'There is no build for this computer.');
    if (!list.assets[st.asset]) throw fail(`Version ${list.version} has no build for this computer.`);
    if (st.status === 'downloading') return view();
    if (!packagePath) set({ status: 'downloading', percent: 0, error: '' });
    try {
      packagePath = await fetchAsset(list, st.asset, (pct) => set({ percent: pct }));
      remember(); keep(list.version);
      set({ status: 'ready', percent: 100, error: '' });
      if (getSettings().auto) stage().catch(() => {});
    } catch (e) {
      set({ status: 'available', percent: 0, error: friendly(e) });
      throw e;
    }
    return view();
  }

  // A Command Center passes a package along: the same checks as a download, on a file it already wrote here.
  async function receive({ raw, signature, file }) {
    try {
      const incoming = readList(raw, signature);
      if (!newer(incoming.version, st.current)) throw fail(`This computer already has version ${st.current}.`, 409);
      if (!st.asset) throw fail(st.blocked || 'There is no build for this computer.', 409);
      const info = incoming.assets[st.asset];
      if (!info) throw fail(`Version ${incoming.version} has no build for this computer.`, 409);
      if (!(await matches(file, info))) throw fail('That file does not match the signed list, so it was thrown away.', 400);
      const dest = path.join(dir, incoming.version, st.asset);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(file, dest);
      adopt(incoming, raw, String(signature).trim());
      packagePath = dest;
      remember(); keep(incoming.version);
      set({ status: 'ready', percent: 100, error: '' });
      return view();
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
  }

  // macOS: unpack the new app next to the running one and make sure it is this app, at the version the list names.
  async function stage() {
    if (kind.how !== 'mac' || st.blocked || !packagePath) return null;
    const target = `${kind.bundle}.update`;
    if (staged === target && fs.existsSync(target)) return target;
    const tmp = fs.mkdtempSync(path.join(dir, 'unpack-'));
    try {
      await run('/usr/bin/ditto', ['-x', '-k', packagePath, tmp]);
      const apps = fs.readdirSync(tmp).filter((n) => n.endsWith('.app'));
      if (apps.length !== 1) throw fail('The update package does not hold one app.');
      const unpacked = path.join(tmp, apps[0]);
      const plist = (bundle, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')]).then((s) => s.trim());
      const [mine, theirs, version] = await Promise.all([plist(kind.bundle, 'CFBundleIdentifier'), plist(unpacked, 'CFBundleIdentifier'), plist(unpacked, 'CFBundleShortVersionString')]);
      if (mine !== theirs) throw fail('The update package is a different app.');
      if (version !== list.version) throw fail('The update package is not the version the signed list names.');
      await run('/usr/bin/codesign', ['--verify', '--deep', unpacked]);
      fs.rmSync(target, { recursive: true, force: true });
      await run('/usr/bin/ditto', [unpacked, target]);
      staged = target;
      return target;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // Start the small helper that finishes the job once this process has gone. Must not throw.
  function launchHelper(relaunch) {
    if (applying) return true;
    try {
      if (kind.how === 'mac') {
        if (!staged || !fs.existsSync(staged)) return false;
        const script = path.join(dir, 'swap.sh');
        fs.writeFileSync(script, MAC_SWAP, { mode: 0o700 });
        spawn('/bin/sh', [script, ...process.argv.slice(1).filter((x) => !x.startsWith('--remote-debugging-port'))], {
          detached: true, stdio: 'ignore',
          env: { PATH: '/usr/bin:/bin', APP_PID: String(process.pid), APP_PATH: kind.bundle, STAGE: staged, RELAUNCH: relaunch ? '1' : '0' },
        }).unref();
      } else if (kind.how === 'installer') {
        // The installer made by electron-builder: silent, keep the settings, and start the app again when asked.
        spawn(packagePath, relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'], { detached: true, stdio: 'ignore' }).unref();
      } else if (kind.how === 'portable') {
        const bat = path.join(app.getPath('temp'), `needit-update-${process.pid}.bat`);
        fs.writeFileSync(bat, PORTABLE_BAT, 'ascii');
        spawn('cmd.exe', ['/c', bat], {
          detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, NEW_EXE: packagePath, CUR_EXE: kind.target, RELAUNCH: relaunch ? '1' : '0' },
        }).unref();
      } else return false;
      applying = true;
      return true;
    } catch { return false; }
  }

  // Install now and start again. Refused while the host says a show is running.
  async function install() {
    if (!packagePath) await download();
    if (st.blocked) throw fail(st.blocked, 409);
    if (isBusy()) throw fail(busyReason(), 409);
    set({ status: 'installing', error: '' });
    try {
      await stage();
      if (isBusy()) throw fail(busyReason(), 409);
      if (!launchHelper(true)) throw fail('The update could not be started.');
    } catch (e) {
      set({ status: 'ready', error: friendly(e) });
      throw e;
    }
    setTimeout(() => app.quit(), 600);
    return view();
  }

  // The app is closing: with "install automatically" on, finish a waiting update without starting the app again.
  function onQuit() {
    if (applying || !packagePath || st.blocked || !getSettings().auto) return;
    launchHelper(false);
  }

  function setSettings(patch) {
    const next = {};
    if (typeof patch.check === 'boolean') next.check = patch.check;
    if (typeof patch.auto === 'boolean') next.auto = patch.auto;
    saveSettings(next);
    if (next.auto) {
      if (st.status === 'available') download().catch(() => {});
      else if (st.status === 'ready') stage().catch(() => {});
    }
    set({});
    return view();
  }

  // After a restart: say that an update happened, and pick up a package that was downloaded but not installed.
  async function start() {
    const last = getSettings().lastVersion;
    if (last && last !== st.current && newer(st.current, last)) st.updatedFrom = last;
    if (last !== st.current) saveSettings({ lastVersion: st.current });
    try {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const folder = path.join(dir, name);
        if (!/^\d+\.\d+\.\d+$/.test(name) || !newer(name, st.current)) { fs.rmSync(folder, { recursive: true, force: true }); continue; }
        try {
          const raw = fs.readFileSync(path.join(folder, LIST));
          const sig = fs.readFileSync(path.join(folder, `${LIST}.sig`), 'utf8').trim();
          const found = readList(raw, sig);
          const file = st.asset && path.join(folder, st.asset);
          if (found.version === name && file && found.assets[st.asset] && await matches(file, found.assets[st.asset])) {
            adopt(found, raw, sig); packagePath = file;
            set({ status: 'ready', percent: 100 });
            if (getSettings().auto) stage().catch(() => {});
          } else fs.rmSync(folder, { recursive: true, force: true });
        } catch { fs.rmSync(folder, { recursive: true, force: true }); }
      }
      if (kind.how === 'mac' && kind.bundle && !staged) fs.rmSync(`${kind.bundle}.update`, { recursive: true, force: true });
    } catch { /* a missing folder is fine */ }
    set({});
    setTimeout(() => check().catch(() => {}), 12000);
    timer = setInterval(() => check().catch(() => {}), CHECK_EVERY);
  }

  return {
    start, stop: () => clearInterval(timer), state: view, check, download, receive, install, onQuit, setSettings,
    seen: () => { if (st.updatedFrom) set({ updatedFrom: null }); },
    // For a Command Center that passes its own download along to players without internet.
    latest: () => (latest ? { version: latest.list.version, notes: String(latest.list.notes || ''), assets: Object.keys(latest.list.assets) } : null),
    // Fetch another computer's build (checked against the signed list) and hand back what that computer needs to trust it.
    async packageFor(asset, onProgress) {
      if (!latest) throw fail('No update list has been fetched yet. Check for updates first.');
      const file = await fetchAsset(latest.list, asset, onProgress);
      return { version: latest.list.version, raw: latest.raw, signature: latest.signature, file, size: latest.list.assets[asset].size };
    },
  };
}

module.exports = { createUpdater, readList, newer, hashFile, matches, friendly, FEED };
