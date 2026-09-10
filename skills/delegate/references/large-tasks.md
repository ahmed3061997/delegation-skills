# Large tasks: splitting, sequencing, and the recap

Some tasks do not fit in one run. This is the path for those: cut the work into bounded subtasks,
show the user the ordered sequence with what each will cost, dispatch them **one at a time**, and
review everything **once, at the end**.

Everything else stays as it is. Each subtask is an ordinary run through the ordinary dispatcher, with
the ordinary permission profiles and the ordinary `delegate.run.v1` result. This mode sequences that
loop; it does not replace it.

## First: is this actually a batch?

Do not split when:

- Fewer than two subtasks come out of the task.
- Each candidate is small enough to do inline, or one ordinary run covers them all more cheaply.
- The subtasks cannot be briefed independently. If each brief needs the full context of all the
  others, it is one task described three ways.
- The serial total is more time than the user will spend. Six subtasks is most of a working day.

Note what is *not* a reason to refuse: work where each step depends on the last. Serial dispatch
handles that natively — subtask *n* reads the tree subtask *n−1* left behind. Sequential dependency
is a reason to split, not a reason to decline.

## Cutting the subtasks

**One subtask, one responsibility, bounded by a seam the code already has** — a module, a layer, an
interface, a migration, a test target. A boundary the codebase already respects is one an agent can
be briefed about without describing the rest of the system.

Too big, and the plan warns you:

- the goal needs an "and", or a list of unrelated outcomes
- owned paths span parts of the system that do not depend on each other
- the acceptance criteria could pass in halves — half done is a coherent state

Too small, and it should fold into its neighbour:

- it cannot be briefed without restating a sibling's brief
- it produces no deliverable of its own — pure setup, a rename the next subtask absorbs
- writing the brief costs more than doing the work inline

**Where smallness stops paying.** Serial dispatch makes the total a sum, and every subtask carries
fixed overhead: a brief to write, a process to start, a result to record. Ten small subtasks can take
longer than five right-sized ones *and* produce a worse recap, because the responsibility is spread
across pieces no single review can judge. Take the smallest piece that stands alone, then merge
adjacent slivers of the same responsibility if the estimated total is more than the user wants to
spend. State that trade; do not resolve it silently.

## Writing the plan

```bash
node "<skill-dir>/scripts/plan.mjs" template --out plan.json
```

Each subtask carries:

| Field | Why it is required |
| --- | --- |
| `id` | Referenced by `dependsOn`, and it names the artifact directory. |
| `title`, `description` | What the user reads in the approval table. |
| `responsibility` | The one thing this subtask owns. Two subtasks sharing one is a warning. |
| `goal` | One sentence. If it needs "and", the split is wrong. |
| `ownedPaths` | The claim the recap checks. Required for a write subtask. |
| `dependsOn` | Earlier ids only. Decides what is skipped when something fails. |
| `agent`, `model`, `effort` | Resolved against the catalog at plan time, not mid-batch. |
| `acceptanceCriteria` | What the end-of-batch review judges this subtask against. |
| `sizeClass` | `small`, `medium`, or `large`. The estimate comes from it. |
| `readOnly` | For analysis subtasks whose deliverable is a report, not a diff. |
| `context`, `do`, `brief` | Optional. `brief` replaces the composed brief entirely. |

Plan-level: `title`, `goal`, `checks` (the project's real commands, run **once** at the end),
`budget` (`maxSubtasks`, `subtaskTimeout`, `totalTimeout`), and `stopOnFailure`.

```bash
node "<skill-dir>/scripts/plan.mjs" validate --plan plan.json
```

Errors block the batch: a malformed subtask, a duplicate id, a dependency that runs later, an
ownership path outside the repository, an agent that cannot be dispatched to, a model or effort the
catalog cannot resolve, a budget overrun. Warnings do not block — they are what the user reads before
approving. Nothing is ever rewritten to make a plan pass.

## The approval table

```bash
node "<skill-dir>/scripts/plan.mjs" show --plan plan.json
```

Show it to the user before anything runs. It gives, in order: each subtask's description, what it
owns, which agent runs it, and its estimated duration, then a cumulative total that says plainly
these run back to back.

Estimates come from the size class, recalibrated from durations this machine has actually observed
once there are enough of them, and every one reports its basis. They are ranges, never commitments —
an agent run is not predictable to the minute, and a plan implying otherwise is worse than one that
says "45–90 min, from 11 observed medium codex runs". Observations live beside the catalog in
`${XDG_CACHE_HOME:-~/.cache}/delegate/timings.json` and hold durations only.

A subtask the user wants merged, split, reordered, or dropped is changed in the plan and re-validated.
Nothing about the sequence is renegotiated once it is running.

## Running it

```bash
node "<skill-dir>/scripts/batch.mjs" run --plan plan.json --cd /path/to/repo --yes
```

`--yes` is the user's approval, not a formality: without it the table is printed and nothing is
dispatched. Back the command with whatever your host offers for long work — on Claude Code,
`run_in_background: true`. A batch is finished when `batch.json` carries a terminal status.

What happens per subtask, in order: record the tree state, compose the brief, dispatch, wait for the
process to exit and write its result, attribute the changes, record the actual duration, move on.

- **One agent at a time.** Subtask *n+1* is not launched until *n* has exited.
- **In the user's own tree.** No worktrees, no branches, no patches, no integration step.
- **No checks, no review, no decisions in between.**
- A failed subtask marks its declared dependents `skipped` and lets independent ones continue.
  `--stop-on-failure` halts everything else as `not-started` instead.
- Cancelling terminates the running agent, keeps every completed subtask's work and artifacts, and
  marks the rest `not-started`.

There is no retry, no permission widening, and no substituted agent — the same refusals a single run
already makes, now in more places.

## Why the review waits

Running the project's suite after subtask 2 of 6 tests a half-built tree: the call site exists, the
function it calls does not, and the failure says nothing about whether subtask 2 did its job.

Two things follow, and both are load-bearing:

- **Check commands belong to the batch, not the subtask.** A subtask brief tells the agent to verify
  its own slice; the project's real suite runs once, at the end, from the plan's `checks`. A
  mid-batch failure an agent reports is advisory, not a verdict.
- **A wrong subtask 2 is not discovered until subtask 6 has also run and been paid for.** The
  mitigation is the plan, not the schedule: acceptance criteria sharp enough that the end-of-batch
  review can attribute a failure to one subtask instead of to the batch.

## The recap

```bash
node "<skill-dir>/scripts/recap.mjs" --batch <out-dir>/batch.json
```

It reviews every subtask against the batch ledger, its acceptance criteria, and its owned paths; runs
the plan's checks once over the finished tree; and reports the seams. Then tell the user, in order:

- per subtask: what it was asked to do, which agent did it, what it **reported**, what was
  **checked**, which files it changed, and estimated versus actual time;
- what the whole-tree checks said — the number no half-built subtask could report;
- the cross-subtask findings: a path two subtasks both changed, a subtask that failed, one that never
  ran, an estimate the batch blew past;
- what was **not** done, with the id that blocked it;
- what the user must now decide.

Two things the recap does not do, on purpose. It does not judge whether the pieces fit — duplication
between subtasks, an interface one defined and another ignored, a gap neither covered — that is
yours, and the shared-path finding is where to start looking. And it does not act: the edits are in
the working tree, uncommitted, and committing, reverting, or asking for another pass are all the
user's calls.

## The batch ledger, and why it exists

`review.mjs` on its own flags "changes on paths that were already dirty before the run". In a
sequence that fires on every subtask after the first and means nothing — the predecessors' edits
*are* the pre-existing changes.

So the batch records the tree before it starts and around each subtask. Paths the user had dirty
before any of it stay attributed to the user; everything after is attributed to whichever subtask was
running when it appeared. That is also what makes ownership checkable, and what lets the recap say a
subtask changed a file its predecessor created rather than reporting nothing at all.
