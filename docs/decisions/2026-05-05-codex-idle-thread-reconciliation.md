# Reconcile Cockpit running turns from idle Codex threads

- Date: 2026-05-05
- Status: Accepted

## Context

Cockpit tracks a local `sessions.status` and `turns.status`, while Codex app-server owns the actual thread/turn lifecycle. If the Cockpit server restarts, the browser reconnects, or the WebSocket misses a terminal `turn/completed` notification, Codex can already have an idle thread while Cockpit still marks the session and latest turn as `running`. The UI then rejects the next prompt with "Session is already running" even though Codex has stopped.

## Decision

Whenever Cockpit reads or resumes a Codex app-server thread and sees either `thread.status.type = idle` or a terminal latest turn status, it reconciles any local running turn from the latest app-server turn status. This matters because `thread/read` can return a non-idle thread status such as `notLoaded` while still exposing terminal turn statuses:

- `interrupted` -> local turn `stopped`, session `stopped`
- `failed`/`error` -> local turn/session `error`
- otherwise -> local turn `complete`, session `idle`

This reconciliation also clears in-memory Codex active/stop flags when a managed session is available.

## Consequences

- Reconnect snapshots and transcript refreshes can self-heal stale Cockpit `running` state even when thread-level status is not `idle` but the latest turn is terminal.
- Users are not blocked by "Session is already running" after a missed terminal event.
- Future lifecycle changes must preserve app-server as the authoritative lifecycle source for Codex threads.
