# Delegation Skills

Hand bounded work or a technical decision to another agent CLI on your machine — after asking
**which agent**, then **which model**, then **how much reasoning effort** — and get back a structured
record of what it did.

The skill discovers what is actually installed, offers only choices it can prove exist, dispatches
with an explicit permission profile, and reports the result. It does not commit, push, revert, or
re-dispatch. Those decisions stay yours.

## Requirements

- macOS or Linux
- Node.js 18 or newer
- git (for change attribution; a run without it still works, and says so)
- At least one supported agent CLI, installed and authenticated

## Install

### With the Skills CLI

The repository follows the standard `skills/` layout, so the two skills can be installed together
with the `npx skills` CLI. From a published repository:

```bash
npx skills add <owner>/<repo> --skill delegate --skill debate
```

From this checkout, use a project-scoped install for one agent:

```bash
npx skills add . --skill delegate --skill debate --agent claude-code --yes
```

Add `--global` (`-g`) for a user-wide install, or `--all` to install every skill to all detected
agents. The `debate` skill depends on the bundled `delegate` skill for its verified CLI dispatch
engine, so install both together.

The CLI installs the skill files and supporting references/scripts into the selected agent's normal
skills directory. Use `--global` (`-g`) for a user-wide install, or omit it for a project-scoped
install. List the available skills first with `--list`:

```bash
npx skills add <owner>/<repo> --list
```

## Using delegate

Ask for a delegation in your own words — "delegate this to another agent", "have another agent
implement X", "which agents can I use for this?" The skill then walks the loop:

1. **Discover** — what is installed, at what version, authenticated or not.
2. **Choose** — agent, then model, then effort. Each answer narrows the next.
3. **Brief** — one self-contained task description, sent on stdin.
4. **Dispatch** — with a named permission profile and a full artifact trail.
5. **Review** — re-run the project's real checks; separate the agent's changes from work that was
   already in the tree.
6. **Report** — and stop.

## Delegating a task too large for one run

Ask for it in your own words — "split this up and delegate it", "break this into subtasks", "run
these in parts and summarise". The skill plans the work as an **ordered sequence** of subtasks, each
one responsibility bounded by a seam the code already has, and shows you the table before anything
runs:

| # | Subtask | Owns | Agent | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Flag parsing for `--dry-run` | `src/cli/flags.ts` | codex | 20–40 min |
| 2 | Honour the flag in export | `src/commands/export.ts` | codex | 40–90 min |

Then, on your explicit yes:

- **one agent at a time**, in your own working tree — no worktrees, no patches, no merge, so each
  subtask reads what its predecessors actually left behind;
- **no project check until the last subtask exits** — a suite run against a half-built tree tests a
  tree nobody asked for, so the checks run once, at the end;
- **a failure stops that line of work, not the batch** — dependents are skipped, independent
  subtasks continue, nothing is retried;
- **one recap** that keeps what each agent *reported* apart from what was *checked*, reports the
  seams between subtasks, and names what was not done.

```bash
node skills/delegate/scripts/plan.mjs  template --out plan.json
node skills/delegate/scripts/plan.mjs  show --plan plan.json
node skills/delegate/scripts/batch.mjs run --plan plan.json --cd /path/to/repo --yes
node skills/delegate/scripts/recap.mjs --batch <out-dir>/batch.json
```

Estimates come from each subtask's size class, recalibrated from durations observed on your machine,
and are always ranges with their basis attached — never commitments. The total is a sum, because the
subtasks run back to back.

## Using debate

Ask for help deciding an engineering question when you want arguments, objections, alternatives, and
evidence rather than implementation. `debate` gathers a bounded local reference packet, runs a
read-only initial analysis, asks the orchestrator to test its provisional verdict with supporting and
contradictory web evidence, then runs one final read-only analysis. It reports a recommendation and
uncertainty; it does not edit, commit, or approve code.

The helper commands are available in the plugin checkout:

```bash
node skills/debate/scripts/debate.mjs references --cd /path/to/repo \
  --goal-file decision.md --file src/module.ts --out /tmp/debate-references.json
node skills/debate/scripts/debate.mjs review initial \
  --result /tmp/debate-initial/result.json
```

Every script also runs standalone:

```bash
node skills/delegate/scripts/catalog.mjs  --summary
node skills/delegate/scripts/select.mjs   agents --format text
node skills/delegate/scripts/dispatch.mjs --agent codex --brief brief.txt --cd /path/to/repo
node skills/delegate/scripts/review.mjs   --result <out-dir>/result.json --check "npm test"
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
under — see [the ADR](skills/delegate/references/adr-0001-architecture.md) for the reasoning
and the steps to add one.

## Test

```bash
node skills/delegate/tests/run-tests.mjs
node skills/debate/tests/run-tests.mjs
```

Both suites use Node built-ins only. The delegate suite exercises discovery, selection, dispatch,
process lifecycle, review, plan validation, estimates, the serial runner, and the recap against fake
agent binaries; the debate suite covers packet boundaries, evidence validation, brief structure, and
semantic review.

## Layout

```
skills/delegate/         delegation skill and execution engine
  SKILL.md               the delegation loop, and the large-task path
  references/            selection, briefs, dispatch, review, large tasks, ADRs, glossary
  scripts/               registry, catalog, select, adapters, dispatch, review,
                         plan, batch, recap, timings
  tests/                 suites, fixtures, and fake agent CLIs
skills/debate/           two-pass technical debate skill
  SKILL.md               the debate workflow
  references/            workflow, evidence policy, and protocol
  scripts/               bounded packets, briefs, dispatch, and review
  tests/                 dependency-free protocol and workflow tests
docs/                     implementation plans, ADRs, and glossary
```

## License

MIT. See [LICENSE](LICENSE).
