import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createBridge } from './bridge';
import { startGuardedApp } from './close-guard';
import { confirmClose, confirmDialog } from './close-dialog';
import { createShellView } from './ui';
import { createVaultController } from './vault-ui';

// Native dirty state starts true and stays true. Only the renderer close guard
// may destroy the window, avoiding asynchronous dirty-report ordering races.
void startGuardedApp({
  document,
  window: getCurrentWindow(),
  confirm: message => confirmClose(document, message),
  initialize: () => {
    const api = createBridge(invoke);
    let controller: ReturnType<typeof createVaultController>;
    const view = createShellView({ document, onOpenVault: () => { void controller.openVault(); } });
    controller = createVaultController({ document, view, api, confirm: (message, options) => confirmDialog(document, message, options!) });
    window.addEventListener('focus', () => { void controller.checkForExternalChange(); });
    return () => controller.getState().dirty || controller.getState().saving;
  },
});
