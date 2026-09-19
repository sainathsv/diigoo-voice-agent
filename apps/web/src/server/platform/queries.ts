import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditEvents,
  branches,
  memberships,
  organizations,
  platformDb,
  provisioningSteps,
  roleBindings,
  roles,
  supportGrants,
  user,
} from "@jenai/db";

// Console reads only. Every caller has passed requirePlatform() first.

export async function listClients() {
  const db = platformDb();
  const orgs = await db.select().from(organizations).where(eq(organizations.kind, "client")).orderBy(organizations.name);
  const ids = orgs.map((o) => o.id);
  if (!ids.length) return [];
  const steps = await db.select({ tenantId: provisioningSteps.tenantId, status: provisioningSteps.status }).from(provisioningSteps).where(inArray(provisioningSteps.tenantId, ids));
  const people = await db
    .select({ tenantId: memberships.tenantId, n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(inArray(memberships.tenantId, ids), eq(memberships.status, "active")))
    .groupBy(memberships.tenantId);
  const requests = await db
    .select({ tenantId: supportGrants.tenantId, n: sql<number>`count(*)::int` })
    .from(supportGrants)
    .where(and(inArray(supportGrants.tenantId, ids), eq(supportGrants.status, "requested")))
    .groupBy(supportGrants.tenantId);
  return orgs.map((o) => {
    const mine = steps.filter((s) => s.tenantId === o.id);
    return {
      ...o,
      passed: mine.filter((s) => s.status === "passed").length,
      failed: mine.filter((s) => s.status === "failed").length,
      totalSteps: mine.length,
      people: people.find((p) => p.tenantId === o.id)?.n ?? 0,
      openRequests: requests.find((r) => r.tenantId === o.id)?.n ?? 0,
    };
  });
}

export async function clientDetail(id: string) {
  const db = platformDb();
  const [org] = await db.select().from(organizations).where(and(eq(organizations.id, id), eq(organizations.kind, "client")));
  if (!org) return null;
  const [steps, branchRows, members, grants, recent] = await Promise.all([
    db.select().from(provisioningSteps).where(eq(provisioningSteps.tenantId, id)),
    db.select().from(branches).where(eq(branches.tenantId, id)).orderBy(branches.name),
    db
      .select({ membershipId: memberships.id, status: memberships.status, name: user.name, email: user.email, role: roles.name, branchId: roleBindings.branchId })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .leftJoin(roleBindings, and(eq(roleBindings.membershipId, memberships.id), eq(roleBindings.tenantId, id)))
      .leftJoin(roles, eq(roles.id, roleBindings.roleId))
      .where(eq(memberships.tenantId, id))
      .orderBy(user.name),
    db
      .select({ g: supportGrants, staffName: user.name })
      .from(supportGrants)
      .leftJoin(user, eq(user.id, supportGrants.staffUserId))
      .where(eq(supportGrants.tenantId, id))
      .orderBy(desc(supportGrants.requestedAt))
      .limit(20),
    db.select().from(auditEvents).where(eq(auditEvents.tenantId, id)).orderBy(desc(auditEvents.createdAt)).limit(15),
  ]);
  return { org, steps, branches: branchRows, members, grants, recent };
}

export async function listGrants() {
  return platformDb()
    .select({ g: supportGrants, staffName: user.name, orgName: organizations.name, orgSlug: organizations.slug })
    .from(supportGrants)
    .innerJoin(organizations, eq(organizations.id, supportGrants.tenantId))
    .leftJoin(user, eq(user.id, supportGrants.staffUserId))
    .orderBy(desc(supportGrants.requestedAt))
    .limit(100);
}

export async function listStaff(platformOrgId: string) {
  const db = platformDb();
  const people = await db
    .select({ membershipId: memberships.id, status: memberships.status, name: user.name, email: user.email })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.tenantId, platformOrgId))
    .orderBy(user.name);
  const bindings = await db
    .select({ id: roleBindings.id, membershipId: roleBindings.membershipId, roleName: roles.name, roleKey: roles.key })
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(eq(roleBindings.tenantId, platformOrgId));
  const platformRoles = await db.select().from(roles).where(and(eq(roles.side, "platform"), isNull(roles.tenantId)));
  return { people, bindings, platformRoles };
}

export async function platformAudit() {
  return platformDb()
    .select({ e: auditEvents, actorName: user.name, orgName: organizations.name })
    .from(auditEvents)
    .leftJoin(user, eq(user.id, auditEvents.actorUserId))
    .leftJoin(organizations, eq(organizations.id, auditEvents.tenantId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(300);
}
