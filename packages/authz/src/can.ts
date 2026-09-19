import type { Permission } from "./permissions";

export type Scope = { type: "org" } | { type: "branch"; branchId: string };

export interface Grant {
  roleKey: string;
  permissions: readonly string[];
  scope: Scope;
  expiresAt?: Date | null;
}

export interface SupportSession {
  staffUserId: string;
  grantId: string;
  mode: "read" | "write";
  expiresAt: Date;
}

export interface AccessContext {
  userId: string;
  orgId: string;
  orgKind: "platform" | "partner" | "client";
  grants: readonly Grant[];
  /** Present when a Diigoo staff member is inside a client workspace under a support grant. */
  support?: SupportSession | null;
  now?: Date;
}

export interface Target {
  /** Branch the resource belongs to. Omit or null for organization-wide resources. */
  branchId?: string | null;
}

/** What a read-only support session may do. Recordings, raw transcripts and full numbers stay locked. */
const SUPPORT_READ: ReadonlySet<string> = new Set([
  "calls:view",
  "contacts:view",
  "campaigns:view",
  "agents:view",
  "numbers:view",
  "users:view",
  "reports:view",
  "audit:view",
  "billing:view",
]);

/** What a write support session may never do, even with client consent (Blueprint Part 3). */
const SUPPORT_NEVER: ReadonlySet<string> = new Set([
  "billing:manage",
  "apikeys:manage",
  "numbers:manage",
  "contacts:export",
  "reports:export",
  "contacts:reveal_phone",
  "transcripts:view_raw",
  "users:assign_roles",
  "roles:manage",
  "support_access:grant",
  "org:transfer_ownership",
]);

function live(g: Grant, now: Date): boolean {
  return !g.expiresAt || g.expiresAt.getTime() > now.getTime();
}

function grantCovers(g: Grant, perm: string, target: Target | undefined): boolean {
  if (!g.permissions.includes(perm)) return false;
  if (g.scope.type === "org") return true;
  // Branch-scoped grants only apply to resources of that branch.
  return !!target?.branchId && target.branchId === g.scope.branchId;
}

/**
 * Single authorization decision point. A person's rights are the union of
 * their live grants (role + scope). A support session replaces the user's own
 * grants with the support policy.
 */
export function can(ctx: AccessContext, perm: Permission, target?: Target): boolean {
  const now = ctx.now ?? new Date();
  if (ctx.support) {
    if (ctx.support.expiresAt.getTime() <= now.getTime()) return false;
    if (perm.startsWith("platform:")) return false;
    if (ctx.support.mode === "read") return SUPPORT_READ.has(perm);
    return !SUPPORT_NEVER.has(perm);
  }
  return ctx.grants.some((g) => live(g, now) && grantCovers(g, perm, target));
}

/**
 * For list queries: which branches may this person see for `perm`?
 * Returns "all" when any live org-scoped grant carries it, otherwise the branch ids.
 */
export function branchesFor(ctx: AccessContext, perm: Permission): "all" | string[] {
  const now = ctx.now ?? new Date();
  if (ctx.support) return can(ctx, perm) ? "all" : [];
  const ids = new Set<string>();
  for (const g of ctx.grants) {
    if (!live(g, now) || !g.permissions.includes(perm)) continue;
    if (g.scope.type === "org") return "all";
    ids.add(g.scope.branchId);
  }
  return [...ids];
}

/** Every permission the context holds anywhere (any scope). Used to render navigation. */
export function permissionSet(ctx: AccessContext): Set<string> {
  const now = ctx.now ?? new Date();
  const out = new Set<string>();
  for (const g of ctx.grants) if (live(g, now)) g.permissions.forEach((p) => out.add(p));
  return out;
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(ctx: AccessContext, perm: Permission, target?: Target): void {
  if (!can(ctx, perm, target)) throw new ForbiddenError(perm);
}
