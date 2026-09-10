const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  readDb: () => ipcRenderer.invoke('db:read'),
  writeDb: (db) => ipcRenderer.invoke('db:write', db),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('showInFolder', p),
  pickFiles: () => ipcRenderer.invoke('pickFiles'),
  getLanIp: () => ipcRenderer.invoke('lan-ip'),
  onChanged: (cb) => ipcRenderer.on('db:changed', (_e, info) => cb(info))
});
