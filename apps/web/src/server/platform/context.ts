import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { can, type AccessContext, type PlatformPermission } from "@jenai/authz";
import { withTenant } from "@jenai/db";
import { myOrganizations, requireUser } from "../session";
import { loadGrants, type Actor } from "../grants";
import { logDenied } from "../security-log";
import { STAFF_MFA_REQUIRED } from "@/lib/mfa-policy";

export interface PlatformCtx {
  platformOrgId: string;
  user: Actor;
  access: AccessContext;
}

/**
 * Resolve the Diigoo console context. Staff are members of the platform
 * organization; their platform roles are read inside that tenant.
 * Returns null when the user is not Diigoo staff.
 */
export const platformContext = cache(async (): Promise<PlatformCtx | null> => {
  const u = await requireUser();
  const p = (await myOrganizations(u.id)).find((o) => o.kind === "platform" && o.membershipStatus === "active");
  if (!p) return null;
  const grants = await withTenant(p.orgId, (tx) => loadGrants(tx, p.membershipId));
  return {
    platformOrgId: p.orgId,
    user: { userId: u.id, name: u.name, email: u.email },
    access: { userId: u.id, orgId: p.orgId, orgKind: "platform", grants },
  };
});

/** Gate for every console page and action. The platform DB pool may only be used after this. */
export async function requirePlatform(perm?: PlatformPermission): Promise<PlatformCtx> {
  const ctx = await platformContext();
  if (!ctx) {
    const u = await requireUser();
    await logDenied({ user: { userId: u.id } }, { area: "console", reason: "not Diigoo staff" });
    redirect("/orgs");
  }
  if (STAFF_MFA_REQUIRED && !(await staffHasTwoStep())) redirect("/account/security?required=staff");
  if (perm && !can(ctx.access, perm)) {
    await logDenied({ user: ctx.user, org: { id: ctx.platformOrgId } }, { area: "console", perm });
    redirect(`/console?denied=${encodeURIComponent(perm)}`);
  }
  return ctx;
}

export function platformCan(ctx: PlatformCtx, perm: PlatformPermission) {
  return can(ctx.access, perm);
}

/** Staff must have two-step sign-in on (production default). */
async function staffHasTwoStep(): Promise<boolean> {
  const u = await requireUser();
  return Boolean((u as { twoFactorEnabled?: boolean }).twoFactorEnabled);
}
