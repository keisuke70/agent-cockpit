#!/usr/bin/env bash
set -euo pipefail
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mapping_file="$tmpdir/mappings.tsv"
mapping_action="copy"

target_group=""
force=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      force=true
      shift
      ;;
    --core|--mobile)
      if [ -n "$target_group" ]; then
        echo "Specify only one of --core or --mobile" >&2
        exit 2
      fi
      target_group="${1#--}"
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 [--force] [--core|--mobile] <project-path> <project-file> [project-file...]" >&2
  exit 2
fi

project_root="$(cd "$1" && pwd)"
shift

shared_root="$project_root/../agent-skills"
if [ ! -e "$shared_root" ] || ! git -C "$shared_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Shared repo not found at $shared_root" >&2
  exit 1
fi
shared_root="$(cd "$shared_root" && pwd)"

extract_shared_block() {
  local src="$1"
  python3 - "$src" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
begin = "<!-- BEGIN SHARED INSTRUCTIONS"
end = "<!-- END SHARED INSTRUCTIONS -->"

begin_count = text.count(begin)
end_count = text.count(end)
if begin_count != 1 or end_count != 1:
    raise SystemExit("Expected exactly one shared instructions block")

start = text.index(begin)
finish = text.index(end, start) + len(end)
print(text[start:finish])
PY
}

copy_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "synced: ${src#$project_root/} -> ${dest#$shared_root/}"
}

register_mapping() {
  local src="$1"
  local dest="$2"
  local previous=""
  mapping_action="copy"

  if [ -f "$mapping_file" ]; then
    previous="$(awk -F '\t' -v key="$dest" '$1 == key { print $2; exit }' "$mapping_file")"
  fi

  if [ -n "$previous" ]; then
    if ! cmp -s "$previous" "$src"; then
      echo "Conflicting sources map to the same upstream target: $dest" >&2
      echo "  first:  ${previous#$project_root/}" >&2
      echo "  second: ${src#$project_root/}" >&2
      exit 1
    fi
    mapping_action="skip"
    return
  fi

  printf '%s\t%s\n' "$dest" "$src" >> "$mapping_file"
}

ensure_shared_dest_clean() {
  local dest="$1"
  local rel="${dest#$shared_root/}"

  if $force || ! git -C "$shared_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  if [ -n "$(git -C "$shared_root" status --short --untracked-files=all -- "$rel")" ]; then
    echo "Refusing to overwrite dirty shared path: $rel" >&2
    echo "Commit, stash, or rerun with --force." >&2
    exit 1
  fi
}

for rel in "$@"; do
  src="$project_root/$rel"
  if [ ! -e "$src" ]; then
    echo "Missing source file: $rel" >&2
    exit 1
  fi

  case "$rel" in
    .agents/scripts/review-schema.json|.claude/skills/review-schema.json)
      dest="$shared_root/scripts/review-schema.json"
      register_mapping "$src" "$dest"
      if [ "$mapping_action" = "copy" ]; then
        ensure_shared_dest_clean "$dest"
        copy_file "$src" "$dest"
      fi

      dest="$shared_root/skills/core/review-schema.json"
      register_mapping "$src" "$dest"
      if [ "$mapping_action" = "copy" ]; then
        ensure_shared_dest_clean "$dest"
        copy_file "$src" "$dest"
      fi
      ;;
    .agents/skills/*|.claude/skills/*)
      skill_path="${rel#.agents/skills/}"
      skill_path="${skill_path#.claude/skills/}"
      skill_name="${skill_path%%/*}"
      skill_name="${skill_name%%/*}"
      if [ -d "$shared_root/skills/core/$skill_name" ]; then
        dest="$shared_root/skills/core/$skill_path"
      elif [ -d "$shared_root/skills/mobile/$skill_name" ]; then
        dest="$shared_root/skills/mobile/$skill_path"
      elif [ -n "$target_group" ]; then
        dest="$shared_root/skills/$target_group/$skill_path"
      else
        echo "Unknown shared skill target for $rel" >&2
        exit 1
      fi
      register_mapping "$src" "$dest"
      if [ "$mapping_action" = "copy" ]; then
        ensure_shared_dest_clean "$dest"
        copy_file "$src" "$dest"
      fi
      ;;
    .agents/scripts/run-codex-review.mjs|.agents/scripts/run-codex-review.sh)
      dest="$shared_root/scripts/${rel#.agents/scripts/}"
      register_mapping "$src" "$dest"
      if [ "$mapping_action" = "copy" ]; then
        ensure_shared_dest_clean "$dest"
        copy_file "$src" "$dest"
      fi
      ;;
    .agents/scripts/*)
      echo "Unsupported shared script path: $rel" >&2
      exit 1
      ;;
    AGENTS.md|CLAUDE.md)
      block="$(extract_shared_block "$src")"
      if [ -z "$block" ]; then
        echo "Shared instructions block not found in $rel" >&2
        exit 1
      fi
      block_file="$tmpdir/$(basename "$rel").shared.md"
      printf '%s\n' "$block" > "$block_file"
      dest="$shared_root/claude-snippets/shared-instructions.md"
      register_mapping "$block_file" "$dest"
      if [ "$mapping_action" = "copy" ]; then
        ensure_shared_dest_clean "$dest"
        printf '%s\n' "$block" > "$dest"
        echo "synced: ${rel} shared block -> claude-snippets/shared-instructions.md"
      fi
      ;;
    *)
      echo "Unsupported shared path: $rel" >&2
      exit 1
      ;;
  esac
done
