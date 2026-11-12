// First-slide thumbnails for cues. macOS: Quick Look renders any deck or PDF (no Office needed).
// Elsewhere: the preview picture PowerPoint stores in a .pptx, or pdf.js for PDFs.
// Cached on disk by file path, size and modification time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { openZip } = require('./preflight/zip');

const WIDTH = 360;

function createThumbnailer({ cacheDir, probePdf }) {
  fs.mkdirSync(cacheDir, { recursive: true });

  function keyFor(file, st) {
    return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex');
  }

  function quickLook(file) {
    return new Promise((resolve) => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'deckcue-ql-'));
      execFile('qlmanage', ['-t', '-s', String(WIDTH), '-o', out, file], { timeout: 20000 }, () => {
        const png = path.join(out, `${path.basename(file)}.png`);
        let buf = null;
        try { buf = fs.readFileSync(png); } catch { /* no preview available */ }
        fs.rmSync(out, { recursive: true, force: true });
        resolve(buf ? `data:image/png;base64,${buf.toString('base64')}` : null);
      });
    });
  }

  async function generate(file) {
    const ext = path.extname(file).toLowerCase();
    if (process.platform === 'darwin') {
      const ql = await quickLook(file);
      if (ql) return ql;
    }
    if (ext === '.pdf') {
      const r = await probePdf(file, WIDTH);
      return r && r.thumb ? r.thumb : null;
    }
    if (['.pptx', '.ppsx', '.potx', '.pptm', '.ppsm'].includes(ext)) {
      try {
        const zip = openZip(file);
        try {
          const jpg = zip.readBuffer('docProps/thumbnail.jpeg');
          return jpg ? `data:image/jpeg;base64,${jpg.toString('base64')}` : null;
        } finally { zip.close(); }
      } catch { return null; }
    }
    return null;
  }

  // Returns a data: URL, or null when no preview can be made.
  async function thumbnail(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const cached = path.join(cacheDir, `${keyFor(file, st)}.txt`);
    try { return fs.readFileSync(cached, 'utf8') || null; } catch { /* not cached yet */ }
    const url = await generate(file).catch(() => null);
    try { fs.writeFileSync(cached, url || ''); } catch { /* cache is optional */ }
    return url;
  }

  return { thumbnail };
}

module.exports = { createThumbnailer };
