'use strict';

/**
 * Public entry point for the Pumice vault storage core.
 *
 * The desktop main process should require this module (never the renderer):
 * the renderer reaches it through IPC handlers in the main process.
 */
const {
  Vault,
  VaultError,
  VaultSecurityError,
  VaultConflictError,
  DEFAULT_EXTENSIONS
} = require('./vault.js');

module.exports = {
  Vault,
  VaultError,
  VaultSecurityError,
  VaultConflictError,
  DEFAULT_EXTENSIONS
};
