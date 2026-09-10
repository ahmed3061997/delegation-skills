/**
 * delegate · lib/duration.mjs
 *
 * h/m/s duration parsing for the dispatch watchdog.
 *
 * The watchdog is ours, not the agent's: none of the supported CLIs exposes a
 * wall-clock limit of its own. A malformed `--timeout` therefore has to fail
 * loudly at parse time — silently falling back to "no watchdog" would leave a
 * run the caller asked to bound running unbounded.
 */

/** Node's setTimeout truncates past this, which would silently disarm the watchdog. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Parse "2h", "45m", "90s", "1h30m" into milliseconds.
 * Returns null for anything malformed, zero, or beyond the timer ceiling.
 */
export function parseDuration(duration) {
  if (typeof duration !== "string") return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n + BigInt(match[2] || 0) * 60n + BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}
