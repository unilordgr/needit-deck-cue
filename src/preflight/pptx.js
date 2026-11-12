// Reads what a show operator needs to know from a .pptx/.ppsx/.potx: slide size, slide count, hidden
// slides, fonts used and embedded, and embedded or linked video/audio.
const fs = require('fs');
const path = require('path');
const { openZip } = require('./zip');

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};
const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tags = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) || [];

// Fonts named in text runs and styles. Theme references (+mj-lt, +mn-ea …) are resolved separately.
function collectFonts(xml, into) {
  for (const t of xml.match(/<a:(latin|ea|cs|sym)\b[^>]*>/g) || []) {
    const face = attr(t, 'typeface');
    if (face && !face.startsWith('+')) into.add(face);
  }
}

function themeFonts(xml) {
  const out = [];
  for (const block of ['majorFont', 'minorFont']) {
    const m = new RegExp(`<a:${block}>([\\s\\S]*?)</a:${block}>`).exec(xml);
    if (!m) continue;
    // Only the default Latin and East Asian faces; per-script <a:font> entries are used only for those scripts.
    for (const kind of ['latin', 'ea']) {
      const t = new RegExp(`<a:${kind}\\b[^>]*>`).exec(m[1]);
      const face = t && attr(t[0], 'typeface');
      if (face) out.push(face);
    }
  }
  return out;
}

const MEDIA_REL = /\/(video|audio|media)$/;

function resolveTarget(partDir, target) {
  return path.posix.normalize(path.posix.join(partDir, target));
}

function analyzePptx(file) {
  const zip = openZip(file);
  try {
    const names = [...zip.entries.keys()];
    const pres = zip.read('ppt/presentation.xml') || '';
    const sz = tags(pres, 'p:sldSz')[0];
    const width = sz ? Number(attr(sz, 'cx')) : null;
    const height = sz ? Number(attr(sz, 'cy')) : null;
    const slideCount = tags(pres, 'p:sldId').length;
    const embeddedFonts = tags(pres, 'p:font').map((t) => attr(t, 'typeface')).filter(Boolean);

    const fonts = new Set();
    let hidden = 0;
    const media = new Map(); // key -> { name, ext, linked, target, exists }
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const parts = names.filter((n) => /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(n));
    for (const part of parts) {
      const xml = zip.read(part) || '';
      collectFonts(xml, fonts);
      if (slides.includes(part) && /<p:sld\b[^>]*\bshow="(0|false)"/.test(xml)) hidden++;
      const rels = zip.read(part.replace(/([^/]+)$/, '_rels/$1.rels')) || '';
      for (const r of tags(rels, 'Relationship')) {
        const type = attr(r, 'Type') || '';
        if (!MEDIA_REL.test(type)) continue;
        const target = attr(r, 'Target') || '';
        const linked = attr(r, 'TargetMode') === 'External';
        if (linked) {
          let p = target;
          if (/^file:/i.test(p)) {
            try { p = decodeURIComponent(new URL(p).pathname); } catch { /* keep raw */ }
            if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          } else if (!/^https?:/i.test(p) && !path.isAbsolute(p)) {
            p = path.resolve(path.dirname(file), p);
          }
          const web = /^https?:/i.test(target);
          media.set(`link:${target}`, { name: path.basename(p), ext: path.extname(p).toLowerCase(), linked: true, web, target: p, exists: web ? null : fs.existsSync(p) });
        } else {
          const inZip = resolveTarget(path.posix.dirname(part), target);
          media.set(inZip, { name: path.posix.basename(inZip), ext: path.extname(inZip).toLowerCase(), linked: false, exists: zip.entries.has(inZip) });
        }
      }
    }
    // Theme fonts of the slide masters' themes.
    for (const master of names.filter((n) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(n))) {
      const rels = zip.read(master.replace(/([^/]+)$/, '_rels/$1.rels')) || '';
      for (const r of tags(rels, 'Relationship')) {
        if (!/\/theme$/.test(attr(r, 'Type') || '')) continue;
        const theme = zip.read(resolveTarget('ppt/slideMasters', attr(r, 'Target')));
        if (theme) themeFonts(theme).forEach((f) => fonts.add(f));
      }
    }
    return {
      kind: 'pptx',
      width, height, slideCount, hidden,
      fonts: [...fonts].sort(),
      embeddedFonts,
      media: [...media.values()],
    };
  } finally {
    zip.close();
  }
}

// Old binary .ppt, and encrypted (password-protected) Office files, are OLE compound files.
function isCompoundFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    return b.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { analyzePptx, isCompoundFile };
