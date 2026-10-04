/**
 * The zenoti command line, against a fake Zenoti and the local database.
 * Nothing here reaches the real Zenoti: every command is handed a fake fetch
 * and a fake clock. The fake answers by method and path as Zenoti documents
 * them, accepts only the key it was given, and refuses what the key may not
 * read with the 401 Zennara's key was seen to get.
 */
import "./env";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { credentialsOf } from "@jenai/engine";
import { auditEvents, branches, integrations, organizations, platformDb, visits, withTenant } from "../index";
import { ZenotiCommandError, connectCommand, readZenotiKeyFile, syncCommand, testCommand, type ZenotiCommandDeps } from "./zenoti-commands";

const KEY = "zen-cli-key-0123456789abcdef";
const NEW_KEY = "zen-cli-key-fedcba9876543210";
const APP_SECRET = "zen-cli-app-secret-kept-quiet";
const KONDAPUR = "80963e4e-6625-4b83-8b88-9708c0cb2303";
const DENIED = { Message: "Authorization has been denied for this request." };
const ACCRUAL = "/v1/reports/sales/accrual_basis/flat_file";
/** 11:30 in Hyderabad on 4 October 2026. */
const NOW = new Date("2026-10-04T06:00:00Z");

type Endpoint = "appointments" | "guestDetails" | "guestPackages" | "salesAccrual" | "salesReport";
const ALL: Endpoint[] = ["appointments", "guestDetails", "guestPackages", "salesAccrual", "salesReport"];

function endpointOf(method: string, p: string): Endpoint | "centres" | null {
  if (method === "GET" && p === "/v1/centers") return "centres";
  if (method === "GET" && p === "/v1/appointments") return "appointments";
  if (method === "GET" && /^\/v1\/guests\/[^/]+$/.test(p)) return "guestDetails";
  if (method === "GET" && /^\/v1\/guests\/[^/]+\/Packages$/.test(p)) return "guestPackages";
  if (method === "POST" && p === ACCRUAL) return "salesAccrual";
  if (method === "GET" && p === "/v1/sales/salesreport") return "salesReport";
  return null;
}

/** Guest n's mobile as the front desk typed it. */
const mobile = (n: number) => `984800000${n}`;

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

/** A Zenoti that accepts `key` and lets it read `allowed`. */
function fakeZenoti(allowed: Endpoint[], key = KEY) {
  const z = {
    key,
    allowed: new Set<Endpoint>(allowed),
    appointments: [] as Array<Record<string, unknown>>,
    guests: new Map<string, Record<string, unknown>>(),
    seen: [] as Array<{ method: string; host: string; path: string; auth: string | null }>,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    z.seen.push({ method, host: url.host, path: url.pathname, auth });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    // A key Zenoti does not know is refused everywhere, the centres included.
    if (auth !== `apikey ${z.key}`) return reply(401, DENIED);
    const e = endpointOf(method, url.pathname);
    if (e === "centres") return reply(200, { centers: [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", country: { name: "India", phone_code: "91" } }] });
    if (!e) return reply(404, { message: "Not found" });
    if (!z.allowed.has(e)) return reply(401, DENIED);
    const q = url.searchParams;
    switch (e) {
      case "appointments": {
        const [from, to] = [q.get("start_date")!, q.get("end_date")!];
        return reply(200, z.appointments.filter((a) => String(a.start_time).slice(0, 10) >= from && String(a.start_time).slice(0, 10) < to));
      }
      case "guestDetails": {
        const g = z.guests.get(decodeURIComponent(url.pathname.split("/")[3]!));
        return g ? reply(200, g) : reply(404, { code: "404", message: "Guest not found" });
      }
      case "guestPackages":
        return reply(200, []);
      case "salesAccrual":
        return reply(200, { sales: [], page_info: { total: 0, page: 1, size: 1 } });
      case "salesReport":
        return reply(200, { center_sales_report: [], Error: null });
    }
  }) as typeof fetch;
  return Object.assign(z, { fetchImpl });
}

function clockAt(at: Date) {
  let t = at.getTime();
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** What a command printed, and the fakes it ran against. */
function terminal(z: ReturnType<typeof fakeZenoti>) {
  const lines: string[] = [];
  const deps: ZenotiCommandDeps = { print: (l) => lines.push(l), fetchImpl: z.fetchImpl, clock: clockAt(NOW), now: NOW };
  return { lines, deps, text: () => lines.join("\n") };
}

const dir = await mkdtemp(path.join(tmpdir(), "jenai-zenoti-cli-"));
const keyFile = async (name: string, content: string, mode = 0o600) => {
  const f = path.join(dir, name);
  await writeFile(f, content);
  await chmod(f, mode);
  return f;
};

const orgs: string[] = [];

/** A clinic with a Kondapur branch and no Zenoti yet. */
async function clinic() {
  const slug = `zenoti-cli-${randomUUID().slice(0, 8)}`;
  const [o] = await platformDb().insert(organizations).values({ kind: "client", name: "Zenoti CLI Clinic", slug, status: "active", vertical: "derma", languages: ["en"] }).returning();
  orgs.push(o!.id);
  const [b] = await withTenant(o!.id, (tx) => tx.insert(branches).values({ tenantId: o!.id, name: "Kondapur", languages: ["en"] }).returning());
  return { org: o!.id, slug, branchId: b!.id };
}

const zenotiOf = (org: string) => withTenant(org, (tx) => tx.select().from(integrations).where(eq(integrations.kind, "zenoti")));
const auditOf = (org: string) => withTenant(org, (tx) => tx.select().from(auditEvents).orderBy(auditEvents.createdAt));

afterAll(async () => {
  if (orgs.length) await platformDb().delete(organizations).where(inArray(organizations.id, orgs));
  await rm(dir, { recursive: true, force: true });
});

describe("the key file", () => {
  const refused = async (content: string, why: RegExp) => {
    const e = await readZenotiKeyFile(await keyFile(`k-${randomUUID()}.json`, content)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ZenotiCommandError);
    expect((e as Error).message).toMatch(why);
    // Never quotes what was in the file.
    for (const secret of [KEY, APP_SECRET, "app-77"]) expect((e as Error).message).not.toContain(secret);
  };

  it("is refused without an api_key, or with one that cannot be used, without quoting it", async () => {
    await refused(JSON.stringify({ app_id: "app-77", app_secret: APP_SECRET }), /There is no "api_key"/);
    await refused(JSON.stringify({ api_key: "   ", app_secret: APP_SECRET }), /There is no "api_key"/);
    await refused(`api_key=${KEY}`, /is not JSON/);
    await refused(`{"api_key": "${KEY}",}`, /is not JSON/);
    await refused(JSON.stringify([KEY]), /not in the right shape/);
    await refused(JSON.stringify({ api_key: 12345 }), /"api_key" should be text/);
    await refused(JSON.stringify({ api_key: `${KEY}\nAuthorization: x` }), /"api_key" has spaces or characters/);
    await refused(JSON.stringify({ api_key: KEY, app_secret: `${APP_SECRET} with spaces` }), /"app_secret" has spaces or characters/);
    await expect(readZenotiKeyFile(path.join(dir, "missing.json"))).rejects.toThrow(/There is no key file at/);
    await expect(readZenotiKeyFile("")).rejects.toThrow(/need --file/);
  });

  it("gives the three values, trimmed, and nothing else, and says when other accounts can read it", async () => {
    const content = JSON.stringify({ api_key: ` ${KEY} `, app_id: "app-77", app_secret: APP_SECRET, base_url: "https://example.com" });
    expect(await readZenotiKeyFile(await keyFile("good.json", content))).toEqual({ credentials: { api_key: KEY, app_id: "app-77", app_secret: APP_SECRET }, openToOthers: false });
    expect(await readZenotiKeyFile(await keyFile("open.json", JSON.stringify({ api_key: KEY }), 0o644))).toEqual({ credentials: { api_key: KEY }, openToOthers: true });
  });
});

describe("zenoti connect", () => {
  it("stores the key sealed, tests it, maps the centre to its branch, and prints what the key may read, never the key", async () => {
    const c = await clinic();
    const z = fakeZenoti(["appointments", "guestDetails", "guestPackages", "salesAccrual"]);
    const t = terminal(z);
    const file = await keyFile("connect.json", JSON.stringify({ api_key: KEY, app_id: "app-77", app_secret: APP_SECRET }), 0o644);
    const check = await connectCommand({ tenant: c.slug, file }, t.deps);
    expect(check.ok).toBe(true);

    const [i, ...more] = await zenotiOf(c.org);
    expect(more).toEqual([]);
    expect(i).toMatchObject({ name: "Zenoti", direction: "in", status: "connected", lastError: null, events: [] });
    expect(i!.credentials).not.toContain(KEY);
    expect(credentialsOf(i!)).toEqual({ api_key: KEY, app_id: "app-77", app_secret: APP_SECRET });
    expect(i!.config).toMatchObject({
      centres: [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", phoneCode: "91" }],
      access: { path: "appointments", capabilities: { appointments: true, guestDetails: true, guestPackages: true, salesAccrual: true, salesReport: false } },
      branchMap: { [KONDAPUR]: c.branchId },
    });

    const out = t.text();
    expect(out).toContain("Zenoti CLI Clinic: Zenoti key stored on a new connection, sealed.");
    expect(out).toMatch(/^ {2}CONNECTED$/m);
    expect(out).toContain("Kondapur (ZNKD)  is JENAI's Kondapur branch");
    expect(out).toMatch(/appointments\s+allowed/);
    expect(out).toMatch(/guests' packages\s+allowed/);
    expect(out).toMatch(/older sales report\s+not allowed/);
    expect(out).toContain("services done from  appointments (with each patient's mobile)");
    expect(out).toContain(`Delete ${file} now`);
    expect(out).toContain("other accounts on this machine can read it");
    for (const secret of [KEY, APP_SECRET]) expect(out).not.toContain(secret);

    // Audited, without a secret in sight.
    const trail = await auditOf(c.org);
    expect(trail.map((a) => a.action)).toEqual(["integration.connected", "integration.tested"]);
    expect(trail[0]).toMatchObject({ via: "system", actorUserId: null, targetId: i!.id, diff: { kind: "zenoti", given: ["api_key", "app_id", "app_secret"] } });
    expect(trail[1]!.diff).toMatchObject({ ok: true, path: "appointments", centres: 1 });
    for (const secret of [KEY, APP_SECRET]) expect(JSON.stringify(trail)).not.toContain(secret);

    // Only reads, with the key, to Zenoti's own host.
    expect(z.seen.length).toBe(6);
    for (const r of z.seen) {
      expect(r.method === "GET" || (r.method === "POST" && r.path === ACCRUAL)).toBe(true);
      expect(r.host).toBe("api.zenoti.com");
      expect(r.auth).toBe(`apikey ${KEY}`);
    }
  });

  it("connecting again replaces the key on the same connection and keeps its settings", async () => {
    const c = await clinic();
    await connectCommand({ tenant: c.slug, file: await keyFile("first.json", JSON.stringify({ api_key: KEY })) }, terminal(fakeZenoti(ALL)).deps);
    const [before] = await zenotiOf(c.org);
    await withTenant(c.org, (tx) =>
      tx
        .update(integrations)
        .set({ name: "Zenoti (front desk)", config: { ...before!.config, backfillDays: 200, onlyCentres: ["ZNKD"] } })
        .where(eq(integrations.id, before!.id)),
    );

    const z = fakeZenoti(["salesAccrual", "guestDetails"], NEW_KEY);
    const t = terminal(z);
    await connectCommand({ tenant: c.slug, file: await keyFile("second.json", JSON.stringify({ api_key: NEW_KEY })) }, t.deps);
    const [i, ...more] = await zenotiOf(c.org);
    expect(more).toEqual([]);
    expect(i!.id).toBe(before!.id);
    expect(credentialsOf(i!)).toEqual({ api_key: NEW_KEY });
    expect(i).toMatchObject({ name: "Zenoti (front desk)", status: "connected" });
    // The settings stay; what the key may read is what the new key may read.
    expect(i!.config).toMatchObject({ backfillDays: 200, onlyCentres: ["ZNKD"], branchMap: { [KONDAPUR]: c.branchId }, access: { path: "sales_accrual", capabilities: { appointments: false, salesAccrual: true } } });
    expect(t.text()).toContain("Zenoti key replaced on the existing connection, its settings kept, sealed.");
    expect(t.text()).toContain("Ask your Zenoti admin to add read access to appointments");
    for (const secret of [KEY, NEW_KEY]) expect(t.text()).not.toContain(secret);
    expect((await auditOf(c.org)).map((a) => a.action)).toEqual(["integration.connected", "integration.tested", "integration.reconnected", "integration.tested"]);
  });

  it("leaves a key Zenoti refuses in error, with the reason and what to do", async () => {
    const c = await clinic();
    // Zenoti knows another key, so it refuses this one everywhere.
    const z = fakeZenoti(ALL, NEW_KEY);
    const t = terminal(z);
    const check = await connectCommand({ tenant: c.slug, file: await keyFile("wrong.json", JSON.stringify({ api_key: KEY })) }, t.deps);
    expect(check.ok).toBe(false);
    const [i] = await zenotiOf(c.org);
    expect(i!.status).toBe("error");
    expect(i!.lastError).toMatch(/Zenoti did not accept this API key/);
    expect(t.text()).toMatch(/^ {2}NOT WORKING YET$/m);
    expect(t.text()).toContain("Ask your Zenoti admin for the API key of the backend app made for JENAI");
    expect(t.text()).not.toContain("what the key may read");
    expect(t.text()).not.toContain(KEY);
    expect(i!.lastError).not.toContain(KEY);
  });

  it("is an error when the key sees the centres but no way to read services done", async () => {
    const c = await clinic();
    const t = terminal(fakeZenoti(["guestDetails"]));
    await connectCommand({ tenant: c.slug, file: await keyFile("narrow.json", JSON.stringify({ api_key: KEY })) }, t.deps);
    const [i] = await zenotiOf(c.org);
    expect(i!.status).toBe("error");
    expect(i!.lastError).toContain("JENAI cannot see which services were done");
    expect(t.text()).toMatch(/^ {2}NOT WORKING YET$/m);
    expect(t.text()).toContain("services done from  nowhere: the key may read none of the ways");
    expect(t.text()).toContain("Ask your Zenoti admin to add read access to appointments");
  });
});

describe("zenoti test", () => {
  it("tests the connection again and prints the same, leaving a paused connection paused", async () => {
    const c = await clinic();
    await expect(testCommand({ tenant: c.slug }, terminal(fakeZenoti(ALL)).deps)).rejects.toThrow(/has no Zenoti connection yet/);
    await expect(testCommand({ tenant: "no-such-clinic" }, terminal(fakeZenoti(ALL)).deps)).rejects.toThrow(/No client with the address/);

    await connectCommand({ tenant: c.slug, file: await keyFile("test.json", JSON.stringify({ api_key: KEY })) }, terminal(fakeZenoti(ALL)).deps);
    const [i] = await zenotiOf(c.org);
    await withTenant(c.org, (tx) => tx.update(integrations).set({ status: "paused" }).where(eq(integrations.id, i!.id)));

    const t = terminal(fakeZenoti(["salesReport"]));
    const check = await testCommand({ tenant: c.slug }, t.deps);
    expect(check).toMatchObject({ ok: true, test: { path: "sales_report" } });
    expect((await zenotiOf(c.org))[0]).toMatchObject({ status: "paused", config: { access: { path: "sales_report" } } });
    expect(t.text()).toContain("Zenoti CLI Clinic: testing the Zenoti connection");
    expect(t.text()).toContain("PAUSED, and kept paused: the key works.");
    expect(t.text()).toContain("services done from  Zenoti's older sales report");
    expect(t.text()).toContain("which has no phone numbers");
    expect(t.text()).not.toContain(KEY);
  });
});

describe("zenoti sync", () => {
  it("reads Zenoti once and prints counts per table and the plan per journey, with no names or numbers", async () => {
    const c = await clinic();
    const z = fakeZenoti(["appointments", "guestDetails", "guestPackages"]);
    await connectCommand({ tenant: c.slug, file: await keyFile("sync.json", JSON.stringify({ api_key: KEY })) }, terminal(z).deps);
    const [connected] = await zenotiOf(c.org);
    await withTenant(c.org, (tx) => tx.update(integrations).set({ config: { ...connected!.config, backfillDays: 14 } }).where(eq(integrations.id, connected!.id)));
    z.appointments.push(
      appointment("s1", 1, "2026-09-20", "11:00", 1, "Hydrafacial"),
      appointment("s2", 2, "2026-09-28", "16:30", -2, "PRP - Hair"),
      appointment("s3", 3, "2026-10-05", "10:00", 0, "Consultation"),
    );
    for (const n of [1, 2, 3]) {
      z.guests.set(`g${n}`, {
        id: `g${n}`,
        personal_info: { first_name: "Guest", last_name: `Number ${n}`, mobile_phone: { country_code: 95, number: mobile(n) } },
        preferences: { receive_marketing_sms: n === 1, receive_transactional_sms: true },
      });
    }

    const t = terminal(z);
    const r = await syncCommand({ tenant: c.slug, days: "30", budget: "40" }, t.deps);
    expect(r).toMatchObject({ ran: true, path: "appointments", done: true, error: null });
    const [i] = await zenotiOf(c.org);
    expect(i!.config.backfillDays).toBe(30);
    expect(await withTenant(c.org, (tx) => tx.select().from(visits))).toHaveLength(1);

    const out = t.text();
    expect(out).toContain("Zenoti CLI Clinic: reading Zenoti, at most 40 calls");
    expect(out).toContain("now reads 30 days back, was 14");
    expect(out).toContain("services done from  appointments (with each patient's mobile)");
    expect(out).toMatch(/centre\s+Kondapur: \d+ spans of up to 7 days read, stored from 2026-09-04 through 2026-10-03, 0 days left/);
    expect(out).toMatch(/clinic_appointments\s+3 read, 3 new or changed, 0 removed/);
    expect(out).toMatch(/visits\s+1 read, 1 added, 0 updated/);
    expect(out).toMatch(/external_people\s+3 guest profiles read, 0 still due/);
    expect(out).toMatch(/package_balances\s+1 guest's packages read, 0 rows stored, 0 visits given session counts, 0 guests still due/);
    expect(out).toMatch(/clinic_appointments\s+3 \(1 still to come\)/);
    expect(out).toMatch(/external_people\s+3 \(3 with a phone number, 3 profiles read, 1 agreed to marketing SMS\)/);
    expect(out).toMatch(/call plan\s+3 people: /);
    expect(out).toMatch(/^ {4}appointment_reminder\s+1 /m);
    expect(out).toMatch(/^ {4}no_show_rebook\s+1 /m);
    expect(out).toContain("Nothing was dialled, and nothing was written to Zenoti.");
    for (const never of [KEY, "Guest", "Number", "Dr. Asha", "Hydrafacial", mobile(1), mobile(2), mobile(3), "+91"]) expect(out).not.toContain(never);

    // Widening is audited; asking for fewer days changes nothing.
    expect((await auditOf(c.org)).filter((a) => a.action === "integration.updated").map((a) => a.diff)).toEqual([{ backfillDays: { from: 14, to: 30 } }]);
    const again = terminal(z);
    await syncCommand({ tenant: c.slug, days: "10" }, again.deps);
    expect(again.text()).toContain("already reads 30 days back; --days only widens that, so it stays");
    expect((await zenotiOf(c.org))[0]!.config.backfillDays).toBe(30);
  });

  it("refuses a budget or a number of days it cannot use, before reading anything", async () => {
    const z = fakeZenoti(ALL);
    for (const [flags, why] of [
      [{ budget: "0" }, /--budget takes a whole number from 1 to 400/],
      [{ budget: "12.5" }, /--budget takes a whole number/],
      [{ budget: "1000" }, /--budget takes a whole number/],
      [{ days: "366" }, /--days takes a whole number from 1 to 365/],
      [{ days: "a week" }, /--days takes a whole number/],
    ] as const) {
      await expect(syncCommand({ tenant: "anyone", ...flags }, terminal(z).deps)).rejects.toThrow(why);
    }
    expect(z.seen).toEqual([]);
  });
});
