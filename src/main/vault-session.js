'use strict';

/**
 * Main-process vault session.
 *
 * The renderer never touches the filesystem. This module owns the one open
 * vault and exposes a small, serialisable API to the IPC layer:
 *
 *   const session = new VaultSession();
 *   await session.open('/path/to/copied/vault');
 *   await session.list();
 *   const note = await session.read('notes/today.md');
 *   await session.write('notes/today.md', '# today', { expectedVersion: note.version });
 *
 * It is a thin adapter over the tested vault core (src/vault.js): every safety
 * property — path confinement, atomic writes, conflict detection — lives
 * there. The session adds the "one open vault" state and display metadata for
 * the renderer.
 */

const path = require('node:path');
const { Vault, VaultError } = require('../index.js');

const NO_VAULT_CODE = 'NO_VAULT';
const NOTE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.mdown', '.mkd']);

function displayName(relPath) {
  const parts = relPath.split('/');
  return parts[parts.length - 1] || relPath;
}

function noteSummary(relativePath, stat) {
  return {
    path: relativePath,
    name: displayName(relativePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

class VaultSession {
  #vault = null;

  constructor({ VaultClass = Vault } = {}) {
    this.VaultClass = VaultClass;
  }

  get isOpen() {
    return this.#vault !== null;
  }

  get root() {
    return this.#vault ? this.#vault.root : null;
  }

  get name() {
    return this.#vault ? path.basename(this.#vault.root) : null;
  }

  get info() {
    return this.#vault ? { name: this.name, root: this.root } : null;
  }

  /**
   * Open a user-selected vault directory, replacing any vault already open.
   * A failed open leaves the previous vault untouched.
   */
  async open(rootPath, options = {}) {
    const vault = await this.VaultClass.open(rootPath, {
      extensions: options.extensions ?? NOTE_EXTENSIONS,
    });
    this.#vault = vault;
    return { name: path.basename(vault.root), root: vault.root };
  }

  close() {
    this.#vault = null;
  }

  /** @returns {Promise<Array<{path: string, name: string, size: number, mtimeMs: number}>>} */
  async list() {
    const entries = await this.#requireVault().listMarkdown();
    return entries.map((entry) => noteSummary(entry.relativePath, entry));
  }

  /** @returns {Promise<{path: string, name: string, content: string, version: string, size: number, mtimeMs: number}>} */
  async read(relPath) {
    const note = await this.#requireVault().readMarkdown(relPath);
    return {
      path: note.relativePath,
      name: displayName(note.relativePath),
      content: note.content,
      version: note.version,
      size: note.size,
      mtimeMs: note.mtimeMs,
    };
  }

  /**
   * @param {string} relPath
   * @param {string} content
   * @param {{expectedVersion?: string|null}} [options] omit or pass null for an
   *   explicit unchecked overwrite (the UI only does this after the user has
   *   confirmed a conflict).
   */
  async write(relPath, content, options = {}) {
    const expectedVersion = options.expectedVersion ?? null;
    const writeOptions = expectedVersion === null ? {} : { expectedVersion };
    const written = await this.#requireVault().writeMarkdown(relPath, content, writeOptions);
    return {
      path: written.relativePath,
      name: displayName(written.relativePath),
      version: written.version,
      size: written.size,
      mtimeMs: written.mtimeMs,
    };
  }

  /**
   * Current on-disk metadata for a note, or null when it no longer exists.
   * Used by the renderer to notice external edits without reading the body.
   */
  async stat(relPath) {
    const vault = this.#requireVault();
    try {
      const note = await vault.readMarkdown(relPath);
      return {
        path: note.relativePath,
        name: displayName(note.relativePath),
        version: note.version,
        size: note.size,
        mtimeMs: note.mtimeMs,
      };
    } catch (error) {
      if (error instanceof VaultError && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #requireVault() {
    if (!this.#vault) {
      throw new VaultError('No vault is open', { code: NO_VAULT_CODE });
    }
    return this.#vault;
  }
}

module.exports = { NO_VAULT_CODE, NOTE_EXTENSIONS, VaultSession };
