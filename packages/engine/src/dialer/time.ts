/** Calling windows in a client's time zone (India has no DST, but nothing here assumes that). */

export interface Windows {
  days: number[]; // 0 = Sunday ... 6 = Saturday
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** Hard limit for automated calls, applied on top of every campaign window. */
export const HARD_WINDOW = { start: "09:00", end: "21:00" } as const;
/** Do not start a call this close to the end of a window. */
export const END_GUARD_MIN = 10;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

export function localParts(at: Date, tz: string): { y: number; m: number; d: number; dow: number; minutes: number } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!);
  const hour = Number(p.hour) % 24;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow, minutes: hour * 60 + Number(p.minute) };
}

function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** The UTC instant of a local wall-clock time. */
export function zoned(y: number, m: number, d: number, minutes: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60));
  return new Date(guess.getTime() - offsetMs(guess, tz));
}

/** Effective window for a day: the campaign window clipped to the hard window. */
export function effectiveWindow(w: Windows): { start: number; end: number } {
  return { start: Math.max(toMin(w.start), toMin(HARD_WINDOW.start)), end: Math.min(toMin(w.end), toMin(HARD_WINDOW.end)) };
}

export function inWindow(at: Date, w: Windows, tz: string): boolean {
  const p = localParts(at, tz);
  const { start, end } = effectiveWindow(w);
  return w.days.includes(p.dow) && p.minutes >= start && p.minutes < end - END_GUARD_MIN;
}

/** The next moment at or after `from` when dialing is allowed. */
export function nextWindowStart(from: Date, w: Windows, tz: string): Date {
  const { start, end } = effectiveWindow(w);
  if (end - END_GUARD_MIN <= start || w.days.length === 0) throw new Error("Calling window is empty");
  if (inWindow(from, w, tz)) return from;
  for (let i = 0; i < 8; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const p = localParts(probe, tz);
    const candidate = zoned(p.y, p.m, p.d, start, tz);
    if (w.days.includes(p.dow) && candidate.getTime() >= from.getTime()) return candidate;
  }
  throw new Error("No calling window in the next 8 days");
}

/** Start of the next calendar day's window (used for daily caps and "try tomorrow"). */
export function nextDayWindowStart(from: Date, w: Windows, tz: string): Date {
  const p = localParts(from, tz);
  const tomorrowMidnight = zoned(p.y, p.m, p.d, 0, tz).getTime() + 86_400_000;
  return nextWindowStart(new Date(tomorrowMidnight), w, tz);
}

export function isSameLocalDay(a: Date, b: Date, tz: string): boolean {
  const x = localParts(a, tz);
  const y = localParts(b, tz);
  return x.y === y.y && x.m === y.m && x.d === y.d;
}
