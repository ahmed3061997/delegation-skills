/**
 * delegate · lib/exec.mjs
 *
 * PATH resolution, bounded probe execution, and process-tree termination.
 * Node built-ins only. Makes no network calls and reads no credentials.
 *
 * Every probe here is bounded by a timeout and is chosen to be unambiguously a
 * *query*: no probe passes a bare positional word to a CLI that would read it
 * as a prompt (see registry.mjs for why `codex models` and `pi models` are
 * forbidden).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Resolve `binary` against PATH without spawning anything.
 * Returns the absolute path, or null when the binary is not installed.
 */
export function resolveBinary(binary, env = process.env) {
  const pathValue = env.PATH || env.Path || "";
  if (!pathValue) return null;
  const entries = pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);

  if (process.platform === "win32") {
    const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean);
    for (const entry of entries) {
      for (const extension of extensions) {
        const candidate = join(resolve(entry), `${binary}${extension}`);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }
    return null;
  }

  for (const entry of entries) {
    const candidate = join(resolve(entry), binary);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Cheap, spawn-free identity of an executable. A change here means the binary
 * on PATH is not the one the catalog was built from, so the catalog is invalid.
 *
 * Limit worth knowing: a launcher shim whose own bytes never change when the
 * underlying package is upgraded will not move this fingerprint. That case is
 * caught by the catalog TTL, by `--refresh`, or after the fact by the agent
 * version recorded in every run result.
 */
export function fingerprintExecutable(path) {
  try {
    const stats = statSync(path);
    return { size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) };
  } catch {
    return null;
  }
}

/** True when this platform needs a shell to launch `.cmd`/`.bat` shims. */
export function needsWindowsShell(winShell, binaryPath) {
  return process.platform === "win32" && (winShell || /\.(?:cmd|bat)$/i.test(binaryPath));
}

/** Quote a path for cmd.exe when shell:true; refuse metacharacters outright. */
export function quoteForCmd(value) {
  if (/[\r\n%!]/.test(value) || value.includes('"')) {
    throw new Error(`unsafe path for a Windows shell probe: ${value}`);
  }
  return `"${value}"`;
}

/** Probe output is colorized by some CLIs; patterns match the plain text. */
export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Run a probe and return stdout, throwing on failure.
 * stdin is a pipe (never inherited) so a probe can never wait on the terminal.
 */
export function runProbe(binaryPath, args, useShell, timeoutMs = PROBE_TIMEOUT_MS) {
  const command = useShell ? quoteForCmd(binaryPath) : binaryPath;
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Run a probe and capture both streams without throwing.
 * Some CLIs write status to stderr on success (codex prints login state there),
 * so the caller needs both streams and the exit status.
 */
export function captureProbe(binaryPath, args, useShell, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const command = useShell ? quoteForCmd(binaryPath) : binaryPath;
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = result.stdout || "";
    return {
      ok: !result.error && result.status === 0,
      status: typeof result.status === "number" ? result.status : null,
      stdout,
      output: stripAnsi(`${stdout}${result.stderr || ""}`),
    };
  } catch {
    return { ok: false, status: null, stdout: "", output: "" };
  }
}

/**
 * Terminate a child and everything it spawned.
 *
 * POSIX children are launched detached so they lead their own process group;
 * signalling the negated pid reaches the whole tree. Windows has no process
 * groups to signal, so `taskkill /t` does the walking.
 */
export function killTree(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The group already exited.
    }
  }
}

/**
 * The path a `git status --porcelain` line refers to.
 * `XY path` / `XY orig -> path`; after an arrow, the path is the current one.
 */
export function porcelainPath(line) {
  const body = String(line).slice(3).trim();
  const arrow = body.lastIndexOf(" -> ");
  const raw = arrow === -1 ? body : body.slice(arrow + 4);
  return raw.replace(/^"(.*)"$/, "$1");
}

/**
 * `git status --porcelain` for `cwd`, or null when git cannot report.
 * null is "unknown", never "clean" — the difference decides whether a review
 * can attribute changes at all.
 *
 * `untrackedFiles: "all"` adds `-uall`, which lists new files individually
 * instead of collapsing them into `?? dir/`. A single run does not need the
 * detail; a batch does, because two subtasks creating files in the same new
 * directory are otherwise indistinguishable.
 */
export function gitPorcelain(cwd, { untrackedFiles = "normal" } = {}) {
  try {
    const output = execFileSync("git", ["status", "--porcelain", ...(untrackedFiles === "all" ? ["-uall"] : [])], {
      cwd,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}
