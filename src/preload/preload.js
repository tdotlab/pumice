'use strict';

// Sandboxed preload scripts cannot require arbitrary local modules, so this
// file is intentionally self-contained. Keep the exposed surface small:
// no ipcRenderer, no Node primitives, no arbitrary channel access.
const { contextBridge, ipcRenderer } = require('electron');

const MENU_ACTIONS = Object.freeze(['open-vault', 'about']);

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
  });
}

contextBridge.exposeInMainWorld('pumice', createPreloadApi(ipcRenderer));

// Exposed for the Node test harness that executes this file in a VM. Electron's
// sandboxed preload environment may not define `module` at all.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createPreloadApi, MENU_ACTIONS };
}
