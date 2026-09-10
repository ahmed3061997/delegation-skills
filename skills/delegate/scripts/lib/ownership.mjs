/**
 * delegate · lib/ownership.mjs
 *
 * Owned-path matching, shared by the planner and the review.
 *
 * A subtask declares the paths it expects to create or modify. Under serial
 * execution that declaration is not a boundary — nothing enforces it, and a
 * later subtask editing an earlier one's file is often correct. It is a claim
 * the end-of-batch review can check: a write outside the declared set is
 * something the user should see, not something to prevent mid-run.
 *
 * The matching rules are deliberately few. An ownership rule whose behaviour
 * nobody can predict is worse than one that occasionally needs another entry.
 */

/**
 * Does `path` fall inside `owned`?
 *
 * Exact match, directory prefix, or a trailing `*` / `**` wildcard. `.` owns
 * everything, which the planner warns about rather than forbids.
 */
export function matchesOwnedPath(path, owned) {
  const target = String(path).replace(/^\.\//, "");
  const rule = String(owned).replace(/^\.\//, "").replace(/\/+$/, "");
  if (rule === "" || rule === "." || rule === "**") return true;
  if (rule.endsWith("/**") || rule.endsWith("/*")) {
    const base = rule.replace(/\/\*+$/, "");
    return target === base || target.startsWith(`${base}/`);
  }
  if (rule.endsWith("*")) return target.startsWith(rule.slice(0, -1));
  return target === rule || target.startsWith(`${rule}/`);
}

/** True when any declared owned path covers `path`. */
export function isOwned(path, ownedPaths) {
  return (ownedPaths ?? []).some((owned) => matchesOwnedPath(path, owned));
}

/**
 * Paths that were changed but not declared.
 *
 * `exempt` carries the paths the user had already dirtied before the work
 * started: those are not the agent's to answer for.
 */
export function unownedChanges(changedPaths, ownedPaths, exempt = []) {
  const excused = new Set(exempt);
  return (changedPaths ?? []).filter((path) => !excused.has(path) && !isOwned(path, ownedPaths));
}
