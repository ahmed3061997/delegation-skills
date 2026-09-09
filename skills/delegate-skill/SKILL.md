---
name: delegate-skill
description: >-
  Delegate a bounded task to an installed agent CLI of the user's choosing — Claude Code, Codex,
  OpenCode, or Cursor Agent — after asking which agent, then which model, then how much reasoning
  effort. Use when the user wants to hand implementation work to another agent but has not named
  one, or asks which agents are available, or says things like "delegate this", "have another agent
  do X", "run this through an agent", or "pick an agent for this". Discovers what is installed,
  offers only real choices, dispatches with an explicit permission profile, and reports what came
  back. DO NOT USE when the user names a specific agent that has its own dedicated delegation skill,
  when the task is small enough to do inline, or when they want the code written directly.
license: MIT
compatibility: >-
  macOS and Linux. Requires Node.js 18 or newer, and git for change attribution. At least one
  supported agent CLI must be installed and authenticated. The orchestrating agent needs to run
  shell commands and read files; nothing here is specific to one host.
metadata:
  version: 1.0.0
---

# Delegate Skill

You are the **orchestrator**. This skill hands a bounded task to a separate **agent** — a coding CLI
installed on this machine — and gives you back a structured record of what it did. You write the
brief and own the judgment. The agent does the typing. You review, and you decide what happens next.

Everything the skill needs is bundled: the agent registry, the discovery cache, the dispatch
adapters, and the tests. It reads no other skill's files and changes none.

## What this skill will not do

It does not commit, push, revert, or re-dispatch. It does not retry with a wider permission profile
after a refusal, and it does not quietly substitute a different agent, model, or effort for one that
was rejected. Every one of those is reported to you, and the decision stays yours.

## The loop

### 1. See what is actually available

```bash
node "<skill-dir>/scripts/catalog.mjs" --summary
```

`<skill-dir>` is the directory holding this `SKILL.md`. Claude Code prints it as "Base directory for
this skill"; on other hosts, use the directory you loaded the skill from.

Fourteen agent CLIs are in the registry. All fourteen are discovered; four have dispatch adapters
that were exercised against a real, locally installed CLI — Claude Code, Codex, OpenCode, and Cursor
Agent — and only those can receive a task. The rest are reported as installed-but-not-dispatchable,
with the reason. That is a deliberate limit, not an oversight: see
[references/adr-0001-architecture.md](references/adr-0001-architecture.md).

Results are cached for 24 hours under `${XDG_CACHE_HOME:-~/.cache}/delegate-skill/catalog.json` and
rebuilt automatically when an agent's executable moves or changes. Add `--refresh` to force it.

### 2. Ask three questions, in order

Agent first, then model, then effort — each one narrows the next, so the order cannot be shuffled.
Full guidance, including how to phrase each question with a native question tool or as a numbered
text prompt: [references/selection-flow.md](references/selection-flow.md).

```bash
node "<skill-dir>/scripts/select.mjs" agents  --format text
node "<skill-dir>/scripts/select.mjs" models  --agent codex --format text
node "<skill-dir>/scripts/select.mjs" efforts --agent codex --model gpt-5.6-sol --format text
```

Drop `--format text` for JSON if you are building the choices into a native question tool.

Ask the user; do not choose for them. The one thing you may propose is the effort default: **high**,
when high is verified for that agent and model. If it is not, offer the verified levels or the CLI's
own default instead — never a level you cannot show came from the CLI.

### 3. Write the brief

If the user did not say what the task is, ask before going further — there is nothing to brief
without it. A working directory is optional and defaults to the current one.

The agent sees **only** the text you send: no repo memory, no chat history, no shared context.
Everything the task needs goes in — the goal, the current state, what to change, what to leave alone,
the project's **actual** check commands (discover them from the repo, do not assume), and a report
contract. Tell it not to commit. One task per brief.
Template and guidance: [references/writing-the-brief.md](references/writing-the-brief.md).

### 4. Dispatch

```bash
node "<skill-dir>/scripts/dispatch.mjs" \
  --agent codex --model gpt-5.6-sol --effort high \
  --brief brief.txt --cd /path/to/repo --timeout 2h
```

The dispatcher blocks until the agent exits, then writes `result.json`. Back it with whatever your
host offers: on Claude Code, run the Bash call with `run_in_background: true` and you are notified on
completion. A run is finished when the process has exited and `result.json` has a `status` — not when
a progress line says so.

Add `--read-only` for review or diagnosis with no edits. Flags, statuses, and the full result shape:
[references/dispatch-and-results.md](references/dispatch-and-results.md).

### 5. Review — do not trust the self-report

The agent's own summary is a claim, not evidence.

```bash
node "<skill-dir>/scripts/review.mjs" --result <out-dir>/result.json \
  --check "npm test" --check "npm run lint"
```

That re-runs the project's real checks and records the mechanical findings — failed checks, a
read-only run that wrote anyway, a model the agent swapped, changes on paths that were already dirty
before the run. The judgment is still yours: does the diff match the brief, is anything out of scope,
is the report true? Checklist: [references/review-and-report.md](references/review-and-report.md).

### 6. Report and stop

Tell the user what the agent did, what the checks said, and what you found. Leave the edits in place.
Committing, reverting, and asking for another pass are all the user's calls — this skill deliberately
makes none of them for you.

## Continuing a run

`result.json` carries a `sessionId`. To send a follow-up, dispatch again with `--session <id>` and a
**delta** brief describing only what should change. `--resume-last` exists as a fallback, but "last"
is global to that CLI, not per repository, so prefer the id.

## Tests

```bash
node "<skill-dir>/tests/run-tests.mjs"
```

No dependencies and no network. Dispatch is exercised end to end against fake agent binaries on a
throwaway PATH — real processes, real stdin, real signals, real exit codes, no paid runs.

## References

- [references/selection-flow.md](references/selection-flow.md) — the three questions, what each
  answer means, and how to ask them on a host with or without a native question tool.
- [references/writing-the-brief.md](references/writing-the-brief.md) — structure, the report
  contract, and embedding the project's real check commands.
- [references/dispatch-and-results.md](references/dispatch-and-results.md) — dispatcher flags, the
  `delegate-skill.run.v1` contract, statuses, exit codes, and recovery.
- [references/review-and-report.md](references/review-and-report.md) — the review checklist and where
  the skill's authority stops.
- [references/adr-0001-architecture.md](references/adr-0001-architecture.md) — the architecture and
  the decisions behind it, including why ten agents are discovery-only.
- [references/glossary.md](references/glossary.md) — agent, adapter, model, effort, catalog, brief,
  run, review.
