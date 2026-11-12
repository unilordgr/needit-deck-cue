const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probe', {
  onRequest: (fn) => ipcRenderer.on('probe:request', (_e, req) => fn(req)),
  reply: (res) => ipcRenderer.send('probe:reply', res),
});
