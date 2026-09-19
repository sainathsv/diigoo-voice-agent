import "server-only";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  auditEvents,
  branches,
  invitations,
  memberships,
  provisioningSteps,
  roleBindings,
  roles,
  supportGrants,
  user,
  withTenant,
} from "@jenai/db";

/** Everything the Team page needs, read inside the tenant. */
export async function loadTeam(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const members = await tx
      .select({ id: memberships.id, status: memberships.status, title: memberships.title, joined: memberships.createdAt, userId: user.id, name: user.name, email: user.email })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .orderBy(user.name);
    const bindings = await tx
      .select({ id: roleBindings.id, membershipId: roleBindings.membershipId, roleId: roles.id, roleName: roles.name, roleKey: roles.key, branchId: roleBindings.branchId, expiresAt: roleBindings.expiresAt })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId));
    const branchRows = await tx.select().from(branches).orderBy(branches.name);
    const roleRows = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.side, "client"), or(isNull(roles.tenantId), eq(roles.tenantId, tenantId))));
    const pending = await tx
      .select({ id: invitations.id, email: invitations.email, name: invitations.name, roleName: roles.name, branchId: invitations.branchId, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .where(eq(invitations.status, "pending"))
      .orderBy(desc(invitations.createdAt));
    return { members, bindings, branches: branchRows, roles: roleRows, pending };
  });
}

export async function loadOverview(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const steps = await tx.select().from(provisioningSteps);
    const memberCount = (await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.status, "active"))).length;
    const branchCount = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.status, "active"))).length;
    const recent = await tx.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(8);
    const pendingSupport = await tx.select({ id: supportGrants.id }).from(supportGrants).where(eq(supportGrants.status, "requested"));
    return { steps, memberCount, branchCount, recent, pendingSupport: pendingSupport.length };
  });
}

export async function loadAudit(tenantId: string, onlySupport: boolean) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ e: auditEvents, actorName: user.name })
      .from(auditEvents)
      .leftJoin(user, eq(user.id, auditEvents.actorUserId))
      .where(onlySupport ? eq(auditEvents.via, "support") : undefined)
      .orderBy(desc(auditEvents.createdAt))
      .limit(200);
    return rows;
  });
}

export async function loadSupport(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const grants = await tx
      .select({ g: supportGrants, staffName: user.name })
      .from(supportGrants)
      .leftJoin(user, eq(user.id, supportGrants.staffUserId))
      .orderBy(desc(supportGrants.requestedAt))
      .limit(30);
    return grants;
  });
}

export async function loadBranches(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select().from(branches).orderBy(branches.name);
    const counts = rows.length
      ? await tx.select({ branchId: roleBindings.branchId, membershipId: roleBindings.membershipId }).from(roleBindings).where(inArray(roleBindings.branchId, rows.map((r) => r.id)))
      : [];
    return rows.map((b) => ({ ...b, people: new Set(counts.filter((c) => c.branchId === b.id).map((c) => c.membershipId)).size }));
  });
}
