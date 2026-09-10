/**
 * delegate · tests/timings.test.mjs
 *
 * Estimates and the observation store. The invariant under test is honesty: an
 * estimate always reports where it came from, a corrupt store costs an estimate
 * rather than a plan, and the store never grows without bound.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { test, ok, equal, deepEqual, includes, withTempDir } from "./harness.mjs";
import {
  MAX_SAMPLES,
  MIN_SAMPLES,
  REVIEW_ALLOWANCE_MINUTES,
  SIZE_CLASSES,
  TIMINGS_SCHEMA,
  emptyStore,
  estimateFor,
  formatMinutes,
  formatRange,
  loadTimings,
  recordObservation,
  saveTimings,
  timingsPath,
  totalEstimate,
} from "../scripts/timings.mjs";

test("with nothing observed, an estimate is the size-class default and says so", () => {
  const estimate = estimateFor(emptyStore(), { agent: "codex", sizeClass: "medium" });
  equal(estimate.basis, "defaults");
  equal(estimate.min, SIZE_CLASSES.medium.min);
  equal(estimate.max, SIZE_CLASSES.medium.max);
  includes(estimate.note, "no calibration yet");
});

test("fewer than the sample threshold is still the default, not a guess from noise", () => {
  let store = emptyStore();
  for (let index = 0; index < MIN_SAMPLES - 1; index += 1) {
    store = recordObservation(store, { agent: "codex", model: "gpt-5.6", sizeClass: "medium", minutes: 12 });
  }
  const estimate = estimateFor(store, { agent: "codex", model: "gpt-5.6", sizeClass: "medium" });
  equal(estimate.basis, "defaults");
  equal(estimate.min, SIZE_CLASSES.medium.min);
});

test("enough observations recalibrate the range and report the sample count", () => {
  let store = emptyStore();
  for (const minutes of [50, 55, 60, 65, 70]) {
    store = recordObservation(store, { agent: "codex", model: "gpt-5.6", sizeClass: "medium", minutes });
  }
  const estimate = estimateFor(store, { agent: "codex", model: "gpt-5.6", sizeClass: "medium" });
  equal(estimate.basis, "observed");
  equal(estimate.samples, 5);
  ok(estimate.min >= 50 && estimate.min <= 60, `low end ${estimate.min} should come from the samples`);
  ok(estimate.max >= 60 && estimate.max <= 70, `high end ${estimate.max} should come from the samples`);
  includes(estimate.note, "5 observed medium codex run");
});

test("a model with no history falls back to the agent's runs of the same size", () => {
  let store = emptyStore();
  for (const minutes of [30, 32, 35, 38]) {
    store = recordObservation(store, { agent: "claude", model: "opus", sizeClass: "small", minutes });
  }
  const estimate = estimateFor(store, { agent: "claude", model: "a-different-model", sizeClass: "small" });
  equal(estimate.basis, "observed-agent");
  includes(estimate.note, "across models");
});

test("the store stays bounded and ignores nonsense", () => {
  let store = emptyStore();
  for (let index = 0; index < MAX_SAMPLES + 15; index += 1) {
    store = recordObservation(store, { agent: "codex", sizeClass: "large", minutes: 100 + index });
  }
  const durations = store.observations["codex|(cli-default)|large"].durations;
  equal(durations.length, MAX_SAMPLES, "old samples must be dropped");
  equal(durations[durations.length - 1], 100 + MAX_SAMPLES + 14, "the newest sample is kept");

  const before = JSON.stringify(store);
  store = recordObservation(store, { agent: "codex", sizeClass: "nonsense", minutes: 10 });
  store = recordObservation(store, { agent: "codex", sizeClass: "large", minutes: -4 });
  store = recordObservation(store, { agent: "codex", sizeClass: "large", minutes: "soon" });
  equal(JSON.stringify(store), before, "invalid observations must not enter the store");
});

test("a serial total is the sum plus the review allowance, never the maximum", () => {
  const estimates = [
    { min: 20, max: 40, basis: "defaults" },
    { min: 40, max: 90, basis: "defaults" },
  ];
  const total = totalEstimate(estimates);
  equal(total.min, 60 + REVIEW_ALLOWANCE_MINUTES);
  equal(total.max, 130 + REVIEW_ALLOWANCE_MINUTES);
  equal(total.serial, true);
  equal(total.basis, "defaults");
  equal(totalEstimate([{ min: 1, max: 2, basis: "defaults" }, { min: 1, max: 2, basis: "observed" }]).basis, "mixed");
});

test("a corrupt store costs an estimate, not the plan", () => {
  withTempDir("delegate-timings", (dir) => {
    const path = join(dir, "timings.json");
    writeFileSync(path, "{ not json at all", "utf8");
    const { store } = loadTimings({ path });
    equal(store.schema, TIMINGS_SCHEMA);
    deepEqual(store.observations, {}, "a corrupt store reads as no observations, not as garbage");
    equal(estimateFor(store, { agent: "codex", sizeClass: "small" }).basis, "defaults");
  });
});

test("a round trip through the file keeps the observations", () => {
  withTempDir("delegate-timings", (dir) => {
    const path = join(dir, "timings.json");
    let store = emptyStore();
    for (const minutes of [20, 25, 30]) {
      store = recordObservation(store, { agent: "cursor", sizeClass: "small", minutes });
    }
    equal(saveTimings(store, { path }), null);
    const reloaded = loadTimings({ path });
    equal(estimateFor(reloaded.store, { agent: "cursor", sizeClass: "small" }).samples, 3);
  });
});

test("the store records durations and nothing else", () => {
  let store = emptyStore();
  store = recordObservation(store, { agent: "codex", model: "gpt-5.6", sizeClass: "small", minutes: 21 });
  const serialized = JSON.stringify(store);
  for (const needle of ["brief", "finalMessage", "token", "workdir"]) {
    ok(!serialized.includes(needle), `the timings store must not carry ${needle}`);
  }
});

test("durations read as time, not as decimals", () => {
  equal(formatMinutes(35), "35 min");
  equal(formatMinutes(120), "2h");
  equal(formatMinutes(95), "1h 35m");
  equal(formatRange({ min: 20, max: 40 }), "20–40 min");
  equal(formatRange({ min: 60, max: 150 }), "60 min–2h 30m");
});

test("the cache path sits beside the catalog, under XDG_CACHE_HOME", () => {
  includes(timingsPath({ XDG_CACHE_HOME: "/tmp/cache" }), "/tmp/cache/delegate/timings.json");
});
