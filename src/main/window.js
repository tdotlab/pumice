'use strict';

const path = require('node:path');

const WINDOW_DEFAULTS = Object.freeze({
  width: 1180,
  height: 780,
  minWidth: 760,
  minHeight: 480,
  backgroundColor: '#f6f4ef',
  title: 'Pumice',
});

/**
 * Build the BrowserWindow options for the shell. Pure so the security
 * posture and layout floor can be asserted without launching Electron.
 */
function buildWindowOptions({ preloadPath } = {}) {
  if (typeof preloadPath !== 'string' || !path.isAbsolute(preloadPath)) {
    throw new TypeError('preloadPath must be an absolute path');
  }

  return {
    ...WINDOW_DEFAULTS,
    show: false,
    useContentSize: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
    },
  };
}

/**
 * Create and load the one shell window. The vault module will add its own
 * views inside this window rather than creating additional top-level windows.
 */
function loadShellWindow({ BrowserWindow, preloadPath }) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('BrowserWindow constructor is required');
  }

  const window = new BrowserWindow(buildWindowOptions({ preloadPath }));
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return window;
}

module.exports = { WINDOW_DEFAULTS, buildWindowOptions, loadShellWindow };
