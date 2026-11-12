const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getShow: invoke('show:get'),
  updateShow: invoke('show:update'),
  fileCmd: invoke('show:file'),
  displays: invoke('displays:list'),
  identify: invoke('displays:identify'),
  fire: invoke('cue:fire'),
  arm: invoke('cue:arm'),
  go: invoke('cue:go'),
  stop: invoke('cue:stop'),
  nav: invoke('cue:nav'),
  blackout: invoke('blackout:toggle'),
  clearMessage: invoke('message:clear'),
  fileStatus: invoke('files:status'),
  resolveFiles: invoke('files:resolve'),
  pickFile: invoke('files:pick'),
  reveal: invoke('files:reveal'),
  env: invoke('env:status'),
  controlGet: invoke('control:get'),
  timerCmd: invoke('timer:cmd'),
  preflightRun: invoke('preflight:run'),
  thumbsGet: invoke('thumbs:get'),
  versionUse: invoke('version:use'),
  versionIgnore: invoke('version:ignore'),
  versionClear: invoke('version:clear'),
  showModeSet: invoke('showmode:set'),
  showModeReadiness: invoke('showmode:readiness'),
  showModeQuitApps: invoke('showmode:quitApps'),
  showModeConfig: invoke('showmode:config'),
  openShortcuts: invoke('showmode:openShortcuts'),
  syncGet: invoke('sync:get'),
  syncSet: invoke('sync:set'),
  syncPull: invoke('sync:pull'),
  stageMessage: invoke('stage:message'),
  openStage: invoke('stage:open'),
  controlSet: invoke('control:set'),
  requestAccessibility: invoke('env:requestAccessibility'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => {
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
