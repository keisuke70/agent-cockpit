#!/usr/bin/env bash
set -euo pipefail

force=false
include_mobile=false
pull_shared=false
sync_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=true
      shift
      ;;
    --pull)
      pull_shared=true
      shift
      ;;
    --mobile)
      include_mobile=true
      sync_args+=("$1")
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 [--force] <project-path> [--mobile]" >&2
  exit 2
fi

project_root="$(cd "$1" && pwd)"
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mobile)
      include_mobile=true
      sync_args+=("$1")
      shift
      ;;
    *)
      sync_args+=("$1")
      shift
      ;;
  esac
done

shared_root="$project_root/../agent-skills"
if [ ! -e "$shared_root" ] || ! git -C "$shared_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Shared repo not found at $shared_root" >&2
  exit 1
fi
shared_root="$(cd "$shared_root" && pwd)"

if $pull_shared && git -C "$shared_root" remote get-url origin >/dev/null 2>&1; then
  if ! git -C "$shared_root" pull --ff-only >/dev/null 2>&1; then
    echo "Failed to update sibling agent-skills checkout. Resolve the pull failure or rerun intentionally from the desired local commit." >&2
    exit 1
  fi
fi

if ! $force && git -C "$project_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  status_paths=(
    AGENTS.md
    CLAUDE.md
    .claude/skills/review-schema.json
    .agents/scripts/review-schema.json
    .agents/scripts/run-codex-review.mjs
    .agents/scripts/run-codex-review.sh
  )

  while IFS= read -r skill_dir; do
    skill_name="$(basename "$skill_dir")"
    status_paths+=(".agents/skills/$skill_name" ".claude/skills/$skill_name")
  done < <(find "$shared_root/skills/core" -mindepth 1 -maxdepth 1 -type d | sort)

  if $include_mobile; then
    while IFS= read -r skill_dir; do
      skill_name="$(basename "$skill_dir")"
      status_paths+=(".agents/skills/$skill_name" ".claude/skills/$skill_name")
    done < <(find "$shared_root/skills/mobile" -mindepth 1 -maxdepth 1 -type d | sort)
  fi

  managed_changes="$(
    git -C "$project_root" status --short --untracked-files=all -- "${status_paths[@]}"
  )"
  if [ -n "$managed_changes" ]; then
    echo "Refusing to overwrite dirty shared-managed paths. Commit, stash, or rerun with --force." >&2
    printf '%s\n' "$managed_changes" >&2
    exit 1
  fi
fi

if ! $force && git -C "$shared_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  shared_status_paths=(
    claude-snippets/shared-instructions.md
    scripts/review-schema.json
    scripts/run-codex-review.mjs
    scripts/run-codex-review.sh
    skills/core/review-schema.json
    skills/core
  )
  if $include_mobile; then
    shared_status_paths+=(skills/mobile)
  fi

  shared_changes="$(
    git -C "$shared_root" status --short --untracked-files=all -- "${shared_status_paths[@]}"
  )"
  if [ -n "$shared_changes" ]; then
    echo "Refusing to sync from a dirty sibling agent-skills checkout. Commit, stash, or rerun with --force." >&2
    printf '%s\n' "$shared_changes" >&2
    exit 1
  fi
fi

cd "$project_root"
if [ "${#sync_args[@]}" -eq 0 ]; then
  "$shared_root/sync.sh" --no-pull
else
  "$shared_root/sync.sh" --no-pull "${sync_args[@]}"
fi
