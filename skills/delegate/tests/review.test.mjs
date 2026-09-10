/**
 * delegate · tests/review.test.mjs
 *
 * Review findings and the check runner. The invariant under test is that review
 * reports and stops: it writes findings, and it never lands, reverts, or
 * re-dispatches anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import { findingsFromRun } from "../scripts/review.mjs";

const REVIEW = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "review.mjs");

function runRecord(overrides = {}) {
  return {
    schema: "delegate.run.v1",
    agent: "codex",
    label: "OpenAI Codex",
    agentVersion: "codex-cli 0.147.0",
    workdir: "/tmp/repo",
    requested: { agent: "codex", model: "gpt-5.5", effort: "high", readOnly: false },
    resolved: {
      model: "gpt-5.5",
      modelSource: "cached-catalog",
      effort: "high",
      effortMechanism: "codex-config",
      effortVerified: true,
      authState: "authenticated",
    },
    reportedModel: null,
    status: "completed",
    exitCode: 0,
    finalMessage: "Added the flag.",
    warnings: [],
    changes: {
      gitAvailable: true,
      baseline: [],
      after: ["?? src/new.ts"],
      created: ["?? src/new.ts"],
      preexisting: [],
      alsoModified: [],
      attributionUncertain: false,
      note: null,
    },
    review: null,
    ...overrides,
  };
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).join(",");
}

test("a clean completed run in a clean workspace yields no findings", () => {
  equal(findingsFromRun(runRecord()).length, 0);
});

test("pre-existing modifications are flagged so they are reviewed separately", () => {
  const findings = findingsFromRun(
    runRecord({
      changes: {
        gitAvailable: true,
        baseline: [" M src/already.ts"],
        after: [" M src/already.ts", "?? src/new.ts"],
        created: ["?? src/new.ts"],
        preexisting: [" M src/already.ts"],
        alsoModified: [" M src/already.ts"],
        attributionUncertain: true,
        note: "1 path(s) were already modified before the run",
      },
    }),
  );
  includes(kinds(findings), "attribution");
  includes(findings[0].detail, "already modified");
  includes(findings[0].paths.join(""), "src/already.ts");
});

test("a write-capable run that changed nothing is a finding, not a pass", () => {
  const findings = findingsFromRun(
    runRecord({ changes: { ...runRecord().changes, after: [], created: [] } }),
  );
  includes(kinds(findings), "no-changes");
});

test("a read-only run that changed something trips the tripwire", () => {
  const findings = findingsFromRun(runRecord({ requested: { ...runRecord().requested, readOnly: true } }));
  const violation = findings.find((finding) => finding.kind === "read-only-violation");
  ok(violation, "a read-only run leaving changes must be reported");
  equal(violation.severity, "high");
});

test("a read-only deliverable that touched nothing is clean", () => {
  // The non-code case: the deliverable is the final message, not a diff.
  const findings = findingsFromRun(
    runRecord({
      requested: { ...runRecord().requested, readOnly: true },
      finalMessage: "Here is the architecture comparison you asked for…",
      changes: { ...runRecord().changes, after: [], created: [] },
    }),
  );
  equal(findings.length, 0, "no diff is the expected outcome for a read-only deliverable");
});

test("a non-completed run is always a finding", () => {
  includes(kinds(findingsFromRun(runRecord({ status: "timeout", error: "watchdog fired" }))), "run-status");
  includes(kinds(findingsFromRun(runRecord({ status: "no_output" }))), "run-status");
});

test("a model the agent silently swapped is reported", () => {
  const findings = findingsFromRun(runRecord({ reportedModel: "gpt-5.4-mini" }));
  const mismatch = findings.find((finding) => finding.kind === "model-mismatch");
  includes(mismatch.detail, "gpt-5.4-mini");
});

test("an unverified effort is carried into the review", () => {
  const findings = findingsFromRun(
    runRecord({ resolved: { ...runRecord().resolved, effortVerified: false } }),
  );
  includes(kinds(findings), "unverified-effort");
});

test("missing git means the review says so rather than assuming a clean tree", () => {
  const findings = findingsFromRun(runRecord({ changes: { gitAvailable: false, created: [] } }));
  includes(kinds(findings), "attribution");
  includes(findings.find((finding) => finding.kind === "attribution").detail, "no change can be attributed");
});

test("selection warnings survive into the review record", () => {
  const findings = findingsFromRun(runRecord({ warnings: ["catalog is stale: refresh failed"] }));
  includes(kinds(findings), "selection-warning");
});

// --- the CLI --------------------------------------------------------------

function writeRun(dir, record) {
  const path = join(dir, "result.json");
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return path;
}

function runReview(args) {
  const result = spawnSync(process.execPath, [REVIEW, ...args], { encoding: "utf8", timeout: 60_000 });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("a passing check leaves the run with no findings and exit 0", () => {
  withTempDir("delegate-review", (dir) => {
    const path = writeRun(dir, runRecord({ workdir: dir }));
    const outcome = runReview(["--result", path, "--check", "exit 0"]);
    equal(outcome.exitCode, 0, outcome.stderr);
    const updated = JSON.parse(readFileSync(path, "utf8"));
    equal(updated.review.schema, "delegate.review.v1");
    equal(updated.review.verdict, "no-findings");
    equal(updated.review.checks[0].status, "passed");
    // The run record itself is preserved, not replaced.
    equal(updated.status, "completed");
    equal(updated.agent, "codex");
  });
});

test("a failing check becomes a high-severity finding and exit 1", () => {
  withTempDir("delegate-review", (dir) => {
    const path = writeRun(dir, runRecord({ workdir: dir }));
    const outcome = runReview(["--result", path, "--check", "echo 'boom: 2 tests failed' >&2; exit 3"]);
    equal(outcome.exitCode, 1);
    const review = JSON.parse(readFileSync(path, "utf8")).review;
    equal(review.checks[0].status, "failed");
    equal(review.checks[0].exitCode, 3);
    includes(review.checks[0].outputTail, "2 tests failed");
    includes(kinds(review.findings), "check-failed");
    equal(review.verdict, "findings-reported");
  });
});

test("checks run in the run's working directory", () => {
  withTempDir("delegate-review", (dir) => {
    writeFileSync(join(dir, "marker.txt"), "here", "utf8");
    const path = writeRun(dir, runRecord({ workdir: dir }));
    equal(runReview(["--result", path, "--check", "test -f marker.txt"]).exitCode, 0);
  });
});

test("no checks supplied is reported, not silently treated as success", () => {
  withTempDir("delegate-review", (dir) => {
    const path = writeRun(dir, runRecord({ workdir: dir }));
    const outcome = runReview(["--result", path]);
    includes(outcome.stdout, "none supplied");
  });
});

test("the review never commits, reverts, or re-dispatches", () => {
  const source = readFileSync(REVIEW, "utf8");
  for (const forbidden of ["git commit", "git checkout", "git reset", "git revert", "dispatch.mjs"]) {
    ok(!source.includes(`"${forbidden}`), `review.mjs must not run ${forbidden}`);
  }
  withTempDir("delegate-review", (dir) => {
    const path = writeRun(dir, runRecord({ workdir: dir, status: "failed" }));
    const outcome = runReview(["--result", path]);
    equal(outcome.exitCode, 1);
    includes(outcome.stdout, "does not commit, revert, or re-dispatch");
  });
});

test("a result file from another schema is refused", () => {
  withTempDir("delegate-review", (dir) => {
    const path = join(dir, "result.json");
    writeFileSync(path, JSON.stringify({ schema: "something-else.v1" }), "utf8");
    const outcome = runReview(["--result", path]);
    equal(outcome.exitCode, 2);
    includes(outcome.stderr, "delegate.run.v1");
  });
});
