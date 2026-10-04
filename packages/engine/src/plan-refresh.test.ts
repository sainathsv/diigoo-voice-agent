/**
 * Keeping the call plan current: the worker's claim on CRM connections due a
 * read, the read and the plan after it, the hourly plan for clients nobody
 * reads, and plan settings. Runs against the local database (`pnpm db:migrate`
 * first). A small stand-in answers for Zoho.
 *
 * Every claim here is made inside withTenant, so row-level security keeps it
 * to the test's own clients and it never takes another client's connection.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { appDb, auditEvents, callPlanSettings, campaignTargets, integrations, organizations, plannedCalls, platformDb, tenantDatabases, visits, withTenant } from "@jenai/db";
import { sealCredentials } from "./integrations/queue";
import { replanTenant } from "./care-plan";
import {
  DEFAULT_PULL_INTERVAL_MINUTES,
  PlanSettingError,
  checkPlanSetting,
  claimPulls,
  planSummary,
  plansToRefresh,
  pullAndPlan,
  pullIntervalMinutes,
  pullKinds,
  requeueStuckPulls,
  setPlanSetting,
} from "./plan-refresh";

const SCOPES = ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.contacts.READ"];
const orgs: Record<"claims" | "clinic" | "backlog" | "quiet", string> = { claims: "", clinic: "", backlog: "", quiet: "" };

/** Zoho writes its times in the account's own offset. */
const ist = (ms: number) => `${new Date(ms + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;
const pad = (n: number) => String(n).padStart(5, "0");
/** An enquiry made within the last two hours, so the plan calls it. */
const lead = (n: number, base: number) => ({
  id: `41508680000030${pad(n)}`,
  Full_Name: `Lead ${n}`,
  Mobile: `98481${pad(n)}`,
  Lead_Status: "New Lead",
  Lead_Source: "Instagram",
  Select_Your_Centre: "Gachibowli",
  Created_Time: ist(base + n * 1000),
  Modified_Time: ist(base + n * 1000),
});

/** Their Leads, by client. */
const crm: Record<string, Array<Record<string, unknown>>> = {};
let asked = 0;
/**
 * Stands in for Zoho's get-records and get-deleted-records: changes after
 * If-Modified-Since, oldest first, 200 to a page with info.more_records, and
 * 204 when there is nothing.
 */
const zohoFor = (tenantId: string) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    asked++;
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const answer = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const m = /^\/crm\/v2\/(\w+)(\/deleted)?$/.exec(url.pathname);
    if (!m) return answer(500);
    if (m[2] || m[1] !== "Leads") return answer(204);
    const after = headers["If-Modified-Since"] ? Date.parse(headers["If-Modified-Since"]) : -Infinity;
    const all = (crm[tenantId] ?? []).filter((r) => Date.parse(String(r.Modified_Time)) > after).sort((a, b) => Date.parse(String(a.Modified_Time)) - Date.parse(String(b.Modified_Time)));
    const page = Number(url.searchParams.get("page") ?? 1);
    const data = all.slice((page - 1) * 200, page * 200);
    return data.length ? answer(200, { data, info: { per_page: 200, count: data.length, page, more_records: all.length > page * 200 } }) : answer(204);
  }) as typeof fetch;

async function connection(tenantId: string, over: Partial<typeof integrations.$inferInsert> = {}): Promise<string> {
  const credentials = sealCredentials(tenantId, { client_id: "cid", client_secret: "secret", refresh_token: "refresh", access_token: "cached", access_token_until: String(Date.now() + 3_600_000) });
  const [i] = await withTenant(tenantId, (tx) =>
    tx
      .insert(integrations)
      .values({ tenantId, kind: "zoho_crm", name: "Zoho", status: "connected", config: { dc: "in", module: "Leads", scopes: SCOPES }, credentials, ...over })
      .returning({ id: integrations.id }),
  );
  return i!.id;
}
const row = async (tenantId: string, id: string) => (await withTenant(tenantId, (tx) => tx.select().from(integrations).where(eq(integrations.id, id))))[0]!;
const claim = (tenantId: string, limit: number) => withTenant(tenantId, (tx) => claimPulls(tx, limit));
const minutesFromNow = (d: Date | null) => (d!.getTime() - Date.now()) / 60_000;

beforeAll(async () => {
  for (const key of Object.keys(orgs) as Array<keyof typeof orgs>) {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name: `Plan Refresh ${key}`, slug: `plan-refresh-${key}-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] })
      .returning();
    orgs[key] = o!.id;
  }
});
afterAll(async () => {
  for (const id of Object.values(orgs)) if (id) await platformDb().delete(organizations).where(eq(organizations.id, id));
});

describe("which connections the worker reads", () => {
  it("only reads what can be read: Zoho connections that work and have not been switched off", () => {
    expect(pullKinds()).toEqual(["zoho_crm"]);
    expect(pullIntervalMinutes({})).toBe(DEFAULT_PULL_INTERVAL_MINUTES);
    expect(pullIntervalMinutes({ pull: { intervalMinutes: 30 } })).toBe(30);
    // Too often would spend their Zoho API credits; a typo keeps the default.
    expect(pullIntervalMinutes({ pull: { intervalMinutes: 2 } })).toBe(10);
    expect(pullIntervalMinutes({ pull: { intervalMinutes: "30" } })).toBe(10);
    expect(pullIntervalMinutes({ pull: null })).toBe(10);
  });

  it("hands a due connection to one claimer only, however many ask at once", async () => {
    const t = orgs.claims;
    const due = await Promise.all([1, 2, 3, 4, 5].map(() => connection(t)));
    // None of these is due a read.
    const later = await connection(t, { nextPullAt: new Date(Date.now() + 3_600_000) });
    const reading = await connection(t, { pullLeaseUntil: new Date(Date.now() + 600_000) });
    const paused = await connection(t, { status: "paused" });
    const off = await connection(t, { config: { dc: "in", scopes: SCOPES, pull: { enabled: false } } });
    const webhook = await connection(t, { kind: "webhook_out", name: "Their hook", config: { url: "https://example.com/hook" } });

    const rounds = await Promise.all([1, 2, 3].map(() => claim(t, 2)));
    const first = rounds.flat().map((c) => c.id);
    expect(new Set(first).size).toBe(first.length); // nobody got one twice
    expect(rounds.flat().every((c) => c.tenantId === t)).toBe(true);
    const rest = (await claim(t, 10)).map((c) => c.id);
    expect([...first, ...rest].sort()).toEqual([...due].sort());
    expect(await claim(t, 10)).toEqual([]); // all held now

    for (const id of [later, reading, paused, off, webhook]) expect([...first, ...rest]).not.toContain(id);
    const held = await row(t, due[0]!);
    expect(minutesFromNow(held.pullLeaseUntil)).toBeGreaterThan(14);
  });

  it("takes back a connection whose reader died, once its lease has run out", async () => {
    const t = orgs.claims;
    await withTenant(t, (tx) => tx.delete(integrations).where(eq(integrations.tenantId, t)));
    const died = await connection(t, { pullLeaseUntil: new Date(Date.now() - 60_000), nextPullAt: new Date(Date.now() + 600_000) });
    const expired = await connection(t, { pullLeaseUntil: new Date(Date.now() - 60_000) });
    // A lease that ran out is free at once, even before it is cleared.
    expect((await claim(t, 10)).map((c) => c.id)).toEqual([expired]);

    expect(await withTenant(t, (tx) => requeueStuckPulls(tx))).toBe(1);
    const back = await row(t, died);
    expect(back.pullLeaseUntil).toBeNull();
    expect(minutesFromNow(back.nextPullAt)).toBeLessThanOrEqual(0); // due again now, not in ten minutes
    expect((await claim(t, 10)).map((c) => c.id)).toEqual([died]);
  });

  it("leaves a client on their own database to the claim made there", async () => {
    const t = orgs.claims;
    await withTenant(t, (tx) => tx.delete(integrations).where(eq(integrations.tenantId, t)));
    await connection(t);
    // Their rows copied from the shared database before a move are stale: the claim made on their own database reads them.
    await platformDb().insert(tenantDatabases).values({ tenantId: t, label: "Their server", host: "db.invalid", database: "jenai", username: "jenai_app", secret: "x", status: "ready" });
    try {
      expect(await withTenant(t, (tx) => claimPulls(tx, 10), appDb())).toEqual([]);
      await platformDb().update(tenantDatabases).set({ status: "disabled" }).where(eq(tenantDatabases.tenantId, t));
      expect(await withTenant(t, (tx) => claimPulls(tx, 10), appDb())).toHaveLength(1);
    } finally {
      await platformDb().delete(tenantDatabases).where(eq(tenantDatabases.tenantId, t));
    }
  });
});

describe("a read on the timer, and the plan after it", () => {
  it("reads, plans everyone again, and sets the next read after the client's own interval", async () => {
    const t = orgs.clinic;
    const base = Date.now() - 2 * 3_600_000;
    crm[t] = [1, 2, 3].map((n) => lead(n, base));
    const id = await connection(t, { config: { dc: "in", module: "Leads", scopes: SCOPES, pull: { intervalMinutes: 30 } } });
    const [mine] = await claim(t, 1);
    expect(mine!.id).toBe(id);

    const r = await pullAndPlan(t, id, { pageBudget: 5, fetchImpl: zohoFor(t), scheduled: true });
    expect(r.sync).toMatchObject({ ran: true, done: true, error: null });
    expect(r.sync.modules.map((m) => [m.module, m.read])).toEqual([["Leads", 3], ["Contacts", 0]]);
    expect(r.plan).toMatchObject({ people: 3, rows: 3 });
    expect(Object.values(r.plan!.byJourney.new_enquiry ?? {}).reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.planError).toBeNull();

    const i = await row(t, id);
    expect(i.pullLeaseUntil).toBeNull();
    expect(i.lastPullAt).toBeInstanceOf(Date);
    expect(i.lastPullError).toBeNull();
    expect(minutesFromNow(i.nextPullAt)).toBeGreaterThan(29);
    expect(minutesFromNow(i.nextPullAt)).toBeLessThanOrEqual(30);
    expect(i.nextPullAt).toEqual(r.nextPullAt);
    // Not due again, so no worker takes it.
    expect(await claim(t, 10)).toEqual([]);

    // A preview: nothing to dial was made.
    expect(await withTenant(t, (tx) => tx.select().from(campaignTargets))).toEqual([]);
    expect(await withTenant(t, (tx) => tx.select().from(plannedCalls))).toHaveLength(3);
  });

  it("reads by hand when asked, taking and letting go of the lease itself", async () => {
    const t = orgs.clinic;
    const [i] = await withTenant(t, (tx) => tx.select().from(integrations));
    crm[t]!.push(lead(4, Date.now() - 3_600_000));
    const r = await pullAndPlan(t, i!.id, { fetchImpl: zohoFor(t) });
    expect(r.sync.modules.find((m) => m.module === "Leads")!.read).toBeGreaterThanOrEqual(1);
    expect(r.plan).toMatchObject({ people: 4, rows: 4 });
    const after = await row(t, i!.id);
    expect(after.pullLeaseUntil).toBeNull();
    expect(minutesFromNow(after.nextPullAt)).toBeGreaterThan(29);

    // Someone else reading it: this run leaves it alone and says so.
    await withTenant(t, (tx) => tx.update(integrations).set({ pullLeaseUntil: new Date(Date.now() + 600_000) }).where(eq(integrations.id, i!.id)));
    asked = 0;
    const busy = await pullAndPlan(t, i!.id, { fetchImpl: zohoFor(t) });
    expect(busy).toMatchObject({ sync: { ran: false }, plan: null, nextPullAt: null });
    expect(asked).toBe(0);
    await withTenant(t, (tx) => tx.update(integrations).set({ pullLeaseUntil: null }).where(eq(integrations.id, i!.id)));
  });

  it("reads a large CRM run after run, and plans once the read has caught up", async () => {
    const t = orgs.backlog;
    const base = Date.now() - 3 * 3_600_000;
    crm[t] = Array.from({ length: 450 }, (_, n) => lead(n + 1, base));
    const id = await connection(t);

    expect((await claim(t, 1))[0]!.id).toBe(id);
    let r = await pullAndPlan(t, id, { pageBudget: 1, fetchImpl: zohoFor(t), scheduled: true });
    expect(r.sync).toMatchObject({ ran: true, done: false, error: null, pages: 1 });
    expect(r.plan).toBeNull(); // not after every page
    expect(minutesFromNow(r.nextPullAt)).toBeLessThanOrEqual(0); // the next read is due at once
    expect(await withTenant(t, (tx) => tx.select().from(plannedCalls))).toEqual([]);

    expect((await claim(t, 1))[0]!.id).toBe(id);
    r = await pullAndPlan(t, id, { pageBudget: 5, fetchImpl: zohoFor(t), scheduled: true });
    expect(r.sync).toMatchObject({ done: true, error: null });
    expect(r.plan).toMatchObject({ people: 450, rows: 450 });
    expect(minutesFromNow(r.nextPullAt)).toBeGreaterThan(9);
  });

  it("records a read that failed, lets go, and tries again at the next interval", async () => {
    const t = orgs.backlog;
    const [i] = await withTenant(t, (tx) => tx.select().from(integrations));
    await withTenant(t, (tx) => tx.update(integrations).set({ nextPullAt: null }).where(eq(integrations.id, i!.id)));
    expect((await claim(t, 1))[0]!.id).toBe(i!.id);
    const down = (async () => new Response("busy", { status: 500 })) as unknown as typeof fetch;
    const r = await pullAndPlan(t, i!.id, { fetchImpl: down, scheduled: true });
    expect(r.sync.error).toMatch(/Zoho answered/);
    expect(r.plan).toMatchObject({ rows: 450 }); // the plan still moves on with the days
    const after = await row(t, i!.id);
    expect(after.lastPullError).toMatch(/Zoho answered/);
    expect(after.pullLeaseUntil).toBeNull();
    expect(minutesFromNow(after.nextPullAt)).toBeGreaterThan(9);
  });
});

describe("plans that age with the days", () => {
  it("plans again, at most hourly, a client with visits that no read will plan soon", async () => {
    const t = orgs.quiet;
    const due = () => withTenant(t, (tx) => plansToRefresh(tx, 10));
    expect(await due()).toEqual([]); // nothing to plan for
    await withTenant(t, (tx) => tx.insert(visits).values({ tenantId: t, phoneE164: "+919848100001", service: "Hydrafacial", visitDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10) }));
    expect(await due()).toEqual([t]); // visits and no plan yet

    await replanTenant(t);
    expect(await due()).toEqual([]); // planned within the hour
    await withTenant(t, (tx) => tx.update(plannedCalls).set({ computedAt: new Date(Date.now() - 2 * 3_600_000) }));
    expect(await due()).toEqual([t]);

    // A read due now plans it anyway; one due tomorrow does not, so the hourly plan does.
    const id = await connection(t);
    expect(await due()).toEqual([]);
    await withTenant(t, (tx) => tx.update(integrations).set({ nextPullAt: new Date(Date.now() + 86_400_000) }).where(eq(integrations.id, id)));
    expect(await due()).toEqual([t]);
    // A suspended client is left as it is.
    await platformDb().update(organizations).set({ status: "suspended" }).where(eq(organizations.id, t));
    expect(await due()).toEqual([]);
    await platformDb().update(organizations).set({ status: "active" }).where(eq(organizations.id, t));
  });
});

describe("looking at a plan and changing its settings", () => {
  it("counts per journey and verdict, and lists the next calls with the number masked", async () => {
    const t = orgs.clinic;
    const s = await planSummary(t);
    expect(s.rows).toBe(4);
    expect(s.computedAt).toBeInstanceOf(Date);
    expect(Object.values(s.byVerdict).reduce((a, b) => a + b, 0)).toBe(4);
    expect(s.next).toHaveLength(4);
    for (const c of s.next) {
      expect(c.phone).toMatch(/^\+91 ••••• •\d{4}$/);
      expect(c.origin).toBe("Zoho Lead");
    }
    expect(JSON.stringify(s)).not.toMatch(/9848100\d{3}|Lead \d/);
    expect((await planSummary(t, { upcoming: 2 })).next).toHaveLength(2);
  });

  it("says plainly why a setting cannot be used", () => {
    expect(checkPlanSetting("centres", ["Kondapur"])).toBeNull();
    expect(checkPlanSetting("centres", [])).toBeNull();
    expect(checkPlanSetting("freshDays", 45)).toBeNull();
    expect(checkPlanSetting("freshDays", null)).toBeNull(); // back to the default
    expect(checkPlanSetting("callingWindow", { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" })).toBeNull();
    expect(checkPlanSetting("visitColumns", { phone: ["Cust Cell"] })).toBeNull();

    expect(checkPlanSetting("centres", "Kondapur")).toMatch(/centres must be a list/);
    expect(checkPlanSetting("centres", ["Kondapur", 3])).toMatch(/centres must be a list/);
    expect(checkPlanSetting("freshDays", 0)).toBe("freshDays must be a whole number from 1 to 365.");
    expect(checkPlanSetting("freshDays", 4.5)).toMatch(/whole number/);
    expect(checkPlanSetting("callingWindow", { days: [1, 9], start: "10:00", end: "19:00" })).toMatch(/day 0 is Sunday/);
    expect(checkPlanSetting("callingWindow", { days: [1], start: "06:00", end: "08:30" })).toMatch(/between 09:00 and 21:00/);
    expect(checkPlanSetting("visitColumns", { mobile: ["Cust Cell"] })).toMatch(/"mobile" is not a field of the visit list/);
    expect(checkPlanSetting("visitColumns", { phone: "Cust Cell" })).toMatch(/visitColumns.phone must be a list/);
    expect(checkPlanSetting("timezone", "UTC")).toMatch(/organisation's own/);
    expect(checkPlanSetting("centers", ["Kondapur"])).toMatch(/"centers" is not a call plan setting\. The settings are: .*centres/);
  });

  it("stores a setting, records who changed it, and plans again; null puts back the default", async () => {
    const t = orgs.clinic;
    const settings = async () => (await withTenant(t, (tx) => tx.select().from(callPlanSettings)))[0]?.settings;

    let r = await setPlanSetting(t, "centres", ["Kondapur"]);
    expect(r.settings).toEqual({ centres: ["Kondapur"] });
    // Their leads are all for Gachibowli, so a plan covering only Kondapur leaves them out.
    expect(r.plan.byVerdict.kept_out).toBe(4);
    r = await setPlanSetting(t, "freshDays", 45);
    expect(await settings()).toEqual({ centres: ["Kondapur"], freshDays: 45 });

    await expect(setPlanSetting(t, "freshDays", 0)).rejects.toThrow(PlanSettingError);
    expect(await settings()).toEqual({ centres: ["Kondapur"], freshDays: 45 });

    r = await setPlanSetting(t, "centres", null);
    expect(r.settings).toEqual({ freshDays: 45 });
    expect(r.plan.byVerdict.kept_out).toBe(0);

    const logged = await withTenant(t, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, t), eq(auditEvents.action, "call_plan.setting_changed"))));
    expect(logged.map((e) => e.summary).sort()).toEqual(["Call plan setting centres changed", "Call plan setting centres put back to its default", "Call plan setting freshDays changed"]);
    expect(await withTenant(t, (tx) => tx.execute(sql`select 1 from campaign_targets`))).toHaveLength(0);
  });
});
