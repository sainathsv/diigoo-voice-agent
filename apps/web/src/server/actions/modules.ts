"use server";

import { redirect } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "@jenai/authz";
import { agentVersions, agents, audit, campaignTargets, campaigns, consents, contacts, leads, phoneNumbers, suppressions, withTenant } from "@jenai/db";
import { LimitError, PublishBlocked, assertFeature, createVersion, entitlements, publishVersion, requestSafetyCheck } from "@jenai/engine";
import { lintVersion, toE164 } from "@jenai/voice";
import { actorFields, requireWorkspace, workspaceAction } from "../access";
import { requestMeta } from "../session";

const go = (slug: string, path: string, msg: { ok?: string; error?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`/w/${slug}/${path}${path.includes("?") ? "&" : "?"}${q}`);
};

async function meta(ctx: Awaited<ReturnType<typeof requireWorkspace>>) {
  return { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()) };
}

// ------------------------------------------------------------------ leads

const STAGES = ["new", "contacted", "callback", "booked", "won", "lost"] as const;

export async function updateLead(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const back = String(fd.get("back") ?? "leads");
  const ctx = await requireWorkspace(slug);
  const [lead] = await withTenant(ctx.org.id, (tx) => tx.select().from(leads).where(eq(leads.id, id)));
  if (!lead) go(slug, back, { error: "Lead not found" });
  if (!can(ctx.access, "contacts:edit", { branchId: lead!.branchId })) go(slug, back, { error: "Your role cannot update leads here." });
  const stage = z.enum(STAGES).optional().parse(fd.get("stage") || undefined);
  const follow = String(fd.get("followUp") ?? "");
  const owner = String(fd.get("owner") ?? "");
  const lostReason = String(fd.get("lostReason") ?? "").trim().slice(0, 200) || null;
  if (stage === "lost" && !lostReason) go(slug, back, { error: "Say why the lead was lost." });
  await withTenant(ctx.org.id, async (tx) => {
    await tx
      .update(leads)
      .set({
        ...(stage ? { stage } : {}),
        ...(follow ? { nextFollowUpAt: new Date(`${follow}T10:00:00+05:30`) } : {}),
        ...(owner ? { ownerMembershipId: owner === "none" ? null : owner } : {}),
        ...(stage === "lost" ? { lostReason } : {}),
        updatedAt: new Date(),
      })
      .where(eq(leads.id, id));
    await audit(tx, { ...(await meta(ctx)), action: "lead.updated", targetType: "lead", targetId: id, summary: `Lead updated${stage ? `: stage ${stage}` : ""}${follow ? `, follow-up ${follow}` : ""}` });
  });
  go(slug, back, { ok: "Lead updated" });
}

// ------------------------------------------------------------------ do-not-call

export async function setDoNotCall(fd: FormData) {
  const slug = String(fd.get("slug"));
  const phone = toE164(String(fd.get("phone") ?? ""));
  const back = String(fd.get("back") ?? "calls");
  const on = fd.get("on") === "1";
  const ctx = await workspaceAction(slug, "contacts:edit");
  if (!phone) go(slug, back, { error: "Invalid phone number" });
  await withTenant(ctx.org.id, async (tx) => {
    if (on) await tx.insert(suppressions).values({ tenantId: ctx.org.id, phoneE164: phone!, reason: "opt_out", scope: null, source: "marked by staff", createdBy: ctx.user.userId }).onConflictDoNothing();
    else await tx.delete(suppressions).where(and(eq(suppressions.tenantId, ctx.org.id), eq(suppressions.phoneE164, phone!), eq(suppressions.reason, "opt_out")));
    await audit(tx, { ...(await meta(ctx)), action: on ? "contact.do_not_call" : "contact.call_allowed", targetType: "phone", targetId: phone!.slice(0, 5) + "…" + phone!.slice(-4), summary: on ? "Marked a number do-not-call" : "Removed a number from do-not-call" });
  });
  go(slug, back, { ok: on ? "This number will not be called by any campaign" : "Number removed from do-not-call" });
}

// ------------------------------------------------------------------ agents

export async function saveAgentDraft(fd: FormData) {
  const slug = String(fd.get("slug"));
  const agentId = String(fd.get("agentId"));
  const ctx = await requireWorkspace(slug);
  const [agent] = await withTenant(ctx.org.id, (tx) => tx.select().from(agents).where(eq(agents.id, agentId)));
  if (!agent) go(slug, "agents", { error: "Agent not found" });
  const scope = { branchId: agent!.branchId };
  if (!can(ctx.access, "agents:edit", scope) && !can(ctx.access, "knowledge:edit", scope)) go(slug, `agents/${agentId}`, { error: "Your role cannot edit this agent." });
  const input = {
    greeting: String(fd.get("greeting") ?? ""),
    facts: String(fd.get("facts") ?? ""),
    outboundOpening: String(fd.get("outboundOpening") ?? "") || null,
    changeNote: String(fd.get("changeNote") ?? "") || null,
  };
  const v = await withTenant(ctx.org.id, async (tx) => {
    const created = await createVersion(tx, ctx.org.id, agentId, input, ctx.user.userId);
    await audit(tx, { ...(await meta(ctx)), action: "agent.version_drafted", targetType: "agent_version", targetId: created.id, summary: `Drafted version ${created.number} of ${agent!.name}${input.changeNote ? `: ${input.changeNote}` : ""}` });
    return created;
  });
  const errs = lintVersion(v).filter((i) => i.level === "error");
  go(slug, `agents/${agentId}?v=${v.id}`, errs.length ? { error: `Draft saved, but it cannot be published yet: ${errs.map((e) => e.message).join(" ")}` } : { ok: `Draft version ${v.number} saved` });
}

export async function submitForApproval(fd: FormData) {
  const slug = String(fd.get("slug"));
  const versionId = String(fd.get("versionId"));
  const ctx = await requireWorkspace(slug);
  const r = await withTenant(ctx.org.id, async (tx) => {
    const [v] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId));
    if (!v || v.state !== "draft") return { error: "Only drafts can be submitted." };
    const [agent] = await tx.select().from(agents).where(eq(agents.id, v.agentId));
    if (!can(ctx.access, "agents:edit", { branchId: agent!.branchId })) return { error: "Your role cannot submit agent changes." };
    const errs = lintVersion(v).filter((i) => i.level === "error");
    if (errs.length) return { error: errs.map((e) => e.message).join(" ") };
    await tx.update(agentVersions).set({ state: "pending_approval" }).where(eq(agentVersions.id, versionId));
    // Start the AI safety check now, so it is usually done before the approver looks.
    await requestSafetyCheck(tx, { tenantId: ctx.org.id, versionId, reason: "publish", requestedBy: ctx.user.userId });
    await audit(tx, { ...(await meta(ctx)), action: "agent.submitted", targetType: "agent_version", targetId: versionId, summary: `Submitted version ${v.number} of ${agent!.name} for approval` });
    return { ok: "Sent for approval. The AI safety check has started.", agentId: v.agentId };
  });
  go(slug, `agents/${"agentId" in r ? r.agentId : ""}`, r);
}

/** Attack this version with the AI red-team suite (the same check publishing waits for). */
export async function runSafetyCheckNow(fd: FormData) {
  const slug = String(fd.get("slug"));
  const versionId = String(fd.get("versionId"));
  const ctx = await requireWorkspace(slug);
  const r = await withTenant(ctx.org.id, async (tx) => {
    const [v] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId));
    if (!v) return { error: "Version not found." };
    const [agent] = await tx.select().from(agents).where(eq(agents.id, v.agentId));
    if (!can(ctx.access, "agents:edit", { branchId: agent!.branchId }) && !can(ctx.access, "agents:publish", { branchId: agent!.branchId })) return { error: "Your role cannot run safety checks." };
    const c = await requestSafetyCheck(tx, { tenantId: ctx.org.id, versionId, reason: "manual", requestedBy: ctx.user.userId });
    await audit(tx, { ...(await meta(ctx)), action: "agent.safety_check_requested", targetType: "agent_version", targetId: versionId, summary: `Asked for an AI safety check of version ${v.number} of ${agent!.name}` });
    return { ok: c.status === "passed" ? "These exact prompts already passed the safety check." : "Safety check started. It takes about 2 minutes; refresh to see the result.", agentId: v.agentId };
  });
  go(slug, `agents/${"agentId" in r ? `${r.agentId}?v=${versionId}` : ""}`, r);
}

/** Approve (maker-checker) and publish to inbound and outbound together. */
export async function approveAndPublish(fd: FormData) {
  const slug = String(fd.get("slug"));
  const versionId = String(fd.get("versionId"));
  const ctx = await requireWorkspace(slug);
  const pre = await withTenant(ctx.org.id, async (tx) => {
    const [v] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId));
    const [agent] = v ? await tx.select().from(agents).where(eq(agents.id, v.agentId)) : [];
    return { v, agent };
  });
  if (!pre.v || !pre.agent) go(slug, "agents", { error: "Version not found" });
  const scope = { branchId: pre.agent!.branchId };
  if (!can(ctx.access, "agents:publish", scope)) go(slug, `agents/${pre.agent!.id}`, { error: "Your role cannot publish agents." });
  const selfMade = pre.v!.createdBy === ctx.user.userId;
  if (selfMade && !can(ctx.access, "org:transfer_ownership")) go(slug, `agents/${pre.agent!.id}`, { error: "Someone else must approve a change you made (maker-checker). Owners may publish their own changes." });
  try {
    await withTenant(ctx.org.id, (tx) => tx.update(agentVersions).set({ approvedBy: ctx.user.userId }).where(eq(agentVersions.id, versionId)));
    const { version, result } = await publishVersion(ctx.org.id, versionId, ctx.user.userId);
    await withTenant(ctx.org.id, async (tx) =>
      audit(tx, {
        ...(await meta(ctx)),
        action: result.ok ? "agent.published" : "agent.publish_failed",
        targetType: "agent_version",
        targetId: versionId,
        summary: result.ok
          ? `Published version ${version.number} of ${pre.agent!.name} to inbound and outbound calls`
          : `Publishing version ${version.number} failed: ${result.results.map((r) => `${r.direction} ${r.ok ? "ok" : r.error}${r.rolledBack ? " (rolled back)" : ""}`).join("; ")}`,
        diff: result,
      }),
    );
    go(slug, `agents/${pre.agent!.id}`, result.ok ? { ok: `Version ${version.number} is live on inbound and outbound calls` } : { error: "Publishing failed and nothing changed for callers. See the version details." });
  } catch (e) {
    if (e instanceof PublishBlocked) go(slug, `agents/${pre.agent!.id}`, { error: e.message });
    throw e;
  }
}

// ------------------------------------------------------------------ campaigns

const campaignSchema = z.object({
  slug: z.string(),
  name: z.string().trim().min(3).max(80),
  agentId: z.uuid(),
  callerNumberId: z.uuid(),
  branchId: z.union([z.uuid(), z.literal("")]),
  purpose: z.enum(["service", "transactional", "promotional"]),
  callPurposeText: z.string().trim().max(120).optional(),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  maxAttempts: z.coerce.number().int().min(1).max(5),
  maxConcurrency: z.coerce.number().int().min(1).max(50),
  dailyCap: z.coerce.number().int().min(1).max(3),
});

export async function createCampaign(fd: FormData) {
  const p = campaignSchema.safeParse(Object.fromEntries(fd));
  const slug = String(fd.get("slug"));
  if (!p.success) go(slug, "campaigns/new", { error: p.error!.issues[0]?.message ?? "Check the form." });
  const d = p.data!;
  const branchId = d.branchId || null;
  const ctx = await workspaceAction(slug, "campaigns:create", { branchId });
  const days = fd.getAll("days").map(Number).filter((n) => n >= 0 && n <= 6);
  if (!days.length) go(slug, "campaigns/new", { error: "Pick at least one calling day." });
  if (d.start >= d.end) go(slug, "campaigns/new", { error: "The calling window must end after it starts." });
  let id = "";
  try {
    id = await withTenant(ctx.org.id, async (tx) => {
      assertFeature(await entitlements(tx, ctx.org.id), "outbound_campaigns");
      const [num] = await tx.select().from(phoneNumbers).where(eq(phoneNumbers.id, d.callerNumberId));
      if (!num) throw new Error("Choose a caller number.");
      if (d.purpose === "promotional" && num.series !== "series_140") throw new Error("Promotional campaigns need a 140-series caller number.");
      const [c] = await tx
        .insert(campaigns)
        .values({
          tenantId: ctx.org.id,
          branchId,
          agentId: d.agentId,
          callerNumberId: d.callerNumberId,
          name: d.name,
          purpose: d.purpose,
          callPurposeText: d.callPurposeText || null,
          windows: { days, start: d.start, end: d.end },
          maxAttempts: d.maxAttempts,
          maxConcurrency: d.maxConcurrency,
          dailyCapPerContact: d.dailyCap,
          createdBy: ctx.user.userId,
        })
        .returning({ id: campaigns.id });
      await audit(tx, { ...(await meta(ctx)), action: "campaign.created", targetType: "campaign", targetId: c!.id, summary: `Created ${d.purpose} campaign "${d.name}"` });
      return c!.id;
    });
  } catch (e) {
    go(slug, "campaigns/new", { error: e instanceof LimitError ? e.message : (e as Error).message });
  }
  go(slug, `campaigns/${id}`, { ok: "Campaign created. Add the people to call next." });
}

/**
 * Add people to call. Lines are "phone, name". The uploader attests consent;
 * that attestation is stored per number as evidence (TRAI and DPDP).
 */
export async function addTargets(fd: FormData) {
  const slug = String(fd.get("slug"));
  const campaignId = String(fd.get("campaignId"));
  const attest = fd.get("attest") === "on";
  const ctx = await requireWorkspace(slug);
  const [c] = await withTenant(ctx.org.id, (tx) => tx.select().from(campaigns).where(eq(campaigns.id, campaignId)));
  if (!c) go(slug, "campaigns", { error: "Campaign not found" });
  if (!can(ctx.access, "campaigns:create", { branchId: c!.branchId }) || !can(ctx.access, "contacts:import", { branchId: c!.branchId })) go(slug, `campaigns/${campaignId}`, { error: "Your role cannot add people to campaigns." });
  if (!["draft", "pending_approval", "approved", "paused"].includes(c!.status)) go(slug, `campaigns/${campaignId}`, { error: "People can only be added before launch or while paused." });
  if (!attest) go(slug, `campaigns/${campaignId}`, { error: "Confirm that these people agreed to be called for this purpose." });
  const lines = String(fd.get("lines") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5000);
  const good: Array<{ phone: string; name: string | null }> = [];
  let bad = 0;
  for (const l of lines) {
    const [rawPhone, ...rest] = l.split(/[,\t;]/);
    const phone = toE164(rawPhone ?? "");
    if (!phone) {
      bad++;
      continue;
    }
    good.push({ phone, name: rest.join(" ").trim() || null });
  }
  const added = await withTenant(ctx.org.id, async (tx) => {
    let n = 0;
    for (const g of good) {
      const [ct] = await tx
        .insert(contacts)
        .values({ tenantId: ctx.org.id, phoneE164: g.phone, name: g.name, branchId: c!.branchId, source: "import", tags: [] })
        .onConflictDoUpdate({ target: [contacts.tenantId, contacts.phoneE164], set: { name: sql`coalesce(${contacts.name}, excluded.name)` } })
        .returning({ id: contacts.id });
      const ins = await tx
        .insert(campaignTargets)
        .values({ tenantId: ctx.org.id, campaignId, contactId: ct!.id, phoneE164: g.phone, name: g.name })
        .onConflictDoNothing()
        .returning({ id: campaignTargets.id });
      if (ins.length) {
        n++;
        await tx.insert(consents).values({
          tenantId: ctx.org.id,
          phoneE164: g.phone,
          contactId: ct!.id,
          purpose: c!.purpose,
          source: "import_attested",
          evidence: `Attested by ${ctx.user.name} when adding to campaign "${c!.name}"`,
          createdBy: ctx.user.userId,
          // Enquiry-style consent is short-lived; attested consent for promotional calls lapses after 180 days here.
          expiresAt: c!.purpose === "promotional" ? new Date(Date.now() + 180 * 86_400_000) : null,
        });
      }
    }
    await tx.update(campaigns).set({ consentAttested: true, updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
    await audit(tx, { ...(await meta(ctx)), action: "campaign.targets_added", targetType: "campaign", targetId: campaignId, summary: `Added ${n} people to "${c!.name}" with consent attestation${bad ? ` (${bad} lines skipped: not a valid number)` : ""}` });
    return n;
  });
  go(slug, `campaigns/${campaignId}`, { ok: `Added ${added} people${bad ? `; ${bad} lines skipped (not a valid number)` : ""}${good.length - added ? `; ${good.length - added} already in this campaign` : ""}.` });
}

export async function campaignTransition(fd: FormData) {
  const slug = String(fd.get("slug"));
  const campaignId = String(fd.get("campaignId"));
  const to = z.enum(["pending_approval", "approved", "running", "paused", "cancelled"]).parse(fd.get("to"));
  const ctx = await requireWorkspace(slug);
  const r = await withTenant(ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).for("update");
    if (!c) return { error: "Campaign not found" };
    const scope = { branchId: c.branchId };
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(campaignTargets).where(eq(campaignTargets.campaignId, campaignId));
    const allowed: Record<string, string[]> = {
      pending_approval: ["draft"],
      approved: ["pending_approval"],
      running: ["approved", "paused"],
      paused: ["running"],
      cancelled: ["draft", "pending_approval", "approved", "paused"],
    };
    if (!allowed[to]!.includes(c.status)) return { error: `A ${c.status.replace("_", " ")} campaign cannot move to ${to.replace("_", " ")}.` };
    if (to === "pending_approval") {
      if (!can(ctx.access, "campaigns:create", scope)) return { error: "Your role cannot submit campaigns." };
      if (!n) return { error: "Add people to call first." };
    }
    if (to === "approved") {
      if (!can(ctx.access, "campaigns:approve", scope)) return { error: "Your role cannot approve campaigns." };
      if (c.createdBy === ctx.user.userId) return { error: "Someone other than the creator must approve (maker-checker)." };
      const [num] = await tx.select().from(phoneNumbers).where(eq(phoneNumbers.id, c.callerNumberId));
      if (!num?.a2pDeclaredAt) return { error: "The caller number is not declared for AI calls yet (TRAI, 18 Sep 2026). Ask JENAI to file the declaration." };
    }
    if ((to === "running" || to === "paused") && !can(ctx.access, "campaigns:launch", scope)) return { error: "Your role cannot launch or pause campaigns." };
    if (to === "cancelled" && !can(ctx.access, "campaigns:create", scope)) return { error: "Your role cannot cancel campaigns." };
    await tx
      .update(campaigns)
      .set({
        status: to,
        ...(to === "approved" ? { approvedBy: ctx.user.userId, approvedAt: new Date() } : {}),
        ...(to === "running" && !c.launchedAt ? { launchedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
    if (to === "cancelled") await tx.update(campaignTargets).set({ state: "cancelled" }).where(and(eq(campaignTargets.campaignId, campaignId), inArray(campaignTargets.state, ["queued", "scheduled"])));
    await audit(tx, { ...(await meta(ctx)), action: `campaign.${to}`, targetType: "campaign", targetId: campaignId, summary: `Campaign "${c.name}" ${to.replace("_", " ")}` });
    return { ok: `Campaign ${to.replace("_", " ")}` };
  });
  go(slug, `campaigns/${campaignId}`, r);
}
