// needit Deck Cue and needit Command Center
// Copyright (C) 2026 needit Creative (https://needitcreative.com)
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version. It comes with no warranty. See LICENSE.

// An error that nothing caught must never stop a show. Electron's default is an error box that blocks the whole
// app, remote control included, until someone clicks it. Write the error down and carry on.
function noteError(kind, e) {
  try {
    const { app } = require('electron');
    const line = `${new Date().toISOString()} ${kind}: ${(e && e.stack) || e}\n`;
    console.error(line);
    require('fs').appendFileSync(require('path').join(app.getPath('userData'), 'errors.log'), line);
  } catch { /* nowhere to write it */ }
}
process.on('uncaughtException', (e) => noteError('uncaught exception', e));
process.on('unhandledRejection', (e) => noteError('unhandled rejection', e));

// One codebase, two apps. The packaged Command Center has deckcueMode "center" in its package.json
// (see builder-center.json); in development start it with: electron . --center
const pkg = require('../package.json');

const center = pkg.deckcueMode === 'center' || process.argv.includes('--center');
require(center ? './center/main' : './main');
