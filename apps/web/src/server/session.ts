import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appDb, sql } from "@jenai/db";
import { CLIENT_IP_HEADER, auth } from "@/lib/auth";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

export async function requireUser() {
  const s = await getSession();
  if (!s) redirect("/login");
  return s.user;
}

export interface MyOrg {
  orgId: string;
  kind: "platform" | "partner" | "client";
  name: string;
  slug: string;
  orgStatus: "onboarding" | "active" | "suspended" | "closed";
  membershipId: string;
  membershipStatus: "invited" | "active" | "suspended";
}

/** The organizations the signed-in user belongs to, via the one narrow cross-tenant lookup. */
export const myOrganizations = cache(async (userId: string): Promise<MyOrg[]> => {
  const rows = (await appDb().execute(
    sql`select org_id, kind, name, slug, org_status, membership_id, membership_status from lookup.my_organizations(${userId})`,
  )) as unknown as Array<Record<string, string>>;
  return rows.map((r) => ({
    orgId: r.org_id!,
    kind: r.kind as MyOrg["kind"],
    name: r.name!,
    slug: r.slug!,
    orgStatus: r.org_status as MyOrg["orgStatus"],
    membershipId: r.membership_id!,
    membershipStatus: r.membership_status as MyOrg["membershipStatus"],
  }));
});

export async function requestMeta() {
  const h = await headers();
  return {
    // Only the header our edge proxy sets; X-Forwarded-For can be forged by clients.
    ip: h.get(CLIENT_IP_HEADER) ?? null,
    userAgent: h.get("user-agent"),
  };
}
