/**
 * delegate · tests/select.test.mjs
 *
 * Selection: what is offered, what is accepted, and what is refused. The
 * governing rule under test is that a rejected choice is reported, never
 * silently replaced with a working one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, ok, equal, includes } from "./harness.mjs";
import { buildCatalog, parseCodexCache, parseModelLines } from "../scripts/catalog.mjs";
import {
  DEFAULT_MODEL_PROMPT_LIMIT,
  allAgentChoices,
  dispatchableAgents,
  effortChoices,
  modelChoices,
  resolveSelection,
} from "../scripts/select.mjs";
import { findAgent } from "../scripts/registry.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => readFileSync(join(fixtures, name), "utf8");

function modelsFor(key, entries, source) {
  const agent = findAgent(key);
  return {
    source,
    entries,
    truncated: false,
    allowsManualId: agent.models.allowsManualId,
    cliDefault: agent.models.cliDefault,
    cliDefaultNote: agent.models.cliDefaultNote,
  };
}

/** A catalog with all four dispatchable agents installed and realistic models. */
function testCatalog({ auth = {}, models = {} } = {}) {
  const installed = new Set(["claude", "codex", "opencode", "cursor", "grok"]);
  const defaults = {
    codex: modelsFor("codex", parseCodexCache(fixture("codex-models-cache.json")), "cached-catalog"),
    cursor: modelsFor("cursor", parseModelLines(fixture("cursor-list-models.txt"), "cursor"), "live"),
    opencode: modelsFor("opencode", parseModelLines(fixture("opencode-models.txt"), "lines"), "live"),
    claude: modelsFor("claude", ["fable", "opus", "sonnet", "haiku"].map((id) => ({ id, label: null, isDefault: false, efforts: null, defaultEffort: null })), "aliases"),
    grok: modelsFor("grok", parseModelLines(fixture("grok-models.txt"), "grok"), "live"),
  };
  const prober = {
    resolve: (agent) => (installed.has(agent.key) ? `/fake/bin/${agent.binary}` : null),
    fingerprint: () => ({ size: 1, mtimeMs: 1 }),
    version: (agent) => `${agent.key}-test`,
    inspect: (agent) => ({
      auth: auth[agent.key] ?? { state: "authenticated", probe: "test" },
      models: models[agent.key] ?? defaults[agent.key] ?? modelsFor(agent.key, [], "unsupported"),
    }),
  };
  return buildCatalog({ prober, env: {}, now: 0 });
}

test("only installed, dispatch-capable agents are offered", () => {
  const catalog = testCatalog();
  const offered = dispatchableAgents(catalog).map((agent) => agent.key);
  equal(offered.join(","), "claude,codex,opencode,cursor");

  // grok is installed here, so it must appear in the full list with a reason.
  const all = allAgentChoices(catalog);
  const grok = all.find((choice) => choice.key === "grok");
  equal(grok.installed, true);
  equal(grok.dispatchable, false);
  includes(grok.reason, "discovery only");
});

test("model choices carry their provenance so a listing is never mistaken for a guarantee", () => {
  const catalog = testCatalog();
  equal(modelChoices(catalog, "codex").source, "cached-catalog");
  equal(modelChoices(catalog, "cursor").source, "live");
  equal(modelChoices(catalog, "claude").source, "aliases");
  includes(modelChoices(catalog, "claude").sourceLabel, "not a live listing");
  equal(modelChoices(catalog, "aider").source, "unsupported");
});

test("hidden models never reach the choices", () => {
  const choices = modelChoices(testCatalog(), "codex", { limit: null });
  ok(!choices.entries.some((entry) => entry.id === "gpt-reserve"));
});

test("the default model is offered first and a long list is capped for prompting", () => {
  const catalog = testCatalog();
  const cursor = modelChoices(catalog, "cursor", { limit: 3 });
  equal(cursor.entries[0].id, "auto");
  equal(cursor.entries[0].isDefault, true);
  equal(cursor.entries.length, 3);
  equal(cursor.truncatedForPrompt, true);
  equal(modelChoices(catalog, "cursor", { limit: null }).truncatedForPrompt, false);
  ok(DEFAULT_MODEL_PROMPT_LIMIT > 0);
});

test("an agent with a configured default may be dispatched with no model", () => {
  const catalog = testCatalog();
  const outcome = resolveSelection(catalog, { agent: "codex" });
  ok(outcome.ok);
  equal(outcome.selection.model.value, null);
  equal(outcome.selection.model.source, "cli-default");
});

test("an agent with no usable default refuses to run without a model", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "opencode" });
  equal(outcome.ok, false);
  includes(outcome.error, "no default model");
  includes(outcome.hint, "opencode-go/glm-5.3");
});

test("a manual model id is accepted where the CLI allows it, and flagged", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "codex", model: "gpt-6-unreleased" });
  ok(outcome.ok);
  equal(outcome.selection.model.source, "manual");
  includes(outcome.selection.warnings, "not in the");
});

test("a model id with characters the dispatch cannot carry is refused", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "codex", model: "gpt-5.5; rm -rf /" });
  equal(outcome.ok, false);
  includes(outcome.error, "does not accept");
});

test("an alias listing still accepts a full model name by hand", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "claude", model: "claude-opus-5-20260101" });
  ok(outcome.ok);
  equal(outcome.selection.model.source, "manual");
});

test("effort defaults to high when high is verified for the selection", () => {
  const catalog = testCatalog();
  equal(effortChoices(catalog, "claude").recommended, "high");
  equal(effortChoices(catalog, "codex", "gpt-6-astra").recommended, "high");
  equal(effortChoices(catalog, "opencode", "openai/gpt-5.2").recommended, "high");
});

test("codex effort levels come from the selected model, not from a global list", () => {
  const catalog = testCatalog();
  equal(effortChoices(catalog, "codex", "gpt-6-astra").values.join(","), "low,medium,high,xhigh,max");
  equal(effortChoices(catalog, "codex", "gpt-5.5").values.join(","), "low,medium,high,xhigh");
  // "max" is verified for astra but not for 5.5, and the refusal says so.
  ok(resolveSelection(catalog, { agent: "codex", model: "gpt-6-astra", effort: "max" }).ok);
  const rejected = resolveSelection(catalog, { agent: "codex", model: "gpt-5.5", effort: "max" });
  equal(rejected.ok, false);
  includes(rejected.hint, "low, medium, high, xhigh");
});

test("with no model chosen, codex effort is offered as unverified rather than guessed", () => {
  const catalog = testCatalog();
  const choices = effortChoices(catalog, "codex", null);
  equal(choices.values.length, 0);
  equal(choices.recommended, null);
  includes(choices.unsupportedReason, "select a model first");

  // Passing one anyway is allowed, but the result records that it is unverified.
  const outcome = resolveSelection(catalog, { agent: "codex", effort: "high" });
  ok(outcome.ok);
  equal(outcome.selection.effort.verified, false);
  includes(outcome.selection.warnings, "could not be verified");
});

test("a model with no reported reasoning levels does not fabricate any", () => {
  const choices = effortChoices(testCatalog(), "codex", "gpt-5.4-mini");
  equal(choices.values.length, 0);
  includes(choices.unsupportedReason, "no verified reasoning levels");
});

test("a Cursor model id that already encodes effort refuses an override", () => {
  const catalog = testCatalog();
  const fixed = effortChoices(catalog, "cursor", "gpt-5.3-codex-high");
  equal(fixed.fixedByModel, true);
  const outcome = resolveSelection(catalog, { agent: "cursor", model: "gpt-5.3-codex-high", effort: "low" });
  equal(outcome.ok, false);
  includes(outcome.error, "already fixes its reasoning level");
});

test("Cursor effort needs an explicit model, since the level rides on the id", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "cursor", effort: "high" });
  equal(outcome.ok, false);
  includes(outcome.error, "needs an explicit --model");
});

test("a parameterized Cursor model accepts a verified effort", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "cursor", model: "gpt-5.2", effort: "high" });
  ok(outcome.ok);
  equal(outcome.selection.effort.mechanism, "model-parameter");
  equal(outcome.selection.effort.verified, true);
});

test("an agent with no verified effort mechanism refuses --effort outright", () => {
  const catalog = testCatalog();
  const choices = effortChoices(catalog, "grok");
  equal(choices.mechanism, "unverified");
  // grok is not dispatchable here either, and that refusal comes first.
  const outcome = resolveSelection(catalog, { agent: "grok", effort: "high" });
  equal(outcome.ok, false);
  includes(outcome.error, "not dispatchable");
});

test("effort must be a bare token", () => {
  const outcome = resolveSelection(testCatalog(), { agent: "claude", effort: "high; echo hi" });
  equal(outcome.ok, false);
  includes(outcome.error, "not a bare token");
});

test("a confirmed authentication failure is surfaced on the selection", () => {
  const catalog = testCatalog({ auth: { codex: { state: "unauthenticated", probe: "codex login status" } } });
  const outcome = resolveSelection(catalog, { agent: "codex", model: "gpt-5.5" });
  ok(outcome.ok, "selection still resolves; refusing to dispatch is dispatch.mjs's call");
  equal(outcome.selection.authState, "unauthenticated");
});

test("unknown authentication warns instead of blocking", () => {
  const catalog = testCatalog({ auth: { claude: { state: "unknown", probe: "claude auth status" } } });
  const outcome = resolveSelection(catalog, { agent: "claude", model: "opus" });
  ok(outcome.ok);
  includes(outcome.selection.warnings, "authentication is unknown");
});

test("a stale catalog is carried into the selection as a warning", () => {
  const catalog = { ...testCatalog(), stale: true, staleReason: "refresh failed (network down)" };
  const outcome = resolveSelection(catalog, { agent: "claude", model: "opus" });
  ok(outcome.ok);
  includes(outcome.selection.warnings, "catalog is stale");
});

test("an unknown agent key and an uninstalled agent fail differently", () => {
  const catalog = testCatalog();
  const unknown = resolveSelection(catalog, { agent: "notanagent" });
  equal(unknown.ok, false);
  includes(unknown.error, "unknown agent");

  const absent = resolveSelection(catalog, { agent: "aider" });
  equal(absent.ok, false);
  includes(absent.error, "not installed");
});
