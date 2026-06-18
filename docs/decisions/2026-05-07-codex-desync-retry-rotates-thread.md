# Avoid Treating Every Desynced Turn as a Broken Codex Thread

- Date: 2026-05-07
- Status: Accepted

## Context

Cockpit can observe a local Codex turn where `turn/start` returned an id but subsequent `thread/read includeTurns` does not show that id. The first recovery idea was to rotate to a fresh app-server thread on retry. That breaks the immediate desync loop, but it also sacrifices Codex conversation continuity and can mask the real cause when the original thread is still readable.

The concrete failure that motivated this record was caused by a realtime voice start/stop race: the Codex thread itself remained readable, but a half-open realtime start allowed a later text turn to interleave badly.

## Decision

Do not automatically rotate the Codex thread for every accepted-but-not-materialized turn. Desync retry should first resubmit on the existing readable thread, while realtime failures are isolated by `codexRealtimeStartInFlight` so they cannot poison later text turns. Thread rotation remains a last-resort recovery for genuinely unhealthy app-server bridges, such as local app-server fatal recovery or explicit unreadable-thread replacement.

## Consequences

Conversation continuity is preserved for the common desync/retry path. Future changes should prove that the app-server thread is unreadable or unrecoverable before replacing it; a missing turn id alone is not enough evidence.
