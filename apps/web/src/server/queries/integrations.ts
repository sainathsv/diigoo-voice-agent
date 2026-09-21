import "server-only";
import { desc, eq, sql } from "drizzle-orm";
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
      })
      .from(integrationEvents);
    return { conns, keys, recent, programs, counts: counts ?? { waiting: 0, failed: 0, sentToday: 0 } };
  });
}

export async function deliveriesFor(tenantId: string, integrationId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(integrationEvents).where(eq(integrationEvents.integrationId, integrationId)).orderBy(desc(integrationEvents.createdAt)).limit(50),
  );
}
