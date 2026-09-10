#!/usr/bin/env node
/**
 * delegate · select.mjs
 *
 * Turn the catalog into the three choices a dispatch needs — agent, then model,
 * then effort — and validate a chosen combination.
 *
 * The order is deliberate and one-way: the agent decides which models exist,
 * and the agent and model together decide which effort levels exist. Asking for
 * a model before an agent would mean offering identifiers that may not apply.
 *
 * Usage (also importable as a library):
 *   node select.mjs agents  [--format json|text] [--include-unavailable]
 *   node select.mjs models  --agent <key> [--format json|text] [--limit <n>|--all]
 *   node select.mjs efforts --agent <key> [--model <id>] [--format json|text]
 *   node select.mjs resolve --agent <key> [--model <id>] [--effort <level>]
 *   node select.mjs --help
 *
 * `resolve` is the gate dispatch.mjs uses. It exits 0 with the resolved
 * selection on stdout, or 2 with a reason on stderr. It never substitutes a
 * different agent, model, or effort for a rejected one: an unavailable choice is
 * reported, not quietly swapped.
 *
 * Exit codes: 0 success · 2 usage error or rejected selection.
 */

import { fileURLToPath } from "node:url";

import { AGENTS, EFFORT_TOKEN, findAgent, modelPattern } from "./registry.mjs";
import { loadCatalog } from "./catalog.mjs";

/** How many models a text prompt lists before suggesting `--all`. */
export const DEFAULT_MODEL_PROMPT_LIMIT = 12;

/** Cursor encodes effort in some model ids; those models cannot take an override. */
const CURSOR_EFFORT_SUFFIX = /-(low|high|xhigh)(-fast)?$/;

/** Human wording for where a set of model identifiers came from. */
export const MODEL_SOURCE_LABEL = Object.freeze({
  live: "listed live by the CLI",
  "cached-catalog": "from the CLI's local model cache",
  aliases: "curated aliases from the CLI's help (not a live listing)",
  unsupported: "no listing available — availability unknown",
  manual: "entered by hand, not present in any listing",
  "cli-default": "the CLI's own configured default",
});

export function agentEntry(catalog, key) {
  return catalog.agents.find((agent) => agent.key === key) ?? null;
}

/** Installed, dispatch-capable agents, in registry order. */
export function dispatchableAgents(catalog) {
  return catalog.agents.filter((agent) => agent.installed && agent.dispatch.available);
}

/**
 * Every agent, annotated with why it can or cannot be dispatched to.
 * Used for the "nothing is available" message, which has to explain itself.
 */
export function allAgentChoices(catalog) {
  return catalog.agents.map((agent) => ({
    key: agent.key,
    label: agent.label,
    binary: agent.binary,
    installed: agent.installed,
    version: agent.executable?.version ?? null,
    auth: agent.auth.state,
    dispatchable: agent.dispatch.available,
    reason: agent.dispatch.reason,
    modelSource: agent.models.source,
    effortMechanism: agent.effort.mechanism,
  }));
}

/** The model choices to offer for `key`, default first, plus the escape hatches. */
export function modelChoices(catalog, key, { limit = null } = {}) {
  const entry = agentEntry(catalog, key);
  if (!entry) return null;
  const ordered = [...entry.models.entries].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const shown = limit === null ? ordered : ordered.slice(0, limit);
  return {
    agent: key,
    source: entry.models.source,
    sourceLabel: MODEL_SOURCE_LABEL[entry.models.source] ?? entry.models.source,
    note: entry.models.note ?? null,
    entries: shown,
    total: ordered.length,
    truncatedByListing: entry.models.truncated,
    truncatedForPrompt: shown.length < ordered.length,
    allowsManualId: entry.models.allowsManualId,
    cliDefault: entry.models.cliDefault,
    cliDefaultNote: entry.models.cliDefaultNote,
    // A model is mandatory when the CLI has no default we can rely on.
    required: !entry.models.cliDefault,
  };
}

/** The base id of a model, with any Cursor bracket parameters removed. */
function baseModelId(model) {
  const bracket = model.indexOf("[");
  return bracket === -1 ? model : model.slice(0, bracket);
}

function findModelEntry(entry, model) {
  const base = baseModelId(model);
  return entry.models.entries.find((candidate) => candidate.id === base) ?? null;
}

/**
 * The effort choices that actually apply to this agent and model.
 *
 * Four shapes come out of this:
 *   - verified per-model levels (Codex, from its model cache)
 *   - verified agent-wide levels (Claude's --effort, OpenCode's --variant)
 *   - fixed by the model (Cursor ids that already encode effort)
 *   - unsupported (the agent has no verified effort mechanism)
 */
export function effortChoices(catalog, key, model = null) {
  const entry = agentEntry(catalog, key);
  if (!entry) return null;
  const registry = findAgent(key);
  const effort = entry.effort;
  const base = {
    agent: key,
    model,
    mechanism: effort.mechanism,
    source: effort.source,
    note: effort.note ?? null,
    values: [],
    recommended: null,
    cliDefault: null,
    fixedByModel: false,
  };

  if (effort.mechanism === "unverified") {
    return { ...base, unsupportedReason: "no verified effort mechanism for this CLI" };
  }

  if (key === "cursor" && model && CURSOR_EFFORT_SUFFIX.test(baseModelId(model))) {
    // The chosen id spells its own reasoning level; a bracket override on top
    // would be a second, conflicting statement of the same thing.
    return {
      ...base,
      fixedByModel: true,
      values: [],
      cliDefault: `the level encoded in "${baseModelId(model)}"`,
      unsupportedReason: "this Cursor model id already fixes its reasoning level",
    };
  }

  if (effort.perModel) {
    const modelEntry = model ? findModelEntry(entry, model) : null;
    if (!modelEntry || !modelEntry.efforts) {
      return {
        ...base,
        values: [],
        cliDefault: registry?.models.cliDefaultNote ?? null,
        unverified: true,
        unsupportedReason: model
          ? `no verified reasoning levels for "${model}" in the CLI's model cache`
          : "select a model first — Codex reasoning levels are per model",
      };
    }
    return {
      ...base,
      values: [...modelEntry.efforts],
      recommended: modelEntry.efforts.includes("high") ? "high" : null,
      cliDefault: modelEntry.defaultEffort ? `${modelEntry.defaultEffort} (this model's default)` : null,
    };
  }

  return {
    ...base,
    values: [...effort.values],
    recommended: effort.values.includes("high") ? "high" : null,
    cliDefault: registry?.key === "opencode" ? "omit --effort to use the provider default" : "omit --effort to use the CLI default",
  };
}

function reject(reason, hint = null) {
  return { ok: false, error: reason, hint };
}

/**
 * Validate an agent/model/effort triple against the catalog.
 *
 * @returns {{ok: true, selection: object} | {ok: false, error: string, hint: string|null}}
 */
export function resolveSelection(catalog, { agent: key, model = null, effort = null } = {}) {
  const registry = findAgent(key);
  if (!registry) {
    return reject(
      `unknown agent "${key}"`,
      `known agents: ${AGENTS.map((entry) => entry.key).join(", ")}`,
    );
  }
  const entry = agentEntry(catalog, key);
  if (!entry) return reject(`agent "${key}" is missing from the catalog`, "rebuild it with catalog.mjs --refresh");
  if (!entry.installed) {
    return reject(`${registry.label} is not installed`, `no "${registry.binary}" on PATH`);
  }
  if (!entry.dispatch.available) {
    return reject(`${registry.label} is discoverable but not dispatchable`, entry.dispatch.reason);
  }

  const warnings = [];
  const models = modelChoices(catalog, key);

  // ---- model ----
  let resolvedModel = null;
  if (model === null || model === "") {
    if (models.required) {
      return reject(
        `${registry.label} has no default model, so --model is required`,
        models.entries.length
          ? `choose one of: ${models.entries.slice(0, 6).map((candidate) => candidate.id).join(", ")}${models.total > 6 ? ", …" : ""}`
          : "run select.mjs models --agent " + key,
      );
    }
    resolvedModel = { value: null, source: "cli-default", label: models.cliDefaultNote };
  } else {
    if (!modelPattern(key).test(model)) {
      return reject(`model "${model}" contains characters this agent's dispatch does not accept`);
    }
    const known = findModelEntry(entry, model);
    if (known) {
      resolvedModel = { value: model, source: entry.models.source, label: known.label };
    } else if (models.allowsManualId) {
      // Accepted, but flagged: nothing here invents identifiers, and a typo
      // should surface in the run result rather than only in the CLI's error.
      warnings.push(
        `"${model}" is not in the ${MODEL_SOURCE_LABEL[entry.models.source] ?? entry.models.source} for ${registry.label}; passing it through as a manual id`,
      );
      resolvedModel = { value: model, source: "manual", label: null };
    } else {
      return reject(
        `${registry.label} has no verified listing to check "${model}" against, and does not accept manual ids here`,
        entry.models.note,
      );
    }
  }

  // ---- effort ----
  const efforts = effortChoices(catalog, key, resolvedModel.value);
  let resolvedEffort = { value: null, mechanism: efforts.mechanism, source: efforts.source, verified: false };
  if (effort !== null && effort !== "") {
    if (!EFFORT_TOKEN.test(effort)) {
      return reject(`effort "${effort}" is not a bare token`);
    }
    if (efforts.mechanism === "unverified") {
      return reject(`${registry.label} has no verified way to set effort`, efforts.unsupportedReason);
    }
    if (efforts.fixedByModel) {
      return reject(
        `the Cursor model "${resolvedModel.value}" already fixes its reasoning level`,
        "either drop --effort or pick a parameterized model id",
      );
    }
    if (efforts.mechanism === "model-parameter" && resolvedModel.value === null) {
      // The only place to put the level is on the model id, so there is nowhere
      // to put it without one. Dropping it silently would be worse.
      return reject(
        `${registry.label} carries effort on the model id, so --effort needs an explicit --model`,
        "pick a model first, or drop --effort to use the CLI default",
      );
    }
    if (efforts.values.length && !efforts.values.includes(effort)) {
      return reject(
        `effort "${effort}" is not available for this selection`,
        `verified levels: ${efforts.values.join(", ")}`,
      );
    }
    if (!efforts.values.length) {
      warnings.push(
        `effort "${effort}" could not be verified for this selection (${efforts.unsupportedReason}); it is passed through as given`,
      );
    }
    resolvedEffort = {
      value: effort,
      mechanism: efforts.mechanism,
      source: efforts.source,
      verified: efforts.values.includes(effort),
    };
  }

  if (entry.auth.state === "unknown") {
    warnings.push(`${registry.label} authentication is unknown (${entry.auth.probe ?? "no probe available"}) — a run may fail at the provider`);
  }
  if (catalog.stale) warnings.push(`catalog is stale: ${catalog.staleReason}`);

  return {
    ok: true,
    selection: {
      agent: key,
      label: registry.label,
      version: entry.executable?.version ?? null,
      authState: entry.auth.state,
      model: resolvedModel,
      effort: resolvedEffort,
      recommendedEffort: efforts.recommended,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Text rendering — for hosts with no native question tool
// ---------------------------------------------------------------------------

function renderAgents(choices, includeUnavailable) {
  const lines = ["Which agent should implement this task?", ""];
  const usable = choices.filter((choice) => choice.dispatchable);
  if (!usable.length) {
    lines.push("  (none available)");
  }
  usable.forEach((choice, index) => {
    const auth = choice.auth === "authenticated" ? "" : `  [auth: ${choice.auth}]`;
    lines.push(`  ${index + 1}. ${choice.label} — ${choice.version ?? "version unknown"}${auth}`);
  });
  if (includeUnavailable) {
    lines.push("", "Not available:");
    for (const choice of choices.filter((candidate) => !candidate.dispatchable)) {
      lines.push(`  · ${choice.label} — ${choice.reason}`);
    }
  }
  lines.push("", "Reply with a number.");
  return `${lines.join("\n")}\n`;
}

function renderModels(choices) {
  const lines = [`Which model should ${choices.agent} use?`, `(${choices.sourceLabel})`, ""];
  choices.entries.forEach((entry, index) => {
    const label = entry.label ? ` — ${entry.label}` : "";
    lines.push(`  ${index + 1}. ${entry.id}${label}${entry.isDefault ? "  [default]" : ""}`);
  });
  if (!choices.entries.length) lines.push("  (no listing available)");
  const extras = [];
  if (choices.cliDefault) extras.push(`d. Use the CLI default (${choices.cliDefaultNote})`);
  if (choices.allowsManualId) extras.push("m. Enter a model id by hand");
  if (extras.length) lines.push("", ...extras.map((extra) => `  ${extra}`));
  if (choices.truncatedForPrompt) {
    lines.push("", `Showing ${choices.entries.length} of ${choices.total}. Ask for the full list with --all.`);
  }
  if (choices.truncatedByListing) lines.push(`The CLI's own listing was truncated at ${choices.total} entries.`);
  if (choices.required) lines.push("", "This agent has no usable default, so a model must be chosen.");
  lines.push("", "Reply with a number or letter.");
  return `${lines.join("\n")}\n`;
}

function renderEfforts(choices) {
  const lines = [`How much reasoning effort should ${choices.agent} use?`];
  if (choices.note) lines.push(`(${choices.note})`);
  lines.push("");
  if (choices.fixedByModel || choices.mechanism === "unverified") {
    lines.push(`  Not selectable here: ${choices.unsupportedReason}.`);
    if (choices.cliDefault) lines.push(`  Effective level: ${choices.cliDefault}.`);
    return `${lines.join("\n")}\n`;
  }
  choices.values.forEach((value, index) => {
    const mark = value === choices.recommended ? "  [recommended]" : "";
    lines.push(`  ${index + 1}. ${value}${mark}`);
  });
  if (!choices.values.length) lines.push(`  (no verified levels: ${choices.unsupportedReason})`);
  if (choices.cliDefault) lines.push("", `  d. ${choices.cliDefault}`);
  lines.push("", "Reply with a number or letter.");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `select.mjs — offer and validate agent / model / effort choices

Usage:
  node select.mjs agents  [--format json|text] [--include-unavailable]
  node select.mjs models  --agent <key> [--format json|text] [--limit <n>] [--all]
  node select.mjs efforts --agent <key> [--model <id>] [--format json|text]
  node select.mjs resolve --agent <key> [--model <id>] [--effort <level>]

Common options:
  --refresh          Rebuild the catalog before answering.
  --format <fmt>     json (default) or text. "text" renders a numbered prompt
                     for hosts without a native question tool.

Exit 0 on success; 2 on a usage error or a rejected selection.
`;

function parseCliArgs(argv) {
  const opts = { command: argv[0] ?? null, agent: null, model: null, effort: null, format: "json", limit: DEFAULT_MODEL_PROMPT_LIMIT, all: false, refresh: false, includeUnavailable: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--agent": opts.agent = next(); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--format": opts.format = next(); break;
      case "--limit": opts.limit = Number.parseInt(next(), 10); break;
      case "--all": opts.all = true; break;
      case "--refresh": opts.refresh = true; break;
      case "--include-unavailable": opts.includeUnavailable = true; break;
      default: throw new Error(`unknown option "${arg}"`);
    }
  }
  if (!["json", "text"].includes(opts.format)) throw new Error(`--format must be json or text`);
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error("--limit must be a positive integer");
  return opts;
}

function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return argv.length ? 0 : 2;
  }
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`select.mjs: ${error.message}. Use --help.\n`);
    return 2;
  }

  const { catalog } = loadCatalog({ refresh: opts.refresh });
  const needsAgent = ["models", "efforts", "resolve"].includes(opts.command);
  if (needsAgent && !opts.agent) {
    process.stderr.write(`select.mjs: ${opts.command} requires --agent.\n`);
    return 2;
  }

  if (opts.command === "agents") {
    const choices = allAgentChoices(catalog);
    process.stdout.write(
      opts.format === "text"
        ? renderAgents(choices, opts.includeUnavailable)
        : `${JSON.stringify({ schema: "delegate.agent-choices.v1", stale: catalog.stale, staleReason: catalog.staleReason, agents: choices }, null, 2)}\n`,
    );
    return 0;
  }

  if (opts.command === "models") {
    const choices = modelChoices(catalog, opts.agent, { limit: opts.all ? null : opts.limit });
    if (!choices) {
      process.stderr.write(`select.mjs: unknown agent "${opts.agent}".\n`);
      return 2;
    }
    process.stdout.write(
      opts.format === "text"
        ? renderModels(choices)
        : `${JSON.stringify({ schema: "delegate.model-choices.v1", ...choices }, null, 2)}\n`,
    );
    return 0;
  }

  if (opts.command === "efforts") {
    const choices = effortChoices(catalog, opts.agent, opts.model);
    if (!choices) {
      process.stderr.write(`select.mjs: unknown agent "${opts.agent}".\n`);
      return 2;
    }
    process.stdout.write(
      opts.format === "text"
        ? renderEfforts(choices)
        : `${JSON.stringify({ schema: "delegate.effort-choices.v1", ...choices }, null, 2)}\n`,
    );
    return 0;
  }

  if (opts.command === "resolve") {
    const outcome = resolveSelection(catalog, { agent: opts.agent, model: opts.model, effort: opts.effort });
    if (!outcome.ok) {
      process.stderr.write(`select.mjs: ${outcome.error}${outcome.hint ? `\n  ${outcome.hint}` : ""}\n`);
      return 2;
    }
    process.stdout.write(
      `${JSON.stringify({ schema: "delegate.selection.v1", ...outcome.selection }, null, 2)}\n`,
    );
    return 0;
  }

  process.stderr.write(`select.mjs: unknown command "${opts.command}". Use --help.\n`);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
