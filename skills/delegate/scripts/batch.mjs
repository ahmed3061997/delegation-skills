#!/usr/bin/env node
/**
 * delegate · batch.mjs
 *
 * Run an approved plan: one subtask at a time, in order, in the user's own
 * working tree.
 *
 * Exactly one agent process is alive at any moment. Subtask n+1 is not launched
 * until subtask n has exited and written a result, so every subtask starts from
 * whatever its predecessors actually left behind — which is what makes a
 * dependent subtask possible without worktrees, patches, or merges.
 *
 * Nothing is reviewed here. No project check is run, no diff is judged, no
 * decision is made about what to do next: a check against a half-built tree
 * tests a tree nobody asked for. The review happens once, at the end, in
 * recap.mjs.
 *
 * Usage:
 *   node batch.mjs run --plan <file> --cd <dir> --yes [options]
 *   node batch.mjs status --batch <batch.json>
 *
 * Options:
 *   --plan <file>       the plan to run (delegate.plan.v1 JSON).
 *   --cd <dir>          the working tree every subtask runs in (default: cwd).
 *   --yes               confirm the user approved the plan shown by plan.mjs.
 *                       Without it, the table is printed and nothing runs.
 *   --out-dir <dir>     artifact root (default: a fresh dir under temp).
 *   --stop-on-failure   halt the batch on the first subtask that does not
 *                       complete, instead of continuing with independent ones.
 *   --refresh-catalog   rebuild the agent catalog before the first dispatch.
 *   --json              print the batch record as JSON instead of a summary.
 *   -h, --help
 *
 * Result: <out-dir>/batch.json, schema delegate.batch.v1, rewritten after every
 * state change so a poller always sees a complete file. Each subtask gets a
 * numbered subdirectory holding the brief, the dispatch log, and the standard
 * delegate.run.v1 artifact set.
 *
 * Subtask statuses are the dispatcher's own, plus: skipped (a declared
 * prerequisite did not complete) and not-started (the batch halted, timed out,
 * or was cancelled first).
 *
 * It never commits, never reverts, never re-dispatches a failed subtask, and
 * never widens a permission profile. A failure stops that line of work and is
 * reported; what to do about it is the user's call.
 *
 * Exit codes: 0 every subtask completed · 1 something did not · 2 usage error ·
 * 3 the plan was not approved (no --yes) or did not validate · 130 cancelled.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadCatalog } from "./catalog.mjs";
import { gitPorcelain, killTree, porcelainPath } from "./lib/exec.mjs";
import { readJsonOrNull, writeJsonAtomic } from "./lib/atomic.mjs";
import { parseDuration } from "./lib/duration.mjs";
import { estimatePlan, loadPlan, renderApproval, validatePlan } from "./plan.mjs";
import { loadTimings, recordObservation, saveTimings, formatMinutes, formatRange } from "./timings.mjs";

export const BATCH_SCHEMA = "delegate.batch.v1";

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(here, "dispatch.mjs");
/** Only a clean completion satisfies a dependent. no_output is not a result. */
const SUCCESS = "completed";

function fail(message, code = 2) {
  process.stderr.write(`batch: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Change attribution
// ---------------------------------------------------------------------------

/**
 * The state of the working tree, as far as attribution needs it.
 *
 * Porcelain status alone is not enough here. A file that subtask 1 created is
 * `?? path` before subtask 2 runs and `?? path` after it edits the same file —
 * identical lines, real change. Size and mtime alongside the status line make
 * that second edit visible, which is exactly the case a batch produces and a
 * single run never does.
 */
export function treeSnapshot(cwd) {
  // -uall: two subtasks creating files under the same new directory would
  // otherwise both show up as the single line "?? src/".
  const lines = gitPorcelain(cwd, { untrackedFiles: "all" });
  if (lines === null) return null;
  const entries = {};
  for (const line of lines) {
    const path = porcelainPath(line);
    let stamp = "";
    try {
      const stats = statSync(join(cwd, path));
      stamp = `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
    } catch {
      stamp = "gone";
    }
    entries[path] = `${line}|${stamp}`;
  }
  return { lines, entries };
}

/**
 * What changed while this subtask was running, and which of it was already the
 * user's before the batch started.
 *
 * This is the piece a single run cannot do for itself. dispatch.mjs compares
 * against the tree as it found it, so from subtask 2 onwards every predecessor's
 * edit looks like "work that was already there" — true, but useless. The batch
 * baseline is what keeps "already there" meaning *the user's*.
 */
export function attributeChanges(before, after, baseline) {
  if (!before || !after) {
    return {
      gitAvailable: false,
      changedPaths: [],
      changedLines: [],
      touchedUserWork: [],
      note: "git could not report on this directory, so nothing can be attributed to this subtask",
    };
  }
  const baselinePaths = new Set(Object.keys(baseline?.entries ?? {}));
  const changedPaths = Object.keys(after.entries).filter((path) => before.entries[path] !== after.entries[path]);
  const changedLines = after.lines.filter((line) => changedPaths.includes(porcelainPath(line)));
  const touchedUserWork = changedPaths.filter((path) => baselinePaths.has(path));
  return {
    gitAvailable: true,
    changedPaths,
    changedLines,
    touchedUserWork,
    note: touchedUserWork.length
      ? `${touchedUserWork.length} path(s) were already dirty before the batch started; that work is the user's, not this subtask's`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/**
 * One subtask, one self-contained brief.
 *
 * A subtask never sees a sibling's brief. What it does see is a one-line list
 * of the subtasks that already ran, because it is about to read a working tree
 * they changed and pretending otherwise would make the tree inexplicable.
 */
export function composeBrief({ plan, subtask, index, completed = [] }) {
  if (typeof subtask.brief === "string" && subtask.brief.trim()) return subtask.brief;

  const owned = subtask.ownedPaths ?? [];
  const lines = [];
  lines.push("GOAL");
  lines.push(subtask.goal);
  lines.push("");
  lines.push("CONTEXT");
  lines.push(
    `This is subtask ${index + 1} of ${plan.subtasks.length} in a delegated batch. ` +
      `The batch as a whole: ${plan.goal ?? plan.title ?? "(no batch goal recorded)"}`,
  );
  lines.push(`Your single responsibility: ${subtask.responsibility}.`);
  if (completed.length) {
    lines.push("Earlier subtasks have already changed this working tree:");
    for (const entry of completed) lines.push(`  - ${entry.id}: ${entry.title}`);
    lines.push("Read the current state of the files rather than assuming the original state.");
  } else {
    lines.push("You are the first subtask; the working tree is as the user left it.");
  }
  if (subtask.context) lines.push(subtask.context);
  lines.push("");
  lines.push("DO");
  if (Array.isArray(subtask.do) && subtask.do.length) {
    for (const item of subtask.do) lines.push(`- ${item}`);
  } else {
    lines.push(`- ${subtask.description}`);
  }
  if (owned.length) {
    lines.push(`- Work only in: ${owned.join(", ")}`);
  }
  lines.push("");
  lines.push("DO NOT");
  lines.push("- Do not commit or push. The orchestrator reviews everything and decides what lands.");
  if (owned.length) {
    lines.push(
      `- Do not change files outside ${owned.join(", ")}. Another subtask owns them. If this task cannot be done without touching something else, stop and say so in your report.`,
    );
  }
  lines.push("- Do not fix unrelated problems you notice. Report them instead; they may belong to another subtask.");
  lines.push("- Do not reformat files you are not otherwise editing.");
  lines.push("");
  lines.push("CHECKS");
  lines.push(
    "The project's full checks are run once, over the whole tree, after every subtask in this batch has finished — not now.",
  );
  lines.push(
    "Verify your own slice as directly as you can. If you run the full suite, expect failures caused by work later subtasks have not done yet; report them, do not chase them.",
  );
  lines.push("");
  lines.push("ACCEPTANCE");
  for (const criterion of subtask.acceptanceCriteria ?? []) lines.push(`- ${criterion}`);
  lines.push("");
  lines.push("REPORT");
  lines.push("End with:");
  lines.push("- the files you changed and why");
  lines.push("- how you verified your slice, with the literal output of anything you ran");
  lines.push("- anything you decided that this brief did not specify");
  lines.push("- anything you could not do, and what blocked it");
  lines.push("- anything you noticed outside your owned paths that someone should look at");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function subtaskDir(outDir, index, id) {
  return join(outDir, `${String(index + 1).padStart(2, "0")}-${id}`);
}

function dispatchArgs({ subtask, plan, workdir, dir, briefPath }) {
  const args = ["--agent", subtask.agent, "--brief", briefPath, "--cd", workdir, "--out-dir", dir];
  if (subtask.model) args.push("--model", subtask.model);
  if (subtask.effort) args.push("--effort", subtask.effort);
  if (subtask.readOnly) args.push("--read-only");
  if (plan.budget?.subtaskTimeout) args.push("--timeout", String(plan.budget.subtaskTimeout));
  // No --refresh-catalog here: the batch refreshed once before the first
  // dispatch, and re-probing every CLI between subtasks would spend minutes
  // rediscovering a machine that has not changed.
  return args;
}

function runDispatch(args, logPath, onChild) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [DISPATCH, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
      // Its own process group, so a cancellation here reaches the dispatcher
      // (which then terminates the agent it launched) instead of racing it.
      detached: process.platform !== "win32",
    });
    onChild(child);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const settle = (outcome) => {
      writeFileSync(logPath, Buffer.concat(chunks).toString("utf8"), "utf8");
      onChild(null);
      resolvePromise(outcome);
    };
    child.on("error", (error) => settle({ exitCode: 1, launchError: String(error?.message ?? error) }));
    child.on("close", (code, signal) => settle({ exitCode: code ?? (signal ? 128 : 1), signal: signal ?? null }));
  });
}

/** The record a batch publishes before it dispatches anything. */
function createBatchRecord({ plan, opts, outDir, baseline, estimates, warnings, stopOnFailure }) {
  return {
    schema: BATCH_SCHEMA,
    planPath: resolve(opts.plan),
    plan: { title: plan.title ?? null, goal: plan.goal ?? null, checks: plan.checks ?? [] },
    workdir: opts.cd,
    outDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    stopOnFailure,
    baseline: { gitAvailable: baseline !== null, lines: baseline?.lines ?? [] },
    estimatedTotal: estimates.total,
    planWarnings: warnings,
    subtasks: plan.subtasks.map((subtask, index) => ({
      id: subtask.id,
      order: index + 1,
      title: subtask.title,
      description: subtask.description,
      responsibility: subtask.responsibility,
      agent: subtask.agent,
      model: subtask.model ?? null,
      effort: subtask.effort ?? null,
      readOnly: subtask.readOnly === true,
      ownedPaths: subtask.ownedPaths ?? [],
      dependsOn: subtask.dependsOn ?? [],
      acceptanceCriteria: subtask.acceptanceCriteria ?? [],
      sizeClass: subtask.sizeClass,
      estimate: estimates.subtasks.find((entry) => entry.id === subtask.id)?.estimate ?? null,
      status: "pending",
      blockedBy: null,
      reason: null,
      dir: subtaskDir(outDir, index, subtask.id),
      resultPath: null,
      startedAt: null,
      finishedAt: null,
      actualMinutes: null,
      exitCode: null,
      ledger: null,
      review: null,
    })),
    cancelled: false,
    note: "no project check has been run; the review happens once, after the batch (recap.mjs)",
  };
}

/** What the user sees while a subtask is in flight: where we are, and what is left. */
function announceSubtask({ plan, subtask, state, index, estimates }) {
  const remaining = estimates.subtasks.slice(index).map((entry) => entry.estimate);
  process.stdout.write(
    `\n[${index + 1}/${plan.subtasks.length}] ${subtask.id} · ${subtask.title}\n` +
      `    ${subtask.agent}${subtask.model ? ` · ${subtask.model}` : ""}${subtask.effort ? ` · ${subtask.effort}` : ""}` +
      `  ·  estimate ${state.estimate ? formatRange(state.estimate) : "?"}` +
      `  ·  remaining ${formatRange({
        min: remaining.reduce((sum, entry) => sum + entry.min, 0),
        max: remaining.reduce((sum, entry) => sum + entry.max, 0),
      })}\n`,
  );
}

/**
 * Dispatch one subtask and record what it did. Mutates `state` in the batch
 * record; the caller owns the ordering decisions around it.
 */
async function runSubtask(context) {
  const { plan, subtask, state, index, opts, baseline, record, estimates, timingsStore, publish, setChild } = context;
  mkdirSync(state.dir, { recursive: true });
  const completed = record.subtasks
    .filter((entry) => entry.status === SUCCESS)
    .map((entry) => ({ id: entry.id, title: entry.title }));
  const briefText = composeBrief({ plan, subtask, index, completed });
  const briefPath = join(state.dir, "subtask-brief.txt");
  writeFileSync(briefPath, briefText, "utf8");

  const before = treeSnapshot(opts.cd);
  const startedAt = Date.now();
  state.status = "running";
  state.startedAt = new Date(startedAt).toISOString();
  publish();
  announceSubtask({ plan, subtask, state, index, estimates });

  const outcome = await runDispatch(
    dispatchArgs({ subtask, plan, workdir: opts.cd, dir: state.dir, briefPath }),
    join(state.dir, "dispatch.log"),
    setChild,
  );

  const finished = Date.now();
  const resultPath = join(state.dir, "result.json");
  const run = readJsonOrNull(resultPath);
  state.finishedAt = new Date(finished).toISOString();
  // Two decimals, not one: a run that failed in twenty seconds should read as
  // "<1 min", not as having taken no time at all.
  state.actualMinutes = Math.round(((finished - startedAt) / 60_000) * 100) / 100;
  state.exitCode = outcome.exitCode;
  state.resultPath = run ? resultPath : null;
  state.ledger = attributeChanges(before, treeSnapshot(opts.cd), baseline);
  state.status = run?.status ?? (context.isCancelled() ? "aborted" : "failed");
  state.reason = subtaskReason({ run, outcome, cancelled: context.isCancelled(), dir: state.dir });
  publish();

  process.stdout.write(
    `    → ${state.status} in ${formatMinutes(state.actualMinutes)} · ` +
      `${state.ledger.gitAvailable ? `${state.ledger.changedPaths.length} path(s) changed` : "changes unknown (no git)"}\n`,
  );

  if (state.status === SUCCESS && subtask.sizeClass) {
    // Only clean completions calibrate: a run killed at four minutes by a bad
    // flag says nothing about how long this shape of work takes.
    Object.assign(
      timingsStore,
      recordObservation(timingsStore, {
        agent: subtask.agent,
        model: subtask.model ?? null,
        sizeClass: subtask.sizeClass,
        minutes: state.actualMinutes,
      }),
    );
    saveTimings(timingsStore);
  }
}

/** Why a subtask ended the way it did, in the words the recap will repeat. */
function subtaskReason({ run, outcome, cancelled, dir }) {
  if (run) return run.error ?? null;
  if (outcome.launchError) return `dispatch could not be launched: ${outcome.launchError}`;
  if (cancelled) return `terminated before the dispatcher wrote a result; check ${dir} for partial artifacts`;
  return "dispatch wrote no result.json; treat this subtask as unverified";
}

async function runBatch(opts) {
  const plan = loadPlan(opts.plan);
  const catalog = loadCatalog({ refresh: opts.refreshCatalog }).catalog;
  const validation = validatePlan(plan, { catalog });
  const { store: timingsStore } = loadTimings();
  const estimates = estimatePlan(plan, timingsStore);

  if (!validation.ok) {
    process.stdout.write(renderApproval(plan, estimates, { errors: validation.errors, warnings: validation.warnings }));
    fail(`the plan has ${validation.errors.length} error(s); nothing was dispatched`, 3);
  }
  if (!opts.yes) {
    // Approval is the user's, and it is given before the first process starts —
    // not inferred from the fact that someone typed a command.
    process.stdout.write(renderApproval(plan, estimates, { warnings: validation.warnings }));
    fail("plan not approved: show this table to the user, then re-run with --yes", 3);
  }

  const outDir = opts.outDir || join(tmpdir(), "delegate", `batch-${basename(opts.cd) || "repo"}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const baseline = treeSnapshot(opts.cd);
  const stopOnFailure = opts.stopOnFailure || plan.stopOnFailure === true;
  const totalBudgetMs = plan.budget?.totalTimeout ? parseDuration(String(plan.budget.totalTimeout)) : null;
  const record = createBatchRecord({
    plan,
    opts,
    outDir,
    baseline,
    estimates,
    warnings: validation.warnings,
    stopOnFailure,
  });
  const startedAt = Date.parse(record.startedAt);
  const publish = () => writeJsonAtomic(join(outDir, "batch.json"), record);
  publish();

  let currentChild = null;
  let cancelled = false;
  const onSignal = (signalName) => {
    if (cancelled) return;
    cancelled = true;
    process.stderr.write(`\nbatch: ${signalName} received — stopping after the current subtask is terminated\n`);
    if (currentChild) killTree(currentChild);
  };
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signalName, () => onSignal(signalName));

  const byId = new Map(record.subtasks.map((entry) => [entry.id, entry]));
  let halted = null;

  for (let index = 0; index < plan.subtasks.length; index += 1) {
    const subtask = plan.subtasks[index];
    const state = record.subtasks[index];

    if (cancelled || halted) {
      state.status = "not-started";
      state.reason = cancelled ? "the batch was cancelled before this subtask started" : halted;
      publish();
      continue;
    }
    if (totalBudgetMs !== null && Date.now() - startedAt > totalBudgetMs) {
      halted = `the batch passed its total budget (${plan.budget.totalTimeout}) before this subtask started`;
      state.status = "not-started";
      state.reason = halted;
      publish();
      continue;
    }
    const blocker = (subtask.dependsOn ?? []).find((id) => byId.get(id)?.status !== SUCCESS);
    if (blocker) {
      state.status = "skipped";
      state.blockedBy = blocker;
      state.reason = `prerequisite "${blocker}" finished as "${byId.get(blocker)?.status ?? "unknown"}"`;
      publish();
      process.stdout.write(`[${index + 1}/${plan.subtasks.length}] ${subtask.id}: skipped — ${state.reason}\n`);
      continue;
    }

    await runSubtask({
      plan,
      subtask,
      state,
      index,
      opts,
      baseline,
      record,
      estimates,
      timingsStore,
      publish,
      setChild: (child) => {
        currentChild = child;
      },
      isCancelled: () => cancelled,
    });

    if (cancelled) {
      halted = "the batch was cancelled";
      record.cancelled = true;
    } else if (state.status !== SUCCESS && stopOnFailure) {
      halted = `the batch stopped after "${subtask.id}" finished as "${state.status}" (--stop-on-failure)`;
    }
    publish();
  }

  record.finishedAt = new Date().toISOString();
  record.totalMinutes = Math.round(((Date.now() - startedAt) / 60_000) * 10) / 10;
  const completedCount = record.subtasks.filter((entry) => entry.status === SUCCESS).length;
  record.status = record.cancelled
    ? "cancelled"
    : completedCount === record.subtasks.length
      ? "completed"
      : halted
        ? "halted"
        : "finished-with-failures";
  publish();

  return { code: record.cancelled ? 130 : record.status === "completed" ? 0 : 1, record };
}

function summarize(record) {
  const lines = ["", `batch: ${record.status} · ${record.subtasks.length} subtask(s) · ${formatMinutes(record.totalMinutes ?? 0)} elapsed`];
  lines.push(`estimated ${formatRange(record.estimatedTotal)} · artifacts in ${record.outDir}`);
  lines.push("");
  for (const subtask of record.subtasks) {
    const time = subtask.actualMinutes === null ? "—" : formatMinutes(subtask.actualMinutes);
    lines.push(`  ${String(subtask.order).padStart(2, "0")} ${subtask.id.padEnd(20)} ${subtask.status.padEnd(12)} ${time}`);
    if (subtask.reason) lines.push(`     ${subtask.reason}`);
  }
  lines.push("");
  lines.push("Nothing has been checked yet. Run recap.mjs to review every subtask, run the project's");
  lines.push("checks once over the finished tree, and produce the report.");
  lines.push(`  node "${join(here, "recap.mjs")}" --batch "${join(record.outDir, "batch.json")}"`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `batch.mjs — run an approved plan, one subtask at a time

Usage:
  node batch.mjs run --plan <file> --cd <dir> --yes [options]
  node batch.mjs status --batch <batch.json>

Options:
  --plan <file>       plan to run (delegate.plan.v1 JSON)
  --cd <dir>          working tree every subtask runs in (default: cwd)
  --yes               confirm the user approved the plan; without it the
                      approval table is printed and nothing is dispatched
  --out-dir <dir>     artifact root (default: a fresh directory under temp)
  --stop-on-failure   halt on the first subtask that does not complete
  --refresh-catalog   rebuild the agent catalog before the first dispatch
  --json              print the batch record as JSON
  -h, --help

One agent process at a time, in plan order, in the user's own working tree. No
project check runs during the batch — a check against a half-built tree tests a
tree nobody asked for. Review once at the end with recap.mjs.

Never commits, reverts, re-dispatches a failure, or widens a permission profile.

Exit 0 when every subtask completed, 1 when something did not, 2 on a usage
error, 3 when the plan was not approved or did not validate, 130 when cancelled.
`;

function parseArgs(argv) {
  const opts = {
    command: null,
    plan: null,
    batch: null,
    cd: process.cwd(),
    yes: false,
    outDir: null,
    stopOnFailure: false,
    refreshCatalog: false,
    json: false,
  };
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
      case "--batch": opts.batch = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--yes": opts.yes = true; break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      case "--stop-on-failure": opts.stopOnFailure = true; break;
      case "--refresh-catalog": opts.refreshCatalog = true; break;
      case "--json": opts.json = true; break;
      default:
        if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
        else if (opts.command === null) opts.command = arg;
        else fail(`unexpected argument: ${arg}`);
    }
  }
  if (!opts.command) fail("a command is required: run | status");
  if (!["run", "status"].includes(opts.command)) fail(`unknown command "${opts.command}"`);
  if (opts.command === "run") {
    if (!opts.plan) fail("run requires --plan <file>");
    if (!existsSync(opts.cd)) fail(`--cd directory does not exist: ${opts.cd}`);
  }
  if (opts.command === "status" && !opts.batch) fail("status requires --batch <batch.json>");
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === "status") {
    const record = readJsonOrNull(opts.batch);
    if (!record) fail(`could not read ${opts.batch}`);
    if (record.schema !== BATCH_SCHEMA) fail(`${opts.batch} is not a ${BATCH_SCHEMA} document`);
    process.stdout.write(opts.json ? `${JSON.stringify(record, null, 2)}\n` : summarize(record));
    return record.status === "completed" ? 0 : 1;
  }
  const { code, record } = await runBatch(opts);
  process.stdout.write(opts.json ? `${JSON.stringify(record, null, 2)}\n` : summarize(record));
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`batch: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
