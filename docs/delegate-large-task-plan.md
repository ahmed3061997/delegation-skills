# delegate large-task plan

Status: implemented in `skills/delegate/` on 2026-09-10 as version 1.2.0.

Two things changed during implementation, both recorded in
[adr-0002-decomposition.md](../skills/delegate/references/adr-0002-decomposition.md):

- `batch.mjs` **spawns `dispatch.mjs` as a child process** rather than calling it as a module. The
  dispatcher owns its own signal handling and exit codes, and reusing it as a process keeps that
  intact — a subtask is a real dispatch, not a simulated one.
- The batch snapshots the tree with `git status --porcelain -uall` **plus size and mtime per path**.
  Porcelain alone collapses new files into `?? dir/` and reports an unchanged line when a subtask
  edits a file its predecessor created — both of which a batch produces routinely and a single run
  never does.

## Summary

Teach `delegate` to handle a task that is too large for one run: split it into bounded subtasks,
dispatch them **one at a time**, and — once every subtask has finished — review the accumulated
result and report one recap.

This is an addition to the existing skill, not a new one. The registry, catalog, selection flow,
adapters, permission profiles, and the `delegate.run.v1` contract are unchanged, and a single-task
delegation runs exactly the same code path it runs today. The multi-subtask path is the same loop,
executed in sequence, with the review moved to the end.

The refusals carry over unchanged: no commit, no push, no revert, no automatic re-dispatch, no
permission widening after a refusal, no silent substitution of agent, model, or effort. Splitting the
work does not relax any of them — it multiplies the places they have to hold.

## Confirmed requirements

- Take one large task and produce a set of smaller delegated tasks from it.
- Cut those subtasks along **responsibility boundaries**, and keep each one as small as the boundary
  allows.
- Show the user the **ordered, briefed sequence** before anything runs — each subtask with a plain
  description and an expected duration, plus a cumulative estimate for the batch.
- Dispatch those subtasks through the existing adapters, **strictly one at a time**, in order.
- Run **no review until every subtask has finished** — then review each result and the whole tree.
- Recap all of it in one report, and stop.

## Two constraints that shape everything

**Serial dispatch.** Exactly one agent process runs at a time. That removes the entire class of
problems that concurrency would have introduced — no worktree isolation, no patch export, no merge
conflicts between siblings, no shared-index corruption. Every subtask runs in the user's actual
working directory and sees everything its predecessors did, which is what makes a dependent subtask
work at all. The cost is wall-clock time: implementation runs routinely take one to two hours, and
six subtasks take six to twelve. That is the trade being made deliberately, and the plan step has to
say so out loud before the user agrees to it.

**Deferred review.** Nothing is checked until the last subtask exits. This is not only a scheduling
choice — it is a correctness one. Running the project's test suite after subtask 2 of 6 tests a
half-built tree: the call site exists, the function it calls does not, and the failure says nothing
about whether subtask 2 did its job. Checks belong at the end, when the tree is whole.

Two consequences follow, and both are load-bearing:

- **Check commands move to the batch level.** A subtask brief may still tell the agent how to verify
  its own narrow slice, but the project's real check suite is run once, by the skill, after the batch.
  A mid-batch check failure reported by a child is advisory, not a verdict.
- **A failure is discovered late.** If subtask 2 was wrong, nothing says so until subtask 6 has also
  run and paid for. The mitigation is the plan, not the schedule: each subtask carries acceptance
  criteria specific enough that the end-of-batch review can attribute a failure to one subtask
  instead of to the batch as a whole.

## What already exists

- [SKILL.md](../skills/delegate/SKILL.md): the six-step loop — discover, select, brief, dispatch,
  review, report. That loop is the unit this plan sequences; it is not being rewritten.
- [dispatch-and-results.md](../skills/delegate/references/dispatch-and-results.md): `--cd`,
  `--out-dir`, `--read-only`, `--session`, `--timeout`, the `delegate.run.v1` result, and the eight
  statuses. `--out-dir` is already per-run, so sequenced runs keep separate artifact trails with no
  change to the dispatcher.
- [writing-the-brief.md](../skills/delegate/references/writing-the-brief.md): a brief is
  self-contained. A subtask brief is a brief — same template, same report contract, one task each.
  Subtasks do not see each other's briefs.
- [review-and-report.md](../skills/delegate/references/review-and-report.md): `review.mjs` judges one
  run against one brief, verdict `findings-reported` or `no-findings`, and flags changes on paths
  that were already dirty before that run.
- [adr-0001-architecture.md](../skills/delegate/references/adr-0001-architecture.md): four verified
  adapters, ten discovery-only entries. This plan adds no adapters and does not revisit that limit.

Two gaps, both narrow. `review.mjs` knows nothing about siblings, so two subtasks can each return
`no-findings` and still contradict each other. And its dirty-path check would fire on every subtask
after the first, because its predecessors' edits are exactly "changes that were already there" — that
needs a batch baseline to stay meaningful.

## When not to split

Checked before any dispatch, and reported plainly when it fires:

- Fewer than two subtasks come out of the task.
- Each candidate subtask is small enough to do inline, or one ordinary `delegate` run covers them all
  more cheaply than the split does.
- The subtasks cannot be briefed independently — if each brief needs the full context of all the
  others to make sense, it is one task described three ways.
- The serial total exceeds what the user will wait for. Six subtasks is most of a working day.

Note what is *not* on this list any more: inherently sequential work. Serial dispatch handles it
natively — each subtask sees its predecessor's output in the tree. Sequential dependency is now a
reason to split, not a reason to refuse.

## Cutting the subtasks

A subtask is one responsibility, bounded by a seam that already exists in the codebase, and no larger
than that boundary requires. Cut along the seams the code gives you — a module, a layer, an interface,
a migration, a test target — not along an arbitrary line count. A boundary the code already respects
is one an agent can be briefed about without describing the rest of the system.

**One subtask, one responsibility.** Its goal is expressible in a single sentence with no "and". Its
acceptance criteria are all about the same thing. It has one deliverable — a working change to one
part of the system, not a bundle.

**Smaller is better, up to the boundary.** A smaller subtask has a shorter brief, a narrower diff, a
cheaper failure, and a review that can actually attribute a problem to it. Split down to the smallest
piece that still stands alone; do not split *below* the seam, because the pieces then need each
other's context and the briefs stop being self-contained.

Signs a subtask is too big, checked at plan time:

- Its goal needs "and", or a bulleted list of unrelated outcomes.
- Its owned paths span parts of the system that do not depend on each other.
- Its acceptance criteria could pass in halves — half done is a coherent state.
- It would take longer than the largest size class below.

Signs it is too small, and should fold into a neighbour:

- It cannot be briefed without restating a sibling's brief.
- It produces no deliverable on its own — pure setup, or a rename its neighbour will absorb.
- Writing the brief costs more than doing the work inline.

**Where smallness stops paying.** Serial dispatch makes the batch total a sum, and every subtask
carries fixed overhead — a brief to write, a process to start, a result to record. Ten small subtasks
can take longer than five right-sized ones and produce a worse recap, because the responsibility gets
spread across pieces that no single review can judge. The floor on smallness is therefore both the
seam and the budget: take the smallest piece that stands alone, then merge adjacent slivers of the
same responsibility if the estimated total is more than the user wants to spend. The plan states that
trade rather than resolving it silently.

Each subtask therefore carries, in the plan: a short title, a one-line description in plain language
for the user, the responsibility it owns, its owned paths, its acceptance criteria, and a size class.

## What the user approves

Before anything is dispatched, the user sees the whole sequence — in order, briefed, with time:

| # | Subtask | Owns | Agent | Estimate |
| --- | --- | --- | --- | --- |
| 1 | plain-language description of the responsibility | paths | agent · model · effort | 20–40 min |
| 2 | … | … | … | 45–90 min |

…followed by a cumulative estimate for the batch, including the end-of-batch review, and a plain
statement that these are serial: the total is the sum, not the maximum.

**Where the estimate comes from.** Each subtask is assigned a size class at plan time — small,
medium, or large — from its scope and owned-path count, and each class carries a duration range.
Once the skill has recorded enough finished runs for a given agent and model, the ranges are
recalibrated from those observations instead of the defaults; until then, the defaults are used and
labelled as such. Observations live in
`${XDG_CACHE_HOME:-~/.cache}/delegate/timings.json`, beside the existing catalog, and hold durations
only — no briefs, no output, no credentials.

Estimates are ranges and are presented as estimates, never as commitments. An agent run is not
predictable to the minute, and a plan that implies otherwise is worse than one that says "45–90
minutes, based on eleven previous medium Codex runs". During the batch the skill reports progress the
same way: subtask *k* of *n*, elapsed, and a revised estimate for what remains.

## Design decisions

1. **One skill, one engine.** The new work lives in `skills/delegate/`, reuses `catalog.mjs`,
   `select.mjs`, `adapters.mjs`, `dispatch.mjs`, and `review.mjs` as modules, and duplicates none of
   them. No adapters added, no second catalog owner, no sibling-skill dependency.
2. **Decomposition is the orchestrator's judgment, structured by the skill.** The skill supplies the
   subtask contract, the sizing heuristics, and mechanical validation; it does not try to split
   arbitrary prose on its own. A helper rejects a malformed plan before anything runs.
3. **Subtasks are cut by responsibility and kept small.** The boundary comes from the code, the size
   comes from the boundary, and both are validated mechanically where they can be — a goal
   containing "and", owned paths spanning unrelated areas, or a size class inconsistent with the
   declared scope are all plan-time warnings the user sees before approving.
4. **The plan is an ordered list, not a graph.** Execution is serial, so order is total and explicit.
   `dependsOn` survives for one purpose only: deciding what to skip when a prerequisite fails.
5. **The user approves a briefed sequence with time attached.** Nothing dispatches until the ordered
   table — description, ownership, agent, per-subtask estimate, cumulative total — has been shown and
   accepted. Estimates come from size class, recalibrated from recorded run durations once there are
   enough of them, and are always ranges.
6. **Every subtask runs in the user's working tree.** No worktrees, no branches, no patches, no
   integration step. Subtask *n* starts from whatever subtask *n−1* left behind — the same tree the
   user will review at the end.
7. **A batch ledger replaces per-run attribution.** The batch records the tree state before it starts
   and before each subtask. Paths dirty before the batch stay attributed to the user; every change
   after that is attributed to the subtask that was running when it appeared. Without this, the
   existing dirty-path finding fires on every subtask after the first and means nothing.
8. **Owned paths are declared and checked, not enforced.** Each subtask declares the paths it expects
   to create or modify. Overlap between subtasks is legitimate under serial execution — a later
   subtask may well edit an earlier one's file. A write outside the declared set is a review finding,
   not a pre-dispatch error, and it is raised at the end with the rest.
9. **Failure does not cascade into retries.** A failed subtask marks its declared dependents
   `skipped` and lets independent successors continue. The batch halts entirely only when the user
   asked it to, or when nothing downstream can still run. No automatic re-dispatch, no permission
   widening, no agent substitution — the existing refusals, applied per subtask.
10. **No review runs mid-batch.** `review.mjs` is invoked once per subtask *after the last one exits*,
    against the retained per-run artifacts, and the project's check suite is run once over the
    finished tree. A batch that is cancelled or halted early still gets its review over whatever ran.
11. **Budget is explicit and bounded.** Maximum subtasks, a per-subtask timeout, and a total wall-clock
    bound are fixed before dispatch and restated in the recap. The dispatcher's watchdog is off by
    default today, which is defensible for one run and not for a six-hour sequence.
12. **Selection is asked once, overridable per subtask.** The existing three questions cover the
    batch by default; a subtask may name its own agent, model, or effort. Every selection resolves
    through `select.mjs` and is validated against the catalog at planning time, so an unusable choice
    fails before the first dispatch rather than four hours in.
13. **Backwards compatible.** No existing flag, contract field, status, or test changes meaning.
    `delegate.run.v1` stays as it is; the new records reference run results rather than reshaping
    them. A user who never splits a task sees no difference.

## The extended loop

The single-run loop is unchanged and still ends at step 6. When a task is split, the sequence below
takes over: an assess step in front, plan and approval steps in the middle, and the review moved
behind the whole dispatch sequence.

0. **Assess** — one run or several? Apply the "when not to split" tests. If one, continue exactly as
   today and stop reading here.
1. **Discover** — unchanged.
2. **Select** — unchanged, asked once for the batch, with per-subtask overrides allowed.
3. **Plan** — cut the work along responsibility boundaries and write the ordered subtask list: id,
   title, one-line description, the responsibility it owns, owned paths, `dependsOn`,
   agent/model/effort, read-only or write, acceptance criteria, and size class. Validate it: schema,
   order, unknown ids, cycles, dispatchable agents, resolvable models and efforts, sizing warnings,
   budget within limits.
4. **Present and confirm** — show the ordered table: each subtask's description, what it owns, which
   agent runs it, and its estimated duration, with a cumulative total that says plainly these run
   back to back. Dispatch only on an explicit yes. A subtask the user wants merged, split, reordered,
   or dropped is changed in the plan and re-validated, not negotiated mid-batch.
5. **Brief and dispatch, one at a time** — for each subtask in order: record the tree state, write the
   brief with the existing template, dispatch with the existing dispatcher, wait for the process to
   exit and `result.json` to carry a status, attribute the changes, record the actual duration, then
   move to the next. No checks, no review, no user decision in between. Progress is reported as
   subtask *k* of *n* with a revised estimate for the remainder. A subtask that fails marks its
   dependents `skipped`.
6. **Review, once everything has finished** — `review.mjs` per subtask against the batch ledger and
   that subtask's acceptance criteria, including owned-path violations; then the project's full check
   suite over the finished tree; then the seams: duplicated helpers, contradictory decisions, an
   interface one subtask defined and another ignored, gaps neither side covered.
7. **Recap and stop** — one report. Edits stay in the working tree, uncommitted.

A batch runs for hours, so `batch.mjs` is meant to be backgrounded the way a single dispatch already
is — on Claude Code, `run_in_background: true`. The batch is finished when `batch.json` carries a
terminal status, not when a progress line says so.

## Contracts

New records, versioned in the existing `delegate.*` family:

**`delegate.plan.v1`** — plan id, base commit, budget (`maxSubtasks`, `subtaskTimeout`,
`totalTimeout`), `stopOnFailure`, `estimatedTotal` (a range, with its basis: defaults or observed
runs), and an ordered array of subtasks: id, `title`, `description` (the user-facing line),
`responsibility`, goal, `ownedPaths`, `dependsOn`, `agent`/`model`/`effort`, `readOnly`,
`acceptanceCriteria`, `sizeClass`, `estimate` (range plus basis), and any sizing warnings raised at
validation. Batch-level `checks`.

**`delegate.batch.v1`** — plan reference, the baseline tree state, and per subtask: status, path to
its `delegate.run.v1` result, its slice of the change ledger, start and end times, `actualMinutes`,
and (after the review phase) its `delegate.review.v1`.

**`delegate.recap.v1`** — counts by status, the whole-tree check results, per-subtask findings,
owned-path violations, cross-subtask findings, estimated versus actual duration per subtask and for
the batch, and an explicit list of what was *not* done.

**`delegate.timings.v1`** — the observation store at
`${XDG_CACHE_HOME:-~/.cache}/delegate/timings.json`: per agent, model, and size class, a bounded
list of recorded durations and the count behind them. Durations only.

Subtask statuses reuse the eight `delegate.run.v1` statuses and add `skipped` (a declared
prerequisite failed) and `not-started` (the batch halted or was cancelled first).
`delegate.review.v1` gains one finding kind, `ownership-violation`, alongside the kinds it already
emits.

All artifacts for a batch live under one run directory, one numbered subdirectory per subtask, each
holding the standard artifact set.

## What the recap must say

The recap is the deliverable, written for someone who watched none of it:

- Per subtask, in execution order: the same description the user approved, which agent did it, what
  it reported, what the review found, which files it changed, and estimated versus actual time.
- What the whole-tree checks said — the number that matters most, and the one no individual subtask
  could report while the tree was half-built.
- Cross-subtask findings: duplication, contradiction, gaps between the pieces.
- What did not run: skipped subtasks with the id that blocked them, and anything cut short.
- What the user must decide: which subtask to re-run, what to fix by hand, whether to commit.

The existing posture holds and matters more here: an agent's summary is a claim, not evidence.
Aggregating six unverified claims produces one large unverified claim. The recap keeps reported and
checked separate, per subtask.

## Changes to the package

```
skills/delegate/
  SKILL.md                          + assess step, + the multi-subtask branch of the loop
  references/large-tasks.md         new: cutting by responsibility, sizing, ordering, the approval
                                      table and estimates, the ledger, deferred review
  references/writing-the-brief.md   + subtask briefs, owned paths, batch-level checks
  references/review-and-report.md   + the end-of-batch review phase and the whole-tree pass
  references/glossary.md            + subtask, batch, ordered plan, owned path, ledger, recap
  references/adr-0002-decomposition.md
                                    new: serial dispatch and deferred review, and the rejected
                                      alternatives — concurrent worktrees with patch integration,
                                      and per-subtask review between runs
  scripts/plan.mjs                  new: plan validation, sizing warnings, ordering, budget checks,
                                      estimates and the approval table
  scripts/timings.mjs               new: the observation store and estimate calibration
  scripts/batch.mjs                 new: sequential runner, tree-state ledger, halt and skip
                                      handling; spawns dispatch.mjs per subtask
  scripts/lib/ownership.mjs         new: owned-path matching, shared by plan and review
  scripts/recap.mjs                 new: end-of-batch review sweep, whole-tree checks, aggregation
  scripts/review.mjs                + ownership-violation findings, + batch-baseline attribution
  tests/plan.test.mjs               new
  tests/timings.test.mjs            new
  tests/batch.test.mjs              new
  tests/recap.test.mjs              new
  tests/run-tests.mjs               + the four suites
```

Repository docs follow: README gains a large-task section, CHANGELOG gains a 1.2.0 entry, and
`SKILL.md` metadata moves to 1.2.0. Minor version — everything here is additive.

## Validation and acceptance

Dependency-free Node tests in the style of the existing suites, against the bundled fake agent
binaries on a throwaway PATH:

- Plan validation: missing fields, unknown `dependsOn` ids, cycles, an order inconsistent with
  declared dependencies, non-dispatchable agents, unresolvable models and efforts, budget overruns.
- Sizing warnings: a multi-responsibility goal, owned paths spanning unrelated areas, a size class
  inconsistent with the declared scope, and a subtask small enough that it should fold into its
  neighbour — each surfaced as a warning on the plan, not a silent rewrite of it.
- Estimates: default ranges by size class; calibration from recorded runs once the sample threshold
  is met; the basis reported honestly in both cases; a cumulative total that sums rather than
  maximises; the approval table rendering in order with every column populated.
- Timings store: bounded growth, atomic writes, a corrupt or unreadable store falling back to the
  defaults instead of failing the plan, and durations only — no brief, output, or credential
  material written.
- Approval: nothing dispatches before an explicit yes; an edited plan is re-validated and re-shown
  rather than partially executed.
- Sequencing: exactly one child process alive at any moment; subtask *n+1* not launched until *n*
  has exited and its result carries a status; dependents of a failure marked `skipped`; independent
  successors still running; `stopOnFailure` halting the rest as `not-started`.
- Ledger and attribution: a clean starting tree, a dirty starting tree whose changes stay attributed
  to the user, edits by subtask 1 correctly attributed to subtask 1 rather than flagged as
  pre-existing for subtask 2, and a subtask writing outside its declared paths.
- Deferred review: no check command executed before the last subtask exits; the review sweep running
  over every retained result afterwards; a cancelled or halted batch still producing a review over
  the subtasks that ran.
- Recap: contract shape, status counts, reported-versus-checked separation, estimate-versus-actual
  per subtask and for the batch, and a non-empty "what was not done" list whenever anything failed,
  was skipped, or never started.
- Refusals, per subtask and for the batch: no automatic re-dispatch, no permission widening, no agent
  substitution, no commit, no revert.
- Regression: the existing five suites pass unchanged, and a single-task dispatch produces the same
  `result.json` shape as today.

Acceptance: a multi-subtask batch completes end to end against fake agents with no paid run; the user
sees an ordered, described, time-estimated sequence before a single process starts; a forced failure
mid-sequence still produces a complete, honest recap naming what never ran; a cancelled batch leaves
every completed subtask's work and artifacts intact; and the single-run path is untouched.

## Non-goals

Concurrency. Committing, pushing, opening a PR. Re-running failed subtasks automatically. Automatic
decomposition of arbitrary prose without orchestrator judgment. Cross-repository batches. New
dispatch adapters — the four verified ones and the reasoning behind that limit stay as they are.
Predicting a run's duration to the minute, or presenting an estimate as a deadline.
