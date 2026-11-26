import { createShellView } from './ui.mjs';

// Collected for the Electron smoke run. Keep this list small and text-only.
window.__pumiceErrors = [];
window.addEventListener('error', (event) => {
  window.__pumiceErrors.push(String(event.message ?? 'unknown renderer error'));
});
window.addEventListener('unhandledrejection', (event) => {
  window.__pumiceErrors.push(String(event.reason ?? 'unhandled renderer rejection'));
});

const api = window.pumice;

const view = createShellView({
  document,
  onOpenVault: () => {
    // The vault module will listen for this request and own folder selection
    // plus file access. The shell only relays the user's intent.
    document.dispatchEvent(
      new CustomEvent('pumice:open-vault-requested', { bubbles: true }),
    );
  },
});

window.pumiceShell = view;

document.dispatchEvent(new CustomEvent('pumice:shell-ready', { detail: { view } }));

const versionElement = document.querySelector('[data-testid="app-version"]');
if (api && typeof api.getAppInfo === 'function') {
  api
    .getAppInfo()
    .then((info) => {
      if (info?.version) versionElement.textContent = `v${info.version}`;
    })
    .catch(() => {
      // Version display is cosmetic; a failure must not break the shell.
    });

  if (typeof api.onMenuAction === 'function') {
    api.onMenuAction((action) => view.handleMenuAction(action));
  }

  if (typeof api.notifyReady === 'function') api.notifyReady();
}
