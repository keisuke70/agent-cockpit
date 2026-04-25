# Codex review state uses a repo-local writable runner

- Date: 2026-04-13
- Status: Accepted

## Context

The synced `.agents` directory is readable in the current Codex sandbox, but it is not
writable. `bash .agents/scripts/run-codex-review.sh ...` failed before reaching Codex
because the runner tried to create `.agents/state/codex-*.active.json` and received
`EPERM`.

There is a second failure mode: when a nested `codex exec` panics or hangs while starting
inside the sandbox, the original runner can wait forever for inherited stdio to close even
after sending `SIGKILL` to the direct child.

## Decision

This repo uses `bash scripts/run-codex-review.sh <plan|impl> <session-key>` as the review
entrypoint. The script is a repo-local copy of the shared runner, with state stored in
`.codex-review-state/` by default and an optional `CODEX_REVIEW_STATE_DIR` override.

The runner still reads the shared JSON schema from `.agents/scripts/review-schema.json`
and keeps the same session-key, resume, active-run, and structured-output behavior.

The runner also terminates Codex as a process tree on timeout and force-resolves the
review attempt with a timeout failure if stdio remains open.

## Consequences

- `.codex-review-state/` is ignored and becomes the durable local resume/cache directory.
- Do not point this repo's review workflow back at `.agents/state` unless `.agents` is
  writable in the active Codex environment.
- Future syncs from `agent-skills` may overwrite `.agents`, but they should not remove the
  repo-local `scripts/run-codex-review.*` override without first proving the shared runner
  can write state and return from nested Codex startup failures.
