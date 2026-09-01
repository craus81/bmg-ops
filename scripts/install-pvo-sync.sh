#!/bin/bash
# Installs (or reinstalls) the nightly PVO sync on this Mac.
# Safe to re-run: it rewrites the schedule and reloads it.
#
#   ./scripts/install-pvo-sync.sh            # default 6:05am
#   ./scripts/install-pvo-sync.sh 21 30      # or pick your own hour/minute
set -eu

HOUR="${1:-6}"
MINUTE="${2:-5}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.bmgfleet.pvo-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.fleetsuite"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$REPO/scripts/pvo-sync.sh</string>
    </array>

    <!-- Daily at $HOUR:$(printf '%02d' "$MINUTE"). If the Mac was asleep, launchd runs it on wake. -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>$HOUR</integer>
        <key>Minute</key><integer>$MINUTE</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>$HOME/.fleetsuite/pvo-sync.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.fleetsuite/pvo-sync.launchd.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed $LABEL — runs daily at $HOUR:$(printf '%02d' "$MINUTE")"
echo "  repo:  $REPO"
echo "  logs:  $HOME/.fleetsuite/pvo-sync.log"
echo "  stop:  launchctl unload $PLIST"
