'use strict';

/**
 * Electron application lifecycle, written against an app-like EventEmitter so
 * platform behaviour can be tested without a display or a real app instance.
 */
function installLifecycle({ app, platform = process.platform, createWindow, getWindow, focusWindow }) {
  if (!app || typeof app.on !== 'function') {
    throw new TypeError('an app emitter is required');
  }

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (getWindow()) focusWindow();
    else createWindow();
  });

  app.on('second-instance', () => {
    if (getWindow()) focusWindow();
  });
}

/**
 * Only one Pumice process may own the shell. A losing process quits right away
 * so it never creates a second window or touches a vault concurrently.
 */
function acquireSingleInstanceLock(app) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') {
    throw new TypeError('an app with requestSingleInstanceLock is required');
  }

  const acquired = app.requestSingleInstanceLock();
  if (!acquired) app.quit();
  return acquired;
}

module.exports = { acquireSingleInstanceLock, installLifecycle };
