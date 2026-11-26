'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { makeTempDir, makeVault, remove } = require('./helpers');
const { Vault, VaultError } = require('../src/index.js');

test('open: selects an existing directory and exposes its absolute real root', async (t) => {
  const root = await makeVault({ 'note.md': '# hi' });
  t.after(() => remove(root));

  const vault = await Vault.open(root);
  assert.ok(vault instanceof Vault);
  assert.equal(vault.root, root);
  assert.equal(path.isAbsolute(vault.root), true);
});

test('open: accepts a trailing separator', async (t) => {
  const root = await makeVault({ 'note.md': '# hi' });
  t.after(() => remove(root));

  const vault = await Vault.open(root + path.sep);
  assert.equal(vault.root, root);
});

test('open: rejects a missing vault directory with code ENOENT', async () => {
  const parent = await makeTempDir();
  const missing = path.join(parent, 'does-not-exist');
  try {
    await assert.rejects(
      () => Vault.open(missing),
      (err) => err instanceof VaultError && err.code === 'ENOENT'
    );
  } finally {
    await remove(parent);
  }
});

test('open: rejects a regular file with code ENOTDIR', async (t) => {
  const root = await makeVault({ 'a.md': 'x' });
  t.after(() => remove(root));

  await assert.rejects(
    () => Vault.open(path.join(root, 'a.md')),
    (err) => err instanceof VaultError && err.code === 'ENOTDIR'
  );
});

test('open: rejects an empty or non-string path with INVALID_PATH', async () => {
  await assert.rejects(() => Vault.open(''), (err) => err.code === 'INVALID_PATH');
  await assert.rejects(() => Vault.open('   '), (err) => err.code === 'INVALID_PATH');
  await assert.rejects(() => Vault.open(null), (err) => err.code === 'INVALID_PATH');
});

test('open: resolves a symlinked vault root to its real path', async (t) => {
  const real = await makeVault({ 'note.md': 'x' });
  const linkParent = await makeTempDir();
  const link = path.join(linkParent, 'vault-link');
  await fs.symlink(real, link, 'dir');
  t.after(() => remove(linkParent));
  t.after(() => remove(real));

  const vault = await Vault.open(link);
  assert.equal(vault.root, real);
});

test('open: honours a custom Markdown extension list', async (t) => {
  const root = await makeVault({ 'note.txt': 'plain', 'note.md': 'markdown' });
  t.after(() => remove(root));

  const vault = await Vault.open(root, { extensions: ['txt'] });
  const entries = await vault.listMarkdown();
  assert.deepEqual(entries.map((e) => e.relativePath), ['note.txt']);
  assert.equal((await vault.readMarkdown('note.txt')).content, 'plain');
});
