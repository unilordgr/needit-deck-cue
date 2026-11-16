// The part of the player's API that a Command Center uses: who am I, receive presentation files into the
// project folder, and add / replace / reorder / change / delete cues. Off unless the operator of this
// player allows it; an optional network key must then match (header X-DeckCue-Key).
//
//   GET  /api/info                         name, id, platform, whether it accepts a Command Center
//   PUT  /api/files/<name>                 body = the file; saved into the project folder
//   POST /api/cues                         { file, index?, label?, autoSlideshow? }  add a cue for a received file
//   POST /api/cue/<ref>/file               { file }                    point a cue at a received file
//   POST /api/cue/<ref>/update             { label, autoSlideshow, startSlide, duration, notes, color, output }
//   POST /api/cue/<ref>/move?to=<n>        new position, 1-based
//   POST /api/cue/<ref>/delete
//   POST /api/timerscreen/config           { idle, livePip, title, showClock }
//   POST /api/timer/presets                { presets: [{ name, minutes }] }   the saved timers
const fs = require('fs');
const path = require('path');

const MAX_JSON = 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024 * 1024;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function createManage({ getConfig, extensions, actions }) {
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_JSON) { reject(fail(413, 'Request too large')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(fail(400, 'Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // File names only: no folders, no hidden files, presentation types only.
  function safeName(raw) {
    const name = path.basename(String(raw).replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
    if (!name || name.startsWith('.')) throw fail(400, 'Invalid file name');
    if (!extensions.includes(path.extname(name).toLowerCase())) throw fail(415, `Not a presentation file: ${name}`);
    return name;
  }

  function received(name) {
    const file = path.join(getConfig().folder, safeName(name));
    if (!fs.existsSync(file)) throw fail(404, `${name} has not been sent to this computer yet`);
    return file;
  }

  function saveFile(req, name) {
    const { folder } = getConfig();
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, name);
    const part = path.join(folder, `.${name}.${process.pid}.part`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      let size = 0;
      const abort = (err) => { out.destroy(); fs.rm(part, { force: true }, () => {}); reject(err); };
      req.on('data', (c) => { size += c.length; if (size > MAX_FILE) { req.destroy(); abort(fail(413, 'File too large')); } });
      req.on('error', abort);
      req.on('aborted', () => abort(fail(400, 'Upload interrupted')));
      out.on('error', (e) => abort(fail(500, `Could not write the file: ${e.message}`)));
      out.on('finish', () => {
        fs.rename(part, target, (err) => {
          if (err) {
            fs.rm(part, { force: true }, () => {});
            // On Windows a deck that is open in PowerPoint can't be replaced.
            return reject(fail(409, `${name} is in use on that computer. Stop its cue, then send it again.`));
          }
          resolve({ name, path: target, size });
        });
      });
      req.pipe(out);
    });
  }

  // Returns true when the request was one of ours (and has been answered).
  function handle(req, res, url, send) {
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts[0] !== 'api') return false;
    const [, a, b, c] = parts;
    const cfg = getConfig();
    const keyOk = !cfg.key || req.headers['x-deckcue-key'] === cfg.key;

    if (req.method === 'GET' && a === 'info' && !b) {
      send(res, 200, { ...actions.info(), manage: !!cfg.accept, keyRequired: !!cfg.key, keyOk });
      return true;
    }
    const isFile = req.method === 'PUT' && a === 'files' && b && !c;
    const isCueAdd = req.method === 'POST' && a === 'cues' && !b;
    const isCueEdit = req.method === 'POST' && a === 'cue' && b && ['file', 'update', 'move', 'delete'].includes(c);
    const isTimerCfg = req.method === 'POST' && a === 'timerscreen' && b === 'config' && !c;
    const isPresets = req.method === 'POST' && a === 'timer' && b === 'presets' && !c;
    if (!isFile && !isCueAdd && !isCueEdit && !isTimerCfg && !isPresets) return false;

    const answer = (work) => {
      Promise.resolve().then(work).then((r) => send(res, 200, { ok: true, ...(r || {}) }))
        .catch((e) => send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 400, { ok: false, error: e.message }));
    };
    if (!cfg.accept) { req.resume(); send(res, 403, { ok: false, error: 'This computer does not accept a Command Center. Turn it on in its Settings.' }); return true; }
    if (!keyOk) { req.resume(); send(res, 401, { ok: false, error: 'Wrong network key.' }); return true; }

    if (isFile) answer(async () => saveFile(req, safeName(decodeURIComponent(b))));
    else if (isCueAdd) answer(async () => { const body = await readJson(req); return actions.addCue({ ...body, file: received(body.file) }); });
    else if (isTimerCfg) answer(async () => actions.timerScreenConfig(await readJson(req)));
    else if (isPresets) answer(async () => actions.setTimerPresets(await readJson(req)));
    else {
      const ref = decodeURIComponent(b);
      if (c === 'file') answer(async () => { const body = await readJson(req); return actions.setCueFile(ref, received(body.file)); });
      else if (c === 'update') answer(async () => actions.updateCue(ref, await readJson(req)));
      else if (c === 'move') answer(() => { req.resume(); return actions.moveCue(ref, Number(url.searchParams.get('to'))); });
      else answer(() => { req.resume(); return actions.deleteCue(ref); });
    }
    return true;
  }

  return { handle };
}

module.exports = { createManage };
