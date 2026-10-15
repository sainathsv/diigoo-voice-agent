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
import { endPull, takePullLease } from "./crm-sync";
import { sealCredentials } from "./queue";
import { errorWithoutValues, syncZenoti } from "./zenoti-sync";
import { importVisits, removeVisitUpload } from "../visits-import";

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

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A Zenoti holding what each test puts in it, whose key may read `allowed`. */
function fakeZenoti(allowed: Endpoint[]) {
  const z = {
    allowed: new Set<Endpoint>(allowed),
    centres: [...CENTRES.centers] as Array<Record<string, unknown>>,
    /** Asked first: an answer of a test's own for any request, or nothing for the usual one. */
    answer: null as ((r: Seen, e: Endpoint | "centres" | null) => Reply | undefined) | null,
    /** Sent with every answer, as Zenoti sends its rate limit headers. */
    headers: {} as Record<string, string>,
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
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...z.headers, ...headers } });
    const e = endpointOf(r);
    const own = z.answer?.(r, e);
    if (own) return reply(own.status, own.body ?? {}, own.headers);
    if (e === "centres") return reply(200, { centers: z.centres });
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
        return reply(200, z.appointments.filter((a) => (a.center_id ?? KONDAPUR) === q.get("center_id") && dayOf(a.start_time) >= from && dayOf(a.start_time) < to));
      }
      case "guestDetails": {
        const g = z.guests.get(guestId());
        return g ? reply(200, g) : reply(404, { code: "404", message: "Guest not found" });
      }
      case "guestPackages":
        return reply(200, z.packages.get(guestId()) ?? []);
      case "salesAccrual": {
        const [from, to] = [dayOf(r.body!.start_date), dayOf(r.body!.end_date)];
        const centres = r.body!.center_ids as string[];
        const rows = z.accrual.filter((x) => centres.includes(String(x.center_id)) && dayOf(x.sale_date) >= from && dayOf(x.sale_date) <= to);
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

/** A line of the sales accrual report. */
const sale = (invoice: string, day: string, guest: number, item: string, name: string, status = "Closed", centre = KONDAPUR) => ({
  sale_date: `${day}T00:00:00`,
  invoice_id: invoice,
  guest_id: `g${guest}`,
  guest_name: `Guest Number ${guest}`,
  center_id: centre,
  item_id: item,
  item_name: name,
  item_type: "Service",
  qty: 1,
  status,
  provider: "Dr. Asha",
  item_category: "Skin",
});

/** A line of the older sales report, serviced and sold on the days given. */
const sold = (id: string, guest: number, serviced: string, soldOn: string, name: string) => ({
  invoice_no: `ZNKD-${id}`,
  invoice_item_id: id,
  guest: { guest_id: `g${guest}`, guest_name: `Guest Number ${guest}`, guest_code: `ZN${guest}` },
  sold_on: `${soldOn}T18:00:00`,
  serviced_on: `${serviced}T14:45:00`,
  item: { type: 0, name, code: "X" },
  quantity: 1,
  employee: { name: "Dr. Asha", code: "E1", job_code: "TH" },
});

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
const checked = (capabilities: Record<Endpoint, boolean>, path: string, centres: Array<Record<string, unknown>> = [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", phoneCode: "91" }]) => ({
  centres,
  access: { capabilities, path, checkedAt: NOW.toISOString() },
});
const may = (...allowed: Endpoint[]): Record<Endpoint, boolean> => ({
  appointments: allowed.includes("appointments"),
  guestDetails: allowed.includes("guestDetails"),
  guestPackages: allowed.includes("guestPackages"),
  salesAccrual: allowed.includes("salesAccrual"),
  salesReport: allowed.includes("salesReport"),
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

const cursorOf = (i: { pullCursor: Record<string, unknown> }, centre = KONDAPUR) => (i.pullCursor.zenoti as Record<string, string> | undefined)?.[centre];
const spansAsked = (z: ReturnType<typeof fakeZenoti>) => z.asked("appointments").map((r) => [r.query.get("start_date"), r.query.get("end_date")]);
/** Bookings 15 to 60 days after 4 October, read once a day, after everything else. */
const FAR = [
  ["2026-10-19", "2026-10-26"],
  ["2026-10-26", "2026-11-02"],
  ["2026-11-02", "2026-11-09"],
  ["2026-11-09", "2026-11-16"],
  ["2026-11-16", "2026-11-23"],
  ["2026-11-23", "2026-11-30"],
  ["2026-11-30", "2026-12-04"],
];

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
      // The no-show on 20 Sep, already rebooked four weeks out.
      appointment("a8", 2, "2026-10-30", "11:00", 0, "PRP - Hair"),
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
    // The check (centres and five probes), 4 weeks of history, 3 spans of recent and coming days, 3 profiles, 1 guest's packages, then 7 weeks of bookings further ahead.
    expect(r.calls).toBe(6 + 4 + 3 + 3 + 1 + 7);
    expect(spansAsked(z).slice(1)).toEqual([
      ["2026-09-04", "2026-09-11"],
      ["2026-09-11", "2026-09-18"],
      ["2026-09-18", "2026-09-25"],
      ["2026-09-25", "2026-10-01"],
      ["2026-10-01", "2026-10-08"],
      ["2026-10-08", "2026-10-15"],
      ["2026-10-15", "2026-10-19"],
      ...FAR,
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
      ["a8", "booked"],
    ]);
    expect(s.bookings.find((b) => b.externalId === "a4")).toMatchObject({ guestRef: "g3", phoneE164: e164(3), startsAt: new Date("2026-10-10T04:30:00Z"), localDay: "2026-10-10", branchId: c.branchId, centreRef: KONDAPUR, doctor: "Dr. Asha" });

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

    // The plan has the check-in before the laser course's next sitting, and nobody waits for a number.
    expect(r.plan?.waitingForPhone).toBe(0);
    expect(s.plan.some((p) => p.originId === s.visits[1]!.id && p.journey === "course_checkin")).toBe(true);
    // The no-show is not called to rebook: the booking a month out was read too.
    const a2 = s.bookings.find((b) => b.externalId === "a2")!;
    expect(s.plan.find((p) => p.originId === a2.id)).toMatchObject({ journey: "no_show_rebook", verdict: "kept_out", reason: "Missed their appointment on Sun 20 Sep 2026 for PRP - Hair, but is booked again for Fri 30 Oct 2026." });

    // What the clinic and the logs see carries counts and centre names, never a guest's name or number.
    expect(r.summary).toBe("Read 8 bookings (8 new or changed) and 2 services done (2 new) from appointments. Read 3 guest profiles. Read the packages of 1 guest. Up to date. 24 of 30 calls to Zenoti used.");
    expect(s.integration.config.lastSync).toMatchObject({ path: "appointments", calls: 24, done: true, summary: r.summary });
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
      ["a8", "booked"],
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

    // 13 days of history, 18 recent and coming, and 46 further ahead are left.
    let r = await run(c.org, c.id, z, NOW, 2);
    expect(r).toMatchObject({ calls: 2, done: false, error: null, left: ["77 days at Kondapur"] });
    expect(r.summary).toMatch(/Left for next time: 77 days at Kondapur\. 2 of 2 calls to Zenoti used\.$/);
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-09-17");

    // A server error, and its retry, count against the budget too.
    z.failNext = 1;
    r = await run(c.org, c.id, z, later(1), 3);
    expect(r).toMatchObject({ calls: 3, done: false, error: null, left: ["64 days at Kondapur"] });
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-09-30");

    r = await run(c.org, c.id, z, later(2));
    expect(r).toMatchObject({ calls: 3 + 7, done: true, error: null, left: [] });
    expect(cursorOf((await stored(c.org)).integration)).toBe("2026-10-03");

    expect(spansAsked(z).map(([from]) => from)).toEqual(["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-18", "2026-09-25", "2026-10-01", "2026-10-08", "2026-10-15", ...FAR.map(([from]) => from)]);
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
    expect(r).toMatchObject({ calls: 5 + 7, done: true });
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
      ...FAR,
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
    // Guest 8's line takes over the visit the clinic uploaded; guest 7's second line folds into the first.
    expect(r.visits).toMatchObject({ numbered: 2, merged: 1 });
    expect(r.plan?.waitingForPhone).toBe(0);

    s = await stored(c.org);
    // One Hydrafacial visit for guest 7, now with their number; guest 8's line took over the uploaded visit, which keeps its id.
    expect(s.visits.map((v) => [v.externalId, v.phoneE164, v.service, v.source])).toEqual([
      ["i1:svc-hf", e164(7), "Hydrafacial", "api"],
      ["i3:svc-prp", e164(8), "PRP - Hair", "upload"],
    ]);
    expect(s.plan.some((p) => p.originId === s.visits[0]!.id)).toBe(true);

    // Read again later, the same line is that visit, with nothing new in it.
    r = await run(c.org, c.id, z, later(26));
    expect(r).toMatchObject({ tested: false, calls: 2, visits: { added: 0, updated: 0, merged: 0 } });
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


describe("guests Zenoti no longer has, or no longer gives a number for", () => {
  it("reads on past a guest merged away or deleted, and asks for them again only much later", async () => {
    const z = fakeZenoti(["salesAccrual", "guestDetails", "guestPackages"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("salesAccrual", "guestDetails", "guestPackages"), "sales_accrual") });
    z.accrual.push(sale("i1", "2026-10-02", 1, "s1", "Peel"), sale("i2", "2026-10-02", 2, "s1", "Peel"), sale("i3", "2026-10-02", 3, "s1", "Peel"), sale("i4", "2026-10-02", 4, "s1", "Peel"));
    // g1 was merged into another guest (400, as the fixture's "Invalid guest"); g2 was deleted (404); g4's profile has no mobile.
    z.answer = (r) => {
      if (r.path.startsWith("/v1/guests/g1")) return { status: 400, body: {} };
      if (r.path.startsWith("/v1/guests/g2")) return { status: 404, body: { message: "Guest not found" } };
      return undefined;
    };
    z.guests.set("g3", profile(3, true, true));
    z.guests.set("g4", { id: "g4", personal_info: { first_name: "Guest", last_name: "Number 4", mobile_phone: { country_code: 0, phone_code: 0, number: "" } } });
    z.packages.set("g3", [{ user_package_id: "up-3", status: 1, package: { name: "Peel 4 Sessions" }, date: { end: "2027-01-01T00:00:00" }, services: [{ service_type_info: { service_category_type: 2, name: "Peel" }, total: 4, used: 1, balance: 3 }] }]);

    const r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ error: null, done: true, guests: { read: 4, left: 0 }, packages: { guests: 4, rows: 1, left: 0 } });
    const s = await stored(c.org);
    expect(s.people.map((p) => [p.externalId, p.phoneE164, p.fetchedAt?.toISOString(), p.profileMisses, p.packagesFetchedAt?.toISOString()])).toEqual([
      ["g1", null, NOW.toISOString(), 3, NOW.toISOString()],
      ["g2", null, NOW.toISOString(), 3, NOW.toISOString()],
      ["g3", e164(3), NOW.toISOString(), 0, NOW.toISOString()],
      ["g4", null, NOW.toISOString(), 1, NOW.toISOString()],
    ]);
    expect(s.packages.map((p) => [p.guestRef, p.service])).toEqual([["g3", "Peel"]]);

    // The next day only the guest with no number is asked for again; the ones Zenoti does not have wait a month.
    z.seen.length = 0;
    await run(c.org, c.id, z, later(25));
    expect(z.asked("guestDetails").map((q) => q.path).filter((p) => !p.includes("00000000"))).toEqual(["/v1/guests/g4"]);
    // Then a week, then a month.
    z.seen.length = 0;
    const r3 = await run(c.org, c.id, z, later(25 + 4 * 24));
    expect(z.asked("guestDetails").map((q) => q.path).filter((p) => !p.includes("00000000"))).toEqual([]);
    expect(r3.guests.left).toBe(0);
    expect((await stored(c.org)).people.find((p) => p.externalId === "g4")?.profileMisses).toBe(2);
  });

  it("moves a guest's visits and bookings to the number they change to, and off one they remove", async () => {
    const z = fakeZenoti(["appointments", "guestDetails"]);
    const c = await clinic({ backfillDays: 30, ...checked(may("appointments", "guestDetails"), "appointments") });
    z.appointments.push(appointment("m1", 5, "2026-09-20", "11:00", 1, "LHR Full Legs"));
    z.guests.set("g5", profile(5, false, true));
    await run(c.org, c.id, z, NOW);
    let s = await stored(c.org);
    expect(s.visits.map((v) => [v.externalId, v.phoneE164])).toEqual([["m1", e164(5)]]);

    // A month on, their profile has a new number; their June visit is not read again, but moves with them.
    z.guests.set("g5", { ...profile(5, false, true), personal_info: { first_name: "Guest", last_name: "Number 5", mobile_phone: { country_code: 95, number: mobile(6) } } });
    let r = await run(c.org, c.id, z, later(24 * 31));
    expect(r.visits.numbered).toBe(1);
    s = await stored(c.org);
    expect(s.people[0]!.phoneE164).toBe(e164(6));
    expect(s.visits.map((v) => [v.externalId, v.phoneE164])).toEqual([["m1", e164(6)]]);
    expect(s.bookings.map((b) => [b.externalId, b.phoneE164])).toEqual([["m1", e164(6)]]);
    expect(s.plan.filter((p) => p.originId === s.visits[0]!.id).every((p) => p.phoneE164 === e164(6))).toBe(true);

    // Then the front desk removes the number: nothing is planned on the old one.
    z.guests.set("g5", { ...profile(5, false, true), personal_info: { first_name: "Guest", last_name: "Number 5", mobile_phone: { country_code: 95, number: "" } } });
    r = await run(c.org, c.id, z, later(24 * 62));
    s = await stored(c.org);
    expect(s.people[0]!.phoneE164).toBeNull();
    expect(s.visits.map((v) => [v.externalId, v.phoneE164])).toEqual([["m1", null]]);
    expect(s.bookings.map((b) => b.phoneE164)).toEqual([null]);
    expect(r.plan?.waitingForPhone).toBe(1);
    expect(s.plan.filter((p) => p.originId === s.visits[0]!.id)).toEqual([]);
  });
});

describe("visits read before their guest's number", () => {
  it("are given the mobile a booking brings once appointments may be read, and fold into its visit", async () => {
    const z = fakeZenoti(["salesReport"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("salesReport"), "sales_report") });
    z.report.push(sold("r1", 1, "2026-09-30", "2026-09-30", "Hydrafacial"), sold("r2", 2, "2026-10-02", "2026-10-02", "Peel"));
    let r = await run(c.org, c.id, z, NOW);
    expect(r.plan?.waitingForPhone).toBe(2);

    // Their Zenoti admin adds appointments; guest details stay refused. The next day's check moves to appointments.
    z.allowed.add("appointments");
    z.appointments.push(appointment("b1", 1, "2026-10-06", "11:00", 0, "Peel"), appointment("b2", 2, "2026-10-02", "15:00", 1, "Peel"));
    r = await run(c.org, c.id, z, later(25));
    expect(r).toMatchObject({ tested: true, path: "appointments" });
    expect(r.visits).toMatchObject({ numbered: 2, merged: 1 });
    expect(r.plan?.waitingForPhone).toBe(0);
    const s = await stored(c.org);
    // Guest 1's report visit has the number from their booking; guest 2's booking was the same visit as the report's.
    expect(s.visits.map((v) => [v.externalId, v.phoneE164, v.service, v.visitDate])).toEqual([
      ["r1", e164(1), "Hydrafacial", "2026-09-30"],
      ["r2", e164(2), "Peel", "2026-10-02"],
    ]);
    expect(s.plan.some((p) => p.originId === s.visits[0]!.id && p.phoneE164 === e164(1))).toBe(true);
  });

  it("are counted in the run's summary when the worker reads and plans after, as when the run plans itself", async () => {
    const z = fakeZenoti(["salesReport"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("salesReport"), "sales_report") });
    z.report.push(sold("r1", 1, "2026-09-30", "2026-09-30", "Hydrafacial"), sold("r2", 2, "2026-10-02", "2026-10-02", "Peel"));
    const r = await syncZenoti(c.org, c.id, { now: NOW, clock: clockAt(NOW), fetchImpl: z.fetchImpl, replan: false });
    expect(r.plan).toBeNull();
    expect(r.waitingForPhone).toBe(2);
    expect(r.summary).toMatch(/ 2 services done wait for a phone number\. /);
    const s = await stored(c.org);
    expect((s.integration.config.lastSync as Record<string, unknown>).summary).toBe(r.summary);
    expect(s.audit.at(-1)?.summary).toContain("2 services done wait for a phone number.");
  });

  it("still have their guest's packages read when they folded into an uploaded visit", async () => {
    const z = fakeZenoti(["appointments", "guestPackages"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("appointments", "guestPackages"), "appointments") });
    // The clinic uploaded the day's visits before the sync ran.
    const [up] = await withTenant(c.org, (tx) => tx.insert(visits).values({ tenantId: c.org, phoneE164: e164(4), service: "Hydrafacial", visitDate: "2026-10-02", source: "upload" }).returning());
    z.appointments.push(appointment("u1", 4, "2026-10-02", "11:00", 1, "Hydrafacial"));
    z.packages.set("g4", [{ user_package_id: "up-4", status: 1, package: { name: "Hydrafacial 6 sittings" }, date: { end: "2027-01-01T00:00:00" }, services: [{ service_type_info: { service_category_type: 2, name: "Hydrafacial" }, total: 6, used: 2, balance: 4 }] }]);

    const r = await run(c.org, c.id, z, NOW);
    expect(r.visits).toMatchObject({ added: 0, updated: 1, merged: 0 });
    expect(z.asked("guestPackages").map((q) => q.path)).toEqual(["/v1/guests/g4/Packages"]);
    const s = await stored(c.org);
    expect(s.packages.map((p) => [p.guestRef, p.service, p.balance, p.phoneE164])).toEqual([["g4", "Hydrafacial", 4, e164(4)]]);
    expect(s.visits).toHaveLength(1);
    expect(s.visits[0]).toMatchObject({ id: up!.id, sessionsTotal: 6, sessionsDone: 2 });
    expect(s.plan.some((p) => p.originId === up!.id && p.journey === "course_checkin")).toBe(true);
  });

  it("reads a package for a whole category against the visits' categories", async () => {
    const z = fakeZenoti(["appointments", "guestPackages"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("appointments", "guestPackages"), "appointments") });
    const a = appointment("k1", 3, "2026-10-02", "11:00", 1, "LHR Full Legs");
    z.appointments.push({ ...a, service: { ...a.service, category: { name: "Laser" }, sub_category: { name: "Hair Reduction" } } });
    z.packages.set("g3", [
      {
        user_package_id: "up-3",
        status: 1,
        package: { name: "Any Hair Reduction, 6 Sessions" },
        date: { end: "2027-01-01T00:00:00" },
        services: [{ service_type_info: { service_category_type: 1, name: "Hair Reduction" }, total: 6, used: 2, balance: 4 }],
      },
    ]);
    await run(c.org, c.id, z, NOW);
    const s = await stored(c.org);
    expect(s.packages.map((p) => [p.service, p.covers, p.balance])).toEqual([["Hair Reduction", "category", 4]]);
    expect(s.visits[0]).toMatchObject({ categories: ["Laser", "Hair Reduction"], sessionsTotal: 6, sessionsDone: 2 });
    // Planned from the package: the 2nd of 6 sittings, so the check-in before the next and no feedback call.
    expect(s.plan.filter((p) => p.originId === s.visits[0]!.id).map((p) => [p.journey, p.verdict])).toEqual([["course_checkin", "scheduled"]]);
  });
});

describe("visits on a list the clinic uploaded as well", () => {
  const visitIds = (s: Awaited<ReturnType<typeof stored>>) => s.plan.filter((p) => p.originType === "visit").map((p) => p.id).sort();

  it("stay when the upload is removed, whether the upload or Zenoti had the visit first, with their planned calls", async () => {
    const z = fakeZenoti(["appointments", "guestDetails"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("appointments", "guestDetails"), "appointments") });
    // The clinic uploads a visit, then Zenoti reads the same one: the uploaded visit becomes Zenoti's, keeping its id.
    const first = await importVisits(c.org, `Mobile,Service,Date\n${mobile(4)},hydrafacial,02/10/2026`, { now: NOW });
    const [up] = await withTenant(c.org, (tx) => tx.select().from(visits).where(eq(visits.batch, first.batch)));
    z.appointments.push(appointment("u1", 4, "2026-10-02", "11:00", 1, "Hydrafacial"), appointment("u2", 5, "2026-10-01", "12:00", 1, "Peel"));
    // Guest 4's profile gives no number: the number the clinic uploaded stays on their visit.
    z.guests.set("g4", { id: "g4", personal_info: { first_name: "Guest", last_name: "Number 4", mobile_phone: { country_code: 95, number: "" } } });
    z.guests.set("g5", profile(5, false, true));
    const r = await run(c.org, c.id, z, NOW);
    expect(r.visits).toMatchObject({ added: 1, updated: 1, merged: 0 });
    let s = await stored(c.org);
    expect(s.visits.map((v) => [v.id === up!.id, v.externalId, v.integrationId, v.phoneE164, v.service, v.batch, v.source])).toEqual([
      [true, "u1", c.id, e164(4), "Hydrafacial", null, "upload"],
      [false, "u2", c.id, e164(5), "Peel", null, "api"],
    ]);
    expect(s.visits[0]!.centreRef).toBe(KONDAPUR);

    // Zenoti had guest 5's visit first; an upload adds its session count, and leaves it Zenoti's.
    const second = await importVisits(c.org, `Mobile,Service,Date,Sessions Done\n${mobile(5)},Peel,01/10/2026,2`, { now: NOW });
    expect(second).toMatchObject({ added: 0, updated: 1 });
    s = await stored(c.org);
    expect(s.visits[1]).toMatchObject({ externalId: "u2", sessionsDone: 2, batch: null });
    const planned = visitIds(s);
    expect(planned.length).toBeGreaterThan(0);

    // Both uploads removed: Zenoti reads those days once only, so its visits stay, and so do their calls.
    expect(await removeVisitUpload(c.org, first.batch, { now: NOW })).toMatchObject({ removed: 0, kept: 0 });
    expect(await removeVisitUpload(c.org, second.batch, { now: NOW })).toMatchObject({ removed: 0, kept: 0 });
    s = await stored(c.org);
    expect(s.visits.map((v) => v.externalId)).toEqual(["u1", "u2"]);
    expect(visitIds(s)).toEqual(planned);

    // A visit stamped with an upload's batch before uploads stopped doing that is let go of by it, not deleted.
    const old = randomUUID();
    await withTenant(c.org, (tx) => tx.update(visits).set({ batch: old }).where(eq(visits.externalId, "u2")));
    expect(await removeVisitUpload(c.org, old, { now: NOW })).toMatchObject({ removed: 0, kept: 1 });
    s = await stored(c.org);
    expect(s.visits.find((v) => v.externalId === "u2")).toMatchObject({ batch: null });
    // The upload's own visits still go.
    const third = await importVisits(c.org, `Mobile,Service,Date\n${mobile(6)},Peel,01/10/2026`, { now: NOW });
    expect(await removeVisitUpload(c.org, third.batch, { now: NOW })).toMatchObject({ removed: 1, kept: 0 });
    expect((await stored(c.org)).visits).toHaveLength(2);
  });
});

describe("clinics with several centres", () => {
  const GACHIBOWLI = "5b0c8a1e-2f43-4d7a-9a1b-6c3e2d1f0a99";
  const JUBILEE = "9e7d6c5b-4a39-4281-8f0e-1d2c3b4a5e6f";
  const HITEC = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
  const centre = (id: string, name: string, code: string) => ({ id, name, code, phoneCode: "91" });
  const named = (z: ReturnType<typeof fakeZenoti>) => z.asked("appointments").map((r) => r.query.get("center_id"));

  it("sets aside a centre Zenoti keeps refusing, names it, and reads the others, their guests and their visits under the branch's name", async () => {
    const z = fakeZenoti(["appointments", "guestDetails"]);
    const centres = [centre(KONDAPUR, "Zennara Clinics - Kondapur", "ZNKD"), centre(GACHIBOWLI, "Zennara Gachibowli", "ZNGB"), centre(JUBILEE, "Zennara Jubilee Hills", "ZNJH")];
    const c = await clinic({ backfillDays: 0, ...checked(may("appointments", "guestDetails"), "appointments", centres) });
    z.answer = (r, e) => (e === "appointments" && r.query.get("center_id") === GACHIBOWLI ? { status: 400, body: {} } : undefined);
    z.appointments.push(appointment("k1", 1, "2026-10-02", "11:00", 1, "Peel"), { ...appointment("j1", 2, "2026-10-02", "12:00", 1, "Peel"), center_id: JUBILEE });
    z.guests.set("g1", profile(1, false, true));
    z.guests.set("g2", profile(2, false, true));

    let r = await run(c.org, c.id, z, NOW);
    expect(r.error).toBe(
      "At Zennara Gachibowli (ZNGB): Zenoti refused a request for appointments (HTTP 400). JENAI tries Zennara Gachibowli (ZNGB) again after 4 Oct 2026 at 12:30, and reads the other centres meanwhile.",
    );
    expect(r.guests.read).toBe(2);
    expect(r.centres.map((x) => [x.name, x.spans, x.problem !== null])).toEqual([
      ["Zennara Clinics - Kondapur", 3 + 7, false],
      ["Zennara Gachibowli", 0, true],
      ["Zennara Jubilee Hills", 3 + 7, false],
    ]);
    let s = await stored(c.org);
    // Kondapur is the JENAI branch the centre is: its visits carry that name, as its bookings do in the plan.
    expect(s.visits.map((v) => [v.externalId, v.branch, v.centreRef])).toEqual([
      ["j1", "Zennara Jubilee Hills", JUBILEE],
      ["k1", "Kondapur", KONDAPUR],
    ]);

    // Within the hour it is not asked again, and still named.
    z.seen.length = 0;
    r = await run(c.org, c.id, z, later(0.5));
    expect(named(z)).toEqual([]);
    expect(r.error).toMatch(/^At Zennara Gachibowli \(ZNGB\): .* JENAI tries Zennara Gachibowli \(ZNGB\) again after 4 Oct 2026 at 12:30\.$/);

    // After it, it is; once Zenoti reads it again, it is no longer set aside.
    z.answer = null;
    z.seen.length = 0;
    r = await run(c.org, c.id, z, later(2));
    expect(named(z).filter((id) => id === GACHIBOWLI)).toHaveLength(3 + 7);
    expect(r.error).toBeNull();
    s = await stored(c.org);
    expect((s.integration.pullCursor.zenotiErrors as Record<string, unknown> | undefined) ?? {}).toEqual({});
  });

  it("takes a permission refused at one centre for that centre's, without checking the key again every run", async () => {
    const z = fakeZenoti(["appointments"]);
    const centres = [centre(KONDAPUR, "Kondapur", "ZNKD"), centre(GACHIBOWLI, "Zennara Gachibowli", "ZNGB")];
    const c = await clinic({ backfillDays: 0, ...checked(may("appointments"), "appointments", centres) });
    z.answer = (r, e) => (e === "appointments" && r.query.get("center_id") === GACHIBOWLI ? { status: 401, body: DENIED } : undefined);
    let r = await run(c.org, c.id, z, NOW);
    expect(r.tested).toBe(false);
    expect(r.error).toBe(
      "Zenoti does not let this key read appointments at Zennara Gachibowli (ZNGB), though it may at other centres. Ask your Zenoti admin to give the backend app made for JENAI access to that centre (in Zenoti: Configuration, then Apps under Integrations). JENAI tries Zennara Gachibowli (ZNGB) again after 5 Oct 2026 at 11:30, and reads the other centres meanwhile.",
    );
    expect(r.centres.find((x) => x.centreId === KONDAPUR)?.spans).toBe(3 + 7);
    // Within the day it is not asked again.
    z.seen.length = 0;
    r = await run(c.org, c.id, z, later(2));
    expect(named(z)).toEqual([KONDAPUR, KONDAPUR, KONDAPUR]);
    expect(r.tested).toBe(false);
  });

  it("takes the centres in turns, least recently read first, and leaves guests a share of the calls", async () => {
    const z = fakeZenoti(["appointments", "guestDetails"]);
    const centres = [centre(KONDAPUR, "Kondapur", "ZNKD"), centre(GACHIBOWLI, "Gachibowli", "ZNGB"), centre(JUBILEE, "Jubilee Hills", "ZNJH"), centre(HITEC, "Hitec City", "ZNHC")];
    const c = await clinic({ backfillDays: 0, ...checked(may("appointments", "guestDetails"), "appointments", centres) });
    for (const n of [1, 2, 3, 4]) {
      z.appointments.push(appointment(`k${n}`, n, "2026-10-02", "11:00", 0, "Peel"));
      z.guests.set(`g${n}`, profile(n, false, true));
    }
    // 10 calls: services take 6, two centres' recent days; the other 4 read the guests' profiles.
    let r = await run(c.org, c.id, z, NOW, 10);
    expect(new Set(named(z))).toEqual(new Set([KONDAPUR, GACHIBOWLI]));
    expect(r).toMatchObject({ calls: 10, guests: { read: 4 } });
    expect(r.left).toEqual(expect.arrayContaining(["64 days at Jubilee Hills", "64 days at Hitec City"]));

    // The centres not read go first next time.
    z.seen.length = 0;
    r = await run(c.org, c.id, z, later(2), 6);
    expect(named(z)).toEqual([JUBILEE, JUBILEE, JUBILEE, HITEC, HITEC, HITEC]);
    z.seen.length = 0;
    await run(c.org, c.id, z, later(4), 6);
    expect(named(z)).toEqual([KONDAPUR, KONDAPUR, KONDAPUR, GACHIBOWLI, GACHIBOWLI, GACHIBOWLI]);
  });

  it("goes by the centre's own time zone and country, so a late booking on a span's edge stays and a mobile gets its code", async () => {
    const DUBAI = "d0bad0ba-1111-4222-8333-944455556666";
    const z = fakeZenoti(["appointments"]);
    const c = await clinic({ backfillDays: 0, ...checked(may("appointments"), "appointments", [{ id: DUBAI, name: "Dubai Marina", code: "DXB", phoneCode: "971", timeZone: "Asia/Dubai" }]) });
    // 23:00 in Dubai on 7 October is already 8 October in India, where the client is.
    z.appointments.push({
      ...appointment("x1", 1, "2026-10-07", "23:00", 0, "Peel"),
      center_id: DUBAI,
      start_time_utc: "2026-10-07T19:00:00",
      guest: { id: "g-dxb", first_name: "Guest", last_name: "Dubai", mobile: { country_id: 0, number: "501234567" } },
    });
    await run(c.org, c.id, z, NOW);
    const s = await stored(c.org);
    expect(s.bookings.map((b) => [b.externalId, b.localDay, b.startsAt.toISOString(), b.phoneE164, b.branchId])).toEqual([["x1", "2026-10-07", "2026-10-07T19:00:00.000Z", "+971501234567", null]]);
  });
});

describe("sales lines Zenoti no longer lists", () => {
  it("removes a line voided or opened again when its days are read again, and keeps older days as they were", async () => {
    const z = fakeZenoti(["salesAccrual"]);
    const c = await clinic({ backfillDays: 10, ...checked(may("salesAccrual"), "sales_accrual") });
    z.accrual.push(sale("v1", "2026-10-02", 1, "s1", "Peel"), sale("v2", "2026-10-01", 2, "s1", "Hydrafacial"), sale("v3", "2026-09-28", 3, "s1", "Peel"));
    await run(c.org, c.id, z, NOW);
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["v1:s1", "v2:s1", "v3:s1"]);

    // v1's invoice is opened again, v2's voided; v3 is history, not read again.
    z.accrual[0]!.status = "Open";
    z.accrual.splice(1, 2);
    const r = await run(c.org, c.id, z, later(2));
    expect(r.visits.removed).toBe(2);
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["v3:s1"]);
  });

  it("removes a line from the older report only when its service and sale both fall in the days read again", async () => {
    const z = fakeZenoti(["salesReport"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("salesReport"), "sales_report") });
    // r1 was serviced on 30 September and invoiced the day after.
    z.report.push(sold("r1", 1, "2026-09-30", "2026-10-01", "Peel"), sold("r2", 2, "2026-10-02", "2026-10-02", "Peel"));
    await run(c.org, c.id, z, NOW);
    expect((await stored(c.org)).visits.map((v) => [v.externalId, v.visitDate, v.listedOn])).toEqual([
      ["r1", "2026-09-30", "2026-10-01"],
      ["r2", "2026-10-02", "2026-10-02"],
    ]);
    z.report.length = 0;
    const r = await run(c.org, c.id, z, later(2));
    expect(r.visits.removed).toBe(1);
    expect((await stored(c.org)).visits.map((v) => v.externalId)).toEqual(["r1"]);
  });
});

describe("long reports", () => {
  it("carries on a span of the accrual report from the page it stopped at, at Zenoti's own page size", async () => {
    const z = fakeZenoti(["salesAccrual"]);
    const c = await clinic({ backfillDays: 0, reportPageSize: 2, ...checked(may("salesAccrual"), "sales_accrual") });
    for (const n of [1, 2, 3, 4, 5]) z.accrual.push(sale(`p${n}`, "2026-10-02", n, "s1", "Peel"));
    const pages = () => z.asked("salesAccrual").map((q) => [q.query.get("Page"), q.query.get("Size")]);

    let r = await run(c.org, c.id, z, NOW, 2);
    expect(r).toMatchObject({ calls: 2, done: false });
    expect((await stored(c.org)).integration.pullCursor.zenotiPage).toMatchObject({ [KONDAPUR]: { from: "2026-10-01", to: "2026-10-04", page: 3, seen: 4 } });
    r = await run(c.org, c.id, z, later(0.5), 1);
    expect(r).toMatchObject({ calls: 1, done: true });
    expect(pages()).toEqual([
      ["1", "2"],
      ["2", "2"],
      ["3", "2"],
    ]);
    const s = await stored(c.org);
    expect(s.visits).toHaveLength(5);
    expect(s.integration.pullCursor.zenotiPage).toEqual({});

    // A Zenoti that gives at most 2 rows a page, whatever is asked: every row is still read.
    const capped = fakeZenoti(["salesAccrual"]);
    const d = await clinic({ backfillDays: 0, reportPageSize: 4, ...checked(may("salesAccrual"), "sales_accrual") });
    for (const n of [1, 2, 3, 4, 5]) capped.accrual.push(sale(`q${n}`, "2026-10-02", n, "s1", "Peel"));
    capped.answer = (q, e) => {
      if (e !== "salesAccrual") return undefined;
      const [page, size] = [Number(q.query.get("Page")), Math.min(2, Number(q.query.get("Size")))];
      return { status: 200, body: { sales: capped.accrual.slice((page - 1) * size, page * size), page_info: { total: capped.accrual.length, page, size } } };
    };
    await run(d.org, d.id, capped, NOW);
    expect(capped.asked("salesAccrual").map((q) => [q.query.get("Page"), q.query.get("Size")])).toEqual([
      ["1", "4"],
      ["2", "2"],
      ["3", "2"],
    ]);
    expect((await stored(d.org)).visits).toHaveLength(5);
  });

  it("falls back to the older report when the accrual report says the key cannot access it", async () => {
    const z = fakeZenoti(["salesReport"]);
    const c = await clinic({ backfillDays: 7, ...checked(may("salesAccrual", "salesReport"), "sales_accrual") });
    z.answer = (_r, e) => (e === "salesAccrual" ? { status: 400, body: { code: 918, message: "cannot access" } } : undefined);
    const r = await run(c.org, c.id, z, NOW);
    expect(r).toMatchObject({ tested: true, path: "sales_report" });
    expect(r.error).toBe("Zenoti does not let this key read the sales accrual report. Services done are read from Zenoti's older sales report instead.");
    expect(r.calls).toBe(1 + 6 + 2);
  });
});

describe("a busy Zenoti", () => {
  it("stops a run before its hold on the connection runs out, however slowly Zenoti lets it in", async () => {
    const z = fakeZenoti(["appointments"]);
    const c = await clinic({ ...checked(may("appointments"), "appointments") });
    // The clinic's other apps keep the organisation's minute spent: every call waits a minute.
    z.headers = { "ratelimit-remaining": "0", "ratelimit-reset": "60" };
    const r = await run(c.org, c.id, z, NOW, 400);
    // The 15 minute lease, less 2 minutes to spare: 13 calls a minute apart.
    expect(r).toMatchObject({ calls: 13, error: null, done: false });
    expect(r.left[0]).toMatch(/days at Kondapur$/);
    expect((await stored(c.org)).integration.pullLeaseUntil).toBeNull();
  });

  it("lets go only of its own hold on the connection", async () => {
    const c = await clinic({});
    const first = (await takePullLease(c.org, c.id))!;
    // It outlived its lease, and another run took the connection.
    await withTenant(c.org, (tx) => tx.update(integrations).set({ pullLeaseUntil: new Date(Date.now() - 1000) }).where(eq(integrations.id, c.id)));
    const second = (await takePullLease(c.org, c.id))!;
    await endPull(c.org, c.id, null, first.lease);
    expect((await stored(c.org)).integration.pullLeaseUntil).toEqual(second.lease);
    await endPull(c.org, c.id, null, second.lease);
    expect((await stored(c.org)).integration.pullLeaseUntil).toBeNull();
  });

  it("waits as long as Zenoti asked when that is longer than a run waits", async () => {
    const z = fakeZenoti(["appointments"]);
    const c = await clinic({ backfillDays: 0, ...checked(may("appointments"), "appointments") });
    z.answer = (_r, e) => (e === "appointments" ? { status: 429, body: {}, headers: { "retry-after": "600" } } : undefined);
    let r = await run(c.org, c.id, z, NOW);
    expect(r.calls).toBe(1);
    expect(r.error).toBe("Zenoti asked JENAI to slow down while reading appointments. It asked JENAI to wait until 4 Oct 2026 at 11:40, so nothing more is read before then.");
    z.answer = null;
    z.seen.length = 0;
    r = await run(c.org, c.id, z, later(0.05));
    expect(r).toMatchObject({ calls: 0, error: null, left: ["everything, as Zenoti asked JENAI to wait until 4 Oct 2026 at 11:40"] });
    expect(z.seen).toEqual([]);
    r = await run(c.org, c.id, z, later(0.5));
    expect(r.calls).toBeGreaterThan(0);
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
