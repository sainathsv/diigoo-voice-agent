import { and, desc, eq, sql } from "drizzle-orm";
import {
  agents,
  campaignTargets,
  campaigns,
  clientPrograms,
  contacts,
  externalLinks,
  integrationEvents,
  phoneNumbers,
  programTemplates,
  withTenant,
  type Tx,
} from "@jenai/db";
import { toE164 } from "@jenai/voice";
import { decide, type Purpose } from "../dialer/policy";
import { policyFacts } from "../dialer/tick";
import { campaignFromProgram, missingVariables, programTemplateOf } from "../programs";

/**
 * Calls asked for by the client's own system: a button in their CRM, a
 * workflow rule, a nightly job of theirs. Their system decides who to call;
 * JENAI still applies the same rules as any other call (do-not-call, consent,
 * caller ID, calling hours), so their button cannot dial someone it should not.
 */

export class CallRequestError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_program" | "bad_phone" | "missing_fields" | "not_ready",
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CallRequestError";
  }
}

export interface CallRequest {
  programKey?: string;
  clientProgramId?: string;
  phone: string;
  name?: string | null;
  /** Per-person data the program needs: amount due, last visit, licence number. */
  context?: Record<string, unknown>;
  /** Their record id, so the result lands back on the same record. */
  externalId?: string | null;
  branchId?: string | null;
  idempotencyKey?: string;
  integrationId?: string | null;
  source?: string;
}

export interface CallRequestResult {
  status: "queued" | "duplicate";
  targetId: string;
  campaignId: string;
  program: { key: string; name: string };
  /** What would happen if we dialled right now: their CRM can show it at once. */
  preview: { action: "dial" | "defer" | "skip"; reason: string; nextAttemptAt?: string };
}

/** The standing campaign that receives calls asked for one at a time. */
async function onDemandCampaign(tx: Tx, tenantId: string, clientProgramId: string, branchId: string | null) {
  const [existing] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.clientProgramId, clientProgramId), eq(campaigns.onDemand, true)))
    .orderBy(desc(campaigns.createdAt))
    .limit(1);
  if (existing) return existing;
  const { campaign } = await campaignFromProgram(tx, tenantId, { clientProgramId, name: "From your own system", branchId, createdBy: null });
  const [c] = await tx
    .update(campaigns)
    .set({ onDemand: true, status: "running", consentAttested: true, launchedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaigns.id, campaign.id))
    .returning();
  return c!;
}

async function upsertContact(tx: Tx, tenantId: string, phone: string, name: string | null, branchId: string | null) {
  const [row] = await tx
    .insert(contacts)
    .values({ tenantId, phoneE164: phone, name, branchId, source: "api", tags: [] })
    .onConflictDoUpdate({ target: [contacts.tenantId, contacts.phoneE164], set: { name: sql`coalesce(${contacts.name}, excluded.name)`, updatedAt: new Date() } })
    .returning();
  return row!;
}

export async function requestCall(tenantId: string, req: CallRequest): Promise<CallRequestResult> {
  const phone = toE164(req.phone);
  if (!phone) throw new CallRequestError("That does not look like an Indian mobile number.", "bad_phone", { phone: req.phone });

  return withTenant(tenantId, async (tx) => {
    const [cp] = req.clientProgramId
      ? await tx.select().from(clientPrograms).where(eq(clientPrograms.id, req.clientProgramId))
      : await tx.select().from(clientPrograms).where(eq(clientPrograms.programKey, req.programKey ?? ""));
    if (!cp) throw new CallRequestError("No such calling program is set up in this workspace.", "unknown_program", { program: req.programKey ?? req.clientProgramId });
    if (!cp.agentId) throw new CallRequestError("That program has no agent yet.", "not_ready", {});
    const p = await programTemplateOf(tx, cp.programKey, cp.programVersion);

    const context = { ...(req.context ?? {}) };
    const missing = missingVariables(p, context, req.name);
    if (missing.length) throw new CallRequestError(`This call needs: ${missing.join(", ")}.`, "missing_fields", { missing });

    // Same request twice (their retry, a double click) means one call.
    const key = `in:${req.idempotencyKey ?? `${cp.id}:${phone}:${new Date().toISOString().slice(0, 13)}`}`;
    const [seen] = await tx.select().from(integrationEvents).where(eq(integrationEvents.idempotencyKey, key));
    if (seen?.refId) {
      const [t] = await tx.select().from(campaignTargets).where(eq(campaignTargets.id, seen.refId));
      if (t) {
        return {
          status: "duplicate" as const,
          targetId: t.id,
          campaignId: t.campaignId,
          program: { key: cp.programKey, name: cp.name },
          preview: { action: t.state === "skipped" ? ("skip" as const) : ("dial" as const), reason: t.skipReason ?? "Already asked for" },
        };
      }
    }

    const campaign = await onDemandCampaign(tx, tenantId, cp.id, req.branchId ?? cp.branchId ?? null);
    const contact = await upsertContact(tx, tenantId, phone, req.name?.trim() || null, req.branchId ?? cp.branchId ?? null);

    // The same person is called again later (a new appointment, next month's bill).
    // One row per person in the standing campaign: reuse it unless a call is already on its way.
    const [already] = await tx
      .select()
      .from(campaignTargets)
      .where(and(eq(campaignTargets.campaignId, campaign.id), eq(campaignTargets.phoneE164, phone)));
    let target = already;
    if (already && ["queued", "scheduled", "dialing"].includes(already.state)) {
      return {
        status: "duplicate" as const,
        targetId: already.id,
        campaignId: campaign.id,
        program: { key: cp.programKey, name: cp.name },
        preview: { action: "dial" as const, reason: "A call for this person is already on its way" },
      };
    }
    if (already) {
      [target] = await tx
        .update(campaignTargets)
        .set({ context, name: req.name?.trim() || already.name, state: "queued", attemptNo: 0, nextAttemptAt: new Date(), skipReason: null, lastOutcome: null, updatedAt: new Date() })
        .where(eq(campaignTargets.id, already.id))
        .returning();
    } else {
      [target] = await tx
        .insert(campaignTargets)
        .values({ tenantId, campaignId: campaign.id, contactId: contact.id, phoneE164: phone, name: req.name?.trim() || contact.name, context, nextAttemptAt: new Date() })
        .returning();
    }

    if (req.externalId && req.integrationId) {
      await tx
        .insert(externalLinks)
        .values({ tenantId, integrationId: req.integrationId, ourType: "contact", ourId: contact.id, externalType: "record", externalId: req.externalId })
        .onConflictDoNothing();
    }

    await tx
      .insert(integrationEvents)
      .values({
        tenantId,
        integrationId: req.integrationId ?? null,
        direction: "in",
        kind: "call.requested",
        refType: "campaign_target",
        refId: target!.id,
        externalId: req.externalId ?? null,
        idempotencyKey: key,
        status: "done",
        payload: { phone, program: cp.programKey, context, source: req.source ?? "api" },
      })
      .onConflictDoNothing();

    // What the rules say right now, so their screen can show it immediately.
    const [num] = await tx.select().from(phoneNumbers).where(eq(phoneNumbers.id, campaign.callerNumberId));
    const now = new Date();
    const facts = await policyFacts(tx, campaign, phone, now);
    const d = decide({
      now,
      campaign: { status: campaign.status, purpose: campaign.purpose as Purpose, windows: campaign.windows, timezone: campaign.timezone, maxAttempts: campaign.maxAttempts, dailyCapPerContact: campaign.dailyCapPerContact, consentAttested: campaign.consentAttested },
      target: { attemptNo: 0 },
      number: { status: num?.status ?? "missing", series: (num?.series ?? "landline") as never, purpose: (num?.purpose ?? "inbound") as never, a2pDeclaredAt: num?.a2pDeclaredAt ?? null },
      ...facts,
    });
    if (d.action === "skip") {
      await tx.update(campaignTargets).set({ state: "skipped", skipReason: d.reason, updatedAt: now }).where(eq(campaignTargets.id, target!.id));
    }
    return {
      status: "queued" as const,
      targetId: target!.id,
      campaignId: campaign.id,
      program: { key: cp.programKey, name: cp.name },
      preview: { action: d.action, reason: d.reason, ...(d.action === "defer" ? { nextAttemptAt: d.until.toISOString() } : {}) },
    };
  });
}

/** Programs their developer can name in the API, and the data each one needs. */
export async function callableProgram(tx: Tx, programKeyOrId: string) {
  const [cp] = await tx
    .select()
    .from(clientPrograms)
    .where(and(eq(clientPrograms.programKey, programKeyOrId)));
  if (!cp) return null;
  const p = await programTemplateOf(tx, cp.programKey, cp.programVersion);
  const [agent] = cp.agentId ? await tx.select().from(agents).where(eq(agents.id, cp.agentId)) : [];
  return {
    key: cp.programKey,
    name: cp.name,
    purpose: p.purpose,
    ready: Boolean(agent?.liveVersionId),
    needs: p.variables.map((v) => ({ name: v.name, label: v.label, required: v.required, example: v.example })),
    outcomes: p.outcomes,
  };
}
