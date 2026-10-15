/**
 * How the command line prints a call plan: counts only, per journey and
 * verdict, and when each call goes. Shared by `zoho pull` and `plan`.
 */
import { PLAN_JOURNEYS, inWindow, nextWindowStart, type PlanJourney, type Windows } from "@jenai/engine";
import { PLANNED_CALL_VERDICTS, type PlannedCallVerdict } from "../index";

const HEAD: Record<PlannedCallVerdict, string> = { call_now: "call now", scheduled: "scheduled", waiting: "waiting", kept_out: "kept out" };

/**
 * A table of counts: one line per journey with any rows, in the plan's own
 * order, ending with what that kind of call does in the workspace's words
 * ("Check in and book their next sitting"), and a total.
 */
export function planTable(byVerdict: Record<PlannedCallVerdict, number>, byJourney: Partial<Record<PlanJourney, Partial<Record<PlannedCallVerdict, number>>>>): string[] {
  const cell = (n: number | undefined, v: PlannedCallVerdict) => String(n ?? 0).padStart(HEAD[v].length + 2);
  const row = (name: string, counts: Partial<Record<PlannedCallVerdict, number>>) => name.padEnd(22) + PLANNED_CALL_VERDICTS.map((v) => cell(counts[v], v)).join("");
  const lines = [" ".repeat(22) + PLANNED_CALL_VERDICTS.map((v) => `  ${HEAD[v]}`).join("")];
  for (const j of Object.keys(PLAN_JOURNEYS) as PlanJourney[]) {
    const counts = byJourney[j];
    if (counts && Object.values(counts).some((n) => n)) lines.push(`${row(j, counts)}   ${PLAN_JOURNEYS[j].label}`);
  }
  lines.push(row("total", byVerdict));
  return lines;
}

/**
 * One of the next calls, as `plan show` lists it: when, verdict, kind of
 * call, masked number, where it came from, and for a course check-in where
 * the course stands. Never a name, a treatment or a reason.
 */
export function nextCallLine(c: { journey: PlanJourney; verdict: PlannedCallVerdict; phone: string; origin: string; step: string | null }, time: string, width: number): string {
  return `${time.padEnd(width)} ${c.verdict.padEnd(10)} ${c.journey.padEnd(22)} ${c.phone.padEnd(18)} ${c.step ? `${c.origin.padEnd(16)} ${c.step}` : c.origin}`;
}

/** A time as the client reads it, in their own time zone. */
export function when(at: Date | null, timeZone: string): string {
  if (!at) return "no time";
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/**
 * When a planned call goes, for the list of next calls, as the workspace's
 * call plan page says it. A call due keeps the time it fell due, and so does
 * a scheduled one whose time came since the plan was worked out: either is
 * said as "now (due since ...)" inside calling hours, and as the next calling
 * hours outside them, never as a date that has gone by.
 */
export function callTime(c: { callAt: Date | null; verdict: PlannedCallVerdict }, now: Date, timeZone: string, window: Windows): string {
  if ((c.verdict === "call_now" || c.verdict === "scheduled") && c.callAt && c.callAt <= now) {
    const since = `due since ${when(c.callAt, timeZone)}`;
    return inWindow(now, window, timeZone) ? `now (${since})` : `next calling hours, ${when(nextWindowStart(now, window, timeZone), timeZone)} (${since})`;
  }
  return when(c.callAt, timeZone);
}
