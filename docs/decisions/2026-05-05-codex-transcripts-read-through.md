# Codex transcripts read through app-server

- Date: 2026-05-05
- Status: Accepted

## Context

Agent Cockpit previously treated SQLite `messages` as the primary transcript for
both Claude and Codex sessions. After Codex moved to the app-server runtime,
Codex itself owns the canonical thread history and exposes it through
`thread/read`. Keeping Cockpit DB rows as the Codex transcript source of truth
creates a second copy that can drift between desktop and mobile clients.

Cockpit still has transcript-like rows that Codex does not know about, especially
locally handled slash-command prompts and replies such as `/help`, `/status`, and
`/sessions`. Old Codex sessions may also have DB-only history if their previous
`cli_session_id` cannot be resumed by app-server.

## Decision

For Codex sessions, normal conversation display reads from Codex app-server
`thread/read` and treats that thread as canonical. SQLite `messages` rows for
normal Codex turns are cache/fallback data, not the display source of truth.

SQLite `messages` remains canonical for Claude sessions and for Cockpit-local
transcript overlays. Codex-local overlay rows are marked separately from Codex
cache rows so they can be merged into app-server transcript output without
reintroducing normal Codex DB rows as primary transcript.

Cockpit DB remains the source of truth for Cockpit metadata, including sessions,
repos, cwd, schedules, push subscriptions, status, and local display metadata.
When an old Codex thread id cannot be resumed, Cockpit records that unreadable
thread id before replacing `sessions.cli_session_id`, so legacy DB transcript
history can remain visible alongside the new readable Codex thread.

## Consequences

- New Codex clients can refresh/reload from the Codex thread instead of requiring
  a DB sync/import step.
- The former Codex “Sync” action becomes a transcript refresh that re-reads
  app-server history rather than importing messages into SQLite.
- Future changes must not make SQLite `messages` the primary normal Codex
  transcript again.
- Cache/fallback rows may be pruned in a later pass, but only after the
  app-server read-through path has proven stable and legacy fallback needs are
  understood.
