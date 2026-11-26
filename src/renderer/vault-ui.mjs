/**
 * Renderer controller for the first Pumice editing workflow.
 *
 * Responsibilities:
 *  - ask the main process to open a vault, then render its Markdown files
 *  - load a note into the textarea and mark it dirty while the text differs
 *  - save through the vault API with the version the note was read at
 *  - never clobber a note another program changed: a save conflict keeps the
 *    draft in the editor and offers an explicit reload or overwrite
 *  - notice external edits when the window regains focus
 *
 * All filesystem work stays in the main process. This module only talks to
 * `window.pumice` (injected here as `api`) and to the shell view.
 */

const EMPTY_TITLE = 'Nothing open';
const DIRTY_LABEL = 'Unsaved changes';

function requireElement(document, testId) {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`shell markup is missing [data-testid="${testId}"]`);
  return element;
}

export function createVaultController({ document, api, view, confirm = () => true } = {}) {
  if (!document) throw new TypeError('document is required');
  if (!view || typeof view.setVault !== 'function' || typeof view.setStatus !== 'function') {
    throw new TypeError('view must be the shell view');
  }
  if (!api || typeof api.openVault !== 'function' || typeof api.writeNote !== 'function') {
    throw new TypeError('api must expose the vault bridge');
  }
  if (typeof confirm !== 'function') throw new TypeError('confirm must be a function');

  const elements = {
    fileItems: requireElement(document, 'file-items'),
    textarea: requireElement(document, 'note-editor'),
    editorEmpty: requireElement(document, 'editor-empty'),
    documentTitle: requireElement(document, 'document-title'),
    saveButton: requireElement(document, 'save-note-button'),
    reloadButton: requireElement(document, 'reload-note-button'),
    dirtyBadge: requireElement(document, 'note-dirty'),
    banner: requireElement(document, 'editor-banner'),
    bannerText: requireElement(document, 'editor-banner-text'),
    bannerReload: requireElement(document, 'banner-reload-button'),
    bannerOverwrite: requireElement(document, 'banner-overwrite-button'),
  };

  const state = {
    vault: null,
    note: null,
    dirty: false,
    saving: false,
    externalChange: false,
  };
  let destroyed = false;

  // ---- presentation helpers -------------------------------------------------

  function setStatus(message, statusState = 'ready') {
    if (!destroyed) view.setStatus(message, statusState);
  }

  function showBanner(message, { reload = false, overwrite = false } = {}) {
    elements.bannerText.textContent = message;
    elements.bannerReload.hidden = !reload;
    elements.bannerOverwrite.hidden = !overwrite;
    elements.banner.hidden = false;
  }

  function hideBanner() {
    elements.banner.hidden = true;
    elements.bannerText.textContent = '';
    elements.bannerReload.hidden = false;
    elements.bannerOverwrite.hidden = true;
  }

  function updateButtons() {
    elements.saveButton.disabled = !(state.note && state.dirty) || state.saving;
    elements.reloadButton.disabled = !state.note || state.saving;
  }

  function setDirty(dirty, { updateStatus = true } = {}) {
    state.dirty = dirty;
    elements.dirtyBadge.hidden = !dirty;
    elements.dirtyBadge.textContent = DIRTY_LABEL;
    updateButtons();
    if (updateStatus && state.note) {
      if (dirty) setStatus('Unsaved changes', 'warning');
      else setStatus(`Editing ${state.note.path}`, 'ready');
    }
  }

  function markActive(relPath) {
    for (const item of elements.fileItems.querySelectorAll('li.file-item')) {
      const active = item.dataset.path === relPath;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  }

  function resetEditor() {
    state.note = null;
    state.externalChange = false;
    elements.textarea.value = '';
    elements.textarea.hidden = true;
    elements.editorEmpty.hidden = false;
    elements.documentTitle.textContent = EMPTY_TITLE;
    hideBanner();
    markActive(null);
    setDirty(false, { updateStatus: false });
    updateButtons();
  }

  function applyNote(note) {
    state.note = {
      path: note.path,
      name: note.name ?? note.path,
      content: typeof note.content === 'string' ? note.content : '',
      version: note.version,
      size: note.size,
      mtimeMs: note.mtimeMs,
    };
    state.externalChange = false;
    elements.textarea.value = state.note.content;
    elements.textarea.hidden = false;
    elements.editorEmpty.hidden = true;
    elements.documentTitle.textContent = note.path;
    hideBanner();
    markActive(note.path);
    setDirty(false, { updateStatus: false });
    updateButtons();
  }

  function errorMessage(result, fallback) {
    return result?.error?.message ?? result?.error?.code ?? fallback;
  }

  async function callApi(fn, ...args) {
    try {
      return await fn(...args);
    } catch (error) {
      return { ok: false, error: { code: 'BRIDGE_ERROR', message: error?.message ?? String(error) } };
    }
  }

  function confirmDiscardIfDirty() {
    if (!state.dirty) return true;
    try {
      return confirm('Discard the unsaved changes in the current note?') !== false;
    } catch {
      return false;
    }
  }

  // ---- the workflow ---------------------------------------------------------

  async function openVault() {
    if (!confirmDiscardIfDirty()) {
      setStatus('Save or discard the current note before opening another vault.', 'warning');
      return { ok: false, canceled: true };
    }

    const result = await callApi(api.openVault);
    if (!result?.ok) {
      if (result?.canceled) return result;
      showBanner(`Could not open the vault: ${errorMessage(result, 'unknown error')}`, {});
      setStatus(`Could not open vault: ${errorMessage(result, 'unknown error')}`, 'error');
      return result;
    }

    state.vault = result.vault;
    view.setVault({
      name: result.vault.name,
      files: Array.isArray(result.vault.files) ? result.vault.files : [],
    });
    resetEditor();

    const count = Array.isArray(result.vault.files) ? result.vault.files.length : 0;
    const noun = count === 1 ? 'note' : 'notes';
    setStatus(`Opened ${result.vault.name} · ${count} ${noun}`, 'ready');
    return result;
  }

  async function loadNoteFromDisk(notePath, { quiet = false } = {}) {
    const result = await callApi(api.readNote, notePath);
    if (!result?.ok) {
      showBanner(`Could not open ${notePath}: ${errorMessage(result, 'unknown error')}`, {});
      setStatus('Could not open note', 'error');
      return result;
    }
    applyNote(result.note);
    if (!quiet) setStatus(`Editing ${notePath}`, 'ready');
    return result;
  }

  async function openNote(notePath) {
    if (destroyed) return;
    if (typeof notePath !== 'string' || notePath.trim() === '') return;
    if (state.note && state.note.path === notePath) return;
    if (!confirmDiscardIfDirty()) {
      setStatus('Save or discard the current note before switching notes.', 'warning');
      return { ok: false, canceled: true };
    }
    return loadNoteFromDisk(notePath);
  }

  async function save({ force = false } = {}) {
    if (destroyed || !state.note || state.saving) return { ok: false, ignored: true };

    const { path: notePath, version } = state.note;
    const content = elements.textarea.value;
    const expectedVersion = force ? null : version;

    state.saving = true;
    updateButtons();

    const result = await callApi(api.writeNote, notePath, content, expectedVersion);
    state.saving = false;

    if (result?.ok) {
      const saved = result.note ?? {};
      state.note = {
        ...state.note,
        ...saved,
        path: saved.path ?? notePath,
        content,
      };
      state.externalChange = false;
      hideBanner();
      // Text typed while the save was in flight must stay dirty.
      const stillDirty = elements.textarea.value !== content;
      setDirty(stillDirty, { updateStatus: false });
      setStatus(
        stillDirty ? `Saved ${notePath} — newer edits not yet saved` : `Saved ${notePath}`,
        stillDirty ? 'warning' : 'ready',
      );
      updateButtons();
      return result;
    }

    const error = result?.error ?? {};
    if (error.code === 'CONFLICT') {
      state.externalChange = true;
      const why = error.reason === 'deleted' ? 'was deleted on disk' : 'changed on disk';
      showBanner(
        `“${notePath}” ${why} since you opened it. Nothing was overwritten. ` +
          'Reload the note from disk, or overwrite it with the version in this editor.',
        { reload: true, overwrite: true },
      );
      setStatus('Note changed on disk — not saved', 'warning');
    } else {
      showBanner(
        `Could not save ${notePath}: ${errorMessage(result, 'unknown error')}. ` +
          'Your edits are still in the editor.',
        {},
      );
      setStatus('Save failed — edits kept', 'error');
    }
    updateButtons();
    return result;
  }

  async function overwrite() {
    if (!state.note || destroyed) return { ok: false, ignored: true };
    let confirmed = true;
    try {
      confirmed = confirm(
        `Overwrite “${state.note.path}” on disk with the text in this editor?`,
      ) !== false;
    } catch {
      confirmed = false;
    }
    if (!confirmed) return { ok: false, canceled: true };
    return save({ force: true });
  }

  async function reload({ quiet = false } = {}) {
    if (!state.note || destroyed) return { ok: false, ignored: true };
    if (!quiet && !confirmDiscardIfDirty()) {
      setStatus('Reload cancelled — edits kept.', 'warning');
      return { ok: false, canceled: true };
    }

    const notePath = state.note.path;
    const result = await callApi(api.readNote, notePath);
    if (!result?.ok) {
      if (result?.error?.code === 'ENOENT') {
        state.externalChange = true;
        showBanner(
          `“${notePath}” was deleted on disk. Your copy is still in the editor; ` +
            'use Overwrite to recreate it, or keep a copy elsewhere.',
          { reload: false, overwrite: true },
        );
        setStatus('Note deleted on disk — edits kept', 'warning');
      } else {
        showBanner(`Could not reload ${notePath}: ${errorMessage(result, 'unknown error')}.`, {});
        setStatus('Reload failed', 'error');
      }
      return result;
    }

    applyNote(result.note);
    setStatus(quiet ? 'Reloaded after external change' : `Reloaded ${notePath}`, quiet ? 'warning' : 'ready');
    return result;
  }

  async function checkForExternalChange() {
    if (destroyed || !state.note || state.saving) return;
    const notePath = state.note.path;
    const result = await callApi(api.statNote, notePath);
    if (!result?.ok) return;

    if (result.note === null) {
      if (!state.externalChange) {
        state.externalChange = true;
        showBanner(
          `“${notePath}” was deleted on disk. Your copy is still in the editor.`,
          { reload: false, overwrite: true },
        );
        setStatus('Note deleted on disk', 'warning');
      }
      return;
    }

    if (result.note.version === state.note.version) return;

    if (state.dirty) {
      state.externalChange = true;
      showBanner(
        `“${notePath}” changed on disk while you were editing. Saving will not ` +
          'overwrite it; reload to take the disk version, or overwrite explicitly.',
        { reload: true, overwrite: true },
      );
      setStatus('Note changed on disk — unsaved edits kept', 'warning');
      return;
    }

    // Nothing to lose: quietly take the version on disk.
    await reload({ quiet: true });
  }

  // ---- wiring ---------------------------------------------------------------

  function handleInput() {
    if (destroyed || !state.note || state.saving) return;
    setDirty(elements.textarea.value !== state.note.content);
  }

  function handleFileClick(event) {
    const item = event.target?.closest?.('li.file-item');
    if (!item || !elements.fileItems.contains(item)) return;
    openNote(item.dataset.path);
  }

  function handleFileKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target?.closest?.('li.file-item');
    if (!item) return;
    event.preventDefault();
    openNote(item.dataset.path);
  }

  function handleSaveClick() {
    save();
  }

  function handleReloadClick() {
    reload();
  }

  function handleOverwriteClick() {
    overwrite();
  }

  function handleShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 's' || !state.note) return;
    event.preventDefault();
    save();
  }

  elements.fileItems.addEventListener('click', handleFileClick);
  elements.fileItems.addEventListener('keydown', handleFileKeydown);
  elements.textarea.addEventListener('input', handleInput);
  elements.saveButton.addEventListener('click', handleSaveClick);
  elements.reloadButton.addEventListener('click', handleReloadClick);
  elements.bannerReload.addEventListener('click', handleReloadClick);
  elements.bannerOverwrite.addEventListener('click', handleOverwriteClick);
  document.addEventListener('keydown', handleShortcut);

  function destroy() {
    destroyed = true;
    elements.fileItems.removeEventListener('click', handleFileClick);
    elements.fileItems.removeEventListener('keydown', handleFileKeydown);
    elements.textarea.removeEventListener('input', handleInput);
    elements.saveButton.removeEventListener('click', handleSaveClick);
    elements.reloadButton.removeEventListener('click', handleReloadClick);
    elements.bannerReload.removeEventListener('click', handleReloadClick);
    elements.bannerOverwrite.removeEventListener('click', handleOverwriteClick);
    document.removeEventListener('keydown', handleShortcut);
  }

  function getState() {
    return {
      vault: state.vault ? state.vault.name : null,
      note: state.note ? state.note.path : null,
      version: state.note ? state.note.version : null,
      dirty: state.dirty,
      saving: state.saving,
      externalChange: state.externalChange,
      bannerVisible: !elements.banner.hidden,
    };
  }

  return {
    checkForExternalChange,
    destroy,
    getState,
    openNote,
    openVault,
    overwrite,
    reload,
    save,
  };
}
