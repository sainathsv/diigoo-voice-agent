import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { apiKeys, clientPrograms, integrationEvents, integrations, withTenant } from "@jenai/db";

/** Connections to the client's own systems, their keys, and what the last deliveries did. */
export async function loadIntegrations(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const [conns, keys, recent, programs] = await Promise.all([
      tx.select().from(integrations).orderBy(desc(integrations.createdAt)),
      tx.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)),
      tx.select().from(integrationEvents).orderBy(desc(integrationEvents.createdAt)).limit(25),
      tx.select({ key: clientPrograms.programKey, name: clientPrograms.name }).from(clientPrograms),
    ]);
    const [counts] = await tx
      .select({
        waiting: sql<number>`count(*) filter (where status = 'queued')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`,
        sentToday: sql<number>`count(*) filter (where status = 'done' and updated_at > now() - interval '24 hours')::int`,
        skippedToday: sql<number>`count(*) filter (where status = 'skipped' and updated_at > now() - interval '24 hours')::int`,
      })
      .from(integrationEvents);
    // Per connection: a skip is a delivery that did not land, and one that
    // hits every event looks like a quiet connection unless it is counted.
    const skips = await tx
      .select({ integrationId: integrationEvents.integrationId, n: sql<number>`count(*)::int` })
      .from(integrationEvents)
      .where(and(eq(integrationEvents.status, "skipped"), sql`${integrationEvents.updatedAt} > now() - interval '24 hours'`))
      .groupBy(integrationEvents.integrationId);
    const skippedToday = Object.fromEntries(skips.map((s) => [s.integrationId ?? "", s.n]));
    return { conns, keys, recent, programs, skippedToday, counts: counts ?? { waiting: 0, failed: 0, sentToday: 0, skippedToday: 0 } };
  });
}

export async function deliveriesFor(tenantId: string, integrationId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(integrationEvents).where(eq(integrationEvents.integrationId, integrationId)).orderBy(desc(integrationEvents.createdAt)).limit(50),
  );
}
