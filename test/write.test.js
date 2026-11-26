'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { makeVault, remove, sha256, isRoot } = require('./helpers');
const { Vault, VaultError, VaultConflictError } = require('../src/index.js');

test('writeMarkdown: creates a new note atomically and leaves no temp files', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  await fs.mkdir(path.join(root, 'ideas'));
  const vault = await Vault.open(root);

  const result = await vault.writeMarkdown('ideas/first.md', '# First\n');
  assert.equal(result.relativePath, 'ideas/first.md');
  assert.equal(result.version, sha256('# First\n'));
  assert.equal(result.size, Buffer.byteLength('# First\n'));
  assert.equal(typeof result.mtimeMs, 'number');

  assert.equal(await fs.readFile(path.join(root, 'ideas', 'first.md'), 'utf8'), '# First\n');
  assert.deepEqual(await fs.readdir(path.join(root, 'ideas')), ['first.md']);
});

test('writeMarkdown: overwrites when the caller supplies the current version', async (t) => {
  const root = await makeVault({ 'note.md': 'one' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const before = await vault.readMarkdown('note.md');
  const after = await vault.writeMarkdown('note.md', 'two', { expectedVersion: before.version });
  assert.equal(after.version, sha256('two'));
  assert.notEqual(after.version, before.version);
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'two');
});

test('writeMarkdown: detects an external modification and preserves the external content', async (t) => {
  const root = await makeVault({ 'note.md': 'one' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const before = await vault.readMarkdown('note.md');
  await fs.writeFile(path.join(root, 'note.md'), 'changed outside');

  await assert.rejects(
    () => vault.writeMarkdown('note.md', 'mine', { expectedVersion: before.version }),
    (err) => {
      assert.ok(err instanceof VaultConflictError);
      assert.ok(err instanceof VaultError);
      assert.equal(err.code, 'CONFLICT');
      assert.equal(err.reason, 'modified');
      assert.equal(err.expectedVersion, before.version);
      assert.equal(err.actualVersion, sha256('changed outside'));
      return true;
    }
  );

  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'changed outside');
});

test('writeMarkdown: detects an external deletion without recreating the file', async (t) => {
  const root = await makeVault({ 'note.md': 'one' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const before = await vault.readMarkdown('note.md');
  await fs.rm(path.join(root, 'note.md'));

  await assert.rejects(
    () => vault.writeMarkdown('note.md', 'mine', { expectedVersion: before.version }),
    (err) => err instanceof VaultConflictError && err.code === 'CONFLICT' && err.reason === 'deleted'
  );

  await assert.rejects(() => fs.stat(path.join(root, 'note.md')), { code: 'ENOENT' });
});

test('writeMarkdown: an mtime-only change with identical content is not a conflict', async (t) => {
  const root = await makeVault({ 'note.md': 'same' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const before = await vault.readMarkdown('note.md');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(root, 'note.md'), future, future);

  const after = await vault.writeMarkdown('note.md', 'next', { expectedVersion: before.version });
  assert.equal(after.version, sha256('next'));
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'next');
});

test('writeMarkdown: mtime expectation writes when unchanged and conflicts when changed', async (t) => {
  const root = await makeVault({ 'note.md': 'one' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const first = await vault.readMarkdown('note.md');
  await vault.writeMarkdown('note.md', 'two', { expectedMtimeMs: first.mtimeMs });

  const second = await vault.readMarkdown('note.md');
  await fs.writeFile(path.join(root, 'note.md'), 'external');

  await assert.rejects(
    () => vault.writeMarkdown('note.md', 'mine', { expectedMtimeMs: second.mtimeMs }),
    (err) => err instanceof VaultConflictError && err.reason === 'modified'
  );
  assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), 'external');
});

test('writeMarkdown: preserves the mode of an existing note', async (t) => {
  const root = await makeVault({ 'note.md': 'one' });
  t.after(() => remove(root));
  await fs.chmod(path.join(root, 'note.md'), 0o640);
  const vault = await Vault.open(root);

  const before = await vault.readMarkdown('note.md');
  await vault.writeMarkdown('note.md', 'two', { expectedVersion: before.version });

  const stat = await fs.stat(path.join(root, 'note.md'));
  assert.equal(stat.mode & 0o777, 0o640);
});

test('writeMarkdown: preserves exact bytes for BOM and CRLF content', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const content = '\ufeff# Title\r\nbody\r\n';
  const written = await vault.writeMarkdown('crlf.md', content);
  const record = await vault.readMarkdown('crlf.md');
  assert.equal(record.content, content);
  assert.equal(record.version, sha256(content));
  assert.equal(written.version, record.version);
});

test('writeMarkdown: a write failure leaves the original content untouched', async (t) => {
  if (isRoot) return t.skip('permission-based failure injection is meaningless as root');
  const root = await makeVault({ 'keep.md': 'original' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await fs.chmod(root, 0o500);
  try {
    await assert.rejects(
      () => vault.writeMarkdown('keep.md', 'replacement'),
      (err) => err instanceof VaultError && err.code === 'EACCES'
    );
  } finally {
    await fs.chmod(root, 0o700);
  }

  assert.equal(await fs.readFile(path.join(root, 'keep.md'), 'utf8'), 'original');
  const names = await fs.readdir(root);
  assert.deepEqual(names, ['keep.md'], 'failed write must clean up its temp file');
});

test('writeMarkdown: rejects a missing parent directory with ENOENT', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.writeMarkdown('missing/note.md', 'x'),
    (err) => err instanceof VaultError && err.code === 'ENOENT'
  );
  await assert.rejects(() => fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
});

test('writeMarkdown: rejects non-string content with INVALID_CONTENT', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.writeMarkdown('note.md', Buffer.from('nope')),
    (err) => err instanceof VaultError && err.code === 'INVALID_CONTENT'
  );
  await assert.rejects(
    () => vault.writeMarkdown('note.md', null),
    (err) => err instanceof VaultError && err.code === 'INVALID_CONTENT'
  );
});

test('writeMarkdown: rejects a non-Markdown target with NOT_MARKDOWN', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.writeMarkdown('note.txt', 'x'),
    (err) => err instanceof VaultError && err.code === 'NOT_MARKDOWN'
  );
  await assert.rejects(() => fs.stat(path.join(root, 'note.txt')), { code: 'ENOENT' });
});

test('writeMarkdown: concurrent writers leave one complete note, never a partial one', async (t) => {
  const root = await makeVault();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const bigA = 'A'.repeat(200_000);
  const bigB = 'B'.repeat(200_000);
  await Promise.all([
    vault.writeMarkdown('race.md', bigA),
    vault.writeMarkdown('race.md', bigB)
  ]);

  const text = await fs.readFile(path.join(root, 'race.md'), 'utf8');
  assert.ok(text === bigA || text === bigB, 'file must be exactly one writer’s content');
  assert.deepEqual(await fs.readdir(root), ['race.md'], 'no temp files may remain');
});
