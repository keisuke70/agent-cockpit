# Restart stale Codex app-server auth bridges

- Date: 2026-06-18
- Status: Accepted

## Context

Pocket Agent keeps a long-lived `codex app-server` child process so mobile/PWA
sessions can talk to Codex through one local bridge. A real failure showed that
the child can keep stale authentication state for days: Codex CLI and `codex
doctor` were healthy, but the old bridge still attempted Responses websocket
connections without bearer/basic auth and returned 401 errors.

## Decision

Pocket Agent treats the app-server process as a disposable authentication bridge,
not as durable session state. Before starting new Codex work, an idle bridge that
has exceeded the configured max age is restarted and rebound to the current
thread. If app-server output or JSON-RPC errors contain Responses 401/Missing
bearer signals, Pocket Agent invalidates that bridge immediately so subsequent
work uses a fresh process and fresh Codex auth state.

## Consequences

- Long-idle mobile sessions should not keep failing just because launchd held an
  old app-server child across Codex auth/model changes.
- Thread history remains owned by Codex; bridge restarts re-resume existing
  materialized threads and only create a replacement for empty pre-first-turn
  threads.
- Future app-server lifecycle changes should keep planned bridge restarts
  separate from true turn failures, so restarting auth plumbing does not mark an
  idle user session as failed.
