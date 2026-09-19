import "server-only";
import { appDb, sql } from "@jenai/db";

/**
 * Per-account sign-in lockout, independent of IP address (IP limits alone can
 * be dodged by rotating addresses). Counted in the database from the sign-in
 * events every web server writes, so it holds across any number of servers and
 * restarts: 10 wrong passwords since the last success, within 15 minutes.
 */
export const MAX_FAILURES = 10;
export const WINDOW_MINUTES = 15;

export async function isLocked(email: string): Promise<boolean> {
  try {
    const [r] = await appDb().execute<{ n: number }>(sql`select lookup.signin_failures(${email.trim().toLowerCase()}, ${WINDOW_MINUTES}) as n`);
    return Number(r?.n ?? 0) >= MAX_FAILURES;
  } catch (e) {
    console.error(`[security] lockout check failed: ${(e as Error).message}`);
    return false; // fail open for sign-in; the IP limiter and alerts still apply
  }
}
