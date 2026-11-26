'use strict';

/**
 * Dirty-close guard.
 *
 * The renderer cancels `beforeunload` while the editor has unsaved changes
 * (src/renderer/vault-ui.mjs). Electron turns that into a `will-prevent-unload`
 * event on the window's webContents; this module owns the dialog and decides
 * whether the unload may proceed. Nothing is written to disk here: the user
 * either keeps editing or explicitly discards the draft.
 *
 * Calling `event.preventDefault()` allows the unload (the user chose to
 * discard). Leaving the event alone keeps the window — and the draft — open.
 * A dialog failure keeps the window open too: losing typed work is worse than
 * a close that needs a second attempt.
 */

const CLOSE_DIALOG = Object.freeze({
  type: 'warning',
  buttons: ['Keep editing', 'Discard changes and close'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
  title: 'Unsaved changes',
  message: 'Close Pumice with unsaved changes?',
  detail:
    'The note in the editor has changes that have not been saved. ' +
    'Closing now discards them permanently.',
});

const DISCARD_RESPONSE = 1;

function installCloseGuard({ window, dialog } = {}) {
  if (!window || !window.webContents || typeof window.webContents.on !== 'function') {
    throw new TypeError('a BrowserWindow with webContents is required');
  }
  if (!dialog || typeof dialog.showMessageBoxSync !== 'function') {
    throw new TypeError('a dialog with showMessageBoxSync is required');
  }

  const onWillPreventUnload = (event) => {
    let response = CLOSE_DIALOG.cancelId;
    try {
      response = dialog.showMessageBoxSync(window, CLOSE_DIALOG);
    } catch {
      // Keep the window (and the draft) open when the dialog cannot be shown.
      response = CLOSE_DIALOG.cancelId;
    }
    if (response === DISCARD_RESPONSE && event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  };

  window.webContents.on('will-prevent-unload', onWillPreventUnload);

  return {
    dialogOptions: CLOSE_DIALOG,
    dispose() {
      if (typeof window.webContents.removeListener === 'function') {
        window.webContents.removeListener('will-prevent-unload', onWillPreventUnload);
      }
    },
  };
}

module.exports = { CLOSE_DIALOG, installCloseGuard };
