'use strict';

/**
 * Pumice vault storage core.
 *
 * A small, GUI-independent module that owns every filesystem operation the
 * desktop app performs on a plain-Markdown vault. See docs/API.md for the
 * public contract; the short version:
 *
 *   const { Vault } = require('pumice-vault-core');
 *   const vault = await Vault.open('/path/to/vault');
 *   await vault.listMarkdown();
 *   const note = await vault.readMarkdown('notes/today.md');
 *   await vault.writeMarkdown('notes/today.md', '# today', {
 *     expectedVersion: note.version
 *   });
 *
 * Safety properties:
 *  - Every note path is resolved and confined to the vault root, rejecting
 *    absolute paths, `..` traversal and symlink escapes.
 *  - Writes go to a temporary file in the destination directory, are fsync'd,
 *    and then atomically renamed over the target, so a crash or failure never
 *    leaves a truncated note. Existing contents survive any failed write.
 *  - Reads return a `version` token (sha256 of the bytes); writes may require
 *    it, so a note changed by another program since the read is reported as a
 *    conflict instead of being silently overwritten.
 *  - Notes that are not valid UTF-8 are refused (`INVALID_ENCODING`) instead of
 *    being decoded lossily: `buffer.toString('utf8')` maps every invalid byte
 *    to U+FFFD, and saving that text back would destroy the original bytes.
 *    Such notes are still listed, flagged `utf8: false`, and never rewritten.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');

const DEFAULT_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdown', '.mkd']);

const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

/** Base error for every failure this module raises deliberately. */
class VaultError extends Error {
  constructor(message, { code = 'VAULT_ERROR', path: relPath = null, cause = null, ...extra } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'VaultError';
    this.code = code;
    this.path = relPath;
    Object.assign(this, extra);
  }
}

/** A path, symlink or NUL-byte attempt tried to escape the vault root. */
class VaultSecurityError extends VaultError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'SECURITY' });
    this.name = 'VaultSecurityError';
  }
}

/** A note whose bytes are not valid UTF-8; decoding it would lose data. */
class VaultEncodingError extends VaultError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'INVALID_ENCODING' });
    this.name = 'VaultEncodingError';
  }
}

/** A note changed or disappeared outside the application since it was read. */
class VaultConflictError extends VaultError {
  constructor(message, {
    reason,
    expectedVersion = null,
    actualVersion = null,
    expectedMtimeMs = null,
    actualMtimeMs = null,
    path: relPath = null
  } = {}) {
    super(message, { code: 'CONFLICT', path: relPath });
    this.name = 'VaultConflictError';
    this.reason = reason;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
    this.expectedMtimeMs = expectedMtimeMs;
    this.actualMtimeMs = actualMtimeMs;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Decode note bytes as UTF-8, or refuse. `Buffer#toString('utf8')` replaces
 * every invalid sequence with U+FFFD, which is fine for display but fatal for
 * a note that can be saved back, so this is checked first.
 */
function decodeUtf8(buffer, apiPath) {
  if (!isUtf8(buffer)) {
    throw new VaultEncodingError(
      `Note is not valid UTF-8: ${apiPath} (its bytes would be rewritten)`,
      { path: apiPath }
    );
  }
  return buffer.toString('utf8');
}

function relativeEscape(root, candidate) {
  const rel = path.relative(root, candidate);
  if (rel === '') return false;
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function isWithinOrEqual(root, candidate) {
  return !relativeEscape(root, candidate);
}

function isStrictlyWithin(root, candidate) {
  return path.relative(root, candidate) !== '' && !relativeEscape(root, candidate);
}

function toApiPath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function normalizeExtensions(extensions) {
  const list = extensions === undefined ? DEFAULT_EXTENSIONS : extensions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new VaultError('extensions must be a non-empty array of strings', { code: 'INVALID_OPTIONS' });
  }
  const normalized = list.map((ext) => {
    if (typeof ext !== 'string' || ext.trim() === '') {
      throw new VaultError('each extension must be a non-empty string', { code: 'INVALID_OPTIONS' });
    }
    const trimmed = ext.trim().toLowerCase();
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  });
  return Object.freeze([...new Set(normalized)]);
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Read a file refusing to follow a symlink at the final component, so a
 * last-moment swap cannot redirect the read outside the vault.
 */
async function readFileNoFollow(target, apiPath) {
  let handle = null;
  try {
    handle = await fsp.open(target, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP') {
      throw new VaultSecurityError(`Refusing to follow a symlink: ${apiPath}`, { path: apiPath });
    }
    throw err;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function fsyncDirectoryBestEffort(dir) {
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some filesystems/platforms. The rename
    // itself is already atomic; durability of the directory entry is best effort.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

class Vault {
  /**
   * Validate and open a vault directory.
   *
   * @param {string} rootPath absolute path picked by the user (relative paths
   *   are resolved against the process cwd; prefer absolute).
   * @param {{ extensions?: string[] }} [options]
   * @returns {Promise<Vault>}
   */
  static async open(rootPath, options = {}) {
    if (typeof rootPath !== 'string' || rootPath.trim() === '') {
      throw new VaultError('Vault path must be a non-empty string', { code: 'INVALID_PATH' });
    }
    if (rootPath.includes('\0')) {
      throw new VaultError('Vault path must not contain NUL bytes', { code: 'INVALID_PATH' });
    }
    const absolute = path.resolve(rootPath);

    let stat;
    try {
      stat = await fsp.stat(absolute);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new VaultError(`Vault directory does not exist: ${absolute}`, { code: 'ENOENT', cause: err });
      }
      throw new VaultError(`Cannot access vault directory: ${err.message}`, {
        code: err.code || 'EACCES',
        cause: err
      });
    }
    if (!stat.isDirectory()) {
      throw new VaultError(`Vault path is not a directory: ${absolute}`, { code: 'ENOTDIR' });
    }

    let realRoot;
    try {
      realRoot = await fsp.realpath(absolute);
    } catch (err) {
      throw new VaultError(`Cannot resolve vault directory: ${err.message}`, {
        code: err.code || 'EACCES',
        cause: err
      });
    }

    try {
      await fsp.access(realRoot, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      throw new VaultError(`Vault directory is not readable: ${err.message}`, {
        code: err.code || 'EACCES',
        cause: err
      });
    }

    return new Vault(realRoot, options);
  }

  constructor(root, options = {}) {
    this.root = root;
    this.extensions = normalizeExtensions(options.extensions);
  }

  /** True when a vault-relative path has a configured Markdown extension. */
  isMarkdown(relPath) {
    return this.extensions.includes(path.extname(relPath).toLowerCase());
  }

  /**
   * List Markdown notes, sorted by relative path.
   *
   * `utf8` is `false` when a note's bytes are not valid UTF-8 (the note is
   * listed but cannot be opened or saved without rewriting its bytes) and
   * `null` when the bytes could not be inspected. Detecting this costs one
   * read per note; that is the price of never silently corrupting a file.
   *
   * @param {{ recursive?: boolean, includeHidden?: boolean }} [options]
   * @returns {Promise<Array<{relativePath: string, size: number, mtimeMs: number, utf8: boolean|null}>>}
   */
  async listMarkdown(options = {}) {
    const recursive = options.recursive !== false;
    const includeHidden = options.includeHidden === true;
    const entries = [];

    const walk = async (dirAbsolute, relBase) => {
      let dirents;
      try {
        dirents = await fsp.readdir(dirAbsolute, { withFileTypes: true });
      } catch (err) {
        if (dirAbsolute === this.root) {
          throw new VaultError(`Cannot read vault directory: ${err.message}`, {
            code: err.code || 'EACCES',
            cause: err
          });
        }
        return; // A subdirectory removed mid-walk is simply skipped.
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue; // never traverse or list symlinks
        if (!includeHidden && dirent.name.startsWith('.')) continue;

        const absolute = path.join(dirAbsolute, dirent.name);
        const relPath = relBase ? `${relBase}/${dirent.name}` : dirent.name;

        if (dirent.isDirectory()) {
          if (recursive) await walk(absolute, relPath);
          continue;
        }
        if (!dirent.isFile() || !this.isMarkdown(dirent.name)) continue;

        try {
          // lstat (not stat) so a file swapped for a symlink mid-walk is skipped.
          const stat = await fsp.lstat(absolute);
          if (stat.isFile() && !stat.isSymbolicLink()) {
            let utf8 = null;
            try {
              utf8 = isUtf8(await readFileNoFollow(absolute, relPath));
            } catch (readError) {
              if (readError.code === 'ENOENT' || readError instanceof VaultSecurityError) continue;
              // Unreadable but still listed: the encoding is simply unknown.
            }
            entries.push({ relativePath: relPath, size: stat.size, mtimeMs: stat.mtimeMs, utf8 });
          }
        } catch (err) {
          if (err.code !== 'ENOENT') throw err; // deleted mid-walk: skip it
        }
      }
    };

    await walk(this.root, '');
    entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    return entries;
  }

  /**
   * Read one Markdown note.
   *
   * @param {string} relPath vault-relative path, POSIX separators
   * @returns {Promise<{relativePath: string, content: string, version: string, size: number, mtimeMs: number}>}
   */
  async readMarkdown(relPath) {
    const { target, apiPath } = this.#resolveNote(relPath);
    if (!this.isMarkdown(apiPath)) {
      throw new VaultError(`Not a Markdown note: ${apiPath}`, { code: 'NOT_MARKDOWN', path: apiPath });
    }

    const { buffer, stat } = await this.#readExistingFile(target, apiPath);
    return {
      relativePath: apiPath,
      content: decodeUtf8(buffer, apiPath),
      version: sha256(buffer),
      size: buffer.length,
      mtimeMs: stat.mtimeMs
    };
  }

  /**
   * Atomically create or overwrite one Markdown note.
   *
   * @param {string} relPath vault-relative path, POSIX separators
   * @param {string} content UTF-8 text
   * @param {{ expectedVersion?: string, expectedMtimeMs?: number }} [options]
   *   Provide `expectedVersion` (preferred) or `expectedMtimeMs` from a prior
   *   read to require that the note has not changed since; a mismatch raises
   *   VaultConflictError and the on-disk note is left untouched.
   * @returns {Promise<{relativePath: string, version: string, size: number, mtimeMs: number}>}
   */
  async writeMarkdown(relPath, content, options = {}) {
    if (typeof content !== 'string') {
      throw new VaultError('Note content must be a string', {
        code: 'INVALID_CONTENT',
        path: typeof relPath === 'string' ? relPath : null
      });
    }
    const { target, apiPath } = this.#resolveNote(relPath);
    if (!this.isMarkdown(apiPath)) {
      throw new VaultError(`Not a Markdown note: ${apiPath}`, { code: 'NOT_MARKDOWN', path: apiPath });
    }

    const expectedVersion = options.expectedVersion ?? null;
    const expectedMtimeMs = options.expectedMtimeMs ?? null;
    if (expectedVersion !== null && typeof expectedVersion !== 'string') {
      throw new VaultError('expectedVersion must be a string when provided', { code: 'INVALID_OPTIONS', path: apiPath });
    }
    if (expectedMtimeMs !== null && typeof expectedMtimeMs !== 'number') {
      throw new VaultError('expectedMtimeMs must be a number when provided', { code: 'INVALID_OPTIONS', path: apiPath });
    }

    const parent = path.dirname(target);
    let parentReal;
    try {
      parentReal = await fsp.realpath(parent);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        throw new VaultError(`Parent directory does not exist for ${apiPath}`, {
          code: 'ENOENT',
          path: apiPath,
          cause: err
        });
      }
      throw new VaultError(`Cannot access parent directory for ${apiPath}: ${err.message}`, {
        code: err.code || 'EACCES',
        path: apiPath,
        cause: err
      });
    }
    if (!isWithinOrEqual(this.root, parentReal)) {
      throw new VaultSecurityError(`Parent directory escapes the vault: ${apiPath}`, { path: apiPath });
    }

    let existingStat = null;
    let existingBuffer = null;
    try {
      existingStat = await lstatOrNull(target);
      if (existingStat) {
        if (existingStat.isSymbolicLink()) {
          throw new VaultSecurityError(`Refusing to write through a symlink: ${apiPath}`, { path: apiPath });
        }
        if (existingStat.isDirectory()) {
          throw new VaultError(`Path is a directory, not a note: ${apiPath}`, { code: 'EISDIR', path: apiPath });
        }
        if (!existingStat.isFile()) {
          throw new VaultError(`Path is not a regular file: ${apiPath}`, { code: 'INVALID_TARGET', path: apiPath });
        }
        existingBuffer = await readFileNoFollow(target, apiPath);
      }
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError(`Cannot read current note ${apiPath}: ${err.message}`, {
        code: err.code || 'READ_FAILED',
        path: apiPath,
        cause: err
      });
    }

    // Never re-encode a note whose current bytes are not UTF-8: the decoded
    // text a caller holds cannot represent them, so any save would corrupt it.
    if (existingStat && !isUtf8(existingBuffer)) {
      throw new VaultEncodingError(
        `Refusing to rewrite a note that is not valid UTF-8: ${apiPath}`,
        { path: apiPath }
      );
    }

    if (expectedVersion !== null) {
      if (!existingStat) {
        throw new VaultConflictError(`Note was deleted outside Pumice: ${apiPath}`, {
          reason: 'deleted',
          expectedVersion,
          path: apiPath
        });
      }
      const actualVersion = sha256(existingBuffer);
      if (actualVersion !== expectedVersion) {
        throw new VaultConflictError(`Note changed outside Pumice: ${apiPath}`, {
          reason: 'modified',
          expectedVersion,
          actualVersion,
          actualMtimeMs: existingStat.mtimeMs,
          path: apiPath
        });
      }
    } else if (expectedMtimeMs !== null) {
      if (!existingStat) {
        throw new VaultConflictError(`Note was deleted outside Pumice: ${apiPath}`, {
          reason: 'deleted',
          expectedMtimeMs,
          path: apiPath
        });
      }
      if (existingStat.mtimeMs !== expectedMtimeMs) {
        throw new VaultConflictError(`Note changed outside Pumice: ${apiPath}`, {
          reason: 'modified',
          expectedMtimeMs,
          actualMtimeMs: existingStat.mtimeMs,
          path: apiPath
        });
      }
    }

    const buffer = Buffer.from(content, 'utf8');
    const tempPath = path.join(parent, `.pumice-${crypto.randomUUID()}.tmp`);
    let handle = null;
    try {
      // Create the sibling temp file exclusively; never reuse or follow links.
      handle = await fsp.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        existingStat ? 0o600 : 0o666
      );
      await handle.writeFile(buffer);
      if (existingStat) await handle.chmod(existingStat.mode & 0o777);
      await handle.sync();
      await handle.close();
      handle = null;

      // Atomic replace: readers see either the old or the new complete note.
      await fsp.rename(tempPath, target);
      await fsyncDirectoryBestEffort(parent);
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(tempPath).catch(() => {});
      if (err instanceof VaultError) throw err;
      throw new VaultError(`Failed to write note ${apiPath}: ${err.message}`, {
        code: err.code || 'WRITE_FAILED',
        path: apiPath,
        cause: err
      });
    }

    let finalStat;
    try {
      finalStat = await fsp.stat(target);
    } catch (err) {
      throw new VaultError(`Note was written but cannot be stat'ed: ${err.message}`, {
        code: err.code || 'WRITE_FAILED',
        path: apiPath,
        cause: err
      });
    }

    return {
      relativePath: apiPath,
      version: sha256(buffer),
      size: buffer.length,
      mtimeMs: finalStat.mtimeMs
    };
  }

  #resolveNote(relPath) {
    if (typeof relPath !== 'string') {
      throw new VaultError('Note path must be a string', { code: 'INVALID_PATH' });
    }
    if (relPath === '') {
      throw new VaultError('Note path must not be empty', { code: 'INVALID_PATH' });
    }
    if (relPath.includes('\0')) {
      throw new VaultError('Note path must not contain NUL bytes', { code: 'INVALID_PATH' });
    }
    if (path.isAbsolute(relPath)) {
      throw new VaultError(`Note path must be relative to the vault: ${relPath}`, {
        code: 'INVALID_PATH',
        path: relPath
      });
    }

    const target = path.resolve(this.root, relPath);
    if (!isStrictlyWithin(this.root, target)) {
      throw new VaultSecurityError(`Note path escapes the vault: ${relPath}`, { path: relPath });
    }
    return { target, apiPath: toApiPath(this.root, target) };
  }

  async #readExistingFile(target, apiPath) {
    const stat = await lstatOrNull(target);
    if (!stat) {
      throw new VaultError(`Note not found: ${apiPath}`, { code: 'ENOENT', path: apiPath });
    }
    if (stat.isSymbolicLink()) {
      throw new VaultSecurityError(`Refusing to read a symlink inside the vault: ${apiPath}`, { path: apiPath });
    }
    if (stat.isDirectory()) {
      throw new VaultError(`Path is a directory, not a note: ${apiPath}`, { code: 'EISDIR', path: apiPath });
    }
    if (!stat.isFile()) {
      throw new VaultError(`Path is not a regular file: ${apiPath}`, { code: 'INVALID_TARGET', path: apiPath });
    }

    try {
      const real = await fsp.realpath(target);
      if (!isStrictlyWithin(this.root, real)) {
        throw new VaultSecurityError(`Note path escapes the vault: ${apiPath}`, { path: apiPath });
      }
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError(`Cannot resolve note ${apiPath}: ${err.message}`, {
        code: err.code || 'READ_FAILED',
        path: apiPath,
        cause: err
      });
    }

    let handle = null;
    try {
      handle = await fsp.open(target, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ELOOP') {
        throw new VaultSecurityError(`Refusing to follow a symlink: ${apiPath}`, { path: apiPath });
      }
      throw new VaultError(`Cannot read note ${apiPath}: ${err.message}`, {
        code: err.code || 'READ_FAILED',
        path: apiPath,
        cause: err
      });
    }

    try {
      const handleStat = await handle.stat();
      if (!handleStat.isFile()) {
        throw new VaultError(`Path is not a regular file: ${apiPath}`, { code: 'INVALID_TARGET', path: apiPath });
      }
      const buffer = await handle.readFile();
      return { buffer, stat: handleStat };
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError(`Cannot read note ${apiPath}: ${err.message}`, {
        code: err.code || 'READ_FAILED',
        path: apiPath,
        cause: err
      });
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

module.exports = {
  Vault,
  VaultError,
  VaultSecurityError,
  VaultConflictError,
  VaultEncodingError,
  DEFAULT_EXTENSIONS
};
