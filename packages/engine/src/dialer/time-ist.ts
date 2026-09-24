/**
 * India is the only timezone a daily allowance is counted in: a client's day
 * is their day, not UTC's, so a cap that reset at 05:30 local would be wrong.
 */
const IST_OFFSET_MS = 330 * 60_000;

/** The calendar day in India that an instant falls on, as yyyy-mm-dd. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight in India, the moment a daily allowance is replenished. */
export function startOfNextIstDay(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - IST_OFFSET_MS);
}
