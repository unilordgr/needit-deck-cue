// The part of the player's API that a Command Center uses: who am I, receive presentation files into the
// project folder, and add / replace / reorder / change / delete cues. Off unless the operator of this
// player allows it; an optional network key must then match (header X-DeckCue-Key).
//
//   GET  /api/info                         name, id, platform, whether it accepts a Command Center
//   POST /api/files/check                  { name }  is a file with that name already here, and which cues use it
//   PUT  /api/files/<name>                 body = the file; saved into the project folder. A file with that name
//                                          (capitals do not matter) is replaced and goes to the Trash.
//   POST /api/cues                         { file, index?, label?, autoSlideshow? }  add a cue for a received file
//   POST /api/cue/<ref>/file               { file }                    point a cue at a received file
//   POST /api/cue/<ref>/update             { label, autoSlideshow, startSlide, duration, notes, color, output }
//   POST /api/cue/<ref>/move?to=<n>        new position, 1-based
//   POST /api/cue/<ref>/delete
//   POST /api/cues/clear                   empty the list (refused while something is live)
//   GET  /api/cue/<ref>/download           the cue's file, to copy this list to another computer
//   POST /api/timerscreen/config           { idle, livePip, title, showClock, pip: { x, y, h, bg, content } }
//   PUT  /api/card/<name>                  body = an image; it becomes this computer's event card
//   POST /api/card/clear                   take the event card away
//   GET  /api/card                         the event card's image, to copy a show to another computer
//   POST /api/output                       { output: 'auto' | 'window' | <screen id from /api/state outputs> }
//   POST /api/timer/presets                { presets: [{ name, minutes }] }   the saved timers
//   POST /api/update/install               update this computer now (refused while a show runs); answers at once
//   PUT  /api/update/package/<file>        body = the build; headers X-Update-List (base64 of update.json) and
//                                          X-Update-Signature. Only used when the signature and the file check out.
const fs = require('fs');
const path = require('path');

const MAX_JSON = 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024 * 1024;
const MAX_UPDATE = 1024 * 1024 * 1024;
const MAX_CARD = 64 * 1024 * 1024;

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

  // The event card is an image, not a presentation.
  function safeImage(raw) {
    const name = path.basename(String(raw).replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
    if (!name || name.startsWith('.')) throw fail(400, 'Invalid file name');
    if (!actions.cardExtensions.includes(path.extname(name).toLowerCase())) throw fail(415, `The event card must be an image (PNG or JPG): ${name}`);
    return name;
  }

  function received(name) {
    const safe = safeName(name);
    const existing = actions.nameInFolder(safe);
    if (!existing) throw fail(404, `${name} has not been sent to this computer yet`);
    return path.join(getConfig().folder, existing);
  }

  function saveFile(req, name, max = MAX_FILE) {
    const { folder } = getConfig();
    fs.mkdirSync(folder, { recursive: true });
    // "deck.pptx" must not become a second file beside "Deck.pptx", nor silently overwrite it.
    const existing = actions.nameInFolder(name);
    const target = path.join(folder, existing || name);
    const part = path.join(folder, `.${name}.${process.pid}.part`);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      let size = 0;
      const abort = (err) => { out.destroy(); fs.rm(part, { force: true }, () => {}); reject(err); };
      req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); abort(fail(413, 'File too large')); } });
      req.on('error', abort);
      req.on('aborted', () => abort(fail(400, 'Upload interrupted')));
      out.on('error', (e) => abort(fail(500, `Could not write the file: ${e.message}`)));
      out.on('finish', async () => {
        if (size === 0) { fs.rm(part, { force: true }, () => {}); return reject(fail(400, `${name} is empty (0 bytes), so it was not added.`)); }
        if (existing) await actions.trash(target); // the version it replaces can be brought back from the Trash
        fs.rename(part, target, (err) => {
          if (err) {
            fs.rm(part, { force: true }, () => {});
            // On Windows a deck that is open in PowerPoint can't be replaced.
            return reject(fail(409, `${name} is in use on that computer. Stop its cue, then send it again.`));
          }
          // Keep the file's own date (the sender passes it on). Otherwise every copy looks brand new, and a
          // newer version sent later would be called "older" than the copy it replaces.
          const date = Number(req.headers['x-file-date']);
          if (Number.isFinite(date) && date > 0) { try { fs.utimesSync(target, date / 1000, date / 1000); } catch { /* the date is a nicety */ } }
          resolve({ name: path.basename(target), path: target, size, replaced: !!existing });
        });
      });
      req.pipe(out);
    });
  }

  // An update package from a Command Center goes to a temporary file first; update.js decides whether to trust it.
  function saveUpdate(req, target) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      let size = 0;
      const abort = (err) => { out.destroy(); fs.rm(target, { force: true }, () => {}); reject(err); };
      req.on('data', (c) => { size += c.length; if (size > MAX_UPDATE) { req.destroy(); abort(fail(413, 'Update package too large')); } });
      req.on('error', abort);
      req.on('aborted', () => abort(fail(400, 'Upload interrupted')));
      out.on('error', (e) => abort(fail(500, `Could not write the update: ${e.message}`)));
      out.on('finish', () => resolve(target));
      req.pipe(out);
    });
  }

  // Returns true when the request was one of ours (and has been answered).
  function handle(req, res, url, send) {
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts[0] !== 'api') return false;
    const [, a, b, c] = parts;
    const cfg = getConfig();
    // The key travels percent-encoded, so it may hold any letters (Greek too); a plain one is still accepted.
    const sent = req.headers['x-deckcue-key'];
    const keyOk = !cfg.key || sent === cfg.key || sent === encodeURIComponent(cfg.key);

    if (req.method === 'GET' && a === 'info' && !b) {
      send(res, 200, { ...actions.info(), manage: !!cfg.accept, keyRequired: !!cfg.key, keyOk });
      return true;
    }
    const isFile = req.method === 'PUT' && a === 'files' && b && !c;
    const isFileCheck = req.method === 'POST' && a === 'files' && b === 'check' && !c;
    const isCueAdd = req.method === 'POST' && a === 'cues' && !b;
    const isClear = req.method === 'POST' && a === 'cues' && b === 'clear' && !c;
    const isDownload = req.method === 'GET' && a === 'cue' && b && c === 'download';
    const isCueEdit = req.method === 'POST' && a === 'cue' && b && ['file', 'update', 'move', 'delete'].includes(c);
    const isTimerCfg = req.method === 'POST' && a === 'timerscreen' && b === 'config' && !c;
    const isPresets = req.method === 'POST' && a === 'timer' && b === 'presets' && !c;
    const isCard = req.method === 'PUT' && a === 'card' && b && !c;
    const isCardClear = req.method === 'POST' && a === 'card' && b === 'clear' && !c;
    const isCardGet = req.method === 'GET' && a === 'card' && !b;
    const isOutput = req.method === 'POST' && a === 'output' && !b;
    const isUpdateInstall = req.method === 'POST' && a === 'update' && b === 'install' && !c;
    const isUpdatePackage = req.method === 'PUT' && a === 'update' && b === 'package' && c && parts.length === 4;
    if (!isFile && !isFileCheck && !isCueAdd && !isCueEdit && !isTimerCfg && !isPresets && !isClear && !isDownload && !isUpdateInstall && !isUpdatePackage && !isCard && !isCardClear && !isCardGet && !isOutput) return false;

    const answer = (work) => {
      Promise.resolve().then(work).then((r) => send(res, 200, { ok: true, ...(r || {}) }))
        .catch((e) => send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 400, { ok: false, error: e.message, ...(e.extra || {}) }));
    };
    if (!cfg.accept) { req.resume(); send(res, 403, { ok: false, error: 'This computer does not accept a Command Center. Turn it on in its Settings.' }); return true; }
    if (!keyOk) { req.resume(); send(res, 401, { ok: false, error: 'Wrong network key.' }); return true; }

    if (isCard) { answer(async () => { const saved = await saveFile(req, safeImage(decodeURIComponent(b)), MAX_CARD); return actions.setCard(saved.path); }); return true; }
    if (isCardClear) { answer(() => { req.resume(); return actions.setCard(''); }); return true; }
    if (isOutput) { answer(async () => actions.setOutput(await readJson(req))); return true; }
    if (isDownload || isCardGet) {
      try {
        const file = isCardGet ? actions.cardPath() : actions.cuePath(decodeURIComponent(b));
        const st = fs.statSync(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-File-Name': encodeURIComponent(path.basename(file)), 'X-File-Date': String(Math.round(st.mtimeMs)) });
        fs.createReadStream(file).pipe(res);
      } catch (e) { send(res, e.code && e.code >= 400 ? e.code : 400, { ok: false, error: e.message }); }
      return true;
    }
    if (isUpdateInstall) { answer(() => { req.resume(); return actions.updateInstall(); }); return true; }
    if (isUpdatePackage) {
      answer(async () => {
        const name = decodeURIComponent(c);
        if (name !== actions.updateAsset()) { req.resume(); throw fail(409, `This computer needs ${actions.updateAsset() || 'no update package'}, not ${name}.`); }
        let raw;
        try { raw = Buffer.from(String(req.headers['x-update-list'] || ''), 'base64'); } catch { raw = Buffer.alloc(0); }
        const signature = String(req.headers['x-update-signature'] || '');
        if (!raw.length || !signature) { req.resume(); throw fail(400, 'The signed update list is missing.'); }
        const file = await saveUpdate(req, actions.updateTempFile());
        return actions.updateReceive({ raw, signature, file });
      });
      return true;
    }
    if (isFileCheck) { answer(async () => { const body = await readJson(req); return actions.fileCheck(safeName(body.name)); }); return true; }
    if (isClear) answer(() => { req.resume(); return actions.clearCues(); });
    else if (isFile) answer(async () => saveFile(req, safeName(decodeURIComponent(b))));
    else if (isCueAdd) answer(async () => {
      const body = await readJson(req);
      // missing: true keeps a place in the list for a cue whose file is not there (copying a list from another computer).
      const file = body.missing ? path.join(getConfig().folder, safeName(body.file)) : received(body.file);
      return actions.addCue({ ...body, file });
    });
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
