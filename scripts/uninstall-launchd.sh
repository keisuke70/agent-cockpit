#!/usr/bin/env bash
set -euo pipefail

LABEL="com.kei.agent-cockpit"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST_DEST" ]; then
  echo "==> Unloading $LABEL"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "==> Removed $PLIST_DEST"
else
  echo "==> $PLIST_DEST not present, nothing to do"
fi

echo "==> Done. Data files at ~/Library/Application Support/agent-cockpit/ and"
echo "    logs at ~/Library/Logs/agent-cockpit/ are preserved."
