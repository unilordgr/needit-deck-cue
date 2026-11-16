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
  about: invoke('about:get'),
  aboutOpen: invoke('about:open'),
  prefs: invoke('prefs:get'),
  setPrefs: invoke('prefs:set'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args)),
});
