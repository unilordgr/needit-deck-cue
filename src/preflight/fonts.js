// Lists the font names available to the presentation apps on this computer, by reading the name table of
// every font file in the system and user font folders, plus fonts bundled inside PowerPoint and WPS
// (those apps can use them even though the system can't). Names are lower-cased for matching.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc']);

function fontDirs() {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
      // Fonts installed by WPS Office for Windows.
      path.join(process.env.LOCALAPPDATA || '', 'Kingsoft', 'WPS Office'),
    ];
  }
  return [
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts'),
    '/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts',
    '/Applications/wpsoffice.app/Contents',
    '/Applications/WPS Office.app/Contents',
    '/Applications/Keynote.app/Contents/Resources',
    // Fonts downloaded on demand through Font Book.
    ...(() => {
      try {
        return fs.readdirSync('/System/Library/AssetsV2').filter((d) => d.startsWith('com_apple_MobileAsset_Font')).map((d) => path.join('/System/Library/AssetsV2', d));
      } catch { return []; }
    })(),
  ];
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return n === length ? buf : buf.subarray(0, n);
}

// Names from one font (sfnt) starting at `base`: family (1), full name (4), PostScript (6), typographic family (16).
function sfntNames(fd, base) {
  const head = readAt(fd, base, 12);
  if (head.length < 12) return [];
  const numTables = head.readUInt16BE(4);
  const dir = readAt(fd, base + 12, numTables * 16);
  for (let i = 0; i < numTables; i++) {
    if (dir.toString('latin1', i * 16, i * 16 + 4) !== 'name') continue;
    const offset = dir.readUInt32BE(i * 16 + 8);
    const length = dir.readUInt32BE(i * 16 + 12);
    const t = readAt(fd, offset, Math.min(length, 512 * 1024));
    const count = t.readUInt16BE(2);
    const strings = t.readUInt16BE(4);
    const names = [];
    for (let r = 0; r < count; r++) {
      const rec = 6 + r * 12;
      if (rec + 12 > t.length) break;
      const platform = t.readUInt16BE(rec);
      const nameId = t.readUInt16BE(rec + 6);
      if (![1, 4, 6, 16].includes(nameId)) continue;
      const len = t.readUInt16BE(rec + 8);
      const off = strings + t.readUInt16BE(rec + 10);
      if (off + len > t.length) continue;
      const raw = t.subarray(off, off + len);
      if (platform === 3 || platform === 0) {
        // UTF-16BE
        const le = Buffer.alloc(raw.length);
        for (let k = 0; k + 1 < raw.length; k += 2) { le[k] = raw[k + 1]; le[k + 1] = raw[k]; }
        names.push(le.toString('utf16le'));
      } else if (platform === 1) {
        names.push(raw.toString('latin1'));
      }
    }
    return names;
  }
  return [];
}

function fileNames(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const tag = readAt(fd, 0, 12);
    if (tag.toString('latin1', 0, 4) === 'ttcf') {
      const n = tag.readUInt32BE(8);
      const offsets = readAt(fd, 12, n * 4);
      const out = [];
      for (let i = 0; i < n; i++) out.push(...sfntNames(fd, offsets.readUInt32BE(i * 4)));
      return out;
    }
    return sfntNames(fd, 0);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walk(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, out);
    else if (FONT_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

let cache = null;

// Returns a Set of lower-cased font names. Scans once (a second or two) and then answers from memory.
function installedFonts() {
  if (cache) return cache;
  const files = [];
  for (const d of fontDirs()) walk(d, 6, files);
  const names = new Set();
  for (const f of files) for (const n of fileNames(f)) if (n) names.add(n.trim().toLowerCase());
  cache = names;
  return cache;
}

function refreshFonts() {
  cache = null;
}

module.exports = { installedFonts, refreshFonts };
