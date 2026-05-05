#!/usr/bin/env bash
set -euo pipefail

LABEL="com.kei.agent-cockpit"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agent-cockpit"
SERVER_ENTRY="$REPO_ROOT/packages/server/dist/index.js"

if [ ! -f "$PLIST_DEST" ]; then
  echo "ERROR: launchd plist is not installed at $PLIST_DEST" >&2
  echo "Run: bash scripts/install-launchd.sh" >&2
  exit 1
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "ERROR: server build is missing: $SERVER_ENTRY" >&2
  echo "Run: npm run build" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

if launchctl list | grep -q "$LABEL"; then
  echo "==> Unloading existing $LABEL"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
else
  echo "==> $LABEL is not currently loaded; loading from plist"
fi

# If an old process was left behind outside launchd, remove only this repo's server entry.
leftover_pids="$(pgrep -f "node .*${SERVER_ENTRY}" || true)"
if [ -n "$leftover_pids" ]; then
  echo "==> Stopping leftover server process(es): $leftover_pids"
  kill $leftover_pids 2>/dev/null || true
  sleep 1
fi

# Ensure launchd sees the latest plist contents, then start the freshly built server.
echo "==> Loading $LABEL"
launchctl load "$PLIST_DEST"

sleep 1
if ! launchctl list | grep -q "$LABEL"; then
  echo "ERROR: launchd did not start $LABEL. Check $LOG_DIR/launchd.err.log" >&2
  exit 1
fi

if curl -fsS http://127.0.0.1:3001/api/health >/dev/null; then
  echo "==> agent-cockpit restarted: http://127.0.0.1:3001"
else
  echo "WARNING: launchd loaded $LABEL, but /api/health did not respond yet." >&2
  echo "Check logs: $LOG_DIR/launchd.err.log" >&2
fi
