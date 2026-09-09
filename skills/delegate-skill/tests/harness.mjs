/**
 * delegate-skill · tests/harness.mjs
 *
 * A dependency-free test harness. The skill ships with no node_modules, so its
 * tests cannot assume a runner is installed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export function collected() {
  return registered.splice(0, registered.length);
}

export class AssertionError extends Error {}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function ok(value, message = "expected a truthy value") {
  if (!value) throw new AssertionError(`${message} (got ${show(value)})`);
}

export function equal(actual, expected, message = "values differ") {
  if (actual !== expected) {
    throw new AssertionError(`${message}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
}

export function deepEqual(actual, expected, message = "structures differ") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

export function includes(haystack, needle, message = "substring not found") {
  const text = Array.isArray(haystack) ? haystack.join("\n") : String(haystack);
  if (!text.includes(needle)) {
    throw new AssertionError(`${message}\n  looking for: ${show(needle)}\n  in: ${text.slice(0, 800)}`);
  }
}

export function throwsWith(fn, needle, message = "expected a throw") {
  try {
    fn();
  } catch (error) {
    includes(String(error?.message ?? error), needle, message);
    return;
  }
  throw new AssertionError(`${message}: nothing was thrown`);
}

/**
 * A scratch directory removed when `fn` finishes, even on failure.
 * Handles an async `fn` too: deleting the directory while a child process is
 * still running inside it would make the test lie about what it observed.
 */
export function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (error) => {
        cleanup();
        throw error;
      },
    );
  }
  cleanup();
  return result;
}
