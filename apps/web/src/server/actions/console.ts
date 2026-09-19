"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { can } from "@jenai/authz";
import {
  PROVISIONING_STEPS,
  audit,
  branches,
  memberships,
  organizations,
  plans,
  platformDb,
  provisioningSteps,
  subscriptions,
  roleBindings,
  roles,
  supportGrants,
  user,
  withTenant,
} from "@jenai/db";
import { requirePlatform } from "../platform/context";
import { createInvitation } from "../invitations";
import { requestMeta } from "../session";

export type ConsoleFormState = { ok?: string; error?: string; link?: string; clientId?: string } | null;

const go = (path: string, msg: { ok?: string; error?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
};

const VERTICALS = ["dental", "derma", "hospital", "municipal", "spa", "gym", "restaurant", "home_services", "other"] as const;

const newClient = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "Use 2 to 48 lowercase letters, digits or hyphens"),
  vertical: z.enum(VERTICALS),
  city: z.string().trim().max(80).optional(),
  plan: z.enum(["trial", "front_desk", "growth", "business", "enterprise", "government"]),
  branch: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.email(),
});

/** Create a client: organization, first branch, go-live checklist and the Owner invitation. */
export async function createClient(_: ConsoleFormState, fd: FormData): Promise<ConsoleFormState> {
  const ctx = await requirePlatform("platform:clients.manage");
  const p = newClient.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Check the form." };
  const d = p.data;
  const db = platformDb();
  const [taken] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, d.slug));
  if (taken) return { error: `The address ${d.slug} is taken.` };
  const [ownerRole] = await db.select().from(roles).where(and(eq(roles.key, "owner"), eq(roles.side, "client"), isNull(roles.tenantId)));
  if (!ownerRole) return { error: "Role templates are missing. Run the seed." };

  const [org] = await db
    .insert(organizations)
    .values({ kind: "client", parentId: ctx.platformOrgId, name: d.name, slug: d.slug, vertical: d.vertical, city: d.city || null, state: "Telangana", plan: d.plan, status: "onboarding", languages: ["te", "hi", "en"] })
    .returning();
  const meta = await requestMeta();
  // Everything tenant-owned is written through the tenant context, like the app does.
  const link = await withTenant(org!.id, async (tx) => {
    const [b] = await tx.insert(branches).values({ tenantId: org!.id, name: d.branch, city: d.city || null, languages: ["te", "hi", "en"] }).returning({ id: branches.id });
    for (const s of PROVISIONING_STEPS) await tx.insert(provisioningSteps).values({ tenantId: org!.id, step: s.key });
    const [planRow] = await tx.select().from(plans).where(eq(plans.key, d.plan));
    await tx.insert(subscriptions).values({ tenantId: org!.id, planKey: d.plan, billingModel: planRow?.billingModel ?? "prepaid", startsOn: new Date().toISOString().slice(0, 10), extraFeatures: [] });
    const inv = await createInvitation(tx, { tenantId: org!.id, email: d.ownerEmail, name: d.ownerName, roleId: ownerRole.id, invitedBy: ctx.user.userId });
    await audit(tx, {
      tenantId: org!.id,
      actorUserId: ctx.user.userId,
      via: "user",
      action: "org.created",
      targetType: "organization",
      targetId: org!.id,
      summary: `JENAI created this workspace (${d.plan}) with branch ${d.branch}; Owner invited: ${d.ownerEmail}`,
      diff: { branchId: b!.id },
      ...meta,
    });
    return inv.url;
  });
  revalidatePath("/console");
  return { ok: `${d.name} created. Send the Owner this invitation link.`, link, clientId: org!.id };
}

export async function setStepStatus(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.provision");
  const orgId = String(fd.get("orgId"));
  const step = String(fd.get("step"));
  const status = z.enum(["pending", "in_progress", "passed", "failed", "skipped"]).parse(fd.get("status"));
  const detail = String(fd.get("detail") ?? "").trim().slice(0, 300) || null;
  if (!PROVISIONING_STEPS.some((s) => s.key === step)) go(`/console/clients/${orgId}`, { error: "Unknown step" });
  await withTenant(orgId, async (tx) => {
    await tx
      .update(provisioningSteps)
      .set({ status, detail, updatedBy: ctx.user.userId, updatedAt: new Date() })
      .where(and(eq(provisioningSteps.tenantId, orgId), eq(provisioningSteps.step, step)));
    await audit(tx, {
      tenantId: orgId,
      actorUserId: ctx.user.userId,
      action: "provisioning.step",
      targetType: "provisioning_step",
      targetId: step,
      summary: `Go-live step "${PROVISIONING_STEPS.find((s) => s.key === step)?.label}" set to ${status.replace("_", " ")}`,
      diff: { detail },
      ...(await requestMeta()),
    });
  });
  go(`/console/clients/${orgId}`, { ok: "Step updated" });
}

/** The go-live gate: every required step must have passed. */
export async function goLive(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.provision");
  const orgId = String(fd.get("orgId"));
  const db = platformDb();
  const steps = await db.select().from(provisioningSteps).where(eq(provisioningSteps.tenantId, orgId));
  const open = PROVISIONING_STEPS.filter((s) => s.required && steps.find((x) => x.step === s.key)?.status !== "passed");
  if (open.length) go(`/console/clients/${orgId}`, { error: `Cannot go live yet. Still open: ${open.map((s) => s.label).join(", ")}` });
  await db.update(organizations).set({ status: "active", updatedAt: new Date() }).where(eq(organizations.id, orgId));
  await audit(db, { tenantId: orgId, actorUserId: ctx.user.userId, action: "org.went_live", targetType: "organization", targetId: orgId, summary: "All go-live checks passed; workspace is live", ...(await requestMeta()) });
  go(`/console/clients/${orgId}`, { ok: "Client is live" });
}

export async function setClientStatus(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.manage");
  const orgId = String(fd.get("orgId"));
  const status = z.enum(["active", "suspended"]).parse(fd.get("status"));
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200);
  if (status === "suspended" && reason.length < 5) go(`/console/clients/${orgId}`, { error: "Give a reason for suspending (at least 5 characters)." });
  const db = platformDb();
  await db.update(organizations).set({ status, suspendedReason: status === "suspended" ? reason : null, updatedAt: new Date() }).where(and(eq(organizations.id, orgId), eq(organizations.kind, "client")));
  await audit(db, {
    tenantId: orgId,
    actorUserId: ctx.user.userId,
    action: status === "suspended" ? "org.suspended" : "org.reactivated",
    targetType: "organization",
    targetId: orgId,
    summary: status === "suspended" ? `JENAI suspended this workspace: ${reason}` : "JENAI reactivated this workspace",
    ...(await requestMeta()),
  });
  go(`/console/clients/${orgId}`, { ok: status === "suspended" ? "Client suspended" : "Client reactivated" });
}

const supportReq = z.object({
  orgId: z.uuid(),
  mode: z.enum(["read", "write", "breakglass"]),
  reason: z.string().trim().min(10, "Explain why (at least 10 characters)").max(400),
  ticket: z.string().trim().max(40).optional(),
  minutes: z.coerce.number().int().min(15).max(240),
});

// Tenant-owned writes from the console go through withTenant on the app pool,
// so row-level security still applies; the platform pool is used for reads only.

/**
 * Ask a client for access. Read access is auto-approved while the client's
 * standing consent is on. Break-glass skips consent but is super-admin only,
 * capped at 15 minutes, and loudly logged.
 */
export async function requestSupport(fd: FormData) {
  const ctx = await requirePlatform("platform:support.request");
  const p = supportReq.safeParse(Object.fromEntries(fd));
  const orgId = String(fd.get("orgId"));
  if (!p.success) go(`/console/clients/${orgId}`, { error: p.error!.issues[0]?.message ?? "Check the request." });
  const d = p.data!;
  if (d.mode === "breakglass" && !can(ctx.access, "platform:breakglass")) go(`/console/clients/${orgId}`, { error: "Break-glass is for super admins only." });
  const db = platformDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, d.orgId));
  if (!org || org.kind !== "client") go("/console", { error: "Client not found" });
  const now = new Date();
  const standing = !!org!.supportAccessUntil && org!.supportAccessUntil > now;
  const autoApprove = d.mode === "breakglass" || (d.mode === "read" && standing);
  const minutes = d.mode === "breakglass" ? 15 : d.minutes;

  await withTenant(d.orgId, async (tx) => {
    const [g] = await tx
      .insert(supportGrants)
      .values({
        tenantId: d.orgId,
        staffUserId: ctx.user.userId,
        mode: d.mode,
        reason: d.reason,
        ticket: d.ticket || null,
        durationMinutes: minutes,
        ...(autoApprove ? { status: "approved" as const, startsAt: now, expiresAt: new Date(now.getTime() + minutes * 60_000), decidedAt: now } : {}),
      })
      .returning({ id: supportGrants.id });
    await audit(tx, {
      tenantId: d.orgId,
      actorUserId: ctx.user.userId,
      via: "support",
      action: d.mode === "breakglass" ? "support.breakglass" : "support.requested",
      targetType: "support_grant",
      targetId: g!.id,
      summary:
        d.mode === "breakglass"
          ? `BREAK-GLASS: ${ctx.user.name} (JENAI) took 15 minutes of emergency access. Reason: ${d.reason}`
          : `${ctx.user.name} (JENAI) requested ${d.mode} access for ${minutes} min${autoApprove ? " (auto-approved by standing consent)" : ""}. Reason: ${d.reason}`,
      ...(await requestMeta()),
    });
  });
  go(`/console/access`, { ok: autoApprove ? "Access is active. Use Enter to open the workspace." : "Request sent to the client for approval." });
}

/** Second approver for write access (Blueprint Part 3). */
export async function platformApprove(fd: FormData) {
  const ctx = await requirePlatform("platform:support.approve");
  const grantId = String(fd.get("grantId"));
  const db = platformDb();
  const [g] = await db.select().from(supportGrants).where(eq(supportGrants.id, grantId));
  if (!g || g.mode !== "write" || g.status !== "requested") go("/console/access", { error: "Nothing to approve." });
  if (g!.staffUserId === ctx.user.userId) go("/console/access", { error: "Someone else must approve your own write request." });
  const now = new Date();
  const clientApproved = !!g!.decidedBy;
  await withTenant(g!.tenantId, async (tx) => {
    await tx
      .update(supportGrants)
      .set({
        platformApprover: ctx.user.userId,
        ...(clientApproved ? { status: "approved" as const, startsAt: now, expiresAt: new Date(now.getTime() + g!.durationMinutes * 60_000) } : {}),
      })
      .where(eq(supportGrants.id, grantId));
    await audit(tx, { tenantId: g!.tenantId, actorUserId: ctx.user.userId, via: "support", action: "support.approved_by_jenai", targetType: "support_grant", targetId: grantId, summary: `${ctx.user.name} (JENAI) co-approved write access` });
  });
  go("/console/access", { ok: clientApproved ? "Write access is active." : "Co-approved. Waiting for the client." });
}

export async function endSupportGrant(fd: FormData) {
  const ctx = await requirePlatform("platform:support.request");
  const grantId = String(fd.get("grantId"));
  const db = platformDb();
  const [g] = await db.select().from(supportGrants).where(eq(supportGrants.id, grantId));
  if (!g) go("/console/access", { error: "Not found" });
  if (g!.staffUserId !== ctx.user.userId && !can(ctx.access, "platform:support.approve")) go("/console/access", { error: "Not yours to end." });
  await withTenant(g!.tenantId, async (tx) => {
    await tx.update(supportGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(supportGrants.id, grantId));
    await audit(tx, { tenantId: g!.tenantId, actorUserId: ctx.user.userId, via: "support", action: "support.ended", targetType: "support_grant", targetId: grantId, summary: `${ctx.user.name} (JENAI) ended support access` });
  });
  go("/console/access", { ok: "Access ended" });
}

// ------------------------------------------------------------------ staff

export async function inviteStaff(_: ConsoleFormState, fd: FormData): Promise<ConsoleFormState> {
  const ctx = await requirePlatform("platform:staff.manage");
  const p = z.object({ email: z.email(), name: z.string().trim().min(2), roleId: z.uuid() }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "Check the name, email and role." };
  const db = platformDb();
  const [role] = await db.select().from(roles).where(eq(roles.id, p.data.roleId));
  if (!role || role.side !== "platform") return { error: "Choose a Diigoo role." };
  if (role.key === "super_admin" && !can(ctx.access, "platform:breakglass")) return { error: "Only a super admin can add a super admin." };
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(and(eq(memberships.tenantId, ctx.platformOrgId), eq(user.email, p.data.email.toLowerCase())));
  if (existing) return { error: "Already on the Diigoo team." };
  const link = await withTenant(ctx.platformOrgId, async (tx) => {
    const inv = await createInvitation(tx, { tenantId: ctx.platformOrgId, email: p.data.email, name: p.data.name, roleId: role.id, invitedBy: ctx.user.userId });
    await audit(tx, { tenantId: ctx.platformOrgId, actorUserId: ctx.user.userId, action: "staff.invited", targetType: "invitation", targetId: inv.id, summary: `Invited ${p.data.email} as ${role.name}` });
    return inv.url;
  });
  revalidatePath("/console/staff");
  return { ok: `Invitation created for ${p.data.email}.`, link };
}

export async function removeStaffRole(fd: FormData) {
  const ctx = await requirePlatform("platform:staff.manage");
  const bindingId = String(fd.get("bindingId"));
  const db = platformDb();
  const [b] = await db
    .select({ binding: roleBindings, role: roles })
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(and(eq(roleBindings.id, bindingId), eq(roleBindings.tenantId, ctx.platformOrgId)));
  if (!b) go("/console/staff", { error: "Not found" });
  if (b!.role.key === "super_admin") {
    const supers = await db.select({ id: roleBindings.id }).from(roleBindings).where(eq(roleBindings.roleId, b!.role.id));
    if (supers.length <= 1) go("/console/staff", { error: "Keep at least one super admin." });
  }
  await withTenant(ctx.platformOrgId, async (tx) => {
    await tx.delete(roleBindings).where(eq(roleBindings.id, bindingId));
    await audit(tx, { tenantId: ctx.platformOrgId, actorUserId: ctx.user.userId, action: "staff.role_removed", targetType: "membership", targetId: b!.binding.membershipId, summary: `Removed ${b!.role.name}` });
  });
  go("/console/staff", { ok: "Role removed" });
}
