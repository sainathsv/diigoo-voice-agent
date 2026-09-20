import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agents, agentVersions, campaigns, clientPrograms, phoneNumbers, programTemplates, withTenant } from "@jenai/db";
import { catalogueFor } from "@jenai/engine";

/** The programs this client already runs, with where each one has got to. */
export async function loadPrograms(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const catalogue = await catalogueFor(tx, tenantId);
    const mine = await tx.select().from(clientPrograms).orderBy(desc(clientPrograms.createdAt));
    const agentIds = mine.map((m) => m.agentId).filter((x): x is string => Boolean(x));
    const rows = agentIds.length
      ? await tx.select({ a: agents, liveNumber: agentVersions.number, state: agentVersions.state }).from(agents).leftJoin(agentVersions, eq(agentVersions.id, agents.liveVersionId)).where(inArray(agents.id, agentIds))
      : [];
    const counts = agentIds.length
      ? await tx.select({ programId: campaigns.clientProgramId, status: campaigns.status }).from(campaigns).where(inArray(campaigns.clientProgramId, mine.map((m) => m.id)))
      : [];
    const numbers = await tx.select({ id: phoneNumbers.id, e164: phoneNumbers.e164, series: phoneNumbers.series, purpose: phoneNumbers.purpose }).from(phoneNumbers).where(eq(phoneNumbers.status, "active"));
    const templates = new Map(catalogue.map((c) => [`${c.key}:${c.version}`, c]));
    const extra = mine.filter((m) => !templates.has(`${m.programKey}:${m.programVersion}`));
    if (extra.length) {
      const olds = await tx
        .select()
        .from(programTemplates)
        .where(inArray(programTemplates.key, extra.map((e) => e.programKey)));
      for (const o of olds) templates.set(`${o.key}:${o.version}`, o);
    }
    return {
      catalogue,
      numbers,
      running: mine.map((m) => ({
        program: m,
        template: templates.get(`${m.programKey}:${m.programVersion}`) ?? null,
        agent: rows.find((r) => r.a.id === m.agentId)?.a ?? null,
        liveVersion: rows.find((r) => r.a.id === m.agentId)?.liveNumber ?? null,
        campaigns: counts.filter((c) => c.programId === m.id).length,
        live: counts.filter((c) => c.programId === m.id && c.status === "running").length,
      })),
    };
  });
}
