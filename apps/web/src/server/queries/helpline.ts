import "server-only";
import { and, eq, like, sql } from "drizzle-orm";
import { agents, organizations, programTemplates, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";

/**
 * A cyber crime helpline works from Analytics, not sales Leads: either it has a
 * cyber crime agent, or a police program was written just for it.
 */
export async function isCaseWorkspace(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [a] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.domain, CYBER_INTAKE_DOMAIN)).limit(1);
    if (a) return true;
    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, tenantId));
    if (!org) return false;
    const [p] = await tx
      .select({ key: programTemplates.key })
      .from(programTemplates)
      .where(and(like(programTemplates.key, "police.%"), sql`${org.slug} = any(${programTemplates.tenantSlugs})`))
      .limit(1);
    return !!p;
  });
}
