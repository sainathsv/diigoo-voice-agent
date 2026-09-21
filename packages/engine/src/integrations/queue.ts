import { and, eq, inArray, sql } from "drizzle-orm";
import { externalLinks, integrationEvents, integrations, openSecret, sealSecret, withTenant, type Db, type Integration, type Tx } from "@jenai/db";
import { webhookConnector, restConnector } from "./http";
import { zohoConnector } from "./zoho";
import type { Connector, ConnectorContext, OutEvent } from "./types";

/**
 * Write-backs to the client's own system: queued in the database, delivered by
 * the worker, retried with a widening gap, and never sent twice (idempotency
 * key per event and integration). Any number of workers can share the queue.
 */

export const CONNECTORS: Record<string, Connector> = {
  webhook_out: webhookConnector,
  rest_generic: restConnector,
  zoho_crm: zohoConnector,
};

const PURPOSE = "integration-credentials";
/** 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h, then give up. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];

export function credentialsOf(i: Integration): Record<string, string> {
  if (!i.credentials) return {};
  try {
    return JSON.parse(openSecret(i.tenantId, PURPOSE, i.credentials)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function sealCredentials(tenantId: string, creds: Record<string, string>): string {
  return sealSecret(tenantId, PURPOSE, JSON.stringify(creds));
}

/** Who wants this event: connected integrations that push out and subscribe to it. */
export async function subscribers(tx: Tx, kind: string): Promise<Integration[]> {
  const rows = await tx
    .select()
    .from(integrations)
    .where(and(inArray(integrations.status, ["connected", "draft"]), inArray(integrations.direction, ["out", "both"])));
  return rows.filter((i) => i.status === "connected" && (i.events.length === 0 || i.events.includes(kind)));
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
}

/** Hands one event to every integration that wants it. Safe to call twice. */
export async function enqueueEvent(tx: Tx, tenantId: string, input: EnqueueInput): Promise<number> {
  const targets = await subscribers(tx, input.kind);
  let queued = 0;
  for (const i of targets) {
    const [linked] = input.externalId
      ? []
      : await tx
          .select({ externalId: externalLinks.externalId })
          .from(externalLinks)
          .where(and(eq(externalLinks.integrationId, i.id), eq(externalLinks.ourType, input.refType === "call" ? "contact" : input.refType), eq(externalLinks.ourId, String(payloadContactId(input) ?? input.refId))));
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
        idempotencyKey: key,
        payload: input.payload,
      })
      .onConflictDoNothing()
      .returning({ id: integrationEvents.id });
    if (r.length) queued++;
  }
  return queued;
}

function payloadContactId(input: EnqueueInput): string | undefined {
  const person = input.payload.person as Record<string, unknown> | undefined;
  return typeof person?.contact_id === "string" ? person.contact_id : undefined;
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
    if (i.status === "paused") {
      await tx.update(integrationEvents).set({ status: "queued", nextAttemptAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() }).where(eq(integrationEvents.id, e.id));
      return { ok: false, status: "queued", message: "paused" };
    }

    const ctx: ConnectorContext = {
      integration: i,
      credentials: credentialsOf(i),
      fetch: fetchImpl,
      async save(patch) {
        await tx
          .update(integrations)
          .set({
            ...(patch.credentials ? { credentials: sealCredentials(ref.tenantId, patch.credentials) } : {}),
            ...(patch.config ? { config: { ...i.config, ...patch.config } } : {}),
            updatedAt: new Date(),
          })
          .where(eq(integrations.id, i.id));
      },
    };
    const out: OutEvent = { id: e.id, kind: e.kind, idempotencyKey: e.idempotencyKey, externalId: e.externalId, payload: e.payload };
    const r = await connector.send(ctx, out);

    if (r.ok) {
      await tx
        .update(integrationEvents)
        .set({ status: "done", httpStatus: r.httpStatus ?? null, response: (r.response ?? "").slice(0, 1000), externalId: r.externalId ?? e.externalId, error: null, updatedAt: new Date() })
        .where(eq(integrationEvents.id, e.id));
      await tx.update(integrations).set({ status: "connected", lastOkAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(integrations.id, i.id));
      // Remember which of their records this person is, so the next call lands in the same place.
      const contactId = payloadContactId({ kind: e.kind, refType: e.refType ?? "", refId: e.refId ?? "", payload: e.payload });
      if (r.externalId && contactId) {
        await tx
          .insert(externalLinks)
          .values({ tenantId: ref.tenantId, integrationId: i.id, ourType: "contact", ourId: contactId, externalType: String(i.config.module ?? "record"), externalId: r.externalId })
          .onConflictDoNothing();
      }
      return { ok: true, status: "done", message: r.response ?? "" };
    }

    const give_up = r.retry === false || e.attempts >= BACKOFF_MS.length;
    const wait = BACKOFF_MS[Math.min(e.attempts, BACKOFF_MS.length - 1)]!;
    await tx
      .update(integrationEvents)
      .set({
        status: give_up ? "failed" : "queued",
        nextAttemptAt: new Date(Date.now() + wait),
        httpStatus: r.httpStatus ?? null,
        response: (r.response ?? "").slice(0, 1000),
        error: (r.response ?? "could not deliver").slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(integrationEvents.id, e.id));
    await tx
      .update(integrations)
      .set({ status: give_up ? "error" : i.status, lastError: (r.response ?? "could not deliver").slice(0, 300), lastErrorAt: new Date(), updatedAt: new Date() })
      .where(eq(integrations.id, i.id));
    return { ok: false, status: give_up ? "failed" : "queued", message: r.response ?? "" };
  });
}

/** Deliveries left "sending" by a worker that died. */
export async function requeueStuckDeliveries(db: Db, minutes = 10): Promise<number> {
  const r = await db.execute(sql`
    update integration_events set status = 'queued', next_attempt_at = now(), updated_at = now()
    where status = 'sending' and updated_at < now() - make_interval(mins => ${minutes})`);
  return (r as unknown as { count?: number }).count ?? 0;
}
