const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  onCommand: (fn) => ipcRenderer.on('pdf:cmd', (_e, cmd) => fn(cmd)),
  status: (s) => ipcRenderer.send('pdf:status', s),
  stop: () => ipcRenderer.send('pdf:stop'),
});
