# Selection flow

Three questions, always in this order: **agent → model → effort**. The order is not stylistic. The
agent decides which models exist; the agent and model together decide which effort levels exist.
Asking about a model first means offering identifiers that may not apply to whatever agent is chosen
afterwards.

The user answers all three. The only thing you propose is the effort default.

---

## Before you ask: is there anything to ask about?

```bash
node "<skill-dir>/scripts/select.mjs" agents --format text --include-unavailable
```

If no agent is dispatchable, say so plainly and stop. The output names each unavailable agent and
why — not installed, or installed but discovery-only. Do not offer to install anything.

## Question 1 — which agent?

Offer only agents that are installed **and** dispatchable. An agent whose authentication is confirmed
failed still appears, marked, because the fix is a login the user can do; an agent whose
authentication is merely *unknown* also appears, marked, because unknown is not failure.

With a native question tool, use the JSON form and build one option per agent, with the version and
any auth marker as the description. Without one, print the text form verbatim and take a number.

## Question 2 — which model?

```bash
node "<skill-dir>/scripts/select.mjs" models --agent <key> --format text
```

The `source` field says how much the list is worth, and it should reach the user:

| source | means | how to present it |
| --- | --- | --- |
| `live` | the CLI listed these just now | trustworthy and current |
| `cached-catalog` | read from the CLI's own local cache | current as of that CLI's last sync |
| `aliases` | curated names from the CLI's help, not a listing | may lag the provider's real catalog |
| `unsupported` | no credential-free listing exists | availability unknown; do not guess ids |

Two escape hatches appear when the agent supports them:

- **CLI default** — dispatch with no model and let the CLI use its configured one. Offer this only
  when `cliDefault` is true. OpenCode has no usable default, so a model is mandatory there.
- **Manual id** — the user types an id the listing does not contain. It is accepted where the agent
  allows it, and the run result records it as `manual` plus a warning, so a typo surfaces in the
  review rather than only in the CLI's error.

Hidden models never appear. Long listings are capped for prompting; pass `--all` if the user asks to
see everything.

## Question 3 — how much effort?

```bash
node "<skill-dir>/scripts/select.mjs" efforts --agent <key> --model <id> --format text
```

Effort reaches each CLI differently, and the mechanism is in the output:

| agent | mechanism | how it is sent |
| --- | --- | --- |
| Claude Code | `flag` | `--effort <level>` |
| Codex | `codex-config` | `-c model_reasoning_effort=<level>` |
| OpenCode | `variant` | `--variant <name>` (provider-specific) |
| Cursor Agent | `model-parameter` | appended to the id as `model[effort=<level>]` |

**Default to `high`** when `recommended` comes back as `high` — that is the tool telling you high is
verified for this exact agent and model. When it comes back `null`, do not reach for high anyway.
Offer what `values` contains, or the CLI default, and say why the list is what it is.

Four shapes come out of this call:

- **verified levels** — offer them, with `high` marked when present.
- **fixed by the model** — some Cursor ids already spell their level (`…-high`, `…-xhigh`). There is
  nothing to choose; say which level the id implies and move on.
- **needs a model first** — Codex levels are per model, so with no model chosen there is nothing to
  verify. Either go back and pick a model, or accept that an effort passed here is unverified.
- **unsupported** — the agent has no verified effort mechanism. Do not invent one.

## Asking without a native question tool

Every `--format text` render is a self-contained numbered prompt ending in "Reply with a number."
Print it, wait, and map the reply back to the entry at that index. Letters are used for the escape
hatches: `d` for the CLI default, `m` for a manual id.

Do not renumber, reorder, or trim the list you were given — the index the user replies with has to
mean the same entry you displayed.

## Validate before dispatching

```bash
node "<skill-dir>/scripts/select.mjs" resolve --agent codex --model gpt-5.5 --effort high
```

Exit 0 prints the resolved selection; exit 2 prints the reason and a hint. `dispatch.mjs` runs the
same check itself, so this step is for confirming a choice with the user before committing to it.

When it refuses, relay the reason and ask again. Do not repair a rejected selection by substituting
something that works — the user picked what they picked for a reason, and a silent swap turns their
choice into a suggestion.
