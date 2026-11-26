'use strict';

// Sandboxed preload scripts cannot require arbitrary local modules, so this
// file is intentionally self-contained. Keep the exposed surface small:
// no ipcRenderer, no Node primitives, no arbitrary channel access.
const { contextBridge, ipcRenderer } = require('electron');

const MENU_ACTIONS = Object.freeze(['open-vault', 'about']);

function requireNotePath(notePath) {
  if (typeof notePath !== 'string' || notePath.trim() === '') {
    throw new TypeError('note path must be a non-empty string');
  }
  return notePath;
}

function requireExpectedVersion(expectedVersion) {
  if (expectedVersion !== null && typeof expectedVersion !== 'string') {
    throw new TypeError('expectedVersion must be a string or null');
  }
  return expectedVersion;
}

function createPreloadApi(bridge) {
  return Object.freeze({
    getAppInfo() {
      return bridge.invoke('shell:get-app-info');
    },

    notifyReady() {
      bridge.send('shell:renderer-ready');
    },

    onMenuAction(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('onMenuAction requires a callback function');
      }
      const listener = (_event, action) => {
        if (typeof action === 'string' && MENU_ACTIONS.includes(action)) callback(action);
      };
      bridge.on('shell:menu-action', listener);
      return () => bridge.removeListener('shell:menu-action', listener);
    },

    // Vault file access. The main process decides which folder is open; the
    // renderer can only name paths inside it (the vault core rejects escapes).
    openVault() {
      return bridge.invoke('vault:open');
    },

    listNotes() {
      return bridge.invoke('vault:list');
    },

    readNote(notePath) {
      return bridge.invoke('vault:read', requireNotePath(notePath));
    },

    statNote(notePath) {
      return bridge.invoke('vault:stat', requireNotePath(notePath));
    },

    writeNote(notePath, content, expectedVersion = null) {
      requireNotePath(notePath);
      if (typeof content !== 'string') throw new TypeError('note content must be a string');
      requireExpectedVersion(expectedVersion);
      return bridge.invoke('vault:write', {
        path: notePath,
        content,
        expectedVersion,
      });
    },
  });
}

contextBridge.exposeInMainWorld('pumice', createPreloadApi(ipcRenderer));

// Exposed for the Node test harness that executes this file in a VM. Electron's
// sandboxed preload environment may not define `module` at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPreloadApi, MENU_ACTIONS };
}
