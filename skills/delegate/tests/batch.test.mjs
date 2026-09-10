/**
 * delegate · tests/batch.test.mjs
 *
 * The sequential runner, end to end against fake agent binaries on a throwaway
 * PATH: real processes, real working tree, real signals, no paid run.
 *
 * The invariants under test are the two that define this mode — exactly one
 * agent at a time, and not a single project check until the last subtask has
 * exited — plus the attribution that only a batch can do: telling a
 * predecessor's edits apart from the user's own uncommitted work.
 *
 * POSIX only; the shims are /bin/sh scripts and the skill targets macOS and Linux.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import { attributeChanges, composeBrief, treeSnapshot } from "../scripts/batch.mjs";
import { PLAN_SCHEMA } from "../scripts/plan.mjs";
import { installFakeAgents, installGitShim } from "./fake-agents/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BATCH = join(here, "..", "scripts", "batch.mjs");
const SKIP = process.platform === "win32";

function subtask(overrides = {}) {
  return {
    id: "first",
    title: "First slice",
    description: "Create the first file.",
    responsibility: "first slice",
    goal: "src/first.ts exists with the expected line.",
    ownedPaths: ["src/first.ts"],
    dependsOn: [],
    agent: "codex",
    acceptanceCriteria: ["src/first.ts exists"],
    sizeClass: "small",
    context: "WRITE: src/first.ts",
    ...overrides,
  };
}

function makePlan(overrides = {}) {
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
        goal: "src/second.ts exists with the expected line.",
        ownedPaths: ["src/second.ts"],
        dependsOn: ["first"],
        context: "WRITE: src/second.ts",
      }),
    ],
    ...overrides,
  };
}

/**
 * A scratch world: fake CLIs and git on the only PATH entry, a scratch cache,
 * and a git repository with a space in its name to keep argv quoting honest.
 */
function inWorld(fn) {
  return withTempDir("delegate-batch", (dir) => {
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
    const write = (plan) => {
      const path = join(dir, "plan.json");
      writeFileSync(path, JSON.stringify(plan, null, 2), "utf8");
      return path;
    };
    return fn({ dir, bin, cache, work, write, out: join(dir, "out") });
  });
}

function env(world, extra = {}) {
  return {
    PATH: world.bin,
    HOME: world.dir,
    XDG_CACHE_HOME: world.cache,
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...extra,
  };
}

function runBatch(world, args, { extraEnv = {}, timeoutMs = 60_000 } = {}) {
  const result = spawnSync(process.execPath, [BATCH, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: env(world, extraEnv),
  });
  const batchPath = join(world.out, "batch.json");
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    batchPath,
    record: existsSync(batchPath) ? JSON.parse(readFileSync(batchPath, "utf8")) : null,
  };
}

// --- briefs ---------------------------------------------------------------

test("a subtask brief is self-contained and carries the batch's boundaries", () => {
  const plan = makePlan();
  const brief = composeBrief({
    plan,
    subtask: plan.subtasks[1],
    index: 1,
    completed: [{ id: "first", title: "First slice" }],
  });
  includes(brief, "GOAL");
  includes(brief, "Your single responsibility: second slice.");
  includes(brief, "subtask 2 of 2");
  includes(brief, "Do not commit or push");
  includes(brief, "Do not change files outside src/second.ts");
  includes(brief, "ACCEPTANCE");
  includes(brief, "after every subtask in this batch has finished — not now");
  // Predecessors are named, never quoted: a sibling's brief is not this
  // subtask's context, but the tree it left behind has to be explicable.
  includes(brief, "- first: First slice");
  ok(!brief.includes("Create the first file."), "a sibling's brief must not leak into this one");
});

test("the first subtask is told the tree is the user's, not a predecessor's", () => {
  const plan = makePlan();
  const brief = composeBrief({ plan, subtask: plan.subtasks[0], index: 0, completed: [] });
  includes(brief, "You are the first subtask");
});

test("an explicit brief overrides composition entirely", () => {
  const plan = makePlan();
  const brief = composeBrief({ plan, subtask: { ...plan.subtasks[0], brief: "just this" }, index: 0 });
  equal(brief, "just this");
});

// --- attribution ----------------------------------------------------------

test("attribution separates this subtask's work from the user's own", () => {
  const before = { lines: [" M user.ts"], entries: { "user.ts": " M user.ts|10:1" } };
  const after = {
    lines: [" M user.ts", "?? new.ts"],
    entries: { "user.ts": " M user.ts|10:1", "new.ts": "?? new.ts|5:2" },
  };
  const baseline = { lines: [" M user.ts"], entries: { "user.ts": " M user.ts|10:1" } };
  const ledger = attributeChanges(before, after, baseline);
  equal(ledger.changedPaths.join(","), "new.ts");
  equal(ledger.touchedUserWork.length, 0);
  equal(ledger.note, null);
});

test("editing a file the user had already dirtied is called out", () => {
  const baseline = { lines: [" M user.ts"], entries: { "user.ts": " M user.ts|10:1" } };
  const after = { lines: [" M user.ts"], entries: { "user.ts": " M user.ts|99:2" } };
  const ledger = attributeChanges(baseline, after, baseline);
  equal(ledger.touchedUserWork.join(","), "user.ts");
  includes(ledger.note, "the user's");
});

test("a second edit to a predecessor's untracked file is still a change", () => {
  // Porcelain says "?? path" both times; only the fingerprint moves. This is
  // the case a batch produces on every dependent subtask.
  const before = { lines: ["?? new.ts"], entries: { "new.ts": "?? new.ts|5:1" } };
  const after = { lines: ["?? new.ts"], entries: { "new.ts": "?? new.ts|11:2" } };
  equal(attributeChanges(before, after, { lines: [], entries: {} }).changedPaths.join(","), "new.ts");
});

test("without git, attribution says so rather than claiming a clean tree", () => {
  const ledger = attributeChanges(null, null, null);
  equal(ledger.gitAvailable, false);
  includes(ledger.note, "nothing can be attributed");
});

// --- approval -------------------------------------------------------------

test("without --yes the table is printed and nothing is dispatched", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const plan = world.write(makePlan());
    const outcome = runBatch(world, ["run", "--plan", plan, "--cd", world.work, "--out-dir", world.out]);
    equal(outcome.exitCode, 3, outcome.stderr);
    includes(outcome.stdout, "Nothing is dispatched until you approve this plan");
    includes(outcome.stderr, "re-run with --yes");
    ok(!existsSync(join(world.out, "batch.json")), "no batch may start before the user approves it");
    ok(!existsSync(join(world.work, "src", "first.ts")), "no subtask may have run");
  });
});

test("an invalid plan stops before the first dispatch, even with --yes", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const broken = makePlan();
    broken.subtasks[0].dependsOn = ["second"];
    const outcome = runBatch(world, ["run", "--plan", world.write(broken), "--cd", world.work, "--out-dir", world.out, "--yes"]);
    equal(outcome.exitCode, 3);
    includes(outcome.stdout, "runs later");
    ok(!existsSync(join(world.work, "src", "first.ts")), "nothing may run from a plan that does not validate");
  });
});

// --- the sequence ---------------------------------------------------------

test("subtasks run one at a time, in order, in the user's tree", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const outcome = runBatch(world, [
      "run", "--plan", world.write(makePlan()), "--cd", world.work, "--out-dir", world.out, "--yes",
    ]);
    equal(outcome.exitCode, 0, outcome.stdout + outcome.stderr);
    const record = outcome.record;
    equal(record.schema, "delegate.batch.v1");
    equal(record.status, "completed");
    equal(record.subtasks.map((entry) => entry.id).join(","), "first,second");
    for (const entry of record.subtasks) {
      equal(entry.status, "completed", `${entry.id}: ${entry.reason ?? ""}`);
      ok(entry.resultPath && existsSync(entry.resultPath), `${entry.id} must leave a run result`);
      ok(existsSync(join(entry.dir, "subtask-brief.txt")), `${entry.id} must leave the brief it sent`);
      ok(entry.actualMinutes !== null, `${entry.id} must record how long it took`);
      ok(entry.estimate, `${entry.id} must carry the estimate the user approved`);
    }
    // One at a time: the second cannot have started before the first finished.
    ok(
      Date.parse(record.subtasks[1].startedAt) >= Date.parse(record.subtasks[0].finishedAt),
      "a second agent must not be alive while the first is running",
    );
    ok(existsSync(join(world.work, "src", "first.ts")), "the agent's edits land in the user's own tree");
    ok(existsSync(join(world.work, "src", "second.ts")));
    equal(record.subtasks[0].ledger.changedPaths.join(","), "src/first.ts");
    equal(record.subtasks[1].ledger.changedPaths.join(","), "src/second.ts");
    equal(record.subtasks[1].ledger.touchedUserWork.length, 0);
  });
});

test("work the user had in the tree before the batch stays theirs", () => {
  if (SKIP) return;
  return inWorld((world) => {
    writeFileSync(join(world.work, "tracked.txt"), "the user was mid-edit\n", "utf8");
    const outcome = runBatch(world, [
      "run", "--plan", world.write(makePlan()), "--cd", world.work, "--out-dir", world.out, "--yes",
    ]);
    equal(outcome.exitCode, 0, outcome.stderr);
    includes(outcome.record.baseline.lines.join(","), "tracked.txt");
    for (const entry of outcome.record.subtasks) {
      ok(!entry.ledger.changedPaths.includes("tracked.txt"), "the user's own edit is not the agent's work");
    }
    equal(readFileSync(join(world.work, "tracked.txt"), "utf8"), "the user was mid-edit\n", "the batch must not touch it");
  });
});

test("no project check runs while the batch is running", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const marker = join(world.dir, "check-ran.marker");
    const plan = makePlan({ checks: [`touch "${marker}"`] });
    const outcome = runBatch(world, ["run", "--plan", world.write(plan), "--cd", world.work, "--out-dir", world.out, "--yes"]);
    equal(outcome.exitCode, 0, outcome.stderr);
    ok(!existsSync(marker), "a check against a half-built tree tests a tree nobody asked for");
    includes(outcome.record.note, "no project check has been run");
    for (const entry of outcome.record.subtasks) {
      equal(entry.review, null, "review is deferred to the end of the batch");
    }
  });
});

// --- failure ---------------------------------------------------------------

test("a failed subtask skips its dependents and lets independent ones run", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const plan = makePlan({
      subtasks: [
        subtask({ context: "WRITE: src/first.ts\nFAIL: 3" }),
        subtask({
          id: "second",
          title: "Depends on the first",
          description: "Runs only if the first worked.",
          responsibility: "second slice",
          goal: "src/second.ts exists.",
          ownedPaths: ["src/second.ts"],
          dependsOn: ["first"],
          context: "WRITE: src/second.ts",
        }),
        subtask({
          id: "independent",
          title: "Unrelated slice",
          description: "Has nothing to do with the first.",
          responsibility: "third slice",
          goal: "src/third.ts exists.",
          ownedPaths: ["src/third.ts"],
          dependsOn: [],
          context: "WRITE: src/third.ts",
        }),
      ],
    });
    const outcome = runBatch(world, ["run", "--plan", world.write(plan), "--cd", world.work, "--out-dir", world.out, "--yes"]);
    equal(outcome.exitCode, 1, "a batch with a failure is not a success");
    const [first, second, independent] = outcome.record.subtasks;
    equal(first.status, "failed");
    equal(second.status, "skipped");
    equal(second.blockedBy, "first");
    includes(second.reason, "first");
    equal(independent.status, "completed", "an unrelated subtask must not be punished for someone else's failure");
    ok(existsSync(join(world.work, "src", "third.ts")));
    ok(!existsSync(join(world.work, "src", "second.ts")), "a skipped subtask must not have run");
    equal(outcome.record.status, "finished-with-failures");
  });
});

test("--stop-on-failure halts the rest as not-started", () => {
  if (SKIP) return;
  return inWorld((world) => {
    const plan = makePlan({
      subtasks: [
        subtask({ context: "WRITE: src/first.ts\nFAIL: 2" }),
        subtask({
          id: "independent",
          title: "Unrelated slice",
          description: "Would have run.",
          responsibility: "second slice",
          goal: "src/second.ts exists.",
          ownedPaths: ["src/second.ts"],
          dependsOn: [],
          context: "WRITE: src/second.ts",
        }),
      ],
    });
    const outcome = runBatch(world, [
      "run", "--plan", world.write(plan), "--cd", world.work, "--out-dir", world.out, "--yes", "--stop-on-failure",
    ]);
    equal(outcome.exitCode, 1);
    equal(outcome.record.subtasks[1].status, "not-started");
    includes(outcome.record.subtasks[1].reason, "--stop-on-failure");
    equal(outcome.record.status, "halted");
  });
});

test("the batch never commits, reverts, or re-dispatches", () => {
  const source = readFileSync(BATCH, "utf8");
  for (const needle of ["git commit", "git checkout", "git reset", "git revert", "git stash", "git apply"]) {
    ok(!source.includes(needle), `batch.mjs must not run ${needle}`);
  }
  // Permissions come from the adapter's own two profiles. Nothing here reaches
  // for a wider one, and there is no second attempt at a subtask that failed.
  for (const needle of ["--dangerously", "bypassPermissions", "--force"]) {
    ok(!source.includes(needle), `batch.mjs must not widen a permission profile with ${needle}`);
  }
});

// --- cancellation ----------------------------------------------------------

test("cancelling mid-batch keeps what ran and marks the rest not-started", async () => {
  if (SKIP) return;
  await inWorld(async (world) => {
    const plan = makePlan();
    const child = spawn(
      process.execPath,
      [BATCH, "run", "--plan", world.write(plan), "--cd", world.work, "--out-dir", world.out, "--yes"],
      { env: env(world, { FAKE_MODE: "sleep", FAKE_SLEEP_MS: "60000" }), stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise((resolvePromise) => child.on("close", (code) => resolvePromise(code)));
    // Interrupt once the first agent has actually started talking, which is the
    // realistic case: a user cancels a run that is under way, not one that is
    // still opening its files.
    const batchPath = join(world.out, "batch.json");
    const events = join(world.out, "01-first", "events.jsonl");
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (existsSync(events) && readFileSync(events, "utf8").trim()) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    child.kill("SIGINT");
    const code = await exited;
    equal(code, 130, "a cancelled batch exits 130");
    const record = JSON.parse(readFileSync(batchPath, "utf8"));
    equal(record.cancelled, true);
    equal(record.status, "cancelled");
    equal(record.subtasks[0].status, "aborted");
    ok(existsSync(record.subtasks[0].resultPath), "the partial run's artifacts survive cancellation");
    equal(record.subtasks[1].status, "not-started");
    includes(record.subtasks[1].reason, "cancelled");
  });
});

// --- status ---------------------------------------------------------------

test("status re-reads a finished batch without running anything", () => {
  if (SKIP) return;
  return inWorld((world) => {
    runBatch(world, ["run", "--plan", world.write(makePlan()), "--cd", world.work, "--out-dir", world.out, "--yes"]);
    const outcome = runBatch(world, ["status", "--batch", join(world.out, "batch.json")]);
    equal(outcome.exitCode, 0);
    includes(outcome.stdout, "batch: completed");
    includes(outcome.stdout, "recap.mjs");
  });
});

test("usage errors are exit 2", () => {
  if (SKIP) return;
  return inWorld((world) => {
    equal(runBatch(world, []).exitCode, 2);
    equal(runBatch(world, ["run", "--cd", world.work]).exitCode, 2);
    equal(runBatch(world, ["run", "--plan", "x", "--cd", "/nonexistent/dir"]).exitCode, 2);
    equal(runBatch(world, ["status"]).exitCode, 2);
  });
});

test("a snapshot of a non-repository is null, not an empty tree", () => {
  if (SKIP) return;
  return withTempDir("delegate-batch-nogit", (dir) => {
    equal(treeSnapshot(join(dir, "nothing-here")), null);
  });
});
