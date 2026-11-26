'use strict';

const MENU_ACTIONS = Object.freeze(['open-vault', 'about']);

function isMenuAction(value) {
  return typeof value === 'string' && MENU_ACTIONS.includes(value);
}

/**
 * The shell owns exactly two IPC channels for now. Vault file access will be
 * added by the vault module under its own namespace, not through this one.
 */
function registerIpcHandlers({
  ipcMain,
  app,
  onRendererReady = () => {},
  versions = process.versions,
  platform = process.platform,
  isDev = false,
} = {}) {
  if (!ipcMain) throw new TypeError('ipcMain is required');

  ipcMain.handle('shell:get-app-info', () => ({
    name: 'Pumice',
    version: app.getVersion(),
    electron: versions.electron ?? null,
    platform,
    isDev,
  }));

  ipcMain.on('shell:renderer-ready', (event) => {
    onRendererReady(event);
  });
}

module.exports = { MENU_ACTIONS, isMenuAction, registerIpcHandlers };
