#!/usr/bin/env node
/**
 * delegate-skill · tests/fake-agents/fake-agent.mjs
 *
 * A stand-in for a real agent CLI, so the dispatch lifecycle can be tested
 * end-to-end — real process, real stdin, real signals, real exit codes — with no
 * network call and no paid run.
 *
 * It answers the same probes the catalog uses and emits the same event shapes
 * the real CLIs emit (see tests/fixtures/events for the recorded originals).
 *
 * Behaviour is driven by the environment so one binary covers every case:
 *   FAKE_MODE        ok | logged-out | garbage | silent | sleep | crash | malformed-events
 *   FAKE_EXIT        exit code for the dispatch path (default 0, or 1 for crash)
 *   FAKE_SLEEP_MS    how long the sleep/crash modes stay alive (default 60000)
 *   FAKE_STDIN_OUT   copy the brief received on stdin to this path
 *   FAKE_VERSION     version string to report
 */

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const asIndex = argv.indexOf("--as");
const agent = asIndex === -1 ? "codex" : argv[asIndex + 1];
const args = asIndex === -1 ? argv : [...argv.slice(0, asIndex), ...argv.slice(asIndex + 2)];

const mode = process.env.FAKE_MODE || "ok";
const version = process.env.FAKE_VERSION || "9.9.9-fake";
const out = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

if (args.includes("--version") || args[0] === "version" || args[0] === "changelog") {
  if (mode === "garbage") {
    // A CLI whose version output is not a version: discovery must survive it.
    out("\n\nWARN: could not determine build metadata\n");
    process.exit(0);
  }
  out(agent === "antigravity" ? `${version}: changelog` : version);
  process.exit(0);
}

const joined = args.join(" ");

if (joined === "auth status") {
  // Real `claude auth status` also returns email and organization ids; the
  // catalog must read only loggedIn, so the fixture includes the rest.
  if (mode === "garbage") {
    out("not json at all");
    process.exit(0);
  }
  out(
    JSON.stringify(
      {
        loggedIn: mode !== "logged-out",
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "someone@example.com",
        orgId: "00000000-0000-0000-0000-000000000000",
        orgName: "Example Org",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (joined === "login status") {
  // codex reports login state on stderr.
  process.stderr.write(mode === "logged-out" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(0);
}

if (joined === "auth list") {
  if (mode !== "logged-out") out("●  anthropic  oauth\n   openai     api");
  else out("no providers configured");
  process.exit(0);
}

if (joined === "status") {
  out(mode === "logged-out" ? "Not logged in. Run cursor-agent login." : "Logged in as someone@example.com");
  process.exit(0);
}

if (joined === "models" || joined === "--list-models") {
  if (mode === "garbage") {
    process.stderr.write("error: failed to reach the model service\n");
    process.exit(3);
  }
  if (agent === "cursor") {
    out(
      [
        "Available models",
        "",
        "auto - Auto (default)",
        "gpt-5.2 - GPT-5.2",
        "gpt-5.3-codex-high - Codex 5.3 High",
        "claude-opus-5-thinking-high - Claude Opus 5 1M Thinking",
        "Tip: pass --model to pick one",
      ].join("\n"),
    );
  } else {
    out(["opencode-go/glm-5.3", "anthropic/claude-sonnet-5", "openai/gpt-5.2"].join("\n"));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

let brief = "";
try {
  brief = readFileSync(0, "utf8");
} catch {
  brief = "";
}
if (process.env.FAKE_STDIN_OUT) writeFileSync(process.env.FAKE_STDIN_OUT, brief, "utf8");

const outputFileIndex = args.indexOf("-o");
const outputFile = outputFileIndex === -1 ? null : args[outputFileIndex + 1];
const report = `Applied the change described in the brief (${brief.trim().split("\n")[0] ?? ""}).`;

const streams = {
  claude: [
    { type: "system", subtype: "init", session_id: "5f2c9d1e-0000-4000-8000-abcdef123456", model: "claude-opus-5" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the module." }] }, session_id: "5f2c9d1e-0000-4000-8000-abcdef123456" },
    { type: "result", subtype: "success", is_error: false, result: report, session_id: "5f2c9d1e-0000-4000-8000-abcdef123456", num_turns: 4 },
  ],
  codex: [
    { id: "0", msg: { type: "task_started" }, thread_id: "01999e6a-1111-7000-8000-0123456789ab" },
    { type: "item.completed", item: { type: "agent_message", text: report }, thread_id: "01999e6a-1111-7000-8000-0123456789ab" },
    { type: "turn.completed", thread_id: "01999e6a-1111-7000-8000-0123456789ab" },
  ],
  cursor: [
    { type: "system", subtype: "init", session_id: "chat_9f8e7d", model: "gpt-5.2", cwd: process.cwd() },
    { type: "assistant", message: { content: [{ type: "text", text: "Patched the handler." }] } },
    { type: "result", subtype: "success", is_error: false, result: report, session_id: "chat_9f8e7d" },
  ],
  opencode: [
    { type: "session_start", sessionID: "ses_7f3a2b1c" },
    { type: "text", part: { id: "prt_1", type: "text", text: "Reading the module." } },
    { type: "text", part: { id: "prt_1", type: "text", text: report } },
    { type: "step_finish", part: { type: "step_finish", cost: 0.0134, modelID: "anthropic/claude-sonnet-5" } },
  ],
};

const events = streams[agent] ?? streams.codex;

if (mode === "silent") {
  // Exit 0 having produced nothing: the "missing output" case.
  process.exit(0);
}

if (mode === "sleep" || mode === "crash") {
  // Emit the opening event, then stay alive so a watchdog or a cancellation has
  // something real to kill. Partial artifacts must survive it.
  out(JSON.stringify(events[0]));
  if (outputFile) writeFileSync(outputFile, "partial work in progress", "utf8");
  const sleepMs = Number.parseInt(process.env.FAKE_SLEEP_MS || "60000", 10);
  setTimeout(() => {
    process.exit(Number.parseInt(process.env.FAKE_EXIT || (mode === "crash" ? "1" : "0"), 10));
  }, sleepMs);
} else {
  for (const event of events) out(JSON.stringify(event));
  if (mode === "malformed-events") {
    out("{ this is not json");
    out("plain progress line, no braces");
  }
  if (outputFile) writeFileSync(outputFile, report, "utf8");
  const exitCode = Number.parseInt(process.env.FAKE_EXIT || "0", 10);
  if (exitCode !== 0) process.stderr.write(`fake-agent: failing on purpose with exit ${exitCode}\n`);
  process.exit(exitCode);
}
