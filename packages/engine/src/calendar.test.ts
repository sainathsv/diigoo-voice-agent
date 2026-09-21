import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appointments, calls, contacts, organizations, platformDb, withTenant } from "@jenai/db";
import { CalendarError, appointmentFromCall, createAppointment, dayRange, dayView, monthRange, saveResource, todaySummary, updateAppointment } from "./calendar";

const db = platformDb();
let tenant = "";
let drA = "";
let drB = "";
const at = (day: string, time: string) => new Date(`${day}T${time}:00+05:30`);
const DAY = "2026-10-15"; // a Thursday

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ kind: "client", name: "Calendar Test Clinic", slug: `cal-test-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] })
    .returning();
  tenant = org!.id;
  drA = (await saveResource(tenant, { name: "Dr A", kind: "doctor" }, null)).id;
  drB = (await saveResource(tenant, { name: "Dr B", kind: "doctor" }, null)).id;
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, tenant));
});

describe("writing in the calendar", () => {
  it("books a visit and refuses a second one on top of the same doctor", async () => {
    const a = await createAppointment(tenant, { personName: "Ravi", startsAt: at(DAY, "10:00"), minutes: 30, resourceId: drA }, null);
    expect(a.status).toBe("booked");
    expect(a.endsAt.getTime() - a.startsAt.getTime()).toBe(30 * 60_000);

    // Overlapping the same doctor is refused, with the entry that is in the way.
    await expect(createAppointment(tenant, { personName: "Sita", startsAt: at(DAY, "10:15"), minutes: 30, resourceId: drA }, null)).rejects.toThrow(CalendarError);
    // The same time with a different doctor is fine: two rooms, two people.
    const b = await createAppointment(tenant, { personName: "Sita", startsAt: at(DAY, "10:15"), minutes: 30, resourceId: drB }, null);
    expect(b.id).toBeTruthy();
    // Back to back is not an overlap.
    const c = await createAppointment(tenant, { personName: "Arun", startsAt: at(DAY, "10:30"), minutes: 30, resourceId: drA }, null);
    expect(c.id).toBeTruthy();
  });

  it("moves an entry, and refuses a move onto a taken slot", async () => {
    const x = await createAppointment(tenant, { personName: "Meena", startsAt: at(DAY, "16:00"), minutes: 30, resourceId: drA }, null);
    const moved = await updateAppointment(tenant, x.id, { startsAt: at(DAY, "17:00"), minutes: 30 }, null);
    expect(moved.startsAt.toISOString()).toBe(at(DAY, "17:00").toISOString());
    await expect(updateAppointment(tenant, x.id, { startsAt: at(DAY, "10:05"), minutes: 20 }, null)).rejects.toThrow(/already taken/);
  });

  it("frees the slot again when an entry is cancelled", async () => {
    const x = await createAppointment(tenant, { personName: "Gone", startsAt: at(DAY, "18:00"), minutes: 30, resourceId: drB }, null);
    await expect(createAppointment(tenant, { personName: "Other", startsAt: at(DAY, "18:00"), minutes: 30, resourceId: drB }, null)).rejects.toThrow(CalendarError);
    await updateAppointment(tenant, x.id, { status: "cancelled", cancelledReason: "patient rang to cancel" }, null);
    const replacement = await createAppointment(tenant, { personName: "Other", startsAt: at(DAY, "18:00"), minutes: 30, resourceId: drB }, null);
    expect(replacement.id).toBeTruthy();
  });

  it("refuses an end before the start", async () => {
    await expect(createAppointment(tenant, { personName: "Bad", startsAt: at(DAY, "12:00"), endsAt: at(DAY, "11:00") }, null)).rejects.toThrow(/after the start/);
  });
});

describe("what a call books", () => {
  it("writes the visit once, however often the call is analysed", async () => {
    const { callId, contactId } = await withTenant(tenant, async (tx) => {
      const [c] = await tx.insert(contacts).values({ tenantId: tenant, phoneE164: "+919800000701", name: "Kiran", tags: [] }).returning();
      const [call] = await tx
        .insert(calls)
        .values({
          tenantId: tenant,
          contactId: c!.id,
          provider: "dograh",
          externalRunId: `cal-${randomUUID().slice(0, 8)}`,
          direction: "inbound",
          status: "completed",
          fromE164: "+919800000701",
          toE164: "+914012345678",
          startedAt: new Date(),
        })
        .returning();
      return { callId: call!.id, contactId: c!.id };
    });

    const when = at(DAY, "11:30");
    const first = await withTenant(tenant, (tx) => appointmentFromCall(tx, tenant, { callId, contactId, branchId: null, when, personName: "Kiran", phone: "+919800000701", note: "About: hair fall" }));
    expect(first?.source).toBe("call");
    expect(first?.notes).toContain("hair fall");
    const second = await withTenant(tenant, (tx) => appointmentFromCall(tx, tenant, { callId, contactId, branchId: null, when, personName: "Kiran" }));
    expect(second?.id).toBe(first?.id); // the same entry, not a second one
    const all = await withTenant(tenant, (tx) => tx.select().from(appointments).where(eq(appointments.callId, callId)));
    expect(all).toHaveLength(1);
  });
});

describe("reading the calendar", () => {
  it("groups a day by doctor and keeps unassigned entries separate", async () => {
    await createAppointment(tenant, { title: "Walk-in list", startsAt: at(DAY, "09:00"), minutes: 30 }, null);
    const v = await dayView(tenant, at(DAY, "12:00"));
    expect(v.items.length).toBeGreaterThan(3);
    expect(v.byResource.find((g) => g.resource.id === drA)!.items.length).toBeGreaterThan(1);
    expect(v.unassigned.map((u) => u.title)).toContain("Walk-in list");
    // Cancelled entries stay out of the day.
    expect(v.items.some((i) => i.status === "cancelled")).toBe(false);
  });

  it("reads days and months in India time, with weeks starting on Monday", () => {
    const { from, to } = dayRange(new Date("2026-10-15T20:30:00Z")); // past midnight IST
    expect(from.toISOString()).toBe("2026-10-15T18:30:00.000Z"); // 16 Oct 00:00 IST
    expect(to.getTime() - from.getTime()).toBe(24 * 3600 * 1000);
    const m = monthRange(new Date("2026-10-15T06:00:00Z"));
    expect(m.weeks).toHaveLength(6);
    expect(m.weeks[0]).toHaveLength(7);
    // 1 Oct 2026 is a Thursday, so the grid starts on Monday 28 Sept.
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(m.weeks[0]![0]!)).toBe("2026-09-28");
  });

  it("counts today for the overview", async () => {
    const now = new Date();
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
    await createAppointment(tenant, { personName: "Today person", startsAt: new Date(`${key}T23:30:00+05:30`), minutes: 15, resourceId: drA }, null);
    const s = await todaySummary(tenant, now);
    expect(s.total).toBeGreaterThan(0);
    expect(s.booked).toBeGreaterThan(0);
  });
});
