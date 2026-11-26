import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShellDom } from './helpers/dom.mjs';
import { createShellView } from '../src/renderer/ui.mjs';
import { createVaultController } from '../src/renderer/vault-ui.mjs';

const VAULT = {
  ok: true,
  vault: {
    name: 'Field Notes',
    root: '/vault',
    files: [
      { path: 'notes/daily.md', name: 'daily.md', size: 8, mtimeMs: 1 },
      { path: 'welcome.md', name: 'welcome.md', size: 20, mtimeMs: 2 },
    ],
  },
};

const NOTE = {
  ok: true,
  note: {
    path: 'notes/daily.md',
    name: 'daily.md',
    content: '# Daily\n',
    version: 'v1',
    size: 8,
    mtimeMs: 1,
  },
};

const SECOND = {
  ok: true,
  note: {
    path: 'welcome.md',
    name: 'welcome.md',
    content: '# Welcome\n',
    version: 'w1',
    size: 10,
    mtimeMs: 2,
  },
};

function makeApi(handlers = {}) {
  const calls = [];
  const call = (name, fallback) => async (...args) => {
    calls.push([name, ...args]);
    return handlers[name] ? handlers[name](...args) : fallback;
  };
  const api = {
    calls,
    openVault: call('openVault', { ok: false, canceled: true }),
    listNotes: call('listNotes', { ok: true, files: [] }),
    readNote: call('readNote', NOTE),
    writeNote: call('writeNote', {
      ok: true,
      note: { ...NOTE.note, content: '# Daily edited\n', version: 'v2' },
    }),
    statNote: call('statNote', { ok: true, note: { version: 'v1' } }),
  };
  return api;
}

async function mount({ handlers, confirm = () => true } = {}) {
  const dom = await loadShellDom();
  const { document } = dom.window;
  const view = createShellView({ document, onOpenVault() {} });
  const api = makeApi({
    readNote: (notePath) => (notePath === 'welcome.md' ? SECOND : NOTE),
    ...handlers,
  });
  const controller = createVaultController({ document, view, api, confirm });
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  return { dom, document, window: dom.window, view, api, controller, q };
}

async function openVaultAndNote(options = {}) {
  const mounted = await mount({
    ...options,
    handlers: { openVault: () => VAULT, ...(options.handlers ?? {}) },
  });
  await mounted.controller.openVault();
  mounted.q('file-items').querySelector('li').click();
  await new Promise((resolve) => setImmediate(resolve));
  return mounted;
}

test('opening a vault renders its files and leaves the editor empty', async () => {
  const { q, view, controller, api } = await mount({ handlers: { openVault: () => VAULT } });

  await controller.openVault();

  assert.deepEqual(api.calls, [['openVault']]);
  assert.equal(view.getState().vault, 'Field Notes');
  assert.equal(q('file-list').hidden, false);
  assert.equal(q('file-items').children.length, 2);
  assert.equal(q('note-editor').hidden, true);
  assert.equal(q('editor-empty').hidden, false);
  assert.equal(controller.getState().note, null);
});

test('a cancelled or failed open leaves the shell alone and reports errors', async () => {
  const canceled = await mount({ handlers: { openVault: () => ({ ok: false, canceled: true }) } });
  await canceled.controller.openVault();
  assert.equal(canceled.view.getState().vault, 'No vault open');
  assert.equal(canceled.q('status-text').dataset.state, 'ready');

  const failed = await mount({
    handlers: {
      openVault: () => ({ ok: false, error: { code: 'EACCES', message: 'Vault directory is not readable' } }),
    },
  });
  await failed.controller.openVault();
  assert.equal(failed.q('status-text').dataset.state, 'error');
  assert.match(failed.q('status-text').textContent, /not readable/i);
  assert.equal(failed.controller.getState().note, null);
});

test('clicking a file row loads the note into the editor', async () => {
  const { q, controller, api } = await openVaultAndNote();

  assert.deepEqual(api.calls.at(-1), ['readNote', 'notes/daily.md']);
  const textarea = q('note-editor');
  assert.equal(textarea.hidden, false);
  assert.equal(q('editor-empty').hidden, true);
  assert.equal(textarea.value, '# Daily\n');
  assert.equal(q('document-title').textContent, 'notes/daily.md');
  assert.equal(q('save-note-button').disabled, true);
  assert.equal(q('reload-note-button').disabled, false);
  assert.equal(q('note-dirty').hidden, true);
  assert.equal(controller.getState().note, 'notes/daily.md');
  assert.equal(controller.getState().dirty, false);

  const active = q('file-items').querySelector('li[aria-current="true"]');
  assert.equal(active.dataset.path, 'notes/daily.md');
});

test('a note that cannot be read is reported and leaves the editor empty', async () => {
  const { q, controller } = await mount({
    handlers: {
      openVault: () => VAULT,
      readNote: () => ({ ok: false, error: { code: 'ENOENT', message: 'Note not found: notes/gone.md' } }),
    },
  });
  await controller.openVault();
  q('file-items').querySelector('li').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(q('note-editor').hidden, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /not found/i);
  assert.equal(q('status-text').dataset.state, 'error');
});

test('editing marks the note dirty and reverting the text clears the marker', async () => {
  const { q, controller, document } = await openVaultAndNote();
  const textarea = q('note-editor');

  textarea.value = '# Daily\n\nnew line\n';
  textarea.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

  assert.equal(controller.getState().dirty, true);
  assert.equal(q('save-note-button').disabled, false);
  assert.equal(q('note-dirty').hidden, false);
  assert.equal(q('status-text').dataset.state, 'warning');

  textarea.value = '# Daily\n';
  textarea.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

  assert.equal(controller.getState().dirty, false);
  assert.equal(q('save-note-button').disabled, true);
  assert.equal(q('note-dirty').hidden, true);
});

test('saving sends the edited text with the version it was read at', async () => {
  const { q, controller, api } = await openVaultAndNote();
  const textarea = q('note-editor');
  textarea.value = '# Daily edited\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  q('save-note-button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(api.calls.at(-1), ['writeNote', 'notes/daily.md', '# Daily edited\n', 'v1']);
  assert.equal(controller.getState().dirty, false);
  assert.equal(controller.getState().version, 'v2');
  assert.equal(q('save-note-button').disabled, true);
  assert.equal(q('note-dirty').hidden, true);
  assert.match(q('status-text').textContent, /saved/i);
  assert.equal(q('status-text').dataset.state, 'ready');
});

test('Ctrl+S saves the open note', async () => {
  const { q, controller, api, document } = await openVaultAndNote();
  const textarea = q('note-editor');
  textarea.value = '# Keyboard save\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  const KeyboardEventCtor = document.defaultView.KeyboardEvent;
  const event = new KeyboardEventCtor('keydown', {
    key: 's',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(api.calls.at(-1), ['writeNote', 'notes/daily.md', '# Keyboard save\n', 'v1']);
  assert.equal(controller.getState().dirty, false);
  assert.match(q('status-text').textContent, /saved/i);
});

test('edits typed while a save is in flight stay dirty', async () => {
  let resolveWrite;
  const { q, controller } = await openVaultAndNote({
    handlers: {
      writeNote: () => new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# First\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  const pending = controller.save();
  textarea.value = '# Second\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  resolveWrite({ ok: true, note: { ...NOTE.note, content: '# First\n', version: 'v2' } });
  await pending;

  assert.equal(controller.getState().dirty, true);
  assert.equal(q('save-note-button').disabled, false);
  assert.match(q('status-text').textContent, /not yet saved/i);
  assert.equal(q('status-text').dataset.state, 'warning');
});

test('an ordinary save failure keeps the draft and surfaces the error', async () => {
  const { q, controller } = await openVaultAndNote({
    handlers: {
      writeNote: () => ({ ok: false, error: { code: 'EACCES', message: 'Permission denied' } }),
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# Unsaved\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.save();

  assert.equal(textarea.value, '# Unsaved\n');
  assert.equal(controller.getState().dirty, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /permission denied/i);
  assert.equal(q('status-text').dataset.state, 'error');
});

test('a conflict preserves the draft, explains the external change and offers overwrite', async () => {
  const { q, controller } = await openVaultAndNote({
    handlers: {
      writeNote: () => ({
        ok: false,
        error: {
          code: 'CONFLICT',
          reason: 'modified',
          message: 'Note changed outside Pumice: notes/daily.md',
        },
      }),
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# My edits\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.save();

  assert.equal(textarea.value, '# My edits\n');
  assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().externalChange, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /changed on disk/i);
  assert.equal(q('banner-reload-button').hidden, false);
  assert.equal(q('banner-overwrite-button').hidden, false);
  assert.equal(q('status-text').dataset.state, 'warning');
});

test('explicit overwrite saves without a version expectation after a conflict', async () => {
  let attempt = 0;
  const { q, controller, api } = await openVaultAndNote({
    handlers: {
      writeNote: (...args) => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, error: { code: 'CONFLICT', reason: 'modified', message: 'changed' } };
        }
        return { ok: true, note: { ...NOTE.note, content: '# Mine\n', version: 'v3' } };
      },
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# Mine\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.save();
  q('banner-overwrite-button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(api.calls.at(-1), ['writeNote', 'notes/daily.md', '# Mine\n', null]);
  assert.equal(controller.getState().dirty, false);
  assert.equal(q('editor-banner').hidden, true);
  assert.match(q('status-text').textContent, /saved/i);
});

test('reload discards local edits only after confirmation and takes the disk copy', async () => {
  let confirmation;
  let reads = 0;
  const { q, controller } = await openVaultAndNote({
    confirm: (message) => {
      confirmation = message;
      return true;
    },
    handlers: {
      readNote: () => {
        reads += 1;
        return reads === 1
          ? NOTE
          : { ok: true, note: { ...NOTE.note, content: '# From disk\n', version: 'v9' } };
      },
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# Draft\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.reload();

  assert.match(confirmation, /discard|unsaved/i);
  assert.equal(textarea.value, '# From disk\n');
  assert.equal(controller.getState().dirty, false);
  assert.equal(controller.getState().version, 'v9');
});

test('reload does nothing when the user declines to discard edits', async () => {
  const { q, controller, api } = await openVaultAndNote({ confirm: () => false });
  const textarea = q('note-editor');
  textarea.value = '# Draft\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));
  const before = api.calls.length;

  await controller.reload();

  assert.equal(api.calls.length, before);
  assert.equal(textarea.value, '# Draft\n');
  assert.equal(controller.getState().dirty, true);
});

test('switching notes while dirty requires confirmation and never loses the draft silently', async () => {
  const declined = await openVaultAndNote({ confirm: () => false });
  const declinedText = declined.q('note-editor');
  declinedText.value = '# Draft\n';
  declinedText.dispatchEvent(new (declined.q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));
  const before = declined.api.calls.length;

  declined.q('file-items').querySelectorAll('li')[1].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(declined.api.calls.length, before);
  assert.equal(declinedText.value, '# Draft\n');
  assert.equal(declined.controller.getState().note, 'notes/daily.md');
  assert.equal(declined.q('status-text').dataset.state, 'warning');

  const accepted = await openVaultAndNote({ confirm: () => true });
  const acceptedText = accepted.q('note-editor');
  acceptedText.value = '# Draft\n';
  acceptedText.dispatchEvent(new (accepted.q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));
  accepted.q('file-items').querySelectorAll('li')[1].click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(accepted.controller.getState().note, 'welcome.md');
  assert.equal(acceptedText.value, '# Welcome\n');
});

test('a clean note reloads automatically when it changed on disk', async () => {
  let reads = 0;
  const { q, controller } = await openVaultAndNote({
    handlers: {
      statNote: () => ({ ok: true, note: { version: 'v2' } }),
      readNote: () => {
        reads += 1;
        return reads === 1
          ? NOTE
          : { ok: true, note: { ...NOTE.note, content: '# Daily from disk\n', version: 'v2' } };
      },
    },
  });

  await controller.checkForExternalChange();

  assert.equal(q('note-editor').value, '# Daily from disk\n');
  assert.equal(controller.getState().dirty, false);
  assert.match(q('status-text').textContent, /reloaded|changed/i);
  assert.equal(q('status-text').dataset.state, 'warning');
});

test('a dirty note never takes the disk copy automatically; it warns instead', async () => {
  const { q, controller, api } = await openVaultAndNote({
    handlers: { statNote: () => ({ ok: true, note: { version: 'v2' } }) },
  });
  const textarea = q('note-editor');
  textarea.value = '# My draft\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));
  const readsBefore = api.calls.filter(([name]) => name === 'readNote').length;

  await controller.checkForExternalChange();

  assert.equal(textarea.value, '# My draft\n');
  assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().externalChange, true);
  assert.equal(api.calls.filter(([name]) => name === 'readNote').length, readsBefore);
  assert.match(q('editor-banner-text').textContent, /changed on disk/i);
  assert.equal(q('status-text').dataset.state, 'warning');
});

test('a note deleted on disk is reported without discarding the draft', async () => {
  const { q, controller } = await openVaultAndNote({
    handlers: { statNote: () => ({ ok: true, note: null }) },
  });
  const textarea = q('note-editor');
  textarea.value = '# Keep me\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.checkForExternalChange();

  assert.equal(textarea.value, '# Keep me\n');
  assert.equal(controller.getState().dirty, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /deleted/i);
  assert.equal(q('banner-overwrite-button').hidden, false);
});

test('destroy detaches the file list and editor listeners', async () => {
  const { q, controller, api } = await openVaultAndNote();
  const before = api.calls.length;
  controller.destroy();

  q('file-items').querySelectorAll('li')[1].click();
  q('note-editor').dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.calls.length, before);
});

// ---- non-UTF-8 notes and the dirty-close guard ----------------------------

const MIXED_VAULT = {
  ok: true,
  vault: {
    name: 'Field Notes',
    root: '/vault',
    files: [
      { path: 'notes/daily.md', name: 'daily.md', size: 8, mtimeMs: 1, utf8: true },
      { path: 'notes/latin1.md', name: 'latin1.md', size: 10, mtimeMs: 2, utf8: false },
    ],
  },
};

test('a non-UTF-8 note is marked not editable in the list and is never opened', async () => {
  const { q, controller, api } = await mount({ handlers: { openVault: () => MIXED_VAULT } });
  await controller.openVault();

  const row = q('file-items').querySelector('li[data-path="notes/latin1.md"]');
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.match(row.className, /is-uneditable/);
  assert.match(row.textContent, /not UTF-8/i);

  const readsBefore = api.calls.filter(([name]) => name === 'readNote').length;
  row.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(api.calls.filter(([name]) => name === 'readNote').length, readsBefore);
  assert.equal(q('note-editor').hidden, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /not UTF-8/i);
  assert.equal(q('status-meta').textContent, 'Markdown · not UTF-8');
  assert.equal(controller.getState().note, null);
});

test('a read refused with INVALID_ENCODING shows the encoding banner, not a decoded note', async () => {
  const { q, controller } = await mount({
    handlers: {
      openVault: () => MIXED_VAULT,
      readNote: () => ({
        ok: false,
        error: { code: 'INVALID_ENCODING', message: 'Note is not valid UTF-8: notes/latin1.md' },
      }),
    },
  });
  await controller.openVault();

  // The stale-listing path: the row claims UTF-8, the read refuses.
  const row = q('file-items').querySelector('li[data-path="notes/daily.md"]');
  row.dataset.utf8 = 'true';
  row.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(q('note-editor').hidden, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /not UTF-8/i);
  assert.equal(q('status-meta').textContent, 'Markdown · not UTF-8');
  assert.equal(q('status-text').dataset.state, 'warning');
  assert.equal(controller.getState().note, null);
});

test('the status bar reports the encoding of the open note instead of hard-coding UTF-8', async () => {
  const { q, controller } = await openVaultAndNote();

  assert.equal(q('status-meta').textContent, 'Markdown · UTF-8');
  assert.equal(controller.getState().note, 'notes/daily.md');
});

test('a save refused because the note is not UTF-8 keeps the draft and explains why', async () => {
  const { q, controller } = await openVaultAndNote({
    handlers: {
      writeNote: () => ({
        ok: false,
        error: {
          code: 'INVALID_ENCODING',
          message: 'Refusing to rewrite a note that is not valid UTF-8: notes/daily.md',
        },
      }),
    },
  });
  const textarea = q('note-editor');
  textarea.value = '# Draft that must not be written\n';
  textarea.dispatchEvent(new (q('note-editor').ownerDocument.defaultView.Event)('input', { bubbles: true }));

  await controller.save();

  assert.equal(textarea.value, '# Draft that must not be written\n');
  assert.equal(controller.getState().dirty, true);
  assert.equal(q('editor-banner').hidden, false);
  assert.match(q('editor-banner-text').textContent, /not UTF-8/i);
  assert.equal(q('status-text').dataset.state, 'warning');
});

test('beforeunload is only cancelled while the editor has unsaved changes', async () => {
  const { q, controller, window } = await openVaultAndNote();
  const dispatch = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  const clean = dispatch();
  assert.equal(clean.defaultPrevented, false, 'a clean editor must close without a prompt');

  const textarea = q('note-editor');
  textarea.value = '# Draft that must not vanish\n';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(controller.getState().dirty, true);

  const dirty = dispatch();
  assert.equal(dirty.defaultPrevented, true, 'a dirty editor must block the close');
  // The handler also sets event.returnValue for engines that read the legacy
  // string; setting it (or preventing default) is what Electron observes.
  assert.equal(dirty.returnValue, false, 'a cancelled beforeunload reports returnValue false');

  textarea.value = '# Daily\n';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(dispatch().defaultPrevented, false, 'reverting the text clears the guard');
});
