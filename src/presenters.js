// Platform-independent layer over the presentation apps: file types, app choice, and the built-in
// PDF player. The app-specific control lives in a driver per platform (src/drivers/*.js), each exporting
// { APPS, PPT_APP_PREFERENCE, isInstalled, needsAccessibility, fire, stop, nav, close }.
const path = require('path');
const { shell } = require('electron');
const pdfPlayer = require('./pdfPlayer');

const driver = process.platform === 'win32' ? require('./drivers/win') : require('./drivers/mac');

const APPS = {
  ...driver.APPS,
  // Built into Deck Cue (src/pdfPlayer.js); always available.
  pdf: { builtin: true, name: 'Built-in PDF player', short: 'PDF' },
};

const PPT_EXT = ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.ppsm', '.pot', '.potx', '.dps'];
const KEY_EXT = ['.key'];
const PDF_EXT = ['.pdf'];
const SUPPORTED_EXT = [...PPT_EXT, ...(APPS.keynote ? KEY_EXT : []), ...PDF_EXT];

function isInstalled(app) {
  if (!APPS[app]) return false;
  return APPS[app].builtin ? true : driver.isInstalled(app);
}

function installedApps() {
  return Object.keys(APPS).filter(isInstalled);
}

// The app .ppt/.pptx files open with: the show's preference, else the first installed one.
function pptApp(preferred) {
  if (APPS[preferred] && !APPS[preferred].builtin && isInstalled(preferred)) return preferred;
  return driver.PPT_APP_PREFERENCE.find(isInstalled) || driver.PPT_APP_PREFERENCE[0];
}

function appFor(choice, file, preferredPptApp) {
  const ext = path.extname(file).toLowerCase();
  if (PDF_EXT.includes(ext)) return 'pdf';
  if (APPS[choice] && choice !== 'pdf') return choice;
  if (KEY_EXT.includes(ext) && APPS.keynote) return 'keynote';
  return pptApp(preferredPptApp);
}

const needsAccessibility = (app, routed) => (app === 'pdf' ? false : driver.needsAccessibility(app, routed));

async function fire(app, opts) {
  if (!isInstalled(app)) throw new Error(`${APPS[app] ? APPS[app].name : app} is not installed`);
  if (app === 'pdf') {
    if (!opts.auto) {
      const err = await shell.openPath(opts.file);
      if (err) throw new Error(err);
      return 'opened';
    }
    return pdfPlayer.show(opts.file, { startPage: opts.startSlide, bounds: opts.bounds });
  }
  return driver.fire(app, opts);
}

function stop(app) {
  if (app === 'pdf') return Promise.resolve(pdfPlayer.stop());
  if (!isInstalled(app)) return Promise.resolve();
  return driver.stop(app);
}

function nav(app, dir) {
  if (app === 'pdf') return Promise.resolve(pdfPlayer.nav(dir));
  return driver.nav(app, dir);
}

function close(app, file) {
  if (app === 'pdf') return Promise.resolve(pdfPlayer.close(file));
  if (!isInstalled(app)) return Promise.resolve();
  return driver.close(app, file);
}

module.exports = { pdfPlayer, APPS, SUPPORTED_EXT, isInstalled, installedApps, pptApp, appFor, needsAccessibility, fire, stop, nav, close };
