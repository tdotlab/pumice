'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Create a fresh temporary directory (under os.tmpdir(), which honours TMPDIR)
 * and return its real path.
 */
async function makeTempDir(prefix = 'pumice-vault-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

/** Write a file, creating parent directories as needed. */
async function put(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/**
 * Build a temp directory populated with the given files.
 * Keys are vault-relative POSIX paths; values are file contents.
 */
async function makeVault(files = {}) {
  const root = await makeTempDir('pumice-vault-fixture-');
  for (const [rel, content] of Object.entries(files)) {
    await put(path.join(root, ...rel.split('/')), content);
  }
  return root;
}

/** Recursively remove a temp directory, ignoring missing paths. */
async function remove(dir) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true });
}

/** sha256 hex of UTF-8 text, matching the vault's `version` token. */
function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

module.exports = { makeTempDir, makeVault, put, remove, sha256, isRoot };
