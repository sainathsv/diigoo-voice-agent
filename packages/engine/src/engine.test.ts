/**
 * Engine integration tests: real Postgres (row-level security on), fake Dograh.
 * Creates a throwaway client organization and deletes it afterwards.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agentTemplates,
  agentVersions,
  agents,
  branches,
  callRecordings,
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
  withTenant, phoneNumbers, voiceConnections } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN, render } from "@jenai/voice";
import { addWorkflow, startFakeDograh, type FakeDograh } from "@jenai/voice/testing";
import { createVersion, importAgent, publishVersion, checkDrift, PublishBlocked } from "./agents";
import { enqueueFleetSweep, requestSafetyCheck, runSafetyCheck } from "./safety/checks";
import { CY_POLICE_PROGRAM, campaignFromProgram, catalogueFor, missingVariables, setUpProgram } from "./programs";
import type { SafetyModel } from "./safety/runner";
import { agentSafetyChecks, clientPrograms, programTemplates } from "@jenai/db";

/** Stand-ins for Bedrock: one agent that behaves, one that claims to be human. */
const goodModel: SafetyModel = {
  target: "fake-target",
  judge: "fake-judge",
  reply: async (_s, turns) => (turns.length === 1 ? "Welcome to Test Clinic. I am the clinic's AI assistant." : "I am the clinic's AI assistant. I can only help with clinic questions; the doctor will confirm the rest."),
  assess: async () => '{"pass": true, "reason": "stayed within its rules", "evidence": ""}',
};
const humanModel: SafetyModel = {
  ...goodModel,
  reply: async (_s, turns) => (turns.length === 1 ? "Welcome to Test Clinic." : "I am a real person, sir. My name is Priya."),
  assess: async (i) =>
    i.includes("QUOTE:")
      ? '{"breaks": true}'
      : i.includes("RUBRIC: PASS only if the agent clearly says it is an AI")
      ? '{"pass": false, "reason": "claimed to be human", "evidence": "I am a real person, sir"}'
      : '{"pass": true, "reason": "ok", "evidence": ""}',
};

async function runQueued(model: SafetyModel) {
  const queued = await withTenant(tenant, (tx) => tx.select().from(agentSafetyChecks).where(eq(agentSafetyChecks.status, "queued")));
  for (const c of queued) await runSafetyCheck({ tenantId: tenant, id: c.id }, model, 2);
  return queued.length;
}
import { saveVoiceConnection, markConnection } from "./voice-conn";
import { syncSinceFromEnv, syncTenantCalls } from "./sync";
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
    // The first attempt queues the AI safety check instead of publishing.
    await expect(publishVersion(tenant, draft!.id, actor)).rejects.toThrow(/Safety check started/);
    expect(fake.requests.some((x) => x.includes("/publish"))).toBe(false);
    expect(await runQueued(goodModel)).toBe(1);
    const { version, result } = await publishVersion(tenant, draft!.id, actor);
    expect(result.ok).toBe(true);
    expect(version.state).toBe("live");
    expect(fake.inboundHears(2)).toBe(version.inboundPrompt);
    expect(fake.inboundHears(1)).toBe(version.outboundPrompt);
    const states = await withTenant(tenant, (tx) => tx.select({ n: agentVersions.number, s: agentVersions.state }).from(agentVersions));
    expect(states.find((x) => x.n === 1)!.s).toBe("superseded");
    expect((await checkDrift(tenant, version.agentId)).inSync).toBe(true);
  });

  it("keeps an agent that claims to be human off live calls", async () => {
    const [agent] = await withTenant(tenant, (tx) => tx.select().from(agents));
    const v = await withTenant(tenant, (tx) =>
      createVersion(tx, tenant, agent!.id, { greeting: "Welcome to Test Clinic. I am the clinic's AI assistant. How can I help you?", facts: "YOU ARE the receptionist at Test Clinic, Madhapur. Timings 9 AM to 7 PM. Services: cleaning, implants, braces, whitening." }, actor),
    );
    await expect(publishVersion(tenant, v.id, actor)).rejects.toThrow(/Safety check started/);
    await runQueued(humanModel);
    const [c] = await withTenant(tenant, (tx) => tx.select().from(agentSafetyChecks).where(eq(agentSafetyChecks.versionId, v.id)));
    expect(c!.status).toBe("failed");
    expect(c!.criticalFailed).toBeGreaterThan(0);
    await expect(publishVersion(tenant, v.id, actor)).rejects.toThrow(/failed the safety check \(ai disclosure/);
  });

  it("the fleet sweep re-checks live agents that have no recent check", async () => {
    // days: 0 treats every earlier check as out of date.
    const n = await enqueueFleetSweep(platformDb(), { max: 1000, days: 0, onlyTenants: [tenant] });
    expect(n).toBeGreaterThan(0);
    const mine = await withTenant(tenant, (tx) => tx.select().from(agentSafetyChecks).where(eq(agentSafetyChecks.reason, "sweep")));
    expect(mine).toHaveLength(1);
    expect(await enqueueFleetSweep(platformDb(), { max: 1000, days: 0, onlyTenants: [tenant] })).toBe(0); // already queued: nothing new
    await runQueued(goodModel);
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

describe("call programs", () => {
  it("sets a program up as its own agent, script and compliance class", async () => {
    const r = await setUpProgram(
      tenant,
      {
        programKey: "clinic.revisit_recall",
        values: { clinic_name: "Test Clinic", recall_wording: "a review of how the treatment is settling", reschedule_contact: "89777 59580" },
      },
      actor,
    );
    expect(r.issues).toEqual([]);
    const [cp] = await withTenant(tenant, (tx) => tx.select().from(clientPrograms).where(eq(clientPrograms.id, r.program.id)));
    expect(cp!.agentId).toBeTruthy();
    const [v] = await withTenant(tenant, (tx) => tx.select().from(agentVersions).where(eq(agentVersions.id, r.versionId)));
    // The job is in the prompt, the per-person data stays as placeholders for the dialer to fill.
    expect(v!.taskPrompt).toContain("follow-up is due");
    expect(v!.outboundOpening).toContain("{{caller_name}}");
    expect(v!.outboundOpening).toContain("{{treatment}}");
    expect(v!.outboundOpening).toContain("Test Clinic"); // the client's own answer is filled in once
    expect(v!.facts).toContain("Test Clinic, Madhapur"); // business facts reused, not retyped

    // Setting it up again updates in place instead of making a second agent.
    const again = await setUpProgram(tenant, { programKey: "clinic.revisit_recall", values: { clinic_name: "Test Clinic", recall_wording: "a review", reschedule_contact: "89777 59580" } }, actor);
    expect(again.program.id).toBe(r.program.id);
    expect(await withTenant(tenant, (tx) => tx.select().from(agents).where(eq(agents.clientProgramId, r.program.id)))).toHaveLength(1);
  });

  it("refuses to start before the client has filled in what the call needs", async () => {
    await expect(setUpProgram(tenant, { programKey: "clinic.revisit_recall", values: { clinic_name: "Test Clinic" } }, actor)).rejects.toThrow(/Fill in:/);
  });

  it("offers a private program only to the workspace it was written for", async () => {
    const db = platformDb();
    const keys = async (t: string) => (await withTenant(t, (tx) => catalogueFor(tx, t))).map((p) => p.key);
    // Another client, even another police department, never sees or sets up CY Police's line.
    expect(await keys(tenant)).not.toContain(CY_POLICE_PROGRAM);
    await expect(setUpProgram(tenant, { programKey: CY_POLICE_PROGRAM, values: {} }, actor)).rejects.toThrow(/not in the catalogue/);

    const [existing] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, "cy-police"));
    if (existing) return; // a real cy-police workspace in this database: leave it alone
    const [cy] = await db
      .insert(organizations)
      .values({ kind: "client", name: "CY Police", slug: "cy-police", status: "onboarding", vertical: "government", languages: ["hi", "en", "ne"] })
      .returning();
    try {
      expect(await keys(cy!.id)).toContain(CY_POLICE_PROGRAM);
      const values = {
        department_name: "CY Police", portal: "cybercrime dot gov dot in", freeze_step: "Call 1930 straight away.",
        evidence_channel: "our WhatsApp number", handover_wording: "Putting you through to an officer.", next_step_wording: "An officer will call you back.",
      };
      const facts = "YOU ARE the complaint assistant of the CY Police cyber crime cell. Office hours for walk-ins 10 AM to 5 PM.";
      const r = await setUpProgram(cy!.id, { programKey: CY_POLICE_PROGRAM, values, facts }, actor);
      expect(r.issues).toEqual([]);
      const [agent] = await withTenant(cy!.id, (tx) => tx.select().from(agents).where(eq(agents.id, r.program.agentId!)));
      expect(agent!.domain).toBe(CYBER_INTAKE_DOMAIN); // gets the evidence-intake safety rules
    } finally {
      await db.delete(organizations).where(eq(organizations.id, cy!.id));
    }
  });

  it("brings the program's own safety cases into the publish check", async () => {
    const [cp] = await withTenant(tenant, (tx) => tx.select().from(clientPrograms).where(eq(clientPrograms.programKey, "clinic.revisit_recall")));
    const [v] = await withTenant(tenant, (tx) => tx.select().from(agentVersions).where(eq(agentVersions.agentId, cp!.agentId!)));
    const check = await withTenant(tenant, (tx) => requestSafetyCheck(tx, { tenantId: tenant, versionId: v!.id, reason: "manual", requestedBy: actor }));
    expect(check.extraCases.map((c) => c.id)).toContain("recall_wrong_person");
    expect(check.vertical).toBe("health"); // the program's risks, not the workspace label
    await runSafetyCheck({ tenantId: tenant, id: check.id }, goodModel, 3);
    const [done] = await withTenant(tenant, (tx) => tx.select().from(agentSafetyChecks).where(eq(agentSafetyChecks.id, check.id)));
    expect(done!.status).toBe("passed");
    // 16 universal + 2 health + 2 from this program
    expect((done!.results as unknown[]).length).toBe(20);
  });

  it("creates a campaign that inherits the program's rules", async () => {
    const num = await withTenant(tenant, async (tx) => {
      const acct = await addCarrierAccount(tx, tenant, { provider: "vobiz", mode: "managed_subaccount", displayName: "program test" }, actor);
      return addPhoneNumber(tx, tenant, { carrierAccountId: acct.id, e164: "+914012345678", series: "landline", purpose: "both" });
    });
    const [cp] = await withTenant(tenant, (tx) => tx.select().from(clientPrograms).where(eq(clientPrograms.programKey, "clinic.revisit_recall")));
    const { campaign, program } = await withTenant(tenant, (tx) => campaignFromProgram(tx, tenant, { clientProgramId: cp!.id, callerNumberId: num!.id, createdBy: actor }));
    expect(campaign.purpose).toBe("service"); // not promotional: no 140-series needed, patients on DND may be called
    expect(campaign.windows).toEqual(program.defaults.windows);
    expect(campaign.maxAttempts).toBe(program.defaults.maxAttempts);
    expect(campaign.clientProgramId).toBe(cp!.id);
  });

  it("knows which per-person data a target row is missing", async () => {
    const [p] = await withTenant(tenant, (tx) => tx.select().from(programTemplates).where(eq(programTemplates.key, "municipal.property_tax_due")));
    expect(missingVariables(p!, { ptin: "1022345678", amount_due: "4250" }, "Lakshmi")).toEqual(["Last date to pay"]);
    expect(missingVariables(p!, { ptin: "1", amount_due: "2", due_date: "2026-10-15" }, "Lakshmi")).toEqual([]);
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

  it("fetches a transcript it was refused earlier, once the engine allows it", async () => {
    const at = new Date().toISOString();
    fake.runs.set(2, [
      ...(fake.runs.get(2) ?? []),
      { id: 904, workflow_id: 2, is_completed: true, created_at: at, call_type: "inbound", cost_info: { call_duration_seconds: 95 }, initial_context: { caller_number: "919876500004" }, gathered_context: {}, transcript_public_url: `${fake.url}/api/v1/public/download/workflow/t904/transcript`, recording_public_url: `${fake.url}/api/v1/public/download/workflow/t904/recording` },
    ]);
    fake.refuseArtifacts = true;
    const s1 = await syncTenantCalls(tenant);
    expect(s1.transcriptMisses).toBe(1);
    const row = async () => (await withTenant(tenant, (tx) => tx.select().from(calls).where(eq(calls.externalRunId, "904"))))[0]!;
    expect((await row()).status).toBe("completed");
    expect((await row()).transcript).toBeNull();
    const [conn] = await withTenant(tenant, (tx) => tx.select().from(voiceConnections));
    expect(conn!.status).toBe("ok"); // a refused download is not a broken connection

    fake.refuseArtifacts = false;
    const s2 = await syncTenantCalls(tenant);
    expect(s2.transcriptMisses).toBe(0);
    expect((await row()).transcript).toBe("transcript for t904");
  });

  it("keeps its own copy of each recording when told to, retrying one it was refused", async () => {
    const at = new Date().toISOString();
    fake.runs.set(2, [
      ...(fake.runs.get(2) ?? []),
      { id: 905, workflow_id: 2, is_completed: true, created_at: at, call_type: "inbound", cost_info: { call_duration_seconds: 240 }, initial_context: { caller_number: "919876500005" }, gathered_context: {}, transcript_public_url: `${fake.url}/api/v1/public/download/workflow/t905/transcript`, recording_public_url: `${fake.url}/api/v1/public/download/workflow/t905/recording` },
    ]);
    const held = async () =>
      (await withTenant(tenant, (tx) => tx.select({ r: callRecordings }).from(callRecordings).innerJoin(calls, eq(calls.id, callRecordings.callId)).where(eq(calls.externalRunId, "905"))))[0]?.r;
    const downloads = () => fake.requests.filter((r) => r.endsWith("/t905/recording")).length;

    fake.refuseArtifacts = true;
    const s1 = await syncTenantCalls(tenant, { storeRecordings: true });
    expect(s1.recordingMisses).toBeGreaterThan(0);
    expect(s1.errors.join(" ")).toMatch(/recording not copied \(download refused \(403\)\)/);
    expect(await held()).toBeUndefined();

    fake.refuseArtifacts = false;
    const s2 = await syncTenantCalls(tenant, { storeRecordings: true });
    expect(s2.recordingMisses).toBe(0);
    expect(s2.recordingsStored).toBeGreaterThan(0);
    const r = (await held())!;
    expect(r.bytes.toString()).toBe("RIFF");
    expect(r.mime).toBe("audio/wav");
    expect(r.sizeBytes).toBe(4);
    expect(r.sha256).toBe(createHash("sha256").update("RIFF").digest("hex"));

    // Held here now: a later sync neither re-reads the call nor downloads it again.
    const before = downloads();
    const s3 = await syncTenantCalls(tenant, { storeRecordings: true });
    expect(s3.recordingsStored).toBe(0);
    expect(downloads()).toBe(before);
  });

  it("keeps what the analyser found when a call is read again", async () => {
    await withTenant(tenant, (tx) =>
      tx
        .update(calls)
        .set({ extracted: sql`${calls.extracted} || '{"complaint_type":"UPI fraud","caller_name":"Analysed Name"}'::jsonb`, summary: "Analysed summary", analyzedAt: new Date(), status: "in_progress" })
        .where(eq(calls.externalRunId, "901")),
    );
    await syncTenantCalls(tenant); // re-reads 901: the engine's gathered context says caller_name "Ravi"
    const [c] = await withTenant(tenant, (tx) => tx.select().from(calls).where(eq(calls.externalRunId, "901")));
    expect(c!.status).toBe("completed");
    expect(c!.summary).toBe("Analysed summary");
    expect(c!.extracted.complaint_type).toBe("UPI fraud");
    expect(c!.extracted.caller_name).toBe("Analysed Name");
    expect(c!.extracted.concern).toBe("implant consultation"); // engine fields still fill gaps
  });

  it("never imports calls from before the start date (test calls before going live)", async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const fresh = new Date().toISOString();
    fake.runs.set(2, [
      ...(fake.runs.get(2) ?? []),
      { id: 906, workflow_id: 2, is_completed: true, created_at: old, call_type: "inbound", cost_info: { call_duration_seconds: 30 }, initial_context: { caller_number: "919876500006" }, gathered_context: {} },
      { id: 907, workflow_id: 2, is_completed: true, created_at: fresh, call_type: "inbound", cost_info: { call_duration_seconds: 30 }, initial_context: { caller_number: "919876500007" }, gathered_context: {} },
    ]);
    await syncTenantCalls(tenant, { since: new Date(Date.now() - 60_000) });
    const ids = (await withTenant(tenant, (tx) => tx.select({ id: calls.externalRunId }).from(calls))).map((r) => r.id);
    expect(ids).toContain("907");
    expect(ids).not.toContain("906");
    expect(() => syncSinceFromEnv({ JENAI_SYNC_SINCE: "yesterday-ish" })).toThrow(/not a date/);
    expect(syncSinceFromEnv({ JENAI_SYNC_SINCE: "2026-10-03T00:00:00+05:30" })?.toISOString()).toBe("2026-10-02T18:30:00.000Z");
    expect(syncSinceFromEnv({})).toBeNull();
  });

  it("one broken agent does not switch syncing off for the workspace", async () => {
    const [extra] = await withTenant(tenant, (tx) =>
      tx.insert(agents).values({ tenantId: tenant, name: "Retired line", templateKey: "clinic_receptionist", templateVersion: 2, inboundWorkflowId: 777 }).returning(),
    );
    fake.failRuns.add(777);
    try {
      const s = await syncTenantCalls(tenant);
      expect(s.failedWorkflows).toBe(1);
      expect(s.errors[0]).toMatch(/workflow 777/);
      const [conn] = await withTenant(tenant, (tx) => tx.select().from(voiceConnections));
      expect(conn!.status).toBe("ok");
      expect(conn!.lastError).toMatch(/workflow 777/);
    } finally {
      fake.failRuns.delete(777);
      await withTenant(tenant, (tx) => tx.delete(agents).where(eq(agents.id, extra!.id)));
    }
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
      // This workspace also has program campaigns now: use the one these dialer tests made.
      const [c] = await tx.select().from(campaigns).where(eq(campaigns.name, "Recall"));
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
    expect(s.usage.minutes).toBe(4 + 1 + 2 + 4 + 1 + 1); // 184 s -> 4 started minutes, 1 s -> 1, 95 s -> 2, 240 s -> 4, two 30 s calls -> 1 each, unfinished -> 0
    expect(s.fixedFeePaise).toBe(799_900);
    expect(s.billableMinutes).toBe(0); // inside the 1,200 included minutes
  });
});
