/**
 * Renderer view model for the Pumice shell.
 *
 * This module owns only the shell chrome: vault title, file list placeholder,
 * status line and the Open vault affordance. It never reads or writes files.
 * The vault module will call `setVault()` with a view model it has built.
 */

export const EMPTY_VAULT_TITLE = 'No vault open';
const DEFAULT_EMPTY_LIST_NOTE = 'Open a vault to see its Markdown files.';
const EMPTY_VAULT_NOTE = 'No Markdown files found.';

function requireElement(document, testId) {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`shell markup is missing [data-testid="${testId}"]`);
  return element;
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function fileNameFor(file) {
  const name = asNonEmptyString(file?.name);
  if (name) return name;
  const filePath = asNonEmptyString(file?.path);
  if (filePath) {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  }
  return 'Untitled';
}

export function createShellView({ document, onOpenVault = () => {} } = {}) {
  if (!document) throw new TypeError('document is required');
  if (typeof onOpenVault !== 'function') throw new TypeError('onOpenVault must be a function');

  const elements = {
    vaultTitle: requireElement(document, 'vault-title'),
    openButton: requireElement(document, 'open-vault-button'),
    fileList: requireElement(document, 'file-list'),
    fileListEmpty: requireElement(document, 'file-list-empty'),
    fileItems: requireElement(document, 'file-items'),
    documentTitle: requireElement(document, 'document-title'),
    statusText: requireElement(document, 'status-text'),
  };

  let destroyed = false;

  const handleOpen = () => {
    if (!destroyed) onOpenVault();
  };
  elements.openButton.addEventListener('click', handleOpen);

  function setStatus(message, state = 'ready') {
    const text = asNonEmptyString(message) ?? 'Ready';
    elements.statusText.textContent = text;
    elements.statusText.dataset.state = state;
  }

  function clearFiles() {
    elements.fileItems.replaceChildren();
  }

  function renderFiles(files) {
    clearFiles();
    if (files.length === 0) {
      elements.fileListEmpty.textContent = EMPTY_VAULT_NOTE;
      elements.fileListEmpty.hidden = false;
      return;
    }

    elements.fileListEmpty.hidden = true;
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const item = document.createElement('li');
      item.className = 'file-item';
      item.dataset.path = asNonEmptyString(file?.path) ?? '';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = fileNameFor(file);

      item.append(name);
      fragment.append(item);
    }
    elements.fileItems.append(fragment);
  }

  /**
   * @param {{name: string, files?: Array<{name?: string, path?: string}>} | null} vault
   */
  function setVault(vault) {
    if (vault === null || vault === undefined) {
      elements.vaultTitle.textContent = EMPTY_VAULT_TITLE;
      elements.fileList.hidden = true;
      elements.fileListEmpty.textContent = DEFAULT_EMPTY_LIST_NOTE;
      elements.fileListEmpty.hidden = false;
      clearFiles();
      setStatus('Ready');
      return;
    }

    const name = asNonEmptyString(vault.name) ?? 'Untitled vault';
    const files = Array.isArray(vault.files) ? vault.files.filter(Boolean) : [];

    elements.vaultTitle.textContent = name;
    elements.fileList.hidden = false;
    renderFiles(files);

    const count = files.length === 1 ? '1 note' : `${files.length} notes`;
    setStatus(`${name} · ${count}`);
  }

  function handleMenuAction(action) {
    if (action === 'open-vault') {
      handleOpen();
      return true;
    }
    return false;
  }

  function getState() {
    return {
      vault: elements.vaultTitle.textContent,
      fileCount: elements.fileItems.children.length,
      status: elements.statusText.textContent,
      statusState: elements.statusText.dataset.state,
    };
  }

  function destroy() {
    destroyed = true;
    elements.openButton.removeEventListener('click', handleOpen);
  }

  return { destroy, getState, handleMenuAction, setStatus, setVault };
}
