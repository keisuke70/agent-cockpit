# Isolate Codex Realtime Start/Stop From Text Turns

- Date: 2026-05-07
- Status: Accepted

## Context

A Codex realtime voice start can be interrupted by browser reconnects, user stop actions, or deploy restarts before the app-server returns an answer SDP. If Cockpit marks the realtime state idle while the original start request is still in flight, the UI can submit a normal text prompt to the same Codex thread. That interleaving can produce accepted `turn/start` ids that never materialize in `thread/read`, making the session look permanently desynced even though the underlying Codex thread is still readable.

## Decision

Track realtime start as a separate in-flight operation with a token. Text prompt submission and desynced retry must treat `codexRealtimeStartInFlight` as busy even if the visible realtime state has moved through stopping/idle. Stop requests during start are best-effort cancellation: they return quickly, but the session remains guarded until the matching start handler settles or times out. Realtime failures are isolated to voice state and should not imply that the Codex thread is unhealthy.

## Consequences

A failed voice attempt should no longer poison later text turns. The trade-off is that text input may remain blocked for up to the realtime start timeout while cleanup completes, which is preferable to corrupting turn/thread synchronization.
