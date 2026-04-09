#!/usr/bin/env bash
set -euo pipefail

# Install agent-cockpit as a launchd user agent so it runs on Mac startup.
# Idempotent: re-running unloads the previous version first.

LABEL="com.kei.agent-cockpit"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_TEMPLATE="$REPO_ROOT/scripts/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agent-cockpit"

if [ ! -f "$PLIST_TEMPLATE" ]; then
  echo "ERROR: plist template not found at $PLIST_TEMPLATE" >&2
  exit 1
fi

echo "==> Creating log directory: $LOG_DIR"
mkdir -p "$LOG_DIR"

echo "==> Building server, shared, and web packages"
cd "$REPO_ROOT"
npm run build -w @agent-cockpit/shared
npm run build -w @agent-cockpit/server
npm run build -w @agent-cockpit/web

if [ ! -f "$REPO_ROOT/packages/server/dist/index.js" ]; then
  echo "ERROR: server build did not produce dist/index.js" >&2
  exit 1
fi

echo "==> Rendering plist with REPO_ROOT=$REPO_ROOT, USER=$USER"
mkdir -p "$HOME/Library/LaunchAgents"
sed \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__USER__|$USER|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"

if launchctl list | grep -q "$LABEL"; then
  echo "==> Unloading existing $LABEL"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

echo "==> Loading $LABEL"
launchctl load "$PLIST_DEST"

sleep 1
if launchctl list | grep -q "$LABEL"; then
  echo "==> agent-cockpit is running under launchd"
  echo "    plist:    $PLIST_DEST"
  echo "    logs:     $LOG_DIR/launchd.{out,err}.log"
  echo "    server:   http://127.0.0.1:3001"
  echo
  if [ -f "$HOME/Library/Application Support/agent-cockpit/auth-token" ]; then
    echo "    Auth token: $(cat "$HOME/Library/Application Support/agent-cockpit/auth-token")"
  else
    echo "    Auth token will be generated on first request - check the token file:"
    echo "    $HOME/Library/Application Support/agent-cockpit/auth-token"
  fi
else
  echo "ERROR: launchd did not start $LABEL. Check $LOG_DIR/launchd.err.log" >&2
  exit 1
fi
