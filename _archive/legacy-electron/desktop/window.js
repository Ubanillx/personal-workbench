const path = require('path');

function createWindow(BrowserWindow, rootDir) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: '个人工作台',
    icon: path.join(rootDir, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(rootDir, 'renderer', 'index.html'));
  return win;
}

module.exports = { createWindow };
