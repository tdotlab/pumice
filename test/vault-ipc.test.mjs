import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import helpers from './helpers.js';
import vaultIpcModule from '../src/main/vault-ipc.js';
import vaultSessionModule from '../src/main/vault-session.js';

const { VAULT_CHANNELS, registerVaultIpcHandlers } = vaultIpcModule;
const { VaultSession } = vaultSessionModule;
const { makeVault, remove, sha256 } = helpers;

const FILES = {
  'welcome.md': '# Welcome\n',
  'notes/daily.md': '# Daily\n',
  'notes/attachments.txt': 'not markdown\n',
  '.hidden/secret.md': '# Secret\n',
};

function fakeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    invoke(channel, ...args) {
      const handler = this.handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    },
  };
}

async function setup({ files = FILES, chooseDirectory } = {}) {
  const root = await makeVault(files);
  const session = new VaultSession();
  const ipcMain = fakeIpcMain();
  const chosen = [];
  registerVaultIpcHandlers({
    ipcMain,
    session,
    chooseDirectory: async () => {
      chosen.push(true);
      return chooseDirectory ? chooseDirectory(root) : root;
    },
  });
  return { root, session, ipcMain, chosen, cleanup: () => remove(root) };
}

test('the vault module owns exactly its five vault: channels and no shell channel', () => {
  const ipcMain = fakeIpcMain();
  registerVaultIpcHandlers({ ipcMain, session: new VaultSession(), chooseDirectory: async () => null });

  assert.deepEqual([...ipcMain.handlers.keys()], [...VAULT_CHANNELS]);
  for (const channel of ipcMain.handlers.keys()) {
    assert.match(channel, /^vault:/);
  }
});

test('vault:open asks for a directory, opens it and returns its Markdown list', async () => {
  const context = await setup();
  try {
    const result = await context.ipcMain.invoke('vault:open');
    assert.equal(result.ok, true);
    assert.equal(result.vault.root, context.root);
    assert.equal(result.vault.name, path.basename(context.root));
    assert.deepEqual(result.vault.files.map((file) => file.path), [
      'notes/daily.md',
      'welcome.md',
    ]);
    assert.equal(context.chosen.length, 1);
  } finally {
    await context.cleanup();
  }
});

test('vault:open reports a cancelled folder dialog distinctly from an error', async () => {
  const context = await setup({ chooseDirectory: () => null });
  try {
    const result = await context.ipcMain.invoke('vault:open');
    assert.deepEqual(result, { ok: false, canceled: true });
  } finally {
    await context.cleanup();
  }
});

test('vault:open wraps a bad directory in a serialisable error envelope', async () => {
  const ipcMain = fakeIpcMain();
  registerVaultIpcHandlers({
    ipcMain,
    session: new VaultSession(),
    chooseDirectory: async () => '/definitely/not/a/pumice/vault',
  });

  const result = await ipcMain.invoke('vault:open');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(typeof result.error.message, 'string');
  assert.equal('stack' in result.error, false);
});

test('vault:read returns note content and version; a missing note is an ENOENT envelope', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');

    const read = await context.ipcMain.invoke('vault:read', 'welcome.md');
    assert.equal(read.ok, true);
    assert.equal(read.note.path, 'welcome.md');
    assert.equal(read.note.content, '# Welcome\n');
    assert.equal(read.note.version, sha256('# Welcome\n'));

    const missing = await context.ipcMain.invoke('vault:read', 'notes/gone.md');
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'ENOENT');
  } finally {
    await context.cleanup();
  }
});

test('vault:write saves when the expected version matches and returns the new version', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');
    const read = await context.ipcMain.invoke('vault:read', 'welcome.md');

    const written = await context.ipcMain.invoke('vault:write', {
      path: 'welcome.md',
      content: '# Edited\n',
      expectedVersion: read.note.version,
    });

    assert.equal(written.ok, true);
    assert.equal(written.note.version, sha256('# Edited\n'));
    assert.equal(
      await fs.readFile(path.join(context.root, 'welcome.md'), 'utf8'),
      '# Edited\n',
    );
  } finally {
    await context.cleanup();
  }
});

test('vault:write turns an external change into a CONFLICT envelope and preserves the disk copy', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');
    const read = await context.ipcMain.invoke('vault:read', 'welcome.md');
    await fs.writeFile(path.join(context.root, 'welcome.md'), 'external edit\n');

    const written = await context.ipcMain.invoke('vault:write', {
      path: 'welcome.md',
      content: 'my version\n',
      expectedVersion: read.note.version,
    });

    assert.equal(written.ok, false);
    assert.equal(written.error.code, 'CONFLICT');
    assert.equal(written.error.reason, 'modified');
    assert.equal(written.error.path, 'welcome.md');
    assert.equal(written.error.actualVersion, sha256('external edit\n'));
    assert.equal(
      await fs.readFile(path.join(context.root, 'welcome.md'), 'utf8'),
      'external edit\n',
    );
  } finally {
    await context.cleanup();
  }
});

test('vault:write with a null expected version is the explicit overwrite path', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');
    await fs.writeFile(path.join(context.root, 'welcome.md'), 'external edit\n');

    const written = await context.ipcMain.invoke('vault:write', {
      path: 'welcome.md',
      content: 'my version\n',
      expectedVersion: null,
    });

    assert.equal(written.ok, true);
    assert.equal(
      await fs.readFile(path.join(context.root, 'welcome.md'), 'utf8'),
      'my version\n',
    );
  } finally {
    await context.cleanup();
  }
});

test('vault:stat returns the current version, a null note when missing, and errors otherwise', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');

    const current = await context.ipcMain.invoke('vault:stat', 'welcome.md');
    assert.equal(current.ok, true);
    assert.equal(current.note.version, sha256('# Welcome\n'));

    const missing = await context.ipcMain.invoke('vault:stat', 'notes/gone.md');
    assert.deepEqual(missing, { ok: true, note: null });

    const traversal = await context.ipcMain.invoke('vault:stat', '../outside.md');
    assert.equal(traversal.ok, false);
    assert.equal(traversal.error.code, 'SECURITY');
  } finally {
    await context.cleanup();
  }
});

test('every data channel reports NO_VAULT before a vault is opened', async () => {
  const ipcMain = fakeIpcMain();
  registerVaultIpcHandlers({
    ipcMain,
    session: new VaultSession(),
    chooseDirectory: async () => null,
  });

  for (const [channel, payload] of [
    ['vault:list'],
    ['vault:read', 'welcome.md'],
    ['vault:write', { path: 'welcome.md', content: 'x', expectedVersion: null }],
    ['vault:stat', 'welcome.md'],
  ]) {
    const result = await ipcMain.invoke(channel, payload);
    assert.equal(result.ok, false, channel);
    assert.equal(result.error.code, 'NO_VAULT', channel);
  }
});

test('write payloads are validated instead of being trusted from the renderer', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');

    const noPath = await context.ipcMain.invoke('vault:write', { content: 'x' });
    assert.equal(noPath.ok, false);
    assert.equal(noPath.error.code, 'INVALID_PATH');

    const badContent = await context.ipcMain.invoke('vault:write', {
      path: 'welcome.md',
      content: 42,
    });
    assert.equal(badContent.ok, false);
    assert.equal(badContent.error.code, 'INVALID_CONTENT');
  } finally {
    await context.cleanup();
  }
});

// ---- encoding and the write contract --------------------------------------

const LATIN1 = Buffer.from('café note\n', 'latin1');

test('vault:read reports a non-UTF-8 note as INVALID_ENCODING, never as decoded text', async () => {
  const context = await setup({ files: { 'latin1.md': LATIN1, 'welcome.md': '# Welcome\n' } });
  try {
    await context.ipcMain.invoke('vault:open');
    const read = await context.ipcMain.invoke('vault:read', 'latin1.md');

    assert.equal(read.ok, false);
    assert.equal(read.error.code, 'INVALID_ENCODING');
    assert.equal(read.error.path, 'latin1.md');
    assert.equal('note' in read, false);
    assert.deepEqual(await fs.readFile(path.join(context.root, 'latin1.md')), LATIN1);
  } finally {
    await context.cleanup();
  }
});

test('vault:list flags notes that are not UTF-8', async () => {
  const context = await setup({ files: { 'latin1.md': LATIN1, 'welcome.md': '# Welcome\n' } });
  try {
    const opened = await context.ipcMain.invoke('vault:open');
    const byPath = Object.fromEntries(opened.vault.files.map((file) => [file.path, file]));
    assert.equal(byPath['welcome.md'].utf8, true);
    assert.equal(byPath['latin1.md'].utf8, false);
  } finally {
    await context.cleanup();
  }
});

test('vault:write refuses a payload without expectedVersion instead of overwriting unchecked', async () => {
  const context = await setup();
  try {
    await context.ipcMain.invoke('vault:open');
    await fs.writeFile(path.join(context.root, 'welcome.md'), 'external edit\n');

    const written = await context.ipcMain.invoke('vault:write', {
      path: 'welcome.md',
      content: 'my version\n',
    });

    assert.equal(written.ok, false);
    assert.equal(written.error.code, 'INVALID_OPTIONS');
    assert.match(written.error.message, /expectedVersion/);
    assert.equal(
      await fs.readFile(path.join(context.root, 'welcome.md'), 'utf8'),
      'external edit\n',
    );
  } finally {
    await context.cleanup();
  }
});
