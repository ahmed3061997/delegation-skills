#!/bin/sh
# delegate-skill · install.sh
#
# Install the skill into a Claude Code skills directory, where it auto-loads on
# the next session.
#
#   ./install.sh                 symlink it (edits in this repo take effect live)
#   ./install.sh --copy          copy it instead (a frozen snapshot)
#   ./install.sh --uninstall     remove it again
#
# Options:
#   --copy             Copy the skill instead of symlinking it.
#   --target <dir>     Skills directory to install into.
#                      Default: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills
#   --force            Replace an existing installation.
#   --uninstall        Remove a previous installation and exit.
#   --dry-run          Print what would happen; change nothing.
#   -h, --help         Show this help.
#
# It refuses to touch anything at the destination that it did not put there:
# an unrelated directory is reported, never overwritten or deleted.
#
# POSIX sh. No dependencies beyond coreutils; Node 18+ is needed to *run* the
# skill, and its absence is reported as a warning, not a failure.

set -eu

SKILL_NAME="delegate-skill"
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR="$REPO_DIR/skills/$SKILL_NAME"

MODE="link"
FORCE=0
UNINSTALL=0
DRY_RUN=0
TARGET_ROOT=""

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

# The header comment is the help text; print it up to the first line of code.
usage() {
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --copy) MODE="copy" ;;
    --link) MODE="link" ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --target)
      [ $# -ge 2 ] || die "--target requires a directory"
      TARGET_ROOT="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ -z "$TARGET_ROOT" ]; then
  TARGET_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
fi
DEST="$TARGET_ROOT/$SKILL_NAME"

# Is what sits at $DEST something this script installed? Anything else is the
# user's, and gets reported rather than removed.
is_ours() {
  [ -L "$DEST" ] && return 0
  [ -f "$DEST/SKILL.md" ] && grep -q "^name: $SKILL_NAME\$" "$DEST/SKILL.md" 2>/dev/null && return 0
  return 1
}

remove_existing() {
  if [ -L "$DEST" ]; then
    run rm -- "$DEST"
  else
    run rm -rf -- "$DEST"
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -e "$DEST" ] && [ ! -L "$DEST" ]; then
    say "Nothing installed at $DEST."
    exit 0
  fi
  is_ours || die "$DEST was not installed by this script; remove it yourself if you mean to."
  remove_existing
  if [ "$DRY_RUN" -eq 1 ]; then
    say "Dry run: nothing was changed."
  else
    say "Removed $DEST"
    say "Restart Claude Code for it to drop out of the session."
  fi
  exit 0
fi

[ -f "$SOURCE_DIR/SKILL.md" ] || die "no skill found at $SOURCE_DIR — run this from the repository root"

if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  if [ "$FORCE" -ne 1 ]; then
    if is_ours; then
      die "$DEST already exists. Re-run with --force to replace it, or --uninstall to remove it."
    fi
    die "$DEST already exists and was not installed by this script. Move it aside first."
  fi
  is_ours || die "$DEST was not installed by this script; --force will not overwrite it."
  say "Replacing the existing installation at $DEST"
  remove_existing
fi

run mkdir -p -- "$TARGET_ROOT"

if [ "$MODE" = "link" ]; then
  run ln -s -- "$SOURCE_DIR" "$DEST"
else
  run cp -R -- "$SOURCE_DIR" "$DEST"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "Dry run: nothing was changed."
  exit 0
fi

if [ "$MODE" = "link" ]; then
  say "Linked $DEST -> $SOURCE_DIR"
  say "Edits in this repository take effect on the next session."
else
  say "Copied $SOURCE_DIR -> $DEST"
  say "This is a snapshot; re-run to pick up later changes."
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
    say ""
    say "Warning: Node $(node --version) found; the skill needs Node 18 or newer to run."
  fi
else
  say ""
  say "Warning: no node on PATH. The skill needs Node 18 or newer to run."
fi

say ""
say "Installed. Restart Claude Code, then check what it can reach:"
say "  node \"$DEST/scripts/catalog.mjs\" --summary"
