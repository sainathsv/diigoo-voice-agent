/**
 * How the command line prints a call plan: counts only, per journey and
 * verdict, and when each call goes. Shared by `zoho pull` and `plan`.
 */
import { PLAN_JOURNEYS, type PlanJourney } from "@jenai/engine";
import { PLANNED_CALL_VERDICTS, type PlannedCallVerdict } from "../index";

const HEAD: Record<PlannedCallVerdict, string> = { call_now: "call now", scheduled: "scheduled", waiting: "waiting", kept_out: "kept out" };

/** A table of counts: one line per journey with any rows, in the plan's own order, and a total. */
export function planTable(byVerdict: Record<PlannedCallVerdict, number>, byJourney: Partial<Record<PlanJourney, Partial<Record<PlannedCallVerdict, number>>>>): string[] {
  const cell = (n: number | undefined, v: PlannedCallVerdict) => String(n ?? 0).padStart(HEAD[v].length + 2);
  const row = (name: string, counts: Partial<Record<PlannedCallVerdict, number>>) => name.padEnd(22) + PLANNED_CALL_VERDICTS.map((v) => cell(counts[v], v)).join("");
  const lines = [" ".repeat(22) + PLANNED_CALL_VERDICTS.map((v) => `  ${HEAD[v]}`).join("")];
  for (const j of Object.keys(PLAN_JOURNEYS) as PlanJourney[]) {
    const counts = byJourney[j];
    if (counts && Object.values(counts).some((n) => n)) lines.push(row(j, counts));
  }
  lines.push(row("total", byVerdict));
  return lines;
}

/** A time as the client reads it, in their own time zone. */
export function when(at: Date | null, timeZone: string): string {
  if (!at) return "no time";
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/**
 * When a planned call goes, for the list of next calls. A call due now keeps
 * the time it fell due, so a past time is said as "now (due since ...)"
 * rather than as a date that has gone by.
 */
export function callTime(c: { callAt: Date | null; verdict: PlannedCallVerdict }, now: Date, timeZone: string): string {
  if (c.verdict === "call_now" && c.callAt && c.callAt <= now) return `now (due since ${when(c.callAt, timeZone)})`;
  return when(c.callAt, timeZone);
}
