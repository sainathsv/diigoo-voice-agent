import "server-only";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { branchesFor, type AccessContext, type Permission } from "@jenai/authz";
import {
  agentVersions,
  agents,
  branches,
  calls,
  campaignTargets,
  campaigns,
  carrierAccounts,
  contacts,
  dialAttempts,
  leads,
  memberships,
  phoneNumbers,
  suppressions,
  user,
  withTenant,
} from "@jenai/db";
import { billingPeriod, entitlements, statement, usage } from "@jenai/engine";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_STATUS = new Set(["queued", "ringing", "in_progress", "completed", "no_answer", "busy", "failed", "unknown"]);
const LEAD_STAGE = new Set(["new", "contacted", "callback", "booked", "won", "lost"]);

/** SQL filter limiting rows to the branches a person may see for `perm` ("all" means no filter). */
function branchScope(access: AccessContext, perm: Permission, col: typeof calls.branchId | typeof leads.branchId | typeof campaigns.branchId): SQL | undefined | "none" {
  const b = branchesFor(access, perm);
  if (b === "all") return undefined;
  if (!b.length) return "none";
  return inArray(col, b);
}

export async function loadCalls(tenantId: string, access: AccessContext, f: { direction?: string; status?: string; branch?: string; page?: number }) {
  const scope = branchScope(access, "calls:view", calls.branchId);
  if (scope === "none") return { rows: [], total: 0, branches: [] };
  const conds: SQL[] = [];
  if (scope) conds.push(scope);
  if (f.direction === "inbound" || f.direction === "outbound") conds.push(eq(calls.direction, f.direction));
  // Filters come from the URL: accept only known values (hostile input must not reach the database as an enum).
  if (f.status && CALL_STATUS.has(f.status)) conds.push(eq(calls.status, f.status as never));
  if (f.branch && UUID.test(f.branch)) conds.push(eq(calls.branchId, f.branch));
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(f.page) || 1)));
  return withTenant(tenantId, async (tx) => {
    const where = conds.length ? and(...conds) : undefined;
    const rows = await tx
      .select({ c: calls, contactName: contacts.name, contactPhone: contacts.phoneE164, agentName: agents.name, branchName: branches.name })
      .from(calls)
      .leftJoin(contacts, eq(contacts.id, calls.contactId))
      .leftJoin(agents, eq(agents.id, calls.agentId))
      .leftJoin(branches, eq(branches.id, calls.branchId))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(50)
      .offset((page - 1) * 50);
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(calls).where(where);
    const bs = await tx.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name);
    return { rows, total: n, branches: bs };
  });
}

export async function loadCall(tenantId: string, id: string) {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ c: calls, contact: contacts, agentName: agents.name, branchName: branches.name })
      .from(calls)
      .leftJoin(contacts, eq(contacts.id, calls.contactId))
      .leftJoin(agents, eq(agents.id, calls.agentId))
      .leftJoin(branches, eq(branches.id, calls.branchId))
      .where(eq(calls.id, id));
    if (!row) return null;
    const [lead] = row.c.contactId ? await tx.select().from(leads).where(eq(leads.contactId, row.c.contactId)).orderBy(desc(leads.createdAt)).limit(1) : [];
    const blocked = row.contact ? await tx.select().from(suppressions).where(eq(suppressions.phoneE164, row.contact.phoneE164)) : [];
    return { ...row, lead: lead ?? null, blocked };
  });
}

export async function loadLeads(tenantId: string, access: AccessContext, f: { stage?: string; mine?: string; membershipId: string | null }) {
  const scope = branchScope(access, "contacts:view", leads.branchId);
  if (scope === "none") return { rows: [], counts: {} as Record<string, number>, team: [] };
  const conds: SQL[] = [];
  if (scope) conds.push(scope);
  if (f.stage && LEAD_STAGE.has(f.stage)) conds.push(eq(leads.stage, f.stage as never));
  if (f.mine && f.membershipId) conds.push(eq(leads.ownerMembershipId, f.membershipId));
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ l: leads, name: contacts.name, phone: contacts.phoneE164, branchName: branches.name, ownerName: user.name })
      .from(leads)
      .innerJoin(contacts, eq(contacts.id, leads.contactId))
      .leftJoin(branches, eq(branches.id, leads.branchId))
      .leftJoin(memberships, eq(memberships.id, leads.ownerMembershipId))
      .leftJoin(user, eq(user.id, memberships.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(leads.updatedAt))
      .limit(200);
    const counts = await tx
      .select({ stage: leads.stage, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(scope ? scope : undefined)
      .groupBy(leads.stage);
    const team = await tx
      .select({ id: memberships.id, name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.status, "active"))
      .orderBy(user.name);
    return { rows, counts: Object.fromEntries(counts.map((c) => [c.stage, c.n])) as Record<string, number>, team };
  });
}

export async function loadAgents(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const list = await tx
      .select({ a: agents, branchName: branches.name })
      .from(agents)
      .leftJoin(branches, eq(branches.id, agents.branchId))
      .orderBy(agents.name);
    const versions = list.length ? await tx.select().from(agentVersions).where(inArray(agentVersions.agentId, list.map((x) => x.a.id))).orderBy(desc(agentVersions.number)) : [];
    return list.map((x) => ({ ...x, versions: versions.filter((v) => v.agentId === x.a.id) }));
  });
}

export async function loadAgent(tenantId: string, id: string) {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ a: agents, branchName: branches.name }).from(agents).leftJoin(branches, eq(branches.id, agents.branchId)).where(eq(agents.id, id));
    if (!row) return null;
    const versions = await tx
      .select({ v: agentVersions, createdByName: user.name })
      .from(agentVersions)
      .leftJoin(user, eq(user.id, agentVersions.createdBy))
      .where(eq(agentVersions.agentId, id))
      .orderBy(desc(agentVersions.number));
    return { ...row, versions };
  });
}

export async function loadNumbers(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const nums = await tx
      .select({ n: phoneNumbers, branchName: branches.name, agentName: agents.name, accountName: carrierAccounts.displayName })
      .from(phoneNumbers)
      .leftJoin(branches, eq(branches.id, phoneNumbers.branchId))
      .leftJoin(agents, eq(agents.id, phoneNumbers.inboundAgentId))
      .leftJoin(carrierAccounts, eq(carrierAccounts.id, phoneNumbers.carrierAccountId))
      .orderBy(phoneNumbers.e164);
    const accounts = await tx.select().from(carrierAccounts).orderBy(carrierAccounts.createdAt);
    return { nums, accounts };
  });
}

export async function loadCampaigns(tenantId: string, access: AccessContext) {
  const scope = branchScope(access, "campaigns:view", campaigns.branchId);
  if (scope === "none") return [];
  return withTenant(tenantId, async (tx) => {
    const list = await tx
      .select({ c: campaigns, agentName: agents.name, number: phoneNumbers.e164, branchName: branches.name })
      .from(campaigns)
      .leftJoin(agents, eq(agents.id, campaigns.agentId))
      .leftJoin(phoneNumbers, eq(phoneNumbers.id, campaigns.callerNumberId))
      .leftJoin(branches, eq(branches.id, campaigns.branchId))
      .where(scope ? scope : undefined)
      .orderBy(desc(campaigns.createdAt));
    const stats = list.length
      ? await tx
          .select({ id: campaignTargets.campaignId, state: campaignTargets.state, n: sql<number>`count(*)::int` })
          .from(campaignTargets)
          .where(inArray(campaignTargets.campaignId, list.map((x) => x.c.id)))
          .groupBy(campaignTargets.campaignId, campaignTargets.state)
      : [];
    return list.map((x) => ({ ...x, stats: Object.fromEntries(stats.filter((s) => s.id === x.c.id).map((s) => [s.state, s.n])) as Record<string, number> }));
  });
}

export async function loadCampaign(tenantId: string, id: string) {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ c: campaigns, agentName: agents.name, number: phoneNumbers, branchName: branches.name })
      .from(campaigns)
      .leftJoin(agents, eq(agents.id, campaigns.agentId))
      .leftJoin(phoneNumbers, eq(phoneNumbers.id, campaigns.callerNumberId))
      .leftJoin(branches, eq(branches.id, campaigns.branchId))
      .where(eq(campaigns.id, id));
    if (!row) return null;
    const targets = await tx.select().from(campaignTargets).where(eq(campaignTargets.campaignId, id)).orderBy(desc(campaignTargets.updatedAt)).limit(300);
    const log = await tx.select().from(dialAttempts).where(eq(dialAttempts.campaignId, id)).orderBy(desc(dialAttempts.createdAt)).limit(50);
    const names = await tx
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(or(eq(user.id, row.c.createdBy ?? ""), eq(user.id, row.c.approvedBy ?? "")));
    return { ...row, targets, log, people: Object.fromEntries(names.map((n) => [n.id, n.name])) as Record<string, string> };
  });
}

export async function loadCampaignForm(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const ags = await tx.select().from(agents).where(eq(agents.status, "active")).orderBy(agents.name);
    const nums = await tx.select().from(phoneNumbers).where(and(eq(phoneNumbers.status, "active"), or(eq(phoneNumbers.purpose, "both"), eq(phoneNumbers.purpose, "outbound_service"), eq(phoneNumbers.purpose, "outbound_promotional"))));
    const bs = await tx.select().from(branches).where(eq(branches.status, "active")).orderBy(branches.name);
    const ent = await entitlements(tx, tenantId);
    return { agents: ags, numbers: nums, branches: bs, campaignsAllowed: ent.features.has("outbound_campaigns"), planName: ent.plan.name };
  });
}

export async function loadPlanUsage(tenantId: string, at = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const ent = await entitlements(tx, tenantId);
    const period = billingPeriod(at, ent.subscription?.billingDay ?? 1);
    const u = await usage(tx, tenantId, period.from, period.to);
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(branches).where(eq(branches.status, "active"));
    const counts = {
      branches: n,
      phone_numbers: (await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(eq(phoneNumbers.status, "active"))).length,
      agents: (await tx.select({ id: agents.id }).from(agents).where(eq(agents.status, "active"))).length,
      users: (await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.status, "active"))).length,
    };
    return { ent, period, statement: statement(ent, u, period, n), counts };
  });
}

export { isNull };
