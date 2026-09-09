/**
 * delegate-skill · tests/catalog.test.mjs
 *
 * Discovery and caching. The prober is injected, so these run without spawning
 * anything except where the fake-agent suite explicitly wants a real process.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes, withTempDir } from "./harness.mjs";
import {
  CATALOG_SCHEMA,
  CATALOG_TTL_MS,
  buildCatalog,
  catalogPath,
  loadCatalog,
  parseCodexCache,
  parseModelLines,
  validateCache,
} from "../scripts/catalog.mjs";
import { AGENTS } from "../scripts/registry.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(fixtures, name), "utf8");

/** A prober that reports nothing installed. */
function emptyProber() {
  return {
    resolve: () => null,
    fingerprint: () => null,
    version: () => null,
    inspect: () => ({ auth: { state: "unknown", probe: null }, models: null }),
  };
}

/**
 * A prober where the listed agents are installed with canned answers.
 * `state` is mutable so a test can move a binary between calls.
 */
function scriptedProber(state) {
  return {
    resolve: (agent) => state.paths[agent.key] ?? null,
    fingerprint: (path) => state.fingerprints[path] ?? { size: 1, mtimeMs: 1 },
    version: (agent) => state.versions[agent.key] ?? "1.0.0",
    inspect: (agent) => ({
      auth: state.auth[agent.key] ?? { state: "unknown", probe: "scripted" },
      models: state.models[agent.key] ?? {
        source: "live",
        entries: [{ id: "m1", label: null, isDefault: true, efforts: null, defaultEffort: null }],
        truncated: false,
        allowsManualId: agent.models.allowsManualId,
        cliDefault: agent.models.cliDefault,
        cliDefaultNote: agent.models.cliDefaultNote,
      },
    }),
  };
}

function scriptFor(keys) {
  return {
    paths: Object.fromEntries(keys.map((key) => [key, `/fake/bin/${key}`])),
    fingerprints: {},
    versions: {},
    auth: {},
    models: {},
  };
}

test("the catalog lists every registry entry even when nothing is installed", () => {
  const catalog = buildCatalog({ prober: emptyProber(), env: {}, now: 0 });
  equal(catalog.schema, CATALOG_SCHEMA);
  equal(catalog.agents.length, 14);
  equal(catalog.agents.length, AGENTS.length);
  ok(catalog.agents.every((agent) => agent.installed === false));
  ok(catalog.agents.every((agent) => agent.dispatch.available === false));
  ok(catalog.agents.every((agent) => agent.auth.state === "unknown"));
});

test("a missing executable is reported as not installed, not as an error", () => {
  const catalog = buildCatalog({ prober: scriptedProber(scriptFor(["codex"])), env: {}, now: 0 });
  const codex = catalog.agents.find((agent) => agent.key === "codex");
  const claude = catalog.agents.find((agent) => agent.key === "claude");
  equal(codex.installed, true);
  equal(codex.dispatch.available, true);
  equal(claude.installed, false);
  includes(claude.dispatch.reason, "not installed");
});

test("a discovery-only agent stays discoverable but is never dispatchable", () => {
  const script = scriptFor(["grok"]);
  const catalog = buildCatalog({ prober: scriptedProber(script), env: {}, now: 0 });
  const grok = catalog.agents.find((agent) => agent.key === "grok");
  equal(grok.installed, true);
  equal(grok.dispatch.available, false);
  includes(grok.dispatch.reason, "discovery only");
});

test("unknown authentication is distinct from a confirmed failure", () => {
  const script = scriptFor(["claude", "codex", "aider"]);
  script.auth.claude = { state: "authenticated", probe: "claude auth status" };
  script.auth.codex = { state: "unauthenticated", probe: "codex login status" };
  const catalog = buildCatalog({ prober: scriptedProber(script), env: {}, now: 0 });
  const byKey = Object.fromEntries(catalog.agents.map((agent) => [agent.key, agent]));
  equal(byKey.claude.auth.state, "authenticated");
  equal(byKey.codex.auth.state, "unauthenticated");
  // aider has no auth probe at all, which is "unknown", not "unauthenticated".
  equal(byKey.aider.auth.state, "unknown");
});

test("the codex cache parser drops hidden models and keeps per-model efforts", () => {
  const entries = parseCodexCache(fixture("codex-models-cache.json"));
  const ids = entries.map((entry) => entry.id);
  ok(!ids.includes("gpt-reserve"), "a visibility:hide model must not be offered");
  ok(!ids.includes(undefined), "an entry with no slug must be dropped");
  equal(ids.join(","), "gpt-6-astra,gpt-5.5,gpt-5.4-mini");
  const astra = entries.find((entry) => entry.id === "gpt-6-astra");
  equal(astra.efforts.join(","), "low,medium,high,xhigh,max");
  equal(astra.defaultEffort, "low");
  // An empty level list becomes null: "none reported", not "none supported".
  equal(entries.find((entry) => entry.id === "gpt-5.4-mini").efforts, null);
});

test("malformed probe output is a parse failure, never a crash", () => {
  let threw = false;
  try {
    parseCodexCache("{not json");
  } catch {
    threw = true;
  }
  ok(threw, "the parser signals failure so probeModels can label the source unsupported");

  const script = scriptFor(["codex"]);
  script.models.codex = {
    source: "unsupported",
    entries: [],
    truncated: false,
    allowsManualId: true,
    cliDefault: true,
    cliDefaultNote: null,
    note: "the CLI's local model cache is missing or unreadable",
  };
  const catalog = buildCatalog({ prober: scriptedProber(script), env: {}, now: 0 });
  const codex = catalog.agents.find((agent) => agent.key === "codex");
  equal(codex.models.source, "unsupported");
  equal(codex.dispatch.available, true, "an unreadable model listing must not disable dispatch");
});

test("model listings parse into ids for every documented format", () => {
  const cursor = parseModelLines(fixture("cursor-list-models.txt"), "cursor");
  equal(cursor[0].id, "auto");
  equal(cursor[0].isDefault, true);
  ok(!cursor.some((entry) => entry.id === "Available models"), "the header is not a model");
  ok(!cursor.some((entry) => entry.id.startsWith("Tip")), "the tip line is not a model");
  equal(cursor.find((entry) => entry.id === "gpt-5.2").label, "GPT-5.2");

  const opencode = parseModelLines(fixture("opencode-models.txt"), "lines");
  equal(opencode.length, 6);
  equal(opencode[1].id, "opencode-go/glm-5.3");

  const grok = parseModelLines(fixture("grok-models.txt"), "grok");
  equal(grok.length, 3);
  equal(grok.find((entry) => entry.isDefault).id, "grok-4.6");

  const pi = parseModelLines(fixture("pi-list-models.txt"), "table");
  equal(pi[0].id, "anthropic/claude-opus-5");
  equal(pi.length, 3);
});

test("a fresh catalog is written to the cache and reused on the next call", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    const script = scriptFor(["codex"]);
    const prober = scriptedProber(script);
    const first = loadCatalog({ cachePath, prober, env: {}, now: 1_000 });
    equal(first.source, "fresh");
    equal(first.cacheWriteError, null);
    ok(readFileSync(cachePath, "utf8").includes(CATALOG_SCHEMA));

    script.versions.codex = "2.0.0"; // would change the catalog if it rebuilt
    const second = loadCatalog({ cachePath, prober, env: {}, now: 2_000 });
    equal(second.source, "cache");
    equal(second.catalog.agents.find((agent) => agent.key === "codex").executable.version, "1.0.0");
  });
});

test("the cache expires after 24 hours", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    const prober = scriptedProber(scriptFor(["codex"]));
    loadCatalog({ cachePath, prober, env: {}, now: 0 });
    const justInside = loadCatalog({ cachePath, prober, env: {}, now: CATALOG_TTL_MS - 1 });
    equal(justInside.source, "cache");
    const past = loadCatalog({ cachePath, prober, env: {}, now: CATALOG_TTL_MS });
    equal(past.source, "fresh");
    includes(past.reason, "older than 24 hours");
  });
});

test("the cache is invalidated when an executable moves or changes on disk", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    const script = scriptFor(["codex"]);
    const prober = scriptedProber(script);
    loadCatalog({ cachePath, prober, env: {}, now: 0 });

    script.paths.codex = "/other/bin/codex";
    const moved = validateCache(JSON.parse(readFileSync(cachePath, "utf8")), { prober, env: {}, now: 1 });
    equal(moved.valid, false);
    includes(moved.reason, "executable path changed");

    script.paths.codex = "/fake/bin/codex";
    script.fingerprints["/fake/bin/codex"] = { size: 999, mtimeMs: 999 };
    const upgraded = validateCache(JSON.parse(readFileSync(cachePath, "utf8")), { prober, env: {}, now: 1 });
    equal(upgraded.valid, false);
    includes(upgraded.reason, "changed on disk");
  });
});

test("--refresh rebuilds even when the cache is valid", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    const script = scriptFor(["codex"]);
    const prober = scriptedProber(script);
    loadCatalog({ cachePath, prober, env: {}, now: 0 });
    script.versions.codex = "3.1.4";
    const refreshed = loadCatalog({ refresh: true, cachePath, prober, env: {}, now: 1 });
    equal(refreshed.source, "fresh");
    equal(refreshed.reason, "explicit refresh");
    equal(refreshed.catalog.agents.find((agent) => agent.key === "codex").executable.version, "3.1.4");
  });
});

test("a failed refresh falls back to the previous catalog, labelled stale", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    const script = scriptFor(["codex"]);
    loadCatalog({ cachePath, prober: scriptedProber(script), env: {}, now: 0 });
    const before = readFileSync(cachePath, "utf8");

    const brokenProber = {
      ...scriptedProber(script),
      version: () => {
        throw new Error("probe subsystem exploded");
      },
    };
    const outcome = loadCatalog({ refresh: true, cachePath, prober: brokenProber, env: {}, now: 1 });
    equal(outcome.source, "stale-cache");
    equal(outcome.catalog.stale, true);
    includes(outcome.catalog.staleReason, "probe subsystem exploded");
    equal(readFileSync(cachePath, "utf8"), before, "a stale catalog must never overwrite the cache");
  });
});

test("a refresh with no cache to fall back on surfaces the failure", () => {
  withTempDir("delegate-cache", (dir) => {
    const brokenProber = {
      resolve: () => "/fake/bin/codex",
      fingerprint: () => ({ size: 1, mtimeMs: 1 }),
      version: () => {
        throw new Error("probe subsystem exploded");
      },
      inspect: () => ({ auth: { state: "unknown", probe: null }, models: null }),
    };
    let message = "";
    try {
      loadCatalog({ cachePath: join(dir, "catalog.json"), prober: brokenProber, env: {}, now: 0 });
    } catch (error) {
      message = String(error.message);
    }
    includes(message, "probe subsystem exploded");
  });
});

test("an unwritable cache directory does not fail the run", () => {
  withTempDir("delegate-cache", (dir) => {
    // A path whose parent is a file cannot be created, which is the same class
    // of failure as a read-only cache root.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const outcome = loadCatalog({
      cachePath: join(blocker, "catalog.json"),
      prober: scriptedProber(scriptFor(["codex"])),
      env: {},
      now: 0,
    });
    equal(outcome.source, "fresh");
    ok(outcome.cacheWriteError, "the failure is reported rather than thrown");
    equal(outcome.catalog.agents.find((agent) => agent.key === "codex").installed, true);
  });
});

test("a corrupt cache file is treated as no cache", () => {
  withTempDir("delegate-cache", (dir) => {
    const cachePath = join(dir, "catalog.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{ half a file", "utf8");
    const outcome = loadCatalog({ cachePath, prober: scriptedProber(scriptFor(["codex"])), env: {}, now: 0 });
    equal(outcome.source, "fresh");
  });
});

test("the cache path honours XDG_CACHE_HOME", () => {
  equal(catalogPath({ XDG_CACHE_HOME: "/tmp/xdg" }), "/tmp/xdg/delegate-skill/catalog.json");
  includes(catalogPath({}), join(".cache", "delegate-skill", "catalog.json"));
});
