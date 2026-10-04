/**
 * How the command line says when a planned call goes. Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { callTime, when } from "./plan-text";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-01T06:30:00Z"); // 12:00 in India

describe("when a planned call goes, on the command line", () => {
  it("says a call already due as now, with the time it fell due, never as a past date alone", () => {
    const due = new Date("2026-09-29T05:30:00Z");
    expect(callTime({ callAt: due, verdict: "call_now" }, NOW, TZ)).toBe(`now (due since ${when(due, TZ)})`);
    expect(callTime({ callAt: NOW, verdict: "call_now" }, NOW, TZ)).toMatch(/^now \(due since /);
  });

  it("gives the time itself for a call still to come, or one not due now", () => {
    const later = new Date("2026-10-02T12:30:00Z");
    expect(callTime({ callAt: later, verdict: "scheduled" }, NOW, TZ)).toBe(when(later, TZ));
    // Due, but its calling hours are still to come: the time it can be made.
    expect(callTime({ callAt: later, verdict: "call_now" }, NOW, TZ)).toBe(when(later, TZ));
    expect(callTime({ callAt: null, verdict: "call_now" }, NOW, TZ)).toBe("no time");
  });
});
