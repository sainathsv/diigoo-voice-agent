"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt } from "drizzle-orm";
import { audit, organizations, platformDb, supportGrants } from "@jenai/db";
import { requirePlatform } from "../platform/context";
import { SUPPORT_COOKIE } from "../platform/support";
import { requestMeta } from "../session";

/** Enter a client workspace under an approved grant. Logged on both sides. */
export async function enterSupport(fd: FormData) {
  const grantId = String(fd.get("grantId"));
  const ctx = await requirePlatform("platform:support.request");
  const now = new Date();
  const [row] = await platformDb()
    .select({ grant: supportGrants, org: organizations })
    .from(supportGrants)
    .innerJoin(organizations, eq(organizations.id, supportGrants.tenantId))
    .where(and(eq(supportGrants.id, grantId), eq(supportGrants.staffUserId, ctx.user.userId), eq(supportGrants.status, "approved"), gt(supportGrants.expiresAt, now)));
  if (!row) redirect("/console/access?error=That+grant+is+not+active");
  (await cookies()).set(SUPPORT_COOKIE, grantId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: row.grant.expiresAt!,
  });
  await audit(platformDb(), {
    tenantId: row.org.id,
    actorUserId: ctx.user.userId,
    impersonatorUserId: ctx.user.userId,
    via: "support",
    action: "support.session_started",
    targetType: "support_grant",
    targetId: grantId,
    summary: `${ctx.user.name} (JENAI) opened the workspace with ${row.grant.mode} access`,
    diff: { mode: row.grant.mode, expiresAt: row.grant.expiresAt },
    ...(await requestMeta()),
  });
  redirect(`/w/${row.org.slug}`);
}

export async function exitSupport() {
  const jar = await cookies();
  if (jar.get(SUPPORT_COOKIE)) jar.delete(SUPPORT_COOKIE);
}

export async function exitSupportAndReturn() {
  await exitSupport();
  redirect("/console/access");
}
