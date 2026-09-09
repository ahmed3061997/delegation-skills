# Writing the brief

The agent receives one thing: the text you send on stdin. No repository memory, no conversation
history, no shared context, no ability to ask you a follow-up question. If the brief does not say it,
the agent does not know it.

Write for a competent engineer who has never seen this codebase and cannot ask you anything.

## What every brief contains

1. **Goal** — one sentence. What is true when this is done that is not true now.
2. **Context** — where in the repository this lives, what the current behaviour is, and any decision
   that is already made so it is not relitigated.
3. **Do** — the specific changes, concretely.
4. **Do not** — the boundaries. Always include "do not commit or push"; the orchestrator owns that.
   Name anything nearby that must not be touched.
5. **Checks** — the project's **actual** commands. Find them in the repo (CLAUDE.md, AGENTS.md,
   Makefile, package.json scripts, CI config). Do not assume `npm test` exists.
6. **Report contract** — what the final message must contain, so you can review it without guessing.

One task per brief. A brief with two goals produces a diff with two half-finished changes.

## Template

```
GOAL
Add a --dry-run flag to the export command so it prints the plan without writing files.

CONTEXT
The export command lives in src/commands/export.ts and writes through src/io/writer.ts.
Flags are parsed with the project's own parser in src/cli/flags.ts — do not add a dependency.
The plan object already exists as ExportPlan; nothing new needs modelling.

DO
- Add a boolean --dry-run flag, default false.
- When set, build the ExportPlan as usual, print it, and return without calling the writer.
- Cover it in the existing test file tests/commands/export.test.ts.

DO NOT
- Do not commit or push. The orchestrator reviews and commits.
- Do not change the writer's interface or touch anything under src/io/.
- Do not reformat files you are not otherwise editing.

CHECKS (run these before reporting)
- npm run test:unit
- npm run lint

REPORT
End with:
- the files you changed and why
- the exact output of each check above
- anything you decided that the brief did not specify
- anything you could not do, and what blocked it
```

## Delimiting the parts

Long briefs read better with explicit blocks, and every supported agent handles XML-style tags well:

```
<goal>…</goal>
<context>…</context>
<constraints>…</constraints>
<checks>…</checks>
<report>…</report>
```

Use whichever is clearer for the task; be consistent within one brief.

## The report contract earns its place

Ask for the specific things you will check in step 5, because the gap between them is where a
plausible-sounding summary hides:

- **What was decided, not just what was done.** A brief never fully specifies a task. Ask for the
  judgment calls explicitly, or you will find them in the diff instead.
- **The literal check output.** "Tests pass" is a claim. Pasted output is evidence — still one you
  re-run yourself, but a fabricated paste is much easier to catch than a vague assertion.
- **What was left undone.** An agent that hits a blocker and works around it silently produces the
  most expensive kind of diff.

## Delta briefs

To continue a run, dispatch with `--session <id>` from the previous `result.json` and send **only
what changes**:

```
The flag works, but two things need fixing:
1. --dry-run should imply --verbose; right now it prints nothing at all.
2. The new test asserts on the exact string; assert on the parsed plan instead.
Same constraints as before: do not commit, do not touch src/io/.
```

Do not restate the whole original brief. The session already has it, and repeating it invites the
agent to redo work it has already done.

## Read-only briefs

With `--read-only`, the deliverable is the final message rather than a diff. Say so, and say what
shape the answer should take:

```
GOAL
Review src/auth/session.ts for race conditions around token refresh. Do not change any file.

REPORT
For each issue: the file and line, what interleaving triggers it, and the smallest fix you would
make. If you find nothing, say so and name what you checked.
```

Read-only is enforced by the agent, not by this skill. The review still compares the working tree
before and after and reports any change as a violation — a tripwire, not a boundary.
