"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ALL_CLIENT_PERMISSIONS, can, type AccessContext, type Target, privilegedIn } from "@jenai/authz";
import {
  audit,
  branches,
  invitations,
  memberships,
  organizations,
  roleBindings,
  roles,
  supportGrants,
  user,
  withTenant,
  type Tx,
} from "@jenai/db";
import { actorFields, requireWorkspace, workspaceAction, type WorkspaceCtx } from "../access";
import { createInvitation } from "../invitations";
import { requestMeta } from "../session";

export type FormState = { ok?: string; error?: string; link?: string } | null;

const back = (slug: string, page: string, msg: { ok?: string; error?: string }, extra: Record<string, string> = {}): never => {
  const q = new URLSearchParams(extra);
  if (msg.error) q.set("error", msg.error);
  else q.set("ok", msg.ok ?? "Saved");
  redirect(`/w/${slug}/${page}?${q.toString()}`);
};

/** You may only hand out rights you hold yourself at that scope; only an Owner can make an Owner. */
function mayGrant(access: AccessContext, role: { key: string; permissions: string[]; tenantId: string | null }, target: Target) {
  if (role.key === "owner" && role.tenantId === null) return can(access, "org:transfer_ownership");
  return role.permissions.every((p) => can(access, p as never, target));
}

async function loadRole(tx: Tx, roleId: string) {
  const [r] = await tx.select().from(roles).where(eq(roles.id, roleId));
  if (!r || r.side !== "client") throw new Error("Unknown role");
  return r;
}

async function meta(ctx: WorkspaceCtx) {
  return { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()) };
}

// ------------------------------------------------------------------ team

const inviteSchema = z.object({
  slug: z.string(),
  email: z.email().max(200),
  name: z.string().trim().max(120).optional(),
  roleId: z.uuid(),
  branchId: z.union([z.uuid(), z.literal("")]).optional(),
});

export async function inviteMember(_: FormState, fd: FormData): Promise<FormState> {
  const parsed = inviteSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: "Check the email address and role." };
  const { slug, email, name, roleId } = parsed.data;
  const branchId = parsed.data.branchId || null;
  try {
    const ctx = await workspaceAction(slug, "users:invite", { branchId });
    const link = await withTenant(ctx.org.id, async (tx) => {
      const role = await loadRole(tx, roleId);
      if (!mayGrant(ctx.access, role, { branchId })) throw new Error("You can only invite people with access you have yourself.");
      if (role.defaultScope === "branch" && !branchId) throw new Error(`${role.name} needs a branch.`);
      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .where(eq(user.email, email.toLowerCase()));
      if (existing) throw new Error("That person is already on this team. Change their roles instead.");
      const inv = await createInvitation(tx, { tenantId: ctx.org.id, email, name, roleId, branchId, invitedBy: ctx.user.userId });
      await audit(tx, {
        ...(await meta(ctx)),
        action: "member.invited",
        targetType: "invitation",
        targetId: inv.id,
        summary: `Invited ${email} as ${role.name}`,
        diff: { roleKey: role.key, roleName: role.name, branchId, privileged: privilegedIn(role.permissions) },
      });
      return inv.url;
    });
    revalidatePath(`/w/${slug}/team`);
    return { ok: `Invitation created for ${email}. Send them this link (valid 7 days).`, link };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function revokeInvitation(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const ctx = await workspaceAction(slug, "users:invite");
  await withTenant(ctx.org.id, async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ status: "revoked" })
      .where(and(eq(invitations.id, id), eq(invitations.status, "pending")))
      .returning();
    if (inv) await audit(tx, { ...(await meta(ctx)), action: "member.invite_revoked", targetType: "invitation", targetId: id, summary: `Revoked invitation for ${inv.email}` });
  });
  back(slug, "team", { ok: "Invitation revoked" });
}

export async function addRoleBinding(fd: FormData) {
  const slug = String(fd.get("slug"));
  const membershipId = String(fd.get("membershipId"));
  const roleId = String(fd.get("roleId"));
  const branchId = (fd.get("branchId") as string) || null;
  const ctx = await workspaceAction(slug, "users:assign_roles", { branchId });
  const err = await withTenant(ctx.org.id, async (tx) => {
    const role = await loadRole(tx, roleId);
    if (!mayGrant(ctx.access, role, { branchId })) return "You can only give access you have yourself.";
    if (role.defaultScope === "branch" && !branchId) return `${role.name} needs a branch.`;
    if (membershipId === ctx.membershipId) return "You cannot change your own roles.";
    await tx
      .insert(roleBindings)
      .values({ tenantId: ctx.org.id, membershipId, roleId, scopeType: branchId ? "branch" : "org", branchId, grantedBy: ctx.user.userId })
      .onConflictDoNothing();
    await audit(tx, { ...(await meta(ctx)), action: "member.role_added", targetType: "membership", targetId: membershipId, summary: `Added role ${role.name}`, diff: { roleId, roleKey: role.key, roleName: role.name, branchId, privileged: privilegedIn(role.permissions) } });
    return null;
  });
  back(slug, "team", err ? { error: err } : { ok: "Role added" });
}

export async function removeRoleBinding(fd: FormData) {
  const slug = String(fd.get("slug"));
  const bindingId = String(fd.get("bindingId"));
  const ctx = await workspaceAction(slug, "users:assign_roles");
  const err = await withTenant(ctx.org.id, async (tx) => {
    const [b] = await tx
      .select({ binding: roleBindings, role: roles })
      .from(roleBindings)
      .innerJoin(roles, eq(roles.id, roleBindings.roleId))
      .where(eq(roleBindings.id, bindingId));
    if (!b) return "Role not found.";
    if (b.binding.membershipId === ctx.membershipId) return "You cannot change your own roles.";
    if (!mayGrant(ctx.access, b.role, { branchId: b.binding.branchId })) return "You cannot remove access above your own.";
    if (b.role.key === "owner" && b.role.tenantId === null) {
      const owners = await tx
        .select({ id: roleBindings.id })
        .from(roleBindings)
        .where(and(eq(roleBindings.roleId, b.role.id), ne(roleBindings.id, bindingId)));
      if (owners.length === 0) return "A workspace must always have an Owner.";
    }
    await tx.delete(roleBindings).where(eq(roleBindings.id, bindingId));
    await audit(tx, { ...(await meta(ctx)), action: "member.role_removed", targetType: "membership", targetId: b.binding.membershipId, summary: `Removed role ${b.role.name}` });
    return null;
  });
  back(slug, "team", err ? { error: err } : { ok: "Role removed" });
}

export async function setMemberStatus(fd: FormData) {
  const slug = String(fd.get("slug"));
  const membershipId = String(fd.get("membershipId"));
  const status = fd.get("status") === "suspended" ? "suspended" : "active";
  const ctx = await workspaceAction(slug, "users:assign_roles");
  const err = await withTenant(ctx.org.id, async (tx) => {
    if (membershipId === ctx.membershipId) return "You cannot pause your own access.";
    const ownerRole = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.key, "owner"), eq(roles.side, "client")));
    const isOwner = await tx
      .select({ id: roleBindings.id })
      .from(roleBindings)
      .where(and(eq(roleBindings.membershipId, membershipId), eq(roleBindings.roleId, ownerRole[0]!.id)));
    if (isOwner.length && !can(ctx.access, "org:transfer_ownership")) return "Only an Owner can pause another Owner.";
    const [m] = await tx.update(memberships).set({ status, updatedAt: new Date() }).where(eq(memberships.id, membershipId)).returning();
    if (!m) return "Member not found.";
    await audit(tx, { ...(await meta(ctx)), action: status === "suspended" ? "member.paused" : "member.reactivated", targetType: "membership", targetId: membershipId, summary: `${status === "suspended" ? "Paused" : "Reactivated"} a team member` });
    return null;
  });
  back(slug, "team", err ? { error: err } : { ok: status === "suspended" ? "Access paused" : "Access restored" });
}

// ------------------------------------------------------------------ branches

const branchSchema = z.object({
  slug: z.string(),
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().max(80).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(20).optional(),
});

export async function createBranch(fd: FormData) {
  const parsed = branchSchema.safeParse(Object.fromEntries(fd));
  const slug = String(fd.get("slug"));
  if (!parsed.success) back(slug, "branches", { error: "Give the branch a name of at least 2 characters." });
  const d = parsed.data!;
  const ctx = await workspaceAction(slug, "branches:manage");
  await withTenant(ctx.org.id, async (tx) => {
    const [b] = await tx
      .insert(branches)
      .values({ tenantId: ctx.org.id, name: d.name, city: d.city || null, address: d.address || null, phone: d.phone || null, languages: ctx.org.languages })
      .returning({ id: branches.id });
    await audit(tx, { ...(await meta(ctx)), action: "branch.created", targetType: "branch", targetId: b!.id, summary: `Created branch ${d.name}` });
  });
  back(slug, "branches", { ok: `Branch ${d.name} created` });
}

export async function setBranchStatus(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const status = fd.get("status") === "inactive" ? "inactive" : "active";
  const ctx = await workspaceAction(slug, "branches:manage");
  await withTenant(ctx.org.id, async (tx) => {
    const [b] = await tx.update(branches).set({ status, updatedAt: new Date() }).where(eq(branches.id, id)).returning();
    if (b) await audit(tx, { ...(await meta(ctx)), action: `branch.${status}`, targetType: "branch", targetId: id, summary: `Marked ${b.name} ${status}` });
  });
  back(slug, "branches", { ok: "Branch updated" });
}

// ------------------------------------------------------------------ roles

export async function cloneRole(fd: FormData) {
  const slug = String(fd.get("slug"));
  const fromId = String(fd.get("fromId"));
  const name = String(fd.get("name") ?? "").trim();
  const ctx = await workspaceAction(slug, "roles:manage");
  if (name.length < 2) back(slug, "roles", { error: "Name the new role." });
  const key = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
  const err = await withTenant(ctx.org.id, async (tx) => {
    const src = await loadRole(tx, fromId);
    const [dupe] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, ctx.org.id), eq(roles.key, key)));
    if (dupe) return "A role with that name exists.";
    const perms = src.permissions.filter((p) => p !== "org:transfer_ownership");
    const [r] = await tx
      .insert(roles)
      .values({ tenantId: ctx.org.id, side: "client", key, name, description: `Based on ${src.name}`, permissions: perms, defaultScope: src.defaultScope, isSystem: false })
      .returning({ id: roles.id });
    await audit(tx, { ...(await meta(ctx)), action: "role.created", targetType: "role", targetId: r!.id, summary: `Created role ${name} from ${src.name}` });
    return null;
  });
  back(slug, "roles", err ? { error: err } : { ok: `Role ${name} created. Adjust its permissions below.` });
}

export async function updateRolePermissions(fd: FormData) {
  const slug = String(fd.get("slug"));
  const roleId = String(fd.get("roleId"));
  const ctx = await workspaceAction(slug, "roles:manage");
  const requested = fd.getAll("perm").map(String);
  const valid = requested.filter((p) => (ALL_CLIENT_PERMISSIONS as string[]).includes(p) && p !== "org:transfer_ownership");
  const err = await withTenant(ctx.org.id, async (tx) => {
    const [r] = await tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.tenantId, ctx.org.id)));
    if (!r) return "Only custom roles can be edited. Clone a template first.";
    const beyond = valid.filter((p) => !can(ctx.access, p as never));
    if (beyond.length) return `You cannot add permissions you do not hold: ${beyond.join(", ")}`;
    await tx.update(roles).set({ permissions: valid, updatedAt: new Date() }).where(eq(roles.id, roleId));
    await audit(tx, {
      ...(await meta(ctx)),
      action: "role.updated",
      targetType: "role",
      targetId: roleId,
      summary: `Updated permissions of ${r.name}`,
      diff: { added: valid.filter((p) => !r.permissions.includes(p)), removed: r.permissions.filter((p) => !valid.includes(p)) },
    });
    return null;
  });
  back(slug, "roles", err ? { error: err } : { ok: "Permissions saved" }, { role: roleId });
}

// ------------------------------------------------------------------ organization + support consent

export async function updateOrgProfile(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const s = z
    .object({
      name: z.string().trim().min(2).max(120),
      legalName: z.string().trim().max(160).optional(),
      gstin: z.union([z.literal(""), z.string().trim().regex(/^[0-9]{2}[A-Z0-9]{13}$/i, "GSTIN has 15 characters")]).optional(),
      city: z.string().trim().max(80).optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!s.success) back(slug, "settings", { error: s.error.issues[0]?.message ?? "Check the fields." });
  const d = s.data!;
  await withTenant(ctx.org.id, async (tx) => {
    await tx
      .update(organizations)
      .set({ name: d.name, legalName: d.legalName || null, gstin: d.gstin ? d.gstin.toUpperCase() : null, city: d.city || null, updatedAt: new Date() })
      .where(eq(organizations.id, ctx.org.id));
    await audit(tx, { ...(await meta(ctx)), action: "org.updated", targetType: "organization", targetId: ctx.org.id, summary: "Updated business profile" });
  });
  back(slug, "settings", { ok: "Business profile saved" });
}

export async function setStandingSupport(fd: FormData) {
  const slug = String(fd.get("slug"));
  const days = Number(fd.get("days"));
  const ctx = await workspaceAction(slug, "support_access:grant");
  const until = days > 0 ? new Date(Date.now() + Math.min(days, 30) * 86_400_000) : null;
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(organizations).set({ supportAccessUntil: until, updatedAt: new Date() }).where(eq(organizations.id, ctx.org.id));
    await audit(tx, {
      ...(await meta(ctx)),
      action: until ? "support.standing_allowed" : "support.standing_removed",
      targetType: "organization",
      targetId: ctx.org.id,
      summary: until ? `Allowed read-only JENAI support for ${days} day(s)` : "Removed standing JENAI support access",
    });
  });
  back(slug, "settings", { ok: until ? `JENAI support may view (read-only) for ${days} day(s)` : "Standing support access removed" });
}

export async function decideSupportGrant(fd: FormData) {
  const slug = String(fd.get("slug"));
  const grantId = String(fd.get("grantId"));
  const decision = fd.get("decision") === "approve" ? "approve" : "deny";
  const ctx = await workspaceAction(slug, "support_access:grant");
  const msg = await withTenant(ctx.org.id, async (tx) => {
    const [g] = await tx.select().from(supportGrants).where(and(eq(supportGrants.id, grantId), eq(supportGrants.status, "requested")));
    if (!g) return { error: "That request is no longer pending." };
    const now = new Date();
    if (decision === "deny") {
      await tx.update(supportGrants).set({ status: "denied", decidedBy: ctx.user.userId, decidedAt: now }).where(eq(supportGrants.id, grantId));
    } else {
      // Write access also needs a second approver at Diigoo; it starts when both have approved.
      const ready = g.mode === "read" || !!g.platformApprover;
      await tx
        .update(supportGrants)
        .set({
          decidedBy: ctx.user.userId,
          decidedAt: now,
          ...(ready ? { status: "approved" as const, startsAt: now, expiresAt: new Date(now.getTime() + g.durationMinutes * 60_000) } : {}),
        })
        .where(eq(supportGrants.id, grantId));
    }
    await audit(tx, {
      ...(await meta(ctx)),
      action: decision === "approve" ? "support.approved_by_client" : "support.denied_by_client",
      targetType: "support_grant",
      targetId: grantId,
      summary: `${decision === "approve" ? "Approved" : "Denied"} ${g.mode} support access (${g.durationMinutes} min, ticket ${g.ticket ?? "none"})`,
    });
    return { ok: decision === "approve" ? "Support access approved" : "Support access denied" };
  });
  back(slug, "settings", msg);
}

export async function revokeSupportGrant(fd: FormData) {
  const slug = String(fd.get("slug"));
  const grantId = String(fd.get("grantId"));
  const ctx = await workspaceAction(slug, "support_access:grant");
  await withTenant(ctx.org.id, async (tx) => {
    const [g] = await tx.update(supportGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(supportGrants.id, grantId)).returning();
    if (g) await audit(tx, { ...(await meta(ctx)), action: "support.revoked_by_client", targetType: "support_grant", targetId: grantId, summary: `Ended ${g.mode} support access` });
  });
  back(slug, "settings", { ok: "Support access ended" });
}

/** Used by pages to keep the membership check in one place. */
export async function currentWorkspace(slug: string) {
  return requireWorkspace(slug);
}
