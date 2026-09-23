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
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
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

/** Two-step sign-in secrets (Better Auth two-factor plugin, migration 0010). */
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull(),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: ts("locked_until"),
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
  calendarToken: text("calendar_token"),
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
    allowedIps: text("allowed_ips").array().notNull().default([]),
    lastUsedIp: text("last_used_ip"),
    callsMade: integer("calls_made").notNull().default(0),
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
  // Filled by the audit_events_link trigger (hash chain per workspace, migration 0009).
  chain: text("chain"),
  chainSeq: bigint("chain_seq", { mode: "number" }),
  prevHash: text("prev_hash"),
  hash: text("hash"),
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

// ---------------------------------------------------------------- plans (0002)
export const billingModel = pgEnum("billing_model", ["prepaid", "postpaid_invoice", "contract"]);

export const plans = pgTable("plans", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  billingModel: billingModel("billing_model").notNull(),
  monthlyFeePaise: bigint("monthly_fee_paise", { mode: "number" }).notNull().default(0),
  feeBasis: text("fee_basis").notNull().default("per_workspace"),
  includedMinutes: integer("included_minutes").notNull().default(0),
  overagePaisePerMin: bigint("overage_paise_per_min", { mode: "number" }),
  limits: jsonb("limits").$type<PlanLimits>().notNull().default({}),
  features: text("features").array().notNull(),
  isPublic: boolean("is_public").notNull().default(true),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(100),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface PlanLimits {
  branches?: number;
  phone_numbers?: number;
  concurrent_calls?: number;
  agents?: number;
  users?: number;
  campaigns_per_month?: number;
}

export const subscriptions = pgTable("subscriptions", {
  tenantId: uuid("tenant_id").primaryKey(),
  planKey: text("plan_key").notNull(),
  billingModel: billingModel("billing_model").notNull(),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on"),
  billingDay: integer("billing_day").notNull().default(1),
  contractFeePaise: bigint("contract_fee_paise", { mode: "number" }),
  contractRatePaisePerMin: bigint("contract_rate_paise_per_min", { mode: "number" }),
  committedMinutes: integer("committed_minutes"),
  limitOverrides: jsonb("limit_overrides").$type<PlanLimits>().notNull().default({}),
  extraFeatures: text("extra_features").array().notNull(),
  poNumber: text("po_number"),
  poValidUntil: text("po_valid_until"),
  invoiceToName: text("invoice_to_name"),
  invoiceToDepartment: text("invoice_to_department"),
  invoiceToAddress: text("invoice_to_address"),
  invoiceToGstin: text("invoice_to_gstin"),
  invoiceEmail: text("invoice_email"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  notes: text("notes"),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------- voice + agents (0003)
export const agentTemplates = pgTable(
  "agent_templates",
  {
    key: text("key").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    basePrompt: text("base_prompt").notNull(),
    endPrompt: text("end_prompt").notNull(),
    extraction: jsonb("extraction").$type<ExtractionVar[]>().notNull(),
    extractionPrompt: text("extraction_prompt").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);
export interface ExtractionVar {
  name: string;
  type: string;
  prompt: string;
}

export const voiceMode = pgEnum("voice_mode", ["read_only", "managed"]);

export const voiceConnections = pgTable("voice_connections", {
  tenantId: uuid("tenant_id").primaryKey(),
  provider: text("provider").notNull().default("dograh"),
  baseUrl: text("base_url").notNull(),
  externalOrgId: integer("external_org_id"),
  mediaBaseUrl: text("media_base_url"),
  authKind: text("auth_kind").notNull(),
  credentialCiphertext: text("credential_ciphertext").notNull(),
  mode: voiceMode("mode").notNull().default("read_only"),
  status: text("status").notNull().default("unverified"),
  lastError: text("last_error"),
  lastVerifiedAt: ts("last_verified_at"),
  lastSyncAt: ts("last_sync_at"),
  createdBy: text("created_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agentPurpose = pgEnum("agent_purpose", ["receptionist", "outbound_sales", "reminders", "grievance", "other"]);

export const agents = pgTable(
  "agents",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    name: text("name").notNull(),
    purpose: agentPurpose("purpose").notNull().default("receptionist"),
    templateKey: text("template_key").notNull(),
    templateVersion: integer("template_version").notNull(),
    domain: text("domain").notNull().default("clinic"),
    inboundWorkflowId: integer("inbound_workflow_id"),
    outboundWorkflowId: integer("outbound_workflow_id"),
    outboundWorkflowUuid: text("outbound_workflow_uuid"),
    liveVersionId: uuid("live_version_id"),
    clientProgramId: uuid("client_program_id"),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const versionState = pgEnum("version_state", ["draft", "pending_approval", "publishing", "live", "superseded", "failed", "imported"]);

export const agentVersions = pgTable(
  "agent_versions",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    number: integer("number").notNull(),
    state: versionState("state").notNull().default("draft"),
    personaName: text("persona_name"),
    greeting: text("greeting").notNull(),
    facts: text("facts").notNull(),
    outboundOpening: text("outbound_opening"),
    inboundPrompt: text("inbound_prompt"),
    outboundPrompt: text("outbound_prompt"),
    promptHash: text("prompt_hash"),
    changeNote: text("change_note"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    approvedBy: text("approved_by"),
    publishedBy: text("published_by"),
    publishedAt: ts("published_at"),
    publishResult: jsonb("publish_result"),
    guardrailsVersion: integer("guardrails_version"),
    taskPrompt: text("task_prompt"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

// ---------------------------------------------------------------- calls, contacts, leads (0004)
export const contacts = pgTable(
  "contacts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    phoneE164: text("phone_e164").notNull(),
    name: text("name"),
    email: text("email"),
    source: text("source").notNull().default("call"),
    tags: text("tags").array().notNull(),
    attrs: jsonb("attrs").$type<Record<string, unknown>>().notNull().default({}),
    ownerMembershipId: uuid("owner_membership_id"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastCallAt: ts("last_call_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const callDirection = pgEnum("call_direction", ["inbound", "outbound"]);
export const callStatus = pgEnum("call_status", ["queued", "ringing", "in_progress", "completed", "no_answer", "busy", "failed", "unknown"]);

export const calls = pgTable(
  "calls",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    agentId: uuid("agent_id"),
    agentVersionId: uuid("agent_version_id"),
    contactId: uuid("contact_id"),
    campaignId: uuid("campaign_id"),
    targetId: uuid("target_id"),
    direction: callDirection("direction").notNull(),
    status: callStatus("status").notNull().default("unknown"),
    provider: text("provider").notNull().default("dograh"),
    externalRunId: text("external_run_id").notNull(),
    externalWorkflowId: integer("external_workflow_id"),
    fromE164: text("from_e164"),
    toE164: text("to_e164"),
    startedAt: ts("started_at").notNull(),
    durationS: integer("duration_s"),
    disposition: text("disposition"),
    summary: text("summary"),
    transcript: text("transcript"),
    extracted: jsonb("extracted").$type<Record<string, unknown>>().notNull().default({}),
    recordingRef: text("recording_ref"),
    transcriptRef: text("transcript_ref"),
    costPaise: bigint("cost_paise", { mode: "number" }),
    syncedAt: ts("synced_at").notNull().defaultNow(),
    analyzedAt: ts("analyzed_at"),
    analysisModel: text("analysis_model"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const leadStage = pgEnum("lead_stage", ["new", "contacted", "callback", "booked", "won", "lost"]);

export const leads = pgTable(
  "leads",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    contactId: uuid("contact_id").notNull(),
    branchId: uuid("branch_id"),
    source: text("source").notNull().default("call"),
    firstCallId: uuid("first_call_id"),
    lastCallId: uuid("last_call_id"),
    stage: leadStage("stage").notNull().default("new"),
    interest: text("interest"),
    preferredTimeText: text("preferred_time_text"),
    preferredAt: ts("preferred_at"),
    temperature: text("temperature"),
    ownerMembershipId: uuid("owner_membership_id"),
    nextFollowUpAt: ts("next_follow_up_at"),
    lostReason: text("lost_reason"),
    notes: text("notes"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

// ---------------------------------------------------------------- telephony (0005)
export const carrierMode = pgEnum("carrier_mode", ["managed_subaccount", "client_account", "forwarding"]);
export const kycStatus = pgEnum("kyc_status", ["not_started", "link_sent", "submitted", "verified", "rejected"]);

export const carrierAccounts = pgTable(
  "carrier_accounts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    provider: text("provider").notNull(),
    mode: carrierMode("mode").notNull(),
    displayName: text("display_name").notNull(),
    externalAccountId: text("external_account_id"),
    credentialCiphertext: text("credential_ciphertext"),
    kycStatus: kycStatus("kyc_status").notNull().default("not_started"),
    kycReference: text("kyc_reference"),
    voiceConfigId: integer("voice_config_id"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const numberSeries = pgEnum("number_series", ["landline", "mobile", "series_140", "series_1600", "toll_free"]);
export const numberPurpose = pgEnum("number_purpose", ["inbound", "outbound_service", "outbound_promotional", "both"]);

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    carrierAccountId: uuid("carrier_account_id").notNull(),
    branchId: uuid("branch_id"),
    e164: text("e164").notNull(),
    label: text("label"),
    series: numberSeries("series").notNull(),
    purpose: numberPurpose("purpose").notNull().default("inbound"),
    inboundAgentId: uuid("inbound_agent_id"),
    isDefaultCallerId: boolean("is_default_caller_id").notNull().default(false),
    a2pDeclaredAt: ts("a2p_declared_at"),
    a2pReference: text("a2p_reference"),
    dltHeader: text("dlt_header"),
    maxConcurrency: integer("max_concurrency").notNull().default(10),
    voiceNumberId: integer("voice_number_id"),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

// ---------------------------------------------------------------- dialer (0006)
export const consentPurpose = pgEnum("consent_purpose", ["service", "transactional", "promotional"]);
export const consentStatus = pgEnum("consent_status", ["granted", "revoked"]);

export const consents = pgTable(
  "consents",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    contactId: uuid("contact_id"),
    purpose: consentPurpose("purpose").notNull(),
    channel: text("channel").notNull().default("voice"),
    status: consentStatus("status").notNull().default("granted"),
    source: text("source").notNull(),
    evidence: text("evidence"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    createdBy: text("created_by"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const suppressionReason = pgEnum("suppression_reason", ["opt_out", "dnd_registry", "complaint", "legal", "wrong_number"]);

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  phoneE164: text("phone_e164").notNull(),
  reason: suppressionReason("reason").notNull(),
  scope: consentPurpose("scope"),
  source: text("source"),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
});

export const campaignStatus = pgEnum("campaign_status", ["draft", "pending_approval", "approved", "running", "paused", "completed", "cancelled"]);

export interface CallingWindows {
  days: number[]; // 0 = Sunday
  start: string; // "HH:MM" local
  end: string;
}

export const campaigns = pgTable(
  "campaigns",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    agentId: uuid("agent_id").notNull(),
    callerNumberId: uuid("caller_number_id").notNull(),
    name: text("name").notNull(),
    purpose: consentPurpose("purpose").notNull(),
    status: campaignStatus("status").notNull().default("draft"),
    callPurposeText: text("call_purpose_text"),
    clientProgramId: uuid("client_program_id"),
    onDemand: boolean("on_demand").notNull().default(false),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    windows: jsonb("windows").$type<CallingWindows>().notNull(),
    maxConcurrency: integer("max_concurrency").notNull().default(2),
    maxAttempts: integer("max_attempts").notNull().default(3),
    dailyCapPerContact: integer("daily_cap_per_contact").notNull().default(2),
    consentAttested: boolean("consent_attested").notNull().default(false),
    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    launchedAt: ts("launched_at"),
    completedAt: ts("completed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const targetState = pgEnum("target_state", ["queued", "scheduled", "dialing", "completed", "skipped", "failed", "cancelled"]);

export const campaignTargets = pgTable(
  "campaign_targets",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    campaignId: uuid("campaign_id").notNull(),
    contactId: uuid("contact_id"),
    phoneE164: text("phone_e164").notNull(),
    name: text("name"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    state: targetState("state").notNull().default("queued"),
    attemptNo: integer("attempt_no").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastOutcome: text("last_outcome"),
    lastCallId: uuid("last_call_id"),
    skipReason: text("skip_reason"),
    externalRunId: text("external_run_id"),
    leaseUntil: ts("lease_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const dialAttempts = pgTable(
  "dial_attempts",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: bigint("id", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    targetId: uuid("target_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    phoneE164: text("phone_e164").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    gateway: text("gateway"),
    externalRunId: text("external_run_id"),
    outcome: text("outcome"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type AgentTemplate = typeof agentTemplates.$inferSelect;
export type VoiceConnection = typeof voiceConnections.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type CarrierAccount = typeof carrierAccounts.$inferSelect;
export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignTarget = typeof campaignTargets.$inferSelect;

// ---------------------------------------------------------------------------
// Security (migration 0009)
// ---------------------------------------------------------------------------
export const securityEventKind = pgEnum("security_event_kind", [
  "signin_ok", "signin_failed", "signin_locked", "signout",
  "access_denied", "session_revoked", "password_changed",
  "mfa_enabled", "mfa_disabled", "mfa_failed",
]);
export type SecurityEventKind = (typeof securityEventKind.enumValues)[number];

export const securityEvents = pgTable("security_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  kind: securityEventKind("kind").notNull(),
  email: text("email"),
  userId: text("user_id"),
  tenantId: uuid("tenant_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  detail: jsonb("detail"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const alertSeverity = pgEnum("alert_severity", ["low", "medium", "high", "critical"]);
export const alertStatus = pgEnum("alert_status", ["open", "acknowledged", "resolved", "false_positive"]);
export type AlertSeverity = (typeof alertSeverity.enumValues)[number];
export type AlertStatus = (typeof alertStatus.enumValues)[number];

export const securityAlerts = pgTable("security_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  rule: text("rule").notNull(),
  severity: alertSeverity("severity").notNull(),
  title: text("title").notNull(),
  subject: text("subject").notNull(),
  detail: jsonb("detail").notNull().default({}),
  dedupeKey: text("dedupe_key").notNull(),
  status: alertStatus("status").notNull().default("open"),
  hits: integer("hits").notNull().default(1),
  firstSeen: ts("first_seen").notNull().defaultNow(),
  lastSeen: ts("last_seen").notNull().defaultNow(),
  notifiedAt: ts("notified_at"),
  handledBy: text("handled_by"),
  handledAt: ts("handled_at"),
  note: text("note"),
});
export type SecurityAlert = typeof securityAlerts.$inferSelect;

export const securityDetectorState = pgTable("security_detector_state", {
  name: text("name").primaryKey(),
  lastId: bigint("last_id", { mode: "number" }).notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface ProgramVariable {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "money";
  required: boolean;
  example?: string;
}
export interface ProgramField {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  example?: string;
}
export interface ProgramOutcome {
  key: string;
  label: string;
  stage?: "new" | "contacted" | "callback" | "booked" | "won" | "lost";
}
export interface ProgramDefaults {
  windows?: { days: number[]; start: string; end: string };
  maxAttempts?: number;
  dailyCapPerContact?: number;
  maxConcurrency?: number;
}
export interface ProgramRequirements {
  callerIdSeries?: "series_140" | "normal" | "any";
  consent?: "explicit" | "existing_relationship" | "statutory";
  records?: string[];
}
export interface ProgramRedteamCase {
  id: string;
  severity: "critical" | "high" | "medium";
  risk: string;
  turns: string[];
  rubric: string;
}

// ---------------------------------------------------------------------------
// AI safety checks (migration 0011)
// ---------------------------------------------------------------------------
export const safetyStatus = pgEnum("safety_status", ["queued", "running", "passed", "failed", "needs_review", "error"]);
export const safetyReason = pgEnum("safety_reason", ["publish", "manual", "sweep"]);
export type SafetyStatus = (typeof safetyStatus.enumValues)[number];

export const agentSafetyChecks = pgTable(
  "agent_safety_checks",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    versionId: uuid("version_id").notNull(),
    promptHash: text("prompt_hash").notNull(),
    suiteVersion: integer("suite_version").notNull(),
    guardrailsVersion: integer("guardrails_version"),
    vertical: text("vertical").notNull().default("general"),
    targetModel: text("target_model").notNull(),
    judgeModel: text("judge_model").notNull(),
    reason: safetyReason("reason").notNull(),
    status: safetyStatus("status").notNull().default("queued"),
    held: integer("held").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    review: integer("review").notNull().default(0),
    criticalFailed: integer("critical_failed").notNull().default(0),
    results: jsonb("results").notNull().default([]),
    error: text("error"),
    cachedFrom: uuid("cached_from"),
    requestedBy: text("requested_by"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    attempts: integer("attempts").notNull().default(0),
    extraCases: jsonb("extra_cases").$type<ProgramRedteamCase[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type AgentSafetyCheck = typeof agentSafetyChecks.$inferSelect;

// ---------------------------------------------------------------------------
// Call programs (migration 0013)
// ---------------------------------------------------------------------------
export const programTemplates = pgTable(
  "program_templates",
  {
    key: text("key").notNull(),
    version: integer("version").notNull(),
    vertical: text("vertical").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    direction: text("direction").notNull().default("outbound"),
    purpose: consentPurpose("purpose").notNull(),
    goal: text("goal").notNull(),
    taskPrompt: text("task_prompt").notNull(),
    opening: text("opening").notNull(),
    variables: jsonb("variables").$type<ProgramVariable[]>().notNull().default([]),
    clientFields: jsonb("client_fields").$type<ProgramField[]>().notNull().default([]),
    extraction: jsonb("extraction").$type<Array<{ name: string; type: string; prompt: string }>>().notNull().default([]),
    outcomes: jsonb("outcomes").$type<ProgramOutcome[]>().notNull().default([]),
    defaults: jsonb("defaults").$type<ProgramDefaults>().notNull().default({}),
    requirements: jsonb("requirements").$type<ProgramRequirements>().notNull().default({}),
    complianceNote: text("compliance_note").notNull().default(""),
    redteamCases: jsonb("redteam_cases").$type<ProgramRedteamCase[]>().notNull().default([]),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);
export type ProgramTemplate = typeof programTemplates.$inferSelect;

export const clientPrograms = pgTable(
  "client_programs",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    programKey: text("program_key").notNull(),
    programVersion: integer("program_version").notNull(),
    name: text("name").notNull(),
    agentId: uuid("agent_id"),
    callerNumberId: uuid("caller_number_id"),
    values: jsonb("values").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type ClientProgram = typeof clientPrograms.$inferSelect;

// ---------------------------------------------------------------------------
// Integrations (migration 0014): the client's own system stays the record of truth
// ---------------------------------------------------------------------------
export const integrationKind = pgEnum("integration_kind", ["webhook_out", "rest_generic", "zoho_crm", "salesforce", "hubspot", "leadsquared", "sap_odata", "google_sheets"]);
export const integrationStatus = pgEnum("integration_status", ["draft", "connected", "error", "paused"]);
export type IntegrationKind = (typeof integrationKind.enumValues)[number];

export const integrations = pgTable(
  "integrations",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    kind: integrationKind("kind").notNull(),
    name: text("name").notNull(),
    status: integrationStatus("status").notNull().default("draft"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    mapping: jsonb("mapping").$type<Record<string, Record<string, string>>>().notNull().default({}),
    events: text("events").array().notNull().default([]),
    credentials: text("credentials"),
    direction: text("direction").notNull().default("both"),
    lastOkAt: ts("last_ok_at"),
    lastError: text("last_error"),
    lastErrorAt: ts("last_error_at"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type Integration = typeof integrations.$inferSelect;

export const integrationEvents = pgTable(
  "integration_events",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    integrationId: uuid("integration_id"),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    externalId: text("external_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    httpStatus: integer("http_status"),
    response: text("response"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type IntegrationEvent = typeof integrationEvents.$inferSelect;

export const externalLinks = pgTable(
  "external_links",
  {
    tenantId: uuid("tenant_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    ourType: text("our_type").notNull(),
    ourId: uuid("our_id").notNull(),
    externalType: text("external_type").notNull(),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.integrationId, t.ourType, t.ourId] })],
);

// ---------------------------------------------------------------------------
// Calendar (migration 0015)
// ---------------------------------------------------------------------------
export const resourceKind = pgEnum("resource_kind", ["doctor", "staff", "room", "equipment"]);
export const appointmentKind = pgEnum("appointment_kind", ["visit", "follow_up", "procedure", "call_back", "block", "other"]);
export const appointmentStatus = pgEnum("appointment_status", ["booked", "confirmed", "arrived", "completed", "cancelled", "no_show"]);
export type AppointmentKind = (typeof appointmentKind.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatus.enumValues)[number];

export interface WorkingHours {
  days?: number[];
  start?: string;
  end?: string;
}

export const resources = pgTable(
  "resources",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    name: text("name").notNull(),
    kind: resourceKind("kind").notNull().default("doctor"),
    title: text("title"),
    colour: text("colour").notNull().default("#C96A3C"),
    workingHours: jsonb("working_hours").$type<WorkingHours>().notNull().default({}),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type Resource = typeof resources.$inferSelect;

export const appointments = pgTable(
  "appointments",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    branchId: uuid("branch_id"),
    resourceId: uuid("resource_id"),
    contactId: uuid("contact_id"),
    callId: uuid("call_id"),
    clientProgramId: uuid("client_program_id"),
    title: text("title").notNull(),
    kind: appointmentKind("kind").notNull().default("visit"),
    status: appointmentStatus("status").notNull().default("booked"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    personName: text("person_name"),
    phoneE164: text("phone_e164"),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    externalId: text("external_id"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    cancelledReason: text("cancelled_reason"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);
export type Appointment = typeof appointments.$inferSelect;

// ---------------------------------------------------- client-hosted data (0016)
/**
 * Clients who keep their own records on their own Postgres. Platform-level on
 * purpose: this is the map to everyone else's databases, so it never moves.
 */
export const tenantDatabases = pgTable("tenant_databases", {
  tenantId: uuid("tenant_id").primaryKey(),
  label: text("label").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(5432),
  database: text("database").notNull(),
  username: text("username").notNull(),
  /** Sealed with sealSecret(tenantId, "tenant_db"). Never logged. */
  secret: text("secret").notNull(),
  sslmode: text("sslmode").notNull().default("verify-full"),
  caCertificate: text("ca_certificate"),
  status: text("status").notNull().default("pending"),
  schemaVersion: integer("schema_version").notNull().default(0),
  lastOkAt: ts("last_ok_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
