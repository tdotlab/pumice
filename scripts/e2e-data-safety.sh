#!/usr/bin/env bash
#
# Real-Electron data-safety check without a display server.
#
# Opens a throwaway vault containing UTF-8, latin-1 and UTF-16LE notes through
# the real preload/renderer/IPC, then exercises the dirty-close dialog. See
# scripts/e2e-data-safety.js for the individual checks.
#
# PUMICE_LOCAL_PREFIX works exactly like scripts/smoke-headless.sh.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ -n "${PUMICE_LOCAL_PREFIX:-}" ]]; then
  export LD_LIBRARY_PATH="$PUMICE_LOCAL_PREFIX/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export XDG_DATA_DIRS="$PUMICE_LOCAL_PREFIX/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
fi

exec ./node_modules/.bin/electron \
  --ozone-platform=headless \
  --disable-gpu \
  --no-sandbox \
  scripts/e2e-data-safety.js
