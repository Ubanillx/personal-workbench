const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { JsonRepository } = require('./repositories/json-repository');
const { createWindow } = require('./desktop/window');
const { registerIpc } = require('./desktop/ipc');
const { getLanIp, startHttpServer } = require('./server/http-server');

const rootDir = __dirname;
const repository = new JsonRepository(path.join(rootDir, 'data'));
let win = null;

function notifyChanged(reason) {
  if (win && !win.isDestroyed()) win.webContents.send('db:changed', { reason });
}

registerIpc({
  ipcMain,
  dialog,
  shell,
  repository,
  getWindow: () => win,
  getLanIp,
  notifyChanged
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await repository.ensureApiToken();
    win = createWindow(BrowserWindow, rootDir);
    startHttpServer({
      rootDir,
      repository,
      notifyChanged,
      port: 17500
    });
  });

  app.on('window-all-closed', () => app.quit());
}
