/**
 * What a client sets for their own call plan from the workspace: their CRM's
 * words (statuses, lead sources), treatment timings and the fields read, and
 * what goes when a connection does. Runs against the local database
 * (`pnpm db:migrate` first) on a throwaway client.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { auditEvents, crmRecords, integrations, organizations, plannedCalls, platformDb, withTenant } from "@jenai/db";
import { DEFAULT_PLAN_SETTINGS, dropOrphanedPlanRows, planSettingsOf, replanTenant } from "./care-plan";
import { dbErrorCode, errorText } from "./errors";
import { PlanSettingError, setPlanSettings } from "./plan-refresh";
import { PlanSwitchError, planSettingsPage, removeTreatmentRule, setPullFieldLabels, setTreatmentRule, statusMoved, treatmentRuleProblem } from "./plan-settings";

let org = "";
let zoho = "";
const asked = new Date(Date.now() - 2 * 3_600_000);

beforeAll(async () => {
  const [o] = await platformDb()
    .insert(organizations)
    .values({ kind: "client", name: "Plan Settings Clinic", slug: `plan-settings-${randomUUID().slice(0, 8)}`, status: "active", vertical: "dermatology", languages: ["en"] })
    .returning({ id: organizations.id });
  org = o!.id;
  await withTenant(org, async (tx) => {
    const [i] = await tx.insert(integrations).values({ tenantId: org, kind: "zoho_crm", name: "Zoho", status: "connected", config: { dc: "in" } }).returning({ id: integrations.id });
    zoho = i!.id;
    const rec = (n: number, over: Partial<typeof crmRecords.$inferInsert>) => ({
      tenantId: org,
      integrationId: zoho,
      module: "Leads",
      externalId: `4150868000004${String(n).padStart(6, "0")}`,
      phoneE164: `+91984803${String(n).padStart(4, "0")}`,
      name: `Lead ${n}`,
      createdExt: asked,
      modifiedExt: asked,
      ...over,
    });
    // A second clinic's Zoho, with Zoho's own standard words and a status of its own.
    await tx.insert(crmRecords).values([
      rec(1, { status: "Not Contacted", source: "Advertisement", centre: "Zennara Clinics Kondapur" }),
      rec(2, { status: "Attempted to Contact", source: "Cold Call" }),
      rec(3, { status: "Hot Prospect", source: "Advertisement" }),
      rec(4, { status: "Hot Prospect", source: "Walk-in" }),
    ]);
  });
  await replanTenant(org);
});

afterAll(async () => {
  await platformDb().delete(organizations).where(eq(organizations.id, org));
});

describe("their CRM's own words", () => {
  it("knows Zoho's standard lead statuses out of the box, and lists the ones it does not", async () => {
    const p = await planSettingsPage(org);
    expect(p.statuses).toEqual(
      expect.arrayContaining([
        { status: "Hot Prospect", records: 2, list: null },
        { status: "Not Contacted", records: 1, list: "openStatuses" },
        { status: "Attempted to Contact", records: 1, list: "openStatuses" },
      ]),
    );
    expect(p.sources).toEqual(expect.arrayContaining([{ source: "Cold Call", records: 1, enquiry: false }, { source: "Advertisement", records: 2, enquiry: true }]));
    expect(p.centres).toEqual([{ centre: "Zennara Clinics Kondapur", records: 1 }]);
    expect(p.modules).toEqual([{ module: "Leads", records: 4 }]);
    expect(p).toMatchObject({ enabled: false, canEnable: true });
    expect(p.rules.defaults.length).toBeGreaterThan(5);
  });

  it("puts a status in one list, taking it out of the others, and plans again", async () => {
    const before = await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.name, "Lead 3")));
    expect(before[0]!.reason).toMatch(/"Hot Prospect" is not a status the plan settings know/);
    const { settings } = await planSettingsPage(org);
    const patch = statusMoved(settings, "Hot Prospect", "openStatuses");
    expect(patch).toEqual({ openStatuses: [...DEFAULT_PLAN_SETTINGS.openStatuses, "Hot Prospect"] });
    const r = await setPlanSettings(org, patch);
    expect(r.plan.byJourney.new_enquiry?.call_now).toBeGreaterThan(0);
    const after = await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.name, "Lead 3")));
    expect(after[0]).toMatchObject({ journey: "new_enquiry", verdict: "call_now" });

    // Moving "Not Interested" to open takes it out of both lists it starts in.
    const moved = statusMoved(planSettingsOf(r.settings), "not interested", "openStatuses");
    expect(moved.neverStatuses).not.toContain("Not Interested");
    expect(moved.declinedStatuses).not.toContain("Not Interested");
    // Out of every list: the plan says it does not know it.
    expect(statusMoved(planSettingsOf(r.settings), "Hot Prospect", null).openStatuses).not.toContain("Hot Prospect");
  });

  it("refuses the whole change when one setting cannot be used, and stores none of it", async () => {
    await expect(setPlanSettings(org, { freshDays: 20, minGapDays: -1 })).rejects.toThrow(PlanSettingError);
    expect((await planSettingsPage(org)).own.freshDays).toBeUndefined();
    await expect(setPlanSettings(org, {})).rejects.toThrow("Nothing to change.");
  });
});

describe("treatment timings", () => {
  it("stores the clinic's own timing over JENAI's default, once per word whatever its case, and removes it", async () => {
    expect(treatmentRuleProblem({ match: "x" })).toMatch(/2 to 60 characters/);
    expect(treatmentRuleProblem({ match: "hydrafacial", courseSessions: 0 })).toMatch(/Sessions in a course must be a whole number from 1 to 50/);
    await expect(setTreatmentRule(org, { match: "x" })).rejects.toThrow(PlanSwitchError);

    await setTreatmentRule(org, { match: "Hydrafacial", maintenanceAfterDays: 45 }, { actorUserId: null });
    await setTreatmentRule(org, { match: "hydrafacial", label: "Hydrafacial", maintenanceAfterDays: 40 });
    let p = await planSettingsPage(org);
    expect(p.rules.own).toHaveLength(1);
    expect(p.rules.own[0]).toMatchObject({ match: "hydrafacial", label: "Hydrafacial", maintenanceAfterDays: 40 });
    await removeTreatmentRule(org, p.rules.own[0]!.id);
    p = await planSettingsPage(org);
    expect(p.rules.own).toEqual([]);
    const logged = await withTenant(org, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.tenantId, org)));
    expect(logged.filter((e) => e.action.startsWith("call_plan.treatment_rule")).map((e) => e.action).sort()).toEqual([
      "call_plan.treatment_rule_removed",
      "call_plan.treatment_rule_set",
      "call_plan.treatment_rule_set",
    ]);
  });
});

describe("the fields read from their CRM", () => {
  it("sets the labels one item is read from, makes the connection due a read, and puts the defaults back", async () => {
    await setPullFieldLabels(org, zoho, "centre", ["Clinic Branch", " "]);
    let [i] = await withTenant(org, (tx) => tx.select().from(integrations).where(eq(integrations.id, zoho)));
    expect(i!.config).toMatchObject({ dc: "in", pull: { fieldLabels: { centre: ["Clinic Branch"] } } });
    expect(i!.nextPullAt).toBeNull();
    expect((await planSettingsPage(org)).connections[0]).toMatchObject({ labels: { centre: ["Clinic Branch"], status: ["Lead Status"] }, ownLabels: ["centre"] });
    await setPullFieldLabels(org, zoho, "centre", null);
    [i] = await withTenant(org, (tx) => tx.select().from(integrations).where(eq(integrations.id, zoho)));
    expect(i!.config).toMatchObject({ pull: { fieldLabels: {} } });
    await expect(setPullFieldLabels(org, zoho, "email", ["Email"])).rejects.toThrow(/is not something the plan reads/);
    await expect(setPullFieldLabels(org, zoho, "centre", [""])).rejects.toThrow(/at least one field label/);
  });
});

describe("a connection removed", () => {
  it("takes the planned calls made from its records with it, at once", async () => {
    const before = await withTenant(org, (tx) => tx.select().from(plannedCalls).where(eq(plannedCalls.originType, "crm_record")));
    expect(before.length).toBeGreaterThan(0);
    const dropped = await withTenant(org, async (tx) => {
      await tx.delete(integrations).where(eq(integrations.id, zoho));
      // The records go with the connection, and their planned calls with them in the same statement (0033's trigger).
      expect(await tx.select().from(plannedCalls)).toEqual([]);
      return dropOrphanedPlanRows(tx);
    });
    expect(dropped).toBe(0);
    expect(await withTenant(org, (tx) => tx.select().from(plannedCalls))).toEqual([]);
  });

  it("sweeps any planned call whose record, visit or front desk booking is gone", async () => {
    const row = (originType: "crm_record" | "visit" | "clinic_appointment") => ({
      tenantId: org,
      journey: "no_call",
      programKey: "",
      verdict: "kept_out" as const,
      reason: "Left from before.",
      originType,
      originId: randomUUID(),
      originLabel: "Gone",
    });
    const dropped = await withTenant(org, async (tx) => {
      await tx.insert(plannedCalls).values([row("crm_record"), row("visit"), row("clinic_appointment")]);
      return dropOrphanedPlanRows(tx);
    });
    expect(dropped).toBe(3);
    expect(await withTenant(org, (tx) => tx.select().from(plannedCalls))).toEqual([]);
  });
});

describe("errors safe to log", () => {
  it("keeps a failed query's statement and values out, and keeps Postgres's code", async () => {
    let caught: unknown;
    try {
      await withTenant(org, (tx) => tx.insert(crmRecords).values({ tenantId: org, integrationId: randomUUID(), module: "Leads", externalId: "1", phoneE164: "+919876543210", name: "Anitha Reddy" }));
    } catch (e) {
      caught = e;
    }
    expect(String((caught as Error).message)).toMatch(/Anitha Reddy|\+919876543210/); // what Drizzle puts in the message
    expect(errorText(caught)).toBe("the database refused it (23503)");
    expect(dbErrorCode(caught)).toBe("23503");
    expect(errorText(new Error("Zoho answered 500"))).toBe("Zoho answered 500");
    expect(dbErrorCode(new Error("x"))).toBeNull();
  });
});
