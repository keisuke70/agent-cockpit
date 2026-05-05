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
  launchd_pid="$(
    launchctl list | awk -v label="$LABEL" '$3 == label { print $1; exit }'
  )"
  if ! [[ "$launchd_pid" =~ ^[0-9]+$ ]]; then
    launchd_pid=""
  fi

  # Clear duplicate/manual servers for this repo before restarting the launchd
  # job. Do not kill the launchd-owned process here; kickstart owns that part.
  duplicate_pids=""
  for pid in $(pgrep -f "node .*${SERVER_ENTRY}" || true); do
    if [ -z "$launchd_pid" ] || [ "$pid" != "$launchd_pid" ]; then
      duplicate_pids="${duplicate_pids}${duplicate_pids:+ }$pid"
    fi
  done
  if [ -n "$duplicate_pids" ]; then
    echo "==> Stopping duplicate server process(es): $duplicate_pids"
    kill $duplicate_pids 2>/dev/null || true
    sleep 1
  fi

  # Do not unload+load for the common case. Agent Cockpit often runs this
  # command from inside its own web session; unloading first creates a window
  # where the command/client can be interrupted before the load happens, leaving
  # the server stopped. kickstart asks launchd to kill and immediately restart
  # the already-loaded job, so launchd owns the restart even if this shell dies.
  echo "==> Restarting $LABEL with launchctl kickstart"
  if ! launchctl kickstart -k "gui/$(id -u)/$LABEL"; then
    echo "ERROR: kickstart failed; leaving the existing loaded job in place." >&2
    echo "Run scripts/install-launchd.sh if the launchd job needs to be reinstalled." >&2
    exit 1
  fi
else
  echo "==> $LABEL is not currently loaded; loading from plist"

  # If an old process was left behind outside launchd, remove only this repo's
  # server entry. When launchd owns the job we intentionally avoid pgrep+kill so
  # we do not race the freshly restarted process.
  leftover_pids="$(pgrep -f "node .*${SERVER_ENTRY}" || true)"
  if [ -n "$leftover_pids" ]; then
    echo "==> Stopping leftover server process(es): $leftover_pids"
    kill $leftover_pids 2>/dev/null || true
    sleep 1
  fi

  echo "==> Loading $LABEL"
  launchctl load "$PLIST_DEST"
fi

sleep 1
if ! launchctl list | grep -q "$LABEL"; then
  echo "ERROR: launchd did not start $LABEL. Check $LOG_DIR/launchd.err.log" >&2
  exit 1
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3001/api/health >/dev/null; then
    echo "==> agent-cockpit restarted: http://127.0.0.1:3001"
    exit 0
  fi
  sleep 0.5
done

echo "WARNING: launchd loaded $LABEL, but /api/health did not respond yet." >&2
echo "Check logs: $LOG_DIR/launchd.err.log" >&2
