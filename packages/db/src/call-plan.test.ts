/**
 * The call plan's tables (migration 0025): each keeps to its own client, the
 * way every other tenant table does. Runs as the app role against the local
 * database. Requires `pnpm db:migrate` first.
 */
import "./scripts/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { platformDb, withTenant } from "./client";
import { callPlanSettings, crmRecords, integrations, organizations, plannedCalls, treatmentRules, visits } from "./schema";

let a = "";
let b = "";
let integrationA = "";

/** Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is on .cause. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.cause?.message ?? ""} ${err.message ?? ""}`;
  }
  return "no error";
}

beforeAll(async () => {
  const made = await platformDb()
    .insert(organizations)
    .values(["A", "B"].map((n) => ({ kind: "client" as const, name: `Call Plan Clinic ${n}`, slug: `plan-test-${n.toLowerCase()}-${randomUUID().slice(0, 8)}`, status: "active" as const, vertical: "health", languages: ["en"] })))
    .returning({ id: organizations.id });
  a = made[0]!.id;
  b = made[1]!.id;
  const [i] = await withTenant(a, (tx) => tx.insert(integrations).values({ tenantId: a, kind: "zoho_crm", name: "Zoho" }).returning());
  integrationA = i!.id;
});

afterAll(async () => {
  // Everything above hangs off the two clinics and goes with them.
  await platformDb().delete(organizations).where(inArray(organizations.id, [a, b]));
});

describe("call plan tables", () => {
  it("keep each client's records to that client", async () => {
    await withTenant(a, async (tx) => {
      const [record] = await tx
        .insert(crmRecords)
        .values({ tenantId: a, integrationId: integrationA, module: "Leads", externalId: "4150868000001944196", phoneE164: "+919876543210", status: "Follow-up", followUpAt: new Date("2026-10-03T04:30:00Z") })
        .returning();
      const [visit] = await tx
        .insert(visits)
        .values({ tenantId: a, phoneE164: "+919876543210", service: "Hydrafacial", visitDate: "2026-10-01", sessionsDone: 1, sessionsTotal: 4 })
        .returning();
      await tx.insert(treatmentRules).values({ tenantId: a, match: "hydrafacial", label: "Hydrafacial", feedbackAfterDays: 2, sessionIntervalDays: 21, courseSessions: 4 });
      await tx.insert(callPlanSettings).values({ tenantId: a, settings: { quietDays: 7 } });
      await tx.insert(plannedCalls).values([
        { tenantId: a, phoneE164: "+919876543210", journey: "enquiry_follow_up", programKey: "clinic.warm_follow_up", verdict: "call_now", reason: "They asked to be called back on 3 October.", originType: "crm_record", originId: record!.id, originLabel: "Zoho Lead" },
        { tenantId: a, phoneE164: "+919876543210", journey: "next_session", programKey: "clinic.revisit_recall", verdict: "scheduled", reason: "Session 2 of 4 is due three weeks after the first.", callAt: new Date("2026-10-22T05:30:00Z"), originType: "visit", originId: visit!.id, originLabel: "Visit list", context: { treatment: "Hydrafacial", visit_date: "2026-10-01" } },
      ]);
    });

    const counts = (tenant: string) =>
      withTenant(tenant, async (tx) => ({
        crm: (await tx.select().from(crmRecords)).length,
        visits: (await tx.select().from(visits)).length,
        rules: (await tx.select().from(treatmentRules)).length,
        settings: (await tx.select().from(callPlanSettings)).length,
        plan: (await tx.select().from(plannedCalls)).length,
      }));
    expect(await counts(a)).toEqual({ crm: 1, visits: 1, rules: 1, settings: 1, plan: 2 });
    expect(await counts(b)).toEqual({ crm: 0, visits: 0, rules: 0, settings: 0, plan: 0 });

    // A visit day stays the day it was, whatever the server's time zone.
    const [v] = await withTenant(a, (tx) => tx.select().from(visits));
    expect(v!.visitDate).toBe("2026-10-01");
  });

  it("refuses a row written into another client", async () => {
    // Thunks, so each write starts only when it is awaited and none is left unhandled.
    for (const write of [
      () => withTenant(b, (tx) => tx.insert(visits).values({ tenantId: a, phoneE164: "+919876543211", service: "PRP", visitDate: "2026-10-02" })),
      () => withTenant(b, (tx) => tx.insert(callPlanSettings).values({ tenantId: a, settings: {} })),
      () => withTenant(b, (tx) => tx.insert(plannedCalls).values({ tenantId: a, journey: "visit_feedback", programKey: "clinic.feedback", verdict: "kept_out", reason: "x", originType: "visit", originId: randomUUID(), originLabel: "Visit list" })),
    ]) {
      expect(await pgError(write())).toMatch(/row-level security/i);
    }
    const changed = await withTenant(b, (tx) => tx.update(treatmentRules).set({ label: "Hijacked" }).where(eq(treatmentRules.tenantId, a)).returning());
    expect(changed).toHaveLength(0);
  });

  it("counts the same service on the same day once, however it is capitalised", async () => {
    const again = withTenant(a, (tx) => tx.insert(visits).values({ tenantId: a, phoneE164: "+919876543210", service: "HYDRAFACIAL", visitDate: "2026-10-01" }));
    expect(await pgError(again)).toMatch(/visits_once/);
  });

  it("plans only calls it knows how to judge", async () => {
    const odd = withTenant(a, (tx) =>
      tx.insert(plannedCalls).values({ tenantId: a, journey: "maintenance", programKey: "clinic.revisit_recall", verdict: "dial" as "call_now", reason: "x", originType: "visit", originId: randomUUID(), originLabel: "Visit list" }),
    );
    expect(await pgError(odd)).toMatch(/check constraint/i);
  });

  it("starts a connection with nothing pulled, and drops its CRM copy when it is removed", async () => {
    const [i] = await withTenant(a, (tx) => tx.select().from(integrations).where(eq(integrations.id, integrationA)));
    expect(i!.pullCursor).toEqual({});
    expect(i!.nextPullAt).toBeNull();
    await withTenant(a, (tx) => tx.delete(integrations).where(eq(integrations.id, integrationA)));
    expect(await withTenant(a, (tx) => tx.select().from(crmRecords))).toHaveLength(0);
  });
});
