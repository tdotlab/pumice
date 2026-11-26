'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { parseArgs } = require('./cli.js');
const { acquireSingleInstanceLock, installLifecycle } = require('./lifecycle.js');
const { registerIpcHandlers } = require('./ipc.js');
const { buildMenuTemplate } = require('./menu.js');
const { runSmokeTest } = require('./smoke.js');
const { loadShellWindow } = require('./window.js');

const args = parseArgs(process.argv);
const isDev = !app.isPackaged;
let mainWindow = null;

app.setName('Pumice');

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function focusMainWindow() {
  const window = getMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createMainWindow() {
  const existing = getMainWindow();
  if (existing) return existing;

  mainWindow = loadShellWindow({
    BrowserWindow,
    preloadPath: path.join(__dirname, '..', 'preload', 'preload.js'),
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function handleMenuAction(action) {
  if (action === 'about') {
    dialog.showMessageBox({
      type: 'info',
      title: 'About Pumice',
      message: `Pumice ${app.getVersion()}`,
      detail: 'A lightweight desktop shell for plain-Markdown vaults.\n\nVault storage is provided by the vault module.',
    });
    return;
  }

  const window = getMainWindow();
  if (window) window.webContents.send('shell:menu-action', action);
}

if (args.smokeTest) {
  // The smoke run never needs compositing; this also keeps it friendlier to
  // minimal CI displays.
  app.disableHardwareAcceleration();
}

if (!acquireSingleInstanceLock(app)) {
  // A second process lost the single-instance lock and has already asked to
  // quit. Do not build a menu, window or IPC surface.
} else {
  installLifecycle({
    app,
    platform: process.platform,
    createWindow: createMainWindow,
    getWindow: getMainWindow,
    focusWindow: focusMainWindow,
  });

  registerIpcHandlers({
    ipcMain,
    app,
    isDev,
    onRendererReady: () => {},
  });

  app
    .whenReady()
    .then(() => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildMenuTemplate({ appName: 'Pumice', isDev, onAction: handleMenuAction }),
        ),
      );

      const window = createMainWindow();
      if (args.devTools) window.webContents.openDevTools({ mode: 'detach' });
      if (args.smokeTest) runSmokeTest({ app, window });
    })
    .catch((error) => {
      console.error('Pumice failed to start:', error);
      app.exit(1);
    });
}
