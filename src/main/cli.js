'use strict';

/**
 * Parse the small set of user-facing startup flags. Electron passes its own
 * switches (and the app path) through argv, so unknown entries are ignored on
 * purpose instead of failing startup.
 */
function parseArgs(argv = []) {
  const options = { smokeTest: false, devTools: false };
  for (const arg of argv) {
    if (arg === '--smoke-test') options.smokeTest = true;
    else if (arg === '--devtools') options.devTools = true;
  }
  return options;
}

module.exports = { parseArgs };
