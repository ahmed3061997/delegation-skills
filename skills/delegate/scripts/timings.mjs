#!/usr/bin/env node
/**
 * delegate · timings.mjs
 *
 * Duration observations, and the estimates a batch plan shows the user before
 * anything is dispatched.
 *
 * A serial batch spends real hours, so the user has to see what it will cost
 * before agreeing to it. An estimate starts as a range attached to a size class
 * and is recalibrated from what this machine has actually observed once enough
 * runs of the same shape exist. Both cases report their basis: a plan that says
 * "45-90 min, from 11 observed medium codex runs" is honest, and so is one that
 * says "from the built-in defaults" — a plan that hides which it is, is not.
 *
 * Nothing here is a commitment. An agent run is not predictable to the minute,
 * and the estimate is never presented as a deadline.
 *
 * Usage:
 *   node timings.mjs --show            print what has been observed so far
 *   node timings.mjs --path            print the observation file's location
 *   node timings.mjs --estimate --agent codex --size medium [--model <id>]
 *   node timings.mjs --forget          delete the observation file
 *   node timings.mjs --help
 *
 * Store: ${XDG_CACHE_HOME:-~/.cache}/delegate/timings.json, schema
 * delegate.timings.v1. It holds durations, agent keys, model ids, and size
 * classes — no briefs, no agent output, no credentials, nothing from the
 * repository. Bounded to the most recent samples per shape.
 *
 * Exit codes: 0 on success · 2 on a usage error.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readJsonOrNull, writeJsonAtomic } from "./lib/atomic.mjs";

export const TIMINGS_SCHEMA = "delegate.timings.v1";

/**
 * Default ranges per size class, in minutes. Deliberately wide: these are what
 * the skill says when it has no evidence, and a narrow guess presented without
 * evidence is the failure mode this whole file exists to avoid.
 */
export const SIZE_CLASSES = Object.freeze({
  small: Object.freeze({ min: 15, max: 40, blurb: "one seam, a handful of files" }),
  medium: Object.freeze({ min: 40, max: 90, blurb: "one responsibility across a module" }),
  large: Object.freeze({ min: 90, max: 150, blurb: "one responsibility, wide surface" }),
});

/** Below this many samples an observation set is noise, not a calibration. */
export const MIN_SAMPLES = 3;
/** Keep the store bounded; old runs describe an older CLI anyway. */
export const MAX_SAMPLES = 20;
/** What the end-of-batch review costs, added to a plan's total. */
export const REVIEW_ALLOWANCE_MINUTES = 10;

/** ${XDG_CACHE_HOME:-~/.cache}/delegate/timings.json */
export function timingsPath(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "delegate", "timings.json");
}

export function emptyStore() {
  return { schema: TIMINGS_SCHEMA, updatedAt: null, observations: {} };
}

function observationKey(agent, model, sizeClass) {
  return `${agent}|${model ?? "(cli-default)"}|${sizeClass}`;
}

/**
 * Load the store, falling back to an empty one for absent, unreadable, or
 * corrupt files. A broken cache must never fail a plan: the worst it can cost
 * is a less-informed estimate.
 */
export function loadTimings({ path = null, env = process.env } = {}) {
  const file = path ?? timingsPath(env);
  const parsed = readJsonOrNull(file);
  const usable = Boolean(parsed) && parsed.schema === TIMINGS_SCHEMA && Boolean(parsed.observations);
  return { store: usable ? { ...emptyStore(), ...parsed } : emptyStore(), path: file };
}

/** Record one finished run. Returns a new store; the input is not mutated. */
export function recordObservation(store, { agent, model = null, sizeClass, minutes }) {
  if (!agent || !SIZE_CLASSES[sizeClass]) return store;
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return store;
  const key = observationKey(agent, model, sizeClass);
  const previous = store.observations?.[key]?.durations ?? [];
  const durations = [...previous, Math.round(value * 100) / 100].slice(-MAX_SAMPLES);
  return {
    ...store,
    schema: TIMINGS_SCHEMA,
    updatedAt: new Date().toISOString(),
    observations: { ...(store.observations ?? {}), [key]: { durations, count: durations.length } },
  };
}

/** Persist the store. Returns an error message instead of throwing: a cache
 *  that cannot be written is not a reason to fail a batch that already ran. */
export function saveTimings(store, { path = null, env = process.env } = {}) {
  try {
    writeJsonAtomic(path ?? timingsPath(env), store);
    return null;
  } catch (error) {
    return error?.message ? String(error.message) : String(error);
  }
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function samplesFor(store, agent, model, sizeClass) {
  const exact = store.observations?.[observationKey(agent, model, sizeClass)]?.durations ?? [];
  if (exact.length >= MIN_SAMPLES) return { durations: exact, basis: "observed" };
  // Fall back to this agent's runs of the same size across models: the model
  // matters less to wall-clock than the size of the task does.
  const acrossModels = Object.entries(store.observations ?? {})
    .filter(([key]) => key.startsWith(`${agent}|`) && key.endsWith(`|${sizeClass}`))
    .flatMap(([, entry]) => entry.durations ?? []);
  if (acrossModels.length >= MIN_SAMPLES) return { durations: acrossModels, basis: "observed-agent" };
  return { durations: [], basis: "defaults" };
}

/**
 * The estimate for one subtask shape.
 *
 * @returns {{min:number,max:number,basis:string,samples:number,sizeClass:string,note:string}}
 */
export function estimateFor(store, { agent, model = null, sizeClass }) {
  const defaults = SIZE_CLASSES[sizeClass] ?? SIZE_CLASSES.medium;
  const { durations, basis } = samplesFor(store ?? emptyStore(), agent, model, sizeClass);
  if (basis === "defaults") {
    return {
      min: defaults.min,
      max: defaults.max,
      basis: "defaults",
      samples: durations.length,
      sizeClass,
      note: `built-in ${sizeClass} range (no calibration yet${durations.length ? `, only ${durations.length} sample(s)` : ""})`,
    };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const low = Math.max(1, Math.round(percentile(sorted, 0.2)));
  const high = Math.max(low + 1, Math.round(percentile(sorted, 0.8)));
  return {
    min: low,
    max: high,
    basis,
    samples: sorted.length,
    sizeClass,
    note:
      basis === "observed"
        ? `from ${sorted.length} observed ${sizeClass} ${agent} run(s) on this model`
        : `from ${sorted.length} observed ${sizeClass} ${agent} run(s) across models`,
  };
}

/** Sum estimates the way a serial batch spends them: added, never maximised. */
export function totalEstimate(estimates, { reviewAllowance = REVIEW_ALLOWANCE_MINUTES } = {}) {
  const min = estimates.reduce((sum, estimate) => sum + estimate.min, 0) + reviewAllowance;
  const max = estimates.reduce((sum, estimate) => sum + estimate.max, 0) + reviewAllowance;
  const bases = new Set(estimates.map((estimate) => estimate.basis));
  return {
    min,
    max,
    reviewAllowance,
    basis: bases.size === 1 ? [...bases][0] : "mixed",
    serial: true,
  };
}

/** "35 min" · "1h 30m" — readable at both ends of the range. */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  // A run that took forty seconds should not read as having taken no time.
  if (total === 0 && minutes > 0) return "<1 min";
  if (total < 90) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatRange({ min, max }) {
  if (min === max) return formatMinutes(min);
  // "20–40 min" reads better than "20 min–40 min"; past an hour the units differ
  // between the ends, so both need spelling out.
  if (max < 90) return `${Math.round(min)}–${Math.round(max)} min`;
  return `${formatMinutes(min)}–${formatMinutes(max)}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `timings.mjs — duration observations and plan estimates

Usage:
  node timings.mjs --show
  node timings.mjs --path
  node timings.mjs --estimate --agent <key> --size <small|medium|large> [--model <id>]
  node timings.mjs --forget

Options:
  --show               print every recorded observation and its calibration
  --path               print the observation file's location
  --estimate           print one estimate as JSON, with its basis
  --agent <key>        agent key, for --estimate
  --model <id>         model id, for --estimate (optional)
  --size <class>       size class: ${Object.keys(SIZE_CLASSES).join(" | ")}
  --forget             delete the observation file
  -h, --help

The store holds durations, agent keys, model ids, and size classes only — no
briefs, no agent output, no credentials. Estimates are ranges with their basis
attached, and are never commitments.

Exit 0 on success, 2 on a usage error.
`;

function fail(message) {
  process.stderr.write(`timings: ${message}\n`);
  process.exit(2);
}

function main(argv) {
  const opts = { show: false, path: false, estimate: false, forget: false, agent: null, model: null, size: null };
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
      case "--help": process.stdout.write(HELP); return 0;
      case "--show": opts.show = true; break;
      case "--path": opts.path = true; break;
      case "--estimate": opts.estimate = true; break;
      case "--forget": opts.forget = true; break;
      case "--agent": opts.agent = next(); break;
      case "--model": opts.model = next(); break;
      case "--size": opts.size = next(); break;
      default: fail(`unknown option: ${arg}`);
    }
  }

  const { store, path } = loadTimings();
  if (opts.path) {
    process.stdout.write(`${path}\n`);
    return 0;
  }
  if (opts.forget) {
    try {
      unlinkSync(path);
      process.stdout.write(`removed ${path}\n`);
    } catch {
      process.stdout.write(`nothing to remove at ${path}\n`);
    }
    return 0;
  }
  if (opts.estimate) {
    if (!opts.agent) fail("--estimate requires --agent");
    if (!opts.size || !SIZE_CLASSES[opts.size]) fail(`--size must be one of: ${Object.keys(SIZE_CLASSES).join(", ")}`);
    const estimate = estimateFor(store, { agent: opts.agent, model: opts.model, sizeClass: opts.size });
    process.stdout.write(`${JSON.stringify({ ...estimate, range: formatRange(estimate) }, null, 2)}\n`);
    return 0;
  }

  const entries = Object.entries(store.observations ?? {});
  const lines = [`timings: ${entries.length} observed shape(s) · ${path}`, ""];
  if (!entries.length) {
    lines.push("Nothing observed yet; plans will use the built-in ranges:");
    for (const [name, range] of Object.entries(SIZE_CLASSES)) {
      lines.push(`  ${name.padEnd(7)} ${formatRange(range)}   ${range.blurb}`);
    }
  } else {
    for (const [key, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      const [agent, model, sizeClass] = key.split("|");
      const estimate = estimateFor(store, { agent, model: model === "(cli-default)" ? null : model, sizeClass });
      lines.push(`  ${key}`);
      lines.push(`     ${entry.durations.length} sample(s) → ${formatRange(estimate)}  [${estimate.basis}]`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
