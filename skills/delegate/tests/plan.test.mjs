/**
 * delegate · tests/plan.test.mjs
 *
 * Plan validation, sizing warnings, estimates, and the approval table.
 *
 * The rules under test: a plan is checked, never rewritten; a subtask carrying
 * more than one responsibility is a warning the user reads, not a silent fix;
 * and nothing about the sequence is presented to the user without the time it
 * will cost.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import {
  DEFAULT_MAX_SUBTASKS,
  PLAN_SCHEMA,
  estimatePlan,
  renderApproval,
  templatePlan,
  validatePlan,
} from "../scripts/plan.mjs";
import { emptyStore, recordObservation } from "../scripts/timings.mjs";
import { isOwned, matchesOwnedPath, unownedChanges } from "../scripts/lib/ownership.mjs";

const PLAN = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "plan.mjs");

function subtask(overrides = {}) {
  return {
    id: "parser",
    title: "Flag parsing",
    description: "Teach the parser about --dry-run.",
    responsibility: "cli flag parsing",
    goal: "The parser accepts --dry-run, defaulting to false.",
    ownedPaths: ["src/cli/flags.ts"],
    dependsOn: [],
    agent: "codex",
    acceptanceCriteria: ["--dry-run parses to a boolean"],
    sizeClass: "small",
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    schema: PLAN_SCHEMA,
    title: "dry run support",
    goal: "The export command supports --dry-run.",
    checks: ["npm test"],
    subtasks: [
      subtask(),
      subtask({
        id: "export",
        title: "Honour the flag",
        description: "Print the plan instead of writing.",
        responsibility: "export command behaviour",
        goal: "With --dry-run set, export writes nothing.",
        ownedPaths: ["src/commands/export.ts"],
        dependsOn: ["parser"],
        sizeClass: "medium",
      }),
    ],
    ...overrides,
  };
}

function kinds(problems) {
  return problems.map((problem) => problem.kind).join(",");
}

// --- shape and order ------------------------------------------------------

test("a well-formed two-subtask plan validates with no errors", () => {
  const outcome = validatePlan(plan());
  equal(outcome.errors.length, 0, JSON.stringify(outcome.errors));
  equal(outcome.ok, true);
});

test("the shipped template is a valid plan", () => {
  const outcome = validatePlan(templatePlan());
  equal(outcome.errors.length, 0, JSON.stringify(outcome.errors));
});

test("one subtask is not a batch", () => {
  const outcome = validatePlan(plan({ subtasks: [subtask()] }));
  includes(kinds(outcome.errors), "not-a-batch");
  includes(outcome.errors[0].detail, "ordinary dispatch");
});

test("the schema is checked before anything else is trusted", () => {
  includes(kinds(validatePlan({ ...plan(), schema: "something-else" }).errors), "schema");
  includes(kinds(validatePlan(null).errors), "schema");
});

test("a subtask the user cannot read about is rejected", () => {
  for (const field of ["title", "description", "responsibility", "goal"]) {
    const broken = plan();
    delete broken.subtasks[0][field];
    const outcome = validatePlan(broken);
    ok(
      outcome.errors.some((error) => error.detail.includes(field)),
      `a missing ${field} must be an error — the user reads it before approving`,
    );
  }
});

test("acceptance criteria and a size class are required", () => {
  includes(kinds(validatePlan(plan({ subtasks: [subtask({ acceptanceCriteria: [] }), subtask({ id: "b" })] })).errors), "acceptance");
  includes(kinds(validatePlan(plan({ subtasks: [subtask({ sizeClass: "huge" }), subtask({ id: "b" })] })).errors), "size");
});

test("ids must be unique and well formed", () => {
  const duplicated = plan({ subtasks: [subtask(), subtask({ dependsOn: [] })] });
  includes(kinds(validatePlan(duplicated).errors), "id");
  includes(kinds(validatePlan(plan({ subtasks: [subtask({ id: "Not An Id" }), subtask({ id: "b" })] })).errors), "id");
});

test("a dependency that runs later is an ordering error, which is also what makes cycles impossible", () => {
  const inverted = plan();
  inverted.subtasks[0].dependsOn = ["export"];
  const outcome = validatePlan(inverted);
  includes(kinds(outcome.errors), "order");
  includes(outcome.errors[0].detail, "runs later");

  const cyclic = plan();
  cyclic.subtasks[0].dependsOn = ["export"];
  cyclic.subtasks[1].dependsOn = ["parser"];
  ok(validatePlan(cyclic).errors.some((error) => error.kind === "order"), "a cycle cannot be ordered");
});

test("unknown and self dependencies are rejected", () => {
  includes(kinds(validatePlan(plan({ subtasks: [subtask(), subtask({ id: "b", dependsOn: ["ghost"] })] })).errors), "depends-on");
  includes(kinds(validatePlan(plan({ subtasks: [subtask(), subtask({ id: "b", dependsOn: ["b"] })] })).errors), "depends-on");
});

test("owned paths must stay inside the repository", () => {
  for (const path of ["/etc/passwd", "../outside/file.ts", "~/secrets"]) {
    const outcome = validatePlan(plan({ subtasks: [subtask({ ownedPaths: [path] }), subtask({ id: "b" })] }));
    ok(
      outcome.errors.some((error) => error.kind === "owned-paths"),
      `"${path}" must not be accepted as an owned path`,
    );
  }
});

test("a write subtask that owns nothing is rejected; a read-only one is fine", () => {
  includes(kinds(validatePlan(plan({ subtasks: [subtask({ ownedPaths: [] }), subtask({ id: "b" })] })).errors), "owned-paths");
  const readOnly = validatePlan(
    plan({ subtasks: [subtask({ ownedPaths: [], readOnly: true }), subtask({ id: "b" })] }),
  );
  ok(!readOnly.errors.some((error) => error.kind === "owned-paths"), "a read-only subtask delivers a report, not a diff");
});

test("a serial batch is bounded by its budget", () => {
  const many = plan({
    subtasks: Array.from({ length: DEFAULT_MAX_SUBTASKS + 1 }, (unused, index) => subtask({ id: `s${index}` })),
  });
  const outcome = validatePlan(many);
  includes(kinds(outcome.errors), "budget");
  includes(outcome.errors.find((error) => error.kind === "budget").detail, "one after another");
  includes(kinds(validatePlan(plan({ budget: { subtaskTimeout: "soon" } })).errors), "budget");
});

// --- sizing warnings ------------------------------------------------------

test("a goal carrying two responsibilities is a warning, not a rewrite", () => {
  const outcome = validatePlan(
    plan({ subtasks: [subtask({ goal: "Add the flag and rewrite the writer." }), subtask({ id: "b" })] }),
  );
  includes(kinds(outcome.warnings), "multi-responsibility");
  equal(outcome.ok, true, "a sizing warning must not block a plan the user approves anyway");
});

test("ownership sprawling across unrelated areas is flagged", () => {
  const outcome = validatePlan(
    plan({
      subtasks: [subtask({ ownedPaths: ["src/a.ts", "docs/b.md", "infra/c.tf"] }), subtask({ id: "b" })],
    }),
  );
  includes(kinds(outcome.warnings), "spans-areas");
});

test("a size class inconsistent with the declared scope is flagged both ways", () => {
  const tooBig = validatePlan(
    plan({
      subtasks: [
        subtask({ sizeClass: "small", ownedPaths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }),
        subtask({ id: "b" }),
      ],
    }),
  );
  includes(kinds(tooBig.warnings), "size-mismatch");

  const tooSmall = validatePlan(plan({ subtasks: [subtask({ sizeClass: "large" }), subtask({ id: "b" })] }));
  includes(kinds(tooSmall.warnings), "size-mismatch");
});

test("a sliver that adds no ownership beyond its predecessor should be folded in", () => {
  const outcome = validatePlan(
    plan({
      subtasks: [
        subtask({ id: "first", ownedPaths: ["src/cli/flags.ts", "src/cli/parse.ts"] }),
        subtask({ id: "second", ownedPaths: ["src/cli/flags.ts"], responsibility: "CLI flag parsing" }),
      ],
    }),
  );
  const warning = outcome.warnings.find((candidate) => candidate.kind === "too-small");
  ok(warning, "a same-responsibility subtask with no new ownership is a sliver");
  includes(warning.detail, "fold it in");
});

test("owning the whole tree is a warning: ownership that wide reports nothing", () => {
  includes(kinds(validatePlan(plan({ subtasks: [subtask({ ownedPaths: ["."] }), subtask({ id: "b" })] })).warnings), "broad-ownership");
});

test("a plan with no batch-level checks says so", () => {
  includes(kinds(validatePlan(plan({ checks: [] })).warnings), "checks");
});

// --- ownership matching ---------------------------------------------------

test("owned paths match exactly, by directory, and by trailing wildcard", () => {
  ok(matchesOwnedPath("src/cli/flags.ts", "src/cli/flags.ts"));
  ok(matchesOwnedPath("src/cli/flags.ts", "src/cli"));
  ok(matchesOwnedPath("src/cli/flags.ts", "src/**"));
  ok(matchesOwnedPath("src/cli/flags.ts", "src/cli/*"));
  ok(!matchesOwnedPath("src/io/writer.ts", "src/cli"));
  ok(!matchesOwnedPath("src/climate.ts", "src/cli"), "a prefix must stop at a path segment");
  ok(isOwned("tests/a.test.ts", ["src", "tests"]));
});

test("changes the user already had are not the agent's to answer for", () => {
  const strayed = unownedChanges(["src/cli/flags.ts", "src/io/writer.ts", "notes.md"], ["src/cli"], ["notes.md"]);
  equal(strayed.join(","), "src/io/writer.ts");
});

// --- estimates and the table ---------------------------------------------

test("every subtask gets an estimate and the total is their sum", () => {
  const estimates = estimatePlan(plan(), emptyStore());
  equal(estimates.subtasks.length, 2);
  const summed = estimates.subtasks.reduce((total, entry) => total + entry.estimate.max, 0);
  ok(estimates.total.max > summed, "the total must include the end-of-batch review allowance");
  equal(estimates.total.serial, true);
});

test("observed runs move the estimate, and the table says which basis it used", () => {
  let store = emptyStore();
  for (const minutes of [12, 13, 14, 15]) {
    store = recordObservation(store, { agent: "codex", model: null, sizeClass: "small", minutes });
  }
  const estimates = estimatePlan(plan(), store);
  const parser = estimates.subtasks.find((entry) => entry.id === "parser").estimate;
  equal(parser.basis, "observed");
  ok(parser.max < 40, "an observed range should beat the default when the runs were faster");
  includes(renderApproval(plan(), estimates), "observed");
});

test("the approval table shows order, description, ownership, agent, and time", () => {
  const table = renderApproval(plan(), estimatePlan(plan(), emptyStore()), { warnings: [] });
  includes(table, "Flag parsing");
  includes(table, "Teach the parser about --dry-run.");
  includes(table, "src/cli/flags.ts");
  includes(table, "codex");
  includes(table, "after: parser");
  includes(table, "total:");
  includes(table, "serial, so this is the sum");
  includes(table, "not commitments");
  includes(table, "Nothing is dispatched until you approve this plan");
});

// --- the CLI --------------------------------------------------------------

function runPlan(args) {
  const result = spawnSync(process.execPath, [PLAN, ...args], { encoding: "utf8", timeout: 60_000 });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("validate exits 0 on a good plan and 1 on a broken one", () => {
  withTempDir("delegate-plan", (dir) => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(plan()), "utf8");
    const ok0 = runPlan(["validate", "--plan", good, "--no-catalog"]);
    equal(ok0.exitCode, 0, ok0.stdout + ok0.stderr);
    includes(ok0.stdout, "estimated wall clock");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(plan({ subtasks: [subtask()] })), "utf8");
    const failed = runPlan(["validate", "--plan", bad, "--no-catalog"]);
    equal(failed.exitCode, 1);
    includes(failed.stdout, "not-a-batch");
  });
});

test("show renders the approval table; --json renders the same review as data", () => {
  withTempDir("delegate-plan", (dir) => {
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify(plan()), "utf8");
    includes(runPlan(["show", "--plan", path, "--no-catalog"]).stdout, "estimate");
    const parsed = JSON.parse(runPlan(["validate", "--plan", path, "--no-catalog", "--json"]).stdout);
    equal(parsed.ok, true);
    equal(parsed.estimates.subtasks.length, 2);
    equal(parsed.schema, "delegate.plan-review.v1");
  });
});

test("template writes a plan that validates", () => {
  withTempDir("delegate-plan", (dir) => {
    const path = join(dir, "template.json");
    equal(runPlan(["template", "--out", path]).exitCode, 0);
    equal(validatePlan(JSON.parse(readFileSync(path, "utf8"))).ok, true);
    equal(runPlan(["validate", "--plan", path, "--no-catalog"]).exitCode, 0);
  });
});

test("usage errors are exit 2, not a silently empty plan", () => {
  equal(runPlan([]).exitCode, 2);
  equal(runPlan(["validate"]).exitCode, 2);
  equal(runPlan(["nonsense", "--plan", "x"]).exitCode, 2);
  equal(runPlan(["validate", "--plan", "/nonexistent/plan.json"]).exitCode, 2);
});
