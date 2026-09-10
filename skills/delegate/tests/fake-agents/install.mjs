/**
 * delegate · tests/fake-agents/install.mjs
 *
 * Put fake agent binaries on a throwaway PATH so discovery and dispatch can be
 * exercised against real processes.
 *
 * POSIX only, on purpose: a Windows shim would need a .cmd wrapper and the
 * shell:true launch path, and the skill's stated support is macOS and Linux.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_AGENT = join(here, "fake-agent.mjs");

/** The registry binary name for each agent we can fake. */
export const FAKE_BINARIES = Object.freeze({
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor-agent",
});

/**
 * Create executable shims for `agents` inside `binDir` and return a PATH-like
 * env fragment that finds them and nothing else.
 */
export function installFakeAgents(binDir, agents = Object.keys(FAKE_BINARIES)) {
  mkdirSync(binDir, { recursive: true });
  for (const agent of agents) {
    const binary = FAKE_BINARIES[agent];
    if (!binary) throw new Error(`no fake binary defined for "${agent}"`);
    const shim = join(binDir, binary);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" --as ${agent} "$@"\n`,
      "utf8",
    );
    chmodSync(shim, 0o755);
  }
  return binDir;
}

/**
 * Give the throwaway PATH a working git and nothing else.
 *
 * Change attribution needs git, but the real PATH holds the user's actual agent
 * CLIs, which discovery would then find. A shim gives one without the other.
 */
export function installGitShim(binDir) {
  const realGit = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = join(binDir, "git");
  writeFileSync(shim, `#!/bin/sh\nexec "${realGit}" "$@"\n`, "utf8");
  chmodSync(shim, 0o755);
  return shim;
}

/**
 * An env whose PATH contains only `binDir`, so nothing real can be discovered
 * by accident, plus a HOME and cache root pointed at scratch space.
 */
export function fakeEnv(binDir, { home, cacheHome, extra = {} } = {}) {
  return {
    PATH: binDir,
    ...(home ? { HOME: home } : {}),
    ...(cacheHome ? { XDG_CACHE_HOME: cacheHome } : {}),
    ...extra,
  };
}
