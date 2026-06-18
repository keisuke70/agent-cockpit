# Ignore stale terminal Codex turns while a newer turn is running

- Date: 2026-05-06
- Status: Accepted

## Context

Cockpit reconciles local running state by reading Codex app-server thread state. During a new or streaming turn, `thread/read` can lag and still report the previous completed turn as the latest transcript turn. If Cockpit treats any terminal latest turn as authoritative for the current local running turn, the UI flips to Ready while Codex is still answering.

## Decision

When Cockpit has a running local Codex turn id, a terminal latest turn from `thread/read` only completes/stops/fails the local turn if the Codex turn id matches. If the terminal latest turn id differs from the active/running Codex turn id, Cockpit ignores that stale terminal reconciliation and waits for the matching live notification or watchdog reconciliation.

## Consequences

- Transcript refreshes, reconnect snapshots, and watchdog reads no longer make a streaming answer appear Ready because they saw the previous completed turn.
- Legitimate missed terminal events are still repaired when the terminal turn id matches the running local turn.
- Accepted-but-unmaterialized turns remain handled by the dedicated watchdog/desync path instead of the generic latest-terminal reconciliation path.
