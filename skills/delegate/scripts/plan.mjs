#!/usr/bin/env node
/**
 * delegate · plan.mjs
 *
 * Validate a batch plan, size its subtasks, estimate what it will cost, and
 * render the table the user approves before anything is dispatched.
 *
 * A batch plan is an ordered list of subtasks, each one responsibility bounded
 * by a seam that already exists in the codebase. This file is the mechanical
 * half of that: it checks the shape, the order, the ownership, and the
 * selections, and it warns when a subtask looks like it is carrying more than
 * one responsibility. Which seams to cut along is judgment, and stays with the
 * orchestrator — see references/large-tasks.md.
 *
 * Usage:
 *   node plan.mjs template [--out <file>]
 *   node plan.mjs validate --plan <file> [--json] [--no-catalog] [--refresh-catalog]
 *   node plan.mjs show     --plan <file> [--json] [--no-catalog]
 *
 * Options:
 *   --plan <file>       the plan to read (delegate.plan.v1 JSON).
 *   --json              machine-readable output instead of the text table.
 *   --no-catalog        skip agent/model/effort resolution against the catalog.
 *                       Shape and ordering are still checked.
 *   --refresh-catalog   rebuild the agent catalog before resolving.
 *   --out <file>        where `template` writes its starter plan.
 *   -h, --help
 *
 * Exit codes: 0 valid (warnings are still printed) · 1 invalid · 2 usage error.
 *
 * It plans and reports. It dispatches nothing, writes nothing outside --out,
 * and never edits the plan to make it pass.
 */

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findAgent } from "./registry.mjs";
import { loadCatalog } from "./catalog.mjs";
import { resolveSelection } from "./select.mjs";
import { readJsonOrNull } from "./lib/atomic.mjs";
import { parseDuration } from "./lib/duration.mjs";
import { isOwned } from "./lib/ownership.mjs";
import {
  SIZE_CLASSES,
  estimateFor,
  formatRange,
  loadTimings,
  totalEstimate,
} from "./timings.mjs";

export const PLAN_SCHEMA = "delegate.plan.v1";

/** More than this many serial subtasks is a day of wall clock; say so. */
export const DEFAULT_MAX_SUBTASKS = 12;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Owning more than this many top-level areas is a sign of two responsibilities. */
const MAX_TOP_LEVEL_AREAS = 2;
const MAX_CRITERIA_BEFORE_WARNING = 5;

function problem(id, kind, detail) {
  return { id, kind, detail };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value) {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

function topLevelArea(path) {
  const [first] = String(path).split("/").filter(Boolean);
  return first ?? ".";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOwnedPaths(subtask, errors, warnings) {
  const owned = subtask.ownedPaths;
  if (!Array.isArray(owned) || !stringList(owned)) {
    errors.push(problem(subtask.id, "owned-paths", "ownedPaths must be an array of repository-relative paths"));
    return;
  }
  if (!owned.length && !subtask.readOnly) {
    errors.push(problem(subtask.id, "owned-paths", "a write subtask must declare at least one owned path"));
  }
  for (const path of owned) {
    if (path.startsWith("/") || path.startsWith("~")) {
      errors.push(problem(subtask.id, "owned-paths", `owned path "${path}" must be repository-relative`));
    }
    if (path.split("/").includes("..")) {
      errors.push(problem(subtask.id, "owned-paths", `owned path "${path}" escapes the repository`));
    }
    if (path === "." || path === "./" || path === "*" || path === "**") {
      warnings.push(
        problem(subtask.id, "broad-ownership", `owns the whole tree via "${path}" — ownership that wide reports nothing`),
      );
    }
  }
  const areas = new Set(owned.map(topLevelArea));
  if (areas.size > MAX_TOP_LEVEL_AREAS) {
    warnings.push(
      problem(
        subtask.id,
        "spans-areas",
        `owned paths span ${areas.size} top-level areas (${[...areas].join(", ")}); that usually means more than one responsibility`,
      ),
    );
  }
}

function validateSizing(subtask, previous, warnings) {
  const goal = String(subtask.goal ?? "");
  if (/\band\b/i.test(goal) || goal.includes(";")) {
    warnings.push(
      problem(subtask.id, "multi-responsibility", `the goal reads as more than one thing ("${goal.trim().slice(0, 80)}") — consider splitting`),
    );
  }
  const owned = Array.isArray(subtask.ownedPaths) ? subtask.ownedPaths : [];
  const criteria = Array.isArray(subtask.acceptanceCriteria) ? subtask.acceptanceCriteria : [];
  if (subtask.sizeClass === "small" && owned.length > 4) {
    warnings.push(problem(subtask.id, "size-mismatch", `declared small but owns ${owned.length} paths`));
  }
  if (subtask.sizeClass === "large" && owned.length <= 1 && criteria.length <= 1) {
    warnings.push(problem(subtask.id, "size-mismatch", "declared large but owns one path with one criterion"));
  }
  if (criteria.length > MAX_CRITERIA_BEFORE_WARNING) {
    warnings.push(
      problem(subtask.id, "multi-responsibility", `${criteria.length} acceptance criteria; check they are all about the same thing`),
    );
  }
  // A subtask that owns nothing its predecessor does not already own, for the
  // same responsibility, is a sliver: the split costs a brief and a run and
  // buys no separation.
  if (
    previous &&
    owned.length &&
    isNonEmptyString(subtask.responsibility) &&
    isNonEmptyString(previous.responsibility) &&
    subtask.responsibility.trim().toLowerCase() === previous.responsibility.trim().toLowerCase() &&
    owned.every((path) => isOwned(path, previous.ownedPaths ?? []))
  ) {
    warnings.push(
      problem(subtask.id, "too-small", `same responsibility and no new ownership beyond "${previous.id}" — fold it in`),
    );
  }
}

/**
 * One subtask: shape, ownership, sizing, dependencies, and selection.
 *
 * `seen` carries the ids validated so far, which is how a dependency on a
 * subtask that has not run yet is caught — and, since execution is serial and
 * in array order, how a cycle is caught with it.
 */
function validateSubtask({ subtask, index, subtasks, seen, catalog }, errors, warnings) {
  const id = isNonEmptyString(subtask?.id) ? subtask.id : `#${index + 1}`;
  if (!subtask || typeof subtask !== "object") {
    errors.push(problem(id, "shape", "subtask must be an object"));
    return;
  }
  if (!isNonEmptyString(subtask.id) || !ID_PATTERN.test(subtask.id)) {
    errors.push(problem(id, "id", "id must be lowercase letters, digits, and dashes"));
  } else if (seen.has(subtask.id)) {
    errors.push(problem(id, "id", `duplicate id (also at position ${seen.get(subtask.id) + 1})`));
  } else {
    seen.set(subtask.id, index);
  }

  for (const field of ["title", "description", "responsibility", "goal"]) {
    if (!isNonEmptyString(subtask[field])) {
      errors.push(problem(id, "shape", `${field} is required — the user reads it before approving the batch`));
    }
  }
  if (!stringList(subtask.acceptanceCriteria) || !subtask.acceptanceCriteria.length) {
    errors.push(
      problem(id, "acceptance", "acceptanceCriteria must be a non-empty array; the end-of-batch review needs them"),
    );
  }
  if (!SIZE_CLASSES[subtask.sizeClass]) {
    errors.push(problem(id, "size", `sizeClass must be one of: ${Object.keys(SIZE_CLASSES).join(", ")}`));
  }
  if (subtask.readOnly != null && typeof subtask.readOnly !== "boolean") {
    errors.push(problem(id, "shape", "readOnly must be a boolean when present"));
  }
  validateOwnedPaths({ ...subtask, id }, errors, warnings);
  validateSizing({ ...subtask, id }, index > 0 ? subtasks[index - 1] : null, warnings);
  validateDependencies({ subtask, id, subtasks, seen }, errors);
  validateSelection({ subtask, id, catalog }, errors, warnings);
}

/** Dependencies point backwards only, which is what makes the order total. */
function validateDependencies({ subtask, id, subtasks, seen }, errors) {
  const dependsOn = subtask.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every((entry) => typeof entry === "string")) {
    errors.push(problem(id, "depends-on", "dependsOn must be an array of subtask ids"));
    return;
  }
  for (const dependency of dependsOn) {
    if (dependency === subtask.id) {
      errors.push(problem(id, "depends-on", "a subtask cannot depend on itself"));
    } else if (!subtasks.some((candidate) => candidate?.id === dependency)) {
      errors.push(problem(id, "depends-on", `depends on unknown subtask "${dependency}"`));
    } else if (!seen.has(dependency)) {
      // Execution is serial and in array order, so a dependency that has not run
      // yet cannot be satisfied. This also makes cycles impossible.
      errors.push(
        problem(id, "order", `depends on "${dependency}", which runs later; reorder so prerequisites come first`),
      );
    }
  }
}

/** Agent, model, and effort are resolved now, not four hours into the batch. */
function validateSelection({ subtask, id, catalog }, errors, warnings) {
  if (!isNonEmptyString(subtask.agent)) {
    errors.push(problem(id, "agent", "agent is required"));
    return;
  }
  if (!findAgent(subtask.agent)) {
    errors.push(problem(id, "agent", `unknown agent "${subtask.agent}"`));
    return;
  }
  if (!catalog) return;
  const outcome = resolveSelection(catalog, {
    agent: subtask.agent,
    model: subtask.model ?? null,
    effort: subtask.effort ?? null,
  });
  if (!outcome.ok) {
    errors.push(problem(id, "selection", `${outcome.error}${outcome.hint ? ` (${outcome.hint})` : ""}`));
    return;
  }
  for (const warning of outcome.selection.warnings) {
    warnings.push(problem(id, "selection-warning", warning));
  }
}

/**
 * Check a plan's shape, order, ownership, sizing, and selections.
 *
 * @param {object} plan
 * @param {{catalog?: object|null}} options catalog omitted means agent, model,
 *        and effort are not resolved — the rest is still checked.
 * @returns {{ok: boolean, errors: object[], warnings: object[], subtasks: object[]}}
 */
export function validatePlan(plan, { catalog = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: [problem(null, "schema", "the plan is not a JSON object")], warnings, subtasks: [] };
  }
  if (plan.schema !== PLAN_SCHEMA) {
    errors.push(problem(null, "schema", `expected schema "${PLAN_SCHEMA}", found "${plan.schema ?? "nothing"}"`));
  }
  const subtasks = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  if (!Array.isArray(plan.subtasks)) {
    errors.push(problem(null, "subtasks", "subtasks must be an ordered array"));
  } else if (subtasks.length < 2) {
    errors.push(
      problem(
        null,
        "not-a-batch",
        `a batch needs at least two subtasks (found ${subtasks.length}); one task is an ordinary dispatch`,
      ),
    );
  }

  const budget = plan.budget ?? {};
  const maxSubtasks = Number.isInteger(budget.maxSubtasks) ? budget.maxSubtasks : DEFAULT_MAX_SUBTASKS;
  if (maxSubtasks <= 0) errors.push(problem(null, "budget", "budget.maxSubtasks must be a positive integer"));
  if (subtasks.length > maxSubtasks) {
    errors.push(
      problem(null, "budget", `${subtasks.length} subtasks exceeds budget.maxSubtasks (${maxSubtasks}); they run one after another`),
    );
  }
  for (const field of ["subtaskTimeout", "totalTimeout"]) {
    if (budget[field] != null && parseDuration(String(budget[field])) === null) {
      errors.push(problem(null, "budget", `budget.${field} "${budget[field]}" is not a valid h/m/s duration`));
    }
  }
  if (plan.checks != null && !stringList(plan.checks)) {
    errors.push(problem(null, "checks", "checks must be an array of shell commands to run once, after the batch"));
  } else if (!plan.checks?.length) {
    warnings.push(
      problem(null, "checks", "no batch-level checks; the whole-tree pass is the only place the project's suite runs"),
    );
  }

  const seen = new Map();
  subtasks.forEach((subtask, index) => {
    validateSubtask({ subtask, index, subtasks, seen, catalog }, errors, warnings);
  });

  return { ok: errors.length === 0, errors, warnings, subtasks };
}

// ---------------------------------------------------------------------------
// Estimates and the approval table
// ---------------------------------------------------------------------------

/** Attach an estimate to every subtask, plus the serial total for the batch. */
export function estimatePlan(plan, store) {
  const subtasks = (plan.subtasks ?? []).map((subtask) => ({
    id: subtask.id,
    estimate: estimateFor(store, {
      agent: subtask.agent,
      model: subtask.model ?? null,
      sizeClass: SIZE_CLASSES[subtask.sizeClass] ? subtask.sizeClass : "medium",
    }),
  }));
  return { subtasks, total: totalEstimate(subtasks.map((entry) => entry.estimate)) };
}

function column(value, width) {
  const text = String(value ?? "");
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/** The table the user says yes to. Order, ownership, agent, and time. */
export function renderApproval(plan, estimates, { errors = [], warnings = [] } = {}) {
  const lines = [""];
  lines.push(`plan: ${plan.title ?? "(untitled)"}  ·  ${(plan.subtasks ?? []).length} subtasks, run one after another`);
  lines.push("");
  lines.push(`  ${column("#", 3)}${column("subtask", 34)}${column("owns", 30)}${column("agent", 20)}estimate`);
  lines.push(`  ${"-".repeat(3)}${"-".repeat(34)}${"-".repeat(30)}${"-".repeat(20)}--------`);
  (plan.subtasks ?? []).forEach((subtask, index) => {
    const estimate = estimates.subtasks.find((entry) => entry.id === subtask.id)?.estimate;
    const selection = [subtask.agent, subtask.model, subtask.effort].filter(Boolean).join(" · ");
    lines.push(
      `  ${column(index + 1, 3)}${column(subtask.title, 34)}${column((subtask.ownedPaths ?? []).join(" "), 30)}` +
        `${column(selection, 20)}${estimate ? formatRange(estimate) : "?"}`,
    );
    lines.push(`     ${subtask.description ?? ""}`);
    if (subtask.dependsOn?.length) lines.push(`     after: ${subtask.dependsOn.join(", ")}`);
    if (subtask.readOnly) lines.push("     read-only: the deliverable is the report, not a diff");
  });
  lines.push("");
  lines.push(
    `total: ${formatRange(estimates.total)} of wall clock — serial, so this is the sum, ` +
      `including ~${estimates.total.reviewAllowance} min for the end-of-batch review.`,
  );
  const bases = new Set(estimates.subtasks.map((entry) => entry.estimate.basis));
  lines.push(
    `estimates: ${[...bases].join(", ")} — ranges, not commitments. They are what previous runs suggest, not what this one promises.`,
  );
  if (plan.checks?.length) {
    lines.push("");
    lines.push("after the last subtask, once, over the whole tree:");
    for (const check of plan.checks) lines.push(`  ${check}`);
  }
  if (warnings.length) {
    lines.push("");
    lines.push("warnings (the plan is runnable; read these first):");
    for (const warning of warnings) lines.push(`  (${warning.id ?? "plan"}) ${warning.kind}: ${warning.detail}`);
  }
  if (errors.length) {
    lines.push("");
    lines.push("errors (nothing can be dispatched until these are fixed):");
    for (const error of errors) lines.push(`  (${error.id ?? "plan"}) ${error.kind}: ${error.detail}`);
  }
  lines.push("");
  lines.push("Nothing is dispatched until you approve this plan. Subtasks to merge, split, reorder, or drop");
  lines.push("are changed here and re-validated — not negotiated once the batch is running.");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function templatePlan() {
  return {
    schema: PLAN_SCHEMA,
    title: "short name for the whole piece of work",
    goal: "one sentence: what is true when the whole batch is done",
    budget: { maxSubtasks: DEFAULT_MAX_SUBTASKS, subtaskTimeout: "2h", totalTimeout: null },
    stopOnFailure: false,
    checks: ["the project's real test command", "the project's real lint command"],
    subtasks: [
      {
        id: "parser",
        title: "Flag parsing for --dry-run",
        description: "Teach the CLI parser about --dry-run, defaulting to false.",
        responsibility: "cli flag parsing",
        goal: "The parser accepts --dry-run, exposing it on the parsed options object.",
        ownedPaths: ["src/cli/flags.ts", "tests/cli/flags.test.ts"],
        dependsOn: [],
        agent: "codex",
        model: null,
        effort: "high",
        readOnly: false,
        acceptanceCriteria: [
          "--dry-run parses to a boolean, default false",
          "the existing flag tests still pass and cover the new flag",
        ],
        sizeClass: "small",
        context: "optional: anything the agent needs that it cannot see from the owned paths",
      },
      {
        id: "export-command",
        title: "Honour --dry-run in export",
        description: "Print the export plan and return without writing when the flag is set.",
        responsibility: "export command behaviour",
        goal: "With --dry-run set, the export command prints its plan instead of writing files.",
        ownedPaths: ["src/commands/export.ts", "tests/commands/export.test.ts"],
        dependsOn: ["parser"],
        agent: "codex",
        model: null,
        effort: "high",
        readOnly: false,
        acceptanceCriteria: [
          "with --dry-run the writer is never called",
          "without it, behaviour is unchanged",
        ],
        sizeClass: "medium",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `plan.mjs — validate, size, and price a batch plan before it runs

Usage:
  node plan.mjs template [--out <file>]
  node plan.mjs validate --plan <file> [--json] [--no-catalog] [--refresh-catalog]
  node plan.mjs show     --plan <file> [--json] [--no-catalog]

Options:
  --plan <file>       the plan to read (${PLAN_SCHEMA} JSON)
  --json              machine-readable output instead of the text table
  --no-catalog        skip agent/model/effort resolution; shape and order are
                      still checked
  --refresh-catalog   rebuild the agent catalog before resolving
  --out <file>        where "template" writes its starter plan
  -h, --help

Subtasks are checked for one responsibility each, for ownership that does not
sprawl, and for dependencies that run before their dependents. Sizing problems
are warnings, not rewrites: the plan is yours.

Exit 0 when the plan is valid, 1 when it is not, 2 on a usage error.
`;

function fail(message) {
  process.stderr.write(`plan: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { command: null, plan: null, json: false, catalog: true, refreshCatalog: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help": process.stdout.write(HELP); process.exit(0); break;
      case "--plan": opts.plan = next(); break;
      case "--json": opts.json = true; break;
      case "--no-catalog": opts.catalog = false; break;
      case "--refresh-catalog": opts.refreshCatalog = true; break;
      case "--out": opts.out = next(); break;
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        else if (opts.command === null) opts.command = arg;
        else fail(`unexpected argument: ${arg}`);
    }
  }
  if (!opts.command) fail("a command is required: template | validate | show");
  if (!["template", "validate", "show"].includes(opts.command)) fail(`unknown command "${opts.command}"`);
  if (opts.command !== "template" && !opts.plan) fail(`${opts.command} requires --plan <file>`);
  return opts;
}

export function loadPlan(path) {
  if (!existsSync(path)) fail(`plan file not found: ${path}`);
  const plan = readJsonOrNull(path);
  if (!plan) fail(`could not parse ${path} as JSON`);
  return plan;
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.command === "template") {
    const text = `${JSON.stringify(templatePlan(), null, 2)}\n`;
    if (opts.out) {
      writeFileSync(opts.out, text, "utf8");
      process.stdout.write(`wrote ${opts.out}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  const plan = loadPlan(opts.plan);
  const catalog = opts.catalog ? loadCatalog({ refresh: opts.refreshCatalog }).catalog : null;
  const outcome = validatePlan(plan, { catalog });
  const { store } = loadTimings();
  const estimates = estimatePlan(plan, store);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "delegate.plan-review.v1",
          ok: outcome.ok,
          errors: outcome.errors,
          warnings: outcome.warnings,
          estimates,
        },
        null,
        2,
      )}\n`,
    );
    return outcome.ok ? 0 : 1;
  }

  if (opts.command === "validate") {
    const lines = [""];
    lines.push(
      outcome.ok
        ? `plan: valid · ${(plan.subtasks ?? []).length} subtasks · ${outcome.warnings.length} warning(s)`
        : `plan: invalid · ${outcome.errors.length} error(s), ${outcome.warnings.length} warning(s)`,
    );
    for (const error of outcome.errors) lines.push(`  error   (${error.id ?? "plan"}) ${error.kind}: ${error.detail}`);
    for (const warning of outcome.warnings) lines.push(`  warning (${warning.id ?? "plan"}) ${warning.kind}: ${warning.detail}`);
    if (outcome.ok) lines.push(`  estimated wall clock: ${formatRange(estimates.total)} (serial)`);
    lines.push("");
    process.stdout.write(`${lines.join("\n")}\n`);
    return outcome.ok ? 0 : 1;
  }

  process.stdout.write(renderApproval(plan, estimates, { errors: outcome.errors, warnings: outcome.warnings }));
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
