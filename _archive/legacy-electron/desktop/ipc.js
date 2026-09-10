function registerIpc({ ipcMain, dialog, shell, repository, getWindow, getLanIp, notifyChanged }) {
  ipcMain.handle('db:read', () => repository.read());

  ipcMain.handle('db:write', async (_event, db) => {
    try {
      await repository.write(db);
      notifyChanged('desktop');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('openPath', async (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false };
    const error = await shell.openPath(filePath);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('showInFolder', (_event, filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return { ok: false };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle('pickFiles', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择要固定的文件',
      properties: ['openFile', 'multiSelections']
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('lan-ip', () => getLanIp());
}

module.exports = { registerIpc };
