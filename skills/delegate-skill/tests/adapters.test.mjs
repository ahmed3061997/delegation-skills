/**
 * delegate-skill · tests/adapters.test.mjs
 *
 * Command construction and result normalization, per adapter.
 *
 * Argv is asserted flag by flag because these strings are the whole contract
 * with each CLI: a wrong flag is a wrong permission profile, and a dropped one
 * is a silently different run from the one the user chose.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, ok, equal, includes } from "./harness.mjs";
import { ADAPTERS, findAdapter } from "../scripts/adapters.mjs";

const shellTool = process.platform === "win32" ? "PowerShell" : "Bash";

function argvFor(key, opts = {}, run = { finalPath: "/tmp/run/final.txt" }, prepared = { settingsPath: "/tmp/run/settings.json" }) {
  return findAdapter(key).buildArgv({
    opts: { model: null, effort: null, readOnly: false, session: null, resumeLast: false, skipGitRepoCheck: false, ...opts },
    run,
    prepared,
  });
}

/** Index of `flag` in argv, or -1. Asserting on order matters for codex resume. */
const at = (argv, flag) => argv.indexOf(flag);

test("every dispatchable adapter answers the whole interface", () => {
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    equal(adapter.key, key);
    ok(typeof adapter.binary === "string" && adapter.binary.length > 0);
    ok(typeof adapter.profile === "function", `${key}.profile`);
    ok(typeof adapter.prepare === "function", `${key}.prepare`);
    ok(typeof adapter.buildArgv === "function", `${key}.buildArgv`);
    ok(typeof adapter.normalizer === "function", `${key}.normalizer`);
    ok(adapter.supports && typeof adapter.supports.readOnly === "boolean", `${key}.supports`);
  }
});

test("no adapter ever puts the brief in argv", () => {
  const brief = "GOAL: do the thing\nCONSTRAINTS: do not commit";
  for (const key of Object.keys(ADAPTERS)) {
    const argv = argvFor(key, { model: "m", effort: "high" });
    ok(!argv.some((arg) => arg.includes(brief)), `${key} must send the brief on stdin`);
    ok(!argv.some((arg) => arg.includes("GOAL")), `${key} must send the brief on stdin`);
  }
});

// --- claude ---------------------------------------------------------------

test("claude write profile pins tools, permission mode, and an explicit settings file", () => {
  const argv = argvFor("claude", { model: "opus", effort: "high" });
  includes(argv.join(" "), "-p --output-format stream-json --verbose");
  equal(argv[at(argv, "--permission-mode") + 1], "acceptEdits");
  equal(argv[at(argv, "--tools") + 1], `Read,Glob,Grep,Edit,Write,${shellTool}`);
  equal(argv[at(argv, "--settings") + 1], "/tmp/run/settings.json");
  equal(argv[at(argv, "--disallowedTools") + 1], "mcp__*");
  ok(argv.includes("--strict-mcp-config"));
  ok(argv.includes("--disable-slash-commands"));
  equal(argv[at(argv, "--model") + 1], "opus");
  equal(argv[at(argv, "--effort") + 1], "high");
});

test("claude read-only profile exposes no write, shell, or edit tool", () => {
  const argv = argvFor("claude", { readOnly: true });
  equal(argv[at(argv, "--permission-mode") + 1], "plan");
  equal(argv[at(argv, "--tools") + 1], "Read,Glob,Grep");
  ok(!argv.join(" ").includes("Write"));
  ok(!argv.join(" ").includes("Edit"));
  ok(!argv.join(" ").includes(shellTool));
  equal(findAdapter("claude").profile({ readOnly: true }).name, "plan-read-only");
});

test("claude's settings file denies commit, push, and re-entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegate-prepare-"));
  try {
    const prepared = findAdapter("claude").prepare({ runDir: dir, opts: { readOnly: false } });
    const settings = JSON.parse(readFileSync(prepared.settingsPath, "utf8"));
    const deny = settings.permissions.deny.join(" ");
    includes(deny, "git commit");
    includes(deny, "git push");
    includes(deny, "delegate-skill");
    equal(settings.disableClaudeAiConnectors, true);
    equal(prepared.artifacts.settingsPath, prepared.settingsPath);

    // A read-only run has nothing to deny: it cannot run a shell at all.
    const readOnly = findAdapter("claude").prepare({ runDir: dir, opts: { readOnly: true } });
    equal(JSON.parse(readFileSync(readOnly.settingsPath, "utf8")).permissions.deny.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude normalizes a stream-json run into session, model, and final report", () => {
  const normalizer = findAdapter("claude").normalizer();
  normalizer.accept({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5" });
  normalizer.accept({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } });
  normalizer.accept({ type: "result", subtype: "success", is_error: false, result: "Done: added the flag." });
  const folded = normalizer.finish(null);
  equal(folded.sessionId, "sess-1");
  equal(folded.reportedModel, "claude-opus-5");
  equal(folded.finalMessage, "Done: added the flag.");
  equal(folded.agentError, null);
});

test("claude reports an error result even when the process exits cleanly", () => {
  const normalizer = findAdapter("claude").normalizer();
  normalizer.accept({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });
  const folded = normalizer.finish(null);
  includes(folded.agentError, "error_max_turns");
});

// --- codex ----------------------------------------------------------------

test("codex builds a workspace-write exec with the prompt on stdin", () => {
  const argv = argvFor("codex", { model: "gpt-5.5", effort: "high" });
  equal(argv[0], "exec");
  equal(argv[at(argv, "-s") + 1], "workspace-write");
  equal(argv[at(argv, "-o") + 1], "/tmp/run/final.txt");
  equal(argv[at(argv, "-m") + 1], "gpt-5.5");
  equal(argv[at(argv, "-c") + 1], "model_reasoning_effort=high");
  ok(argv.includes("--json"));
  equal(argv[argv.length - 1], "-", "the trailing dash is what makes codex read stdin");
});

test("codex read-only uses its own sandbox rather than a convention", () => {
  const argv = argvFor("codex", { readOnly: true });
  equal(argv[at(argv, "-s") + 1], "read-only");
  equal(findAdapter("codex").profile({ readOnly: true }).name, "sandbox-read-only");
});

test("codex restates the sandbox before the resume subcommand", () => {
  const argv = argvFor("codex", { session: "01999e6a-1111", readOnly: true });
  // Shared exec options must precede `resume`, or codex rejects them.
  ok(at(argv, "-s") < at(argv, "resume"), "sandbox must be restated before resume");
  equal(argv[at(argv, "resume") + 1], "01999e6a-1111");
  const last = argvFor("codex", { resumeLast: true });
  equal(last[at(last, "resume") + 1], "--last");
});

test("codex takes its final report from the file it was told to write", () => {
  const adapter = findAdapter("codex");
  equal(adapter.finalMessageFromFile, true);
  const normalizer = adapter.normalizer();
  normalizer.accept({ id: "0", msg: { type: "task_started" }, thread_id: "thread-9" });
  const folded = normalizer.finish("Refactored the parser.");
  equal(folded.sessionId, "thread-9");
  equal(folded.finalMessage, "Refactored the parser.");
});

// --- opencode -------------------------------------------------------------

test("opencode maps the write profile to the build agent with --auto", () => {
  const argv = argvFor("opencode", { model: "anthropic/claude-sonnet-5", effort: "high" });
  equal(argv.slice(0, 4).join(" "), "run --format json --agent");
  equal(argv[at(argv, "--agent") + 1], "build");
  equal(argv[at(argv, "--model") + 1], "anthropic/claude-sonnet-5");
  equal(argv[at(argv, "--variant") + 1], "high", "opencode calls effort a variant");
  ok(argv.includes("--auto"));
});

test("opencode read-only uses the plan agent and never --auto", () => {
  const argv = argvFor("opencode", { readOnly: true, model: "openai/gpt-5.2" });
  equal(argv[at(argv, "--agent") + 1], "plan");
  ok(!argv.includes("--auto"), "--auto would let a plan run approve its way into edits");
});

test("opencode assembles streamed text parts, last write per part id winning", () => {
  const normalizer = findAdapter("opencode").normalizer();
  normalizer.accept({ type: "session_start", sessionID: "ses_1" });
  normalizer.accept({ type: "text", part: { id: "p1", type: "text", text: "Reading" } });
  normalizer.accept({ type: "text", part: { id: "p1", type: "text", text: "Reading the module." } });
  normalizer.accept({ type: "text", part: { id: "p2", type: "text", text: " Then patched it." } });
  normalizer.accept({ type: "step_finish", part: { type: "step_finish", modelID: "anthropic/claude-sonnet-5" } });
  const folded = normalizer.finish(null);
  equal(folded.sessionId, "ses_1");
  equal(folded.finalMessage, "Reading the module. Then patched it.");
  equal(folded.reportedModel, "anthropic/claude-sonnet-5");
});

// --- cursor ---------------------------------------------------------------

test("cursor write mode passes --force and always --trust", () => {
  const argv = argvFor("cursor", { model: "gpt-5.2" });
  includes(argv.join(" "), "--print --output-format stream-json --trust");
  ok(argv.includes("--force"));
  equal(argv[at(argv, "--model") + 1], "gpt-5.2");
});

test("cursor read-only uses plan mode and drops --force", () => {
  const argv = argvFor("cursor", { readOnly: true });
  equal(argv[at(argv, "--mode") + 1], "plan");
  ok(!argv.includes("--force"));
});

test("cursor carries effort as the documented bracket parameter on the model", () => {
  const argv = argvFor("cursor", { model: "gpt-5.2", effort: "high" });
  equal(argv[at(argv, "--model") + 1], "gpt-5.2[effort=high]");
  // Without an effort the id is passed through untouched.
  equal(argvFor("cursor", { model: "gpt-5.2" })[at(argvFor("cursor", { model: "gpt-5.2" }), "--model") + 1], "gpt-5.2");
});

test("cursor prefers its result event over assembled assistant text", () => {
  const normalizer = findAdapter("cursor").normalizer();
  normalizer.accept({ type: "system", subtype: "init", session_id: "chat_1", model: "gpt-5.2" });
  normalizer.accept({ type: "assistant", message: { content: [{ type: "text", text: "chatter" }] } });
  normalizer.accept({ type: "result", subtype: "success", is_error: false, result: "Final answer." });
  equal(normalizer.finish(null).finalMessage, "Final answer.");

  const noResult = findAdapter("cursor").normalizer();
  noResult.accept({ type: "assistant", message: { content: [{ type: "text", text: "only chatter" }] } });
  equal(noResult.finish(null).finalMessage, "only chatter");
});

test("a malformed event is absorbed, not fatal", () => {
  for (const key of Object.keys(ADAPTERS)) {
    const normalizer = findAdapter(key).normalizer();
    normalizer.accept(null);
    normalizer.accept({ type: "text", part: null });
    normalizer.accept({ type: "assistant", message: { content: "not an array" } });
    ok(normalizer.finish(null), `${key} survives malformed events`);
  }
});
