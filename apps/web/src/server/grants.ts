import "server-only";
import { eq } from "drizzle-orm";
import type { Grant } from "@jenai/authz";
import { roleBindings, roles, type Tx } from "@jenai/db";

export interface Actor {
  userId: string;
  name: string;
  email: string;
}

/** Live role grants of one membership, read inside the tenant (row-level security applies). */
export async function loadGrants(tx: Tx, membershipId: string): Promise<Grant[]> {
  const rows = await tx
    .select({
      key: roles.key,
      permissions: roles.permissions,
      scopeType: roleBindings.scopeType,
      branchId: roleBindings.branchId,
      expiresAt: roleBindings.expiresAt,
    })
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(eq(roleBindings.membershipId, membershipId));
  return rows.map((r) => ({
    roleKey: r.key,
    permissions: r.permissions,
    scope: r.scopeType === "branch" && r.branchId ? { type: "branch", branchId: r.branchId } : { type: "org" },
    expiresAt: r.expiresAt,
  }));
}
