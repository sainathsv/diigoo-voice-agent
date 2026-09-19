/**
 * Engine integration tests: real Postgres (row-level security on), fake Dograh.
 * Creates a throwaway client organization and deletes it afterwards.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agentTemplates,
  agentVersions,
  agents,
  branches,
  calls,
  campaignTargets,
  campaigns,
  consents,
  contacts,
  dialAttempts,
  leads,
  organizations,
  platformDb,
  subscriptions,
  suppressions,
  withTenant,
} from "@jenai/db";
import { render } from "@jenai/voice";
import { addWorkflow, startFakeDograh, type FakeDograh } from "@jenai/voice/testing";
import { createVersion, importAgent, publishVersion, checkDrift, PublishBlocked } from "./agents";
import { saveVoiceConnection, markConnection } from "./voice-conn";
import { syncTenantCalls } from "./sync";
import { addCarrierAccount, addPhoneNumber } from "./telephony";
import { runDialerTick, SimulatedGateway, zoned } from "./dialer";
import { entitlements, statement, usage, billingPeriod } from "./plans";

let fake: FakeDograh;
let tenant = "";
let branch = "";
const actor = null; // system actions record no user

beforeAll(async () => {
  fake = await startFakeDograh({ apiKey: "k-test" });
  const [tpl] = await platformDb().select().from(agentTemplates).where(eq(agentTemplates.key, "clinic_receptionist"));
  const live = render(tpl!, { greeting: "Welcome to Test Clinic. How can I help you?", facts: "YOU ARE the receptionist at Test Clinic, Madhapur. Timings 10 AM to 7 PM. Services: cleaning, implants." }, "dental");
  addWorkflow(fake, 1, "Test outbound", live.outboundPrompt);
  addWorkflow(fake, 2, "Test inbound", live.inboundPrompt);

  const [org] = await platformDb()
    .insert(organizations)
    .values({ kind: "client", name: "Engine Test Clinic", slug: `engine-test-${randomUUID().slice(0, 8)}`, status: "active", languages: ["te", "en"] })
    .returning();
  tenant = org!.id;
  await withTenant(tenant, async (tx) => {
    const [b] = await tx.insert(branches).values({ tenantId: tenant, name: "Madhapur", languages: ["te", "en"] }).returning();
    branch = b!.id;
    await tx.insert(subscriptions).values({ tenantId: tenant, planKey: "growth", billingModel: "prepaid", startsOn: "2026-09-01", extraFeatures: [] });
    await saveVoiceConnection(tx, tenant, { baseUrl: fake.url, auth: { kind: "api_key", apiKey: "k-test" } }, null);
  });
});

afterAll(async () => {
  await platformDb().delete(organizations).where(eq(organizations.id, tenant));
  await fake.close();
});

describe("agents", () => {
  it("imports a live agent as version 1 without changing what callers hear", async () => {
    const before = fake.inboundHears(2);
    const r = await importAgent(tenant, { name: "Receptionist", branchId: branch, purpose: "receptionist", domain: "dental", inboundWorkflowId: 2, outboundWorkflowId: 1 }, actor);
    expect(r.recognised).toBe(true);
    expect(r.version.state).toBe("imported");
    expect(r.version.facts).toContain("Test Clinic, Madhapur");
    expect(r.agent.outboundWorkflowUuid).toBe("uuid-1");
    expect(fake.inboundHears(2)).toBe(before);
    expect(fake.requests.some((x) => x.includes("/publish") || x.startsWith("PUT"))).toBe(false);
  });

  it("refuses to publish while the client is read-only", async () => {
    const [agent] = await withTenant(tenant, (tx) => tx.select().from(agents));
    const v = await withTenant(tenant, (tx) =>
      createVersion(tx, tenant, agent!.id, { greeting: "Welcome to Test Clinic. I am the clinic's AI assistant. How can I help you?", facts: "YOU ARE the receptionist at Test Clinic, Madhapur. Timings 9 AM to 8 PM. Services: cleaning, implants, braces." }, actor),
    );
    await expect(publishVersion(tenant, v.id, actor)).rejects.toBeInstanceOf(PublishBlocked);
  });

  it("in managed mode, one publish updates inbound and outbound together and the old version is superseded", async () => {
    await withTenant(tenant, (tx) => markConnection(tx, tenant, { mode: "managed" }));
    const [draft] = await withTenant(tenant, (tx) => tx.select().from(agentVersions).where(eq(agentVersions.state, "draft")));
    const { version, result } = await publishVersion(tenant, draft!.id, actor);
    expect(result.ok).toBe(true);
    expect(version.state).toBe("live");
    expect(fake.inboundHears(2)).toBe(version.inboundPrompt);
    expect(fake.inboundHears(1)).toBe(version.outboundPrompt);
    const states = await withTenant(tenant, (tx) => tx.select({ n: agentVersions.number, s: agentVersions.state }).from(agentVersions));
    expect(states.find((x) => x.n === 1)!.s).toBe("superseded");
    expect((await checkDrift(tenant, version.agentId)).inSync).toBe(true);
  });

  it("detects drift when someone edits the engine directly", async () => {
    const wf = fake.workflows.get(2)!;
    wf.published.nodes[0]!.data!.prompt = "hand-edited in the engine";
    wf.versions[0]!.workflow_json.nodes[0]!.data!.prompt = "hand-edited in the engine";
    const [agent] = await withTenant(tenant, (tx) => tx.select().from(agents));
    const d = await checkDrift(tenant, agent!.id);
    expect(d.inSync).toBe(false);
    expect(d.inboundMatches).toBe(false);
  });
});

describe("calls sync", () => {
  it("pulls calls, contacts and leads, and a second sync adds nothing", async () => {
    const now = new Date().toISOString();
    fake.runs.set(2, [
      { id: 901, workflow_id: 2, is_completed: true, created_at: now, call_type: "inbound", cost_info: { call_duration_seconds: 184 }, initial_context: { caller_number: "919876500001", called_number: "914012345678" }, gathered_context: { caller_name: "Ravi", concern: "implant consultation", next_step: "booked", preferred_time: "20 Sep 2026, 11:00 AM", interest_level: "hot" }, transcript_public_url: `${fake.url}/api/v1/public/download/workflow/t901/transcript`, recording_public_url: `${fake.url}/api/v1/public/download/workflow/t901/recording` },
      { id: 902, workflow_id: 2, is_completed: true, created_at: now, call_type: "inbound", cost_info: { call_duration_seconds: 1 }, initial_context: { caller_number: "09876500002" }, gathered_context: {} },
      { id: 903, workflow_id: 2, is_completed: false, created_at: now, call_type: "inbound", cost_info: null, initial_context: { caller_number: "9876500003" }, gathered_context: null },
    ]);
    const s1 = await syncTenantCalls(tenant);
    expect(s1.errors).toEqual([]);
    expect(s1.inserted).toBe(3);
    expect(s1.leadsTouched).toBe(1);
    const rows = await withTenant(tenant, (tx) => tx.select().from(calls));
    const booked = rows.find((r) => r.externalRunId === "901")!;
    expect(booked.status).toBe("completed");
    expect(booked.transcript).toBe("transcript for t901");
    expect(booked.branchId).toBe(branch);
    expect(rows.find((r) => r.externalRunId === "902")!.status).toBe("no_answer");
    const [lead] = await withTenant(tenant, (tx) => tx.select().from(leads));
    expect(lead!.stage).toBe("booked");
    expect(lead!.preferredAt?.toISOString()).toBe(zoned(2026, 9, 20, 11 * 60, "Asia/Kolkata").toISOString());
    const people = await withTenant(tenant, (tx) => tx.select().from(contacts));
    expect(people.map((p) => p.phoneE164).sort()).toEqual(["+919876500001", "+919876500002", "+919876500003"]);

    const s2 = await syncTenantCalls(tenant);
    expect(s2.inserted).toBe(0);
    // The in-progress call is re-read until it finishes.
    expect(s2.updated).toBe(1);
  });
});

describe("dialer", () => {
  it("dials only who passes the compliance gate, then records the outcome", async () => {
    const now = zoned(2026, 9, 17, 11 * 60, "Asia/Kolkata"); // Thursday 11:00 IST
    const ids = await withTenant(tenant, async (tx) => {
      const acct = await addCarrierAccount(tx, tenant, { provider: "vobiz", mode: "managed_subaccount", displayName: "Test Vobiz" }, actor);
      const num = await addPhoneNumber(tx, tenant, { carrierAccountId: acct.id, e164: `+9140${Math.floor(10000000 + Math.random() * 8e7)}`, series: "landline", purpose: "both", branchId: branch });
      const [agent] = await tx.select().from(agents);
      await tx.execute(sql`update phone_numbers set a2p_declared_at = now() where id = ${num.id}`);
      const [c] = await tx
        .insert(campaigns)
        .values({ tenantId: tenant, branchId: branch, agentId: agent!.id, callerNumberId: num.id, name: "Recall", purpose: "service", status: "running", windows: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" }, createdBy: actor })
        .returning();
      const add = (phone: string) => tx.insert(campaignTargets).values({ tenantId: tenant, campaignId: c!.id, phoneE164: phone, name: "Test", nextAttemptAt: new Date(now.getTime() - 60_000) }).returning();
      await tx.insert(consents).values({ tenantId: tenant, phoneE164: "+919876511111", purpose: "service", source: "inbound_call" });
      await tx.insert(suppressions).values({ tenantId: tenant, phoneE164: "+919876522222", reason: "opt_out", source: "test" });
      const [ok] = await add("+919876511111");
      const [optedOut] = await add("+919876522222");
      const [noConsent] = await add("+919876533333");
      return { campaign: c!.id, ok: ok!.id, optedOut: optedOut!.id, noConsent: noConsent!.id };
    });

    const simulator = new SimulatedGateway(0, () => "answered");
    const r1 = await runDialerTick({ now, simulator });
    expect(r1.errors).toEqual([]);
    expect(r1.dialed).toBe(1);
    expect(r1.skipped).toBe(2);
    expect(r1.gateways).toEqual({ simulated: 1 });
    const t = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.campaignId, ids.campaign)));
    expect(t.find((x) => x.id === ids.optedOut)!.skipReason).toMatch(/Do-not-call/);
    expect(t.find((x) => x.id === ids.noConsent)!.skipReason).toMatch(/consent/);

    const r2 = await runDialerTick({ now: new Date(now.getTime() + 1000), simulator });
    expect(r2.resolved).toBe(1);
    const [done] = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.id, ids.ok)));
    expect(done!.state).toBe("completed");
    expect(done!.lastOutcome).toBe("answered");
    const [c] = await withTenant(tenant, (tx) => tx.select().from(campaigns).where(eq(campaigns.id, ids.campaign)));
    expect(c!.status).toBe("completed");
    const log = await withTenant(tenant, (tx) => tx.select().from(dialAttempts).where(and(eq(dialAttempts.campaignId, ids.campaign))));
    expect(log.map((l) => l.decision).sort()).toEqual(["dial", "skip", "skip"]);
  });

  it("waits at night instead of dialing", async () => {
    const night = zoned(2026, 9, 17, 22 * 60 + 30, "Asia/Kolkata");
    const id = await withTenant(tenant, async (tx) => {
      const [c] = await tx.select().from(campaigns);
      await tx.update(campaigns).set({ status: "running" }).where(eq(campaigns.id, c!.id));
      const [t] = await tx.insert(campaignTargets).values({ tenantId: tenant, campaignId: c!.id, phoneE164: "+919876544444", nextAttemptAt: new Date(night.getTime() - 1000) }).returning();
      await tx.insert(consents).values({ tenantId: tenant, phoneE164: "+919876544444", purpose: "service", source: "web_form" });
      return t!.id;
    });
    const r = await runDialerTick({ now: night, simulator: new SimulatedGateway(0, () => "answered") });
    expect(r.dialed).toBe(0);
    expect(r.deferred).toBe(1);
    const [t] = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.id, id)));
    expect(t!.nextAttemptAt.toISOString()).toBe(zoned(2026, 9, 18, 10 * 60, "Asia/Kolkata").toISOString());
  });
});

describe("plans", () => {
  it("meters usage for the monthly statement", async () => {
    const period = billingPeriod(new Date());
    const s = await withTenant(tenant, async (tx) => statement(await entitlements(tx, tenant), await usage(tx, tenant, period.from, period.to), period, 1));
    expect(s.usage.calls).toBeGreaterThanOrEqual(3);
    expect(s.usage.minutes).toBe(4 + 1); // 184 s -> 4 started minutes, 1 s -> 1 minute, unfinished -> 0
    expect(s.fixedFeePaise).toBe(799_900);
    expect(s.billableMinutes).toBe(0); // inside the 1,200 included minutes
  });
});
