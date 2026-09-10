#!/usr/bin/env node
/**
 * delegate · recap.mjs
 *
 * The end-of-batch review, and the one report the user reads.
 *
 * Every subtask has finished; the tree is whole for the first time since the
 * batch started. This is where the project's checks finally run — once, over
 * everything — where each subtask's result is reviewed against what it claimed
 * and what it owned, and where the seams between subtasks get looked at, which
 * no single-run review can do.
 *
 * The one thing it will not do is let a stack of self-reports pass as evidence.
 * Aggregating six unverified claims produces one large unverified claim, so
 * every subtask line separates what the agent *reported* from what was
 * *checked*.
 *
 * Usage:
 *   node recap.mjs --batch <batch.json> [--check "<command>"]... [--json]
 *
 * Options:
 *   --batch <file>    a batch.json written by batch.mjs (required).
 *   --check <cmd>     a whole-tree check to run once. Repeatable. Defaults to
 *                     the batch plan's own checks when none are given.
 *   --timeout <dur>   per-check watchdog (default: 15m). h/m/s.
 *   --json            print the recap as JSON instead of the report.
 *   -h, --help
 *
 * Writes <batch-dir>/recap.json (schema delegate.recap.v1), fills each
 * subtask's review into its own result.json, and updates batch.json.
 *
 * It reports and stops: no commit, no revert, no re-dispatch, no rework. What
 * to do about a failed subtask is the user's decision, and the recap's job is
 * to make that decision an informed one.
 *
 * Exit codes: 0 every subtask completed, every check passed, nothing flagged ·
 * 1 there is something to read · 2 usage error.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonOrNull, writeJsonAtomic } from "./lib/atomic.mjs";
import { parseDuration } from "./lib/duration.mjs";
import { porcelainPath } from "./lib/exec.mjs";
import { formatMinutes, formatRange } from "./timings.mjs";
import { REVIEW_SCHEMA, findingsFromRun, runCheck } from "./review.mjs";
import { BATCH_SCHEMA } from "./batch.mjs";

export const RECAP_SCHEMA = "delegate.recap.v1";
const DEFAULT_CHECK_TIMEOUT = "15m";
const SUCCESS = "completed";
/** Past this multiple of the estimate, the plan's estimate misled the user. */
const DRIFT_FACTOR = 1.5;

function fail(message) {
  process.stderr.write(`recap: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Per-subtask review
// ---------------------------------------------------------------------------

/**
 * Review one finished subtask against the batch it belongs to.
 *
 * Two things here are impossible for a single run to do for itself: telling its
 * predecessors' edits apart from the user's own uncommitted work, and knowing
 * which paths it was supposed to stay inside.
 */
export function reviewSubtask(subtask, run, { userDirtyPaths }) {
  if (!run) {
    return {
      schema: REVIEW_SCHEMA,
      reviewedAt: new Date().toISOString(),
      checks: [],
      findings: [
        {
          kind: "no-result",
          severity: "high",
          detail:
            subtask.status === "skipped" || subtask.status === "not-started"
              ? `this subtask never ran (${subtask.reason ?? subtask.status})`
              : "no result.json was written, so there is nothing to review — treat this subtask as unverified",
        },
      ],
      verdict: "findings-reported",
    };
  }
  const findings = findingsFromRun(run, {
    userDirtyPaths,
    ownedPaths: subtask.ownedPaths?.length ? subtask.ownedPaths : null,
    changedPaths: subtask.ledger?.gitAvailable ? subtask.ledger.changedPaths : null,
  });
  return {
    schema: REVIEW_SCHEMA,
    reviewedAt: new Date().toISOString(),
    workdir: run.workdir ?? null,
    // Per-subtask checks are deliberately empty: the project's suite runs once,
    // over the finished tree, further down. A suite run against a tree that is
    // three subtasks short tests a tree nobody asked for.
    checks: [],
    findings,
    verdict: findings.length ? "findings-reported" : "no-findings",
  };
}

// ---------------------------------------------------------------------------
// Cross-subtask findings
// ---------------------------------------------------------------------------

/** The seams: what only becomes visible once every subtask has finished. */
export function crossSubtaskFindings(record) {
  const findings = [];

  const changedBy = new Map();
  for (const subtask of record.subtasks) {
    for (const path of subtask.ledger?.changedPaths ?? []) {
      if (!changedBy.has(path)) changedBy.set(path, []);
      changedBy.get(path).push(subtask.id);
    }
  }
  const shared = [...changedBy.entries()].filter(([, ids]) => new Set(ids).size > 1);
  if (shared.length) {
    findings.push({
      kind: "shared-path",
      severity: "medium",
      detail: `${shared.length} path(s) were changed by more than one subtask; read those diffs together before judging either`,
      paths: shared.map(([path, ids]) => `${path}  (${[...new Set(ids)].join(", ")})`),
    });
  }

  const notRun = record.subtasks.filter((subtask) => subtask.status === "skipped" || subtask.status === "not-started");
  if (notRun.length) {
    findings.push({
      kind: "not-run",
      severity: "high",
      detail: `${notRun.length} subtask(s) never ran, so the batch's goal is not met`,
      paths: notRun.map((subtask) => `${subtask.id}: ${subtask.reason ?? subtask.status}`),
    });
  }

  const failed = record.subtasks.filter(
    (subtask) => subtask.status !== SUCCESS && subtask.status !== "skipped" && subtask.status !== "not-started",
  );
  if (failed.length) {
    findings.push({
      kind: "subtask-failed",
      severity: "high",
      detail: `${failed.length} subtask(s) did not complete`,
      paths: failed.map((subtask) => `${subtask.id}: ${subtask.status}${subtask.reason ? ` — ${subtask.reason}` : ""}`),
    });
  }

  const drifted = record.subtasks.filter(
    (subtask) => subtask.estimate && subtask.actualMinutes !== null && subtask.actualMinutes > subtask.estimate.max * DRIFT_FACTOR,
  );
  if (drifted.length) {
    findings.push({
      kind: "estimate-drift",
      severity: "low",
      detail: "some subtasks took materially longer than the plan showed the user",
      paths: drifted.map(
        (subtask) => `${subtask.id}: estimated ${formatRange(subtask.estimate)}, took ${formatMinutes(subtask.actualMinutes)}`,
      ),
    });
  }

  if (record.baseline?.gitAvailable === false) {
    findings.push({
      kind: "attribution",
      severity: "medium",
      detail: "git could not report on the working tree, so no change in this batch can be attributed to a subtask",
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Recap
// ---------------------------------------------------------------------------

export function buildRecap(record, { checks, findings, subtaskReviews }) {
  const byStatus = {};
  for (const subtask of record.subtasks) {
    byStatus[subtask.status] = (byStatus[subtask.status] ?? 0) + 1;
  }
  const notDone = [];
  for (const subtask of record.subtasks) {
    if (subtask.status === SUCCESS) continue;
    notDone.push({
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
      reason: subtask.reason ?? null,
      blockedBy: subtask.blockedBy ?? null,
    });
  }
  for (const check of checks.filter((candidate) => candidate.status !== "passed")) {
    notDone.push({ id: null, title: `check: ${check.command}`, status: check.status, reason: null, blockedBy: null });
  }

  return {
    schema: RECAP_SCHEMA,
    recappedAt: new Date().toISOString(),
    batchPath: join(record.outDir, "batch.json"),
    workdir: record.workdir,
    batchStatus: record.status,
    counts: byStatus,
    estimatedTotal: record.estimatedTotal ?? null,
    actualTotalMinutes: record.totalMinutes ?? null,
    checks,
    subtasks: record.subtasks.map((subtask) => ({
      id: subtask.id,
      order: subtask.order,
      title: subtask.title,
      description: subtask.description,
      agent: subtask.agent,
      model: subtask.model,
      status: subtask.status,
      estimate: subtask.estimate,
      actualMinutes: subtask.actualMinutes,
      changedPaths: subtask.ledger?.changedPaths ?? [],
      // Kept apart on purpose: one of these is evidence, the other is a claim.
      reported: subtask.reported ?? null,
      checked: {
        findings: subtaskReviews.get(subtask.id)?.findings ?? [],
        verdict: subtaskReviews.get(subtask.id)?.verdict ?? "not-reviewed",
      },
    })),
    crossFindings: findings,
    notDone,
    decisions: [
      "what to re-run, and with what changed in the brief",
      "what to fix by hand",
      "whether any of this should be committed",
    ],
    // Deliberately absent, as everywhere else in this skill: any notion of
    // "approved". A subtask-level finding counts too — a batch whose checks all
    // pass while one subtask wrote outside its declared paths is not clean.
    verdict:
      record.status === "completed" &&
      checks.every((check) => check.status === "passed") &&
      !findings.length &&
      [...subtaskReviews.values()].every((review) => !review.findings.length)
        ? "no-findings"
        : "findings-reported",
  };
}

function firstLine(text) {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function report(recap, record) {
  const lines = [""];
  lines.push(
    `recap: batch ${recap.batchStatus} · ${record.subtasks.length} subtask(s) · ` +
      `${recap.actualTotalMinutes === null ? "duration unknown" : formatMinutes(recap.actualTotalMinutes)}` +
      `${recap.estimatedTotal ? ` (estimated ${formatRange(recap.estimatedTotal)})` : ""}`,
  );
  lines.push(`working tree: ${recap.workdir}`);
  lines.push("");

  for (const subtask of recap.subtasks) {
    const time =
      subtask.actualMinutes === null
        ? "never ran"
        : `${formatMinutes(subtask.actualMinutes)}${subtask.estimate ? ` of ${formatRange(subtask.estimate)} estimated` : ""}`;
    lines.push(`${String(subtask.order).padStart(2, "0")}. ${subtask.title}  [${subtask.status}]  ${time}`);
    lines.push(`    asked: ${subtask.description}`);
    lines.push(`    agent: ${subtask.agent}${subtask.model ? ` · ${subtask.model}` : ""}`);
    lines.push(`    reported: ${subtask.reported ? firstLine(subtask.reported) : "(nothing)"}`);
    const findings = subtask.checked.findings;
    lines.push(`    checked:  ${findings.length ? `${findings.length} finding(s)` : "no findings from the run record"}`);
    for (const finding of findings) lines.push(`      (${finding.severity}) ${finding.kind}: ${finding.detail}`);
    if (subtask.changedPaths.length) {
      lines.push(`    changed:  ${subtask.changedPaths.slice(0, 12).join(", ")}${subtask.changedPaths.length > 12 ? `, … (${subtask.changedPaths.length} total)` : ""}`);
    } else if (subtask.status === SUCCESS) {
      lines.push("    changed:  nothing");
    }
    lines.push("");
  }

  lines.push("whole-tree checks (the number no half-built subtask could report):");
  if (!recap.checks.length) {
    lines.push("  none supplied — pass --check with the project's real commands, or put them in the plan");
  }
  for (const check of recap.checks) {
    lines.push(`  [${check.status}] ${check.command}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`);
    if (check.status !== "passed") for (const line of check.outputTail.slice(-12)) lines.push(`      ${line}`);
  }
  lines.push("");

  lines.push("across subtasks:");
  if (!recap.crossFindings.length) lines.push("  nothing mechanical to report; the seams are still yours to read");
  for (const finding of recap.crossFindings) {
    lines.push(`  (${finding.severity}) ${finding.kind}: ${finding.detail}`);
    for (const path of (finding.paths ?? []).slice(0, 20)) lines.push(`      ${path}`);
  }
  lines.push("");

  lines.push("what was not done:");
  if (!recap.notDone.length) lines.push("  nothing — every subtask completed and every check passed");
  for (const entry of recap.notDone) {
    lines.push(`  ${entry.id ? `${entry.id}: ` : ""}${entry.title} [${entry.status}]${entry.reason ? ` — ${entry.reason}` : ""}`);
  }
  lines.push("");

  lines.push("Still yours to judge: do the pieces fit, did any subtask quietly redefine an interface");
  lines.push("another one relies on, and is anything duplicated between them? Then decide:");
  for (const decision of recap.decisions) lines.push(`  - ${decision}`);
  lines.push("");
  lines.push("The edits are in your working tree, uncommitted. This skill does not commit, revert, or re-dispatch.");
  lines.push(`recap: ${join(record.outDir, "recap.json")}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `recap.mjs — review a finished batch and report it once

Usage:
  node recap.mjs --batch <batch.json> [--check "<command>"]... [--json]

Options:
  --batch <file>    batch.json written by batch.mjs (required)
  --check <cmd>     whole-tree check to run once (repeatable); defaults to the
                    plan's own checks
  --timeout <dur>   per-check watchdog, default ${DEFAULT_CHECK_TIMEOUT}
  --json            print the recap as JSON instead of the report

Reviews every subtask against what it claimed and what it owned, runs the
project's checks once over the finished tree, reports the seams between
subtasks, and says plainly what was not done.

Never commits, reverts, or re-dispatches. Exit 0 when everything completed and
passed with nothing flagged, 1 when there is something to read, 2 on usage.
`;

function parseArgs(argv) {
  const opts = { batch: null, checks: [], timeout: DEFAULT_CHECK_TIMEOUT, json: false };
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
      case "--batch": opts.batch = next(); break;
      case "--check": opts.checks.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      case "--json": opts.json = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (!opts.batch) fail("--batch is required");
  if (!existsSync(opts.batch)) fail(`batch file not found: ${opts.batch}`);
  if (parseDuration(opts.timeout) === null) fail(`--timeout "${opts.timeout}" is invalid`);
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const record = readJsonOrNull(opts.batch);
  if (!record) fail(`could not parse ${opts.batch} as JSON`);
  if (record.schema !== BATCH_SCHEMA) {
    fail(`${opts.batch} is not a ${BATCH_SCHEMA} document (found "${record.schema ?? "nothing"}")`);
  }
  // A batch whose own process died leaves status "running" behind, and that
  // batch still deserves a recap. Only a subtask with an agent still in flight
  // is a reason to wait: reviewing a tree being written is reviewing noise.
  const inFlight = record.subtasks.find((subtask) => subtask.status === "running");
  if (inFlight) {
    fail(`subtask "${inFlight.id}" is still running; nothing is reviewed until every subtask has finished`);
  }

  const userDirtyPaths = (record.baseline?.lines ?? []).map(porcelainPath);
  const subtaskReviews = new Map();
  for (const subtask of record.subtasks) {
    const run = subtask.resultPath ? readJsonOrNull(subtask.resultPath) : null;
    const review = reviewSubtask(subtask, run, { userDirtyPaths });
    subtaskReviews.set(subtask.id, review);
    subtask.review = review;
    subtask.reported = run?.finalMessage ?? null;
    if (run && subtask.resultPath) writeJsonAtomic(subtask.resultPath, { ...run, review });
  }

  const commands = opts.checks.length ? opts.checks : (record.plan?.checks ?? []);
  const timeoutMs = parseDuration(opts.timeout);
  const checks = commands.map((command) => runCheck(command, record.workdir, timeoutMs));

  const findings = crossSubtaskFindings(record);
  for (const check of checks.filter((candidate) => candidate.status !== "passed")) {
    findings.push({
      kind: "check-failed",
      severity: "high",
      detail: `whole-tree check ${check.status}: ${check.command}`,
      outputTail: check.outputTail,
    });
  }

  const recap = buildRecap(record, { checks, findings, subtaskReviews });
  const recapPath = join(dirname(opts.batch), "recap.json");
  writeJsonAtomic(recapPath, recap);
  writeJsonAtomic(opts.batch, { ...record, recapPath, reviewedAt: recap.recappedAt });

  process.stdout.write(opts.json ? `${JSON.stringify(recap, null, 2)}\n` : report(recap, record));
  return recap.verdict === "no-findings" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
