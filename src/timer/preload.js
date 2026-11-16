const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timerScreen', {
  onState: (fn) => ipcRenderer.on('timerscreen:state', (_e, s) => fn(s)),
  dismiss: () => ipcRenderer.send('timerscreen:dismiss'),
});
