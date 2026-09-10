/**
 * delegate · tests/recap.test.mjs
 *
 * The end-of-batch review and the one report the user reads.
 *
 * What is under test: the checks run here and nowhere earlier; a predecessor's
 * edits are not reported as unattributable; ownership claims are checked;
 * reported and checked stay apart; and whatever did not happen is named.
 */

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import { crossSubtaskFindings, reviewSubtask } from "../scripts/recap.mjs";
import { PLAN_SCHEMA } from "../scripts/plan.mjs";
import { installFakeAgents, installGitShim } from "./fake-agents/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BATCH = join(here, "..", "scripts", "batch.mjs");
const RECAP = join(here, "..", "scripts", "recap.mjs");
const SKIP = process.platform === "win32";

// --- unit: one subtask's review ------------------------------------------

function run(overrides = {}) {
  return {
    schema: "delegate.run.v1",
    agent: "codex",
    label: "OpenAI Codex",
    workdir: "/tmp/repo",
    status: "completed",
    requested: { agent: "codex", readOnly: false },
    resolved: { model: "gpt-5.6", effort: "high", effortVerified: true },
    reportedModel: null,
    finalMessage: "Did the thing.",
    warnings: [],
    changes: {
      gitAvailable: true,
      baseline: ["?? src/first.ts"],
      after: ["?? src/first.ts", "?? src/second.ts"],
      created: ["?? src/second.ts"],
      preexisting: ["?? src/first.ts"],
      alsoModified: ["?? src/first.ts"],
      attributionUncertain: true,
      note: "1 path(s) were already modified before the run",
    },
    review: null,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    id: "second",
    order: 2,
    title: "Second slice",
    status: "completed",
    ownedPaths: ["src/second.ts"],
    ledger: { gitAvailable: true, changedPaths: ["src/second.ts"], touchedUserWork: [], note: null },
    estimate: { min: 15, max: 40, basis: "defaults" },
    actualMinutes: 20,
    ...overrides,
  };
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).join(",");
}

test("a predecessor's edits are not reported as unattributable", () => {
  // Without the batch baseline this is the finding that would fire on every
  // subtask after the first, and mean nothing every time.
  const review = reviewSubtask(state(), run(), { userDirtyPaths: [] });
  equal(kinds(review.findings), "", JSON.stringify(review.findings));
  equal(review.verdict, "no-findings");
});

test("work the user had dirty before the batch is still flagged", () => {
  const review = reviewSubtask(state(), run(), { userDirtyPaths: ["src/first.ts"] });
  includes(kinds(review.findings), "attribution");
  includes(review.findings[0].detail, "already modified");
});

test("a write outside the declared ownership is a finding", () => {
  const review = reviewSubtask(
    state({ ledger: { gitAvailable: true, changedPaths: ["src/second.ts", "src/elsewhere.ts"], touchedUserWork: [] } }),
    run(),
    { userDirtyPaths: [] },
  );
  const violation = review.findings.find((finding) => finding.kind === "ownership-violation");
  ok(violation, "ownership is a claim the review checks");
  includes(violation.paths.join(","), "src/elsewhere.ts");
  ok(!violation.paths.includes("src/second.ts"), "declared paths are not violations");
});

test("a subtask that never ran is reviewed as never having run", () => {
  const review = reviewSubtask(state({ status: "skipped", reason: 'prerequisite "first" failed' }), null, {
    userDirtyPaths: [],
  });
  includes(kinds(review.findings), "no-result");
  includes(review.findings[0].detail, "never ran");
});

test("per-subtask reviews run no checks; that is the batch's job", () => {
  equal(reviewSubtask(state(), run(), { userDirtyPaths: [] }).checks.length, 0);
});

// --- unit: the seams ------------------------------------------------------

function record(overrides = {}) {
  return {
    schema: "delegate.batch.v1",
    status: "completed",
    workdir: "/tmp/repo",
    outDir: "/tmp/out",
    baseline: { gitAvailable: true, lines: [] },
    subtasks: [state({ id: "first", order: 1 }), state()],
    ...overrides,
  };
}

test("a path two subtasks both changed is surfaced as a seam", () => {
  const findings = crossSubtaskFindings(
    record({
      subtasks: [
        state({ id: "first", order: 1, ledger: { gitAvailable: true, changedPaths: ["src/shared.ts"], touchedUserWork: [] } }),
        state({ ledger: { gitAvailable: true, changedPaths: ["src/shared.ts"], touchedUserWork: [] } }),
      ],
    }),
  );
  const shared = findings.find((finding) => finding.kind === "shared-path");
  ok(shared, "two subtasks editing one file is exactly what a per-run review cannot see");
  includes(shared.paths.join(","), "first, second");
});

test("subtasks that never ran and subtasks that failed are separate findings", () => {
  const findings = crossSubtaskFindings(
    record({
      subtasks: [
        state({ id: "first", order: 1, status: "failed" }),
        state({ status: "skipped", reason: "prerequisite failed" }),
      ],
    }),
  );
  includes(kinds(findings), "not-run");
  includes(kinds(findings), "subtask-failed");
});

test("an estimate the batch blew past is reported back to the user", () => {
  const findings = crossSubtaskFindings(
    record({ subtasks: [state({ id: "first", order: 1 }), state({ actualMinutes: 200 })] }),
  );
  const drift = findings.find((finding) => finding.kind === "estimate-drift");
  ok(drift, "an estimate that misled the user is worth saying out loud");
  includes(drift.paths.join(","), "estimated");
});

test("a tree git could not report on is never treated as clean", () => {
  includes(kinds(crossSubtaskFindings(record({ baseline: { gitAvailable: false, lines: [] } }))), "attribution");
});

// --- end to end -----------------------------------------------------------

function inWorld(fn) {
  return withTempDir("delegate-recap", (dir) => {
    const bin = installFakeAgents(join(dir, "bin"));
    installGitShim(bin);
    const cache = join(dir, "cache");
    const work = join(dir, "work dir");
    mkdirSync(cache, { recursive: true });
    mkdirSync(work, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
    writeFileSync(join(work, "tracked.txt"), "original\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "seed"], {
      cwd: work,
      stdio: "ignore",
    });
    return fn({ dir, bin, cache, work, out: join(dir, "out") });
  });
}

function subtask(overrides = {}) {
  return {
    id: "first",
    title: "First slice",
    description: "Create the first file.",
    responsibility: "first slice",
    goal: "src/first.ts exists.",
    ownedPaths: ["src/first.ts"],
    dependsOn: [],
    agent: "codex",
    acceptanceCriteria: ["src/first.ts exists"],
    sizeClass: "small",
    context: "WRITE: src/first.ts",
    ...overrides,
  };
}

function runBatchAndRecap(world, plan, recapArgs = []) {
  const planPath = join(world.dir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
  const env = {
    PATH: world.bin,
    HOME: world.dir,
    XDG_CACHE_HOME: world.cache,
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  };
  const batch = spawnSync(
    process.execPath,
    [BATCH, "run", "--plan", planPath, "--cd", world.work, "--out-dir", world.out, "--yes"],
    { encoding: "utf8", timeout: 60_000, env },
  );
  const batchPath = join(world.out, "batch.json");
  const recap = spawnSync(process.execPath, [RECAP, "--batch", batchPath, ...recapArgs], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  return {
    batch: { exitCode: batch.status, stdout: batch.stdout ?? "", stderr: batch.stderr ?? "" },
    exitCode: recap.status,
    stdout: recap.stdout ?? "",
    stderr: recap.stderr ?? "",
    batchPath,
    record: existsSync(batchPath) ? JSON.parse(readFileSync(batchPath, "utf8")) : null,
    recap: existsSync(join(world.out, "recap.json")) ? JSON.parse(readFileSync(join(world.out, "recap.json"), "utf8")) : null,
  };
}

function twoSlicePlan(overrides = {}) {
  return {
    schema: PLAN_SCHEMA,
    title: "two slices",
    goal: "Two files exist.",
    checks: [],
    subtasks: [
      subtask(),
      subtask({
        id: "second",
        title: "Second slice",
        description: "Create the second file.",
        responsibility: "second slice",
        goal: "src/second.ts exists.",
        ownedPaths: ["src/second.ts"],
        dependsOn: ["first"],
        context: "WRITE: src/second.ts",
      }),
    ],
    ...overrides,
  };
}

test("the whole-tree checks run here, once, after every subtask has finished", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const marker = join(world.dir, "checked.marker");
    // Shell builtins only: the throwaway PATH holds the fake agents and git,
    // so a check that reaches for /usr/bin would be testing the sandbox.
    const outcome = runBatchAndRecap(world, twoSlicePlan({ checks: [`test -f "src/first.ts" && echo ran > "${marker}"`] }));
    equal(outcome.batch.exitCode, 0, outcome.batch.stderr);
    ok(existsSync(marker), "the check must run in the recap, in the batch's working tree");
    equal(outcome.exitCode, 0, outcome.stdout + outcome.stderr);
    equal(outcome.recap.checks.length, 1);
    equal(outcome.recap.checks[0].status, "passed");
    equal(outcome.recap.verdict, "no-findings");
  });
});

test("a failing whole-tree check is a finding and exit 1", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatchAndRecap(world, twoSlicePlan({ checks: ["echo 'boom: 2 failed' >&2; exit 1"] }));
    equal(outcome.exitCode, 1);
    includes(outcome.stdout, "whole-tree checks");
    includes(kinds(outcome.recap.crossFindings), "check-failed");
  });
});

test("the recap keeps what an agent reported apart from what was checked", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatchAndRecap(world, twoSlicePlan());
    includes(outcome.stdout, "reported:");
    includes(outcome.stdout, "checked:");
    for (const entry of outcome.recap.subtasks) {
      ok(entry.reported !== undefined, "the agent's claim is recorded");
      ok(entry.checked, "and kept separate from what the review found");
      equal(entry.checked.verdict, "no-findings");
    }
  });
});

test("no subtask after the first is accused of the previous one's changes", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatchAndRecap(world, twoSlicePlan());
    for (const entry of outcome.recap.subtasks) {
      equal(entry.checked.findings.length, 0, `${entry.id}: ${JSON.stringify(entry.checked.findings)}`);
    }
  });
});

test("a subtask that wrote outside its owned paths is caught at the end", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const plan = twoSlicePlan();
    plan.subtasks[1].context = "WRITE: src/second.ts\nWRITE: src/not-mine.ts";
    const outcome = runBatchAndRecap(world, plan);
    const second = outcome.recap.subtasks.find((entry) => entry.id === "second");
    const violation = second.checked.findings.find((finding) => finding.kind === "ownership-violation");
    ok(violation, "the declaration is checked once the batch is done, not enforced mid-run");
    includes(violation.paths.join(","), "src/not-mine.ts");
    equal(outcome.exitCode, 1);
  });
});

test("what did not happen is named, and the recap says so plainly", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const plan = twoSlicePlan();
    plan.subtasks[0].context = "WRITE: src/first.ts\nFAIL: 4";
    const outcome = runBatchAndRecap(world, plan);
    equal(outcome.exitCode, 1);
    includes(outcome.stdout, "what was not done:");
    const ids = outcome.recap.notDone.map((entry) => entry.id).join(",");
    includes(ids, "first");
    includes(ids, "second");
    includes(kinds(outcome.recap.crossFindings), "not-run");
    includes(outcome.stdout, "does not commit, revert, or re-dispatch");
  });
});

test("the review is written back into each run result and the batch record", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatchAndRecap(world, twoSlicePlan());
    for (const entry of outcome.record.subtasks) {
      equal(entry.review.schema, "delegate.review.v1");
      const result = JSON.parse(readFileSync(entry.resultPath, "utf8"));
      equal(result.review.schema, "delegate.review.v1", "the run's own artifact carries its review");
      equal(result.status, "completed", "the run record is preserved, not replaced");
    }
    ok(outcome.record.recapPath.endsWith("recap.json"));
  });
});

test("--json prints the recap contract", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatchAndRecap(world, twoSlicePlan(), ["--json"]);
    const parsed = JSON.parse(outcome.stdout);
    equal(parsed.schema, "delegate.recap.v1");
    for (const field of ["counts", "checks", "subtasks", "crossFindings", "notDone", "verdict", "estimatedTotal"]) {
      ok(field in parsed, `the recap contract needs ${field}`);
    }
  });
});

test("a batch with a subtask still running is not reviewed", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const batchPath = join(world.dir, "half.json");
    writeFileSync(
      batchPath,
      JSON.stringify({ ...record({ status: "running" }), subtasks: [state({ status: "running" })] }),
      "utf8",
    );
    const outcome = spawnSync(process.execPath, [RECAP, "--batch", batchPath], { encoding: "utf8", timeout: 30_000 });
    equal(outcome.status, 2);
    includes(outcome.stderr, "still running");
  });
});

test("the recap never commits, reverts, or re-dispatches", () => {
  const source = readFileSync(RECAP, "utf8");
  for (const needle of ["git commit", "git checkout", "git reset", "git revert", "dispatch.mjs"]) {
    ok(!source.includes(needle), `recap.mjs must not run ${needle}`);
  }
});

test("usage errors are exit 2", () => {
  const missing = spawnSync(process.execPath, [RECAP], { encoding: "utf8", timeout: 30_000 });
  equal(missing.status, 2);
  const wrongSchema = withTempDir("delegate-recap-usage", (dir) => {
    const path = join(dir, "notabatch.json");
    writeFileSync(path, JSON.stringify({ schema: "something-else" }), "utf8");
    return spawnSync(process.execPath, [RECAP, "--batch", path], { encoding: "utf8", timeout: 30_000 });
  });
  equal(wrongSchema.status, 2);
  includes(wrongSchema.stderr, "delegate.batch.v1");
});
