/**
 * The call plan as the workspace page shows it: sources, counts, filters,
 * pages, masked numbers and branch limits. Runs against the local database
 * (`pnpm db:migrate` first) on two throwaway clients.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  PLANNED_CALL_VERDICTS,
  branches,
  clinicAppointments,
  crmRecords,
  externalPeople,
  integrations,
  organizations,
  packageBalances,
  plannedCalls,
  platformDb,
  suppressions,
  visits,
  withTenant,
} from "@jenai/db";
import { PLAN_JOURNEYS, replanTenant } from "./care-plan";
import { importVisits } from "./visits-import";
import { PLAN_VIEW_PAGE, planView } from "./plan-view";
import { planSummary } from "./plan-refresh";

let clinic = "";
let other = "";
let kondapur = "";
let gachibowli = "";
const ANITHA = "+919848011111";
const LEADS = 55;

/** A day this many days back, as a clinic's export writes it (dd/mm/yyyy, India time). */
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000 + 330 * 60_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

beforeAll(async () => {
  const ids: string[] = [];
  for (const name of ["Plan View Clinic", "Plan View Other"]) {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name, slug: `plan-view-${randomUUID().slice(0, 8)}`, status: "active", vertical: "dermatology", languages: ["en"] })
      .returning({ id: organizations.id });
    ids.push(o!.id);
  }
  [clinic, other] = ids as [string, string];

  await withTenant(clinic, async (tx) => {
    const bs = await tx
      .insert(branches)
      .values([
        { tenantId: clinic, name: "Kondapur", code: "KDP", languages: ["en"] },
        { tenantId: clinic, name: "Gachibowli", code: "GCB", languages: ["en"] },
      ])
      .returning({ id: branches.id, name: branches.name });
    kondapur = bs.find((b) => b.name === "Kondapur")!.id;
    gachibowli = bs.find((b) => b.name === "Gachibowli")!.id;
    const [z] = await tx
      .insert(integrations)
      .values({ tenantId: clinic, kind: "zoho_crm", name: "Zoho", status: "connected", config: { dc: "in" }, lastPullAt: new Date(Date.now() - 5 * 60_000) })
      .returning({ id: integrations.id });
    const asked = new Date(Date.now() - 2 * 3_600_000);
    const lead = (n: number, over: Partial<typeof crmRecords.$inferInsert> = {}) => ({
      tenantId: clinic,
      integrationId: z!.id,
      module: "Leads",
      externalId: `41508680000019${String(n).padStart(5, "0")}`,
      phoneE164: `+91984802${String(n).padStart(4, "0")}`,
      name: `Lead ${n}`,
      status: "New Lead",
      treatment: "Hydrafacial",
      createdExt: asked,
      modifiedExt: asked,
      ...over,
    });
    await tx.insert(crmRecords).values([
      ...Array.from({ length: LEADS }, (_, n) => lead(n + 1)),
      lead(901, { status: "Junk Lead" }),
      // Anitha also asked about a peel: her contact puts this record in Kondapur.
      lead(902, { phoneE164: ANITHA, name: "Anitha", status: "Interested" }),
      lead(903, { module: "Contacts", status: null, treatment: null }),
      lead(904, { deletedAt: new Date() }),
    ]);
  });

  // Uploading runs the plan for everyone, the CRM records too.
  await importVisits(
    clinic,
    [
      "Bill Date,Guest Name,Guest Mobile,Item,Therapist,Centre",
      `${daysAgo(3)},Anitha,98480 11111,Hydrafacial,Dr Rao,Kondapur`,
      `${daysAgo(10)},Ravi,98480 22222,Laser Hair Removal,Dr Rao,Gachibowli`,
      `${daysAgo(2)},Nobody,12345,Peel,,`,
    ].join("\n"),
    { source: "upload", uploadedBy: "plan-view-test" },
  );
});

afterAll(async () => {
  await platformDb().delete(organizations).where(inArray(organizations.id, [clinic, other].filter(Boolean)));
});

describe("the call plan page", () => {
  it("says where the plan comes from: the CRM read and the last visit list upload", async () => {
    const v = await planView(clinic);
    expect(v.sources).toHaveLength(1);
    expect(v.sources[0]).toMatchObject({ name: "Zoho", kind: "zoho_crm", status: "connected", reading: true, lastPullError: null, held: { Contacts: 1, Leads: LEADS + 2 } });
    expect(v.sources[0]!.lastPullAt).toBeInstanceOf(Date);
    expect(v.visits.total).toBe(2);
    expect(v.visits.lastUpload).toMatchObject({ by: null, added: 2, updated: 0, refused: 1 });
    expect(v.computedAt).toBeInstanceOf(Date);
  });

  it("counts every row once, by verdict and by kind of call", async () => {
    const v = await planView(clinic);
    const stored = await withTenant(clinic, (tx) => tx.select({ verdict: plannedCalls.verdict, journey: plannedCalls.journey }).from(plannedCalls));
    expect(v.total).toBe(stored.length);
    for (const verdict of PLANNED_CALL_VERDICTS) expect(v.byVerdict[verdict]).toBe(stored.filter((s) => s.verdict === verdict).length);
    expect(v.byJourney.reduce((n, j) => n + j.total, 0)).toBe(stored.length);
    for (const j of v.byJourney) expect(j.label).toBe(PLAN_JOURNEYS[j.journey].label);
    expect(v.byJourney.find((j) => j.journey === "new_enquiry")!.total).toBeGreaterThanOrEqual(LEADS);
    expect(v.byVerdict.kept_out).toBeGreaterThanOrEqual(2); // the junk lead and the Contacts-only record
  });

  it("pages 50 at a time, due calls first, and never shows a full number", async () => {
    const one = await planView(clinic);
    const two = await planView(clinic, { page: 2 });
    expect(one.rows).toHaveLength(PLAN_VIEW_PAGE);
    expect(two.rows).toHaveLength(one.total - PLAN_VIEW_PAGE);
    expect(two.page).toBe(2);
    const ids = [...one.rows, ...two.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(one.total);

    const rank = (v: string) => PLANNED_CALL_VERDICTS.indexOf(v as never);
    const order = [...one.rows, ...two.rows].map((r) => rank(r.verdict));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    for (const r of [...one.rows, ...two.rows]) {
      expect(r.phone).toMatch(/^\+91 ••••• •\d{4}$/);
      expect(r.phone).not.toContain("98480");
    }
  });

  it("shows where each row comes from, with the CRM status or the service taken", async () => {
    const rows = [...(await planView(clinic)).rows, ...(await planView(clinic, { page: 2 })).rows];
    const junk = rows.find((r) => r.name === "Lead 901")!;
    expect(junk).toMatchObject({ from: "Zoho Lead", originType: "crm_record", status: "Junk Lead", treatment: "Hydrafacial", verdict: "kept_out", service: null });
    expect(junk.phone).toBe("+91 ••••• •0901");
    expect(rows.find((r) => r.name === "Lead 903")).toMatchObject({ from: "Zoho Contact", verdict: "kept_out", journey: "no_call" });
    const visit = rows.find((r) => r.originType === "visit" && r.service === "Laser Hair Removal")!;
    expect(visit).toMatchObject({ from: "Visit list", status: null });
    expect(visit.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows.some((r) => r.name === "Lead 904")).toBe(false); // deleted in Zoho
  });

  it("filters by verdict and kind of call, and ignores values it does not know", async () => {
    const out = await planView(clinic, { verdict: "kept_out" });
    expect(out.verdict).toBe("kept_out");
    expect(out.total).toBe(out.byVerdict.kept_out);
    expect(out.rows.every((r) => r.verdict === "kept_out")).toBe(true);

    const enquiries = await planView(clinic, { journey: "new_enquiry", verdict: "kept_out" });
    expect(enquiries.rows.every((r) => r.journey === "new_enquiry" && r.verdict === "kept_out")).toBe(true);
    expect(enquiries.total).toBe(out.byJourney.find((j) => j.journey === "new_enquiry")!.kept_out);

    const all = await planView(clinic);
    for (const f of [{ journey: "constructor" }, { journey: "x' or 1=1 --" }, { verdict: "dialled" }, { page: Number.NaN }, { page: -4 }]) {
      const v = await planView(clinic, f);
      expect(v).toMatchObject({ journey: undefined, verdict: undefined, page: 1, total: all.total });
    }
  });

  it("keeps a viewer of some branches to the people in them", async () => {
    const k = await planView(clinic, { branchIds: [kondapur] });
    expect(k.total).toBeGreaterThanOrEqual(2);
    expect(k.rows.every((r) => r.name === "Anitha")).toBe(true);
    // Her visit by its own branch, her Zoho enquiry by her contact's.
    expect(k.rows.map((r) => r.from).sort()).toEqual(expect.arrayContaining(["Visit list", "Zoho Lead"]));
    expect(k.byVerdict.call_now + k.byVerdict.scheduled + k.byVerdict.waiting + k.byVerdict.kept_out).toBe(k.total);

    const g = await planView(clinic, { branchIds: [gachibowli] });
    expect(g.total).toBeGreaterThanOrEqual(1);
    expect(g.rows.every((r) => r.name === "Ravi")).toBe(true);

    const none = await planView(clinic, { branchIds: [] });
    expect(none).toMatchObject({ total: 0, rows: [], byJourney: [] });
  });

  it("shows someone who asks not to be called since the plan was worked out as kept out at once", async () => {
    const before = await planView(clinic, { journey: "visit_feedback" });
    const anitha = before.rows.find((r) => r.name === "Anitha")!;
    expect(anitha.verdict).not.toBe("kept_out");
    await withTenant(clinic, (tx) => tx.insert(suppressions).values({ tenantId: clinic, phoneE164: ANITHA, reason: "opt_out", scope: null, source: "call" }));
    try {
      const after = await planView(clinic, { journey: "visit_feedback" });
      expect(after.rows.find((r) => r.id === anitha.id)).toMatchObject({ verdict: "kept_out", reason: "Asked not to be called.", callAt: null });
      const feedbackOut = (v: typeof before) => v.byJourney.find((j) => j.journey === "visit_feedback")!.kept_out;
      expect(feedbackOut(after)).toBe(feedbackOut(before) + 1);
      expect(after.byVerdict.kept_out).toBeGreaterThan(before.byVerdict.kept_out);
      expect((await planView(clinic, { verdict: "kept_out", journey: "visit_feedback" })).rows.map((r) => r.id)).toContain(anitha.id);
      expect((await planSummary(clinic)).next.every((n) => !n.phone.endsWith("1111"))).toBe(true);
      // An opt-out from offers only, or the DND register, stops none of these calls.
      await withTenant(clinic, async (tx) => {
        await tx.delete(suppressions).where(eq(suppressions.tenantId, clinic));
        await tx.insert(suppressions).values({ tenantId: clinic, phoneE164: ANITHA, reason: "opt_out", scope: "promotional", source: "call" });
      });
      expect((await planView(clinic, { journey: "visit_feedback" })).rows.find((r) => r.id === anitha.id)!.verdict).toBe(anitha.verdict);
    } finally {
      await withTenant(clinic, (tx) => tx.delete(suppressions).where(eq(suppressions.tenantId, clinic)));
    }
  });

  it("says whether the plan is switched on, when it was worked out and the upload it can take out", async () => {
    const v = await planView(clinic);
    expect(v).toMatchObject({ enabled: false, canEnable: true, timezone: "Asia/Kolkata", callingWindow: { start: "10:00", end: "19:00" } });
    expect(v.visits.lastUpload!.batch).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.sources[0]!.lastPullNotes).toEqual([]);
  });

  it("shows another client nothing of this one, and an upload that stored nothing", async () => {
    const v = await planView(other);
    expect(v).toMatchObject({ sources: [], visits: { total: 0, lastUpload: null }, total: 0, rows: [], computedAt: null });

    const r = await importVisits(other, "Mobile,Service,Date\n12345,Peel,01/09/2026\n,Peel,01/09/2026\n", { source: "upload" });
    expect(r.added).toBe(0);
    const after = await planView(other);
    expect(after.visits).toMatchObject({ total: 0, lastUpload: { added: 0, refused: 2 } });
  });
});

describe("the call plan page for a clinic on Zenoti", () => {
  let desk = "";
  let zenoti = "";
  let kdp = "";
  let gcb = "";
  const inDays = (n: number, hour: number) => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + n * 86_400_000 + (hour - 5.5) * 3_600_000);
  const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name: "Plan View Front Desk", slug: `plan-view-desk-${randomUUID().slice(0, 8)}`, status: "active", vertical: "dermatology", languages: ["en"] })
      .returning({ id: organizations.id });
    desk = o!.id;
    await withTenant(desk, async (tx) => {
      const bs = await tx
        .insert(branches)
        .values([
          { tenantId: desk, name: "Kondapur", code: "KDP", languages: ["en"] },
          { tenantId: desk, name: "Gachibowli", code: "GCB", languages: ["en"] },
        ])
        .returning({ id: branches.id, name: branches.name });
      kdp = bs.find((b) => b.name === "Kondapur")!.id;
      gcb = bs.find((b) => b.name === "Gachibowli")!.id;
      const [i] = await tx
        .insert(integrations)
        .values({
          tenantId: desk,
          kind: "zenoti",
          name: "Zenoti",
          status: "connected",
          direction: "in",
          lastPullAt: new Date(Date.now() - 5 * 60_000),
          config: { lastSync: { summary: "Read 1 booking (1 new or changed) and 1 service done (1 new) from appointments. Up to date. 9 of 30 calls used." } },
        })
        .returning({ id: integrations.id });
      zenoti = i!.id;
      await tx.insert(externalPeople).values({ tenantId: desk, integrationId: zenoti, externalId: "g1", phoneE164: "+919848033333" });
      await tx.insert(clinicAppointments).values({
        tenantId: desk,
        integrationId: zenoti,
        externalId: "a1",
        guestRef: "g1",
        phoneE164: "+919848033333",
        name: "Sita",
        service: "Hydrafacial",
        startsAt: inDays(5, 11),
        status: "booked",
        branchId: gcb,
      });
      await tx.insert(visits).values({ tenantId: desk, integrationId: zenoti, externalId: "v1", guestRef: "g2", phoneE164: "+919848044444", name: "Ravi", service: "Peel", visitDate: today(), branchId: kdp, source: "api" });
      await tx.insert(packageBalances).values({ tenantId: desk, integrationId: zenoti, guestRef: "g2", phoneE164: "+919848044444", packageName: "Peels", service: "Peel", total: 4, used: 1, balance: 3, status: "active" });
    });
    await replanTenant(desk);
  });

  afterAll(async () => {
    if (desk) await platformDb().delete(organizations).where(eq(organizations.id, desk));
  });

  it("shows Zenoti beside the CRM: what is held from it and its last read in words", async () => {
    const v = await planView(desk);
    expect(v.sources).toHaveLength(1);
    expect(v.sources[0]).toMatchObject({
      name: "Zenoti",
      kind: "zenoti",
      status: "connected",
      reading: true,
      held: { bookings: 1, "services done": 1, guests: 1, "package lines": 1 },
      lastSummary: "Read 1 booking (1 new or changed) and 1 service done (1 new) from appointments. Up to date. 9 of 30 calls used.",
    });
    // The visit list box counts uploads only: Zenoti's services done are counted under Zenoti.
    expect(v.visits.total).toBe(0);
  });

  it("names Zenoti's rows by where they come from, with the booking's service, status and time", async () => {
    const v = await planView(desk);
    const booking = v.rows.find((r) => r.originType === "clinic_appointment")!;
    expect(booking).toMatchObject({ from: "Zenoti booking", journey: "appointment_reminder", service: "Hydrafacial", status: "booked", name: "Sita" });
    expect(booking.bookedFor).toEqual(inDays(5, 11));
    expect(booking.phone).toBe("+91 ••••• •3333");
    expect(v.rows.find((r) => r.originType === "visit")).toMatchObject({ from: "Zenoti visit", service: "Peel", name: "Ravi" });
    expect(v.byJourney.map((j) => j.label)).toContain(PLAN_JOURNEYS.appointment_reminder.label);
  });

  it("keeps a viewer of some branches to the bookings at them", async () => {
    const g = await planView(desk, { branchIds: [gcb] });
    expect(g.rows.length).toBeGreaterThan(0);
    expect(g.rows.every((r) => r.from === "Zenoti booking")).toBe(true);
    const k = await planView(desk, { branchIds: [kdp] });
    expect(k.rows.length).toBeGreaterThan(0);
    expect(k.rows.every((r) => r.from === "Zenoti visit")).toBe(true);
  });
});
