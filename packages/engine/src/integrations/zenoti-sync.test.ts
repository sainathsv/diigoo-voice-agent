/**
 * Reading Zenoti into JENAI, against a fake Zenoti and the local database.
 * Nothing here reaches the real Zenoti. The fake keeps bookings, sales lines,
 * guests and packages, answers by method and path as Zenoti documents it, and
 * refuses what the key may not read with the 401 Zennara's key was seen to
 * get. A fake clock stands in for pacing and waits. Each test has a clinic of
 * its own, so one test's visits never count in another's plan.
 */
import "@jenai/db/env";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { auditEvents, branches, clinicAppointments, externalPeople, integrations, organizations, packageBalances, plannedCalls, platformDb, visits, withTenant } from "@jenai/db";
import { sealCredentials } from "./queue";
import { errorWithoutValues, syncZenoti } from "./zenoti-sync";

const KEY = "zen-test-key-not-real";
const KONDAPUR = "80963e4e-6625-4b83-8b88-9708c0cb2303";
const CENTRES = { centers: [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", country: { name: "India", phone_code: "91" } }] };
const DENIED = { Message: "Authorization has been denied for this request." };
const ACCRUAL = "/v1/reports/sales/accrual_basis/flat_file";
/** 11:30 in Hyderabad on 4 October 2026. */
const NOW = new Date("2026-10-04T06:00:00Z");
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

interface Seen {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  auth: string | null;
}
/** Every request any fake Zenoti was sent, for the last test. */
const everything: Seen[] = [];

type Endpoint = "appointments" | "guestDetails" | "guestPackages" | "salesAccrual" | "salesReport";

function endpointOf(r: Seen): Endpoint | "centres" | null {
  if (r.method === "GET" && r.path === "/v1/centers") return "centres";
  if (r.method === "GET" && r.path === "/v1/appointments") return "appointments";
  if (r.method === "GET" && /^\/v1\/guests\/[^/]+$/.test(r.path)) return "guestDetails";
  if (r.method === "GET" && /^\/v1\/guests\/[^/]+\/Packages$/.test(r.path)) return "guestPackages";
  if (r.method === "POST" && r.path === ACCRUAL) return "salesAccrual";
  if (r.method === "GET" && r.path === "/v1/sales/salesreport") return "salesReport";
  return null;
}

const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

/** A Zenoti holding what each test puts in it, whose key may read `allowed`. */
function fakeZenoti(allowed: Endpoint[]) {
  const z = {
    allowed: new Set<Endpoint>(allowed),
    appointments: [] as Array<Record<string, unknown>>,
    accrual: [] as Array<Record<string, unknown>>,
    report: [] as Array<Record<string, unknown>>,
    guests: new Map<string, Record<string, unknown>>(),
    packages: new Map<string, unknown[]>(),
    /** Server errors to answer before answering properly again. */
    failNext: 0,
    seen: [] as Seen[],
    /** The calls to one endpoint, in order. */
    asked: (e: Endpoint) => z.seen.filter((r) => endpointOf(r) === e),
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r: Seen = {
      method: init?.method ?? "GET",
      host: url.host,
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    z.seen.push(r);
    everything.push(r);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const e = endpointOf(r);
    if (e === "centres") return reply(200, CENTRES);
    if (!e) return reply(404, { message: "Not found" });
    if (!z.allowed.has(e)) return reply(401, DENIED);
    if (z.failNext > 0) {
      z.failNext--;
      return reply(500, { message: "Something went wrong" });
    }
    const q = r.query;
    const guestId = () => decodeURIComponent(r.path.split("/")[3]!);
    switch (e) {
      case "appointments": {
        const [from, to] = [q.get("start_date")!, q.get("end_date")!];
        return reply(200, q.get("center_id") === KONDAPUR ? z.appointments.filter((a) => dayOf(a.start_time) >= from && dayOf(a.start_time) < to) : []);
      }
      case "guestDetails": {
        const g = z.guests.get(guestId());
        return g ? reply(200, g) : reply(404, { code: "404", message: "Guest not found" });
      }
      case "guestPackages":
        return reply(200, z.packages.get(guestId()) ?? []);
      case "salesAccrual": {
        const [from, to] = [dayOf(r.body!.start_date), dayOf(r.body!.end_date)];
        const rows = z.accrual.filter((x) => dayOf(x.sale_date) >= from && dayOf(x.sale_date) <= to);
        const [page, size] = [Number(q.get("Page")), Number(q.get("Size"))];
        return reply(200, { sales: rows.slice((page - 1) * size, page * size), page_info: { total: rows.length, page, size } });
      }
      case "salesReport": {
        const [from, to] = [q.get("start_date")!, q.get("end_date")!];
        return reply(200, { center_sales_report: z.report.filter((x) => dayOf(x.serviced_on) >= from && dayOf(x.serviced_on) <= to), Error: null });
      }
    }
  }) as typeof fetch;
  return Object.assign(z, { fetchImpl });
}

function clockAt(at: Date) {
  let t = at.getTime();
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const run = (org: string, id: string, z: ReturnType<typeof fakeZenoti>, at: Date, callBudget?: number) =>
  syncZenoti(org, id, { now: at, clock: clockAt(at), fetchImpl: z.fetchImpl, callBudget });

/** Guest n's number, as the front desk typed it, and as JENAI keeps it. */
const mobile = (n: number) => `984800000${n}`;
const e164 = (n: number) => `+91${mobile(n)}`;

function appointment(id: string, guest: number, day: string, time: string, status: number, service: string) {
  return {
    appointment_id: id,
    invoice_id: `inv-${id}`,
    guest: { id: `g${guest}`, first_name: "Guest", last_name: `Number ${guest}`, mobile: { country_id: 95, number: mobile(guest), display_number: `+91 ${mobile(guest)}` }, email: null },
    service: { id: `svc-${service}`, name: service, category: { name: "Skin" }, sub_category: { name: "Facials" } },
    therapist: { id: "t-1", first_name: "Asha", last_name: "Rao", display_name: "Dr. Asha" },
    start_time: `${day}T${time}:00`,
    start_time_utc: new Date(`${day}T${time}:00+05:30`).toISOString().slice(0, 19),
    status,
    progress: 0,
    source: "Zenoti",
  };
}

const profile = (guest: number, marketing: boolean, transactional: boolean) => ({
  id: `g${guest}`,
  code: `ZN${guest}`,
  personal_info: { first_name: "Guest", last_name: `Number ${guest}`, mobile_phone: { country_code: 95, number: mobile(guest) }, email: null },
  preferences: { receive_marketing_sms: marketing, receive_transactional_sms: transactional },
});

const orgs: string[] = [];

/** A clinic with a Kondapur branch and a Zenoti connection holding a (fake) key. */
async function clinic(config: Record<string, unknown>) {
  const [o] = await platformDb()
    .insert(organizations)
    .values({ kind: "client", name: "Zenoti Sync Clinic", slug: `zenoti-sync-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] })
    .returning();
  const org = o!.id;
  orgs.push(org);
  const [b] = await withTenant(org, (tx) => tx.insert(branches).values({ tenantId: org, name: "Kondapur", languages: ["en"] }).returning());
  const [i] = await withTenant(org, (tx) =>
    tx.insert(integrations).values({ tenantId: org, kind: "zenoti", name: "Zenoti", status: "connected", direction: "in", config, credentials: sealCredentials(org, { api_key: KEY }) }).returning(),
  );
  return { org, branchId: b!.id, id: i!.id };
}

/** What a check made at NOW found, so a test can start without one. */
const checked = (capabilities: Record<Endpoint, boolean>, path: string) => ({
  centres: [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", phoneCode: "91" }],
  access: { capabilities, path, checkedAt: NOW.toISOString() },
});

const stored = (org: string) =>
  withTenant(org, async (tx) => ({
    integration: (await tx.select().from(integrations))[0]!,
    bookings: await tx.select().from(clinicAppointments).orderBy(clinicAppointments.externalId),
    visits: await tx.select().from(visits).orderBy(visits.externalId),
    people: await tx.select().from(externalPeople).orderBy(externalPeople.externalId),
    packages: await tx.select().from(packageBalances).orderBy(packageBalances.service),
    plan: await tx.select().from(plannedCalls),
    audit: await tx.select().from(auditEvents).where(eq(auditEvents.action, "zenoti.synced")).orderBy(auditEvents.createdAt),
  }));

const cursorOf = (i: { pullCursor: Record<string, unknown> }) => (i.pullCursor.zenoti as Record<string, string> | undefined)?.[KONDAPUR];
const spansAsked = (z: ReturnType<typeof fakeZenoti>) => z.asked("appointments").map((r) => [r.query.get("start_date"), r.query.get("end_date")]);

afterAll(async () => {
  if (orgs.length) await platformDb().delete(organizations).where(inArray(organizations.id, orgs));
});

describe("reading Zenoti through appointments", () => {
  const z = fakeZenoti(["appointments", "guestDetails", "guestPackages", "salesAccrual", "salesReport"]);
  let c: Awaited<ReturnType<typeof clinic>>;

  it("checks what the key may read, backfills a week at a time, then reads the recent days, guests and packages", async () => {
    c = await clinic({ backfillDays: 30 });
    z.appointments.push(
      // Before the 30 days read back: never asked for.
      appointment("a0", 1, "2026-08-01", "11:00", 1, "Hydrafacial"),
      appointment("a1", 1, "2026-09-06", "11:00", 1, "Hydrafacial"),
      appointment("a2", 2, "2026-09-20", "16:30", -2, "PRP - Hair"),
      appointment("a3", 1, "2026-10-02", "12:00", 1, "LHR Full Legs"),
      appointment("a5", 2, "2026-10-03", "15:00", 0, "PRP - Hair"),
      appointment("a4", 3, "2026-10-10", "10:00", 0, "Consultation"),
      appointment("a6", 3, "2026-10-12", "10:00", 4, "Consultation"),
      // A slot Zenoti calls Voided: neither booked nor done.
      appointment("a7", 2, "2026-10-01", "09:00", 21, "Peel"),
    );
    z.guests.set("g1", profile(1, false, true));
    z.guests.set("g2", profile(2, true, true));
    // g3 is gone from Zenoti: their profile is not found.
    z.packages.set("g1", [
      {
        user_package_id: "up-1",
        status: 1,
        package: { id: "p-1", name: "LHR 5 Body Parts 5 Sessions", type: 0 },
        date: { start: "2026-09-01T10:00:00", end: "2027-03-01T00:00:00" },
        services: [
          { service_type_info: { id: "s-1", name: "LHR Full Legs" }, total: 5, used: 2, balance: 3 },
          { service_type_info: { id: "s-2", name: "LHR Underarms" }, total: 5, used: 2, balance: 3 },
        ],
        products: [],
      },
    ]);

    const r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ ran: true, tested: true, path: "appointments", done: true, error: null, left: [] });
    // The check (centres and five probes), 4 weeks of history, 3 spans of recent and coming days, 3 profiles, 1 guest's packages.
    expect(r.calls).toBe(6 + 4 + 3 + 3 + 1);
    expect(spansAsked(z).slice(1)).toEqual([
      ["2026-09-04", "2026-09-11"],
      ["2026-09-11", "2026-09-18"],
      ["2026-09-18", "2026-09-25"],
      ["2026-09-25", "2026-10-01"],
      ["2026-10-01", "2026-10-08"],
      ["2026-10-08", "2026-10-15"],
      ["2026-10-15", "2026-10-19"],
    ]);
    expect(z.asked("appointments").every((q) => q.query.get("include_no_show_cancel") === "true")).toBe(true);

    const s = await stored(c.org);
    expect(cursorOf(s.integration)).toBe("2026-10-03");
    expect(s.integration.config.branchMap).toEqual({ [KONDAPUR]: c.branchId });
    expect(s.integration.lastPullError).toBeNull();
    expect(s.integration.pullLeaseUntil).toBeNull();
    expect(s.bookings.map((b) => [b.externalId, b.status])).toEqual([
      ["a1", "completed"],
      ["a2", "no_show"],
      ["a3", "completed"],
      ["a4", "booked"],
      ["a5", "booked"],
      ["a6", "confirmed"],
      ["a7", "unknown"],
    ]);
    expect(s.bookings.find((b) => b.externalId === "a4")).toMatchObject({ guestRef: "g3", phoneE164: e164(3), startsAt: new Date("2026-10-10T04:30:00Z"), branchId: c.branchId, centreRef: KONDAPUR, doctor: "Dr. Asha" });

    // Completed bookings are the services done, with the number from the booking.
    expect(s.visits).toHaveLength(2);
    expect(s.visits[0]).toMatchObject({ externalId: "a1", guestRef: "g1", phoneE164: e164(1), service: "Hydrafacial", visitDate: "2026-09-06", doctor: "Dr. Asha", branch: "Kondapur", branchId: c.branchId, source: "api", integrationId: c.id });
    // The package in use says how far through the course they are.
    expect(s.visits[1]).toMatchObject({ externalId: "a3", service: "LHR Full Legs", visitDate: "2026-10-02", sessionsTotal: 5, sessionsDone: 2 });
    expect(r.packages).toMatchObject({ guests: 1, rows: 2, sessions: 1, left: 0 });
    expect(s.packages.map((p) => [p.guestRef, p.service, p.total, p.used, p.balance, p.status, p.expiresOn, p.phoneE164])).toEqual([
      ["g1", "LHR Full Legs", 5, 2, 3, "active", "2027-03-01", e164(1)],
      ["g1", "LHR Underarms", 5, 2, 3, "active", "2027-03-01", e164(1)],
    ]);

    // Each guest's profile, read once: the consents it gives, and a guest Zenoti no longer has marked read.
    expect(s.people.map((p) => [p.externalId, p.phoneE164, p.marketingSmsConsent, p.transactionalSmsConsent, p.fetchedAt?.toISOString()])).toEqual([
      ["g1", e164(1), false, true, NOW.toISOString()],
      ["g2", e164(2), true, true, NOW.toISOString()],
      ["g3", e164(3), null, null, NOW.toISOString()],
    ]);
    expect(s.people[0]!.packagesFetchedAt?.toISOString()).toBe(NOW.toISOString());

    // The plan has the laser course's next session, and nobody waits for a number.
    expect(r.plan?.waitingForPhone).toBe(0);
    expect(s.plan.some((p) => p.originId === s.visits[1]!.id && p.journey === "next_session")).toBe(true);

    // What the clinic and the logs see carries counts and centre names, never a guest's name or number.
    expect(r.summary).toBe("Read 7 bookings (7 new or changed) and 2 services done (2 new) from appointments. Read 3 guest profiles. Read the packages of 1 guest. Up to date. 17 of 30 calls to Zenoti used.");
    expect(s.integration.config.lastSync).toMatchObject({ path: "appointments", calls: 17, done: true, summary: r.summary });
    expect(JSON.stringify(r)).not.toMatch(/Number \d|9848/);
    expect(s.audit.map((a) => [a.action, a.via, a.targetId, a.summary])).toEqual([["zenoti.synced", "system", c.id, `Zenoti read: ${r.summary}`]]);
  });

  it("reads the recent days again, so a booking completed, cancelled or deleted in Zenoti is seen", async () => {
    z.appointments.find((a) => a.appointment_id === "a5")!.status = 1;
    z.appointments.find((a) => a.appointment_id === "a4")!.status = -1;
    z.appointments.splice(
      z.appointments.findIndex((a) => a.appointment_id === "a6"),
      1,
    );
    z.seen.length = 0;

    const r = await run(c.org, c.id, z, later(2));
    expect(r).toMatchObject({ tested: false, done: true, error: null });
    // Only the recent and coming days, and the packages of the guest who now has a visit.
    expect(spansAsked(z)).toEqual([
      ["2026-10-01", "2026-10-08"],
      ["2026-10-08", "2026-10-15"],
      ["2026-10-15", "2026-10-19"],
    ]);
    expect(z.asked("guestDetails")).toHaveLength(0);
    expect(z.asked("guestPackages").map((q) => q.path)).toEqual(["/v1/guests/g2/Packages"]);
    expect(r.calls).toBe(4);
    // a4 and a5 changed in Zenoti; the other bookings of these days are as they were, and not written again.
    expect(r.bookings).toEqual({ read: 4, changed: 2, removed: 1 });
    expect(r.visits).toMatchObject({ added: 1, removed: 0 });

    const s = await stored(c.org);
    expect(s.bookings.map((b) => [b.externalId, b.status])).toEqual([
      ["a1", "completed"],
      ["a2", "no_show"],
      ["a3", "completed"],
      ["a4", "cancelled"],
      ["a5", "completed"],
      ["a7", "unknown"],
    ]);
    expect(s.visits.map((v) => [v.externalId, v.phoneE164, v.visitDate])).toEqual([
      ["a1", e164(1), "2026-09-06"],
      ["a3", e164(1), "2026-10-02"],
      ["a5", e164(2), "2026-10-03"],
    ]);

    // Closed by mistake and opened again: the visit goes with it.
    z.appointments.find((a) => a.appointment_id === "a5")!.status = 0;
    const again = await run(c.org, c.id, z, later(3));
    expect(again.visits.removed).toBe(1);
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["a1", "a3"]);
  });

  it("leaves a connection another run is reading", async () => {
    await withTenant(c.org, (tx) => tx.update(integrations).set({ pullLeaseUntil: new Date(Date.now() + 60_000) }).where(eq(integrations.id, c.id)));
    z.seen.length = 0;
    const r = await run(c.org, c.id, z, later(4));
    expect(r).toMatchObject({ ran: false, calls: 0 });
    expect(z.seen).toEqual([]);
    await withTenant(c.org, (tx) => tx.update(integrations).set({ pullLeaseUntil: null }).where(eq(integrations.id, c.id)));
  });
});

describe("a run's call budget", () => {
  it("never makes more calls than it was given, and the next run carries on from the last day stored", async () => {
    const z = fakeZenoti(["appointments"]);
    const c = await clinic({ backfillDays: 30, ...checked({ appointments: true, guestDetails: false, guestPackages: false, salesAccrual: false, salesReport: false }, "appointments") });
    z.appointments.push(appointment("b1", 4, "2026-09-12", "10:00", 1, "Hydrafacial"), appointment("b2", 4, "2026-09-26", "10:00", 1, "Hydrafacial"));

    let r = await run(c.org, c.id, z, NOW, 2);
    expect(r).toMatchObject({ calls: 2, done: false, error: null, left: ["31 days at Kondapur"] });
    expect(r.summary).toMatch(/Left for next time: 31 days at Kondapur\. 2 of 2 calls to Zenoti used\.$/);
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-09-17");

    // A server error, and its retry, count against the budget too.
    z.failNext = 1;
    r = await run(c.org, c.id, z, later(1), 3);
    expect(r).toMatchObject({ calls: 3, done: false, error: null, left: ["18 days at Kondapur"] });
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-09-30");

    r = await run(c.org, c.id, z, later(2));
    expect(r).toMatchObject({ calls: 3, done: true, error: null, left: [] });
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-10-03");

    expect(spansAsked(z).map(([from]) => from)).toEqual(["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-18", "2026-09-25", "2026-10-01", "2026-10-08", "2026-10-15"]);
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["b1", "b2"]);
  });

  it("reads the days a widened window adds, newest first, carrying on where a short run stopped", async () => {
    const z = fakeZenoti(["appointments"]);
    const access = checked({ appointments: true, guestDetails: false, guestPackages: false, salesAccrual: false, salesReport: false }, "appointments");
    const c = await clinic({ backfillDays: 14, ...access });
    z.appointments.push(appointment("w0", 6, "2026-08-20", "10:00", 1, "Hydrafacial"), appointment("w1", 6, "2026-09-08", "10:00", 1, "Hydrafacial"), appointment("w2", 6, "2026-09-22", "10:00", 1, "Peel"));
    const marks = async () => {
      const i = (await stored(c.org)).integration;
      return [cursorOf(i), (i.pullCursor.zenotiFrom as Record<string, string> | undefined)?.[KONDAPUR]];
    };

    let r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ calls: 5, done: true });
    expect(await marks()).toEqual(["2026-10-03", "2026-09-20"]);

    await withTenant(c.org, (tx) => tx.update(integrations).set({ config: { ...access, backfillDays: 30 } }).where(eq(integrations.id, c.id)));
    r = await run(c.org, c.id, z, later(1), 1);
    // Nine days of the widening still to read, and the recent days, not read this run.
    expect(r).toMatchObject({ calls: 1, done: false, left: ["27 days at Kondapur"] });
    expect(r.centres[0]).toMatchObject({ cursor: "2026-10-03", from: "2026-09-13" });
    expect(await marks()).toEqual(["2026-10-03", "2026-09-13"]);

    r = await run(c.org, c.id, z, later(2));
    expect(r).toMatchObject({ calls: 5, done: true, left: [] });
    expect(await marks()).toEqual(["2026-10-03", "2026-09-04"]);
    expect(spansAsked(z)).toEqual([
      ["2026-09-20", "2026-09-27"],
      ["2026-09-27", "2026-10-01"],
      ["2026-10-01", "2026-10-08"],
      ["2026-10-08", "2026-10-15"],
      ["2026-10-15", "2026-10-19"],
      ["2026-09-13", "2026-09-20"],
      ["2026-09-06", "2026-09-13"],
      ["2026-09-04", "2026-09-06"],
      ["2026-10-01", "2026-10-08"],
      ["2026-10-08", "2026-10-15"],
      ["2026-10-15", "2026-10-19"],
    ]);
    // Older than even the widened window: never asked for.
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["w1", "w2"]);
  });

  it("reads nothing when the budget cannot even cover a check of what the key may read", async () => {
    const z = fakeZenoti(["appointments"]);
    const c = await clinic({});
    const r = await run(c.org, c.id, z, NOW, 5);
    expect(r).toMatchObject({ calls: 0, done: false, error: null, left: ["a check of what the key may read"] });
    expect(z.seen).toEqual([]);
  });
});

describe("reading Zenoti through a sales report", () => {
  it("keeps services sold without a number, and gives them one once the guest's profile may be read", async () => {
    const z = fakeZenoti(["salesAccrual", "salesReport"]);
    const c = await clinic({ backfillDays: 10, reportPageSize: 2 });
    const line = (invoice: string, day: string, guest: number, item: string, name: string, type: string, status = "Closed") => ({
      sale_date: `${day}T00:00:00`,
      invoice_id: invoice,
      invoice_no: `ZN-${invoice}`,
      guest_id: `g${guest}`,
      guest_name: `Guest Number ${guest}`,
      center_id: KONDAPUR,
      center_code: "ZNKD",
      item_id: item,
      item_name: name,
      item_type: type,
      qty: 1,
      status,
      provider: "Dr. Asha",
      item_category: "Skin",
      invoice_notes: "Allergic to latex",
    });
    z.accrual.push(
      line("i1", "2026-09-29", 7, "svc-hf", "Hydrafacial", "Service"),
      // A second line for the same service on the same day: one visit once the number is known.
      line("i2", "2026-09-29", 7, "svc-hf", "Hydrafacial", "Service"),
      line("i3", "2026-10-02", 8, "svc-prp", "PRP - Hair", "Service"),
      line("i3", "2026-10-02", 8, "prd-1", "Sunscreen", "Product"),
      line("i4", "2026-10-03", 9, "svc-peel", "Peel", "Service", "Open"),
    );

    let r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ path: "sales_accrual", tested: true, done: true, error: null });
    // The check, one page of the history and two of the recent days.
    expect(r.calls).toBe(6 + 1 + 2);
    const pages = z.asked("salesAccrual").slice(1);
    expect(pages.map((p) => [p.body!.start_date, p.body!.end_date, p.query.get("Page"), p.query.get("Size")])).toEqual([
      ["2026-09-24 00:00:00", "2026-09-30 23:59:59", "1", "2"],
      ["2026-10-01 00:00:00", "2026-10-04 23:59:59", "1", "2"],
      ["2026-10-01 00:00:00", "2026-10-04 23:59:59", "2", "2"],
    ]);
    expect(pages[0]!.body).toMatchObject({ center_ids: [KONDAPUR] });

    let s = await stored(c.org);
    expect(s.visits.map((v) => [v.externalId, v.guestRef, v.phoneE164, v.service, v.visitDate])).toEqual([
      ["i1:svc-hf", "g7", null, "Hydrafacial", "2026-09-29"],
      ["i2:svc-hf", "g7", null, "Hydrafacial", "2026-09-29"],
      ["i3:svc-prp", "g8", null, "PRP - Hair", "2026-10-02"],
    ]);
    expect(s.people.map((p) => [p.externalId, p.phoneE164, p.fetchedAt])).toEqual([
      ["g7", null, null],
      ["g8", null, null],
    ]);
    expect(JSON.stringify(s)).not.toMatch(/latex/i);
    expect(r.plan?.waitingForPhone).toBe(3);
    expect(r.summary).toMatch(/^Read 3 services done \(3 new\) from the sales accrual report\. 3 services done wait for a phone number\. Up to date\./);
    expect(s.plan.filter((p) => p.originType === "visit")).toEqual([]);
    expect(cursorOf(s.integration)).toBe("2026-10-03");

    // Guest 8's visit is already on a list the clinic uploaded, by number.
    await withTenant(c.org, (tx) => tx.insert(visits).values({ tenantId: c.org, phoneE164: e164(8), service: "prp - hair", visitDate: "2026-10-02", source: "upload" }));
    // Their Zenoti admin lets the key read guests; the next day's check sees it.
    z.allowed.add("guestDetails");
    z.guests.set("g7", profile(7, false, true));
    z.guests.set("g8", profile(8, false, false));
    z.seen.length = 0;

    r = await run(c.org, c.id, z, later(25));
    expect(r).toMatchObject({ tested: true, path: "sales_accrual", error: null });
    expect(z.asked("guestDetails").slice(1).map((q) => q.path).sort()).toEqual(["/v1/guests/g7", "/v1/guests/g8"]);
    expect(r.visits).toMatchObject({ numbered: 1, merged: 2 });
    expect(r.plan?.waitingForPhone).toBe(0);

    s = await stored(c.org);
    // One Hydrafacial visit for guest 7, now with their number; guest 8's line is the uploaded visit.
    expect(s.visits.map((v) => [v.externalId, v.phoneE164, v.service, v.source])).toEqual([
      ["i1:svc-hf", e164(7), "Hydrafacial", "api"],
      [null, e164(8), "prp - hair", "upload"],
    ]);
    expect(s.plan.some((p) => p.originId === s.visits[0]!.id)).toBe(true);

    // Read again later, the same line stays folded into the uploaded visit.
    r = await run(c.org, c.id, z, later(26));
    expect(r).toMatchObject({ tested: false, calls: 2, visits: { added: 0, merged: 1 } });
    s = await stored(c.org);
    expect(s.visits).toHaveLength(2);
    // Two runs changed something and were audited; this one found nothing new.
    expect(s.audit).toHaveLength(2);
  });

  it("falls back to the older sales report when Zenoti stops letting the key read appointments", async () => {
    const z = fakeZenoti(["salesReport"]);
    const c = await clinic({ backfillDays: 7, ...checked({ appointments: true, guestDetails: false, guestPackages: false, salesAccrual: false, salesReport: true }, "appointments") });
    // Bookings read while appointments were allowed: one past, one still to come.
    await withTenant(c.org, (tx) =>
      tx.insert(clinicAppointments).values([
        { tenantId: c.org, integrationId: c.id, externalId: "old", guestRef: "g5", service: "Peel", startsAt: new Date("2026-09-30T05:00:00Z"), status: "completed", centreRef: KONDAPUR },
        { tenantId: c.org, integrationId: c.id, externalId: "soon", guestRef: "g5", service: "Peel", startsAt: new Date("2026-10-06T05:00:00Z"), status: "booked", centreRef: KONDAPUR },
      ]),
    );
    const sold = (id: string, type: number, name: string) => ({
      invoice_no: "ZNKD-1001",
      guest: { guest_id: "g5", guest_name: "Guest Number 5", guest_code: "ZN5" },
      sold_on: "2026-09-30T18:57:04",
      serviced_on: "2026-09-30T14:45:00",
      center: { center_name: "Kondapur", center_code: "ZNKD" },
      item: { type, name, code: "LHR-FL" },
      quantity: 1,
      package_redemption: type === 0 ? 1500 : 0,
      invoice_item_id: id,
      employee: { name: "Dr. Asha", code: "E1", job_code: "TH" },
      tags: "VIP",
      promotion: "Package: LHR 5 Body Parts 5 Sessions",
      first_visit: "No",
      package: "LHR 5 Body Parts 5 Sessions",
    });
    // A session taken from the package is a service; the sale of the package itself is not.
    z.report.push(sold("ii-1", 0, "LHR Full Legs"), sold("ii-2", 4, "LHR 5 Body Parts 5 Sessions"));

    const r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ tested: true, path: "sales_report", bookings: { removed: 1 } });
    // The refused read, the key's check on the centres, the full check, then a span of history and one of recent days.
    expect(r.calls).toBe(1 + 1 + 6 + 2);
    expect(r.error).toBe("Zenoti does not let this key read appointments. Services done are read from Zenoti's older sales report instead.");
    expect(z.asked("salesReport").slice(1).map((q) => [q.query.get("start_date"), q.query.get("end_date"), q.query.get("item_type"), q.query.get("status")])).toEqual([
      ["2026-09-27", "2026-09-30", "0", "1"],
      ["2026-10-01", "2026-10-04", "0", "1"],
    ]);

    const s = await stored(c.org);
    expect(s.integration.config.access).toMatchObject({ path: "sales_report", capabilities: { appointments: false, salesReport: true } });
    expect(s.bookings.map((b) => b.externalId)).toEqual(["old"]);
    expect(s.visits.map((v) => [v.externalId, v.guestRef, v.phoneE164, v.service, v.visitDate, v.sessionsTotal, v.doctor])).toEqual([["ii-1", "g5", null, "LHR Full Legs", "2026-09-30", 5, "Dr. Asha"]]);
  });
});

describe("what a run that stopped says", () => {
  it("never repeats the names and numbers a database error carries", async () => {
    const c = await clinic({});
    const e = await withTenant(c.org, (tx) =>
      tx.insert(clinicAppointments).values({ tenantId: c.org, integrationId: c.id, externalId: "x", guestRef: "g9", phoneE164: e164(9), name: "Guest Number 9", service: "Peel", startsAt: NOW, status: "nonsense" as never }),
    ).catch((x: unknown) => x);
    // Drizzle's own message has the values in it.
    expect((e as Error).message).toContain(e164(9));
    const said = errorWithoutValues(e);
    expect(said).toMatch(/^JENAI's database refused to store what was read \(Postgres error 23514, [a-z_0-9]+\)\.$/);
    expect(said).not.toContain(e164(9));
    expect(said).not.toContain("Guest Number 9");
    expect(errorWithoutValues(new Error("Zenoti sent a day that does not exist."))).toBe("Zenoti sent a day that does not exist.");
  });
});

describe("what JENAI sends Zenoti", () => {
  it("only ever reads: GETs, and the accrual report's POST, with the key, to Zenoti's own host", () => {
    expect(everything.length).toBeGreaterThan(50);
    for (const r of everything) {
      expect(r.method === "GET" || (r.method === "POST" && r.path === ACCRUAL)).toBe(true);
      expect(r.host).toBe("api.zenoti.com");
      expect(r.auth).toBe(`apikey ${KEY}`);
    }
  });
});
