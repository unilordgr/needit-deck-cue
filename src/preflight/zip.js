// Minimal zip reader for Office files: lists entries and inflates the ones asked for, without reading the
// rest of the file (decks can carry gigabytes of video).
const fs = require('fs');
const zlib = require('zlib');

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

function openZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66000);
    const tail = readAt(fd, size - tailLen, tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory locator
      const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
      if (loc < 0) throw new Error('unsupported zip64 file');
      const rec = readAt(fd, Number(tail.readBigUInt64LE(loc + 8)), 56);
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // ZIP64 sizes/offset live in the extra field
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); }
        }
        e += 4 + len;
      }
      entries.set(name, { name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      size,
      entries,
      // Text of one entry (XML), or null when missing. Large entries are refused.
      read(name, maxBytes = 20 * 1024 * 1024) {
        const ent = entries.get(name);
        if (!ent || ent.uncompSize > maxBytes) return null;
        const lh = readAt(fd, ent.localOffset, 30);
        const dataStart = ent.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const raw = readAt(fd, dataStart, ent.compSize);
        const data = ent.method === 8 ? zlib.inflateRawSync(raw) : raw;
        return data.toString('utf8');
      },
      close() { fs.closeSync(fd); },
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

module.exports = { openZip };
