# Import Codex thread/list rows as Cockpit sessions

- Date: 2026-05-07
- Status: Accepted

## Context

Codex app-server can list threads that were created outside Agent Cockpit, such as threads started from the local Codex desktop/app UI. Cockpit's session list was previously backed only by its SQLite `sessions` table, so mobile/PWA users could see Cockpit-created threads but not local Codex-created threads even though Codex itself had them in the same thread store.

## Decision

When `/api/sessions` is read, Cockpit asks Codex app-server for `thread/list` and materializes any unseen Codex threads as local `sessions` rows keyed by `cli_session_id`. Existing Cockpit sessions with the same Codex thread id are updated with Codex's latest preview/name, cwd, updated time, and running/idle status without changing their Cockpit session id.

Unknown thread working directories are registered as repos using the directory basename so imported threads can satisfy the existing `sessions.repo_id` foreign key and appear in the all-sessions view.

## Consequences

- Threads started in the local Codex app become visible in Agent Cockpit without a manual import step.
- Cockpit metadata remains local; Codex thread history remains the transcript source once an imported session is opened.
- Deleting an imported Cockpit session only deletes the Cockpit row. Because the Codex thread still exists in the Codex store, a future `thread/list` sync can re-materialize it unless a Codex-side archive/delete workflow is added.

## Follow-up: slash resume uses the current Codex cwd list

Cockpit `/resume` and `/sessions` must not browse all Cockpit DB sessions for Codex sessions. They now call Codex app-server `thread/list` with the current session `cwd`, materialize those Codex thread ids into Cockpit session rows only as link targets, and render that cwd-scoped list. This keeps Cockpit behavior aligned with what Codex itself would show for resume in the current project directory, regardless of whether the thread was started from desktop Codex or mobile Cockpit.
