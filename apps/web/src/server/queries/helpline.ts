import "server-only";
import { eq } from "drizzle-orm";
import { agents, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";

/** A cyber crime helpline works from Analytics, not sales Leads. */
export async function isCaseWorkspace(tenantId: string): Promise<boolean> {
  const [a] = await withTenant(tenantId, (tx) => tx.select({ id: agents.id }).from(agents).where(eq(agents.domain, CYBER_INTAKE_DOMAIN)).limit(1));
  return !!a;
}
