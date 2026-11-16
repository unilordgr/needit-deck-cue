// needit Deck Cue and needit Command Center
// Copyright (C) 2026 needit Creative (https://needitcreative.com)
// Free software under the GNU General Public License, version 3 or later. See LICENSE.
//
// Who made the apps and where to find them. Shared by both apps.
const { app, shell, ipcMain } = require('electron');

const MAKER = 'needit Creative';
const SITE = 'needitcreative.com';
// The windows can only ask for one of these by name, never for an address of their own.
const LINKS = {
  site: `https://${SITE}`,
  repo: 'https://github.com/unilordgr/needit-deck-cue',
  license: 'https://github.com/unilordgr/needit-deck-cue/blob/main/LICENSE',
};

function setupAbout(appName) {
  app.setAboutPanelOptions({
    applicationName: appName,
    applicationVersion: app.getVersion(),
    copyright: `Created by ${MAKER} · ${SITE}\nFree and open source (GPL-3.0).`,
    website: LINKS.site,
  });
  ipcMain.handle('about:get', () => ({ name: appName, version: app.getVersion(), maker: MAKER, site: SITE }));
  ipcMain.handle('about:open', (_e, which) => { if (Object.hasOwn(LINKS, which)) shell.openExternal(LINKS[which]); });
}

module.exports = { setupAbout, MAKER, SITE, LINKS };
