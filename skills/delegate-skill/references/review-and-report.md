# Review and report

The run is finished. Nothing has been committed, and nothing will be by this skill. What is left is
the part a script cannot do.

## Start from the right posture

The agent's `finalMessage` is a claim. It was written by the same process that did the work, with no
independent check on it, and it is the single least reliable artifact in the run directory. Read it
for *what the agent thought it was doing* — that is genuinely useful — and verify everything else.

## The mechanical half

```bash
node "<skill-dir>/scripts/review.mjs" --result <out-dir>/result.json \
  --check "npm run test:unit" --check "npm run lint"
```

Use the project's real commands — the same ones you put in the brief. `review.mjs` runs each in the
run's working directory, records exit codes and output tails into the result under `review`, and adds
findings drawn from the run record itself:

| Finding | Means |
| --- | --- |
| `check-failed` | A project check failed or timed out. |
| `run-status` | The run did not end in `completed`. |
| `attribution` | Paths were already dirty before the run, or git could not report at all. |
| `no-changes` | A write-capable run produced no new changes. Was the task actually done? |
| `read-only-violation` | A read-only run left changes behind. |
| `model-mismatch` | The agent reported running a different model than the one selected. |
| `unverified-effort` | The effort could not be verified, so the agent may have ignored it. |
| `selection-warning` | A manual model id, unknown authentication, or a stale catalog. |

Exit 0 means every check passed and nothing was flagged. Exit 1 means there is something to read.

## The half that is yours

Read the diff against the brief and answer four questions:

1. **Did it do what was asked?** Compare `changes.created` against the "Do" section, item by item.
2. **Did it do more than was asked?** Scope creep is the most common failure and the easiest to miss,
   because the extra work usually looks reasonable in isolation.
3. **Did it do less?** An agent that hits a blocker and works around it silently is the expensive
   case. Look for the workaround, not the confession.
4. **What did it decide that the brief did not specify?** Those decisions are now in your codebase.
   Surface them to the user rather than absorbing them.

Then, depending on the change:

- Schema or migration changes: round-trip them.
- Removals: grep for dangling references to whatever was removed.
- New dependencies: check that adding one was actually in scope.
- Anything touching `alsoModified` paths: separate the agent's work from the work that was already
  there before judging either.

If you have code-review skills installed, run them on the diff now. This skill produces work; those
skills judge it.

## Where this skill's authority stops

The skill reports and stops. It does not commit, revert, or re-dispatch, and it should not offer to
do any of those as though they were the obvious next step. Those are the user's decisions, and the
delegation the user agreed to was "run this task", not "run this task and act on the outcome."

Two things you should always do rather than absorb:

- **Surface, don't smooth.** Report the agent's design decisions, its defensible-but-unasked turns,
  and the nitpicks you would otherwise fix yourself on the way past. The user is entitled to know
  what actually happened, not a tidied version.
- **Stop at scope changes.** If finishing the task properly needs going beyond the brief, say so and
  ask. Do not widen the mandate on your own — not by dispatching again, and not by finishing the job
  by hand.

## Reporting to the user

Cover, briefly:

- what the agent changed, as paths, not as prose;
- what the checks said, including which ones you ran;
- the findings from `review.mjs`, and which ones you judged to matter;
- anything the agent decided that the brief did not specify;
- what is still open, and what you would suggest — as a suggestion.

If the run failed, say what failed and what the evidence was. A failed delegation reported honestly
is a normal outcome. A failed delegation reported as a partial success is a problem you have just
handed to someone else.
