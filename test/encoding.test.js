'use strict';

/**
 * Encoding policy: a note whose bytes are not valid UTF-8 is refused on read
 * and never rewritten. Decoding such a file with `buffer.toString('utf8')`
 * turns every invalid byte into U+FFFD, so opening the decoded text in an
 * editor and saving it back would destroy the original content. These tests
 * pin the refusal (`INVALID_ENCODING`), the listing flag and byte-preservation
 * for the UTF-8 cases that must keep working unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { makeVault, remove, sha256 } = require('./helpers');
const { Vault, VaultError } = require('../src/index.js');

const LATIN1 = Buffer.from('café note\n', 'latin1'); // 0xE9 is not valid UTF-8
const UTF16LE = Buffer.from('\ufeffutf16 note\n', 'utf16le');
const UTF16BE = Buffer.from(
  Uint8Array.from(UTF16LE).map((byte, index, all) =>
    index % 2 === 0 ? all[index + 1] : all[index - 1]
  )
);
const UTF8_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n', 'utf8')]);
const CRLF = Buffer.from('line one\r\nline two\r\n', 'utf8');

async function vaultWith(files) {
  const root = await makeVault(files);
  return { root, vault: await Vault.open(root) };
}

function isEncodingError(error) {
  return error instanceof VaultError && error.code === 'INVALID_ENCODING';
}

test('readMarkdown: refuses a latin-1 note with INVALID_ENCODING and leaves its bytes alone', async (t) => {
  const { root, vault } = await vaultWith({ 'notes/latin1.md': LATIN1 });
  t.after(() => remove(root));

  await assert.rejects(
    () => vault.readMarkdown('notes/latin1.md'),
    (error) => {
      assert.ok(isEncodingError(error), `expected INVALID_ENCODING, got ${error.code}`);
      assert.equal(error.path, 'notes/latin1.md');
      assert.match(error.message, /UTF-8/i);
      return true;
    }
  );
  assert.deepEqual(await fs.readFile(path.join(root, 'notes/latin1.md')), LATIN1);
});

test('readMarkdown: refuses UTF-16LE and UTF-16BE notes with a BOM', async (t) => {
  const { root, vault } = await vaultWith({
    'le.md': UTF16LE,
    'be.md': UTF16BE,
  });
  t.after(() => remove(root));

  await assert.rejects(() => vault.readMarkdown('le.md'), isEncodingError);
  await assert.rejects(() => vault.readMarkdown('be.md'), isEncodingError);
  assert.deepEqual(await fs.readFile(path.join(root, 'le.md')), UTF16LE);
  assert.deepEqual(await fs.readFile(path.join(root, 'be.md')), UTF16BE);
});

test('readMarkdown: UTF-8 with a BOM still decodes and its version is the byte hash', async (t) => {
  const { root, vault } = await vaultWith({ 'bom.md': UTF8_BOM });
  t.after(() => remove(root));

  const note = await vault.readMarkdown('bom.md');
  assert.equal(note.content, '\ufeffhello\n');
  assert.equal(note.version, sha256(Buffer.from('\ufeffhello\n', 'utf8')));
  assert.equal(note.size, UTF8_BOM.length);
});

test('listMarkdown: reports utf8 false for notes that are not UTF-8 and true for the rest', async (t) => {
  const { root, vault } = await vaultWith({
    'good.md': 'plain utf8\n',
    'bom.md': UTF8_BOM,
    'crlf.md': CRLF,
    'latin1.md': LATIN1,
    'nested/utf16.md': UTF16LE,
  });
  t.after(() => remove(root));

  const entries = await vault.listMarkdown();
  const byPath = Object.fromEntries(entries.map((entry) => [entry.relativePath, entry]));

  assert.deepEqual(entries.map((entry) => entry.relativePath), [
    'bom.md',
    'crlf.md',
    'good.md',
    'latin1.md',
    'nested/utf16.md',
  ]);
  assert.equal(byPath['good.md'].utf8, true);
  assert.equal(byPath['bom.md'].utf8, true);
  assert.equal(byPath['crlf.md'].utf8, true);
  assert.equal(byPath['latin1.md'].utf8, false);
  assert.equal(byPath['nested/utf16.md'].utf8, false);
  // Size and mtime keep their old meaning even for refused notes.
  assert.equal(byPath['latin1.md'].size, LATIN1.length);
  assert.equal(typeof byPath['latin1.md'].mtimeMs, 'number');
});

test('writeMarkdown: refuses to rewrite a non-UTF-8 note even without an expected version', async (t) => {
  const { root, vault } = await vaultWith({ 'latin1.md': LATIN1 });
  t.after(() => remove(root));

  await assert.rejects(
    () => vault.writeMarkdown('latin1.md', 'café note\n'),
    (error) => isEncodingError(error) && error.path === 'latin1.md'
  );
  assert.deepEqual(await fs.readFile(path.join(root, 'latin1.md')), LATIN1);
});

test('writeMarkdown: refuses a UTF-16 note whose version the caller supplies', async (t) => {
  const { root, vault } = await vaultWith({ 'utf16.md': UTF16LE });
  t.after(() => remove(root));

  await assert.rejects(
    () => vault.writeMarkdown('utf16.md', '\ufeffutf16 note\n', {
      expectedVersion: sha256(UTF16LE),
    }),
    isEncodingError
  );
  assert.deepEqual(await fs.readFile(path.join(root, 'utf16.md')), UTF16LE);
});

test('writing back text decoded from a UTF-8 note stays byte-identical (BOM and CRLF)', async (t) => {
  const { root, vault } = await vaultWith({ 'bom.md': UTF8_BOM, 'crlf.md': CRLF });
  t.after(() => remove(root));

  for (const [name, bytes] of [['bom.md', UTF8_BOM], ['crlf.md', CRLF]]) {
    const note = await vault.readMarkdown(name);
    const saved = await vault.writeMarkdown(name, note.content, { expectedVersion: note.version });
    assert.equal(saved.version, sha256(bytes), name);
    assert.deepEqual(await fs.readFile(path.join(root, name)), bytes, name);
  }
});

test('a new non-UTF-8 note is never created by writeMarkdown from decoded text', async (t) => {
  // A save cannot invent a non-UTF-8 file: writeMarkdown always encodes UTF-8.
  const { root, vault } = await vaultWith({});
  t.after(() => remove(root));

  await vault.writeMarkdown('fresh.md', 'café\n');
  assert.deepEqual(await fs.readFile(path.join(root, 'fresh.md')), Buffer.from('café\n', 'utf8'));
  assert.equal((await vault.readMarkdown('fresh.md')).content, 'café\n');
});
