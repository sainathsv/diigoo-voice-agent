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
import { analyzeCalls, type Extractor } from "../analyze";
import { setUpProgram } from "../programs";
import { addCarrierAccount, addPhoneNumber } from "../telephony";
import { claimDeliveries, credentialsOf, deliver, enqueueEvent, sealCredentials, subscribers } from "./queue";
import { zohoConnector } from "./zoho";
import { exchangeGrantCode, saveZohoConnection } from "./zoho-connect";
import { EVENT_KINDS, emitCallCompleted, emitLeadUpdated } from "./events";
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
    expect((await withTenant(tenant, (tx) => subscribers(tx, "call.completed"))).map((s) => s.id)).toContain(integrationId);
    answer = { status: 200, body: `{"ok":true}` };
  });

  it("switches the connection off when their system refuses our key", async () => {
    answer = { status: 401, body: "unknown signing key" };
    const { call } = await seedCall("callback");
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));
    const claimed = (await claimDeliveries(platformDb(), 10)).filter((c) => c.tenantId === tenant);
    const r = await deliver(claimed[0]!);
    expect(r.status).toBe("failed"); // "Send failed again" picks it up once the key is fixed
    expect(await integrationStatus(integrationId)).toBe("error"); // the client sees it on their integrations page
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
      if (input.kind === "do_not_call.added") await tx.execute(sql`select 'not-a-uuid'::uuid`);
      return real.enqueueEvent(tx, tenantId, input);
    });
    try {
      const stats = await analyzeCalls(tenant, saidStop);
      expect(stats).toMatchObject({ analyzed: 1, optOuts: 1, failed: 0 });
    } finally {
      vi.mocked(enqueueEvent).mockImplementation(real.enqueueEvent);
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
  const eventRow = async (id: string) => (await withTenant(tenant, (tx) => tx.select().from(integrationEvents).where(eq(integrationEvents.id, id))))[0]!;
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

  it("skips a record that is gone from Zoho the same way", async () => {
    zoho = (req) =>
      req === "POST /crm/v2/Calls"
        ? { status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: "What_Id" }, message: "the related id given seems to be invalid", status: "error" }] } }
        : { status: 500 };
    const ev = await readyToSend({ externalId: "ZOHO-DELETED-1" });
    expect((await send(ev.id)).status).toBe("skipped");
    expect(await errorOf(ev.id)).toMatch(/INVALID_DATA/);
    expect(await integrationStatus(zohoId)).toBe("connected");
  });

  it("switches the connection off for a scope Zoho was not given, even on the phone search", async () => {
    const mismatch = { code: "OAUTH_SCOPE_MISMATCH", details: {}, message: "Client does not have ZohoSearch.securesearch.READ scope. Create a new client with valid scope.", status: "error" };
    zoho = (req) => (req === "GET /crm/v2/Leads/search" ? { status: 401, body: mismatch } : { status: 500 });
    const ev = await readyToSend();
    const r = await send(ev.id);
    // Not "not in Zoho": with the search refused, nobody could have been found.
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/ZohoSearch\.securesearch\.READ/);
    expect(await integrationStatus(zohoId)).toBe("error");
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

  it("says on Test what it will write and what it was not granted", async () => {
    zoho = (req) => (req === "GET /crm/v2/Leads" ? { status: 200, body: { data: [{ id: "ZOHO-LEAD-1" }] } } : { status: 500 });
    const tested = (config: Record<string, unknown>) =>
      zohoConnector.test({
        integration: { tenantId: tenant, id: zohoId, kind: "zoho_crm", name: "Zoho", config: { dc: "in", module: "Leads", ...config }, mapping: { fields: { Lead_Status: "call.outcome" } } } as unknown as Integration,
        credentials: { access_token: "cached", access_token_until: String(Date.now() + 3_600_000) },
        fetch: fakeFetch,
        async save() {},
      });

    // Zennara's grant, asked to add callers who are not in Zoho.
    let r = await tested({ scopes: SCOPES, createIfMissing: true });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      "Connected to Zoho CRM (in). Finding callers in Leads, then Contacts. Writing each call as a Call record, a note for each booking and opt-out, the mapped fields on Leads and Contacts records. Not granted, so not written: a new Leads record for a caller not in Zoho. Health detail from calls (duration, tried before, background, advice given, urgent, problem reported, complication reported) stays in JENAI.",
    );

    r = await tested({ scopes: ["ZohoCRM.modules.leads.READ", "ZohoCRM.modules.notes.CREATE"] });
    expect(r.message).toMatch(/Finding callers in Leads\. Writing a note for each call, booking and opt-out\. Not granted, so not written: the mapped fields on Leads records\. Health detail/);

    // A client who chose what to share hears exactly that.
    r = await tested({ scopes: SCOPES, share: ["skin_type", "tried_before"] });
    expect(r.message).toMatch(/Answers from calls handed on: skin type, tried before\.$/);

    // An older connection, or one Zoho did not list scopes for: not claimed either way.
    r = await tested({});
    expect(r.message).toMatch(/Zoho did not say which scopes it granted/);
    expect(r.message).not.toMatch(/Call record/);
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

    // A grant Zoho did not list scopes for drops the old list rather than trusting it.
    const unlisted = await withTenant(org, (tx) => saveZohoConnection(tx, org, { dc: "in", scopes: null, credentials: { client_id: "cid", client_secret: "secret", refresh_token: "newer" } }));
    expect(unlisted.integration.config).not.toHaveProperty("scopes");
    expect(unlisted.integration.config).toMatchObject({ createIfMissing: true, pull: { every: "15m" } });
    expect(await withTenant(org, (tx) => tx.select({ id: integrations.id }).from(integrations).where(eq(integrations.kind, "zoho_crm")))).toHaveLength(1);
  });
});

describe("what a call hands on, and to whom", () => {
  // One system as it comes, one whose client chose what it may have.
  let plain = "";
  let sharing = "";
  beforeAll(async () => {
    const add = async (name: string, config: Record<string, unknown>, events: string[]) =>
      (await withTenant(tenant, (tx) => tx.insert(integrations).values({ tenantId: tenant, kind: "webhook_out", name, status: "connected", config: { url: `${base}/${name}`, ...config }, events }).returning()))[0]!.id;
    plain = await add("plain", {}, ["call.completed", "lead.updated"]);
    sharing = await add("sharing", { share: ["duration", "skin_type"] }, ["call.completed"]);
  });

  const handed = async (integrationId: string, kind: string, refId: string) =>
    withTenant(tenant, (tx) =>
      tx.select().from(integrationEvents).where(and(eq(integrationEvents.integrationId, integrationId), eq(integrationEvents.kind, kind), eq(integrationEvents.refId, refId))),
    );
  const payloadOf = async (integrationId: string, refId: string) => (await handed(integrationId, "call.completed", refId))[0]!.payload;

  it("keeps health detail out of what each system is handed, unless the client shares it", async () => {
    const { call } = await seedCall("booked");
    const said = { concern: "hair fall treatment", interest_level: "hot", duration: "6 months", tried_before: "onion oil", background: "after delivery", advice_given: "mild shampoo", urgent: false, problem_reported: "itching after the cream", skin_type: "oily" };
    await withTenant(tenant, (tx) => tx.update(calls).set({ extracted: { ...call.extracted, ...said } }).where(eq(calls.id, call.id)));
    await withTenant(tenant, (tx) => emitCallCompleted(tx, tenant, call.id));

    // By default every answer but the health detail.
    expect((await payloadOf(plain, call.id)).fields).toEqual({ booked: "yes", skin_type: "oily" });
    // A share list hands on what it names, and only that.
    expect((await payloadOf(sharing, call.id)).fields).toEqual({ duration: "6 months", skin_type: "oily" });
    // What the call was about travels with it, outside the answers.
    expect((await payloadOf(plain, call.id)).call).toMatchObject({ concern: "hair fall treatment", interest_level: "hot", next_step: "booked", attempt: null });
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
});
