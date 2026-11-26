'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { parseArgs } = require('./cli.js');
const { installCloseGuard } = require('./close-guard.js');
const { acquireSingleInstanceLock, installLifecycle } = require('./lifecycle.js');
const { registerIpcHandlers } = require('./ipc.js');
const { buildMenuTemplate } = require('./menu.js');
const { runSmokeTest } = require('./smoke.js');
const { copyFixtureVault } = require('./smoke-vault.js');
const { registerVaultIpcHandlers } = require('./vault-ipc.js');
const { VaultSession } = require('./vault-session.js');
const { loadShellWindow } = require('./window.js');

const args = parseArgs(process.argv);
const isDev = !app.isPackaged;
const vaultSession = new VaultSession();
let mainWindow = null;
let smokeVault = null;

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
  // The renderer cancels beforeunload while dirty; ask before discarding.
  installCloseGuard({ window: mainWindow, dialog });
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
      detail:
        'A lightweight desktop notes app for plain-Markdown vaults.\n\n' +
        'Vault files are read and written atomically by the main process.',
    });
    return;
  }

  const window = getMainWindow();
  if (window) window.webContents.send('shell:menu-action', action);
}

/**
 * Folder picker for the renderer's Open vault action. The smoke run substitutes
 * a copied fixture vault so the whole workflow can run without a human.
 */
async function chooseVaultDirectory() {
  if (args.smokeTest) {
    if (!smokeVault) throw new Error('smoke vault has not been prepared yet');
    return smokeVault.root;
  }

  const options = {
    title: 'Open Markdown vault',
    buttonLabel: 'Open vault',
    properties: ['openDirectory'],
  };
  const window = getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) return null;
  if (!Array.isArray(result.filePaths) || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

function cleanupSmokeVault() {
  if (!smokeVault) return;
  try {
    smokeVault.cleanup();
  } finally {
    smokeVault = null;
  }
}

app.on('will-quit', cleanupSmokeVault);

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

  registerVaultIpcHandlers({
    ipcMain,
    session: vaultSession,
    chooseDirectory: chooseVaultDirectory,
  });

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildMenuTemplate({ appName: 'Pumice', isDev, onAction: handleMenuAction }),
        ),
      );

      if (args.smokeTest) {
        smokeVault = await copyFixtureVault();
        await vaultSession.open(smokeVault.root);
      }

      const window = createMainWindow();
      if (args.devTools) window.webContents.openDevTools({ mode: 'detach' });
      if (args.smokeTest) {
        runSmokeTest({
          app,
          window,
          vaultRoot: smokeVault.root,
          beforeExit: cleanupSmokeVault,
        });
      }
    })
    .catch((error) => {
      console.error('Pumice failed to start:', error);
      cleanupSmokeVault();
      app.exit(1);
    });
}
