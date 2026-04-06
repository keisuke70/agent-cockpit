---
name: agent-skills-upstream-sync
description: Sync shared skill, runner, and shared-instructions changes between the current project and the sibling ../agent-skills repo. Use when a project-local edit should become the shared source of truth, or when the latest shared skills should be pulled back into the current project.
---

# Agent Skills Sync Workflow

Use this skill when shared assets need to move in either direction between the current project and the sibling `../agent-skills` repo.

## Supported Directions

### Project -> Shared repo

Use this when shared assets were edited inside a project first and those edits now need to be reflected in `../agent-skills`.

### Shared repo -> Current project

Use this when `../agent-skills` already contains the desired updates and the current project should import the latest shared state.

## What Counts As Shared Assets

This skill is for:
- `.agents/skills/<skill-name>/...`
- `.claude/skills/<skill-name>/...`
- `.agents/scripts/run-codex-review.*`
- `.claude/skills/review-schema.json`
- the shared-instructions block in `AGENTS.md` or `CLAUDE.md`

Do not use it for project-specific app logic.

## Workflow

1. Confirm the current project root and locate the sibling shared repo at `../agent-skills`.
2. Decide the direction:
   - Project -> Shared repo when the project copy is the new source of truth
   - Shared repo -> Current project when the shared repo already has the desired version
3. Review diffs before copying so project-only content does not leak into the shared repo and stale shared content does not overwrite intentional local divergence.

## Project -> Shared Repo

1. Inspect the project diff and identify which changed files belong to shared assets.
2. Map project files to shared repo sources:
   - `.agents/skills/<name>/...` or `.claude/skills/<name>/...` -> `../agent-skills/skills/core/<name>/...` or `../agent-skills/skills/mobile/<name>/...`
   - `.agents/scripts/run-codex-review.mjs|run-codex-review.sh|review-schema.json` -> `../agent-skills/scripts/<file>`
   - `.claude/skills/review-schema.json` -> `../agent-skills/scripts/review-schema.json` and `../agent-skills/skills/core/review-schema.json`
   - shared instruction block in `AGENTS.md` or `CLAUDE.md` -> `../agent-skills/claude-snippets/shared-instructions.md`
3. Copy only the intended files into `../agent-skills`.
4. Review the shared repo diff and verify that no project-only content leaked in.
5. Commit in `../agent-skills` if the changes are correct.
6. Push `../agent-skills` to its remote after the commit succeeds.
7. Verify that `origin/main` (or the intended upstream branch) now points at the new commit.
8. If the current project should consume the new shared version immediately, run the pull step afterward.

If both `.agents` and `.claude` mirrors are supplied in the same push, they must be byte-identical for any destination that collapses to the same shared file.

## Shared Repo -> Current Project

1. Ensure `../agent-skills` is already on the desired commit, or opt into a pull/update step first.
2. Ensure the specific shared-managed paths that will be touched are clean in both the current project and `../agent-skills`, or pass `--force` only when overwriting them is intentional.
3. Run `sync-from-agent-skills.sh` from the project root so the guard rails stay active.
4. Review the resulting project diff before committing, especially `AGENTS.md`, `.agents/skills/`, `.claude/skills/`, and `.agents/scripts/`.

## Preferred Automation

For Project -> Shared repo:

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-to-agent-skills.sh [--force] [--core|--mobile] <project-path> [project-file...]
```

Examples:

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-to-agent-skills.sh "$PWD" \
  .agents/skills/codex-plan-review/SKILL.md \
  .agents/skills/codex-impl-review/SKILL.md \
  .agents/scripts/run-codex-review.sh \
  .agents/scripts/run-codex-review.mjs
```

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-to-agent-skills.sh "$PWD" AGENTS.md
```

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-to-agent-skills.sh --core "$PWD" \
  .agents/skills/my-new-skill/SKILL.md
```

For Shared repo -> Current project:

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-from-agent-skills.sh [--force] [--pull] <project-path> [--mobile]
```

Example:

```bash
bash .agents/skills/agent-skills-upstream-sync/scripts/sync-from-agent-skills.sh "$PWD"
```

Round trip example:

1. Push project changes into `../agent-skills`
2. Commit in `../agent-skills`
3. Push the new commit to the remote shared repo
4. Pull the shared repo back into the current project with `sync-from-agent-skills.sh`

## Notes

- The push helper only supports the shared paths above and fails on unknown paths.
- For brand-new skills, pass exactly one of `--core` or `--mobile`.
- The pull helper refuses to run if the current project or sibling shared repo is dirty on the paths that would be touched unless `--force` is passed.
- The push helper refuses to overwrite dirty destination paths in `../agent-skills` unless `--force` is passed.
- The push helper aborts if two different local sources would overwrite the same upstream destination with different contents.
- `review-schema.json` is updated in both `../agent-skills/scripts/` and `../agent-skills/skills/core/` to keep downstream sync output consistent.
- The pull helper is the canonical pull path. Use raw `../agent-skills/sync.sh` only as a low-level escape hatch when you intentionally want to bypass the helper checks.
- The helper does not move `../agent-skills` by default. Use `--pull` only when you explicitly want a fast-forward update first.
- For `AGENTS.md` or `CLAUDE.md`, it extracts only the `BEGIN/END SHARED INSTRUCTIONS` block and writes that block into `../agent-skills/claude-snippets/shared-instructions.md`.
- Always inspect `git -C ../agent-skills diff` before committing in the shared repo.
- Do not run `git commit` and `git push` in parallel. Commit first, then push, then verify `git -C ../agent-skills rev-parse HEAD` matches `git -C ../agent-skills rev-parse origin/main` after fetch/push.
- Always inspect the project diff after a pull, because local project-specific edits can still conflict with shared updates.
