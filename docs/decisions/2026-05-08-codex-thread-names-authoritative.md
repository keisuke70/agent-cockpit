# Codex thread names are authoritative

- Date: 2026-05-08
- Status: Accepted

## Context

Codex app-server generates thread titles that match the native Codex desktop / CLI
experience. Agent Cockpit previously filled empty Codex session names from the
first prompt or from `thread.preview`. Those values are transcript snippets, not
canonical titles, so session names looked noisy and differed from Codex on the
same machine.

## Decision

For Codex app-server sessions, Cockpit must treat Codex `thread.name` and
`thread/name/updated` as the authoritative title source. Cockpit should not run
its local first-prompt auto-title fallback for Codex sessions, and should not
persist preview text as a session name when importing or resuming Codex threads.
Preview may still be used as transcript/search context, but not as the saved
session title.

## Consequences

- Codex sessions opened in Cockpit use the same generated title that Codex uses
  natively when app-server provides one.
- New Codex sessions may remain untitled briefly until Codex emits or exposes the
  generated thread name.
- Claude/non-Codex sessions keep Cockpit's local first-prompt auto-title logic.
