# delegate-skill

Hand a bounded task to another agent CLI on your machine — after asking **which agent**, then **which
model**, then **how much reasoning effort** — and get back a structured record of what it did.

The skill discovers what is actually installed, offers only choices it can prove exist, dispatches
with an explicit permission profile, and reports the result. It does not commit, push, revert, or
re-dispatch. Those decisions stay yours.

## Requirements

- macOS or Linux
- Node.js 18 or newer
- git (for change attribution; a run without it still works, and says so)
- At least one supported agent CLI, installed and authenticated

## Install

### Into your skills directory (recommended for local use)

```bash
./install.sh
```

Symlinks the skill into `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/delegate-skill`, so edits in this
repository take effect on the next session. Use `--copy` for a frozen snapshot, `--target <dir>` for
somewhere else, and `--uninstall` to remove it. It never overwrites or deletes anything at the
destination that it did not put there.

Restart Claude Code, then confirm what it can reach:

```bash
node ~/.claude/skills/delegate-skill/scripts/catalog.mjs --summary
```

### As a Claude Code plugin

From a local checkout:

```bash
claude plugin marketplace add .
claude plugin install delegate-skill@delegation-skills
```

Once this repository is published, the same works from GitHub:

```bash
claude plugin marketplace add <owner>/<repo>
claude plugin install delegate-skill@delegation-skills
```

### By hand

Copy `skills/delegate-skill/` anywhere your agent loads skills from. It is self-contained: no
dependencies, no install step, no manifest of its own.

## Using it

Ask for a delegation in your own words — "delegate this to another agent", "have another agent
implement X", "which agents can I use for this?" The skill then walks the loop:

1. **Discover** — what is installed, at what version, authenticated or not.
2. **Choose** — agent, then model, then effort. Each answer narrows the next.
3. **Brief** — one self-contained task description, sent on stdin.
4. **Dispatch** — with a named permission profile and a full artifact trail.
5. **Review** — re-run the project's real checks; separate the agent's changes from work that was
   already in the tree.
6. **Report** — and stop.

Every script also runs standalone:

```bash
node skills/delegate-skill/scripts/catalog.mjs  --summary
node skills/delegate-skill/scripts/select.mjs   agents --format text
node skills/delegate-skill/scripts/dispatch.mjs --agent codex --brief brief.txt --cd /path/to/repo
node skills/delegate-skill/scripts/review.mjs   --result <out-dir>/result.json --check "npm test"
```

## Supported agents

Fourteen CLIs are in the registry. All fourteen are **discovered** — found on PATH, versioned,
authentication-probed, and their models listed where a credential-free listing exists. Four have
**dispatch adapters** that were written against a real, locally installed CLI:

| Dispatchable | Effort mechanism |
| --- | --- |
| Claude Code (`claude`) | `--effort <level>` |
| OpenAI Codex (`codex`) | `-c model_reasoning_effort=<level>`, verified per model |
| OpenCode (`opencode`) | `--variant <name>` |
| Cursor Agent (`cursor-agent`) | `model[effort=<level>]` |

Discovery-only: Cline, Antigravity, Grok, Kimi, Qoder, Vibe, Pi, Aider, GitHub Copilot CLI, Warp.
They appear in the catalog with the reason they cannot receive a task. Writing an adapter from
documentation alone would risk a wrong flag silently changing the permission profile a run executes
under — see [the ADR](skills/delegate-skill/references/adr-0001-architecture.md) for the reasoning
and the steps to add one.

## Verify

```bash
./verify.sh
```

Runs the skill's test suite, validates both manifests and the skill's frontmatter with
`claude plugin validate --strict`, checks that the version agrees everywhere it appears, and exercises
the installer — including that it refuses to clobber a directory it did not create.

The tests alone:

```bash
node skills/delegate-skill/tests/run-tests.mjs
```

No dependencies and no network. Dispatch is exercised end to end against fake agent binaries on a
throwaway PATH — real processes, real stdin, real signals, real exit codes, and no paid runs.

## Layout

```
.claude-plugin/          plugin and marketplace manifests
skills/delegate-skill/   the skill itself — this is what gets installed
  SKILL.md               the loop the orchestrator follows
  references/            selection, briefs, dispatch, review, ADR, glossary
  scripts/               registry, catalog, select, adapters, dispatch, review
  tests/                 five suites, a runner, fixtures, and fake agent CLIs
docs/                    the implementation plan this was built from
install.sh               local install / uninstall
verify.sh                tests + manifest validation + version consistency
```

## Publishing

Before pushing this anywhere public, fill in the two fields left out on purpose rather than guessed:
add `homepage` and `repository` to `.claude-plugin/plugin.json`, and a `homepage` to the plugin entry
in `.claude-plugin/marketplace.json`. Then `claude plugin tag` cuts a release tag and checks that the
manifests agree.

## License

MIT. See [LICENSE](LICENSE).
