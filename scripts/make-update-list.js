// Writes the signed update list for a release.
//
//   node scripts/make-update-list.js <folder with the builds> [version]
//
// It lists every build in the folder with its size and SHA-256 in update.json, and signs that file with the
// release key (the UPDATE_SIGNING_KEY environment variable, a PEM private key) into update.json.sig.
// The apps only install a build that this list names and whose signature they can check (see src/update.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const folder = process.argv[2];
const version = process.argv[3] || require('../package.json').version;
if (!folder || !fs.existsSync(folder)) { console.error('Give the folder that holds the builds.'); process.exit(1); }
const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem || !pem.includes('PRIVATE KEY')) { console.error('UPDATE_SIGNING_KEY is not set: refusing to publish an unsigned update list.'); process.exit(1); }

const assets = {};
for (const name of fs.readdirSync(folder).sort()) {
  const file = path.join(folder, name);
  if (name.startsWith('update.json') || !fs.statSync(file).isFile()) continue;
  assets[name] = { size: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
if (!Object.keys(assets).length) { console.error('No builds found in that folder.'); process.exit(1); }

const list = {
  version,
  date: new Date().toISOString().slice(0, 10),
  base: process.env.UPDATE_BASE || `https://github.com/unilordgr/needit-deck-cue/releases/download/v${version}/`,
  notes: process.env.UPDATE_NOTES || '',
  assets,
};
const raw = Buffer.from(`${JSON.stringify(list, null, 2)}\n`);
fs.writeFileSync(path.join(folder, 'update.json'), raw);
fs.writeFileSync(path.join(folder, 'update.json.sig'), `${crypto.sign(null, raw, crypto.createPrivateKey(pem)).toString('base64')}\n`);
console.log(`update.json for ${version}: ${Object.keys(assets).length} builds, signed.`);
