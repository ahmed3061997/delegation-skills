#!/usr/bin/env node
/**
 * delegate-skill · catalog.mjs
 *
 * Discover which agent CLIs are installed and what they can be asked to do,
 * then cache that answer so selection is instant on the next task.
 *
 * Usage (also importable as a library):
 *   node catalog.mjs                 read the cache, refreshing it if invalid
 *   node catalog.mjs --refresh       probe now and rewrite the cache
 *   node catalog.mjs --no-cache      probe now, do not read or write the cache
 *   node catalog.mjs --summary       human-readable table instead of JSON
 *   node catalog.mjs --path          print the cache path and exit
 *   node catalog.mjs --help
 *
 * Cache: ${XDG_CACHE_HOME:-~/.cache}/delegate-skill/catalog.json, published by
 * rename so a concurrent reader never sees a partial file. It is invalid — and
 * so rebuilt — when it is older than 24 hours, when its schema does not match,
 * when the registry's agent list has changed, or when any agent's resolved
 * executable path or on-disk fingerprint has moved. If a rebuild fails, the
 * previous catalog is returned with `stale: true` and a reason rather than
 * nothing; a stale catalog is never written back over the cache.
 *
 * Credentials never enter the catalog. Authentication is recorded as one of
 * three values — authenticated, unauthenticated, unknown — and "unknown" (no
 * probe exists, or the probe was inconclusive) is deliberately distinct from a
 * confirmed failure.
 *
 * Exit codes: 0 on success, including when nothing is installed. 2 on a usage
 * error.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AGENTS } from "./registry.mjs";
import {
  captureProbe,
  fingerprintExecutable,
  needsWindowsShell,
  resolveBinary,
  runProbe,
  stripAnsi,
} from "./lib/exec.mjs";
import { readJsonOrNull, writeJsonAtomic } from "./lib/atomic.mjs";

export const CATALOG_SCHEMA = "delegate-skill.catalog.v1";
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MODEL_ENTRIES = 200;

/** ${XDG_CACHE_HOME:-~/.cache}/delegate-skill/catalog.json */
export function catalogPath(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "delegate-skill", "catalog.json");
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function probeVersion(agent, binaryPath) {
  const useShell = needsWindowsShell(agent.winShell, binaryPath);
  const attempt = (args) => {
    try {
      const firstLine = runProbe(binaryPath, args, useShell).trim().split(/\r?\n/, 1)[0].trim();
      if (!firstLine) return null;
      if (agent.versionFormat !== "colon-prefix") return firstLine;
      return /^([^:\s]+):/.exec(firstLine)?.[1] ?? firstLine;
    } catch {
      return null;
    }
  };
  return attempt(agent.versionArgs) ?? (agent.versionFallbackArgs ? attempt(agent.versionFallbackArgs) : null);
}

/**
 * Read one boolean field out of a JSON auth payload and discard the rest.
 * These payloads carry account email and organization ids; nothing but the
 * boolean is allowed to leave this function.
 */
function readAuthBoolean(raw, field) {
  try {
    const value = JSON.parse(raw)[field];
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function probeAuth(agent, binaryPath, shared = null) {
  if (!agent.authProbe) return { state: "unknown", probe: null };
  const { args, jsonField, successPattern, failPattern, missMeansFalse, description } = agent.authProbe;
  const useShell = needsWindowsShell(agent.winShell, binaryPath);
  const state = (value) => ({
    state: value === true ? "authenticated" : value === false ? "unauthenticated" : "unknown",
    probe: description,
  });

  if (jsonField) {
    try {
      return state(readAuthBoolean(runProbe(binaryPath, args, useShell), jsonField));
    } catch (error) {
      const combined = `${error?.stdout || ""}${error?.stderr || ""}`;
      return state(combined.trim() ? readAuthBoolean(combined, jsonField) : null);
    }
  }

  const { ok, output } = shared || captureProbe(binaryPath, args, useShell);
  // failPattern first: "not logged in" also contains "logged in".
  if (failPattern && failPattern.test(output)) return state(false);
  if (successPattern) {
    if (successPattern.test(output)) return state(true);
    // Absence proves logged-out only where the probe says so; elsewhere a
    // reworded CLI would otherwise read as a confident failure.
    return state(ok && missMeansFalse ? false : null);
  }
  return state(ok ? true : null);
}

function modelEntry(id, label = null, extra = {}) {
  return { id, label, isDefault: false, efforts: null, defaultEffort: null, ...extra };
}

function modelResult(source, entries, agent, extra = {}) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return {
    source,
    entries: unique.slice(0, MAX_MODEL_ENTRIES),
    truncated: unique.length > MAX_MODEL_ENTRIES,
    allowsManualId: agent.models.allowsManualId,
    cliDefault: agent.models.cliDefault,
    cliDefaultNote: agent.models.cliDefaultNote,
    ...extra,
  };
}

function noModels(agent, source, note = null) {
  return modelResult(source, [], agent, { note });
}

/** Parse a listing command's stdout into model entries. */
export function parseModelLines(raw, format) {
  const lines = stripAnsi(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (format === "cursor") {
    // "auto - Auto (default)" — id, " - ", display name.
    return lines
      .filter((line) => line !== "Available models" && !line.startsWith("Tip:"))
      .map((line) => {
        const [id, ...rest] = line.split(/\s+-\s+/);
        const label = rest.join(" - ") || null;
        return modelEntry(id, label, { isDefault: /\(default\)/i.test(label || "") });
      })
      .filter((entry) => /^[A-Za-z0-9]/.test(entry.id));
  }
  if (format === "grok") {
    return lines
      .filter((line) => line.startsWith("* "))
      .map((line) => {
        const raw = line.slice(2).trim();
        const isDefault = /\(default\)$/.test(raw);
        return modelEntry(raw.replace(/\s*\(default\)$/, "").trim(), null, { isDefault });
      });
  }
  if (format === "table") {
    return lines
      .slice(1)
      .map((line) => line.split(/\s+/))
      .filter((columns) => columns.length >= 2)
      .map((columns) => modelEntry(`${columns[0]}/${columns[1]}`));
  }
  return lines.map((line) => modelEntry(line));
}

/**
 * Parse Codex's local models cache.
 *
 * This file is the only credential-free Codex listing, and it is also the only
 * source anywhere that states which reasoning levels a given model supports —
 * which is what lets effort selection be per-model instead of guessed. Entries
 * marked `visibility: "hide"` are internal and are excluded.
 */
export function parseCodexCache(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.models)) throw new Error("no models array in the Codex cache");
  return parsed.models
    .filter((model) => typeof model?.slug === "string" && model.slug && model.visibility !== "hide")
    .map((model) => {
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((level) => (typeof level?.effort === "string" ? level.effort : null))
            .filter(Boolean)
        : null;
      return modelEntry(model.slug, typeof model.display_name === "string" ? model.display_name : null, {
        efforts: efforts && efforts.length ? efforts : null,
        defaultEffort:
          typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : null,
      });
    });
}

function cacheFilePath(probe, env) {
  const base = env[probe.envDir] || join(homedir(), probe.homeSubdir);
  return join(base, probe.file);
}

function probeModels(agent, binaryPath, env, shared = null) {
  const probe = agent.modelProbe;
  if (!probe) {
    return noModels(agent, "unsupported", "no credential-free model listing exists for this CLI");
  }
  if (probe.kind === "aliases") {
    // Curated aliases from the CLI's own help, not a live listing. The
    // distinction matters: aliases can lag the provider's actual catalog.
    return modelResult("aliases", probe.values.map((id) => modelEntry(id)), agent);
  }
  if (probe.kind === "cache-file") {
    try {
      return modelResult("cached-catalog", parseCodexCache(readFileSync(cacheFilePath(probe, env), "utf8")), agent);
    } catch {
      // Absent until the CLI has run once, and malformed if a write was
      // interrupted. Neither is a discovery failure worth throwing on.
      return noModels(agent, "unsupported", "the CLI's local model cache is missing or unreadable");
    }
  }
  const capture = shared || captureProbe(binaryPath, probe.args, needsWindowsShell(agent.winShell, binaryPath));
  if (!capture.ok) return noModels(agent, "unsupported", "the model listing command failed");
  try {
    return modelResult("live", parseModelLines(capture.stdout, probe.format), agent);
  } catch {
    return noModels(agent, "unsupported", "the model listing could not be parsed");
  }
}

/**
 * The real prober. Injectable so the catalog can be tested without spawning
 * anything, and so a test can force a refresh failure.
 */
export function defaultProber(env = process.env) {
  return {
    resolve: (agent) => resolveBinary(agent.binary, env),
    fingerprint: (path) => fingerprintExecutable(path),
    version: (agent, path) => probeVersion(agent, path),
    inspect: (agent, path) => {
      // One capture serves both probes when a CLI's auth and model listings are
      // the same command (grok), which halves its spawns.
      const authArgs = agent.authProbe && !agent.authProbe.jsonField ? agent.authProbe.args : null;
      const modelArgs = agent.modelProbe?.kind === "command" ? agent.modelProbe.args : null;
      const sameCommand =
        authArgs &&
        modelArgs &&
        authArgs.length === modelArgs.length &&
        authArgs.every((arg, index) => arg === modelArgs[index]);
      const shared = sameCommand
        ? captureProbe(path, authArgs, needsWindowsShell(agent.winShell, path))
        : null;
      return {
        auth: probeAuth(agent, path, shared),
        models: probeModels(agent, path, env, shared),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Building and caching
// ---------------------------------------------------------------------------

/** Probe every registry entry and return a fresh catalog. */
export function buildCatalog({ prober = defaultProber(), env = process.env, now = Date.now() } = {}) {
  const agents = AGENTS.map((agent) => {
    const path = prober.resolve(agent);
    const base = {
      key: agent.key,
      label: agent.label,
      binary: agent.binary,
      installed: Boolean(path),
      executable: null,
      auth: { state: "unknown", probe: null },
      dispatch: {
        available: false,
        verification: agent.dispatch?.verification ?? null,
        reason: agent.dispatch ? "the CLI is not installed" : agent.dispatchNote,
      },
      models: noModels(agent, "unsupported", "the CLI is not installed"),
      effort: { ...agent.effort, values: [...agent.effort.values] },
    };
    if (!path) return base;

    const version = prober.version(agent, path);
    const { auth, models } = prober.inspect(agent, path);
    return {
      ...base,
      executable: { path, version, fingerprint: prober.fingerprint(path) },
      auth,
      models,
      dispatch: agent.dispatch
        ? { available: true, verification: agent.dispatch.verification, reason: null }
        : { available: false, verification: null, reason: agent.dispatchNote },
    };
  });

  return {
    schema: CATALOG_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CATALOG_TTL_MS).toISOString(),
    ttlMs: CATALOG_TTL_MS,
    platform: process.platform,
    stale: false,
    staleReason: null,
    agents,
  };
}

function sameFingerprint(a, b) {
  if (a === null || b === null) return a === b;
  return Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

/**
 * Is a cached catalog still usable? Checks only what can be answered without
 * spawning a process, so validation stays cheap enough to run on every task.
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateCache(cached, { prober = defaultProber(), env = process.env, now = Date.now() } = {}) {
  if (!cached || cached.schema !== CATALOG_SCHEMA) {
    return { valid: false, reason: "cached catalog has a different schema" };
  }
  if (!Array.isArray(cached.agents)) {
    return { valid: false, reason: "cached catalog has no agent list" };
  }
  const generated = Date.parse(cached.generatedAt ?? "");
  if (!Number.isFinite(generated)) {
    return { valid: false, reason: "cached catalog has no usable timestamp" };
  }
  if (now - generated >= CATALOG_TTL_MS) {
    return { valid: false, reason: "cached catalog is older than 24 hours" };
  }
  if (cached.platform !== process.platform) {
    return { valid: false, reason: "cached catalog was built on a different platform" };
  }
  const cachedKeys = cached.agents.map((agent) => agent?.key).join(",");
  if (cachedKeys !== AGENTS.map((agent) => agent.key).join(",")) {
    return { valid: false, reason: "the agent registry changed since the catalog was built" };
  }
  for (const agent of AGENTS) {
    const entry = cached.agents.find((candidate) => candidate.key === agent.key);
    const path = prober.resolve(agent);
    const cachedPath = entry?.executable?.path ?? null;
    if (path !== cachedPath) {
      return {
        valid: false,
        reason: `${agent.key}: executable path changed (${cachedPath ?? "absent"} → ${path ?? "absent"})`,
      };
    }
    if (path && !sameFingerprint(prober.fingerprint(path), entry?.executable?.fingerprint ?? null)) {
      return { valid: false, reason: `${agent.key}: executable changed on disk since the catalog was built` };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Get a catalog: cached when valid, freshly probed otherwise.
 *
 * @returns {{
 *   catalog: object,
 *   source: "cache"|"fresh"|"stale-cache",
 *   reason: string|null,
 *   cacheWriteError: string|null,
 * }}
 */
export function loadCatalog({
  refresh = false,
  useCache = true,
  cachePath = null,
  prober = defaultProber(),
  env = process.env,
  now = Date.now(),
} = {}) {
  const path = cachePath ?? catalogPath(env);
  const cached = useCache ? readJsonOrNull(path) : null;
  let invalidReason = null;

  if (!refresh && cached) {
    const { valid, reason } = validateCache(cached, { prober, env, now });
    if (valid) {
      return {
        catalog: { ...cached, stale: false, staleReason: null },
        source: "cache",
        reason: null,
        cacheWriteError: null,
      };
    }
    invalidReason = reason;
  }

  try {
    const catalog = buildCatalog({ prober, env, now });
    let cacheWriteError = null;
    if (useCache) {
      try {
        writeJsonAtomic(path, catalog);
      } catch (error) {
        // A read-only or full cache directory must not fail a dispatch; the
        // catalog is still perfectly usable, it just will not be reused.
        cacheWriteError = error?.message ? String(error.message) : String(error);
      }
    }
    return { catalog, source: "fresh", reason: refresh ? "explicit refresh" : invalidReason ?? null, cacheWriteError };
  } catch (error) {
    if (!cached) throw error;
    // Refresh failed and a previous catalog exists: hand it back labelled, and
    // never write the labelled copy over the cache.
    const staleReason = `refresh failed (${error?.message ?? error}); showing the catalog built ${cached.generatedAt}`;
    return {
      catalog: { ...cached, stale: true, staleReason },
      source: "stale-cache",
      reason: staleReason,
      cacheWriteError: null,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `catalog.mjs — discover installed agent CLIs and cache the result

Usage:
  node catalog.mjs [--refresh | --no-cache] [--summary]
  node catalog.mjs --path
  node catalog.mjs --help

Options:
  --refresh    Probe now and rewrite the cache.
  --no-cache   Probe now; neither read nor write the cache.
  --summary    Print a human-readable table instead of JSON.
  --path       Print the cache file path and exit.

Prints the catalog as JSON on stdout (schema ${CATALOG_SCHEMA}).
Exit 0 even when no CLI is installed; exit 2 on a usage error.
`;

function summarize(catalog, source, reason) {
  const lines = [];
  lines.push(`catalog ${catalog.schema}  ·  built ${catalog.generatedAt}  ·  source ${source}`);
  if (catalog.stale) lines.push(`STALE: ${catalog.staleReason}`);
  else if (reason) lines.push(`rebuilt because: ${reason}`);
  lines.push("");
  const dispatchable = catalog.agents.filter((agent) => agent.dispatch.available);
  const installedOnly = catalog.agents.filter((agent) => agent.installed && !agent.dispatch.available);
  const absent = catalog.agents.filter((agent) => !agent.installed);

  lines.push(`dispatch-capable (${dispatchable.length}):`);
  for (const agent of dispatchable) {
    lines.push(
      `  ${agent.key.padEnd(10)} ${String(agent.executable?.version ?? "version unknown").padEnd(24)} ` +
        `auth=${agent.auth.state.padEnd(15)} models=${agent.models.source}(${agent.models.entries.length})`,
    );
  }
  if (installedOnly.length) {
    lines.push("", `installed but not dispatchable (${installedOnly.length}):`);
    for (const agent of installedOnly) lines.push(`  ${agent.key.padEnd(10)} ${agent.dispatch.reason}`);
  }
  lines.push("", `not installed (${absent.length}): ${absent.map((agent) => agent.key).join(", ") || "none"}`);
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--path")) {
    process.stdout.write(`${catalogPath()}\n`);
    return 0;
  }
  const known = new Set(["--refresh", "--no-cache", "--summary"]);
  const unknown = argv.find((arg) => !known.has(arg));
  if (unknown) {
    process.stderr.write(`catalog.mjs: unknown option "${unknown}". Use --help.\n`);
    return 2;
  }
  const refresh = argv.includes("--refresh");
  const useCache = !argv.includes("--no-cache");
  if (refresh && !useCache) {
    process.stderr.write("catalog.mjs: --refresh and --no-cache are mutually exclusive.\n");
    return 2;
  }

  const { catalog, source, reason, cacheWriteError } = loadCatalog({ refresh, useCache });
  if (cacheWriteError) process.stderr.write(`catalog.mjs: cache not written (${cacheWriteError})\n`);
  process.stdout.write(
    argv.includes("--summary") ? summarize(catalog, source, reason) : `${JSON.stringify(catalog, null, 2)}\n`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
