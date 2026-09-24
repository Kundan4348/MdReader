// Preload: the only bridge between the renderer and the file system.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mdreader', {
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, text, hint) => ipcRenderer.invoke('write-file', p, text, hint),
  listDir: (dir) => ipcRenderer.invoke('list-dir', dir),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  getPref: (k) => ipcRenderer.invoke('get-pref', k),
  setPref: (k, v) => ipcRenderer.invoke('set-pref', k, v),
  displayPath: (p) => ipcRenderer.invoke('display-path', p),
  setDirty: (d) => ipcRenderer.send('dirty', d),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  closeWindow: () => ipcRenderer.send('close-window'),
  reveal: (p) => ipcRenderer.send('reveal', p),
  openPath: (p) => ipcRenderer.send('open-path', p),
  statPath: (p) => ipcRenderer.invoke('stat-path', p),
  tabsChanged: (state) => ipcRenderer.send('tabs', state),
  confirmDiscard: (name) => ipcRenderer.invoke('confirm-discard', name),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, p) => cb(p)),
  onExternalChange: (cb) => ipcRenderer.on('external-change', (e, p) => cb(p)),
  onCmd: (cb) => ipcRenderer.on('cmd', (e, c) => cb(c)),
  pathForFile: (f) => webUtils.getPathForFile(f),
  home: ipcRenderer.sendSync('get-home'),
  platform: process.platform,
});
