export interface CloseWindow {
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

/** Tauri does not use Electron's will-prevent-unload guard. */
export async function installCloseGuard(window: CloseWindow, isDirty: () => boolean, confirm: (message: string) => boolean | Promise<boolean>): Promise<() => void> {
  let closing = false;
  return window.onCloseRequested(async event => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      if (isDirty() && (await confirm('Discard the unsaved changes in the current note and close Pumice?')) !== true) return;
      await window.destroy();
    } catch (error) {
      console.error('Close request failed; window kept open', error);
    } finally { closing = false; }
  });
}

/** Do not make the editing workflow available until close protection is active. */
export async function startGuardedApp({ document, window, confirm, initialize }: {
  document: Document;
  window: CloseWindow;
  confirm: (message: string) => boolean | Promise<boolean>;
  initialize: () => () => boolean;
}): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="open-vault-button"]');
  const status = document.querySelector<HTMLElement>('[data-testid="status-text"]');
  if (!button || !status) throw new Error('shell markup is missing startup controls');
  button.disabled = true;
  let isDirty = () => false;
  try {
    await installCloseGuard(window, () => isDirty(), confirm);
    isDirty = initialize();
    button.disabled = false;
  } catch (error) {
    status.textContent = 'Close guard unavailable — editing disabled. Restart Pumice.';
    status.dataset.state = 'error';
    console.error('Could not start protected editor', error);
  }
}
