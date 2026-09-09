#!/bin/sh
# delegate-skill · verify.sh
#
# Check the package before installing or publishing it:
#   1. the skill's own test suite
#   2. both manifests and the skill's frontmatter, via `claude plugin validate --strict`
#   3. the version agrees in plugin.json, marketplace.json, SKILL.md, and CHANGELOG.md
#   4. install.sh installs, refuses to clobber, and uninstalls cleanly
#
# Exit 0 when everything passed, 1 otherwise. Step 2 is skipped with a notice if
# the `claude` CLI is not on PATH; nothing else needs anything beyond Node.
#
# Usage: ./verify.sh [-h|--help]

set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR="$REPO_DIR/skills/delegate-skill"
FAILED=0

case "${1:-}" in
  -h|--help)
    awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
    exit 0
    ;;
  "") ;;
  *) printf 'verify: unknown option: %s\n' "$1" >&2; exit 1 ;;
esac

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1"; FAILED=1; }
pass() { printf '  ok: %s\n' "$1"; }

step "skill tests"
if node "$SKILL_DIR/tests/run-tests.mjs" | tail -1; then
  pass "test suite"
else
  fail "test suite"
fi

step "manifests"
if command -v claude >/dev/null 2>&1; then
  if claude plugin validate "$REPO_DIR" --strict 2>&1 | grep -q "Validation passed"; then
    pass "marketplace.json (--strict)"
  else
    claude plugin validate "$REPO_DIR" --strict 2>&1 | sed 's/^/  /'
    fail "marketplace.json"
  fi
  if claude plugin validate "$REPO_DIR/.claude-plugin/plugin.json" --strict 2>&1 | grep -q "Validation passed"; then
    pass "plugin.json (--strict)"
  else
    claude plugin validate "$REPO_DIR/.claude-plugin/plugin.json" --strict 2>&1 | sed 's/^/  /'
    fail "plugin.json"
  fi
  # Validating the repo root stops at marketplace.json and never reaches the
  # bundled skill, so point the validator at the skills directory as well.
  if claude plugin validate "$REPO_DIR/skills" --strict 2>&1 | grep -q "Validation passed"; then
    pass "SKILL.md frontmatter (--strict)"
  else
    claude plugin validate "$REPO_DIR/skills" --strict 2>&1 | sed 's/^/  /'
    fail "SKILL.md frontmatter"
  fi
else
  printf '  skipped: no `claude` on PATH\n'
fi

step "version consistency"
# One version, four places it can drift. Read each from its own file rather than
# trusting any of them to be the source of truth.
if node -e '
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const found = {
  "plugin.json": JSON.parse(read(".claude-plugin", "plugin.json")).version,
  "marketplace.json": JSON.parse(read(".claude-plugin", "marketplace.json")).plugins[0].version,
  "SKILL.md": (/^\s+version:\s*(\S+)\s*$/m.exec(read("skills", "delegate-skill", "SKILL.md")) || [])[1],
  "CHANGELOG.md": (/^##\s+(\d+\.\d+\.\d+)/m.exec(read("CHANGELOG.md")) || [])[1],
};
const versions = new Set(Object.values(found));
for (const [file, version] of Object.entries(found)) {
  console.log(`  ${file.padEnd(18)} ${version ?? "(not found)"}`);
}
if (versions.size !== 1 || versions.has(undefined)) {
  console.error("  versions disagree");
  process.exit(1);
}
' "$REPO_DIR"; then
  pass "one version everywhere"
else
  fail "version consistency"
fi

step "installer"
SCRATCH="$REPO_DIR/.verify-scratch/skills"
rm -rf -- "$REPO_DIR/.verify-scratch"

if "$REPO_DIR/install.sh" --target "$SCRATCH" --dry-run >/dev/null && [ ! -e "$SCRATCH" ]; then
  pass "--dry-run changes nothing"
else
  fail "--dry-run changed something"
fi

if "$REPO_DIR/install.sh" --target "$SCRATCH" >/dev/null && [ -L "$SCRATCH/delegate-skill" ]; then
  pass "install creates the symlink"
else
  fail "install did not create the symlink"
fi

if "$REPO_DIR/install.sh" --target "$SCRATCH" >/dev/null 2>&1; then
  fail "a second install should refuse instead of clobbering"
else
  pass "refuses to overwrite without --force"
fi

if "$REPO_DIR/install.sh" --target "$SCRATCH" --uninstall >/dev/null && [ ! -e "$SCRATCH/delegate-skill" ]; then
  pass "uninstall removes it"
else
  fail "uninstall left something behind"
fi

# The guard that matters most: a directory this script did not create must
# survive even --force.
mkdir -p -- "$SCRATCH/delegate-skill"
: > "$SCRATCH/delegate-skill/someone-elses-file"
if "$REPO_DIR/install.sh" --target "$SCRATCH" --force >/dev/null 2>&1; then
  fail "--force overwrote a directory it did not install"
elif [ -f "$SCRATCH/delegate-skill/someone-elses-file" ]; then
  pass "--force refuses a foreign directory and leaves it intact"
else
  fail "a foreign directory was damaged"
fi
rm -rf -- "$REPO_DIR/.verify-scratch"

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf 'verify: all checks passed\n'
  exit 0
fi
printf 'verify: something failed above\n'
exit 1
