# ADR 0002 — large tasks: serial dispatch and deferred review

**Status:** accepted · **Date:** 2026-09-10 · **Applies to:** delegate 1.2.0

## Context

Some tasks are too large for one run. Splitting them into several delegated runs raises three
questions the single-task design never had to answer: how do concurrent agents avoid corrupting each
other's edits, when do the project's checks run, and how does a review tell one agent's work from
another's.

The constraints from [ADR 0001](adr-0001-architecture.md) all still hold — Node built-ins only, no
network calls of our own, no credentials in any file we write, two permission profiles per adapter
and no third. Two more were set for this mode: **one agent process at a time**, and **no review until
every subtask has finished**.

## Decisions

### 1. Subtasks run one at a time

Exactly one agent process is alive at any moment, in plan order.

This deletes the entire class of problems concurrency would have introduced: no worktree isolation,
no patch export, no conflicts between siblings, no shared index. Every subtask runs in the user's own
working directory and reads what its predecessors actually left behind, which is what makes a
dependent subtask work at all.

**Consequence:** the batch total is a sum, not a maximum. Six subtasks of one to two hours is most of
a working day, and the plan step has to say so — in the approval table, with a number — before the
user agrees to it.

### 2. Every subtask runs in the user's tree; there is no integration step

No worktrees, no branches, no patches, no merge.

The alternative was a throwaway worktree per subtask, exported as a diff and applied back. That is
the design concurrency would have forced, and it brings conflicts, rejected hunks, and an integration
phase that can fail after every subtask has already been paid for. With serial execution none of it
buys anything: there is never a second writer.

**Consequence:** a batch leaves its edits where a single run leaves them — uncommitted, in the tree
the user will review. It also means a failed subtask's partial work is in that tree, which the recap
names rather than cleans up. Cleaning up would be reverting, and this skill does not revert.

### 3. The plan is an ordered list, not a graph

Execution is serial, so order is total and explicit. `dependsOn` survives for exactly one purpose:
deciding what to skip when a prerequisite fails. A dependency on a subtask that runs later is a
validation error.

**Consequence:** cycles are impossible by construction — a cycle cannot be ordered, so it fails as an
ordering error. No scheduler, no wave derivation, no topological sort to get wrong.

### 4. No project check runs until the last subtask has exited

Not only a scheduling choice. Running the suite after subtask 2 of 6 tests a half-built tree: the
call site exists, the function it calls does not, and the failure says nothing about whether subtask
2 did its job. Check commands therefore belong to the plan, not to the subtask, and run once.

**Consequence:** a wrong subtask 2 is not discovered until subtask 6 has also run and been paid for.
The mitigation is in the plan, not the schedule: per-subtask acceptance criteria sharp enough that
the end-of-batch review can attribute a failure to one subtask rather than to the batch.

### 5. A batch ledger, because a run cannot attribute its own work

`review.mjs` flags changes on paths that were already dirty before a run. In a sequence that fires on
every subtask after the first and means nothing: the predecessors' edits *are* the pre-existing
changes.

The batch records the tree before it starts and around each subtask, so "already there" keeps meaning
*the user's*. The snapshot carries size and mtime alongside the porcelain status line, because a file
subtask 1 created reads as `?? path` both before and after subtask 2 edits it, and `-uall` is used so
two subtasks creating files in one new directory are not collapsed into a single `?? dir/`.

**Consequence:** `findingsFromRun` gained three optional inputs — the user's dirty paths, the owned
paths, and the attributed changes. Called without them it behaves exactly as it did before, which is
what keeps the single-run path unchanged.

### 6. Owned paths are a claim, checked at the end — not a boundary

Each subtask declares the paths it expects to touch. Nothing enforces it mid-run.

Enforcement would mean either sandboxing beyond what the adapters' two profiles offer, or aborting a
run for writing somewhere reasonable — and under serial execution a later subtask editing an earlier
one's file is frequently correct. So the declaration is checked once, at the end, and a write outside
it is a finding the user reads.

**Consequence:** ownership catches sprawl after the fact rather than preventing it, in the same way
`read-only-violation` is a tripwire rather than a boundary.

### 7. Estimates are ranges with a stated basis, calibrated from observation

A size class carries a default range; once enough runs of the same shape have been observed on this
machine, the range is recalibrated from them. Both cases report which they are.

**Consequence:** one more cache file, `timings.json`, holding durations, agent keys, model ids and
size classes — no briefs, no output, no credentials — bounded to the most recent samples. A corrupt
or unwritable store costs an estimate, never a plan or a batch.

### 8. Nothing is dispatched without explicit approval

`batch.mjs run` without `--yes` prints the approval table and exits. Approval is the user seeing the
ordered sequence and the time it will cost, not someone having typed a command.

**Consequence:** an extra round trip on every batch. That is the point: this is the last moment where
merging, splitting, reordering, or dropping a subtask is cheap.

## Alternatives considered

**Concurrent subtasks in isolated git worktrees, integrated by patch.** Rejected in favour of decision
1. It buys wall-clock time and costs conflict resolution, an integration phase that fails last, and a
review that has to reason about a tree assembled from patches rather than the one the agents saw.

**A merge commit per subtask.** Rejected: it would make this skill commit, which is the one thing it
has never done. Committing is the user's decision.

**Reviewing after each subtask.** Rejected in favour of decision 4. It would run the project's suite
against trees nobody asked for, producing failures that are neither the subtask's fault nor
ignorable, and would turn every subtask boundary into a decision point the user has to attend.

**A separate `fanout` skill.** Rejected: it would need its own copy of selection, dispatch, and
review, or a dependency on this one. Batching is the same loop run more than once, so it belongs in
the same package, behind the same refusals.

**Automatic retry of a failed subtask.** Rejected, consistent with ADR 0001: a failure stops that
line of work and is reported. Re-dispatching is a decision, and it is the user's.
