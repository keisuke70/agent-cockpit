# Preflight Codex threads and require turn materialization

- Date: 2026-05-06
- Status: Accepted

## Context

Cockpit previously treated a successful `turn/start` response as enough evidence that a user prompt had reached the target Codex thread. A real failure showed that this is not sufficient: Cockpit stored local prompts and Codex turn ids for a session, but `thread/read` for the session's Codex thread never contained those turns or user messages. Those turns stayed `submitted` locally and eventually became stopped, creating a Cockpit-only transcript that Codex had not materialized.

This was especially visible after realtime/voice experimentation and interrupted turns, where the app-server thread can be returned as `notLoaded` while Cockpit still holds an in-memory managed session.

## Decision

Before starting a Codex turn, Cockpit re-resumes the target app-server thread with `persistExtendedHistory: true` and reconciles any terminal thread state. All thread start/resume calls request extended history persistence.

After `turn/start`, Cockpit no longer treats the returned turn id as sufficient. It immediately reads the target thread and requires the new turn to materialize there. If Codex accepts `turn/start` but the turn does not appear in the target transcript after retries, Cockpit marks the local turn as a retryable desync and returns the session to idle instead of leaving a phantom submitted/stopped turn.

## Consequences

- Cockpit does not silently create durable normal chat history that exists only in SQLite while missing from Codex transcript.
- Stale/unloaded app-server thread handles are refreshed before each prompt.
- `turn/start` success is treated as an acceptance signal, not delivery confirmation; transcript materialization is the confirmation.
