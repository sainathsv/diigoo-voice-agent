/**
 * Per-account sign-in throttle, independent of IP address (IP limits alone can
 * be dodged by rotating addresses). In-memory: correct for one web instance.
 * Move to Redis before running more than one instance (Blueprint Phase 1).
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, number[]>();

function key(email: string) {
  return email.trim().toLowerCase();
}

function recent(email: string, now: number) {
  const list = (failures.get(key(email)) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key(email), list);
  return list;
}

export function isLocked(email: string, now = Date.now()): boolean {
  return recent(email, now).length >= MAX_FAILURES;
}

export function recordFailure(email: string, now = Date.now()): void {
  recent(email, now).push(now);
}

export function clearFailures(email: string): void {
  failures.delete(key(email));
}
