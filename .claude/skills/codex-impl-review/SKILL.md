---
name: codex-impl-review
description: Review implementation code using the shared Codex runner with persistent resume state.
user-invocable: true
metadata:
  tags: implementation, review, codex, quality
---

# Implementation Review Skill

## When to Apply

Apply this skill when:
- User invokes `/codex-impl-review`
- Repo instructions require an implementation review before reporting completion
- The implementation changed 3 or more files

## Required Runner

Always use the shared runner. Do not call raw `codex exec`, `codex exec resume`, or manage `CODEX_THREAD_ID` manually.

```bash
bash .agents/scripts/run-codex-review.sh impl <session-key> < review-prompt.txt
```

- Always pass the same stable `session-key` on the CLI for every round of the same implementation review
- The runner injects the same `Session-Key:` header into the prompt automatically
- The runner persists sessions under `.agents/state/`
- The runner now writes the thread id as soon as the review starts and rejects duplicate in-flight runs for the same `session-key`
- On re-review, the runner resumes the same thread and injects the previous verdict plus a scoped file-change summary so fixes are re-evaluated against the current files
- The runner handles structured output parsing, resume fallback, and session reset behavior
- Run the command from the repo root

## Prompt Requirements

The review prompt should include:
- changed files, explicitly enumerated
- related Decision Records, explicitly enumerated
- plan reference if one exists
- review criteria focused on bugs, regressions, risks, and conflicts
- on re-review, a short `Parent-Adjudication:` block that says which prior issues were accepted, rejected, or deferred and why

Keep the review scope tight:
- Prefer a concrete changed-file list over "inspect the repo" wording
- Limit target files to the minimum needed for the review, ideally 3-10 paths and at most 15
- Limit Decision Records to the specific relevant paths, not `docs/decisions/` as a whole
- Ask the reviewer to read only minimal neighboring files needed to validate a claim
- Keep `Parent-Adjudication:` compact: 1-5 bullets, latest round only

## Review Loop

1. Run the review with the runner.
2. If verdict is `NEEDS_CHANGES`, judge each issue before editing: `accept`, `reject`, or `defer`.
3. Add a short `Parent-Adjudication:` block to the next review prompt so the reviewer sees your judgment.
4. Fix only accepted material findings.
5. Re-run the same runner command with the same `session-key`.
6. Repeat until `APPROVED` or 5 rounds.
7. If the review never reaches `APPROVED`, treat the task as blocked and report the remaining issues to the user instead of claiming completion.

## Fallback

- If Codex is unavailable or repeatedly fails, report the task as blocked instead of skipping review.
- Failures are surfaced as sanitized `[run-codex-review] ...` summaries with categorized hints, not raw stderr passthrough.
- Minor style-only issues are not blocking.
