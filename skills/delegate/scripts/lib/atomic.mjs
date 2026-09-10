/**
 * delegate · lib/atomic.mjs
 *
 * Atomic JSON publication and defensive JSON reads.
 *
 * Both the catalog and every run result are polled by another process while
 * they are being written, so they are always renamed into place rather than
 * written in situ: a reader either sees the previous complete file or the new
 * complete file, never a half-written one.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write `value` as pretty JSON to `path`, creating parents, via rename. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/**
 * Read and parse JSON, returning null for both "absent" and "unparseable".
 * Callers treat null as "no usable cache" — a corrupted catalog must never
 * become an exception in the middle of a dispatch.
 */
export function readJsonOrNull(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
