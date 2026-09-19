import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { agents, carrierAccounts, phoneNumbers, provisioningSteps, sealSecret, withTenant, type Tx } from "@jenai/db";
import { toE164 } from "@jenai/voice";
import { assertWithinLimit, entitlements } from "./plans";
import { voiceClient } from "./voice-conn";

export const SERIES_LABEL: Record<string, string> = {
  landline: "Landline",
  mobile: "Mobile",
  series_140: "140-series (promotional)",
  series_1600: "1600-series (service, BFSI and government)",
  toll_free: "Toll-free",
};
export const PURPOSE_LABEL: Record<string, string> = {
  inbound: "Inbound only",
  outbound_service: "Outbound service calls",
  outbound_promotional: "Outbound promotional calls",
  both: "Inbound and outbound",
};

export async function addCarrierAccount(
  tx: Tx,
  tenantId: string,
  input: { provider: string; mode: "managed_subaccount" | "client_account" | "forwarding"; displayName: string; externalAccountId?: string | null; credential?: string | null; voiceConfigId?: number | null },
  actorUserId: string | null,
) {
  const [row] = await tx
    .insert(carrierAccounts)
    .values({
      tenantId,
      provider: input.provider,
      mode: input.mode,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId ?? null,
      credentialCiphertext: input.credential ? sealSecret(tenantId, "carrier", input.credential) : null,
      voiceConfigId: input.voiceConfigId ?? null,
      createdBy: actorUserId,
    })
    .returning();
  return row!;
}

export async function addPhoneNumber(
  tx: Tx,
  tenantId: string,
  input: { carrierAccountId: string; e164: string; series: string; purpose: string; branchId?: string | null; label?: string | null; inboundAgentId?: string | null; maxConcurrency?: number; voiceNumberId?: number | null },
) {
  const e164 = toE164(input.e164);
  if (!e164) throw new Error("Enter the number with country code, for example +91 40 1234 5678.");
  const ent = await entitlements(tx, tenantId);
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(phoneNumbers).where(ne(phoneNumbers.status, "released"));
  assertWithinLimit(ent, "phone_numbers", n);
  try {
    const [row] = await tx
      .insert(phoneNumbers)
      .values({
        tenantId,
        carrierAccountId: input.carrierAccountId,
        e164,
        series: input.series as never,
        purpose: input.purpose as never,
        branchId: input.branchId ?? null,
        label: input.label ?? null,
        inboundAgentId: input.inboundAgentId ?? null,
        maxConcurrency: input.maxConcurrency ?? 10,
        voiceNumberId: input.voiceNumberId ?? null,
      })
      .returning();
    return row!;
  } catch (e) {
    if (/phone_numbers_e164_global|duplicate key/i.test(`${(e as { cause?: { message?: string } }).cause?.message ?? ""} ${(e as Error).message}`)) {
      throw new Error("That number is already registered to a JENAI workspace. A number can belong to only one client.");
    }
    throw e;
  }
}

/**
 * Bring the numbers this client already uses on the voice engine under
 * management. Only numbers whose inbound agent belongs to THIS client are
 * imported: several clients may share one engine organization today.
 */
export async function importNumbersFromVoice(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const v = await voiceClient(tx, tenantId);
    if (!v) throw new Error("No voice connection.");
    const mine = await tx.select().from(agents).where(isNotNull(agents.inboundWorkflowId));
    const byWf = new Map(mine.map((a) => [a.inboundWorkflowId!, a]));
    const { configurations } = await v.client.listTelephonyConfigs();
    let imported = 0;
    const skipped: string[] = [];
    for (const cfg of configurations) {
      const { phone_numbers } = await v.client.listPhoneNumbers(cfg.id);
      const relevant = phone_numbers.filter((p) => p.inbound_workflow_id && byWf.has(p.inbound_workflow_id) && p.is_active);
      if (!relevant.length) continue;
      let [acct] = await tx.select().from(carrierAccounts).where(eq(carrierAccounts.voiceConfigId, cfg.id));
      if (!acct) {
        acct = await addCarrierAccount(
          tx,
          tenantId,
          { provider: cfg.provider === "vobiz" ? "vobiz" : "other", mode: "managed_subaccount", displayName: `${cfg.name} (shared Diigoo account, move to own sub-account)`, voiceConfigId: cfg.id },
          null,
        ).catch(async () => (await tx.select().from(carrierAccounts).where(eq(carrierAccounts.voiceConfigId, cfg.id)))[0]!);
      }
      for (const p of relevant) {
        const e164 = toE164(p.address);
        if (!e164) continue;
        const [exists] = await tx.select({ id: phoneNumbers.id }).from(phoneNumbers).where(eq(phoneNumbers.e164, e164));
        if (exists) continue;
        try {
          const agent = byWf.get(p.inbound_workflow_id!)!;
          await addPhoneNumber(tx, tenantId, {
            carrierAccountId: acct.id,
            e164,
            series: "landline",
            purpose: "both",
            branchId: agent.branchId,
            label: p.label ?? null,
            inboundAgentId: agent.id,
            voiceNumberId: p.id,
          });
          imported++;
        } catch (e) {
          skipped.push(`${e164}: ${(e as Error).message}`);
        }
      }
    }
    await refreshProvisioning(tx, tenantId);
    return { imported, skipped };
  });
}

/** Go-live steps that can be proven from data are updated from the data. */
export async function refreshProvisioning(tx: Tx, tenantId: string) {
  const nums = await tx.select().from(phoneNumbers).where(ne(phoneNumbers.status, "released"));
  const accts = await tx.select().from(carrierAccounts);
  const set = async (step: string, status: "passed" | "failed" | "in_progress" | "pending", detail: string) =>
    tx.update(provisioningSteps).set({ status, detail, updatedAt: new Date(), updatedBy: null }).where(and(eq(provisioningSteps.tenantId, tenantId), eq(provisioningSteps.step, step)));

  if (nums.length) await set("number", "passed", `${nums.length} number(s) registered: ${nums.map((n) => n.e164).join(", ")}`);
  const outbound = nums.filter((n) => n.purpose !== "inbound");
  const undeclared = outbound.filter((n) => !n.a2pDeclaredAt);
  if (outbound.length) {
    await set("a2p_declaration", undeclared.length ? "failed" : "passed", undeclared.length ? `Not declared for AI calls: ${undeclared.map((n) => n.e164).join(", ")}` : "Every caller ID is declared for AI calls");
  }
  const shared = accts.filter((a) => a.displayName.includes("shared Diigoo account"));
  const own = accts.filter((a) => !shared.includes(a) && a.status === "active");
  if (shared.length && !own.length) await set("telephony_account", "failed", "Still on the shared Diigoo carrier account. Create the client's own sub-account.");
  else if (own.length) await set("telephony_account", own.some((a) => a.kycStatus === "verified") ? "passed" : "in_progress", own.some((a) => a.kycStatus === "verified") ? "Own carrier account, KYC verified" : "Own carrier account created; KYC not verified yet");
  const kyc = own.find((a) => a.kycStatus === "verified");
  if (kyc) await set("kyc", "passed", `Carrier KYC verified (${kyc.displayName})`);
}

export async function numbersByIds(tx: Tx, ids: string[]) {
  return ids.length ? tx.select().from(phoneNumbers).where(inArray(phoneNumbers.id, ids)) : [];
}
