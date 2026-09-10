/**
 * delegate · adapters.mjs
 *
 * One adapter per dispatchable agent, all behind the same four-method surface:
 *
 *   profile(opts)      → the permission profile this run will use, by name
 *   prepare(ctx)       → files the launch needs (Claude's inline settings)
 *   buildArgv(ctx)     → the exact argument array to spawn
 *   normalizer()       → folds the agent's event stream into one result shape
 *
 * Everything agent-specific lives here. dispatch.mjs knows about process
 * lifecycle, artifacts, and git; it knows nothing about any particular CLI.
 *
 * Two rules hold across every adapter:
 *
 *  1. The brief travels on stdin, never in argv. Briefs are multi-line and
 *     XML-tagged; putting one in argv invites quoting bugs on every platform.
 *  2. The permission profile is explicit and is passed on every invocation,
 *     including resumed turns — never inherited from a session and never
 *     escalated after a refusal. There is no permission-bypass retry anywhere
 *     in this skill.
 *
 * Only adapters exercised against a locally installed CLI appear here; see
 * registry.mjs for why the other ten entries are discovery-only.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Claude's shell tool differs by platform, and it appears in deny rules. */
function claudeShellTool() {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

/**
 * Fold a stream of parsed events into one final answer.
 * `onEvent` sees parsed JSON objects; `onLine` sees every raw stdout line so a
 * non-JSON progress line is still preserved in events.jsonl by the caller.
 */
function makeNormalizer({ onEvent, finish }) {
  const state = { sessionId: null, reportedModel: null, agentError: null, resultSubtype: null };
  return {
    state,
    accept(event) {
      try {
        onEvent(state, event);
      } catch {
        // A single malformed event must not abort a run that is otherwise fine;
        // the raw line is already on disk in events.jsonl.
      }
    },
    finish(finalFileText) {
      return { ...state, finalMessage: finish(state, finalFileText) };
    },
  };
}

/** Cursor and Claude both use Anthropic-style stream-json envelopes. */
function readStreamJsonSessionId(event) {
  return (
    event.session_id ??
    event.sessionId ??
    (event.session && (event.session.id ?? event.session.session_id)) ??
    null
  );
}

export const ADAPTERS = Object.freeze({
  // -------------------------------------------------------------------------
  claude: {
    key: "claude",
    binary: "claude",
    winShell: true,
    supports: { session: true, resumeLast: true, readOnly: true },

    profile(opts) {
      return opts.readOnly
        ? {
            name: "plan-read-only",
            description:
              "Claude plan mode with only Read, Glob, and Grep exposed: no edit, write, shell, MCP, or skill tool.",
          }
        : {
            name: "accept-edits",
            description:
              "Claude acceptEdits mode with Read, Glob, Grep, Edit, Write, and the platform shell. MCP discovery and skills are disabled; git commit and git push are denied by an inline settings file, as is re-entering this skill.",
          };
    },

    prepare({ runDir, opts }) {
      // `--settings` accepts a path or a JSON string; a file keeps the exact
      // grant auditable as a run artifact.
      const shell = claudeShellTool();
      const settings = {
        disableClaudeAiConnectors: true,
        permissions: {
          deny: opts.readOnly
            ? []
            : [
                // Single-wildcard forms also catch `git -C <dir> push`.
                `${shell}(git commit *)`,
                `${shell}(git * commit *)`,
                `${shell}(git * commit)`,
                `${shell}(git push *)`,
                `${shell}(git * push *)`,
                `${shell}(git * push)`,
                // The orchestrator owns commits, and a child must not recurse
                // back into a delegation.
                `${shell}(claude *)`,
                `${shell}(*delegate*)`,
              ],
        },
      };
      const settingsPath = join(runDir, "settings.json");
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      return { settingsPath, artifacts: { settingsPath } };
    },

    buildArgv({ opts, prepared }) {
      const argv = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--disallowedTools", "mcp__*",
        "--disable-slash-commands",
        "--settings", prepared.settingsPath,
      ];
      if (opts.readOnly) {
        argv.push("--tools", "Read,Glob,Grep", "--permission-mode", "plan");
      } else {
        argv.push("--tools", `Read,Glob,Grep,Edit,Write,${claudeShellTool()}`, "--permission-mode", "acceptEdits");
      }
      // Resumed turns get the profile again rather than trusting the session.
      if (opts.resumeLast) argv.push("--continue");
      else if (opts.session) argv.push("--resume", opts.session);
      if (opts.model) argv.push("--model", opts.model);
      if (opts.effort) argv.push("--effort", opts.effort);
      return argv;
    },

    normalizer() {
      let finalMessage = "";
      return makeNormalizer({
        onEvent(state, event) {
          const sessionId = readStreamJsonSessionId(event);
          if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;
          if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
            state.reportedModel = event.model;
          }
          if (event.type !== "result") return;
          state.resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
          if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
            state.agentError = `Claude reported result subtype "${event.subtype ?? "unknown"}"`;
          }
          if (typeof event.result === "string") finalMessage = event.result;
        },
        finish: () => finalMessage,
      });
    },
  },

  // -------------------------------------------------------------------------
  codex: {
    key: "codex",
    binary: "codex",
    winShell: true,
    supports: { session: true, resumeLast: true, readOnly: true },
    /** Codex writes its last message to a file we name, so no assembly is needed. */
    finalMessageFromFile: true,

    profile(opts) {
      return opts.readOnly
        ? {
            name: "sandbox-read-only",
            description: "Codex's read-only sandbox: the model can read the workspace but not write to it.",
          }
        : {
            name: "sandbox-workspace-write",
            description:
              "Codex's workspace-write sandbox: writes are confined to the working root. No approval bypass and no full-access escalation.",
          };
    },

    prepare() {
      return { artifacts: {} };
    },

    buildArgv({ opts, run }) {
      const argv = ["exec"];
      const resuming = Boolean(opts.session || opts.resumeLast);
      const sandbox = opts.readOnly ? "read-only" : "workspace-write";
      // Shared exec options are accepted before the resume subcommand, and the
      // sandbox is restated on resumed turns rather than inherited.
      if (resuming) argv.push("-s", sandbox);
      if (opts.session) argv.push("resume", opts.session);
      else if (opts.resumeLast) argv.push("resume", "--last");
      argv.push("--json", "-o", run.finalPath);
      if (!resuming) argv.push("-s", sandbox);
      if (opts.model) argv.push("-m", opts.model);
      if (opts.effort) argv.push("-c", `model_reasoning_effort=${opts.effort}`);
      if (opts.skipGitRepoCheck) argv.push("--skip-git-repo-check");
      argv.push("-"); // read the prompt from stdin
      return argv;
    },

    normalizer() {
      return makeNormalizer({
        onEvent(state, event) {
          const threadId =
            event.thread_id ??
            event.threadId ??
            (event.thread && (event.thread.thread_id ?? event.thread.id)) ??
            null;
          if (typeof threadId === "string" && threadId) state.sessionId = threadId;
        },
        finish: (_state, finalFileText) => finalFileText ?? "",
      });
    },
  },

  // -------------------------------------------------------------------------
  opencode: {
    key: "opencode",
    binary: "opencode",
    winShell: true,
    supports: { session: true, resumeLast: true, readOnly: true },

    profile(opts) {
      return opts.readOnly
        ? {
            name: "agent-plan",
            description:
              "OpenCode's plan agent: review and diagnosis without edits. --auto is deliberately withheld so nothing can auto-approve an edit permission.",
          }
        : {
            name: "agent-build-auto",
            description:
              "OpenCode's build agent with --auto, which auto-approves permissions that are not explicitly denied — required for a headless run, since no one can answer a prompt. The orchestrator's diff review is the check on it.",
          };
    },

    prepare() {
      return { artifacts: {} };
    },

    buildArgv({ opts }) {
      const argv = ["run", "--format", "json"];
      if (opts.session) argv.push("--session", opts.session);
      else if (opts.resumeLast) argv.push("--continue");
      argv.push("--agent", opts.readOnly ? "plan" : "build");
      if (opts.model) argv.push("--model", opts.model);
      if (opts.effort) argv.push("--variant", opts.effort);
      // Never on a plan run: --auto would approve the plan agent's ask-gated
      // permissions and let a "read-only" review edit the tree.
      if (!opts.readOnly) argv.push("--auto");
      // No message positional: the brief is piped on stdin.
      return argv;
    },

    normalizer() {
      // Assistant text arrives as `type:"text"` events; each part id is
      // re-emitted as it grows, so keep first-seen order and last-seen text.
      const parts = new Map();
      const order = [];
      return makeNormalizer({
        onEvent(state, event) {
          const sessionId = event.sessionID ?? event.session_id ?? null;
          if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;
          if (event.type === "text" && event.part && event.part.type === "text") {
            const id = event.part.id ?? `#${order.length}`;
            if (!parts.has(id)) order.push(id);
            parts.set(id, event.part.text ?? "");
          }
          if (event.type === "step_finish" && typeof event.part?.modelID === "string") {
            state.reportedModel = event.part.modelID;
          }
        },
        finish: () => order.map((id) => parts.get(id)).join("").trim(),
      });
    },
  },

  // -------------------------------------------------------------------------
  cursor: {
    key: "cursor",
    binary: "cursor-agent",
    winShell: true,
    supports: { session: true, resumeLast: true, readOnly: true },

    profile(opts) {
      return opts.readOnly
        ? {
            name: "mode-plan",
            description:
              "Cursor's plan mode: read-only analysis and planning, no edits and no --force. Cursor enforces the mode; the relay also reports the git delta so a violation would be visible.",
          }
        : {
            name: "force-write",
            description:
              "Cursor write mode with --force, so commands run without an approval prompt no one can answer. --trust is always passed, so point --cd only at a repository you trust.",
          };
    },

    prepare() {
      return { artifacts: {} };
    },

    /**
     * Cursor has no effort flag. `cursor-agent --help` documents effort as a
     * bracket parameter on the model id, which is why select.mjs requires an
     * explicit model before it will accept --effort for this agent.
     */
    buildArgv({ opts }) {
      const argv = ["--print", "--output-format", "stream-json", "--trust"];
      if (opts.readOnly) argv.push("--mode", "plan");
      else argv.push("--force");
      if (opts.model) {
        argv.push("--model", opts.effort ? `${opts.model}[effort=${opts.effort}]` : opts.model);
      }
      if (opts.session) argv.push("--resume", opts.session);
      else if (opts.resumeLast) argv.push("--continue");
      return argv;
    },

    normalizer() {
      const chunks = [];
      let resultMessage = "";
      return makeNormalizer({
        onEvent(state, event) {
          const sessionId = readStreamJsonSessionId(event);
          if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;
          if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
            state.reportedModel = event.model;
          }
          if (event.type === "assistant" && Array.isArray(event.message?.content)) {
            for (const part of event.message.content) {
              if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
            }
          }
          if (event.type === "result") {
            if (typeof event.result === "string") resultMessage = event.result;
            if (event.is_error === true) state.agentError = "cursor-agent reported is_error: true in its result event";
          }
        },
        // Prefer the result event's own report; fall back to assembled text.
        finish: () => (resultMessage.trim() ? resultMessage : chunks.join("\n\n")),
      });
    },
  },
});

/** @returns {(typeof ADAPTERS)[keyof typeof ADAPTERS] | null} */
export function findAdapter(key) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, key) ? ADAPTERS[key] : null;
}
