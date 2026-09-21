/**
 * The report builders: pure functions, so they are checked without a database
 * or a browser. What matters here is that a client can open the file.
 */
import { describe, expect, it } from "vitest";
import { icsFeed, scheduleCsv, scheduleReportHtml, type ScheduleEntry } from "@jenai/reports";

const at = (t: string) => new Date(`2026-10-15T${t}:00+05:30`);
const entries: ScheduleEntry[] = [
  { id: "a1", startsAt: at("10:00"), endsAt: at("10:30"), title: "Ravi Kumar", personName: "Ravi Kumar", phone: "+919876543210", kind: "visit", status: "booked", notes: "Hair PRP review", source: "call", resourceName: "Dr Rickson", resourceColour: "#C96A3C" },
  { id: "a2", startsAt: at("11:00"), endsAt: at("11:45"), title: "Lakshmi, Reddy", personName: "Lakshmi, Reddy", phone: null, kind: "procedure", status: "cancelled", notes: null, source: "manual", resourceName: "Laser room", resourceColour: "#4A4A52" },
];

describe("schedule downloads", () => {
  it("prints a schedule with the brand, the people and the entries", () => {
    const html = scheduleReportHtml({ orgName: "Zennara Clinics", from: at("00:00"), to: at("23:59"), rangeLabel: "Thursday, 15 October 2026", entries, people: [{ id: "r1", name: "Dr Rickson", colour: "#C96A3C" }] });
    expect(html).toContain("Zennara Clinics");
    expect(html).toContain("Ravi Kumar");
    expect(html).toContain("Space+Grotesk");
    expect(html).toContain("from a call");
    expect(html).not.toContain("—"); // never an em dash in JENAI documents
  });

  it("writes a calendar file other calendars accept, without cancelled entries", () => {
    const ics = icsFeed("Zennara Clinics", entries);
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:a1@jenai.in");
    expect(ics).not.toContain("UID:a2@jenai.in"); // cancelled stays out of their diary
    expect(ics).toContain("SUMMARY:Ravi Kumar with Dr Rickson");
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true); // folded, as the format requires
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("writes a spreadsheet that survives commas in names", () => {
    const csv = scheduleCsv(entries);
    const [head, first, second] = csv.split("\r\n");
    expect(head).toBe("Date,Start,End,Who,Phone,With,What,State,Source,Note");
    expect(first).toContain("Ravi Kumar");
    expect(first).toContain("booked on a call");
    expect(second).toContain('"Lakshmi, Reddy"'); // quoted, so Excel keeps one column
  });
});
