const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('center', {
  platform: process.platform,
  nodes: invoke('nodes:get'),
  action: invoke('node:action'),
  send: invoke('node:send'),
  copyShow: invoke('node:copyShow'),
  add: invoke('node:add'),
  remove: invoke('node:remove'),
  pickFiles: invoke('files:pick'),
  checkFile: invoke('files:check'),
  fileInfo: invoke('files:info'),
  about: invoke('about:get'),
  update: invoke('update:get'),
  latest: invoke('update:latest'),
  updateSet: invoke('update:set'),
  updateCheck: invoke('update:check'),
  updateInstall: invoke('update:install'),
  updateSeen: invoke('update:seen'),
  updateNode: invoke('node:update'),
  aboutOpen: invoke('about:open'),
  prefs: invoke('prefs:get'),
  setPrefs: invoke('prefs:set'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args)),
});
