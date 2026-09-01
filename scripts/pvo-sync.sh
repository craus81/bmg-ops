#!/bin/bash
# Wrapper so launchd (which has almost no PATH and no working directory) can run
# the sync. Works on any Mac — it locates the repo from its own path and finds
# node wherever Homebrew, nvm, or the system put it.
# Logs land in ~/.fleetsuite/pvo-sync.log.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.fleetsuite"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/pvo-sync.log"

# launchd gives us a bare PATH; add the usual node locations before looking.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/current/bin:$PATH"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  # nvm installs without a "current" symlink — take the newest version present.
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') pvo-sync: node not found on PATH ===" >> "$LOG"
  exit 127
fi

cd "$REPO" || exit 1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') pvo-sync starting ($REPO) ===" >> "$LOG"
"$NODE" scripts/pvo-sync.mjs "$@" >> "$LOG" 2>&1
STATUS=$?
echo "=== exited $STATUS ===" >> "$LOG"

# Keep the log from growing forever.
tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $STATUS
