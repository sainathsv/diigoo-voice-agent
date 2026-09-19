/**
 * Typed mirror of the SQL migrations in ../migrations. The SQL files are the
 * source of truth (they carry row-level security); keep this file in step.
 */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------- auth (Better Auth)
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  phone: text("phone"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- tenancy
export const orgKind = pgEnum("org_kind", ["platform", "partner", "client"]);
export const orgStatus = pgEnum("org_status", ["onboarding", "active", "suspended", "closed"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: orgKind("kind").notNull(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: orgStatus("status").notNull().default("onboarding"),
  vertical: text("vertical"),
  plan: text("plan").notNull().default("trial"),
  legalName: text("legal_name"),
  gstin: text("gstin"),
  city: text("city"),
  state: text("state"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  languages: text("languages").array().notNull(),
  supportAccessUntil: ts("support_access_until"),
  suspendedReason: text("suspended_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const branches = pgTable(
  "branches",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    name: text("name").notNull(),
    code: text("code"),
    city: text("city"),
    address: text("address"),
    phone: text("phone"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    languages: text("languages").array().notNull(),
    hours: jsonb("hours").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const teams = pgTable(
  "teams",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    name: text("name").notNull(),
    kind: text("kind"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const membershipStatus = pgEnum("membership_status", ["invited", "active", "suspended"]);

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    userId: text("user_id").notNull(),
    status: membershipStatus("status").notNull().default("active"),
    title: text("title"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const teamMembers = pgTable(
  "team_members",
  {
    tenantId: uuid("tenant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.teamId, t.membershipId] })],
);

export const roleSide = pgEnum("role_side", ["platform", "client"]);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  side: roleSide("side").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  permissions: text("permissions").array().notNull(),
  defaultScope: text("default_scope").notNull().default("org"),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const scopeType = pgEnum("scope_type", ["org", "branch"]);

export const roleBindings = pgTable(
  "role_bindings",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    scopeType: scopeType("scope_type").notNull().default("org"),
    branchId: uuid("branch_id"),
    grantedBy: text("granted_by"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked", "expired"]);

export const invitations = pgTable(
  "invitations",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    roleId: uuid("role_id").notNull(),
    scopeType: scopeType("scope_type").notNull().default("org"),
    branchId: uuid("branch_id"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by"),
    status: invitationStatus("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    branchId: uuid("branch_id"),
    createdBy: text("created_by"),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const stepStatus = pgEnum("step_status", ["pending", "in_progress", "passed", "failed", "skipped"]);

export const provisioningSteps = pgTable(
  "provisioning_steps",
  {
    tenantId: uuid("tenant_id").notNull(),
    step: text("step").notNull(),
    status: stepStatus("status").notNull().default("pending"),
    detail: text("detail"),
    updatedBy: text("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.step] })],
);

export const supportMode = pgEnum("support_mode", ["read", "write", "breakglass"]);
export const grantStatus = pgEnum("grant_status", ["requested", "approved", "denied", "revoked", "expired"]);

export const supportGrants = pgTable(
  "support_grants",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    staffUserId: text("staff_user_id").notNull(),
    mode: supportMode("mode").notNull(),
    reason: text("reason").notNull(),
    ticket: text("ticket"),
    status: grantStatus("status").notNull().default("requested"),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    requestedAt: ts("requested_at").notNull().defaultNow(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    platformApprover: text("platform_approver"),
    startsAt: ts("starts_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const auditVia = pgEnum("audit_via", ["user", "support", "api", "system"]);

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id"),
  actorUserId: text("actor_user_id"),
  impersonatorUserId: text("impersonator_user_id"),
  via: auditVia("via").notNull().default("user"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  summary: text("summary").notNull(),
  diff: jsonb("diff"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const outbox = pgTable("outbox", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id"),
  aggregate: text("aggregate").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  publishedAt: ts("published_at"),
});

export type Organization = typeof organizations.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type SupportGrant = typeof supportGrants.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
