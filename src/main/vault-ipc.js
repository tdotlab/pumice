'use strict';

/**
 * IPC surface for the vault session.
 *
 * The renderer gets plain data, never filesystem objects: every handler
 * returns `{ ok: true, ... }` or `{ ok: false, error: { code, message, ... } }`.
 * Errors are converted to plain objects because Electron serialises thrown
 * errors across IPC by message only, which would lose the conflict code the
 * editor needs.
 *
 * Channels live in the `vault:` namespace reserved by the shell (see
 * docs/ARCHITECTURE.md); the shell itself owns `shell:` only.
 */

const VAULT_CHANNELS = Object.freeze([
  'vault:open',
  'vault:list',
  'vault:read',
  'vault:write',
  'vault:stat',
]);

const { VaultError } = require('../index.js');

function toErrorPayload(error) {
  const payload = {
    code: typeof error?.code === 'string' ? error.code : 'VAULT_ERROR',
    name: typeof error?.name === 'string' ? error.name : 'VaultError',
    message: typeof error?.message === 'string' ? error.message : String(error),
    path: typeof error?.path === 'string' ? error.path : null,
    reason: typeof error?.reason === 'string' ? error.reason : null,
  };
  if (typeof error?.expectedVersion === 'string') payload.expectedVersion = error.expectedVersion;
  if (typeof error?.actualVersion === 'string') payload.actualVersion = error.actualVersion;
  return payload;
}

function fail(error) {
  return { ok: false, error: toErrorPayload(error) };
}

function requireHandler(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

/**
 * @param {{
 *   ipcMain: {handle: Function},
 *   session: {open: Function, list: Function, read: Function, write: Function, stat: Function},
 *   chooseDirectory: () => Promise<string|null>
 * }} options
 */
function registerVaultIpcHandlers({ ipcMain, session, chooseDirectory }) {
  if (!ipcMain) throw new TypeError('ipcMain is required');
  if (!session) throw new TypeError('session is required');
  requireHandler(chooseDirectory, 'chooseDirectory');

  ipcMain.handle('vault:open', async () => {
    try {
      const root = await chooseDirectory();
      if (typeof root !== 'string' || root === '') return { ok: false, canceled: true };
      const info = await session.open(root);
      const files = await session.list();
      return { ok: true, vault: { ...info, files } };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('vault:list', async () => {
    try {
      return { ok: true, files: await session.list() };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('vault:read', async (_event, relPath) => {
    try {
      return { ok: true, note: await session.read(relPath) };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('vault:write', async (_event, payload) => {
    try {
      const { path: relPath, content, expectedVersion } = payload ?? {};
      // A missing path or non-string content is reported before the envelope
      // shape, so the caller sees the most specific problem first.
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        throw new VaultError('Note path must be a non-empty string', { code: 'INVALID_PATH' });
      }
      if (typeof content !== 'string') {
        throw new VaultError('Note content must be a string', {
          code: 'INVALID_CONTENT',
          path: relPath,
        });
      }
      // The renderer's contract is explicit: a string means "only if the note
      // still has this version", null means a deliberate unchecked overwrite.
      // A missing field is a bug in the caller, never an implicit overwrite.
      if (!('expectedVersion' in payload)) {
        throw new VaultError(
          'vault:write requires expectedVersion (pass null for an explicit unchecked overwrite)',
          { code: 'INVALID_OPTIONS', path: relPath }
        );
      }
      const note = await session.write(relPath, content, { expectedVersion });
      return { ok: true, note };
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('vault:stat', async (_event, relPath) => {
    try {
      return { ok: true, note: await session.stat(relPath) };
    } catch (error) {
      return fail(error);
    }
  });
}

module.exports = { VAULT_CHANNELS, registerVaultIpcHandlers, toErrorPayload };
