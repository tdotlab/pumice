#!/usr/bin/env bash
#
# Run the real Electron shell without a display server.
#
# Chromium's Ozone headless platform still needs the same shared libraries as
# the normal app (notably GTK 3). On a machine where those libraries are not
# installed system-wide, point PUMICE_LOCAL_PREFIX at a directory that
# contains usr/lib/x86_64-linux-gnu and usr/share (for example an extracted
# Debian libgtk-3 runtime). No vault is opened by this script.
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
  . \
  --smoke-test
