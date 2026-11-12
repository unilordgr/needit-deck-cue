// Minimal OSC 1.0 codec: messages and bundles with int32 (i), float32 (f), string (s), T/F/N args.

function pad4(n) {
  return (n + 3) & ~3;
}

function readString(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0) throw new Error('Unterminated OSC string');
  return [buf.toString('utf8', off, end), off + pad4(end - off + 1)];
}

function decodeMessage(buf, off, end, out) {
  let address;
  [address, off] = readString(buf, off);
  if (address === '#bundle') {
    off += 8; // timetag (bundles are executed immediately)
    while (off + 4 <= end) {
      const size = buf.readInt32BE(off);
      off += 4;
      decodeMessage(buf, off, off + size, out);
      off += size;
    }
    return;
  }
  const args = [];
  if (off < end && buf[off] === 0x2c) {
    let tags;
    [tags, off] = readString(buf, off);
    for (const t of tags.slice(1)) {
      if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
      else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
      else if (t === 's') { let s; [s, off] = readString(buf, off); args.push(s); }
      else if (t === 'T') args.push(true);
      else if (t === 'F') args.push(false);
      else if (t === 'N') args.push(null);
      else throw new Error(`Unsupported OSC type tag ${t}`);
    }
  }
  out.push({ address, args });
}

function decode(buf) {
  const out = [];
  decodeMessage(buf, 0, buf.length, out);
  return out;
}

function encodeString(s) {
  const raw = Buffer.from(`${s}\0`, 'utf8');
  const b = Buffer.alloc(pad4(raw.length));
  raw.copy(b);
  return b;
}

function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; parts.push(encodeString(a)); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b); }
    else if (typeof a === 'number') { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); }
    else if (a === true) tags += 'T';
    else if (a === false) tags += 'F';
    else tags += 'N';
  }
  return Buffer.concat([encodeString(address), encodeString(tags), ...parts]);
}

module.exports = { decode, encode };
