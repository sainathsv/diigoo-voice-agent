/**
 * Write-backs to a client's own system, and calls their system asks for.
 * A small HTTP server stands in for their CRM.
 */
import "@jenai/db/env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  leads,
  organizations,
  phoneNumbers,
  platformDb,
  type Integration,
  suppressions,
  withTenant,
} from "@jenai/db";
import { analyzeCalls, heardOptOut, type Extractor } from "../analyze";
import { setUpProgram } from "../programs";
import { addCarrierAccount, addPhoneNumber } from "../telephony";
import { claimDeliveries, credentialsOf, deliver, enqueueEvent, sealCredentials, subscribers, testConnection } from "./queue";
import { zohoConnector } from "./zoho";
import { exchangeGrantCode, saveZohoConnection } from "./zoho-connect";
import { EVENT_KINDS, emitCallCompleted, emitLeadUpdated, healthWithheld } from "./events";
import { sharedWith } from "./types";
import { verifySignature } from "./http";
import { CallRequestError, requestCall } from "./inbound";

// The real queue. One test below makes it fail on purpose.
vi.mock("./queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("./queue")>();
  return { ...real, enqueueEvent: vi.fn(real.enqueueEvent) };
});

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

const eventRow = async (id: string) => (await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.id, id))))[0]!;

const integrationStatus = async (id: string) =>
  (await withTenant(tenant, (tx) => tx.select({ status: integrations.status }).from(integrations).where(eq(integrations.id, id))))[0]?.status;

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

  it("keeps trying when their system is down, and skips a refusal without switching the connection off", async () => {
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

    // A refusal (their endpoint says this request is wrong) is not retried for
    // ever, and it is about this one event: the next call still goes to them.
    answer = { status: 400, body: "bad request" };
    await withTenant(tenant, (tx) => tx.update(integrationEvents).set({ status: "queued", nextAttemptAt: new Date() }).where(eq(integrationEvents.id, ev!.id)));
    claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    r = await deliver(claimed[0]!);
    expect(r.status).toBe("skipped");
    [ev] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.id, ev!.id)));
    expect(ev!.status).toBe("skipped");
    expect(ev!.error).toContain("bad request"); // the reason, for whoever works the list
    expect(await integrationStatus(integrationId)).toBe("connected");
    // Said on the connection too, where the client looks.
    const [conn] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, integrationId)));
    expect(conn!.lastError).toContain("bad request");
    expect((await withTenant(tenant, (tx) => subscribers(tx, "call.completed"))).map((s) => s.id)).toContain(integrationId);
    answer = { status: 200, body: `{"ok":true}` };
  });

  it("switches the connection off when their system refuses our key", async () => {
    answer = { status: 401, body: "unknown signing key" };
    const { call } = await seedCall("callback");
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
    const claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    const r = await deliver(claimed[0]!);
    expect(r.status).toBe("failed"); // "Send again" picks it up once the key is fixed
    expect(await integrationStatus(integrationId)).toBe("error"); // the client sees it on their integrations page
    answer = { status: 200, body: `{"ok":true}` };
    await withTenant(tenant, (tx) => tx.update(integrations).set({ status: "connected" }).where(eq(integrations.id, integrationId)));
  });

  it("switches the connection off when their endpoint is gone or turns us away, rather than skipping every event", async () => {
    for (const status of [404, 403, 410]) {
      answer = { status, body: "no such route" };
      const { call } = await seedCall("callback");
      await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
      const claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
      const r = await deliver(claimed[0]!);
      expect(r.status).toBe("failed"); // "Send again" picks it up once the address is fixed
      expect(await integrationStatus(integrationId)).toBe("error");
      await withTenant(tenant, (tx) => tx.update(integrations).set({ status: "connected" }).where(eq(integrations.id, integrationId)));
    }
    answer = { status: 200, body: `{"ok":true}` };
  });

  /** A webhook of its own, so its deliveries can be counted. */
  async function ownHook(name: string, status: "connected" | "error" | "draft" = "connected", lastOkAt: Date | null = null) {
    const [row] = await withTenant(tenant, (tx) =>
      tx.insert(integrations).values({ tenantId: tenant, kind: "webhook_out", name, status, lastOkAt, config: { url: `${base}/${name}` }, events: ["appointment.booked"] }).returning(),
    );
    return row!.id;
  }
  const eventFor = (integrationId: string, values: Partial<typeof integrationEvents.$inferInsert> = {}) =>
    withTenant(tenant, async (tx) =>
      (await tx
        .insert(integrationEvents)
        .values({ tenantId: tenant, integrationId, direction: "out", kind: "appointment.booked", refType: "call", refId: randomUUID(), idempotencyKey: `t-${randomUUID()}`, status: "sending", attempts: 1, payload: { event: "appointment.booked" }, ...values })
        .returning())[0]!,
    );

  it("takes a 404 as one record's only from an API address that names the record", async () => {
    answer = { status: 404, body: "not found" };
    const rest = async (url: string) =>
      (await withTenant(tenant, (tx) => tx.insert(integrations).values({ tenantId: tenant, kind: "rest_generic", name: "Their API", status: "connected", config: { routes: { default: { url } } }, events: ["appointment.booked"] }).returning()))[0]!.id;
    const perRecord = await rest(`${base}/api/patients/{{external_id}}`);
    expect((await deliver({ tenantId: tenant, id: (await eventFor(perRecord, { externalId: "P-9" })).id })).status).toBe("skipped");
    expect(await integrationStatus(perRecord)).toBe("connected");
    expect(received.at(-1)!.path).toBe("/api/patients/P-9");
    const fixed = await rest(`${base}/api/results`);
    expect((await deliver({ tenantId: tenant, id: (await eventFor(fixed)).id })).status).toBe("failed");
    expect(await integrationStatus(fixed)).toBe("error");
    answer = { status: 200, body: `{"ok":true}` };
  });

  it("switches the connection off after twenty refusals in a row, each of which looked like one record's", async () => {
    const hook = await ownHook("strict");
    for (let n = 0; n < 18; n++) await eventFor(hook, { status: "skipped", httpStatus: 400, error: "missing field branch" });
    answer = { status: 400, body: "missing field branch" };
    expect((await deliver({ tenantId: tenant, id: (await eventFor(hook)).id })).status).toBe("skipped");
    expect(await integrationStatus(hook)).toBe("connected"); // nineteen
    expect((await deliver({ tenantId: tenant, id: (await eventFor(hook)).id })).status).toBe("skipped");
    expect(await integrationStatus(hook)).toBe("error");
    const [conn] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, hook)));
    expect(conn!.lastError).toMatch(/^Their system refused the last 20 deliveries\. The latest: missing field branch/);
    answer = { status: 200, body: `{"ok":true}` };
  });

  it("queues for a connection that is not working, and sends once it works again", async () => {
    const hook = await ownHook("held", "error");
    // An opt-out, a booking: queued whatever the connection's health, not dropped.
    expect((await withTenant(tenant, (tx) => subscribers(tx, "appointment.booked"))).map((i) => i.id)).toContain(hook);
    const refId = randomUUID();
    await withTenant(tenant, (tx) => enqueueEvent(tx, tenant, { kind: "appointment.booked", refType: "call", refId, payload: { event: "appointment.booked" } }));
    const [ev] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, hook), eq(integrationEvents.refId, refId))));
    expect(ev!.status).toBe("queued");
    // Taken once, and held: not counted as a try, and out of the worker's way until the connection works.
    const first = (await claimDeliveries(platformDb(), 50)).filter((c) => c.id === ev!.id);
    expect(first).toHaveLength(1);
    expect(await deliver(first[0]!)).toMatchObject({ status: "queued", message: "held: the connection is error" });
    expect(await eventRow(ev!.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await eventRow(ev!.id)).nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);
    expect((await claimDeliveries(platformDb(), 50)).map((c) => c.id)).not.toContain(ev!.id);
    // A Test that passes puts it back, and it goes.
    const [conn] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, hook)));
    expect((await withTenant(tenant, (tx) => testConnection(tx, tenant, conn!))).ok).toBe(true);
    expect(await integrationStatus(hook)).toBe("connected");
    const claimed = (await claimDeliveries(platformDb(), 50)).filter((c) => c.id === ev!.id);
    expect(claimed).toHaveLength(1);
    expect((await deliver(claimed[0]!)).status).toBe("done");
  });

  it("gives up on one event after a day without switching off a connection that delivers everything else", async () => {
    answer = { status: 500, body: "crashed on this one" };
    const busy = await ownHook("busy", "connected", new Date());
    const ev = await eventFor(busy, { attempts: 7, createdAt: new Date(Date.now() - 86_400_000) });
    expect((await deliver({ tenantId: tenant, id: ev.id })).status).toBe("failed");
    expect(await integrationStatus(busy)).toBe("connected");
    // Nothing at all got through that day: then it is the connection.
    const quiet = await ownHook("quiet", "connected", null);
    const lost = await eventFor(quiet, { attempts: 7, createdAt: new Date(Date.now() - 86_400_000) });
    expect((await deliver({ tenantId: tenant, id: lost.id })).status).toBe("failed");
    expect(await integrationStatus(quiet)).toBe("error");
    answer = { status: 200, body: `{"ok":true}` };
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
      expect(await integrationStatus(bad!.id)).toBe("error"); // the address is the connection's, not the event's
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

describe("an opt-out said on a call", () => {
  let crmId = "";
  const saidStop: Extractor = {
    model: "test",
    async extract() {
      return { caller_name: "Ravi", interest_level: "cold", next_step: "none", do_not_call: true, summary: "Asked not to be called again." };
    },
  };

  beforeAll(async () => {
    // Subscribed to every event, the way a Zoho connection is set up.
    const [row] = await withTenant(tenant, (tx) =>
      tx
        .insert(integrations)
        .values({ tenantId: tenant, kind: "webhook_out", name: "Every event", status: "connected", config: { url: `${base}/every-event` }, events: [...EVENT_KINDS] })
        .returning(),
    );
    crmId = row!.id;
  });

  async function heardStop() {
    const seeded = await seedCall("none");
    await withTenant(tenant, (tx) =>
      tx.update(calls).set({ extracted: {}, transcript: "Agent: Hello Ravi. Caller: Please do not call me again." }).where(eq(calls.id, seeded.call.id)),
    );
    return seeded;
  }

  const optedOut = (phone: string) => withTenant(tenant, (tx) => tx.select().from(suppressions).where(eq(suppressions.phoneE164, phone)));
  const analysedAt = async (callId: string) => (await withTenant(tenant, (tx) => tx.select().from(calls).where(eq(calls.id, callId))))[0]?.analyzedAt;

  it("keeps the opt-out and tells a system that subscribes to it", async () => {
    const { call, contact, phone } = await heardStop();
    await withTenant(tenant, (tx) =>
      tx.insert(externalLinks).values({ tenantId: tenant, integrationId: crmId, ourType: "contact", ourId: contact.id, externalType: "Leads", externalId: "ZOHO-STOP-1" }),
    );
    const stats = await analyzeCalls(tenant, saidStop);
    expect(stats).toMatchObject({ analyzed: 1, optOuts: 1, failed: 0 });
    expect(await optedOut(phone)).toHaveLength(1);
    expect(await analysedAt(call.id)).toBeTruthy(); // not read again by the model next round

    const [ev] = await withTenant(tenant, (tx) =>
      tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, crmId), eq(integrationEvents.kind, "do_not_call.added"))),
    );
    expect(ev!.payload).toMatchObject({ person: { contact_id: contact.id, phone } });
    // Their record is found through our contact, not through the phone number.
    expect(ev!.externalId).toBe("ZOHO-STOP-1");
  });

  it("keeps the opt-out even when handing it on fails", async () => {
    const { call, phone } = await heardStop();
    const real = await vi.importActual<typeof import("./queue")>("./queue");
    // The same Postgres error the phone number caused in production, raised inside the queue.
    vi.mocked(enqueueEvent).mockImplementation(async (tx, tenantId, input) => {
      // Fails with the number among its parameters, as the real failure did.
      if (input.kind === "do_not_call.added") await tx.execute(sql`select ${phone}::uuid`);
      return real.enqueueEvent(tx, tenantId, input);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stats = await analyzeCalls(tenant, saidStop);
      expect(stats).toMatchObject({ analyzed: 1, optOuts: 1, failed: 0 });
      // Said, without the number: process logs leave the tenant boundary.
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/do_not_call\.added not queued for tenant .*: postgres 22P02/));
      expect(logged.mock.calls.flat().join(" ")).not.toContain(phone.slice(1));
    } finally {
      vi.mocked(enqueueEvent).mockImplementation(real.enqueueEvent);
      logged.mockRestore();
    }
    expect(await optedOut(phone)).toHaveLength(1);
    expect(await analysedAt(call.id)).toBeTruthy();
    // The rest of the analysis carried on: the call itself still goes to their system.
    const sent = await withTenant(tenant, (tx) =>
      tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, crmId), eq(integrationEvents.refId, call.id), eq(integrationEvents.kind, "call.completed"))),
    );
    expect(sent).toHaveLength(1);
  });
});

describe("hearing an opt-out, however the call recorded it", () => {
  it("takes the standard answer, a program's own answer, or its outcome", () => {
    const offers = { key: "clinic.offers", extraction: [], outcomes: [], purpose: "promotional" };
    const reminder = { key: "general.payment_reminder", extraction: [], outcomes: [], purpose: "transactional" };
    expect(heardOptOut({ do_not_call: true } as never, {}, {}, offers)).toEqual({ scope: null });
    // "Stop calling me with offers": about offers, so their reminders still reach them.
    expect(heardOptOut({ do_not_call: null } as never, {}, { outcome: "do_not_call" }, offers)).toEqual({ scope: "promotional" });
    expect(heardOptOut(null, {}, { do_not_call: "yes" }, offers)).toEqual({ scope: "promotional" });
    // On any other program, every call: the safe reading.
    expect(heardOptOut(null, {}, { asked_to_stop_calling: "yes" }, reminder)).toEqual({ scope: null });
    expect(heardOptOut(null, {}, { asked_to_stop_calling: "no", outcome: "will_pay" }, reminder)).toBeNull();
  });

  it("stops calling a number that is not one of our contacts, and tells their system", async () => {
    const [crm] = await withTenant(tenant, (tx) =>
      tx.insert(integrations).values({ tenantId: tenant, kind: "webhook_out", name: "Opt-outs", status: "connected", config: { url: `${base}/opt-outs` }, events: ["do_not_call.added"] }).returning(),
    );
    const { call, phone } = await seedCall("none");
    await withTenant(tenant, (tx) => tx.update(calls).set({ contactId: null, extracted: {}, transcript: "Caller: Do not call me again." }).where(eq(calls.id, call.id)));
    const stop: Extractor = { model: "test", async extract() { return { do_not_call: true, summary: "Asked not to be called." }; } };
    expect(await analyzeCalls(tenant, stop)).toMatchObject({ analyzed: 1, optOuts: 1, failed: 0 });
    const kept = await withTenant(tenant, (tx) => tx.select().from(suppressions).where(eq(suppressions.phoneE164, phone)));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.scope).toBeNull();
    const [ev] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, crm!.id), eq(integrationEvents.kind, "do_not_call.added"))));
    expect(ev!.payload).toMatchObject({ person: { contact_id: null, phone } });
  });
});

describe("logging calls on their Zoho records", () => {
  // Zennara's grant: no leads.CREATE, so a caller who is not in Zoho stays out of it.
  const SCOPES = ["leads.READ", "leads.UPDATE", "contacts.READ", "contacts.UPDATE", "calls.CREATE", "notes.CREATE"].map((s) => `ZohoCRM.modules.${s}`).concat("ZohoCRM.settings.fields.READ");
  let zohoId = "";
  const asked: string[] = [];
  // Each search, as "Module what=value", in the order asked.
  const searched: string[] = [];
  // What each request carried, for the ones whose body matters.
  const sent: Array<{ req: string; body: Record<string, unknown> }> = [];
  // Stands in for Zoho, answering by method and path (and the query, for a search) with the bodies Zoho documents.
  let zoho: (req: string, token: string, query: string) => { status: number; body?: unknown } = () => ({ status: 500 });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const req = `${init?.method ?? "GET"} ${url.pathname}`;
    asked.push(req);
    // Decoded the way Zoho reads it: a "+" sent unencoded would come back as a space.
    const query = [...url.searchParams].map(([k, v]) => `${k}=${v}`).join("&");
    if (url.pathname.endsWith("/search")) searched.push(`${url.pathname.split("/")[3]} ${query}`);
    if (typeof init?.body === "string") sent.push({ req, body: (JSON.parse(init.body) as { data: Array<Record<string, unknown>> }).data[0]! });
    const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace("Zoho-oauthtoken ", "");
    const r = zoho(req, token, query);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const added = (id: string) => ({ status: 201, body: { data: [{ code: "SUCCESS", details: { id }, message: "record added", status: "success" }] } });
  const updated = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", details: { id }, message: "record updated", status: "success" }] } });
  const bodyOf = (req: string) => sent.find((s) => s.req === req)?.body;

  beforeAll(async () => {
    const [row] = await withTenant(tenant, (tx) =>
      tx.insert(integrations).values({ tenantId: tenant, kind: "zoho_crm", name: "Zoho", status: "connected", config: { dc: "in", module: "Leads", scopes: SCOPES }, mapping: { fields: { Lead_Status: "call.outcome" } }, events: ["call.completed"] }).returning(),
    );
    zohoId = row!.id;
  });

  const aCall = (seconds = 75) => ({ person: { phone: "+919800000777", name: "Lakshmi" }, call: { outcome: "booked", seconds, at: new Date(Date.now() - 600_000).toISOString() }, program: { name: "Front desk" } });

  /** One event on its way to Zoho, with an access token cached the way the worker leaves it. */
  async function readyToSend(
    opts: {
      externalId?: string;
      externalType?: string;
      token?: string;
      kind?: string;
      payload?: Record<string, unknown>;
      module?: string;
      mapping?: Record<string, string>;
      scopes?: string[];
      config?: Record<string, unknown>;
    } = {},
  ) {
    asked.length = 0;
    searched.length = 0;
    sent.length = 0;
    return withTenant(tenant, async (tx) => {
      const credentials = { client_id: "cid", client_secret: "secret", refresh_token: "refresh", access_token: opts.token ?? "cached", access_token_until: String(Date.now() + 3_600_000) };
      await tx
        .update(integrations)
        .set({
          status: "connected",
          credentials: sealCredentials(tenant, credentials),
          config: { dc: "in", module: opts.module ?? "Leads", scopes: opts.scopes ?? SCOPES, ...opts.config },
          mapping: { fields: opts.mapping ?? { Lead_Status: "call.outcome" } },
        })
        .where(eq(integrations.id, zohoId));
      const [ev] = await tx
        .insert(integrationEvents)
        .values({
          tenantId: tenant,
          integrationId: zohoId,
          direction: "out",
          kind: opts.kind ?? "call.completed",
          refType: "call",
          refId: randomUUID(),
          externalId: opts.externalId ?? null,
          externalType: opts.externalType ?? null,
          idempotencyKey: `zoho-${randomUUID()}`,
          status: "sending",
          attempts: 1,
          payload: opts.payload ?? aCall(),
        })
        .returning();
      return ev!;
    });
  }
  const send = (id: string) => deliver({ tenantId: tenant, id }, fakeFetch);
  const errorOf = async (id: string) => (await eventRow(id)).error;

  it("skips a caller who is not in Zoho, and keeps logging everyone else", async () => {
    zoho = (req) => (req.endsWith("/search") ? { status: 204 } : { status: 500 });
    const ev = await readyToSend();
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/No matching record in Zoho for this number \(looked in Leads and Contacts\)/); // the front desk's list of people to add
    // Every way the number may have been saved, in Leads and then in Contacts.
    const ways = (m: string) => [
      `${m} phone=+919800000777`,
      `${m} phone=9800000777`,
      `${m} criteria=((Mobile:equals:+919800000777)or(Phone:equals:+919800000777))`,
      `${m} criteria=((Mobile:equals:9800000777)or(Phone:equals:9800000777))`,
    ];
    expect(searched).toEqual([...ways("Leads"), ...ways("Contacts")]);
    expect(await integrationStatus(zohoId)).toBe("connected");
    expect((await withTenant(tenant, (tx) => subscribers(tx, "call.completed"))).map((s) => s.id)).toContain(zohoId);
  });

  /** A person we know, linked to a Zoho record, with an event on its way for them. */
  async function linkedTo(externalId: string, externalType = "Leads", phone = "+919800000790") {
    const person = { contact_id: randomUUID(), name: "Lakshmi", phone };
    await withTenant(tenant, (tx) => tx.insert(externalLinks).values({ tenantId: tenant, integrationId: zohoId, ourType: "contact", ourId: person.contact_id, externalType, externalId }));
    const ev = await readyToSend({ externalId, externalType, payload: { ...aCall(), person } });
    return { person, ev };
  }
  const linkOf = async (contactId: string) =>
    (await withTenant(tenant, (tx) => tx.select().from(externalLinks).where(and(eq(externalLinks.integrationId, zohoId), eq(externalLinks.ourId, contactId)))))[0];
  const staleId = { status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: "What_Id" }, message: "the related id given seems to be invalid", status: "error" }] } };

  it("finds the person again when the record remembered for them is gone, and remembers the new one", async () => {
    // The front desk converted the Lead into a Contact: Zoho calls the old id invalid.
    zoho = (req, _token, query) => {
      if (req === "POST /crm/v2/Calls") return sent.at(-1)?.body.What_Id === "ZOHO-LEAD-OLD" ? staleId : added("CALL-40");
      if (req === "GET /crm/v2/Contacts/search" && query === "phone=+919800000790") return { status: 200, body: { data: [{ id: "ZOHO-CONTACT-40" }] } };
      if (req.endsWith("/search")) return { status: 204 };
      if (req === "PUT /crm/v2/Contacts/ZOHO-CONTACT-40") return updated("ZOHO-CONTACT-40");
      return { status: 500 };
    };
    const { person, ev } = await linkedTo("ZOHO-LEAD-OLD");
    const r = await send(ev.id);
    expect(r.status).toBe("done");
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ What_Id: "ZOHO-LEAD-OLD" }); // tried first, refused
    expect(sent.filter((x) => x.req === "POST /crm/v2/Calls").at(-1)!.body).toMatchObject({ Who_Id: "ZOHO-CONTACT-40" });
    expect(await eventRow(ev.id)).toMatchObject({ externalId: "ZOHO-CONTACT-40", externalType: "Contacts", progress: { Calls: "CALL-40" } });
    // The next call for them goes straight to the Contact.
    expect(await linkOf(person.contact_id)).toMatchObject({ externalId: "ZOHO-CONTACT-40", externalType: "Contacts" });
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("lets go of a remembered record that is gone when no other has the number, so the next call searches", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? staleId : req.endsWith("/search") ? { status: 204 } : { status: 500 });
    const { person, ev } = await linkedTo("ZOHO-LEAD-GONE", "Leads", "+919800000791");
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/The record we had for this person \(Leads ZOHO-LEAD-GONE\) is gone from Zoho\. No matching record in Zoho for this number/);
    expect(await eventRow(ev.id)).toMatchObject({ externalId: null, externalType: null });
    expect(await linkOf(person.contact_id)).toBeUndefined();
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("switches the connection off when Zoho will not let it search anywhere", async () => {
    const mismatch = { code: "OAUTH_SCOPE_MISMATCH", details: {}, message: "Client does not have ZohoSearch.securesearch.READ scope. Create a new client with valid scope.", status: "error" };
    zoho = (req) => (req.endsWith("/search") ? { status: 401, body: mismatch } : { status: 500 });
    const ev = await readyToSend();
    const r = await send(ev.id);
    // Not "not in Zoho": with the search refused, nobody could have been found.
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/Zoho refused the search in Leads \(OAUTH_SCOPE_MISMATCH\) and Contacts \(OAUTH_SCOPE_MISMATCH\)/);
    expect(r.message).toMatch(/ZohoSearch\.securesearch\.READ/);
    expect(await integrationStatus(zohoId)).toBe("error");
    // The search scope was missing, not each module's: neither module is remembered as unreadable.
    const [row] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, zohoId)));
    expect(row!.config.denied).toBeUndefined();
  });

  it("gets a new token when Zoho has dropped the cached one, rather than switching off", async () => {
    zoho = (req, token) => {
      if (req === "POST /oauth/v2/token") return { status: 200, body: { access_token: "fresh", expires_in: 3600 } };
      if (req === "PUT /crm/v2/Leads/ZOHO-LEAD-7") return updated("ZOHO-LEAD-7");
      if (req !== "POST /crm/v2/Calls") return { status: 500 };
      return token === "fresh" ? added("CALL-1") : { status: 401, body: { code: "INVALID_TOKEN", details: {}, message: "invalid oauth token", status: "error" } };
    };
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-7" });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Calls", "POST /oauth/v2/token", "POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-7"]);
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("waits out Zoho's limit on new tokens, and switches off only when the grant is revoked", async () => {
    zoho = (req) => (req === "POST /oauth/v2/token" ? { status: 400, body: { error: "Access Denied" } } : { status: 500 });
    let ev = await readyToSend({ externalId: "ZOHO-LEAD-7", token: "" });
    expect((await send(ev.id)).status).toBe("queued");
    expect(await integrationStatus(zohoId)).toBe("connected");

    zoho = (req) => (req === "POST /oauth/v2/token" ? { status: 200, body: { error: "invalid_code" } } : { status: 500 });
    ev = await readyToSend({ externalId: "ZOHO-LEAD-7", token: "" });
    const r = await send(ev.id);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/invalid_code/);
    expect(await integrationStatus(zohoId)).toBe("error");
  });

  it("links the call to a Lead through What_Id and to a Contact through Who_Id", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-2") : req.startsWith("PUT ") ? updated("REC") : { status: 500 });
    let ev = await readyToSend({ externalId: "ZOHO-LEAD-8" });
    expect((await send(ev.id)).status).toBe("done");
    // Zoho's Who_Id is always a Contact: a Lead goes in What_Id, with its module named.
    let call = bodyOf("POST /crm/v2/Calls")!;
    expect(call).toMatchObject({ What_Id: "ZOHO-LEAD-8", $se_module: "Leads", Call_Type: "Outbound", Call_Duration: "01:15" });
    expect(call).not.toHaveProperty("Who_Id");
    expect(String(call.Call_Start_Time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);

    ev = await readyToSend({ externalId: "ZOHO-CONTACT-3", module: "Contacts" });
    expect((await send(ev.id)).status).toBe("done");
    call = bodyOf("POST /crm/v2/Calls")!;
    expect(call).toMatchObject({ Who_Id: "ZOHO-CONTACT-3" });
    expect(call).not.toHaveProperty("What_Id");
    expect(call).not.toHaveProperty("$se_module");
    expect(asked).toContain("PUT /crm/v2/Contacts/ZOHO-CONTACT-3");
  });

  it("never sends Zoho a call of no length, which it refuses", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-3") : req.startsWith("PUT ") ? updated("REC") : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-9", payload: aCall(0) });
    expect((await send(ev.id)).status).toBe("done");
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ Call_Duration: "00:01" });
  });

  it("leaves the record's fields alone when no fields are mapped", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-4") : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-10", mapping: {} });
    expect((await send(ev.id)).status).toBe("done");
    // Not a PUT of the raw event onto their Lead.
    expect(asked).toEqual(["POST /crm/v2/Calls"]);
  });

  it("writes a note for a booked visit and for an opt-out, never a call that did not happen", async () => {
    zoho = (req) => (req === "POST /crm/v2/Notes" ? added("NOTE-1") : { status: 500 });
    let ev = await readyToSend({
      externalId: "ZOHO-LEAD-11",
      kind: "appointment.booked",
      payload: { event: "appointment.booked", appointment: { at: "25 Sep 2026, 11:00 AM", source_call: randomUUID() }, person: { phone: "+919800000777" } },
    });
    expect((await send(ev.id)).status).toBe("done");
    // The mapped Lead_Status reads call.outcome, which a booking does not carry, so no PUT either.
    expect(asked).toEqual(["POST /crm/v2/Notes"]);
    expect(bodyOf("POST /crm/v2/Notes")).toMatchObject({ Parent_Id: "ZOHO-LEAD-11", se_module: "Leads", Note_Title: "JENAI: appointment booked" });
    expect(String(bodyOf("POST /crm/v2/Notes")!.Note_Content)).toContain("25 Sep 2026, 11:00 AM");
    expect((await eventRow(ev.id)).progress).toEqual({ Notes: "NOTE-1" });

    ev = await readyToSend({
      externalId: "ZOHO-LEAD-11",
      kind: "do_not_call.added",
      payload: { event: "do_not_call.added", person: { phone: "+919800000777" }, source: "said so on a call" },
    });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Notes"]);
    expect(bodyOf("POST /crm/v2/Notes")).toMatchObject({ Parent_Id: "ZOHO-LEAD-11", Note_Title: "JENAI: asked not to be called" });
  });

  it("skips a kind it has nothing to write for, without asking Zoho anything", async () => {
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-12", kind: "lead.updated", payload: { event: "lead.updated" } });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(asked).toEqual([]);
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("writes a lead's new stage only through the fields mapped, and nothing without a mapping", async () => {
    const payload = { event: "lead.updated", lead: { id: randomUUID(), stage: "won", next_follow_up_at: null }, changed: ["stage"], person: { phone: "+919800000777" } };
    let ev = await readyToSend({ externalId: "ZOHO-LEAD-31", kind: "lead.updated", payload, mapping: {} });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(asked).toEqual([]);

    zoho = (req) => (req === "PUT /crm/v2/Leads/ZOHO-LEAD-31" ? updated("ZOHO-LEAD-31") : { status: 500 });
    ev = await readyToSend({ externalId: "ZOHO-LEAD-31", kind: "lead.updated", payload, mapping: { Lead_Status: "lead.stage" } });
    const r = await send(ev.id);
    expect(r.status).toBe("done");
    // No note and no Call: a stage change is not something said on a call.
    expect(asked).toEqual(["PUT /crm/v2/Leads/ZOHO-LEAD-31"]);
    expect(bodyOf("PUT /crm/v2/Leads/ZOHO-LEAD-31")).toEqual({ Lead_Status: "won" });
    expect(r.message).toMatch(/fields updated on Leads ZOHO-LEAD-31/);
  });

  it("says on the record which try it was, what they asked about, how keen they were and what was agreed", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-32") : req.startsWith("PUT ") ? updated("REC") : { status: 500 });
    const call = { ...aCall().call, attempt: 2, concern: "hair fall treatment", interest_level: "hot", next_step: "booked", summary: "Booked a consultation." };
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-32", payload: { ...aCall(), call, appointment: { at: "25 Sep 2026, 11:00 AM", booked: true }, fields: { skin_type: "oily" } } });
    expect((await send(ev.id)).status).toBe("done");
    expect(String(bodyOf("POST /crm/v2/Calls")!.Description).split("\n")).toEqual([
      "Outcome: booked",
      "Attempt: 2",
      "About: hair fall treatment",
      "Interest: hot",
      "Next step: booked",
      "Agreed time: 25 Sep 2026, 11:00 AM (booked)",
      "Summary: Booked a consultation.",
      "Answers: skin type: oily",
      "Length: 75 seconds",
      "Made by JENAI (AI call)",
    ]);
  });

  it("logs the call once when only the field update failed, and retries just that", async () => {
    let put = 0;
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-5") : req === "PUT /crm/v2/Leads/ZOHO-LEAD-13" ? (++put === 1 ? { status: 503 } : updated("ZOHO-LEAD-13")) : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-13" });
    expect((await send(ev.id)).status).toBe("queued");
    expect((await eventRow(ev.id)).progress).toEqual({ Calls: "CALL-5" }); // kept for the next try

    const r = await send(ev.id);
    expect(r.status).toBe("done");
    expect(r.message).toMatch(/CALL-5 already logged/);
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-13", "PUT /crm/v2/Leads/ZOHO-LEAD-13"]);
  });

  it("keeps the record it found when a try fails, so the retry does not search again", async () => {
    let calls = 0;
    zoho = (req) =>
      req === "GET /crm/v2/Leads/search"
        ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-14" }] } }
        : req === "POST /crm/v2/Calls"
          ? ++calls === 1 ? { status: 500 } : added("CALL-6")
          : req.startsWith("PUT ") ? updated("ZOHO-LEAD-14") : { status: 500 };
    const ev = await readyToSend();
    expect((await send(ev.id)).status).toBe("queued");
    expect((await eventRow(ev.id)).externalId).toBe("ZOHO-LEAD-14");
    expect((await send(ev.id)).status).toBe("done");
    expect(asked.filter((a) => a === "GET /crm/v2/Leads/search")).toHaveLength(1);
  });

  it("finds a caller kept in Contacts, logs the call on that Contact, and goes straight there next time", async () => {
    const person = { contact_id: randomUUID(), name: "Meena", phone: "+919800000781" };
    let calls = 0;
    zoho = (req, _token, query) => {
      // Not in Leads in any form; in Contacts, saved as the bare ten digits.
      if (req === "GET /crm/v2/Contacts/search" && query === "phone=9800000781") return { status: 200, body: { data: [{ id: "ZOHO-CONTACT-21" }] } };
      if (req.endsWith("/search")) return { status: 204 };
      if (req === "POST /crm/v2/Calls") return ++calls === 1 ? { status: 500 } : added(`CALL-21-${calls}`);
      if (req === "PUT /crm/v2/Contacts/ZOHO-CONTACT-21") return updated("ZOHO-CONTACT-21");
      return { status: 500 };
    };
    const ev = await readyToSend({ payload: { ...aCall(), person } });
    expect((await send(ev.id)).status).toBe("queued"); // Zoho failed on the Call itself
    expect(searched).toEqual([
      "Leads phone=+919800000781",
      "Leads phone=9800000781",
      "Leads criteria=((Mobile:equals:+919800000781)or(Phone:equals:+919800000781))",
      "Leads criteria=((Mobile:equals:9800000781)or(Phone:equals:9800000781))",
      "Contacts phone=+919800000781",
      "Contacts phone=9800000781",
    ]);
    expect(await eventRow(ev.id)).toMatchObject({ externalId: "ZOHO-CONTACT-21", externalType: "Contacts" });

    // The retry writes on the Contact it found, without searching again.
    expect((await send(ev.id)).status).toBe("done");
    expect(searched).toHaveLength(6);
    const call = bodyOf("POST /crm/v2/Calls")!;
    expect(call).toMatchObject({ Who_Id: "ZOHO-CONTACT-21" });
    expect(call).not.toHaveProperty("What_Id");
    expect(asked).toContain("PUT /crm/v2/Contacts/ZOHO-CONTACT-21");
    const [link] = await withTenant(tenant, (tx) => tx.select().from(externalLinks).where(and(eq(externalLinks.integrationId, zohoId), eq(externalLinks.ourId, person.contact_id))));
    expect(link).toMatchObject({ externalType: "Contacts", externalId: "ZOHO-CONTACT-21" });

    // Their next call is queued with the Contact, and logged there with no search.
    const refId = randomUUID();
    await withTenant(tenant, (tx) => enqueueEvent(tx, tenant, { kind: "call.completed", refType: "call", refId, payload: { ...aCall(), person } }));
    const [next] = await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, zohoId), eq(integrationEvents.refId, refId))));
    expect(next).toMatchObject({ externalId: "ZOHO-CONTACT-21", externalType: "Contacts" });
    asked.length = 0;
    searched.length = 0;
    sent.length = 0;
    expect((await send(next!.id)).status).toBe("done");
    expect(searched).toEqual([]);
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ Who_Id: "ZOHO-CONTACT-21" });
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Contacts/ZOHO-CONTACT-21"]);
  });

  it("finds a number only an exact match on Mobile or Phone finds, with the + kept", async () => {
    const exact = "criteria=((Mobile:equals:+919800000777)or(Phone:equals:+919800000777))";
    zoho = (req, _token, query) =>
      req === "GET /crm/v2/Leads/search"
        ? query === exact ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-22" }] } } : { status: 204 }
        : req === "POST /crm/v2/Calls" ? added("CALL-22") : req.startsWith("PUT ") ? updated("ZOHO-LEAD-22") : { status: 500 };
    const ev = await readyToSend();
    expect((await send(ev.id)).status).toBe("done");
    expect(searched).toEqual(["Leads phone=+919800000777", "Leads phone=9800000777", `Leads ${exact}`]);
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ What_Id: "ZOHO-LEAD-22", $se_module: "Leads" });
    expect(await eventRow(ev.id)).toMatchObject({ externalId: "ZOHO-LEAD-22", externalType: "Leads" });
  });

  it("searches only the modules their admin let it read", async () => {
    zoho = (req) => (req.endsWith("/search") ? { status: 204 } : { status: 500 });
    let ev = await readyToSend({ scopes: SCOPES.filter((s) => !s.includes(".contacts.")) });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(searched).toHaveLength(4);
    expect(searched.every((q) => q.startsWith("Leads "))).toBe(true); // a Contacts search would be a 401
    expect(await errorOf(ev.id)).toMatch(/looked in Leads\)/);
    expect(await integrationStatus(zohoId)).toBe("connected");

    // Nothing it may read: nobody can be found, which is the connection's problem, not this caller's.
    ev = await readyToSend({ scopes: ["ZohoCRM.modules.calls.CREATE", "ZohoCRM.modules.notes.CREATE"] });
    const r = await send(ev.id);
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/not granted ZohoCRM\.modules\.leads\.READ or ZohoCRM\.modules\.contacts\.READ/);
    expect(asked).toEqual([]);
    expect(await integrationStatus(zohoId)).toBe("error");
  });

  it("writes a remembered record in the module remembered with it", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-23") : req.startsWith("PUT ") ? updated("REC") : { status: 500 });
    let ev = await readyToSend({ externalId: "ZOHO-CONTACT-23", externalType: "Contacts" });
    expect((await send(ev.id)).status).toBe("done");
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ Who_Id: "ZOHO-CONTACT-23" });
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Contacts/ZOHO-CONTACT-23"]);

    // An id their own system handed us does not say: it is in the connection's module, as before.
    ev = await readyToSend({ externalId: "ZOHO-LEAD-23", externalType: "record" });
    expect((await send(ev.id)).status).toBe("done");
    expect(bodyOf("POST /crm/v2/Calls")).toMatchObject({ What_Id: "ZOHO-LEAD-23", $se_module: "Leads" });
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-23"]);
  });

  it("does not create a Lead for a new caller when their admin did not grant it", async () => {
    zoho = (req) => (req.endsWith("/search") ? { status: 204 } : { status: 500 });
    const ev = await readyToSend({ config: { createIfMissing: true } });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/not granted permission to create one in Leads/);
    expect(asked.every((a) => a.endsWith("/search"))).toBe(true); // never a POST Zoho would refuse
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("logs the call but leaves the fields alone without the update scope, and stays connected", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-7") : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-15", scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.calls.CREATE"] });
    const r = await send(ev.id);
    expect(r.status).toBe("done");
    expect(r.message).toMatch(/fields left alone, Zoho was not granted ZohoCRM\.modules\.leads\.UPDATE/);
    // A PUT here is a 401, which would have switched the whole connection off.
    expect(asked).toEqual(["POST /crm/v2/Calls"]);
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("takes a grant on every module, or every operation on one, as covering the write", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-8") : req.startsWith("PUT ") ? updated("REC") : { status: 500 });
    let ev = await readyToSend({ externalId: "ZOHO-LEAD-16", scopes: ["ZohoCRM.modules.ALL"] });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-16"]);

    ev = await readyToSend({ externalId: "ZOHO-LEAD-16", scopes: ["ZohoCRM.modules.leads.ALL", "ZohoCRM.modules.calls.ALL"] });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-16"]);
  });

  it("reads Zoho's grants on every module, on activities, and for any write as covering the operation", async () => {
    zoho = (req) =>
      req === "GET /crm/v2/Leads/search" ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-41" }] } } : req === "POST /crm/v2/Calls" ? added("CALL-41") : req.startsWith("PUT ") ? updated("ZOHO-LEAD-41") : { status: 500 };
    // Least privilege without delete, as Zoho's group scopes give it.
    let ev = await readyToSend({ scopes: ["ZohoCRM.modules.READ", "ZohoCRM.modules.CREATE", "ZohoCRM.modules.UPDATE", "ZohoSearch.securesearch.READ"] });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["GET /crm/v2/Leads/search", "POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-41"]);

    // Calls are one of Zoho's activities.
    ev = await readyToSend({ externalId: "ZOHO-LEAD-41", scopes: ["ZohoCRM.modules.leads.ALL", "ZohoCRM.modules.activities.ALL"] });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-41"]);

    // WRITE is accepted by Zoho for both creating and updating.
    ev = await readyToSend({ externalId: "ZOHO-LEAD-41", scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.leads.WRITE", "ZohoCRM.modules.calls.WRITE"] });
    expect((await send(ev.id)).status).toBe("done");
    expect(asked).toEqual(["POST /crm/v2/Calls", "PUT /crm/v2/Leads/ZOHO-LEAD-41"]);
  });

  const mismatch = { status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", details: {}, message: "invalid oauth scope to access this URL", status: "error" } };
  const deniedOn = async () => ((await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, zohoId))))[0]!.config.denied as string[] | undefined) ?? [];

  it("with no scopes on record, leaves out a module Zoho will not let it search, and stays connected", async () => {
    zoho = (req) => (req === "GET /crm/v2/Contacts/search" ? mismatch : req.endsWith("/search") ? { status: 204 } : { status: 500 });
    let ev = await readyToSend({ scopes: [] });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/No matching record in Zoho for this number \(looked in Leads; Zoho would not let us search Contacts \(OAUTH_SCOPE_MISMATCH\)\)/);
    expect(searched.filter((q) => q.startsWith("Contacts "))).toHaveLength(1); // given up on at the first refusal
    expect(await integrationStatus(zohoId)).toBe("connected");
    expect(await deniedOn()).toEqual(["ZohoCRM.modules.contacts.READ"]);

    // Remembered: the next caller is not searched for there at all.
    await withTenant(tenant, (tx) => tx.update(integrations).set({ config: { dc: "in", module: "Leads", scopes: [], denied: ["ZohoCRM.modules.contacts.READ"] } }).where(eq(integrations.id, zohoId)));
    searched.length = 0;
    ev = (await withTenant(tenant, (tx) =>
      tx.insert(integrationEvents).values({ tenantId: tenant, integrationId: zohoId, direction: "out", kind: "call.completed", refType: "call", refId: randomUUID(), idempotencyKey: `zoho-${randomUUID()}`, status: "sending", attempts: 1, payload: aCall() }).returning(),
    ))[0]!;
    expect((await send(ev.id)).status).toBe("skipped");
    expect(searched.every((q) => q.startsWith("Leads "))).toBe(true);
  });

  it("with no scopes on record, writes a Note when Zoho will not take a Call, and remembers it", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? mismatch : req === "POST /crm/v2/Notes" ? added("NOTE-42") : req.startsWith("PUT ") ? updated("ZOHO-LEAD-42") : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-42", scopes: [] });
    const r = await send(ev.id);
    expect(r.status).toBe("done");
    expect(r.message).toMatch(/note added on Leads ZOHO-LEAD-42; not logged as a Call, Zoho answered OAUTH_SCOPE_MISMATCH/);
    expect(asked).toEqual(["POST /crm/v2/Calls", "POST /crm/v2/Notes", "PUT /crm/v2/Leads/ZOHO-LEAD-42"]);
    expect(String(bodyOf("POST /crm/v2/Notes")!.Note_Content)).toContain("Outcome: booked");
    expect(await integrationStatus(zohoId)).toBe("connected");
    expect(await deniedOn()).toEqual(["ZohoCRM.modules.calls.CREATE"]);
  });

  it("writes a Note when their Calls refuse every call, without remembering a right their admin can give", async () => {
    for (const refusal of [
      { status: 403, body: { code: "NO_PERMISSION", details: {}, message: "permission denied", status: "error" } },
      { status: 400, body: { data: [{ code: "MANDATORY_NOT_FOUND", details: { api_name: "Branch" }, message: "required field not found", status: "error" }] } },
    ]) {
      zoho = (req) => (req === "POST /crm/v2/Calls" ? refusal : req === "POST /crm/v2/Notes" ? added("NOTE-43") : req.startsWith("PUT ") ? updated("ZOHO-LEAD-43") : { status: 500 });
      const ev = await readyToSend({ externalId: "ZOHO-LEAD-43" });
      expect((await send(ev.id)).status).toBe("done");
      expect((await eventRow(ev.id)).progress).toEqual({ Notes: "NOTE-43" });
      expect(await integrationStatus(zohoId)).toBe("connected");
      expect(await deniedOn()).toEqual([]);
    }
  });

  it("with no scopes on record, logs the call and leaves the fields alone when Zoho will not take the update", async () => {
    zoho = (req) => (req === "POST /crm/v2/Calls" ? added("CALL-44") : req.startsWith("PUT ") ? mismatch : { status: 500 });
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-44", scopes: [] });
    const r = await send(ev.id);
    expect(r.status).toBe("done");
    expect(r.message).toMatch(/call logged on Leads ZOHO-LEAD-44; mapped fields left alone, Zoho answered OAUTH_SCOPE_MISMATCH/);
    expect(await integrationStatus(zohoId)).toBe("connected");
    expect(await deniedOn()).toEqual(["ZohoCRM.modules.leads.UPDATE"]);
  });

  it("skips, with the reason, an event it was not allowed to write anything for, rather than calling it done", async () => {
    // Calls granted, Notes not: an opt-out has nowhere to go.
    zoho = () => ({ status: 500 });
    let ev = await readyToSend({
      externalId: "ZOHO-LEAD-45",
      kind: "do_not_call.added",
      payload: { event: "do_not_call.added", person: { phone: "+919800000777" }, source: "said so on a call" },
      scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.calls.CREATE"],
    });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/Nothing written on Leads ZOHO-LEAD-45 for do_not_call\.added: no note, Zoho was not granted ZohoCRM\.modules\.notes\.CREATE/);
    expect(asked).toEqual([]);
    // Said on the connection, where the client looks, without switching it off.
    let [row] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, zohoId)));
    expect(row).toMatchObject({ status: "connected" });
    expect(row!.lastError).toMatch(/no note, Zoho was not granted/);

    // A profile that may not add notes: the same, with Zoho's word for it.
    zoho = (req) => (req === "POST /crm/v2/Notes" ? { status: 403, body: { code: "NO_PERMISSION", details: {}, message: "permission denied", status: "error" } } : { status: 500 });
    ev = await readyToSend({ externalId: "ZOHO-LEAD-45", kind: "appointment.booked", payload: { event: "appointment.booked", appointment: { at: "25 Sep 2026" }, person: { phone: "+919800000777" } } });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/no note, Zoho answered NO_PERMISSION/);
    expect(await eventRow(ev.id)).toMatchObject({ httpStatus: 403 });
    [row] = await withTenant(tenant, (tx) => tx.select().from(integrations).where(eq(integrations.id, zohoId)));
    expect(row!.status).toBe("connected");
  });

  it("counts a write as landed only when Zoho says it succeeded, whatever the HTTP status", async () => {
    // Zoho reports one record's failure inside data[0], and a 2xx can carry it.
    zoho = (req) =>
      req === "POST /crm/v2/Calls"
        ? added("CALL-46")
        : req.startsWith("PUT ")
          ? { status: 202, body: { data: [{ code: "INVALID_DATA", details: { api_name: "Lead_Status" }, message: "invalid data", status: "error" }] } }
          : { status: 500 };
    const ev = await readyToSend({ externalId: "ZOHO-LEAD-46" });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/Lead_Status/);
    // The Call did land, under its real id, so sending again only redoes the update.
    expect((await eventRow(ev.id)).progress).toEqual({ Calls: "CALL-46" });

    // A Call Zoho did not confirm is not counted as written.
    zoho = (req) => (req === "POST /crm/v2/Calls" ? { status: 200, body: { data: [{ code: "MANDATORY_NOT_FOUND", details: { api_name: "Branch" }, message: "required field not found", status: "error" }] } } : req === "POST /crm/v2/Notes" ? added("NOTE-46") : req.startsWith("PUT ") ? updated("ZOHO-LEAD-46") : { status: 500 });
    const again = await readyToSend({ externalId: "ZOHO-LEAD-46" });
    expect((await send(again.id)).status).toBe("done");
    expect((await eventRow(again.id)).progress).toEqual({ Notes: "NOTE-46" });
  });

  it("creates one record for a new caller even when two of their events go at once", async () => {
    const person = { contact_id: randomUUID(), name: "Revathi", phone: "+919800000792" };
    let created = 0;
    zoho = (req) => {
      if (req.endsWith("/search")) return { status: 204 }; // Zoho's search does not see a record made a moment ago
      if (req === "POST /crm/v2/Leads") return added(`ZOHO-LEAD-NEW-${++created}`);
      if (req === "POST /crm/v2/Calls") return added("CALL-47");
      if (req === "POST /crm/v2/Notes") return added("NOTE-47");
      if (req.startsWith("PUT ")) return updated("REC");
      return { status: 500 };
    };
    const scopes = [...SCOPES, "ZohoCRM.modules.leads.CREATE"];
    const one = await readyToSend({ payload: { ...aCall(), person }, scopes, config: { createIfMissing: true } });
    const two = (await withTenant(tenant, (tx) =>
      tx
        .insert(integrationEvents)
        .values({ tenantId: tenant, integrationId: zohoId, direction: "out", kind: "appointment.booked", refType: "call", refId: randomUUID(), idempotencyKey: `zoho-${randomUUID()}`, status: "sending", attempts: 1, payload: { event: "appointment.booked", appointment: { at: "25 Sep 2026, 11:00 AM" }, person } })
        .returning(),
    ))[0]!;
    // Zoho takes its time, as it does, so the two deliveries are in flight together.
    const slowly = (async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 25));
      return fakeFetch(input, init);
    }) as typeof fetch;
    const results = await Promise.all([deliver({ tenantId: tenant, id: one.id }, slowly), deliver({ tenantId: tenant, id: two.id }, slowly)]);
    expect(results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(asked.filter((a) => a === "POST /crm/v2/Leads")).toHaveLength(1);
    expect((await eventRow(one.id)).externalId).toBe("ZOHO-LEAD-NEW-1");
    expect((await eventRow(two.id)).externalId).toBe("ZOHO-LEAD-NEW-1");
    expect(await linkOf(person.contact_id)).toMatchObject({ externalId: "ZOHO-LEAD-NEW-1", externalType: "Leads" });
  });

  it("takes lead changes only once a field is mapped, so nothing is queued just to be skipped", async () => {
    const i = (mapping: Record<string, Record<string, string>>) => ({ mapping }) as unknown as Integration;
    expect(zohoConnector.wants!(i({}), "lead.updated")).toBe(false);
    expect(zohoConnector.wants!(i({ fields: { Lead_Status: "lead.stage" } }), "lead.updated")).toBe(true);
    expect(zohoConnector.wants!(i({}), "do_not_call.added")).toBe(true);
  });

  it("says on Test what it will write and what it was not granted", async () => {
    zoho = (req) => (req === "GET /crm/v2/Leads" ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-1" }] } } : req.endsWith("/search") ? { status: 204 } : { status: 500 });
    const tested = (config: Record<string, unknown>) =>
      zohoConnector.test({
        integration: { tenantId: tenant, id: zohoId, kind: "zoho_crm", name: "Zoho", config: { dc: "in", module: "Leads", ...config }, mapping: { fields: { Lead_Status: "call.outcome" } } } as unknown as Integration,
        credentials: { access_token: "cached", access_token_until: String(Date.now() + 3_600_000) },
        fetch: fakeFetch,
        async save() {},
      });

    // Zennara's grant, asked to add callers who are not in Zoho.
    searched.length = 0;
    let r = await tested({ scopes: SCOPES, createIfMissing: true });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      "Connected to Zoho CRM (in). Finding callers in Leads, then Contacts. Writing each call as a Call record, a note for each booking and opt-out, the mapped fields on Leads and Contacts records. Not granted, so not written: a new Leads record for a caller not in Zoho. Health answers (duration, tried before, background, advice given, urgent, problem reported, complication reported) stay in JENAI, and so does any answer a health program does not mark shareable. On a health call, the summary, what it was about, the recording link and an outcome its program does not mark shareable stay in JENAI.",
    );
    // A search was really asked for, in each module, with a number nobody has.
    expect(searched).toEqual(["Leads phone=0000000000", "Contacts phone=0000000000"]);

    r = await tested({ scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.notes.CREATE"] });
    expect(r.message).toMatch(/Finding callers in Leads\. Writing a note for each call, booking and opt-out\. Not granted, so not written: the mapped fields on Leads records\. Health answers/);

    // A client who chose what to share hears exactly that.
    r = await tested({ scopes: SCOPES, share: ["skin_type", "tried_before", "summary"] });
    expect(r.message).toMatch(/Answers from calls handed on: skin type, tried before\. On a health call, what it was about, the recording link and an outcome its program does not mark shareable stay in JENAI\.$/);

    // An older connection, or one Zoho did not list scopes for: not claimed either way.
    r = await tested({});
    expect(r.message).toMatch(/Zoho did not say which scopes it granted/);
    expect(r.message).not.toMatch(/Call record/);
  });

  it("fails the Test when Zoho will not let it search, rather than the first delivery", async () => {
    const mismatch = { code: "OAUTH_SCOPE_MISMATCH", details: {}, message: "invalid oauth scope to access this URL", status: "error" };
    zoho = (req) => (req === "GET /crm/v2/Leads" ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-1" }] } } : req.endsWith("/search") ? { status: 401, body: mismatch } : { status: 500 });
    const r = await zohoConnector.test({
      integration: { tenantId: tenant, id: zohoId, kind: "zoho_crm", name: "Zoho", config: { dc: "in", module: "Leads", scopes: ["ZohoCRM.modules.ALL"] }, mapping: {} } as unknown as Integration,
      credentials: { access_token: "cached", access_token_until: String(Date.now() + 3_600_000) },
      fetch: fakeFetch,
      async save() {},
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no caller can be found\. Zoho would not let JENAI search Leads \(OAUTH_SCOPE_MISMATCH\) or Contacts \(OAUTH_SCOPE_MISMATCH\): the grant needs ZohoSearch\.securesearch\.READ/);
  });
});

describe("connecting Zoho, and connecting it again", () => {
  let org = "";
  beforeAll(async () => {
    const [o] = await platformDb()
      .insert(organizations)
      .values({ kind: "client", name: "Zoho Reconnect Clinic", slug: `zoho-re-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] })
      .returning();
    org = o!.id;
  });
  afterAll(async () => {
    await platformDb().delete(organizations).where(eq(organizations.id, org));
  });

  /** Zoho's token endpoint, answering the grant code exchange with the given body. */
  const accounts = (body: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  const exchange = (body: Record<string, unknown>) =>
    exchangeGrantCode({ dc: "in", clientId: "cid", clientSecret: "secret", code: "1000.code", fetchImpl: accounts({ access_token: "a", refresh_token: "r", expires_in: 3600, ...body }) });

  it("records the scopes Zoho lists, in the form the connector checks", async () => {
    const t = await exchange({ scope: "ZohoCRM.modules.Leads.READ ZohoCRM.modules.leads.UPDATE,zohocrm.modules.calls.create  ZohoCRM.settings.fields.READ" });
    expect(t.scopes).toEqual(["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.leads.UPDATE", "ZohoCRM.modules.calls.CREATE", "ZohoCRM.settings.fields.READ"]);
    // Zoho's own samples for this call often leave the list out: unknown, not "nothing granted".
    expect((await exchange({})).scopes).toBeNull();
  });

  it("keeps the connection's settings when it is connected again, and takes the new grant's scopes", async () => {
    const first = await withTenant(org, (tx) =>
      saveZohoConnection(tx, org, { dc: "in", module: "Contacts", scopes: ["ZohoCRM.modules.contacts.READ"], credentials: { client_id: "cid", client_secret: "secret", refresh_token: "old" } }),
    );
    expect(first.reconnected).toBe(false);
    expect(first.integration.config).toEqual({ dc: "in", module: "Contacts", scopes: ["ZohoCRM.modules.contacts.READ"] });

    // What the client set up on it afterwards.
    await withTenant(org, (tx) =>
      tx
        .update(integrations)
        .set({ status: "error", config: { ...first.integration.config, createIfMissing: true, pull: { every: "15m" } }, mapping: { fields: { Lead_Status: "call.outcome" } }, events: ["call.completed"], name: "Front desk Zoho" })
        .where(eq(integrations.id, first.integration.id)),
    );

    // Their admin re-grants with one more scope, and the code is redeemed again.
    const scopes = ["ZohoCRM.modules.contacts.READ", "ZohoCRM.modules.contacts.UPDATE"];
    const again = await withTenant(org, (tx) => saveZohoConnection(tx, org, { dc: "in", scopes, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "new" } }));
    expect(again.reconnected).toBe(true);
    expect(again.integration.id).toBe(first.integration.id);
    expect(again.integration.config).toEqual({ dc: "in", module: "Contacts", scopes, createIfMissing: true, pull: { every: "15m" } });
    expect(again.integration.mapping).toEqual({ fields: { Lead_Status: "call.outcome" } });
    expect(again.integration.events).toEqual(["call.completed"]);
    expect(again.integration.name).toBe("Front desk Zoho");
    expect(again.integration.status).toBe("draft"); // until a test says Zoho answers
    expect(credentialsOf(again.integration).refresh_token).toBe("new");

    // A grant Zoho did not list scopes for drops the old list rather than trusting it:
    // kept, it would hide a scope the new grant adds. What Zoho refused under the old grant goes too.
    await withTenant(org, (tx) => tx.update(integrations).set({ config: { ...again.integration.config, denied: ["ZohoCRM.modules.contacts.UPDATE"] } }).where(eq(integrations.id, first.integration.id)));
    const unlisted = await withTenant(org, (tx) => saveZohoConnection(tx, org, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "newer" } }));
    expect(unlisted.integration.config).not.toHaveProperty("scopes");
    expect(unlisted.integration.config).not.toHaveProperty("denied");
    expect(unlisted.integration.config).toMatchObject({ createIfMissing: true, pull: { every: "15m" } });
    expect(await withTenant(org, (tx) => tx.select({ id: integrations.id }).from(integrations).where(eq(integrations.kind, "zoho_crm")))).toHaveLength(1);
  });

  it("keeps the module, events and name when reconnected from the form, whose blank defaults are not choices", async () => {
    const [i] = await withTenant(org, (tx) => tx.select().from(integrations).where(eq(integrations.kind, "zoho_crm")));
    await withTenant(org, (tx) => tx.update(integrations).set({ events: ["call.completed", "do_not_call.added", "lead.updated"], config: { ...i!.config, module: "Contacts" } }).where(eq(integrations.id, i!.id)));
    const again = await withTenant(org, (tx) =>
      saveZohoConnection(tx, org, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "form" }, setup: { name: "Our CRM", module: "Leads", events: ["call.completed", "appointment.booked"] } }),
    );
    expect(again.integration.config.module).toBe("Contacts");
    expect(again.integration.events).toEqual(["call.completed", "do_not_call.added", "lead.updated"]);
    expect(again.integration.name).toBe("Front desk Zoho");
  });

  it("lets go of the records people were linked to when reconnected to another data centre", async () => {
    const [i] = await withTenant(org, (tx) => tx.select().from(integrations).where(eq(integrations.kind, "zoho_crm")));
    const linkFor = (dc: string) => withTenant(org, (tx) => tx.insert(externalLinks).values({ tenantId: org, integrationId: i!.id, ourType: "contact", ourId: randomUUID(), externalType: "Leads", externalId: `ZOHO-${dc}-${randomUUID().slice(0, 6)}` }));
    const links = () => withTenant(org, (tx) => tx.select().from(externalLinks).where(eq(externalLinks.integrationId, i!.id)));
    await linkFor("in");
    await withTenant(org, (tx) => saveZohoConnection(tx, org, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "same-dc" } }));
    expect(await links()).toHaveLength(1);
    await withTenant(org, (tx) => saveZohoConnection(tx, org, { dc: "com", scopes: null, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "other-dc" } }));
    expect(await links()).toEqual([]);
  });

  it("starts a new connection from the form's choices, without lead changes until a field is mapped", async () => {
    const other = (await platformDb().insert(organizations).values({ kind: "client", name: "Zoho New Clinic", slug: `zoho-new-${randomUUID().slice(0, 8)}`, status: "active", vertical: "derma", languages: ["en"] }).returning())[0]!.id;
    try {
      const made = await withTenant(other, (tx) => saveZohoConnection(tx, other, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "s", refresh_token: "r" }, setup: { name: "Our CRM", module: "Contacts", events: ["call.completed"] } }));
      expect(made.integration).toMatchObject({ name: "Our CRM", events: ["call.completed"], status: "draft" });
      expect(made.integration.config.module).toBe("Contacts");
      const plain = await withTenant(other, async (tx) => {
        await tx.delete(integrations).where(eq(integrations.id, made.integration.id));
        return saveZohoConnection(tx, other, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "s", refresh_token: "r" } });
      });
      expect(plain.integration.events).not.toContain("lead.created"); // nothing makes one
    } finally {
      await platformDb().delete(organizations).where(eq(organizations.id, other));
    }
  });
});

describe("what a call hands on, and to whom", () => {
  // One system as it comes, and two whose client chose what they may have.
  let plain = "";
  let sharing = "";
  let telling = "";
  beforeAll(async () => {
    const add = async (name: string, config: Record<string, unknown>, events: string[]) =>
      (await withTenant(tenant, (tx) => tx.insert(integrations).values({ tenantId: tenant, kind: "webhook_out", name, status: "connected", config: { url: `${base}/${name}`, ...config }, events }).returning()))[0]!.id;
    plain = await add("plain", {}, ["call.completed", "lead.updated"]);
    sharing = await add("sharing", { share: ["duration", "skin_type"] }, ["call.completed"]);
    telling = await add("telling", { share: ["concern", "summary"] }, ["call.completed"]);
  });

  const handed = async (integrationId: string, kind: string, refId: string) =>
    withTenant(tenant, (tx) =>
      tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, integrationId), eq(integrationEvents.kind, kind), eq(integrationEvents.refId, refId))),
    );
  const payloadOf = async (integrationId: string, refId: string) => (await handed(integrationId, "call.completed", refId))[0]!.payload;

  it("keeps health detail out of what each system is handed, unless the client shares it", async () => {
    const { call } = await seedCall("booked");
    const said = { concern: "hair fall treatment", interest_level: "hot", duration: "6 months", tried_before: "onion oil", background: "after delivery", advice_given: "mild shampoo", urgent: false, problem_reported: "itching after the cream", skin_type: "oily" };
    await withTenant(tenant, (tx) => tx.update(calls).set({ extracted: { ...call.extracted, ...said }, summary: "Hair fall for 6 months after delivery, tried onion oil, advised a mild shampoo" }).where(eq(calls.id, call.id)));
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));

    // A skin clinic's call on no program: its answers are the health history,
    // and the summary and what it was about retell it.
    const handedPlain = await payloadOf(plain, call.id);
    expect(handedPlain.fields).toEqual({});
    expect(handedPlain.call).toMatchObject({ summary: null, concern: null, recording_url: null, interest_level: "hot", next_step: "booked", outcome: "booked", attempt: null });
    // A share list hands on what it names, and only that.
    expect((await payloadOf(sharing, call.id)).fields).toEqual({ duration: "6 months", skin_type: "oily" });
    expect((await payloadOf(sharing, call.id)).call).toMatchObject({ summary: null, concern: null });
    const handedTelling = await payloadOf(telling, call.id);
    expect(handedTelling.fields).toEqual({});
    expect(handedTelling.call).toMatchObject({ concern: "hair fall treatment", summary: "Hair fall for 6 months after delivery, tried onion oil, advised a mild shampoo" });
  });

  it("hands on a health program's answers and outcomes only when it marks them shareable", async () => {
    const program = {
      extraction: [{ name: "booked", shareable: true }, { name: "symptom_mentioned" }, { name: "how_they_are" }],
      outcomes: [{ key: "booked", stage: "booked", shareable: true }, { key: "stopped_treatment", stage: "callback" }],
    };
    const payload = (outcome: string) => ({
      call: { outcome, outcome_label: "Stopped the treatment", summary: "Stopped the cream, rash spreading", concern: "rash", recording_url: "https://x/r", recording_expires_at: "2026-10-10", next_step: "callback" },
      fields: { booked: "no", symptom_mentioned: "itchy rash spreading on arms", how_they_are: "worse", new_key_nobody_marked: "x" },
    });
    const fields = payload("x").fields;
    let handed = sharedWith({}, payload("stopped_treatment"), healthWithheld(fields, "stopped_treatment", program));
    // A new answer no one marked stays in too: an allow list, not a deny list.
    expect(handed.fields).toEqual({ booked: "no" });
    // The outcome reads as the stage it means, which the lead says anyway.
    expect(handed.call).toEqual({ outcome: "callback", outcome_label: null, summary: null, concern: null, recording_url: null, recording_expires_at: null, next_step: "callback" });
    handed = sharedWith({}, payload("booked"), healthWithheld(fields, "booked", program));
    expect(handed.call).toMatchObject({ outcome: "booked", outcome_label: "Stopped the treatment" });
    // Named in a share list, it goes.
    handed = sharedWith({ share: ["outcome", "symptom_mentioned", "recording"] }, payload("stopped_treatment"), healthWithheld(fields, "stopped_treatment", program));
    expect(handed.fields).toEqual({ symptom_mentioned: "itchy rash spreading on arms" });
    expect(handed.call).toMatchObject({ outcome: "stopped_treatment", recording_url: "https://x/r", summary: null });
    // A call that is not a health call holds nothing back beyond the health answers.
    expect(sharedWith({}, payload("stopped_treatment")).call).toMatchObject({ summary: "Stopped the cream, rash spreading", outcome: "stopped_treatment" });
  });

  it("says which try a dialled call was", async () => {
    const { call, contact, phone } = await seedCall("callback");
    const [campaign] = await withTenant(tenant, (tx) => tx.select().from(campaigns).limit(1));
    await withTenant(tenant, (tx) =>
      tx.insert(campaignTargets).values({ tenantId: tenant, campaignId: campaign!.id, contactId: contact.id, phoneE164: phone, state: "dialing", attemptNo: 2, externalRunId: call.externalRunId }),
    );
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
    expect((await payloadOf(plain, call.id)).call).toMatchObject({ attempt: 2 });
  });

  /** A call made by the appointment reminder program, to a person with a lead closed long ago and one still open. */
  async function reminderCall() {
    const [cp] = await withTenant(tenant, (tx) => tx.select().from(clientPrograms).where(eq(clientPrograms.programKey, "clinic.appointment_reminder")));
    const { call, contact } = await seedCall("none");
    const long = new Date(Date.now() - 90 * 86_400_000);
    return withTenant(tenant, async (tx) => {
      const [closed] = await tx.insert(leads).values({ tenantId: tenant, contactId: contact.id, stage: "lost", lostReason: "went elsewhere", createdAt: long, updatedAt: long }).returning();
      const [open] = await tx.insert(leads).values({ tenantId: tenant, contactId: contact.id, stage: "booked" }).returning();
      await tx.update(calls).set({ agentId: cp!.agentId, extracted: {}, transcript: "Agent: Your visit is tomorrow at 11. Caller: Yes, I will come." }).where(eq(calls.id, call.id));
      return { call, contact, closed: closed!, open: open! };
    });
  }
  const confirmed: Extractor = {
    model: "test",
    async extract() {
      return { caller_name: "Ravi", next_step: "none", summary: "Confirmed the visit.", confirmed: "yes", outcome: "confirmed" };
    },
  };
  const stageOf = async (id: string) => (await withTenant(tenant, (tx) => tx.select().from(leads).where(eq(leads.id, id))))[0]!.stage;

  it("sets the stage a program's outcome means on the open lead, before the call is handed on, and says so once", async () => {
    const { call, contact, closed, open } = await reminderCall();
    expect(await analyzeCalls(tenant, confirmed)).toMatchObject({ analyzed: 1, failed: 0 });

    expect(await stageOf(open.id)).toBe("won"); // "confirmed" means won in this program
    expect(await stageOf(closed.id)).toBe("lost"); // closed before, stays closed
    // The call carries the stage it left, on the lead it moved, though that lead is now closed.
    expect((await payloadOf(plain, call.id)).lead).toMatchObject({ id: open.id, stage: "won" });
    const updates = await handed(plain, "lead.updated", open.id);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toMatchObject({ lead: { id: open.id, stage: "won" }, changed: ["stage"], source_call: call.id, person: { contact_id: contact.id } });
    expect(await handed(plain, "lead.updated", closed.id)).toEqual([]);
  });

  it("keeps the lead's new stage even when handing it on fails", async () => {
    const { call, open } = await reminderCall();
    const real = await vi.importActual<typeof import("./queue")>("./queue");
    vi.mocked(enqueueEvent).mockImplementation(async (tx, tenantId, input) => {
      if (input.kind === "lead.updated") await tx.execute(sql`select 'not-a-uuid'::uuid`);
      return real.enqueueEvent(tx, tenantId, input);
    });
    try {
      expect(await analyzeCalls(tenant, confirmed)).toMatchObject({ analyzed: 1, failed: 0 });
    } finally {
      vi.mocked(enqueueEvent).mockImplementation(real.enqueueEvent);
    }
    expect(await stageOf(open.id)).toBe("won");
    expect(await payloadOf(plain, call.id)).toBeTruthy(); // the call itself still went
  });

  it("hands on each change the team makes to a lead, back and forth", async () => {
    const { contact } = await seedCall("none");
    const [lead] = await withTenant(tenant, (tx) => tx.insert(leads).values({ tenantId: tenant, contactId: contact.id, stage: "callback" }).returning());
    for (const stage of ["booked", "callback", "booked"] as const) {
      await withTenant(tenant, async (tx) => {
        await tx.update(leads).set({ stage, updatedAt: new Date() }).where(eq(leads.id, lead!.id));
        await emitLeadUpdated(tx, tenant, lead!.id, ["stage"]);
      });
    }
    const updates = await handed(plain, "lead.updated", lead!.id);
    expect(updates.map((u) => (u.payload.lead as { stage: string }).stage).sort()).toEqual(["booked", "booked", "callback"]);
  });

  it("sends a lead's stage as it is when delivered, so an older change retried late cannot undo a newer one", async () => {
    const { contact } = await seedCall("none");
    const [lead] = await withTenant(tenant, (tx) => tx.insert(leads).values({ tenantId: tenant, contactId: contact.id, stage: "booked" }).returning());
    await withTenant(tenant, (tx) => emitLeadUpdated(tx, tenant, lead!.id, ["stage"]));
    const [booked] = await handed(plain, "lead.updated", lead!.id);
    // The team moved it on before "booked" got through.
    await withTenant(tenant, (tx) => tx.update(leads).set({ stage: "won", updatedAt: new Date() }).where(eq(leads.id, lead!.id)));
    await withTenant(tenant, (tx) => tx.update(integrationEvents).set({ status: "sending" }).where(eq(integrationEvents.id, booked!.id)));
    expect((await deliver({ tenantId: tenant, id: booked!.id })).status).toBe("done");
    const hit = received.filter((x) => x.path === "/plain").at(-1)!;
    expect(JSON.parse(hit.body).lead).toMatchObject({ id: lead!.id, stage: "won" });
    expect((await eventRow(booked!.id)).payload.lead).toMatchObject({ stage: "won" }); // the log shows what was sent
  });
});
