---
name: codex-plan-review
description: Review implementation plans using the shared Codex runner with persistent resume state.
user-invocable: true
metadata:
  tags: plan, review, codex, quality
---

# Plan Review Skill

## When to Apply

Apply this skill when:
- User invokes `/codex-plan-review`
- A plan must be approved before implementation
- Repo instructions require plan-mode review before ExitPlanMode
- A plan exists only as inline notes and must be formalized into `docs/plans/...` before review

## Plan Mode Compatibility

- Some Codex Plan Mode variants say not to mutate repo-tracked files.
- In repos that require formal plan review, treat `docs/plans/...` creation/update, temporary review-prompt file creation, and `bash .agents/scripts/run-codex-review.sh plan ...` as required plan-finalization work, not implementation.
- Do not stop at `<proposed_plan>` or a chat-only plan because built-in Plan Mode asked for a non-mutating finish.
- If the environment truly hard-blocks those steps, report the task as blocked by plan-mode/tooling incompatibility instead of silently skipping review.

## Required Runner

Always use the shared runner. Do not call raw `codex exec`, `codex exec resume`, or manage `CODEX_THREAD_ID` manually.

```bash
bash .agents/scripts/run-codex-review.sh plan <session-key> < review-prompt.txt
```

- Always pass the same stable `session-key` on the CLI for every round of the same plan review
- The runner injects the same `Session-Key:` header into the prompt automatically
- The runner persists sessions under `.agents/state/`
- The runner now writes the thread id as soon as the review starts and rejects duplicate in-flight runs for the same `session-key`
- On re-review, the runner resumes the same thread and injects the previous verdict plus a scoped file-change summary so updated plans are re-evaluated against the current files
- The runner handles structured output parsing, resume fallback, and session reset behavior
- Run the command from the repo root

## Prompt Requirements

The review prompt should include:
- the target plan path, ideally under `docs/plans/`
- related files and Decision Records, explicitly enumerated instead of broad directories
- review criteria focused on design quality, feasibility, and implementation risk
- on re-review, a short `Parent-Adjudication:` block that says which prior issues were accepted, rejected, or deferred and why

Keep the review scope tight:
- Prefer a concrete file list over "search the repo" wording
- Limit related files to the minimum needed for the plan, ideally under 12 paths
- Limit Decision Records to the specific relevant paths, not `docs/decisions/` as a whole
- Keep `Parent-Adjudication:` compact: 1-5 bullets, latest round only

If the plan is still inline only, create the dated `docs/plans/...` file first. Reviewing a chat-only plan is not sufficient for this repo.

## Review Loop

1. Run the review with the runner.
2. If verdict is `NEEDS_CHANGES`, judge each issue before editing: `accept`, `reject`, or `defer`.
3. Add a short `Parent-Adjudication:` block to the next review prompt so the reviewer sees your judgment.
4. Update the plan file only for accepted issues, not just the chat response.
5. Re-run the same runner command with the same `session-key`.
6. Repeat until `APPROVED` or 5 rounds.
7. If `APPROVED` is still not reached after 5 rounds, keep the task blocked and do not exit plan mode.
8. Only exit plan mode after approval.

Do not treat a runner-path mistake or transient review failure as permission to skip the review.

## Fallback

- If Codex is unavailable or repeatedly fails, report the task as blocked instead of exiting plan mode without approval.
- Failures are surfaced as sanitized `[run-codex-review] ...` summaries with categorized hints, not raw stderr passthrough.
- Minor style-only issues are not blocking.
