// Version management: notices when a cue's file changes on disk, and when a newer version of it appears
// in the same folder ("Keynote_v7.pptx" -> "Keynote_v8.pptx", "Talk FINAL.pptx" -> "Talk FINAL 2.pptx").
// Polls (rather than file-system events) so it also works on network shares and USB drives.
const fs = require('fs');
const path = require('path');

// Trailing version markers, stripped repeatedly to find a file's "stem". A bare number is not one:
// "Session_1.pptx" and "Session_2.pptx", or "Day 2" and "Day 3", are different talks.
const VERSION_TAIL = /[\s._-]*(v(?:ersion)?\s*\d+(?:\.\d+)*|rev(?:ision)?\s*\d+|final(?:\s*\d+)?|latest|updated|new|copy(?:\s*\d+)?|\(\d+\))$/i;

function stem(file) {
  let s = path.basename(file).replace(/\.[^.]+$/, '');
  for (let i = 0; i < 6; i++) {
    const next = s.replace(VERSION_TAIL, '');
    if (next === s || !next.trim()) break;
    s = next;
  }
  return s.trim().toLowerCase();
}

const FAMILY = { '.pptx': 'ppt', '.ppt': 'ppt', '.pptm': 'ppt', '.ppsx': 'ppt', '.pps': 'ppt', '.ppsm': 'ppt', '.potx': 'ppt', '.pot': 'ppt', '.dps': 'ppt', '.key': 'key', '.pdf': 'pdf' };
const family = (file) => FAMILY[path.extname(file).toLowerCase()] || null;

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function createVersionWatcher({ getCues, onChange, intervalMs = 3000 }) {
  const records = new Map(); // cueId -> { path, mtime, size, changedAt, newer, ignored:Set }
  let timer = null;

  function scan() {
    const cues = getCues();
    const folders = new Map(); // dir -> [{ name, path, mtime }]
    const listFolder = (dir) => {
      if (!folders.has(dir)) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* folder gone */ }
        folders.set(dir, entries.filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$')).map((e) => {
          const full = path.join(dir, e.name);
          const st = statSafe(full);
          return st ? { name: e.name, path: full, mtime: st.mtimeMs } : null;
        }).filter(Boolean));
      }
      return folders.get(dir);
    };

    let changed = false;
    const seen = new Set();
    // A file that a cue already plays is that cue's presentation, never a "newer version" of another one.
    const inUse = new Set(cues.map((c) => c.file && c.file.path).filter(Boolean));
    for (const cue of cues) {
      const p = cue.file && cue.file.path;
      if (!p) continue;
      seen.add(cue.id);
      const st = statSafe(p);
      let rec = records.get(cue.id);
      if (!rec || rec.path !== p) {
        // First sight of this file (or the cue now points elsewhere): remember it, nothing to report yet.
        rec = { path: p, mtime: st ? st.mtimeMs : null, size: st ? st.size : null, changedAt: null, newer: null, ignored: rec && rec.path === p ? rec.ignored : new Set() };
        records.set(cue.id, rec);
        changed = true;
      } else if (st && (st.mtimeMs !== rec.mtime || st.size !== rec.size)) {
        rec.mtime = st.mtimeMs;
        rec.size = st.size;
        rec.changedAt = Date.now();
        changed = true;
      }
      // Newer file with the same stem and type in the same folder.
      const fam = family(p);
      const s = stem(p);
      const mine = st ? st.mtimeMs : 0;
      let best = null;
      if (fam) {
        for (const f of listFolder(path.dirname(p))) {
          if (f.path === p || inUse.has(f.path) || family(f.name) !== fam || stem(f.name) !== s || f.mtime <= mine || rec.ignored.has(f.path)) continue;
          if (!best || f.mtime > best.mtime) best = f;
        }
      }
      const prev = rec.newer ? rec.newer.path : null;
      if ((best ? best.path : null) !== prev) {
        rec.newer = best ? { path: best.path, name: best.name, mtime: best.mtime } : null;
        changed = true;
      }
    }
    for (const id of [...records.keys()]) if (!seen.has(id)) { records.delete(id); changed = true; }
    if (changed) onChange(snapshot());
  }

  function snapshot() {
    const out = {};
    for (const [id, r] of records) if (r.changedAt || r.newer) out[id] = { changedAt: r.changedAt, newer: r.newer };
    return out;
  }

  return {
    start() { if (!timer) { timer = setInterval(scan, intervalMs); scan(); } },
    // Report what is known again (the setting for newer versions changed).
    refresh() { onChange(snapshot()); },
    stop() { clearInterval(timer); timer = null; },
    scan,
    // The cue was (re)loaded or the operator saw the change: clear the UPDATED mark.
    clearChanged(cueId) {
      const r = records.get(cueId);
      if (r && r.changedAt) { r.changedAt = null; onChange(snapshot()); }
    },
    ignoreNewer(cueId) {
      const r = records.get(cueId);
      if (r && r.newer) { r.ignored.add(r.newer.path); r.newer = null; onChange(snapshot()); }
    },
    newerFor(cueId) {
      const r = records.get(cueId);
      return r && r.newer ? r.newer : null;
    },
  };
}

module.exports = { createVersionWatcher, stem };
