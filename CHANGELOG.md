# Changelog

All notable changes to this package are recorded here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0 — 2026-09-10

Large tasks: split into subtasks, run them one at a time, review them together.

### Added

- **Batch plans** (`delegate.plan.v1`) — an ordered list of subtasks, each one responsibility bounded
  by a seam that already exists in the codebase, with owned paths, acceptance criteria, a size class,
  and its own agent/model/effort. `plan.mjs` validates shape, order, ownership, and selections, and
  warns about sizing — a goal carrying two responsibilities, ownership spanning unrelated areas, a
  sliver that should fold into its neighbour. It never rewrites a plan to make it pass.
- **The approval table.** Nothing is dispatched until the user has seen the sequence: description,
  ownership, agent, per-subtask estimate, and a cumulative total that is a sum, because the subtasks
  run back to back. `batch.mjs run` without `--yes` prints the table and stops.
- **Estimates with a stated basis** (`delegate.timings.v1`), from the size class by default and
  recalibrated from durations observed on this machine once there are enough. Ranges, never
  commitments. Cached beside the catalog; durations only, bounded, and a corrupt store costs an
  estimate rather than a plan.
- **Serial execution** (`delegate.batch.v1`) — exactly one agent process alive at a time, in plan
  order, in the user's own working tree. No worktrees, no patches, no merge: every subtask reads what
  its predecessors left behind. A failed subtask marks its declared dependents `skipped` and lets
  independent ones continue; `--stop-on-failure` halts the rest as `not-started`. Cancelling keeps
  every completed subtask's work and artifacts.
- **A batch ledger**, so "already there" keeps meaning *the user's work* rather than *the previous
  subtask's* — the one attribution a single run cannot make for itself.
- **Deferred review** (`delegate.recap.v1`) — no project check runs until the last subtask has
  exited, because a suite run against a half-built tree tests a tree nobody asked for. `recap.mjs`
  then reviews every subtask against its ledger, criteria, and owned paths, runs the plan's checks
  once over the finished tree, reports the seams between subtasks, and names what was not done. It
  keeps reported and checked apart on every line.
- **Ownership as a checked claim**: `review.mjs --owned <path>` adds an `ownership-violation` finding.
  Nothing is prevented mid-run and nothing is reverted.
- **References**: `large-tasks.md` and `adr-0002-decomposition.md`, plus batch vocabulary in the
  glossary and batch sections in the brief and review references.
- **Tests**: three more suites — plan validation and estimates, the serial runner end to end against
  fake agents, and the recap — including a guard that the single-run path is unchanged.

### Unchanged

- One task, one run behaves exactly as it did in 1.1.0: same flags, same `delegate.run.v1` record,
  same adapters, same two permission profiles, same refusals. `findingsFromRun` gained optional
  arguments and behaves identically without them.

### Known limits

- A wrong subtask early in a batch is not discovered until the batch finishes and has been paid for.
  That is the cost of deferring the checks; sharp per-subtask acceptance criteria are the mitigation.
- Owned paths are checked after the fact, not enforced. Like read-only, the report is a tripwire.
- A batch cancelled in the first moments of a subtask, before the dispatcher has written a result,
  records that subtask as `aborted` with its partial artifacts and no result file.

## 1.1.0 — 2026-09-10

Evidence-informed technical debate skill added.

### Added

- `debate`, a two-pass read-only workflow for local references, provisional analysis,
  contradictory web evidence, and a final recommendation.
- Versioned reference, evidence, semantic review, and decision protocols with bounded packet helpers
  and tests.

## 1.0.0 — 2026-09-10

First release.

### Added

- **Agent registry** covering fourteen CLIs: Claude Code, Cline, Codex, OpenCode, Antigravity, Grok,
  Kimi, Qoder, Vibe, Cursor Agent, Pi, Aider, GitHub Copilot CLI, and Warp. Every probe is chosen so
  it cannot be read as a prompt by the CLI it targets.
- **Discovery catalog** (`delegate.catalog.v1`) cached at
  `${XDG_CACHE_HOME:-~/.cache}/delegate/catalog.json`, published atomically, valid for 24 hours
  and invalidated when an executable's path or on-disk fingerprint moves. A failed refresh returns
  the previous catalog labelled stale rather than nothing.
- **Selection** in one direction — agent, then model, then effort — with the provenance of every
  identifier carried through to the user: live listing, cached catalog, curated alias, manual entry,
  or CLI default. Hidden models are excluded. Effort defaults to `high` only where high is verified
  for that exact agent and model.
- **Dispatch adapters** for the four CLIs that could be exercised locally, each with exactly two
  permission profiles (write and read-only), stated on every invocation including resumed turns. The
  brief always travels on stdin.
- **Run results** (`delegate.run.v1`) written on every outcome once the brief validates, with
  change accounting that separates the agent's edits from work already in the tree.
- **Review** (`delegate.review.v1`) that re-runs the project's own checks and records findings.
  Its verdict is `findings-reported` or `no-findings` — never `approved`.
- **References**: selection flow, writing the brief, dispatch and results, review and report, an ADR
  covering the architecture, and a glossary.
- **Tests**: five suites, no dependencies and no network. Dispatch is exercised against fake agent
  binaries on a throwaway PATH, covering cancellation, watchdog timeouts, non-zero exits, malformed
  events, paths containing spaces, and partial-artifact preservation.
- **Packaging**: a repository layout compatible with the Skills CLI, with both skills discoverable
  under `skills/`.

### Known limits

- Ten of the fourteen registry entries are discovery-only. They are found and described but cannot
  receive a task, because no adapter was written without the CLI in hand.
- A launcher shim whose bytes do not change when its package is upgraded will not invalidate the
  catalog before the 24-hour TTL. `--refresh` forces it, and the version actually launched is
  recorded in every run result.
- Read-only mode is enforced by each agent, not by this skill. The change report is a tripwire that
  makes a violation visible; it is not a boundary.
- macOS and Linux only. The code carries Windows handling for shims and process trees, but nothing
  here has been verified on Windows.
