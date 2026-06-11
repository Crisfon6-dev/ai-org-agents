#!/usr/bin/env bash
# Sync Aphrodite discipline skills (.claude/skills/aphrodite-*) into the Hermes
# skills dir (~/.hermes/skills/aphrodite) as symlinks. Idempotent: re-running
# produces the same state. Use --remove to delete the symlinks (rollback).
#
# The repo is the single source of truth — symlinks are per-machine and
# regenerable. See agents/README.md (section "Skills de disciplina").
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/.claude/skills"
TARGET_DIR="$HOME/.hermes/skills/aphrodite"
MODE="${1:-sync}"

if [[ "$MODE" == "--remove" ]]; then
  removed=0
  for link in "$TARGET_DIR"/aphrodite-*; do
    [[ -L "$link" ]] || continue
    rm "$link"
    echo "✗ removed $link"
    removed=$((removed + 1))
  done
  echo "Done: $removed symlink(s) removed."
  exit 0
fi

mkdir -p "$TARGET_DIR"

synced=0
for skill_dir in "$SOURCE_DIR"/aphrodite-*; do
  [[ -d "$skill_dir" ]] || continue
  [[ -f "$skill_dir/SKILL.md" ]] || { echo "⚠ skipping $(basename "$skill_dir") (no SKILL.md)"; continue; }
  name="$(basename "$skill_dir")"
  target="$TARGET_DIR/$name"
  # Idempotent: replace only if missing or pointing elsewhere
  if [[ -L "$target" && "$(readlink "$target")" == "$skill_dir" ]]; then
    echo "= $name (already linked)"
  else
    rm -rf "$target"
    ln -s "$skill_dir" "$target"
    echo "✓ $name → $target"
  fi
  synced=$((synced + 1))
done

if [[ $synced -eq 0 ]]; then
  echo "No aphrodite-* skills found in $SOURCE_DIR (author them first — see openspec change discipline-skills-closure-campaign)"
  exit 0
fi

echo "Done: $synced skill(s) linked. Verify with: hermes skills list"
