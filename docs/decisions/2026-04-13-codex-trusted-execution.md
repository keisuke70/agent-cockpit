# Codex cockpit sessions bypass the inner sandbox

- Date: 2026-04-13
- Status: Accepted

## Context

Agent Cockpit is run by the same local user who owns the target repositories and is intended
to be a trusted, single-user control plane on the Mac mini. Launching Codex with `--full-auto`
keeps Codex in `workspace-write` sandbox mode, which prevents some requested maintenance tasks
from editing user-owned paths outside the current workspace or otherwise acting like the local
CLI session the user expects.

## Decision

The Codex adapter launches `codex exec` with
`--dangerously-bypass-approvals-and-sandbox` instead of `--full-auto`.

This changes the trust boundary: Agent Cockpit itself and the authenticated local user session
are the outer boundary. Codex turns started from Cockpit should be treated as having the same
filesystem power as a direct trusted terminal invocation.

## Consequences

- Future Cockpit-started Codex turns are not limited by Codex's `workspace-write` sandbox.
- The app must remain single-user and local/trusted unless an explicit approval or isolation
  model is added.
- Do not reintroduce `--full-auto` for Cockpit Codex sessions unless the product decision
  changes back to sandboxed operation.
