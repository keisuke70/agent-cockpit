# Session recency requires visible activity

- Date: 2026-05-08
- Status: Accepted

## Context

Codex app-server can advance a thread's `updatedAt` when Agent Cockpit merely
resumes or opens the thread. Cockpit imports and refreshes Codex threads from
`thread/list`, and the session list is sorted by `sessions.updated_at`. If every
Codex `updatedAt` change is copied into Cockpit, opening an old session makes it
jump to the top even when no prompt, slash command, status transition, title
change, or transcript-visible work occurred.

## Decision

When refreshing an existing Cockpit session from Codex `thread/list`, do not use
Codex `thread.updatedAt` as a recency update by itself. Adopt the Codex timestamp
only when the refresh includes a visible activity signal: the displayed title /
preview changes, or the session status changes. New imported threads still use
Codex timestamps for initial placement, and local Cockpit turn/status mutations
continue to update `sessions.updated_at` when real work starts or finishes.

## Consequences

- Inspecting a session no longer reorders the saved-session list.
- Sessions still move when actual work changes their preview/title or running
  state.
- If Codex changes only opaque metadata without a visible activity signal,
  Cockpit intentionally preserves the previous list position.
