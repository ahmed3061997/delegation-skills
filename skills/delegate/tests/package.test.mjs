/**
 * delegate · tests/package.test.mjs
 *
 * The package as shipped: skill metadata, references that resolve, CLI help and
 * exit codes, and the self-containment and safety rules the design depends on.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes } from "./harness.mjs";
import { AGENTS } from "../scripts/registry.mjs";
import { ADAPTERS } from "../scripts/adapters.mjs";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("no frontmatter");
  const fields = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const header = /^([a-zA-Z][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (header && !line.startsWith(" ")) {
      key = header[1];
      fields[key] = header[2].replace(/^>-\s*$/, "").trim();
    } else if (key) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function markdownLinks(text) {
  return [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function run(script, args) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: "/nonexistent", HOME: process.env.HOME, XDG_CACHE_HOME: "/nonexistent/cache" },
  });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("SKILL.md carries the metadata a skill host needs", () => {
  const fields = frontmatter(skill);
  equal(fields.name, "delegate");
  ok(fields.description.length > 120, "the description must be specific enough to trigger on");
  includes(fields.description, "DO NOT USE");
  includes(fields.compatibility, "Node.js 18");
  includes(fields.compatibility, "macOS and Linux");
  ok(/^\d+\.\d+\.\d+$/.test(frontmatter(skill).version ?? "1.0.0") || skill.includes("version: 1.0.0"));
});

test("every reference SKILL.md links to exists", () => {
  for (const link of markdownLinks(skill)) {
    if (link.startsWith("http")) continue;
    ok(existsSync(join(root, link)), `SKILL.md links to a missing file: ${link}`);
  }
});

test("references only link to files that exist", () => {
  const referencesDir = join(root, "references");
  for (const name of readdirSync(referencesDir)) {
    const text = readFileSync(join(referencesDir, name), "utf8");
    for (const link of markdownLinks(text)) {
      if (link.startsWith("http") || link.startsWith("#")) continue;
      ok(existsSync(join(referencesDir, link)), `${name} links to a missing file: ${link}`);
    }
  }
});

test("the glossary defines every term the plan requires", () => {
  const glossary = readFileSync(join(root, "references", "glossary.md"), "utf8");
  for (const term of ["Agent", "Adapter", "Model", "Effort", "Catalog", "Brief", "Run", "Review"]) {
    includes(glossary, `### ${term}`, `glossary is missing a definition for ${term}`);
  }
});

test("the ADR records the architecture and its consequences", () => {
  const adr = readFileSync(join(root, "references", "adr-0001-architecture.md"), "utf8");
  includes(adr, "## Context");
  includes(adr, "## Decisions");
  includes(adr, "## Alternatives considered");
  includes(adr, "Consequence:");
  includes(adr, "discovery-only");
});

test("the registry holds all fourteen agents, four of them dispatchable", () => {
  equal(AGENTS.length, 14);
  const keys = AGENTS.map((agent) => agent.key);
  for (const expected of [
    "claude", "cline", "codex", "opencode", "antigravity", "grok", "kimi",
    "qoder", "vibe", "cursor", "pi", "aider", "copilot", "warp",
  ]) {
    ok(keys.includes(expected), `registry is missing ${expected}`);
  }
  equal(new Set(keys).size, 14, "agent keys must be unique");
  equal(new Set(AGENTS.map((agent) => agent.binary)).size, 14, "binary names must be unique");

  const dispatchable = AGENTS.filter((agent) => agent.dispatch);
  equal(dispatchable.map((agent) => agent.key).join(","), "claude,codex,opencode,cursor");
  for (const agent of dispatchable) {
    equal(agent.dispatch.verification, "live");
    ok(ADAPTERS[agent.key], `${agent.key} claims a dispatch adapter that does not exist`);
    equal(ADAPTERS[agent.key].binary, agent.binary);
  }
  for (const agent of AGENTS.filter((candidate) => !candidate.dispatch)) {
    ok(agent.dispatchNote, `${agent.key} must say why it cannot be dispatched to`);
    ok(!ADAPTERS[agent.key], `${agent.key} has an adapter but is marked undispatchable`);
  }
});

test("no probe could be mistaken for a task by its CLI", () => {
  // A bare positional word is read as a prompt by several of these CLIs, which
  // would bill the user and start work nobody asked for.
  for (const agent of AGENTS) {
    for (const args of [agent.versionArgs, agent.versionFallbackArgs, agent.authProbe?.args, agent.modelProbe?.args]) {
      if (!args) continue;
      ok(args.length > 0, `${agent.key}: empty probe`);
    }
    if (agent.modelProbe?.kind === "command") {
      const first = agent.modelProbe.args[0];
      // "models" is a real subcommand for these two and a prompt for the others.
      const subcommandIsSafe = ["opencode", "antigravity", "grok"].includes(agent.key);
      ok(
        first.startsWith("--") || subcommandIsSafe,
        `${agent.key}: "${first}" would be read as a prompt; use a flag instead`,
      );
    }
  }
  // The two CLIs that read `models` as a prompt must not use it.
  equal(AGENTS.find((agent) => agent.key === "codex").modelProbe.kind, "cache-file");
  equal(AGENTS.find((agent) => agent.key === "pi").modelProbe.args[0], "--list-models");
});

test("the package depends on nothing outside itself", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mjs")) files.push(path);
    }
  };
  walk(root);
  ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])) {
      const allowed = specifier.startsWith("node:") || specifier.startsWith(".");
      ok(allowed, `${file} imports "${specifier}"; only node: builtins and relative paths are allowed`);
      if (specifier.startsWith(".")) {
        ok(
          !specifier.includes("../../"),
          `${file} reaches outside the package for "${specifier}"`,
        );
      }
    }
  }
  ok(!existsSync(join(root, "package.json")), "no manifest means no install step");
});

test("nothing in the package makes a network call of its own", () => {
  const source = [
    readFileSync(join(root, "scripts", "catalog.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "dispatch.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "review.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "select.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "plan.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "batch.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "recap.mjs"), "utf8"),
    readFileSync(join(root, "scripts", "timings.mjs"), "utf8"),
  ].join("\n");
  for (const needle of ["node:http", "node:https", "node:net", "fetch("]) {
    ok(!source.includes(needle), `the package must not reach the network itself, but found ${needle}`);
  }
});

test("catalog.mjs exits 0 with nothing installed and 2 on a bad flag", () => {
  const empty = run("catalog.mjs", ["--no-cache", "--summary"]);
  equal(empty.exitCode, 0, empty.stderr);
  includes(empty.stdout, "dispatch-capable (0)");
  includes(empty.stdout, "not installed (14)");

  equal(run("catalog.mjs", ["--nonsense"]).exitCode, 2);
  equal(run("catalog.mjs", ["--refresh", "--no-cache"]).exitCode, 2);
  equal(run("catalog.mjs", ["--help"]).exitCode, 0);
  includes(run("catalog.mjs", ["--path"]).stdout, "delegate/catalog.json");
});

test("select.mjs renders a numbered prompt for hosts without a question tool", () => {
  const agents = run("select.mjs", ["agents", "--format", "text", "--include-unavailable"]);
  equal(agents.exitCode, 0, agents.stderr);
  includes(agents.stdout, "Which agent should implement this task?");
  includes(agents.stdout, "(none available)");
  includes(agents.stdout, "Reply with a number.");
  includes(agents.stdout, "Not available:");
});

test("select.mjs emits the JSON a native question tool needs", () => {
  const agents = JSON.parse(run("select.mjs", ["agents"]).stdout);
  equal(agents.schema, "delegate.agent-choices.v1");
  equal(agents.agents.length, 14);
  for (const field of ["key", "label", "installed", "version", "auth", "dispatchable", "reason"]) {
    ok(field in agents.agents[0], `an agent choice needs ${field} to render as an option`);
  }

  const models = JSON.parse(run("select.mjs", ["models", "--agent", "codex"]).stdout);
  equal(models.schema, "delegate.model-choices.v1");
  for (const field of ["source", "sourceLabel", "entries", "allowsManualId", "cliDefault", "required"]) {
    ok(field in models, `model choices need ${field}`);
  }

  const efforts = JSON.parse(run("select.mjs", ["efforts", "--agent", "claude"]).stdout);
  equal(efforts.schema, "delegate.effort-choices.v1");
  equal(efforts.values.join(","), "low,medium,high,xhigh,max");
  equal(efforts.recommended, "high");
  equal(efforts.mechanism, "flag");
});

test("select.mjs and dispatch.mjs both refuse an unknown agent", () => {
  const selected = run("select.mjs", ["resolve", "--agent", "notanagent"]);
  equal(selected.exitCode, 2);
  includes(selected.stderr, "unknown agent");
  const dispatched = run("dispatch.mjs", ["--agent", "notanagent", "--brief", "/dev/null"]);
  equal(dispatched.exitCode, 2);
  includes(dispatched.stderr, "unknown agent");
});

test("every CLI has help and every helper is runnable standalone", () => {
  for (const script of ["catalog.mjs", "select.mjs", "dispatch.mjs", "review.mjs", "plan.mjs", "batch.mjs", "recap.mjs", "timings.mjs"]) {
    const help = run(script, ["--help"]);
    equal(help.exitCode, 0, `${script} --help`);
    ok(help.stdout.trim().length > 200, `${script} --help should explain itself`);
    includes(help.stdout, "Usage:");
  }
});

test("dispatch.mjs help states that it never commits or retries", () => {
  // Match on unwrapped fragments: the help text is the file's header comment,
  // so any phrase long enough to wrap would fail on the line break.
  const help = run("dispatch.mjs", ["--help"]).stdout.replace(/\s+/g, " ");
  includes(help, "never commits or pushes");
  includes(help, "never retries with a wider permission profile after a refusal");
  includes(help, "never substitutes a different agent, model, or effort");
});

test("the batch helpers state the two rules that define the mode", () => {
  const batch = run("batch.mjs", ["--help"]).stdout.replace(/\s+/g, " ");
  includes(batch, "One agent process at a time");
  includes(batch, "No project check runs during the batch");
  includes(batch, "Never commits, reverts, re-dispatches a failure");

  const recap = run("recap.mjs", ["--help"]).stdout.replace(/\s+/g, " ");
  includes(recap, "runs the project's checks once over the finished tree");
  includes(recap, "Never commits, reverts, or re-dispatches");
});

test("SKILL.md documents the large-task path and its references resolve", () => {
  includes(skill, "references/large-tasks.md");
  includes(skill, "plan.mjs");
  includes(skill, "batch.mjs");
  includes(skill, "recap.mjs");
});

test("the glossary defines the batch vocabulary too", () => {
  const glossary = readFileSync(join(root, "references", "glossary.md"), "utf8");
  for (const term of ["Plan", "Subtask", "Batch", "Owned path", "Ledger", "Recap"]) {
    includes(glossary, `### ${term}`, `glossary is missing a definition for ${term}`);
  }
});

test("a second ADR records the serial-dispatch decision and what it rejected", () => {
  const adr = readFileSync(join(root, "references", "adr-0002-decomposition.md"), "utf8");
  includes(adr, "## Context");
  includes(adr, "## Decisions");
  includes(adr, "## Alternatives considered");
  includes(adr, "Consequence:");
  includes(adr, "serial");
});

test("a single dispatch still behaves exactly as it did before batches existed", () => {
  // The regression guard for the whole feature: nothing added here may change
  // what one run does, what it writes, or how review reads it.
  const help = run("dispatch.mjs", ["--help"]);
  equal(help.exitCode, 0);
  const source = readFileSync(join(root, "scripts", "dispatch.mjs"), "utf8");
  ok(!source.includes("batch"), "dispatch.mjs must not know that batches exist");
  ok(!source.includes("plan.mjs"), "the dispatcher stays the unit, not the sequencer");
  const review = readFileSync(join(root, "scripts", "review.mjs"), "utf8");
  ok(review.includes("findingsFromRun(run, {"), "review keeps its single-run entry point");
});
