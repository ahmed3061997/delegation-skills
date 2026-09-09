/**
 * delegate-skill · tests/dispatch.test.mjs
 *
 * The dispatch lifecycle, end to end, against fake agent binaries on a
 * throwaway PATH: real processes, real stdin, real signals, real exit codes —
 * and no paid run. See tests/fake-agents/.
 *
 * POSIX only; the shims are /bin/sh scripts and the skill targets macOS and
 * Linux.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import { describeChanges } from "../scripts/dispatch.mjs";
import { installFakeAgents } from "./fake-agents/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(here, "..", "scripts", "dispatch.mjs");
const SKIP = process.platform === "win32";

/**
 * Run dispatch.mjs against fake agents inside a scratch world:
 *   <dir>/bin        fake CLIs, the only entry on PATH
 *   <dir>/cache      XDG_CACHE_HOME, so the real catalog is untouched
 *   <dir>/work dir   a git repository with a space in its name
 */
/**
 * git has to be reachable for change accounting, but the real PATH is not:
 * it holds the user's actual agent CLIs, which discovery would then find. A
 * shim gives dispatch a working git and nothing else.
 */
function installGitShim(binDir) {
  const realGit = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(binDir, "git");
  writeFileSync(shim, `#!/bin/sh\nexec "${realGit}" "$@"\n`, "utf8");
  execFileSync("chmod", ["755", shim]);
}

function inWorld(fn, { git = true } = {}) {
  return withTempDir("delegate-dispatch", (dir) => {
    const bin = installFakeAgents(join(dir, "bin"));
    installGitShim(bin);
    const cache = join(dir, "cache");
    // A path with a space is the standard way argv quoting bugs show up.
    const work = join(dir, "work dir");
    mkdirSync(cache, { recursive: true });
    mkdirSync(work, { recursive: true });
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
      writeFileSync(join(work, "tracked.txt"), "original\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "seed"], {
        cwd: work,
        stdio: "ignore",
      });
    }
    const briefPath = join(dir, "brief.txt");
    writeFileSync(briefPath, "GOAL: add a flag\nDo not commit or push.\n", "utf8");
    return fn({ dir, bin, cache, work, briefPath });
  });
}

function runDispatch(world, args, { env = {}, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(process.execPath, [DISPATCH, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      PATH: world.bin,
      HOME: world.dir,
      XDG_CACHE_HOME: world.cache,
      // Keep Node itself reachable for the shims.
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...env,
    },
  });
  const outDir = args[args.indexOf("--out-dir") + 1];
  const resultPath = join(outDir, "result.json");
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    resultPath,
    run: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
  };
}

function baseArgs(world, agent, extra = []) {
  return [
    "--agent", agent,
    "--brief", world.briefPath,
    "--cd", world.work,
    "--out-dir", join(world.dir, "run out"),
    ...extra,
  ];
}

// --- happy path, one per adapter -----------------------------------------

for (const [agent, model] of [
  ["claude", "opus"],
  ["codex", null],
  ["opencode", "anthropic/claude-sonnet-5"],
  ["cursor", "gpt-5.2"],
]) {
  test(`${agent}: a completed run publishes a reviewable result`, () => {
    if (SKIP) return;
    inWorld((world) => {
      const stdinCopy = join(world.dir, "received-brief.txt");
      const args = baseArgs(world, agent, model ? ["--model", model] : []);
      const outcome = runDispatch(world, args, { env: { FAKE_STDIN_OUT: stdinCopy } });

      equal(outcome.exitCode, 0, outcome.stderr);
      equal(outcome.run.schema, "delegate-skill.run.v1");
      equal(outcome.run.status, "completed");
      equal(outcome.run.agent, agent);
      ok(outcome.run.sessionId, "a session id must be captured for a follow-up turn");
      includes(outcome.run.finalMessage, "Applied the change");

      // The brief travelled on stdin, byte for byte.
      equal(readFileSync(stdinCopy, "utf8"), readFileSync(world.briefPath, "utf8"));
      equal(readFileSync(outcome.run.artifacts.briefPath, "utf8"), readFileSync(world.briefPath, "utf8"));

      // Every run leaves the same artifact set, whatever the adapter.
      for (const key of ["briefPath", "eventsPath", "finalPath", "stderrPath", "resultPath"]) {
        ok(existsSync(outcome.run.artifacts[key]), `${agent} should leave ${key}`);
      }
      ok(readFileSync(outcome.run.artifacts.eventsPath, "utf8").trim().length > 0);
      ok(outcome.run.command.args.length > 0, "the exact argv is recorded for audit");
      ok(outcome.run.permissionProfile.name, "the permission profile is named in the result");
      equal(outcome.run.review, null, "review is filled in by review.mjs, not by dispatch");
    });
  });
}

test("a working directory with a space in it survives argv construction", () => {
  if (SKIP) return;
  inWorld((world) => {
    ok(world.work.includes(" "));
    const outcome = runDispatch(world, baseArgs(world, "codex"));
    equal(outcome.exitCode, 0, outcome.stderr);
    equal(outcome.run.workdir, world.work);
    // codex is told where to write its report; that path has a space too.
    ok(outcome.run.command.args.includes(join(world.dir, "run out", "final.txt")));
    equal(readFileSync(outcome.run.artifacts.finalPath, "utf8").trim().length > 0, true);
  });
});

// --- failure modes --------------------------------------------------------

test("a non-zero exit is reported as failed, with the agent's stderr", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex"), { env: { FAKE_EXIT: "7" } });
    equal(outcome.exitCode, 7, "the agent's own exit code is passed through");
    equal(outcome.run.status, "failed");
    equal(outcome.run.exitCode, 7);
    includes(outcome.run.stderrTail, "failing on purpose");
  });
});

test("a clean exit with no report is not reported as success", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "cursor", ["--model", "gpt-5.2"]), {
      env: { FAKE_MODE: "silent" },
    });
    equal(outcome.run.status, "no_output");
    includes(outcome.run.error, "no final report");
  });
});

test("malformed events are preserved verbatim and do not derail the run", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "claude", ["--model", "opus"]), {
      env: { FAKE_MODE: "malformed-events" },
    });
    equal(outcome.run.status, "completed");
    const events = readFileSync(outcome.run.artifacts.eventsPath, "utf8");
    includes(events, "{ this is not json");
    includes(events, "plain progress line");
    includes(outcome.run.finalMessage, "Applied the change");
  });
});

test("the watchdog kills a run that overruns and says so", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex", ["--timeout", "1s"]), {
      env: { FAKE_MODE: "sleep", FAKE_SLEEP_MS: "60000" },
      timeoutMs: 30_000,
    });
    equal(outcome.run.status, "timeout");
    equal(outcome.exitCode, 124);
    includes(outcome.run.error, "did not finish within --timeout 1s");
    // Whatever the agent managed before the kill is still on disk.
    includes(readFileSync(outcome.run.artifacts.finalPath, "utf8"), "partial work");
    ok(readFileSync(outcome.run.artifacts.eventsPath, "utf8").trim().length > 0);
  });
});

test("cancelling the dispatcher terminates the agent and preserves partial work", async () => {
  if (SKIP) return;
  await inWorld(async (world) => {
    const outDir = join(world.dir, "run out");
    const child = spawn(
      process.execPath,
      [DISPATCH, ...baseArgs(world, "codex")],
      {
        env: { PATH: world.bin, HOME: world.dir, XDG_CACHE_HOME: world.cache, FAKE_MODE: "sleep", FAKE_SLEEP_MS: "60000" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Register the exit listener up front: a child that dies early would
    // otherwise emit 'exit' before anything is listening, and the test would
    // wait forever for an event that already happened.
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    // Wait until the agent has actually started before cancelling.
    const eventsPath = join(outDir, "events.jsonl");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(eventsPath) && readFileSync(eventsPath, "utf8").trim()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill("SIGTERM");
    const { code: exitCode } = await exited;

    const run = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
    equal(run.status, "aborted");
    equal(run.signal, "SIGTERM");
    includes(run.error, "was killed by SIGTERM");
    ok(exitCode !== 0);
    includes(readFileSync(run.artifacts.finalPath, "utf8"), "partial work");
  });
});

// --- refusals -------------------------------------------------------------

test("a confirmed authentication failure stops the run before it starts", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex"), { env: { FAKE_MODE: "logged-out" } });
    equal(outcome.exitCode, 4);
    equal(outcome.run.status, "auth_failed");
    equal(outcome.run.command.args, null, "nothing was dispatched");
    includes(outcome.run.error, "not authenticated");
  });
});

test("a discovery-only agent is refused with its reason, not silently swapped", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "aider"));
    equal(outcome.exitCode, 2);
    equal(outcome.run, null, "a selection failure writes no result file");
    includes(outcome.stderr, "not installed");
    ok(!outcome.stderr.includes("using codex instead"));
  });
});

test("a rejected effort is refused rather than downgraded", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "claude", ["--model", "opus", "--effort", "extreme"]));
    equal(outcome.exitCode, 2);
    includes(outcome.stderr, "not available for this selection");
    includes(outcome.stderr, "low, medium, high, xhigh, max");
  });
});

test("an empty brief is a usage error and writes nothing", () => {
  if (SKIP) return;
  inWorld((world) => {
    const empty = join(world.dir, "empty.txt");
    writeFileSync(empty, "   \n", "utf8");
    const outcome = runDispatch(world, [
      "--agent", "codex",
      "--brief", empty,
      "--cd", world.work,
      "--out-dir", join(world.dir, "run out"),
    ]);
    equal(outcome.exitCode, 2);
    equal(outcome.run, null);
    includes(outcome.stderr, "empty brief");
  });
});

test("a malformed --timeout fails loudly instead of running unbounded", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex", ["--timeout", "soon"]));
    equal(outcome.exitCode, 2);
    includes(outcome.stderr, "--timeout \"soon\" is invalid");
  });
});

test("--session and --resume-last cannot both be given", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex", ["--session", "abc", "--resume-last"]));
    equal(outcome.exitCode, 2);
    includes(outcome.stderr, "mutually exclusive");
  });
});

// --- change accounting ----------------------------------------------------

test("changes made during the run are separated from work that was already there", () => {
  deepEqualish(
    describeChanges([" M src/already.ts"], [" M src/already.ts", "?? src/new.ts"]),
    {
      created: ["?? src/new.ts"],
      alsoModified: [" M src/already.ts"],
      attributionUncertain: true,
      gitAvailable: true,
    },
  );
  const clean = describeChanges([], ["?? src/new.ts"]);
  equal(clean.attributionUncertain, false);
  equal(clean.created.length, 1);
  equal(clean.note, null);
});

test("a rename is matched on its current path, not its original", () => {
  const changes = describeChanges([], ['R  "old name.ts" -> "new name.ts"']);
  equal(changes.created.length, 1);
});

test("no git means no attribution, and says so rather than claiming a clean tree", () => {
  const changes = describeChanges(null, null);
  equal(changes.gitAvailable, false);
  equal(changes.attributionUncertain, true);
  includes(changes.note, "no change can be attributed");
});

test("a run in a real repository reports what the agent touched", () => {
  if (SKIP) return;
  inWorld((world) => {
    // Pre-existing work the agent must not be credited or blamed for.
    writeFileSync(join(world.work, "tracked.txt"), "edited by the human\n", "utf8");
    const outcome = runDispatch(world, baseArgs(world, "codex"));
    equal(outcome.run.changes.gitAvailable, true);
    equal(outcome.run.changes.preexisting.length, 1);
    equal(outcome.run.changes.created.length, 0, "the fake agent edits nothing");
    equal(outcome.run.changes.alsoModified.length, 1);
    equal(outcome.run.changes.attributionUncertain, true);
    includes(outcome.run.changes.note, "already modified before the run");
  });
});

test("a directory outside git still produces a result", () => {
  if (SKIP) return;
  inWorld((world) => {
    const outcome = runDispatch(world, baseArgs(world, "codex", ["--skip-git-repo-check"]));
    equal(outcome.run.changes.gitAvailable, false);
    equal(outcome.run.status, "completed");
    ok(outcome.run.command.args.includes("--skip-git-repo-check"));
  }, { git: false });
});

/** Compare only the keys present in `expected`. */
function deepEqualish(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    equal(JSON.stringify(actual[key]), JSON.stringify(value), `changes.${key}`);
  }
}
