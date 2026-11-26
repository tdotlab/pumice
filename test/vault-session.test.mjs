import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import helpers from './helpers.js';
import vaultSessionModule from '../src/main/vault-session.js';

const { makeVault, put, remove } = helpers;
const { NO_VAULT_CODE, VaultSession } = vaultSessionModule;

const FILES = {
  'welcome.md': '# Welcome\n',
  'notes/daily.md': '# Daily\n',
  'notes/ideas.md': '# Ideas\n',
  'notes/attachments.txt': 'not markdown\n',
  '.hidden/secret.md': '# Secret\n',
};

async function withVault(fn) {
  const root = await makeVault(FILES);
  try {
    return await fn(root);
  } finally {
    await remove(root);
  }
}

test('open() reports the vault name and root without leaking the absolute path into listings', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    assert.equal(session.isOpen, false);
    assert.equal(session.info, null);

    const info = await session.open(root);
    assert.equal(session.isOpen, true);
    assert.equal(info.root, root);
    assert.equal(info.name, path.basename(root));
    assert.equal(session.root, root);
  });
});

test('list() returns only visible Markdown notes, sorted, with display names', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);

    const files = await session.list();
    assert.deepEqual(files.map((file) => file.path), [
      'notes/daily.md',
      'notes/ideas.md',
      'welcome.md',
    ]);
    assert.deepEqual(files.map((file) => file.name), ['daily.md', 'ideas.md', 'welcome.md']);
    for (const file of files) {
      assert.equal(typeof file.size, 'number');
      assert.equal(typeof file.mtimeMs, 'number');
    }
  });
});

test('read() returns UTF-8 content with the sha256 version token', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);

    const note = await session.read('welcome.md');
    assert.equal(note.path, 'welcome.md');
    assert.equal(note.name, 'welcome.md');
    assert.equal(note.content, '# Welcome\n');
    assert.equal(note.version, helpers.sha256('# Welcome\n'));
    assert.equal(note.size, Buffer.byteLength('# Welcome\n'));
  });
});

test('write() updates a note when the expected version still matches', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);
    const original = await session.read('welcome.md');

    const saved = await session.write('welcome.md', '# Welcome, again\n', {
      expectedVersion: original.version,
    });

    assert.equal(saved.path, 'welcome.md');
    assert.equal(saved.version, helpers.sha256('# Welcome, again\n'));
    assert.equal(await fs.readFile(path.join(root, 'welcome.md'), 'utf8'), '# Welcome, again\n');
    assert.notEqual(saved.version, original.version);
  });
});

test('write() refuses to clobber a note changed outside Pumice', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);
    const original = await session.read('welcome.md');
    await fs.writeFile(path.join(root, 'welcome.md'), 'external edit\n');

    await assert.rejects(
      session.write('welcome.md', 'mine\n', { expectedVersion: original.version }),
      (error) => {
        assert.equal(error.name, 'VaultConflictError');
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.reason, 'modified');
        assert.equal(error.path, 'welcome.md');
        assert.equal(error.expectedVersion, original.version);
        assert.equal(error.actualVersion, helpers.sha256('external edit\n'));
        return true;
      },
    );

    assert.equal(await fs.readFile(path.join(root, 'welcome.md'), 'utf8'), 'external edit\n');
  });
});

test('write() reports a note deleted outside Pumice without recreating it', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);
    const original = await session.read('notes/ideas.md');
    await fs.unlink(path.join(root, 'notes/ideas.md'));

    await assert.rejects(
      session.write('notes/ideas.md', 'mine\n', { expectedVersion: original.version }),
      (error) => error.code === 'CONFLICT' && error.reason === 'deleted',
    );
    await assert.rejects(fs.access(path.join(root, 'notes/ideas.md')));
  });
});

test('write() without an expected version is an explicit unchecked save', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);
    await fs.writeFile(path.join(root, 'welcome.md'), 'external\n');

    const saved = await session.write('welcome.md', 'mine\n');
    assert.equal(saved.path, 'welcome.md');
    assert.equal(await fs.readFile(path.join(root, 'welcome.md'), 'utf8'), 'mine\n');
  });
});

test('stat() reports the current version and returns null for a missing note', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);
    const original = await session.read('welcome.md');

    const same = await session.stat('welcome.md');
    assert.equal(same.version, original.version);

    await fs.writeFile(path.join(root, 'welcome.md'), 'external\n');
    const changed = await session.stat('welcome.md');
    assert.equal(changed.version, helpers.sha256('external\n'));

    assert.equal(await session.stat('notes/gone.md'), null);
  });
});

test('operations before a vault is open fail with a stable NO_VAULT code', async () => {
  const session = new VaultSession();
  for (const operation of [
    () => session.list(),
    () => session.read('welcome.md'),
    () => session.write('welcome.md', 'x'),
    () => session.stat('welcome.md'),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.code, NO_VAULT_CODE);
      return true;
    });
  }
});

test('opening a missing directory fails and leaves no vault open', async () => {
  const session = new VaultSession();
  await assert.rejects(session.open('/definitely/not/a/pumice/vault'), (error) => error.code === 'ENOENT');
  assert.equal(session.isOpen, false);
});

test('path traversal and non-Markdown targets are refused by the session', async () => {
  await withVault(async (root) => {
    const session = new VaultSession();
    await session.open(root);

    await assert.rejects(
      session.write('../escape.md', 'x'),
      (error) => error.code === 'SECURITY',
    );
    await assert.rejects(
      session.read('notes/attachments.txt'),
      (error) => error.code === 'NOT_MARKDOWN',
    );
  });
});
