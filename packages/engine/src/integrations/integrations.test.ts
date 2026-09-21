/**
 * Write-backs to a client's own system, and calls their system asks for.
 * A small HTTP server stands in for their CRM.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  branches,
  calls,
  campaignTargets,
  campaigns,
  clientPrograms,
  contacts,
  externalLinks,
  integrationEvents,
  integrations,
  organizations,
  phoneNumbers,
  platformDb,
  withTenant,
} from "@jenai/db";
import { setUpProgram } from "../programs";
import { addCarrierAccount, addPhoneNumber } from "../telephony";
import { claimDeliveries, deliver, sealCredentials } from "./queue";
import { emitCallCompleted } from "./events";
import { verifySignature } from "./http";
import { CallRequestError, requestCall } from "./inbound";

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = "";
const received: Received[] = [];
let answer: { status: number; body: string } = { status: 200, body: `{"ok":true,"id":"CRM-1"}` };

let tenant = "";
let integrationId = "";
const SECRET = "whsec_test_secret";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const db = platformDb();
  const [org] = await db
    .insert(organizations)
    .values({ kind: "client", name: "Integration Test Clinic", slug: `int-test-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] })
    .returning();
  tenant = org!.id;
  await withTenant(tenant, (tx) => tx.insert(branches).values({ tenantId: tenant, name: "Main", languages: ["en"] }));
  const [row] = await withTenant(tenant, (tx) =>
    tx
      .insert(integrations)
      .values({
        tenantId: tenant,
        kind: "webhook_out",
        name: "Their CRM",
        status: "connected",
        config: { url: `${base}/jenai-hook` },
        credentials: sealCredentials(tenant, { signing_secret: SECRET }),
        events: ["call.completed"],
      })
      .returning(),
  );
  integrationId = row!.id;
});

afterAll(async () => {
  await platformDb().delete(organizations).where(eq(organizations.id, tenant));
  await new Promise<void>((r) => server.close(() => r()));
});

let seq = 500;
async function seedCall(outcome: string) {
  const phone = `+9198000005${String(++seq).slice(-2)}`;
  return withTenant(tenant, async (tx) => {
    const [contact] = await tx.insert(contacts).values({ tenantId: tenant, phoneE164: phone, name: "Ravi", tags: [] }).returning();
    const [c] = await tx
      .insert(calls)
      .values({
        tenantId: tenant,
        contactId: contact!.id,
        provider: "dograh",
        externalRunId: `run-${randomUUID().slice(0, 8)}`,
        direction: "outbound",
        status: "completed",
        fromE164: "+914012345678",
        toE164: phone,
        startedAt: new Date(),
        durationS: 96,
        summary: "Patient will come on Friday",
        extracted: { outcome, preferred_time: "25 Sep 2026, 11:00 AM", next_step: "booked", booked: "yes" },
      })
      .returning();
    return { call: c!, contact: contact!, phone };
  });
}

describe("handing results back to the client's own system", () => {
  it("signs the payload, sends the fields their CRM needs, and never sends twice", async () => {
    const { call } = await seedCall("booked");
    expect(await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id))).toBe(1);
    // Queuing the same call again adds nothing.
    expect(await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id))).toBe(0);

    const claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    expect(claimed).toHaveLength(1);
    const r = await deliver(claimed[0]!);
    expect(r.ok).toBe(true);

    const hit = received.at(-1)!;
    expect(hit.path).toBe("/jenai-hook");
    expect(hit.headers["x-jenai-event"]).toBe("call.completed");
    expect(verifySignature(SECRET, hit.body, String(hit.headers["x-jenai-signature"]))).toBe(true);
    expect(verifySignature("wrong-secret", hit.body, String(hit.headers["x-jenai-signature"]))).toBe(false);
    const body = JSON.parse(hit.body);
    expect(body.call.outcome).toBe("booked");
    expect(body.call.seconds).toBe(96);
    expect(body.person.phone).toBe(body.person.phone);
    expect(body.person.phone).toMatch(/^\+9198000005/);
    expect(body.appointment).toEqual({ at: "25 Sep 2026, 11:00 AM", booked: true });
    expect(await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.status, "done")))).toHaveLength(1);
  });

  it("remembers which record in their system this person is", async () => {
    const [link] = await withTenant(tenant, (tx) => tx.select().from(externalLinks).where(eq(externalLinks.integrationId, integrationId)));
    expect(link?.externalId).toBeUndefined(); // a plain webhook returns no record id
  });

  it("keeps trying when their system is down, and gives up on a refusal", async () => {
    answer = { status: 500, body: "boom" };
    const { call } = await seedCall("callback");
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
    let claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    let r = await deliver(claimed[0]!);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("queued"); // will try again later
    let [ev] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.refId, call.id)));
    expect(ev!.attempts).toBe(1);
    expect(ev!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // A refusal (their endpoint says the request is wrong) is not retried for ever.
    answer = { status: 400, body: "bad request" };
    await withTenant(tenant, (tx) => tx.update(integrationEvents).set({ status: "queued", nextAttemptAt: new Date() }).where(eq(integrationEvents.id, ev!.id)));
    claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    r = await deliver(claimed[0]!);
    expect(r.status).toBe("failed");
    [ev] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.id, ev!.id)));
    expect(ev!.error).toContain("bad request");
    const [i] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, integrationId)));
    expect(i!.status).toBe("error"); // the client sees it on their integrations page
    answer = { status: 200, body: `{"ok":true}` };
    await withTenant(tenant, (tx) => tx.update(integrations).set({ status: "connected" }).where(eq(integrations.id, integrationId)));
  });

  it("refuses to send to an internal address, whatever the client typed", async () => {
    const [bad] = await withTenant(tenant, (tx) =>
      tx.insert(integrations).values({ tenantId: tenant, kind: "webhook_out", name: "Sneaky", status: "connected", config: { url: "http://169.254.169.254/latest/meta-data/" }, events: ["call.completed"] }).returning(),
    );
    const { call } = await seedCall("won");
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
    const [event] = await withTenant(tenant, (tx) =>
      tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, bad!.id), eq(integrationEvents.refId, call.id))),
    );
    // Production never sets this switch; the tests use it only for the fake CRM on localhost.
    const relaxed = process.env.JENAI_ALLOW_PRIVATE_WEBHOOKS;
    process.env.JENAI_ALLOW_PRIVATE_WEBHOOKS = "false";
    try {
      await withTenant(tenant, (tx) => tx.update(integrationEvents).set({ status: "sending" }).where(eq(integrationEvents.id, event!.id)));
      const r = await deliver({ tenantId: tenant, id: event!.id });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Blocked address/);
    } finally {
      process.env.JENAI_ALLOW_PRIVATE_WEBHOOKS = relaxed;
    }
    await withTenant(tenant, (tx) => tx.delete(integrations).where(eq(integrations.id, bad!.id)));
  });
});

describe("calls their own system asks for", () => {
  beforeAll(async () => {
    await setUpProgram(
      tenant,
      {
        programKey: "clinic.appointment_reminder",
        values: { clinic_name: "Integration Test Clinic", clinic_location: "Madhapur", front_desk_number: "040 1111 2222" },
        facts: "YOU ARE the receptionist at Integration Test Clinic, Madhapur, Hyderabad. Timings 10 AM to 7 PM, Monday to Saturday. Services: skin, hair and laser treatments. The ONLY price you know is the consultation at 500 rupees.",
      },
      null,
    );
    await withTenant(tenant, async (tx) => {
      const acct = await addCarrierAccount(tx, tenant, { provider: "vobiz", mode: "managed_subaccount", displayName: "test" }, null);
      const num = await addPhoneNumber(tx, tenant, { carrierAccountId: acct.id, e164: "+914012345678", series: "landline", purpose: "both" });
      await tx.update(clientPrograms).set({ callerNumberId: num.id }).where(eq(clientPrograms.programKey, "clinic.appointment_reminder"));
    });
  });

  it("asks for the data the program needs before it will queue a call", async () => {
    await expect(
      requestCall(tenant, { programKey: "clinic.appointment_reminder", phone: "9876500011", name: "Sita", context: {} }),
    ).rejects.toThrow(CallRequestError);
  });

  it("queues the call and says straight away what the rules allow", async () => {
    const r = await requestCall(tenant, {
      programKey: "clinic.appointment_reminder",
      phone: "9876500011",
      name: "Sita",
      context: { appointment_date: "25 Sep 2026", appointment_time: "11:00 AM", purpose: "laser session", doctor: "Dr Rickson", branch: "Madhapur" },
      externalId: "ZOHO-4412",
      integrationId,
      idempotencyKey: "their-ticket-9001",
    });
    expect(r.status).toBe("queued");
    // The number has not been declared to the operator for AI calls, so the rules
    // refuse it and their system is told straight away, before anyone waits.
    expect(r.preview.action).toBe("skip");
    expect(r.preview.reason).toMatch(/declared to the operator/);
    const [t] = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.id, r.targetId)));
    expect(t!.context).toMatchObject({ appointment_date: "25 Sep 2026", doctor: "Dr Rickson" });
    // Their record is remembered, so the result lands back on it.
    const [link] = await withTenant(tenant, (tx) => tx.select().from(externalLinks).where(eq(externalLinks.externalId, "ZOHO-4412")));
    expect(link).toBeTruthy();
    // The campaign it went into is the standing one for this program.
    const [c] = await withTenant(tenant, (tx) => tx.select().from(campaigns).where(eq(campaigns.id, t!.campaignId)));
    expect(c!.onDemand).toBe(true);
    expect(c!.purpose).toBe("transactional");
  });

  it("goes through once the number is declared for AI calling", async () => {
    await withTenant(tenant, (tx) => tx.update(phoneNumbers).set({ a2pDeclaredAt: new Date(), a2pReference: "A2P-TEST-1" }).where(eq(phoneNumbers.e164, "+914012345678")));
    const r = await requestCall(tenant, {
      programKey: "clinic.appointment_reminder",
      phone: "9876500044",
      name: "Meena",
      context: { appointment_date: "26 Sep 2026", appointment_time: "10:30 AM", purpose: "review", doctor: "Dr Rickson", branch: "Madhapur" },
    });
    expect(["dial", "defer"]).toContain(r.preview.action);
  });

  it("treats the same request twice as one call", async () => {
    const again = await requestCall(tenant, {
      programKey: "clinic.appointment_reminder",
      phone: "9876500011",
      name: "Sita",
      context: { appointment_date: "25 Sep 2026", appointment_time: "11:00 AM", purpose: "laser session", doctor: "Dr Rickson", branch: "Madhapur" },
      idempotencyKey: "their-ticket-9001",
    });
    expect(again.status).toBe("duplicate");
    const targets = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.phoneE164, "+919876500011")));
    expect(targets).toHaveLength(1);
  });

  it("will not call a number that asked not to be called, and says so at once", async () => {
    await withTenant(tenant, (tx) => tx.execute(`insert into suppressions (tenant_id, phone_e164, reason, source) values ('${tenant}', '+919876500022', 'opt_out', 'test')` as never));
    const r = await requestCall(tenant, {
      programKey: "clinic.appointment_reminder",
      phone: "9876500022",
      name: "Arun",
      context: { appointment_date: "25 Sep 2026", appointment_time: "12:00 PM", purpose: "review", doctor: "Dr Rickson", branch: "Madhapur" },
    });
    expect(r.preview.action).toBe("skip");
    expect(r.preview.reason).toMatch(/Do-not-call/i);
    const [t] = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.id, r.targetId)));
    expect(t!.state).toBe("skipped");
  });

  it("calls the same person again later, with the new details", async () => {
    const ask = (date: string, key: string) =>
      requestCall(tenant, {
        programKey: "clinic.appointment_reminder",
        phone: "9876500055",
        name: "Kiran",
        context: { appointment_date: date, appointment_time: "09:30 AM", purpose: "review", doctor: "Dr Rickson", branch: "Madhapur" },
        idempotencyKey: key,
      });
    const first = await ask("26 Sep 2026", "visit-1");
    // Finish that call, the way the dialer would.
    await withTenant(tenant, (tx) => tx.update(campaignTargets).set({ state: "completed", lastOutcome: "answered" }).where(eq(campaignTargets.id, first.targetId)));
    const second = await ask("20 Oct 2026", "visit-2");
    expect(second.status).toBe("queued");
    expect(second.targetId).toBe(first.targetId); // one row per person in the standing campaign
    const [t] = await withTenant(tenant, (tx) => tx.select().from(campaignTargets).where(eq(campaignTargets.id, second.targetId)));
    expect(t!.state).toBe("queued");
    expect(t!.context).toMatchObject({ appointment_date: "20 Oct 2026" });
    expect(t!.attemptNo).toBe(0);
    // While a call is on its way, asking again does not queue a second one.
    const third = await ask("20 Oct 2026", "visit-3");
    expect(third.status).toBe("duplicate");
  });

  it("refuses a program this workspace does not run", async () => {
    await expect(requestCall(tenant, { programKey: "municipal.property_tax_due", phone: "9876500033" })).rejects.toThrow(/No such calling program/);
  });
});
