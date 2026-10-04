import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { externalLinks, integrationEvents, integrations, leads, openSecret, sealSecret, withTenant, type Db, type Integration, type Tx } from "@jenai/db";
import { webhookConnector, restConnector } from "./http";
import { zohoConnector } from "./zoho";
import { zenotiConnector } from "./zenoti";
import { sharedWith, type Connector, type ConnectorContext, type OutEvent, type Withheld } from "./types";

/**
 * Write-backs to the client's own system: queued in the database, delivered by
 * the worker, retried with a widening gap, and never sent twice (idempotency
 * key per event and integration). Any number of workers can share the queue.
 */

export const CONNECTORS: Record<string, Connector> = {
  webhook_out: webhookConnector,
  rest_generic: restConnector,
  zoho_crm: zohoConnector,
  zenoti: zenotiConnector,
};

const PURPOSE = "integration-credentials";
/** 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h, then give up. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];

export function credentialsOf(i: Integration): Record<string, string> {
  if (!i.credentials) return {};
  try {
    return JSON.parse(openSecret(i.tenantId, PURPOSE, i.credentials)) as Record<string, string>;
  } catch (e) {
    // Never quietly become "no credentials". A stored secret that will not open
    // means it was sealed wrongly, or for another tenant, or has been tampered
    // with, and the far end then reports something unrelated: Zoho answers
    // invalid_client when it is handed an empty client id, which reads like the
    // client's mistake rather than ours.
    throw new Error(`${i.name}: the stored credentials could not be opened (${(e as Error).message}). Reconnect this integration.`);
  }
}

export function sealCredentials(tenantId: string, creds: Record<string, string>): string {
  return sealSecret(tenantId, PURPOSE, JSON.stringify(creds));
}

/**
 * Who wants this event: every integration that pushes out, subscribes to it,
 * and would write something for it, whatever its health. One that is paused,
 * broken or not yet tested gets the event queued all the same, and deliver()
 * holds it until the connection works again: an opt-out said while their
 * admin was re-granting a scope must still reach their CRM afterwards.
 */
export async function subscribers(tx: Tx, kind: string): Promise<Integration[]> {
  const rows = await tx.select().from(integrations).where(inArray(integrations.direction, ["out", "both"]));
  return rows.filter((i) => (i.events.length === 0 || i.events.includes(kind)) && CONNECTORS[i.kind]?.wants?.(i, kind) !== false);
}

export interface EnqueueInput {
  kind: string;
  refType: string;
  refId: string;
  payload: Record<string, unknown>;
  /** Their record id, when we already know which one this is about. */
  externalId?: string | null;
  /** Same key twice = one delivery. Defaults to kind + our record id. */
  idempotencyKey?: string;
  /** What this event holds back from a connection that has not chosen to have it (health detail). */
  withheld?: Withheld;
}

/** Hands one event to every integration that wants it. Safe to call twice. */
export async function enqueueEvent(tx: Tx, tenantId: string, input: EnqueueInput): Promise<number> {
  const targets = await subscribers(tx, input.kind);
  let queued = 0;
  const ours = linkedRecord(input);
  for (const i of targets) {
    const [linked] =
      input.externalId || !ours
        ? []
        : await tx
            .select({ externalId: externalLinks.externalId, externalType: externalLinks.externalType })
            .from(externalLinks)
            .where(and(eq(externalLinks.integrationId, i.id), eq(externalLinks.ourType, ours.type), eq(externalLinks.ourId, ours.id)));
    const key = `${input.idempotencyKey ?? `${input.kind}:${input.refId}`}:${i.id}`;
    const r = await tx
      .insert(integrationEvents)
      .values({
        tenantId,
        integrationId: i.id,
        direction: "out",
        kind: input.kind,
        refType: input.refType,
        refId: input.refId,
        externalId: input.externalId ?? linked?.externalId ?? null,
        // An id their system handed us does not say which kind of record it is.
        externalType: input.externalId ? null : (linked?.externalType ?? null),
        idempotencyKey: key,
        // Stored as handed on, so the delivery log shows what they were given.
        payload: sharedWith(i.config, input.payload, input.withheld),
      })
      .onConflictDoNothing()
      .returning({ id: integrationEvents.id });
    if (r.length) queued++;
  }
  return queued;
}

/**
 * external_links.our_id is a uuid column, and Postgres rejects the statement,
 * and the caller's whole transaction with it, when handed anything else. A
 * phone number as the ref id did exactly that, so only a real uuid gets near it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadContactId(input: EnqueueInput): string | undefined {
  const person = input.payload.person as Record<string, unknown> | undefined;
  return typeof person?.contact_id === "string" && UUID.test(person.contact_id) ? person.contact_id : undefined;
}

/** Which of our records to look up in external_links: the person when we know them, else the event's own record. */
function linkedRecord(input: EnqueueInput): { type: string; id: string } | null {
  const contactId = payloadContactId(input);
  if (contactId) return { type: "contact", id: contactId };
  // Links are kept per contact, so a call with no contact has nothing to find.
  return input.refType !== "call" && UUID.test(input.refId) ? { type: input.refType, id: input.refId } : null;
}

/** Takes up to `limit` due deliveries for this worker. */
export async function claimDeliveries(db: Db, limit: number): Promise<Array<{ tenantId: string; id: string }>> {
  const rows = await db.execute<{ tenant_id: string; id: string }>(sql`
    update integration_events e set status = 'sending', attempts = attempts + 1, updated_at = now()
    from (select tenant_id, id from integration_events
          where status = 'queued' and direction = 'out' and next_attempt_at <= now()
          order by next_attempt_at limit ${limit} for update skip locked) q
    where e.tenant_id = q.tenant_id and e.id = q.id
    returning e.tenant_id, e.id`);
  return rows.map((r) => ({ tenant_id: r.tenant_id, id: r.id })).map((r) => ({ tenantId: r.tenant_id, id: r.id }));
}

export interface DeliveryResult {
  ok: boolean;
  status: string;
  message: string;
}

/**
 * When an event for a connection that does not work (paused, broken, not yet
 * tested) is next looked at: not until it works again, when releaseHeld puts
 * it back. Far ahead rather than in an hour, so a connection left broken for
 * weeks costs the worker nothing, however much waits for it.
 */
const heldUntil = () => new Date(Date.now() + 365 * 86_400_000);

/** Puts the events a connection's trouble held back into the queue, now that it works. */
export async function releaseHeld(tx: Tx, integrationId: string): Promise<number> {
  const rows = await tx
    .update(integrationEvents)
    .set({ nextAttemptAt: new Date(), updatedAt: new Date() })
    .where(and(eq(integrationEvents.integrationId, integrationId), eq(integrationEvents.status, "queued"), sql`${integrationEvents.nextAttemptAt} > now() + interval '30 days'`))
    .returning({ id: integrationEvents.id });
  return rows.length;
}

/**
 * How a connector persists what it learns (a refreshed token, a refused
 * scope) on its integration. Config is merged into what is stored at that
 * moment, so a setting saved meanwhile (by a sync, by the clinic) is kept.
 */
export function saver(tx: Tx, tenantId: string, i: Integration): ConnectorContext["save"] {
  return async (patch) => {
    await tx
      .update(integrations)
      .set({
        ...(patch.credentials ? { credentials: sealCredentials(tenantId, patch.credentials) } : {}),
        ...(patch.config ? { config: sql`${integrations.config} || ${JSON.stringify(patch.config)}::jsonb` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, i.id));
  };
}

/**
 * Asks their system whether this connection works, and records the answer on
 * it: connected, or error with the reason. A paused connection stays paused:
 * a test only says whether it would work, and pausing is the client's way to
 * stop JENAI reading or sending, which only they undo. Events held while it
 * was not working go with the worker's next round.
 *
 * Zenoti is tested with checkZenotiConnection instead, which asks Zenoti with
 * no transaction open (its waits can be long) and keeps its branch map.
 */
export async function testConnection(tx: Tx, tenantId: string, i: Integration, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const connector = CONNECTORS[i.kind];
  if (!connector) return { ok: false, message: "That kind of system is not ready yet." };
  const res = await connector.test({ integration: i, credentials: credentialsOf(i), fetch: fetchImpl, save: saver(tx, tenantId, i) });
  const paused = i.status === "paused";
  await tx
    .update(integrations)
    .set({
      status: paused ? "paused" : res.ok ? "connected" : "error",
      lastOkAt: res.ok ? new Date() : i.lastOkAt,
      lastError: res.ok ? null : res.message,
      lastErrorAt: res.ok ? i.lastErrorAt : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, i.id));
  if (res.ok && !paused) await releaseHeld(tx, i.id);
  return res;
}

/**
 * A lead's stage and follow-up date as they are now, not as they were when
 * the event was queued. A retry hours later, or an older change delivered
 * after a newer one, would otherwise write a stage that is no longer true
 * over one that is.
 */
async function withCurrentLead(tx: Tx, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lead = payload.lead as Record<string, unknown> | null | undefined;
  if (!lead || typeof lead.id !== "string" || !UUID.test(lead.id)) return payload;
  const [now] = await tx.select({ stage: leads.stage, followUp: leads.nextFollowUpAt }).from(leads).where(eq(leads.id, lead.id));
  if (!now) return payload;
  return { ...payload, lead: { ...lead, stage: now.stage, next_follow_up_at: now.followUp?.toISOString() ?? null } };
}

/**
 * After this many deliveries in a row refused by their system, with nothing
 * getting through, the connection is taken to be the problem: a field their
 * admin made mandatory, a profile without the right, a mapping their CRM
 * rejects. Each refusal alone reads like one record's.
 */
const REFUSED_IN_A_ROW = 20;

async function refusedEveryTime(tx: Tx, integrationId: string): Promise<boolean> {
  const last = await tx
    .select({ status: integrationEvents.status, httpStatus: integrationEvents.httpStatus })
    .from(integrationEvents)
    .where(and(eq(integrationEvents.integrationId, integrationId), eq(integrationEvents.direction, "out"), inArray(integrationEvents.status, ["done", "skipped", "failed"])))
    .orderBy(desc(integrationEvents.updatedAt))
    .limit(REFUSED_IN_A_ROW);
  return last.length === REFUSED_IN_A_ROW && last.every((x) => x.status === "skipped" && x.httpStatus !== null);
}

/** Delivers one claimed event and records what their system said. */
export async function deliver(ref: { tenantId: string; id: string }, fetchImpl: typeof fetch = fetch): Promise<DeliveryResult> {
  return withTenant(ref.tenantId, async (tx) => {
    const [e] = await tx.select().from(integrationEvents).where(eq(integrationEvents.id, ref.id));
    if (!e) return { ok: false, status: "failed", message: "gone" };
    const [i] = e.integrationId ? await tx.select().from(integrations).where(eq(integrations.id, e.integrationId)) : [];
    const connector = i ? CONNECTORS[i.kind] : undefined;
    if (!i || !connector) {
      await tx.update(integrationEvents).set({ status: "skipped", error: "The connection was removed", updatedAt: new Date() }).where(eq(integrationEvents.id, e.id));
      return { ok: false, status: "skipped", message: "connection removed" };
    }
    if (i.status !== "connected") {
      // The connection does not work (paused, broken, being reconnected): the
      // event waits for it, and this does not count as a try.
      await tx.update(integrationEvents).set({ status: "queued", attempts: Math.max(0, e.attempts - 1), nextAttemptAt: heldUntil(), updatedAt: new Date() }).where(eq(integrationEvents.id, e.id));
      return { ok: false, status: "queued", message: `held: the connection is ${i.status}` };
    }

    // One person's events go to one connection one at a time. Two at once
    // would each search, each find nothing, and each create the same person
    // in their CRM. In turn, the second finds the record the first linked.
    const contactId = payloadContactId({ kind: e.kind, refType: e.refType ?? "", refId: e.refId ?? "", payload: e.payload });
    let linked: { externalId: string | null; externalType: string | null } = { externalId: e.externalId, externalType: e.externalType };
    if (contactId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${i.id}:${contactId}`}, 0))`);
      if (!e.externalId) {
        const [l] = await tx
          .select({ externalId: externalLinks.externalId, externalType: externalLinks.externalType })
          .from(externalLinks)
          .where(and(eq(externalLinks.integrationId, i.id), eq(externalLinks.ourType, "contact"), eq(externalLinks.ourId, contactId)));
        if (l) linked = l;
      }
    }
    const payload = await withCurrentLead(tx, e.payload);

    const ctx: ConnectorContext = { integration: i, credentials: credentialsOf(i), fetch: fetchImpl, save: saver(tx, ref.tenantId, i) };
    const out: OutEvent = { id: e.id, kind: e.kind, idempotencyKey: e.idempotencyKey, ...linked, payload, progress: e.progress };
    const r = await connector.send(ctx, out);
    // The record and its kind are kept together: an id the connector hands
    // back brings its own kind (or none), never the kind of the one before.
    // One gone from their system is let go, so the next try searches.
    const record = r.externalId ? { externalId: r.externalId, externalType: r.externalType ?? null } : r.forget ? { externalId: null, externalType: null } : linked;
    // Stored as sent, so the delivery log shows what they were given.
    const kept = { ...record, payload, progress: r.progress ?? e.progress, httpStatus: r.httpStatus ?? null, response: (r.response ?? "").slice(0, 1000) };

    // Which of their records this person is, and in which module, so the next
    // call lands in the same place without a search. A record found or made
    // now replaces the one before (a Lead converted to a Contact); one their
    // system no longer has is let go.
    const link = and(eq(externalLinks.integrationId, i.id), eq(externalLinks.ourType, "contact"), eq(externalLinks.ourId, contactId ?? ""));
    if (contactId && (r.forget || (r.ok && r.externalId))) await tx.delete(externalLinks).where(link);
    if (contactId && r.ok && r.externalId) {
      // Left unlinked when their record is already another contact's: the next call searches.
      await tx
        .insert(externalLinks)
        .values({ tenantId: ref.tenantId, integrationId: i.id, ourType: "contact", ourId: contactId, externalType: r.externalType ?? String(i.config.module ?? "record"), externalId: r.externalId })
        .onConflictDoNothing();
    }

    if (r.ok) {
      await tx.update(integrationEvents).set({ status: "done", ...kept, error: null, updatedAt: new Date() }).where(eq(integrationEvents.id, e.id));
      await tx.update(integrations).set({ status: "connected", lastOkAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(integrations.id, i.id));
      return { ok: true, status: "done", message: r.response ?? "" };
    }

    // A refusal about this one record (a caller who is not in their CRM, a
    // value it rejects) must not stop the calls after it reaching their
    // system. It is skipped with its reason, and "Send again" puts it back
    // once they have fixed it on their side. The reason also goes on the
    // connection, where the client looks; it stays connected unless their
    // system has refused everything for a while.
    if (r.retry === false && !r.connectionBroken) {
      const reason = (r.response ?? "refused").slice(0, 500);
      await tx.update(integrationEvents).set({ status: "skipped", ...kept, error: reason, updatedAt: new Date() }).where(eq(integrationEvents.id, e.id));
      const stuck = r.httpStatus !== undefined && (await refusedEveryTime(tx, i.id));
      await tx
        .update(integrations)
        .set({
          ...(stuck ? { status: "error" as const } : {}),
          lastError: (stuck ? `Their system refused the last ${REFUSED_IN_A_ROW} deliveries. The latest: ${reason}` : reason).slice(0, 300),
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, i.id));
      return { ok: false, status: "skipped", message: r.response ?? "" };
    }

    // The record found and what already landed are kept, so the next try
    // carries on from there instead of writing the same call again.
    const exhausted = e.attempts >= BACKOFF_MS.length;
    const giveUp = r.connectionBroken === true || exhausted;
    // A refused connection is broken. One event failing for a day is that
    // event's problem while others still get through; only a day in which
    // nothing at all got through says the same about the connection.
    const broken = r.connectionBroken === true || (exhausted && (!i.lastOkAt || i.lastOkAt < e.createdAt));
    const wait = BACKOFF_MS[Math.min(e.attempts, BACKOFF_MS.length - 1)]!;
    await tx
      .update(integrationEvents)
      .set({ status: giveUp ? "failed" : "queued", nextAttemptAt: new Date(Date.now() + wait), ...kept, error: (r.response ?? "could not deliver").slice(0, 500), updatedAt: new Date() })
      .where(eq(integrationEvents.id, e.id));
    await tx
      .update(integrations)
      .set({ status: broken ? "error" : i.status, lastError: (r.response ?? "could not deliver").slice(0, 300), lastErrorAt: new Date(), updatedAt: new Date() })
      .where(eq(integrations.id, i.id));
    return { ok: false, status: giveUp ? "failed" : "queued", message: r.response ?? "" };
  });
}

/** Deliveries left "sending" by a worker that died. */
export async function requeueStuckDeliveries(db: Db, minutes = 10): Promise<number> {
  const r = await db.execute(sql`
    update integration_events set status = 'queued', next_attempt_at = now(), updated_at = now()
    where status = 'sending' and updated_at < now() - make_interval(mins => ${minutes})`);
  return (r as unknown as { count?: number }).count ?? 0;
}
