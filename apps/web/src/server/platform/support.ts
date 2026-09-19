import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt, lte } from "drizzle-orm";
import { organizations, platformDb, supportGrants, type Organization } from "@jenai/db";
import { platformContext } from "./context";

export const SUPPORT_COOKIE = "jenai_support";

/**
 * A Diigoo staff member's live support session for one client, if any.
 * Requires: the support cookie names a grant for this staff member and this
 * client, the grant is approved, has started and has not expired.
 */
export async function activeSupportSession(
  userId: string,
  slug: string,
): Promise<{ org: Organization; grantId: string; mode: "read" | "write"; expiresAt: Date } | null> {
  const grantId = (await cookies()).get(SUPPORT_COOKIE)?.value;
  if (!grantId || !/^[0-9a-f-]{36}$/i.test(grantId)) return null;
  const staff = await platformContext();
  if (!staff || staff.user.userId !== userId) return null;

  const now = new Date();
  const [row] = await platformDb()
    .select({ org: organizations, grant: supportGrants })
    .from(supportGrants)
    .innerJoin(organizations, eq(organizations.id, supportGrants.tenantId))
    .where(
      and(
        eq(supportGrants.id, grantId),
        eq(supportGrants.staffUserId, userId),
        eq(supportGrants.status, "approved"),
        eq(organizations.slug, slug),
        lte(supportGrants.startsAt, now),
        gt(supportGrants.expiresAt, now),
      ),
    );
  if (!row) return null;
  return {
    org: row.org,
    grantId: row.grant.id,
    mode: row.grant.mode === "read" ? "read" : "write",
    expiresAt: row.grant.expiresAt!,
  };
}
