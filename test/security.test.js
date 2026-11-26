'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { makeTempDir, makeVault, put, remove } = require('./helpers');
const { Vault, VaultError, VaultSecurityError } = require('../src/index.js');

async function setup(t) {
  const root = await makeVault({ 'inside.md': 'inside', 'notes/n.md': 'nested' });
  const outside = await makeTempDir('pumice-vault-outside-');
  await put(path.join(outside, 'secret.md'), 'outside secret');
  t.after(() => remove(root));
  t.after(() => remove(outside));
  const vault = await Vault.open(root);
  return { root, outside, vault };
}

test('security: read rejects parent-directory traversal', async (t) => {
  const { vault } = await setup(t);

  for (const bad of ['../secret.md', 'notes/../../secret.md', '..%2Fsecret.md'.replace('%2F', '/')]) {
    await assert.rejects(
      () => vault.readMarkdown(bad),
      (err) => err instanceof VaultSecurityError && err.code === 'SECURITY',
      `expected traversal rejection for ${bad}`
    );
  }
});

test('security: absolute paths and NUL bytes are rejected as INVALID_PATH', async (t) => {
  const { root, outside, vault } = await setup(t);

  for (const bad of [path.join(outside, 'secret.md'), '/etc/passwd', `bad\0name.md`, '']) {
    await assert.rejects(
      () => vault.readMarkdown(bad),
      (err) => err instanceof VaultError && err.code === 'INVALID_PATH',
      `expected INVALID_PATH for ${JSON.stringify(bad)}`
    );
  }
  assert.ok(root);
});

test('security: write rejects traversal and leaves the outside file untouched', async (t) => {
  const { outside, vault } = await setup(t);
  const outsideFile = path.join(outside, 'secret.md');

  await assert.rejects(
    () => vault.writeMarkdown('../secret.md', 'pwned'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside secret');
  assert.deepEqual(await fs.readdir(outside), ['secret.md']);
});

test('security: read refuses a symlinked file that escapes the vault', async (t) => {
  const { root, outside, vault } = await setup(t);
  await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'));

  await assert.rejects(
    () => vault.readMarkdown('link.md'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );
});

test('security: write refuses a symlinked target and never writes through it', async (t) => {
  const { root, outside, vault } = await setup(t);
  const outsideFile = path.join(outside, 'secret.md');
  await fs.symlink(outsideFile, path.join(root, 'link.md'));

  await assert.rejects(
    () => vault.writeMarkdown('link.md', 'pwned'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside secret');
});

test('security: a symlinked directory cannot be used to read or write outside the vault', async (t) => {
  const { root, outside, vault } = await setup(t);
  await fs.symlink(outside, path.join(root, 'linked-dir'), 'dir');

  await assert.rejects(
    () => vault.readMarkdown('linked-dir/secret.md'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );

  await assert.rejects(
    () => vault.writeMarkdown('linked-dir/new.md', 'pwned'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );
  assert.deepEqual(await fs.readdir(outside), ['secret.md']);
});

test('security: listing skips symlinks and does not recurse into symlinked directories', async (t) => {
  const { root, outside, vault } = await setup(t);
  await fs.symlink(path.join(root, 'inside.md'), path.join(root, 'alias.md'));
  await fs.symlink(outside, path.join(root, 'linked-dir'), 'dir');

  const entries = await vault.listMarkdown();
  const names = entries.map((e) => e.relativePath);
  assert.ok(names.includes('inside.md'));
  assert.ok(!names.includes('alias.md'), 'symlinked notes must not be listed');
  assert.ok(!names.some((n) => n.startsWith('linked-dir/')), 'symlinked dirs must not be walked');
});

test('security: a symlink whose target stays inside the vault is still refused', async (t) => {
  const { root, vault } = await setup(t);
  await fs.symlink(path.join(root, 'inside.md'), path.join(root, 'alias.md'));

  await assert.rejects(
    () => vault.readMarkdown('alias.md'),
    (err) => err instanceof VaultSecurityError && err.code === 'SECURITY'
  );
});

test('security: lexical normalization inside the vault is allowed', async (t) => {
  const { vault } = await setup(t);

  const viaDots = await vault.readMarkdown('notes/../inside.md');
  assert.equal(viaDots.relativePath, 'inside.md');
  assert.equal(viaDots.content, 'inside');
});

test('security: names merely containing two dots are not treated as traversal', async (t) => {
  const { root, vault } = await setup(t);
  await put(path.join(root, 'a..b.md'), 'dots in the name');
  await put(path.join(root, '..weird.md'), 'leading dots');

  assert.equal((await vault.readMarkdown('a..b.md')).content, 'dots in the name');
  assert.equal((await vault.readMarkdown('..weird.md')).content, 'leading dots');
});
