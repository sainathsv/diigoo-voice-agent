/**
 * How the command line says when a planned call goes. Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PLAN_SETTINGS } from "@jenai/engine";
import { callTime, when } from "./plan-text";

const TZ = "Asia/Kolkata";
const W = DEFAULT_PLAN_SETTINGS.callingWindow; // Monday to Saturday, 10:00 to 19:00
const ist = (s: string) => new Date(`${s.replace(" ", "T")}:00+05:30`);
const NOW = ist("2026-10-01 12:00"); // a Thursday

describe("when a planned call goes, on the command line", () => {
  it("says a call already due as now inside calling hours, with the time it fell due, never as a past date alone", () => {
    const due = ist("2026-09-29 11:00");
    expect(callTime({ callAt: due, verdict: "call_now" }, NOW, TZ, W)).toBe(`now (due since ${when(due, TZ)})`);
    expect(callTime({ callAt: NOW, verdict: "call_now" }, NOW, TZ, W)).toMatch(/^now \(due since /);
  });

  it("gives the next calling hours for a call due outside them, as the call plan page does", () => {
    const due = ist("2026-10-01 10:00");
    expect(callTime({ callAt: due, verdict: "call_now" }, ist("2026-10-01 22:30"), TZ, W)).toBe(`next calling hours, ${when(ist("2026-10-02 10:00"), TZ)} (due since ${when(due, TZ)})`);
    // Sunday night: no calling until Monday morning.
    const sat = ist("2026-10-03 11:00");
    expect(callTime({ callAt: sat, verdict: "call_now" }, ist("2026-10-04 21:30"), TZ, W)).toBe(`next calling hours, ${when(ist("2026-10-05 10:00"), TZ)} (due since ${when(sat, TZ)})`);
  });

  it("says a scheduled call whose time came since the plan was worked out as due, not as a past date", () => {
    const six = ist("2026-10-01 18:00");
    expect(callTime({ callAt: six, verdict: "scheduled" }, ist("2026-10-01 18:40"), TZ, W)).toBe(`now (due since ${when(six, TZ)})`);
    expect(callTime({ callAt: six, verdict: "scheduled" }, ist("2026-10-01 19:30"), TZ, W)).toBe(`next calling hours, ${when(ist("2026-10-02 10:00"), TZ)} (due since ${when(six, TZ)})`);
  });

  it("gives the time itself for a call still to come, or one not due now", () => {
    const later = ist("2026-10-02 18:00");
    expect(callTime({ callAt: later, verdict: "scheduled" }, NOW, TZ, W)).toBe(when(later, TZ));
    // Due, but its calling hours are still to come: the time it can be made.
    expect(callTime({ callAt: later, verdict: "call_now" }, NOW, TZ, W)).toBe(when(later, TZ));
    expect(callTime({ callAt: null, verdict: "call_now" }, NOW, TZ, W)).toBe("no time");
  });
});
