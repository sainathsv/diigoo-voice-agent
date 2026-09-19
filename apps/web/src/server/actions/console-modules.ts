"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit, carrierAccounts, organizations, phoneNumbers, plans, platformDb, subscriptions, withTenant } from "@jenai/db";
import {
  addCarrierAccount,
  addPhoneNumber,
  importAgent,
  importNumbersFromVoice,
  markConnection,
  refreshProvisioning,
  saveVoiceConnection,
  syncTenantCalls,
  voiceClient,
} from "@jenai/engine";
import { requirePlatform } from "../platform/context";
import { requestMeta } from "../session";

const back = (orgId: string, msg: { ok?: string; error?: string }, anchor = ""): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`/console/clients/${orgId}?${q}${anchor}`);
};
const uuid = z.uuid();

async function log(orgId: string, actor: string, action: string, summary: string, diff?: unknown) {
  await withTenant(orgId, async (tx) => audit(tx, { tenantId: orgId, actorUserId: actor, action, targetType: "organization", targetId: orgId, summary, diff, ...(await requestMeta()) }));
}

// ------------------------------------------------------------------ voice engine

export async function saveConnection(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const p = z
    .object({
      baseUrl: z.url().refine((u) => u.startsWith("https://") || u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost"), "Use an https address"),
      externalOrgId: z.union([z.literal(""), z.coerce.number().int().positive()]),
      authKind: z.enum(["api_key", "password"]),
      apiKey: z.string().optional(),
      email: z.string().optional(),
      password: z.string().optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) back(orgId, { error: p.error!.issues[0]?.message ?? "Check the connection details." }, "#voice");
  const d = p.data!;
  const auth = d.authKind === "api_key" ? { kind: "api_key" as const, apiKey: (d.apiKey ?? "").trim() } : { kind: "password" as const, email: (d.email ?? "").trim(), password: d.password ?? "" };
  if ((auth.kind === "api_key" && auth.apiKey.length < 10) || (auth.kind === "password" && (!auth.email || !auth.password))) back(orgId, { error: "Enter the API key, or the email and password." }, "#voice");
  await withTenant(orgId, (tx) => saveVoiceConnection(tx, orgId, { baseUrl: d.baseUrl, externalOrgId: d.externalOrgId === "" ? null : d.externalOrgId, auth, mode: "read_only" }, ctx.user.userId));
  await log(orgId, ctx.user.userId, "voice.connection_saved", `JENAI saved the voice engine connection (${d.authKind === "api_key" ? "API key" : "login"}, read-only)`);
  // Verify immediately so problems show up now, not at the next sync.
  const v = await withTenant(orgId, (tx) => voiceClient(tx, orgId));
  try {
    await v!.client.listWorkflows();
    await withTenant(orgId, (tx) => markConnection(tx, orgId, { status: "ok", lastError: null, lastVerifiedAt: new Date() }));
    back(orgId, { ok: "Connected. Import the client's agents next." }, "#voice");
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    await withTenant(orgId, (tx) => markConnection(tx, orgId, { status: "error", lastError: (e as Error).message.slice(0, 300) }));
    back(orgId, { error: `Saved, but the engine refused the connection: ${(e as Error).message.slice(0, 160)}` }, "#voice");
  }
}

export async function setConnectionMode(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const mode = z.enum(["read_only", "managed"]).parse(fd.get("mode"));
  await withTenant(orgId, (tx) => markConnection(tx, orgId, { mode }));
  await log(orgId, ctx.user.userId, "voice.mode_changed", mode === "managed" ? "JENAI switched this workspace to managed: agent publishing and campaigns now reach live calls" : "JENAI switched this workspace back to read-only");
  back(orgId, { ok: mode === "managed" ? "Managed: publishing now changes live calls." : "Read-only again." }, "#voice");
}

export async function syncNow(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.provision");
  const orgId = uuid.parse(fd.get("orgId"));
  const s = await syncTenantCalls(orgId, { maxPerWorkflow: Number(fd.get("max") ?? 50) || 50 });
  await log(orgId, ctx.user.userId, "voice.synced", `Synced calls: ${s.inserted} new, ${s.updated} updated, ${s.leadsTouched} leads`, s);
  back(orgId, s.errors.length && !s.inserted && !s.updated ? { error: `Sync failed: ${s.errors[0]}` } : { ok: `Synced ${s.runsSeen} calls from ${s.workflows} workflows: ${s.inserted} new, ${s.updated} updated, ${s.leadsTouched} leads${s.errors.length ? `, ${s.errors.length} errors` : ""}.` }, "#voice");
}

export async function importAgentAction(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.provision");
  const orgId = uuid.parse(fd.get("orgId"));
  const p = z
    .object({
      name: z.string().trim().min(2),
      branchId: z.union([z.uuid(), z.literal("")]),
      purpose: z.enum(["receptionist", "outbound_sales", "reminders", "grievance", "other"]),
      domain: z.string().trim().min(2).max(40),
      inboundWorkflowId: z.union([z.literal(""), z.coerce.number().int().positive()]),
      outboundWorkflowId: z.union([z.literal(""), z.coerce.number().int().positive()]),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) back(orgId, { error: p.error!.issues[0]?.message ?? "Check the agent details." }, "#voice");
  const d = p.data!;
  if (d.inboundWorkflowId === "" && d.outboundWorkflowId === "") back(orgId, { error: "Choose at least one workflow." }, "#voice");
  try {
    const r = await importAgent(orgId, { name: d.name, branchId: d.branchId || null, purpose: d.purpose, domain: d.domain, inboundWorkflowId: d.inboundWorkflowId || null, outboundWorkflowId: d.outboundWorkflowId || null }, ctx.user.userId);
    await log(orgId, ctx.user.userId, "agent.imported", `Imported live agent "${d.name}" as version 1 (${r.recognised ? "built from the shared template" : "hand-written prompt"})`);
    back(orgId, { ok: `Imported "${d.name}" without changing it.${r.recognised ? "" : " Its prompt is hand-written; rebuild it on the shared template before publishing."}` }, "#voice");
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back(orgId, { error: (e as Error).message }, "#voice");
  }
}

export async function importNumbersAction(fd: FormData) {
  const ctx = await requirePlatform("platform:telephony.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  try {
    const r = await importNumbersFromVoice(orgId);
    await log(orgId, ctx.user.userId, "telephony.imported", `Imported ${r.imported} number(s) from the voice engine`, r);
    back(orgId, { ok: `Imported ${r.imported} number(s).${r.skipped.length ? ` Skipped: ${r.skipped.join("; ")}` : ""}` }, "#telephony");
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
    back(orgId, { error: (e as Error).message }, "#telephony");
  }
}

// ------------------------------------------------------------------ telephony

export async function addCarrierAccountAction(fd: FormData) {
  const ctx = await requirePlatform("platform:telephony.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const p = z
    .object({
      provider: z.enum(["vobiz", "exotel", "plivo", "tata", "other"]),
      mode: z.enum(["managed_subaccount", "client_account", "forwarding"]),
      displayName: z.string().trim().min(2).max(80),
      externalAccountId: z.string().trim().max(80).optional(),
      credential: z.string().max(400).optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) back(orgId, { error: "Check the carrier account details." }, "#telephony");
  const d = p.data!;
  await withTenant(orgId, async (tx) => {
    await addCarrierAccount(tx, orgId, { provider: d.provider, mode: d.mode, displayName: d.displayName, externalAccountId: d.externalAccountId || null, credential: d.credential || null }, ctx.user.userId);
    await refreshProvisioning(tx, orgId);
  });
  await log(orgId, ctx.user.userId, "telephony.account_added", `Added ${d.provider} carrier account "${d.displayName}" (${d.mode.replace(/_/g, " ")})`);
  back(orgId, { ok: "Carrier account added" }, "#telephony");
}

export async function setKyc(fd: FormData) {
  const ctx = await requirePlatform("platform:telephony.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const id = uuid.parse(fd.get("accountId"));
  const status = z.enum(["not_started", "link_sent", "submitted", "verified", "rejected"]).parse(fd.get("kyc"));
  const ref = String(fd.get("ref") ?? "").trim().slice(0, 80) || null;
  await withTenant(orgId, async (tx) => {
    await tx.update(carrierAccounts).set({ kycStatus: status, kycReference: ref, updatedAt: new Date() }).where(eq(carrierAccounts.id, id));
    await refreshProvisioning(tx, orgId);
  });
  await log(orgId, ctx.user.userId, "telephony.kyc", `Carrier KYC set to ${status.replace("_", " ")}${ref ? ` (${ref})` : ""}`);
  back(orgId, { ok: "KYC status updated" }, "#telephony");
}

export async function addNumberAction(fd: FormData) {
  const ctx = await requirePlatform("platform:telephony.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const p = z
    .object({
      carrierAccountId: z.uuid(),
      e164: z.string().min(6),
      series: z.enum(["landline", "mobile", "series_140", "series_1600", "toll_free"]),
      purpose: z.enum(["inbound", "outbound_service", "outbound_promotional", "both"]),
      branchId: z.union([z.uuid(), z.literal("")]),
      label: z.string().max(60).optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) back(orgId, { error: "Check the number details." }, "#telephony");
  const d = p.data!;
  try {
    await withTenant(orgId, async (tx) => {
      await addPhoneNumber(tx, orgId, { ...d, branchId: d.branchId || null, label: d.label || null });
      await refreshProvisioning(tx, orgId);
    });
  } catch (e) {
    back(orgId, { error: (e as Error).message }, "#telephony");
  }
  await log(orgId, ctx.user.userId, "telephony.number_added", `Added number ${d.e164} (${d.series.replace("_", " ")}, ${d.purpose.replace("_", " ")})`);
  back(orgId, { ok: "Number added" }, "#telephony");
}

/** Records that the caller ID was declared to the operator for automated/AI calls (TRAI, 18 Sep 2026). */
export async function declareA2p(fd: FormData) {
  const ctx = await requirePlatform("platform:telephony.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const id = uuid.parse(fd.get("numberId"));
  const ref = String(fd.get("ref") ?? "").trim().slice(0, 80);
  if (ref.length < 3) back(orgId, { error: "Enter the declaration reference from the carrier or operator." }, "#telephony");
  const num = await withTenant(orgId, async (tx) => {
    const [n] = await tx.update(phoneNumbers).set({ a2pDeclaredAt: new Date(), a2pReference: ref, updatedAt: new Date() }).where(eq(phoneNumbers.id, id)).returning();
    await refreshProvisioning(tx, orgId);
    return n;
  });
  await log(orgId, ctx.user.userId, "telephony.a2p_declared", `Caller ID ${num?.e164} declared for AI calls (reference ${ref})`);
  back(orgId, { ok: "Declaration recorded" }, "#telephony");
}

// ------------------------------------------------------------------ plans and billing terms

export async function saveSubscription(fd: FormData) {
  const ctx = await requirePlatform("platform:clients.manage");
  const orgId = uuid.parse(fd.get("orgId"));
  const rupeesToPaise = (v: unknown) => (v === "" || v == null ? null : Math.round(Number(v) * 100));
  const p = z
    .object({
      planKey: z.string().min(2),
      billingModel: z.enum(["prepaid", "postpaid_invoice", "contract"]),
      billingDay: z.coerce.number().int().min(1).max(28),
      contractFee: z.string().optional(),
      contractRate: z.string().optional(),
      committedMinutes: z.string().optional(),
      poNumber: z.string().max(80).optional(),
      poValidUntil: z.string().optional(),
      invoiceToName: z.string().max(160).optional(),
      invoiceToDepartment: z.string().max(120).optional(),
      invoiceToAddress: z.string().max(400).optional(),
      invoiceToGstin: z.union([z.literal(""), z.string().regex(/^[0-9]{2}[A-Z0-9]{13}$/i, "GSTIN has 15 characters")]).optional(),
      invoiceEmail: z.union([z.literal(""), z.email()]).optional(),
      paymentTermsDays: z.coerce.number().int().min(0).max(180),
      notes: z.string().max(500).optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) back(orgId, { error: p.error!.issues[0]?.message ?? "Check the billing terms." }, "#plan");
  const d = p.data!;
  const [plan] = await platformDb().select().from(plans).where(eq(plans.key, d.planKey));
  if (!plan) back(orgId, { error: "Unknown plan" }, "#plan");
  const row = {
    tenantId: orgId,
    planKey: d.planKey,
    billingModel: d.billingModel,
    billingDay: d.billingDay,
    contractFeePaise: rupeesToPaise(d.contractFee),
    contractRatePaisePerMin: rupeesToPaise(d.contractRate),
    committedMinutes: d.committedMinutes ? Number(d.committedMinutes) : null,
    poNumber: d.poNumber || null,
    poValidUntil: d.poValidUntil || null,
    invoiceToName: d.invoiceToName || null,
    invoiceToDepartment: d.invoiceToDepartment || null,
    invoiceToAddress: d.invoiceToAddress || null,
    invoiceToGstin: d.invoiceToGstin ? d.invoiceToGstin.toUpperCase() : null,
    invoiceEmail: d.invoiceEmail || null,
    paymentTermsDays: d.paymentTermsDays,
    notes: d.notes || null,
    updatedBy: ctx.user.userId,
    updatedAt: new Date(),
  };
  await withTenant(orgId, (tx) =>
    tx
      .insert(subscriptions)
      .values({ ...row, startsOn: new Date().toISOString().slice(0, 10), extraFeatures: [] })
      .onConflictDoUpdate({ target: subscriptions.tenantId, set: row }),
  );
  await platformDb().update(organizations).set({ plan: d.planKey, updatedAt: new Date() }).where(eq(organizations.id, orgId));
  await log(orgId, ctx.user.userId, "billing.terms_saved", `Plan set to ${plan!.name}, billed ${d.billingModel.replace("_", " ")}${d.poNumber ? `, PO ${d.poNumber}` : ""}`);
  back(orgId, { ok: "Plan and billing terms saved" }, "#plan");
}

export async function updatePlanAction(fd: FormData) {
  const ctx = await requirePlatform("platform:billing.manage");
  const key = String(fd.get("key"));
  const p = z
    .object({
      name: z.string().trim().min(2).max(60),
      monthlyFee: z.coerce.number().min(0),
      includedMinutes: z.coerce.number().int().min(0),
      overage: z.union([z.literal(""), z.coerce.number().min(0)]),
      limits: z.string(),
      features: z.string(),
      active: z.string().optional(),
    })
    .safeParse(Object.fromEntries(fd));
  const go = (m: { ok?: string; error?: string }): never => redirect(`/console/plans?${new URLSearchParams(m.error ? { error: m.error } : { ok: m.ok! })}`);
  if (!p.success) go({ error: "Check the plan fields." });
  const d = p.data!;
  let limits: Record<string, number>;
  try {
    limits = JSON.parse(d.limits || "{}");
    if (typeof limits !== "object" || Array.isArray(limits)) throw new Error();
  } catch {
    return go({ error: "Limits must be JSON, for example {\"branches\": 3}." });
  }
  await platformDb()
    .update(plans)
    .set({
      name: d.name,
      monthlyFeePaise: Math.round(d.monthlyFee * 100),
      includedMinutes: d.includedMinutes,
      overagePaisePerMin: d.overage === "" ? null : Math.round(Number(d.overage) * 100),
      limits,
      features: d.features.split(",").map((f) => f.trim()).filter(Boolean),
      active: d.active === "on",
      updatedAt: new Date(),
    })
    .where(eq(plans.key, key));
  await audit(platformDb(), { tenantId: null, actorUserId: ctx.user.userId, action: "plan.updated", targetType: "plan", targetId: key, summary: `Updated plan ${d.name}`, diff: d });
  go({ ok: `Plan ${d.name} saved` });
}

