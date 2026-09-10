#!/usr/bin/env node
/**
 * delegate · review.mjs
 *
 * Re-run a repository's own checks against a finished run and record what they
 * said, alongside the change accounting dispatch.mjs already captured.
 *
 * This tool does the mechanical half of a review: run the commands, collect the
 * findings, write them into the run result. The judgment half — does the diff
 * match the brief, is anything out of scope, is the agent's self-report true —
 * stays with the orchestrator, because that is not something a script can do.
 * See references/review-and-report.md.
 *
 * It reports and stops. It never commits, never reverts, and never re-dispatches.
 *
 * Usage:
 *   node review.mjs --result <result.json> [--check "<command>"]... [--json]
 *
 * Options:
 *   --result <file>   A result.json written by dispatch.mjs (required).
 *   --check <cmd>     A project check to re-run in the run's working directory.
 *                     Repeatable. Discover the real commands from the repo
 *                     (CLAUDE.md / AGENTS.md / Makefile / package.json) — do not
 *                     assume them.
 *   --owned <path>    A path this run was supposed to stay inside. Repeatable.
 *                     Changes outside the declared set become findings; nothing
 *                     is prevented, and nothing is reverted.
 *   --timeout <dur>   Per-check watchdog (default: 15m). h/m/s.
 *   --json            Print the review block as JSON instead of a summary.
 *   -h, --help
 *
 * Exit codes: 0 when every check passed and nothing was flagged · 1 when a
 * check failed or a finding was recorded · 2 on a usage error.
 *
 * Each --check runs through the platform shell, because project checks are
 * shell one-liners ("npm test -- --run", "make lint"). Pass only commands you
 * intend to execute; nothing here is taken from the agent's output.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readJsonOrNull, writeJsonAtomic } from "./lib/atomic.mjs";
import { parseDuration } from "./lib/duration.mjs";
import { porcelainPath } from "./lib/exec.mjs";
import { unownedChanges } from "./lib/ownership.mjs";
import { RUN_SCHEMA } from "./dispatch.mjs";

export const REVIEW_SCHEMA = "delegate.review.v1";
const DEFAULT_CHECK_TIMEOUT = "15m";
const OUTPUT_TAIL_LINES = 40;

function fail(message) {
  process.stderr.write(`review: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { result: null, checks: [], owned: [], timeout: DEFAULT_CHECK_TIMEOUT, json: false };
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
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case "--result": opts.result = next(); break;
      case "--check": opts.checks.push(next()); break;
      case "--owned": opts.owned.push(next()); break;
      case "--timeout": opts.timeout = next(); break;
      case "--json": opts.json = true; break;
      default: fail(`unknown option: ${arg}`);
    }
  }
  if (!opts.result) fail("--result is required");
  if (!existsSync(opts.result)) fail(`result file not found: ${opts.result}`);
  if (parseDuration(opts.timeout) === null) fail(`--timeout "${opts.timeout}" is invalid`);
  return opts;
}

const HELP = `review.mjs — re-run project checks against a finished delegation run

Usage:
  node review.mjs --result <result.json> [--check "<command>"]... [--json]

Options:
  --result <file>   result.json from dispatch.mjs (required)
  --check <cmd>     project check to re-run in the run's workdir (repeatable)
  --owned <path>    path the run was supposed to stay inside (repeatable);
                    changes outside the set are reported, never prevented
  --timeout <dur>   per-check watchdog, default ${DEFAULT_CHECK_TIMEOUT}
  --json            print the review block as JSON

Exit 0 when everything passed, 1 when a check failed or a finding was recorded,
2 on a usage error. Never commits, reverts, or re-dispatches.
`;

function tail(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-OUTPUT_TAIL_LINES);
}

export function runCheck(command, cwd, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL";
  return {
    command,
    status: timedOut ? "timeout" : result.status === 0 ? "passed" : "failed",
    exitCode: typeof result.status === "number" ? result.status : null,
    durationMs: Date.now() - started,
    outputTail: tail(`${result.stdout ?? ""}${result.stderr ?? ""}`),
  };
}

/**
 * Changes on paths the run never declared.
 *
 * Nothing here prevents a write; the declaration is a claim, and this is the
 * check on it. `exempt` carries paths the user had already dirtied, which are
 * not the agent's to answer for.
 */
export function ownershipFindings({ changedPaths, ownedPaths, exempt = [] }) {
  if (!ownedPaths || !ownedPaths.length) return [];
  const strayed = unownedChanges(changedPaths, ownedPaths, exempt);
  if (!strayed.length) return [];
  return [
    {
      kind: "ownership-violation",
      severity: "medium",
      detail: `${strayed.length} path(s) changed outside the declared ownership (${ownedPaths.join(", ")})`,
      paths: strayed,
    },
  ];
}

/**
 * Findings that come from the run record itself, before any check is run.
 * These are the things worth surfacing whether or not the tests pass.
 *
 * @param {object} run the delegate.run.v1 record.
 * @param {object} [options]
 * @param {string[]|null} [options.userDirtyPaths] paths the *user* had already
 *        modified. In a batch, a run from subtask 2 onwards finds its
 *        predecessors' edits in the tree and would otherwise report all of them
 *        as unattributable; only the user's own work belongs in that finding.
 * @param {string[]|null} [options.ownedPaths] the paths this run declared.
 * @param {string[]|null} [options.changedPaths] what actually changed, when the
 *        caller can attribute it better than the run record can.
 */
export function findingsFromRun(run, { userDirtyPaths = null, ownedPaths = null, changedPaths = null } = {}) {
  const findings = [];
  if (run.status !== "completed") {
    findings.push({
      kind: "run-status",
      severity: "high",
      detail: `the run finished with status "${run.status}"${run.error ? `: ${run.error}` : ""}`,
    });
  }
  const changes = run.changes ?? null;
  if (!changes || !changes.gitAvailable) {
    findings.push({
      kind: "attribution",
      severity: "medium",
      detail: "git could not report on the working directory, so no change can be attributed to this run",
    });
  } else {
    // In a batch, "already modified" is mostly the previous subtask's work,
    // which is attributable and expected. Only what the user had dirty before
    // any of it started is genuinely unattributable.
    const alsoModified =
      userDirtyPaths === null
        ? changes.alsoModified
        : changes.alsoModified.filter((line) => userDirtyPaths.includes(porcelainPath(line)));
    if (alsoModified.length) {
      findings.push({
        kind: "attribution",
        severity: "medium",
        detail: `${alsoModified.length} path(s) were already modified before the run; review them separately from the agent's work`,
        paths: alsoModified,
      });
    }
    // What this run changed. `changedPaths` wins when the caller knows better:
    // inside a batch, editing a file a previous subtask created is this run's
    // work, even though the run record can only see "the path was already there".
    const attributed = changedPaths ?? changes.created;
    if (!attributed.length && !run.requested?.readOnly) {
      findings.push({
        kind: "no-changes",
        severity: "high",
        detail: "a write-capable run produced no new working-tree changes — check whether the task was actually done",
      });
    }
    if (attributed.length && run.requested?.readOnly) {
      // Read-only is a mode the agent enforces; this is the tripwire, not the
      // boundary. A hit here means the run cannot be trusted as read-only.
      findings.push({
        kind: "read-only-violation",
        severity: "high",
        detail: `a read-only run left ${attributed.length} new change(s) in the working tree`,
        paths: attributed,
      });
    }
    findings.push(
      ...ownershipFindings({
        changedPaths: changedPaths ?? changes.created.map(porcelainPath),
        ownedPaths,
        exempt: userDirtyPaths ?? changes.preexisting?.map(porcelainPath) ?? [],
      }),
    );
  }
  if (run.resolved && run.reportedModel && run.resolved.model && run.reportedModel !== run.resolved.model) {
    findings.push({
      kind: "model-mismatch",
      severity: "medium",
      detail: `requested model "${run.resolved.model}" but the agent reported running "${run.reportedModel}"`,
    });
  }
  if (run.resolved && run.resolved.effort && !run.resolved.effortVerified) {
    findings.push({
      kind: "unverified-effort",
      severity: "low",
      detail: `effort "${run.resolved.effort}" could not be verified against a listing; the agent may have ignored it`,
    });
  }
  for (const warning of run.warnings ?? []) {
    findings.push({ kind: "selection-warning", severity: "low", detail: warning });
  }
  return findings;
}

function summarize(review, run) {
  const lines = [""];
  lines.push(`review: ${run.label} run ${run.status}  ·  ${review.checks.length} check(s), ${review.findings.length} finding(s)`);
  lines.push("");
  if (review.checks.length) {
    lines.push("checks:");
    for (const check of review.checks) {
      lines.push(`  [${check.status}] ${check.command}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`);
      if (check.status !== "passed") {
        for (const line of check.outputTail.slice(-12)) lines.push(`      ${line}`);
      }
    }
  } else {
    lines.push("checks: none supplied — pass --check with the project's real test/lint/build commands");
  }
  lines.push("");
  if (review.findings.length) {
    lines.push("findings:");
    for (const finding of review.findings) {
      lines.push(`  (${finding.severity}) ${finding.kind}: ${finding.detail}`);
      for (const path of (finding.paths ?? []).slice(0, 20)) lines.push(`      ${path}`);
    }
  } else {
    lines.push("findings: none from the run record.");
  }
  lines.push("");
  lines.push("Still yours to judge: does the diff match the brief, is anything out of scope,");
  lines.push("and is the agent's own report true? review.mjs does not commit, revert, or re-dispatch.");
  return `${lines.join("\n")}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const run = readJsonOrNull(opts.result);
  if (!run) fail(`could not parse ${opts.result} as JSON`);
  if (run.schema !== RUN_SCHEMA) {
    fail(`${opts.result} is not a ${RUN_SCHEMA} document (found "${run.schema ?? "nothing"}")`);
  }
  if (!run.workdir) fail("the run result has no workdir to run checks in");

  const timeoutMs = parseDuration(opts.timeout);
  const checks = opts.checks.map((command) => runCheck(command, run.workdir, timeoutMs));
  const findings = findingsFromRun(run, { ownedPaths: opts.owned.length ? opts.owned : null });
  for (const check of checks.filter((candidate) => candidate.status !== "passed")) {
    findings.push({
      kind: "check-failed",
      severity: "high",
      detail: `project check ${check.status}: ${check.command}`,
      outputTail: check.outputTail,
    });
  }

  const review = {
    schema: REVIEW_SCHEMA,
    reviewedAt: new Date().toISOString(),
    workdir: run.workdir,
    checks,
    findings,
    // Deliberately absent: any notion of "approved". Landing the work is a
    // decision, and this file is evidence for it, not the decision itself.
    verdict: findings.length ? "findings-reported" : "no-findings",
  };

  writeJsonAtomic(opts.result, { ...run, review });
  process.stdout.write(opts.json ? `${JSON.stringify(review, null, 2)}\n` : summarize(review, run));
  return findings.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
