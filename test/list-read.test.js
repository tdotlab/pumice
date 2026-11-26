'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { makeVault, remove, sha256 } = require('./helpers');
const { Vault, VaultError } = require('../src/index.js');

async function fixture() {
  return makeVault({
    'a.md': 'Alpha',
    'b.markdown': 'Bravo',
    'upper.MD': 'Upper',
    'notes/c.md': '# Charlie',
    'notes/deep/d.md': 'Deep',
    'notes/ignore.txt': 'not a note',
    'image.png': 'png bytes',
    '.hidden.md': 'hidden note',
    '.secret/hidden-note.md': 'inside hidden dir',
    'dir.md/inner.md': 'inside a directory named like a note',
    'uni.md': 'Ünïcode ✓\nsecond line\n'
  });
}

test('listMarkdown: lists Markdown recursively, sorted, without non-Markdown files', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const entries = await vault.listMarkdown();
  assert.deepEqual(entries.map((e) => e.relativePath), [
    'a.md',
    'b.markdown',
    'dir.md/inner.md',
    'notes/c.md',
    'notes/deep/d.md',
    'uni.md',
    'upper.MD'
  ]);
  for (const entry of entries) {
    assert.equal(typeof entry.size, 'number');
    assert.equal(typeof entry.mtimeMs, 'number');
    assert.ok(!('content' in entry), 'list entries should not include file contents');
  }
  const alpha = entries.find((e) => e.relativePath === 'a.md');
  assert.equal(alpha.size, Buffer.byteLength('Alpha'));
});

test('listMarkdown: non-recursive mode lists only the vault root', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const entries = await vault.listMarkdown({ recursive: false });
  assert.deepEqual(entries.map((e) => e.relativePath), ['a.md', 'b.markdown', 'uni.md', 'upper.MD']);
});

test('listMarkdown: hidden files and directories are skipped unless included', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const visible = await vault.listMarkdown();
  assert.ok(!visible.some((e) => e.relativePath.startsWith('.')));

  const all = await vault.listMarkdown({ includeHidden: true });
  assert.ok(all.some((e) => e.relativePath === '.hidden.md'));
  assert.ok(all.some((e) => e.relativePath === '.secret/hidden-note.md'));
});

test('listMarkdown: a directory whose name ends in .md is not reported as a note', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const entries = await vault.listMarkdown();
  assert.ok(!entries.some((e) => e.relativePath === 'dir.md'));
  assert.ok(entries.some((e) => e.relativePath === 'dir.md/inner.md'));
});

test('readMarkdown: returns content, hash version, size and mtime', async (t) => {
  const root = await makeVault({ 'uni.md': 'Ünïcode ✓\nsecond line\n' });
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  const content = 'Ünïcode ✓\nsecond line\n';
  const record = await vault.readMarkdown('uni.md');
  assert.equal(record.relativePath, 'uni.md');
  assert.equal(record.content, content);
  assert.equal(record.version, sha256(content));
  assert.equal(record.size, Buffer.byteLength(content));
  assert.equal(typeof record.mtimeMs, 'number');
});

test('readMarkdown: accepts .markdown and uppercase .MD extensions', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  assert.equal((await vault.readMarkdown('b.markdown')).content, 'Bravo');
  assert.equal((await vault.readMarkdown('upper.MD')).content, 'Upper');
});

test('readMarkdown: reads a hidden note when explicitly named', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  assert.equal((await vault.readMarkdown('.hidden.md')).content, 'hidden note');
});

test('readMarkdown: rejects a non-Markdown path with NOT_MARKDOWN before touching disk', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.readMarkdown('missing.txt'),
    (err) => err instanceof VaultError && err.code === 'NOT_MARKDOWN'
  );
});

test('readMarkdown: rejects a missing note with ENOENT', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.readMarkdown('nope.md'),
    (err) => err instanceof VaultError && err.code === 'ENOENT'
  );
});

test('readMarkdown: rejects a directory path with EISDIR', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(
    () => vault.readMarkdown('dir.md'),
    (err) => err instanceof VaultError && err.code === 'EISDIR'
  );
});

test('readMarkdown: rejects non-string and absolute paths', async (t) => {
  const root = await fixture();
  t.after(() => remove(root));
  const vault = await Vault.open(root);

  await assert.rejects(() => vault.readMarkdown(null), (err) => err.code === 'INVALID_PATH');
  await assert.rejects(() => vault.readMarkdown(path.join(root, 'a.md')), (err) => err.code === 'INVALID_PATH');
});
