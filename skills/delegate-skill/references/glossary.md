# Glossary

Eight terms carry the whole design. They are used in exactly these senses everywhere in this skill —
in the code, the schemas, and the prompts shown to the user.

### Agent

A coding CLI installed on this machine that can be given a task: `claude`, `codex`, `opencode`,
`cursor-agent`. Fourteen are in the registry; four can currently receive a task.

An agent is *installed* (its binary is on PATH), and separately *dispatchable* (a verified adapter
exists for it). Both must be true to delegate to it. "Agent" never refers to the orchestrator running
this skill — that one is the orchestrator.

### Adapter

The code that knows how to talk to one agent: its two permission profiles, how to build its argument
array, and how to fold its event stream into a common result. One adapter per dispatchable agent, all
behind the same four-method interface, all in `scripts/adapters.mjs`.

An adapter is written against a locally installed CLI, not against documentation alone. That is what
"verified" means in `dispatch.verification`.

### Model

The identifier passed to an agent to choose which model answers — `gpt-5.6-sol`, `opus`,
`anthropic/claude-sonnet-5`. Always accompanied by its **source**, which says how much the identifier
is worth:

- `live` — the CLI listed it just now
- `cached-catalog` — read from the CLI's own local cache
- `aliases` — a curated name from the CLI's help, not a listing
- `manual` — typed by hand, present in no listing
- `cli-default` — no model passed; the CLI uses its configured one

Models marked hidden by their CLI are never offered.

### Effort

How much reasoning the model should spend. Each agent expresses it differently, and the **mechanism**
travels with the value:

- `flag` — a dedicated command-line flag (Claude Code)
- `codex-config` — a config override (Codex)
- `variant` — the CLI's own word for the same idea (OpenCode)
- `model-parameter` — a parameter on the model id (Cursor Agent)
- `unverified` — no verified mechanism exists for this agent

An effort is **verified** when it appears in a list this skill can trace to the CLI. `high` is the
default only when it is verified for that exact agent and model.

### Catalog

The observed state of this machine: which agents are installed, at what version, authenticated or
not, with which models and effort mechanisms. Schema `delegate-skill.catalog.v1`, cached at
`${XDG_CACHE_HOME:-~/.cache}/delegate-skill/catalog.json` for 24 hours.

A catalog is **stale** when a refresh failed and the previous one was returned instead. Stale
catalogs are labelled, carried into selection as a warning, and never written back to the cache.

The catalog holds no credentials. Authentication is one of three words, and nothing else from an auth
probe's output is retained.

### Brief

The complete, self-contained text sent to the agent on stdin. It is everything the agent knows: goal,
context, what to change, what to leave alone, the project's real check commands, and a report
contract. A **delta brief** is a follow-up sent with `--session`, describing only what changes.

Briefs are never placed in argv.

### Run

One dispatch of one brief to one agent, and the record it produces. Schema
`delegate-skill.run.v1`, written atomically to `result.json` on every outcome once the brief and
selection validate.

A run has a **status** (`completed`, `no_output`, `failed`, `timeout`, `aborted`, `auth_failed`,
`agent_unavailable`), a permission profile, the exact argv used, the agent's own final message, and a
change accounting that separates what the agent did from what was already in the working tree.

### Review

What happens after a run: re-running the project's checks, comparing the working tree against the
brief, and recording findings. Schema `delegate-skill.review.v1`, written into the run record's
`review` field.

A review **reports and stops**. Its verdict is `findings-reported` or `no-findings` — never
`approved`, because approving is a decision, and the decision is the user's.

---

### Also worth pinning down

**Orchestrator** — the agent running this skill. It writes the brief, asks the three questions,
dispatches, reviews, and reports. It never delegates its judgment along with the task.

**Permission profile** — the named set of flags that defines what a run may do. Two per adapter,
write and read-only, stated on every invocation and recorded in the result. There is no third.

**Dispatchable vs discoverable** — discoverable means the skill can find and describe it.
Dispatchable means the skill can safely give it work. Ten agents are the first without the second.
