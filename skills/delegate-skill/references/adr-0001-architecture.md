# ADR 0001 — delegate-skill architecture

**Status:** accepted · **Date:** 2026-09-10 · **Applies to:** delegate-skill 1.0.0

## Context

A user with several agent CLIs installed wants to hand one bounded task to one of them, chosen at the
moment of use rather than fixed in advance. Existing delegation skills each target a single CLI and
assume the choice is already made. Nothing answers "which of these can I actually use right now, with
which model, at what reasoning effort?"

The constraints that shaped everything below: no dependencies beyond Node built-ins, no network calls
of our own, no credentials in any file we write, macOS and Linux, and an orchestrator that may or may
not have a native question tool.

## Decisions

### 1. Registry, catalog, adapter, dispatcher are four separate things

- **registry.mjs** — static facts about each CLI: binary name, safe probes, effort mechanism.
- **catalog.mjs** — the *observed* state of this machine, cached.
- **adapters.mjs** — how to talk to one CLI: profiles, argv, event normalization.
- **dispatch.mjs** — process lifecycle, artifacts, git. Knows no CLI-specific detail.

Adding an agent touches the registry and adds one adapter. Nothing else changes.

**Consequence:** four files instead of one, and a small amount of indirection when tracing a flag from
the command line to the spawned process.

### 2. Ten of the fourteen agents are discovery-only

All fourteen registry entries are discovered, versioned, and authentication-probed. Only Claude Code,
Codex, OpenCode, and Cursor Agent can receive a task, because those are the four that were installed
and could be exercised while the adapters were written.

The alternative was writing adapters for the other ten from documentation alone. Rejected: a wrong
flag in an unverified adapter is not a cosmetic bug. It silently changes the permission profile a run
executes under, and the user finds out from the diff. Every dispatchable adapter here was checked
against the CLI's own `--help` output and exercised against a real process.

**Consequence:** ten agents show up in the catalog and cannot be dispatched to, each with its reason.
The registry entry is the honest half of the work; the adapter is the half that requires the CLI in
hand.

**Adding an agent:** install the CLI, read its help, add a `dispatch` block to its registry entry, add
an adapter with the four methods, add a fake-agent stream and argv assertions in the tests, and
verify a real run.

### 3. Selection is agent → model → effort, one way

Each answer constrains the next. Codex reasoning levels are per model; Cursor carries effort on the
model id. A flat "pick a model" question would offer identifiers that may not apply to the agent
chosen afterwards.

**Consequence:** three round trips with the user rather than one. Worth it: the alternative is
offering choices that turn out not to exist.

### 4. Provenance travels with every identifier

A model list is tagged `live`, `cached-catalog`, `aliases`, or `unsupported`, and the tag reaches the
user. An id typed by hand is recorded as `manual` with a warning. An effort that could not be checked
against a listing is recorded as unverified and shows up again in the review.

The rule underneath: **never invent an identifier**. Where no listing exists, availability is reported
as unknown rather than filled in with something plausible.

**Consequence:** more fields in the catalog, and prompts that sometimes have to say "this list may be
out of date" instead of presenting a clean menu.

### 5. The catalog is cached for 24 hours, and validated without spawning

Probing four CLIs costs several process launches. The cache is invalidated by TTL, by a schema or
registry change, or by an executable's path or on-disk fingerprint moving — all of which are answered
with filesystem calls only, so validation is cheap enough to run on every task.

The known gap: a launcher shim whose own bytes do not change when its package is upgraded will not
move the fingerprint. That case is caught at TTL expiry, by `--refresh`, or after the fact by the
agent version recorded in the run result.

**Consequence:** a freshly upgraded CLI can be reported with yesterday's version for up to a day.
`--refresh` is one flag, and the run result always carries the version actually launched.

### 6. A failed refresh returns the previous catalog, labelled

Stale data plus a label beats no data. The labelled copy is never written back over the cache, and the
label rides through selection as a warning.

**Consequence:** a caller who ignores `stale` gets old answers. Every path that surfaces a catalog
surfaces the flag with it.

### 7. Authentication is three-valued

`authenticated`, `unauthenticated`, `unknown`. Several CLIs expose no status command at all, and
treating "no probe" as "not logged in" would block runs that would have worked. A confirmed failure
refuses the dispatch; unknown proceeds with a warning.

Only the boolean is read. `claude auth status` also returns the account email and organization ids;
none of it enters the catalog.

### 8. Two permission profiles per adapter, explicit, no escalation

Each adapter defines exactly a write profile and a read-only profile, states them on every
invocation including resumed turns, and records which was used. There is no bypass mode and no retry
that widens permissions after a refusal.

Read-only is enforced by each agent, not by this skill. The change report is a tripwire that makes a
violation visible; it is not a boundary.

**Consequence:** a task that genuinely needs wider permissions cannot be run through this skill. That
is the intended answer — the user runs it themselves, deliberately.

### 9. The brief goes on stdin, always

Briefs are multi-line and often XML-tagged. Argv is for enum values, pattern-checked tokens, and our
own file paths.

**Consequence:** every adapter needs a stdin-reading invocation. All four have one.

### 10. Once the brief validates, a result is always written

`result.json` is published atomically by rename on every outcome — completed, no_output, failed,
timeout, aborted, auth_failed, agent_unavailable — including when the dispatcher itself is killed.
Usage errors and rejected selections happen before any artifact exists and write nothing.

**Consequence:** a poller must also check the exit code: non-zero with no file is a usage error.

### 11. The skill reports; it does not act

No commit, no push, no revert, no automatic rework. `review.mjs` writes findings and a verdict of
`findings-reported` or `no-findings` — deliberately never `approved`.

Delegation is something the user opted into for one task. Acting on the outcome is a separate
decision, and taking it automatically would quietly convert "run this" into "run this and land it".

**Consequence:** more round trips on a queue of tasks. The user stays in the loop where the loop
matters.

## Alternatives considered

- **Depend on the installed single-CLI delegation skills.** Rejected: the plan requires a
  self-contained package, and reaching into another skill's files couples releases together.
- **One relay per agent, as those skills do.** Rejected: four near-identical process lifecycles is
  where they drift. One dispatcher plus small adapters keeps the lifecycle in one place.
- **Ask all three questions at once.** Rejected: the answers are dependent.
- **Default to a "best" agent.** Rejected: the whole point is that the user chooses.
- **Retry with wider permissions on a permission failure.** Rejected outright. A permission refusal
  is information, and escalating past it is exactly what a delegating user did not agree to.
