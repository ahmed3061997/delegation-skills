#!/usr/bin/env node
/**
 * delegate-skill · dispatch.mjs
 *
 * Send a self-contained brief to a selected agent CLI, capture the run, and
 * publish one structured result the orchestrator can review.
 *
 * Usage:
 *   node dispatch.mjs --agent <key> --brief <file> [options]
 *   cat brief.txt | node dispatch.mjs --agent <key> [options]
 *
 * Options:
 *   --agent <key>          Agent to dispatch to (required). See select.mjs agents.
 *   --brief <file>         Brief path. Omit to read the brief from stdin.
 *   --model <id>           Model id. Required for agents with no usable default.
 *   --effort <level>       Reasoning effort. Validated against the selection.
 *   --cd <dir>             Working directory for the child (default: cwd).
 *   --read-only            Use the agent's read-only/plan profile: no edits.
 *   --session <id>         Continue a specific session; send only the delta brief.
 *   --resume-last          Continue the most recent session (agent-global, not
 *                          per-repo). Mutually exclusive with --session.
 *   --timeout <dur>        Watchdog, off by default. h/m/s, e.g. 45m or 2h.
 *   --out-dir <dir>        Artifact directory (default: a fresh dir under temp,
 *                          so the repository under review stays clean).
 *   --skip-git-repo-check  Codex only: allow running outside a git repository.
 *   --refresh-catalog      Rebuild the agent catalog before resolving.
 *   -h, --help             Show this help.
 *
 * What it will not do: it never commits or pushes, never retries with a wider
 * permission profile after a refusal, and never substitutes a different agent,
 * model, or effort for one that was rejected. Every one of those is reported and
 * left to the orchestrator.
 *
 * Result: <out-dir>/result.json, schema delegate-skill.run.v1, plus a summary on
 * stdout. Artifacts alongside it: brief.txt (exactly what was sent),
 * events.jsonl (the agent's raw stdout), final.txt (its closing report),
 * stderr.txt, and for Claude the settings.json that defined its permissions.
 *
 * Statuses in result.json: completed · no_output (exited 0 with no report, so
 * there is nothing to review) · failed · timeout · aborted · auth_failed ·
 * agent_unavailable.
 *
 * Exit codes:
 *   0    the agent exited 0 and reported no error
 *   2    usage error or rejected selection — no result file is written
 *   3    the selected agent is installed but not dispatchable
 *   4    authentication is confirmed failed; nothing was dispatched
 *   124  the watchdog fired
 *   127  the agent binary is not on PATH
 *   else the agent's own exit code (128+signal if it died on a signal)
 * Once the brief and selection validate, result.json is written on every
 * outcome, so a poller that sees a non-zero exit and no file is looking at a
 * usage error.
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { constants, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { EFFORT_TOKEN, SESSION_TOKEN, findAgent, modelPattern } from "./registry.mjs";
import { findAdapter } from "./adapters.mjs";
import { loadCatalog } from "./catalog.mjs";
import { resolveSelection } from "./select.mjs";
import { gitPorcelain, killTree, needsWindowsShell } from "./lib/exec.mjs";
import { parseDuration } from "./lib/duration.mjs";
import { writeJsonAtomic } from "./lib/atomic.mjs";

export const RUN_SCHEMA = "delegate-skill.run.v1";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_LINES = 20;
const GRACE_BEFORE_SIGKILL_MS = 10_000;

function fail(message, code = 2) {
  process.stderr.write(`dispatch: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    agent: null,
    brief: null,
    model: null,
    effort: null,
    cd: process.cwd(),
    readOnly: false,
    session: null,
    resumeLast: false,
    timeout: null,
    outDir: null,
    skipGitRepoCheck: false,
    refreshCatalog: false,
  };
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
        process.stdout.write(helpText());
        process.exit(0);
        break;
      case "--agent": opts.agent = next(); break;
      case "--brief": opts.brief = next(); break;
      case "--model": opts.model = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--read-only": opts.readOnly = true; break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      case "--skip-git-repo-check": opts.skipGitRepoCheck = true; break;
      case "--refresh-catalog": opts.refreshCatalog = true; break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (!opts.agent) fail("--agent is required (list them with select.mjs agents)");
  if (!findAgent(opts.agent)) fail(`unknown agent "${opts.agent}"`);
  if (opts.model !== null && !modelPattern(opts.agent).test(opts.model)) {
    fail(`--model contains characters this agent's dispatch does not accept: "${opts.model}"`);
  }
  if (opts.effort !== null && !EFFORT_TOKEN.test(opts.effort)) {
    fail(`--effort "${opts.effort}" is not a bare token`);
  }
  if (opts.session !== null && opts.resumeLast) {
    fail("--session and --resume-last are mutually exclusive; pass only one");
  }
  // This value can reach cmd.exe through a .cmd shim, so keep it conservative.
  if (opts.session !== null && !SESSION_TOKEN.test(opts.session)) {
    fail("--session must be a shell-safe id (letters, digits, . _ : -)");
  }
  // The watchdog is ours alone; a malformed duration must not silently become
  // "unbounded" on a run the caller asked to bound.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration under ~24 days`);
  }
  if (!existsSync(opts.cd)) fail(`--cd directory does not exist: ${opts.cd}`);
  return opts;
}

function helpText() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "dispatch.mjs — send a brief to a selected agent CLI\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Change accounting
// ---------------------------------------------------------------------------

/** `XY path` / `XY orig -> path`; the path after an arrow is the current one. */
function porcelainPath(line) {
  const body = line.slice(3).trim();
  const arrow = body.lastIndexOf(" -> ");
  const raw = arrow === -1 ? body : body.slice(arrow + 4);
  return raw.replace(/^"(.*)"$/, "$1");
}

/**
 * Compare the working tree before and after the run.
 *
 * The point is to protect pre-existing work: a path that was already dirty
 * cannot be attributed to the agent, so it is reported separately rather than
 * folded into "what the agent changed".
 */
export function describeChanges(baseline, after) {
  if (baseline === null || after === null) {
    return {
      gitAvailable: false,
      baseline,
      after,
      created: [],
      preexisting: baseline ?? [],
      alsoModified: [],
      attributionUncertain: true,
      note: "git could not report on this directory, so no change can be attributed — inspect the working tree directly",
    };
  }
  const beforePaths = new Set(baseline.map(porcelainPath));
  const created = after.filter((line) => !beforePaths.has(porcelainPath(line)));
  const alsoModified = after.filter((line) => beforePaths.has(porcelainPath(line)));
  return {
    gitAvailable: true,
    baseline,
    after,
    created,
    preexisting: baseline,
    alsoModified,
    attributionUncertain: alsoModified.length > 0,
    note: alsoModified.length
      ? `${alsoModified.length} path(s) were already modified before the run; changes there cannot be attributed to the agent`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Run setup and result publication
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRun(opts, brief) {
  // Default to the system temp dir so the repository under review stays
  // pristine — the change report must show the agent's edits, not ours.
  const outDir =
    opts.outDir || join(tmpdir(), "delegate-skill", `${basename(opts.cd) || "repo"}-${opts.agent}-${timestamp()}`);
  mkdirSync(outDir, { recursive: true });
  const run = {
    outDir,
    startedAt: new Date().toISOString(),
    briefPath: join(outDir, "brief.txt"),
    eventsPath: join(outDir, "events.jsonl"),
    finalPath: join(outDir, "final.txt"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
  };
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.eventsPath, "", "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  return run;
}

function makeResultWriter({ opts, selection, adapter, profile, run, agentVersion, extraArtifacts }) {
  return ({ commandArgs = null, ...extra }) => {
    const result = {
      schema: RUN_SCHEMA,
      agent: opts.agent,
      label: selection?.label ?? opts.agent,
      agentVersion,
      workdir: opts.cd,
      requested: {
        agent: opts.agent,
        model: opts.model,
        effort: opts.effort,
        readOnly: opts.readOnly,
        session: opts.session,
        resumeLast: opts.resumeLast,
        timeout: opts.timeout,
      },
      resolved: selection
        ? {
            model: selection.model.value,
            modelSource: selection.model.source,
            modelLabel: selection.model.label,
            effort: selection.effort.value,
            effortMechanism: selection.effort.mechanism,
            effortVerified: selection.effort.verified,
            recommendedEffort: selection.recommendedEffort,
            authState: selection.authState,
          }
        : null,
      permissionProfile: profile ?? null,
      command: adapter ? { name: adapter.binary, args: commandArgs } : null,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      artifacts: {
        outDir: run.outDir,
        briefPath: run.briefPath,
        eventsPath: run.eventsPath,
        finalPath: existsSync(run.finalPath) ? run.finalPath : null,
        stderrPath: run.stderrPath,
        resultPath: run.resultPath,
        ...(extraArtifacts ?? {}),
      },
      warnings: selection?.warnings ?? [],

      // Filled in by review.mjs; kept in the schema so a reader can tell the
      // difference between "not reviewed yet" and "reviewed, nothing found".
      review: null,
      ...extra,
    };
    writeJsonAtomic(run.resultPath, result);
    return result;
  };
}

function probeAgentVersion(adapter, agentEntry, timeoutMs) {
  // The catalog already recorded a version, but it may be from up to a day ago.
  // Re-reading it here is cheap and makes a stale binary visible in the result.
  try {
    const useShell = needsWindowsShell(adapter.winShell, agentEntry.executable.path);
    const raw = execFileSync(useShell ? `"${agentEntry.executable.path}"` : agentEntry.executable.path, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });
    return { version: (raw.trim().split(/\r?\n/, 1)[0] || "").trim() || agentEntry.executable.version, error: null };
  } catch (error) {
    // Installed but not usable is a different problem from not installed, and
    // sending the caller off to reinstall a present binary would be wrong.
    return { version: agentEntry.executable.version, error };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function dispatch({ opts, brief, run, adapter, selection, profile, prepared, agentVersion, agentEntry, writeResult }) {
  const argv = adapter.buildArgv({ opts: { ...opts, model: selection.model.value, effort: selection.effort.value }, run, prepared });
  const baseline = gitPorcelain(opts.cd);
  const normalizer = adapter.normalizer();
  const stderrTail = [];
  let stdoutBuffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  // shell:true only for Windows .cmd shims, which Node's CreateProcess will not
  // resolve on its own. Safe here: the brief goes on stdin, and argv holds only
  // enum values, pattern-checked model/effort/session tokens, and our own paths.
  const useShell = needsWindowsShell(adapter.winShell, agentEntry.executable.path);
  const child = spawn(useShell ? `"${agentEntry.executable.path}"` : agentEntry.executable.path, argv, {
    cwd: opts.cd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    // POSIX: lead a new process group so a cancellation reaches the whole tree.
    detached: process.platform !== "win32",
  });

  const recordLine = (line) => {
    appendFileSync(run.eventsPath, `${line}\n`, "utf8");
    try {
      normalizer.accept(JSON.parse(line));
    } catch {
      // Progress lines that are not JSON stay in events.jsonl and nothing else.
    }
  };

  child.stdout.on("data", (chunk) => {
    // Decode across chunk boundaries: a multibyte character split between two
    // data events would otherwise land as U+FFFD in the saved report.
    stdoutBuffer += stdoutDecoder.write(chunk);
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) recordLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // surface progress live for the orchestrator
    const text = stderrDecoder.write(chunk);
    appendFileSync(run.stderrPath, text, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) stderrTail.push(line.trimEnd());
    }
    while (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
  });

  const finalize = () => {
    if (stdoutBuffer.trim()) {
      recordLine(stdoutBuffer);
      stdoutBuffer = "";
    }
    const fileText =
      adapter.finalMessageFromFile && existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8").trim() : null;
    const folded = normalizer.finish(fileText);
    if (!adapter.finalMessageFromFile) {
      // Agents that stream their report get it persisted here, so every run
      // leaves the same artifact set behind regardless of adapter.
      writeFileSync(run.finalPath, folded.finalMessage ?? "", "utf8");
    }
    return folded;
  };

  let settled = false;
  let watchdogFired = false;
  let watchdogTimer = null;
  let sigkillTimer = null;
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  if (timeoutMs !== null) {
    watchdogTimer = setTimeout(() => {
      watchdogFired = true;
      child.once("exit", () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      killTree(child);
      sigkillTimer = setTimeout(() => {
        if (!settled) killTree(child, "SIGKILL");
      }, GRACE_BEFORE_SIGKILL_MS);
    }, timeoutMs);
  }
  const clearWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  const publish = (extra) => {
    const result = writeResult({ commandArgs: argv, ...extra });
    printSummary(result);
    return result;
  };

  // Our own death must still produce a result. Without this, a kill from the
  // orchestrator's side leaves no result.json and an agent either still running
  // or dying mid-edit with nothing recording why.
  for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signalName, () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const folded = finalize();
      const fields = {
        status: "aborted",
        exitCode: 128 + (constants.signals[signalName] || 15),
        signal: signalName,
        sessionId: folded.sessionId,
        reportedModel: folded.reportedModel,
        finalMessage: folded.finalMessage,
        changes: describeChanges(baseline, gitPorcelain(opts.cd)),
        stderrTail: stderrTail.slice(-STDERR_TAIL_LINES),
        error: `dispatch was killed by ${signalName}; the agent was terminated with it — inspect the working tree before re-dispatching`,
      };
      const result = publish(fields);
      killTree(child);
      setTimeout(() => {
        killTree(child, "SIGKILL");
        // The child may flush files during the grace window, so refresh the
        // snapshot: the artifact should match the tree the caller will find.
        writeResult({ commandArgs: argv, ...fields, changes: describeChanges(baseline, gitPorcelain(opts.cd)) });
        process.exit(result.exitCode);
      }, 2000);
    });
  }

  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    const folded = finalize();
    const result = publish({
      status: "failed",
      exitCode: 1,
      signal: null,
      sessionId: folded.sessionId,
      reportedModel: folded.reportedModel,
      finalMessage: folded.finalMessage,
      changes: describeChanges(baseline, gitPorcelain(opts.cd)),
      stderrTail: stderrTail.slice(-STDERR_TAIL_LINES),
      error: `failed to launch ${adapter.binary}: ${error?.message ?? error}`,
    });
    process.exit(result.exitCode);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearWatchdog();
    // A descendant that ignored SIGTERM must not outlive the timeout report.
    if (watchdogFired) killTree(child, "SIGKILL");
    const folded = finalize();
    const after = gitPorcelain(opts.cd);
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    // A timed-out run is never a success, even if the agent handled SIGTERM by
    // exiting 0. Nor is a clean exit whose own result event reported an error.
    const succeeded = code === 0 && !watchdogFired && !folded.agentError;
    // A clean exit with nothing to show for it gets its own status rather than
    // passing as "completed": there is no report to review, so the run is
    // unverified even though the process was happy.
    const missingOutput = succeeded && !folded.finalMessage.trim();
    const result = publish({
      status: watchdogFired ? "timeout" : missingOutput ? "no_output" : succeeded ? "completed" : "failed",
      exitCode: succeeded ? 0 : watchdogFired ? 124 : mapped === 0 ? 1 : mapped,
      signal: signal ?? null,
      sessionId: folded.sessionId,
      reportedModel: folded.reportedModel,
      resultSubtype: folded.resultSubtype ?? null,
      finalMessage: folded.finalMessage,
      changes: describeChanges(baseline, after),
      ...(succeeded && !missingOutput ? {} : { stderrTail: stderrTail.slice(-STDERR_TAIL_LINES) }),
      // Deliberately no retry of any kind here: no wider permission profile, no
      // different model, no second attempt. The orchestrator decides.
      ...(watchdogFired
        ? { error: `${adapter.binary} did not finish within --timeout ${opts.timeout}; killed by the watchdog` }
        : folded.agentError
          ? { error: folded.agentError }
          : missingOutput
            ? { error: `${adapter.binary} exited 0 but produced no final report; treat this run as unverified` }
            : {}),
    });
    process.exit(result.exitCode);
  });

  // A child that failed to launch can emit a stray 'error' on its stdin pipe;
  // the 'error' handler above owns that outcome.
  child.stdin.on("error", () => {});
  child.stdin.write(brief);
  child.stdin.end();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(result) {
  const lines = [""];
  lines.push(
    `dispatch: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  ` +
      `${result.label} ${result.agentVersion ?? "?"}`,
  );
  if (result.resolved) {
    const model = result.resolved.model ?? "(CLI default)";
    const effort = result.resolved.effort ?? "(CLI default)";
    lines.push(`selection: model ${model} [${result.resolved.modelSource}]  ·  effort ${effort} [${result.resolved.effortMechanism}]`);
    if (result.reportedModel && result.reportedModel !== result.resolved.model) {
      lines.push(`note: the agent reported running model "${result.reportedModel}"`);
    }
  }
  if (result.permissionProfile) lines.push(`profile: ${result.permissionProfile.name}`);
  for (const warning of result.warnings ?? []) lines.push(`warning: ${warning}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.sessionId) lines.push(`session id (continue with: --session ${result.sessionId})`);

  const changes = result.changes;
  if (changes) {
    if (!changes.gitAvailable) {
      lines.push(`changes: ${changes.note}`);
    } else {
      lines.push(`changes: ${changes.created.length} new, ${changes.alsoModified.length} on already-dirty paths`);
      for (const line of changes.created.slice(0, 40)) lines.push(`  + ${line}`);
      if (changes.created.length > 40) lines.push(`  … and ${changes.created.length - 40} more`);
      for (const line of changes.alsoModified.slice(0, 20)) lines.push(`  ? ${line}  (was already modified)`);
      if (changes.note) lines.push(`  ${changes.note}`);
    }
  }
  if (result.stderrTail?.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("", `--- ${result.label} final report ---`, result.finalMessage || "(no final report captured)", "--- end report ---", "");
  lines.push(`result: ${result.artifacts.resultPath}`);
  lines.push("dispatch does not commit, roll back, or re-dispatch. Review the changes, re-run the project's checks, then decide.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const { catalog } = loadCatalog({ refresh: opts.refreshCatalog });
  const outcome = resolveSelection(catalog, { agent: opts.agent, model: opts.model, effort: opts.effort });
  if (!outcome.ok) {
    // Selection failures happen before any artifact exists, and they are never
    // repaired by substitution: report and stop.
    const agentEntry = catalog.agents.find((entry) => entry.key === opts.agent);
    const notDispatchable = agentEntry?.installed && !agentEntry.dispatch.available;
    fail(`${outcome.error}${outcome.hint ? `\n  ${outcome.hint}` : ""}`, notDispatchable ? 3 : 2);
  }
  const selection = outcome.selection;
  const adapter = findAdapter(opts.agent);
  if (!adapter) fail(`no dispatch adapter for "${opts.agent}"`, 3);
  const agentEntry = catalog.agents.find((entry) => entry.key === opts.agent);

  if ((opts.session || opts.resumeLast) && !adapter.supports.session) {
    fail(`${selection.label} has no verified way to continue a session`, 2);
  }
  if (opts.readOnly && !adapter.supports.readOnly) {
    fail(`${selection.label} has no verified read-only profile`, 2);
  }
  if (opts.skipGitRepoCheck && opts.agent !== "codex") {
    fail("--skip-git-repo-check applies to codex only", 2);
  }

  const run = prepareRun(opts, brief);
  const profile = adapter.profile(opts);
  const prepared = adapter.prepare({ runDir: run.outDir, opts });
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);
  // The watchdog only arms once the child is running, so the version preflight
  // needs its own bound: a probe that never returns would wedge us here, before
  // any result exists, where --timeout could not reach it.
  const probeBudget = timeoutMs === null ? VERSION_PROBE_TIMEOUT_MS : Math.min(timeoutMs, VERSION_PROBE_TIMEOUT_MS);
  const probe = probeAgentVersion(adapter, agentEntry, probeBudget);

  const writeResult = makeResultWriter({
    opts,
    selection,
    adapter,
    profile,
    run,
    agentVersion: probe.version,
    extraArtifacts: prepared.artifacts,
  });

  if (selection.authState === "unauthenticated") {
    // Confirmed failure, not an unknown: refuse rather than burn a run that will
    // fail at the provider. "unknown" is only a warning and does proceed.
    const snapshot = gitPorcelain(opts.cd);
    const result = writeResult({
      status: "auth_failed",
      exitCode: 4,
      signal: null,
      sessionId: null,
      reportedModel: null,
      finalMessage: "",
      changes: describeChanges(snapshot, snapshot),
      error: `${selection.label} reports it is not authenticated; nothing was dispatched`,
    });
    printSummary(result);
    process.exit(4);
  }

  if (probe.error && probe.error.code === "ENOENT") {
    const result = writeResult({
      status: "agent_unavailable",
      exitCode: 127,
      signal: null,
      sessionId: null,
      reportedModel: null,
      finalMessage: "",
      changes: describeChanges(null, null),
      error: `${adapter.binary} disappeared from PATH between discovery and dispatch`,
    });
    printSummary(result);
    process.exit(127);
  }

  dispatch({ opts, brief, run, adapter, selection, profile, prepared, agentVersion: probe.version, agentEntry, writeResult });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
