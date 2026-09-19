import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { assertCan, type AccessContext, type Permission, type Target } from "@jenai/authz";
import { organizations, withTenant, type Organization } from "@jenai/db";
import { loadGrants, type Actor } from "./grants";
import { myOrganizations, requireUser } from "./session";
import { activeSupportSession } from "./platform/support";

export interface WorkspaceCtx {
  org: Organization;
  user: Actor;
  membershipId: string | null;
  access: AccessContext;
  /** Set when a Diigoo staff member is here under a support grant. */
  support: { grantId: string; mode: "read" | "write"; expiresAt: Date } | null;
}

/**
 * Resolve the client workspace for /w/[slug]. Membership is re-verified on
 * every request; the tenant id always comes from that verification, never
 * from the URL or a form field.
 */
export const requireWorkspace = cache(async (slug: string): Promise<WorkspaceCtx> => {
  const u = await requireUser();
  const user: Actor = { userId: u.id, name: u.name, email: u.email };
  const mine = await myOrganizations(u.id);
  const m = mine.find((o) => o.slug === slug && o.kind !== "platform");

  if (m) {
    if (m.membershipStatus !== "active") redirect("/orgs?notice=membership-inactive");
    return withTenant(m.orgId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, m.orgId));
      if (!org) notFound();
      const grants = await loadGrants(tx, m.membershipId);
      return {
        org,
        user,
        membershipId: m.membershipId,
        access: { userId: u.id, orgId: org.id, orgKind: org.kind, grants },
        support: null,
      };
    });
  }

  // Not a member: Diigoo staff may enter under an approved, unexpired support grant.
  const s = await activeSupportSession(u.id, slug);
  if (!s) notFound();
  return {
    org: s.org,
    user,
    membershipId: null,
    access: {
      userId: u.id,
      orgId: s.org.id,
      orgKind: s.org.kind,
      grants: [],
      support: { staffUserId: u.id, grantId: s.grantId, mode: s.mode, expiresAt: s.expiresAt },
    },
    support: { grantId: s.grantId, mode: s.mode, expiresAt: s.expiresAt },
  };
});

/** Guard for server actions and pages: resolve the workspace and check one permission. */
export async function workspaceAction(slug: string, perm: Permission, target?: Target) {
  const ctx = await requireWorkspace(slug);
  if (ctx.org.status === "suspended" && !perm.endsWith(":view")) {
    throw new Error("This workspace is suspended. Contact JENAI support.");
  }
  assertCan(ctx.access, perm, target);
  return ctx;
}

/** Audit fields for the current actor, marking support sessions. */
export function actorFields(ctx: WorkspaceCtx) {
  return ctx.support
    ? { actorUserId: ctx.user.userId, impersonatorUserId: ctx.user.userId, via: "support" as const }
    : { actorUserId: ctx.user.userId, via: "user" as const };
}

export async function orgBySlugForMember(userId: string, slug: string) {
  const mine = await myOrganizations(userId);
  return mine.find((o) => o.slug === slug) ?? null;
}

export { and, eq };
