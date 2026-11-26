'use strict';

/**
 * Scratch copy of the smoke-test vault.
 *
 * The app-level smoke run must never edit a fixture in the repository (or, far
 * worse, a real user vault). It copies a small committed fixture vault into a
 * fresh directory under the OS temp dir, exercises open/edit/save there, and
 * removes the copy when the app quits.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'smoke-vault');

/** True only for a descendant of `root` (not root itself, not a sibling). */
function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Copy the fixture vault into a fresh temp directory. */
async function copyFixtureVault({ destination } = {}) {
  const ownedDestination = destination === undefined;
  const target = destination ?? path.join(os.tmpdir(), `pumice-smoke-${randomUUID()}`);
  let root;
  try {
    await fsp.cp(FIXTURE_DIR, target, { recursive: true, errorOnExist: true, force: false });
    root = await fsp.realpath(target);
  } catch (error) {
    // Only remove a temp directory this function created, never a caller's.
    if (ownedDestination) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return {
    root,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      // Synchronous so it can run from a 'will-quit' handler.
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { FIXTURE_DIR, copyFixtureVault, isInside };
