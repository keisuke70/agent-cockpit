# Codex cache overlays preserve local user prompts

- Date: 2026-05-05
- Status: Accepted

## Context

Codex app-server `thread/read` is the canonical transcript source for Codex sessions, but Cockpit also persists submitted prompts locally as `source = 'cache'` before calling `turn/start`. A prompt can be in flight before the app-server thread contains the corresponding user item. In practice, app-server transcript materialization can also lag or omit a submitted user item even after Cockpit has observed the local turn complete, especially around reconnects, interrupted/stopped turns, or experimental realtime flows.

If Cockpit replaces the client message list with only the canonical app-server thread, the user's sent prompt can disappear from history even though the SQLite cache row proves Cockpit accepted and sent it.

## Decision

For Codex sessions, Cockpit overlays local `source = 'cache'` user and assistant messages onto the app-server transcript whenever the transcript does not already contain an equivalent role+content message. This local cache is a safety net for messages Cockpit already accepted/observed but the app-server transcript has not materialized. The app-server transcript still wins whenever it contains the same content, avoiding duplicate bubbles.

## Consequences

- Reloads, reconnect snapshots, and manual refreshes keep submitted user prompts visible, including after a local turn has completed/stopped but app-server history has not materialized the prompt.
- Equivalent canonical app-server items suppress cache rows to avoid duplicates.
- Future transcript changes should preserve this cache overlay; narrowing it back to only `running` turns or only `user` messages can reintroduce “sent message / observed response disappeared” regressions.
- Streaming deltas and tool activity that have not reached a completed message are still volatile unless Cockpit persists them separately.
