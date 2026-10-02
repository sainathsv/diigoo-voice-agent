import "server-only";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { calls, caseCalls, caseEvidence, cases, withTenant, type Case } from "@jenai/db";
import { scamLabel, withWhatsApp } from "@jenai/engine";

export interface SheetEvidence {
  id: string;
  kind: string;
  mime: string;
  filename: string | null;
  caption: string | null;
  sizeBytes: number;
  sha256: string | null;
  receivedAt: Date;
}

const WEEK = 7 * 86_400_000;

/**
 * One complaint for its case sheet or the export: the call it began with (if
 * any), its WhatsApp case, the proof, and the form's answers merged from both.
 */
export async function loadComplaint(tenantId: string, ref: { callId: string } | { caseId: string }) {
  return withTenant(tenantId, async (tx) => {
    let call: typeof calls.$inferSelect | undefined;
    let kase: Case | undefined;
    if ("callId" in ref) {
      [call] = await tx.select().from(calls).where(eq(calls.id, ref.callId));
      if (!call) return null;
      [kase] = await tx.select().from(cases).where(eq(cases.firstCallId, call.id)).limit(1);
      // A second call from the same person adds to the case the first call opened.
      if (!kase) {
        const [link] = await tx.select({ caseId: caseCalls.caseId }).from(caseCalls).where(eq(caseCalls.callId, call.id)).limit(1);
        if (link) [kase] = await tx.select().from(cases).where(eq(cases.id, link.caseId));
      }
      const phone = call.direction === "inbound" ? call.fromE164 : call.toE164;
      if (!kase && phone)
        [kase] = await tx
          .select()
          .from(cases)
          .where(and(eq(cases.complainantE164, phone), gte(cases.createdAt, new Date(call.startedAt.getTime() - WEEK)), lte(cases.createdAt, new Date(call.startedAt.getTime() + WEEK))))
          .orderBy(desc(cases.createdAt))
          .limit(1);
    } else {
      [kase] = await tx.select().from(cases).where(eq(cases.id, ref.caseId));
      if (!kase) return null;
      if (kase.firstCallId) [call] = await tx.select().from(calls).where(eq(calls.id, kase.firstCallId));
    }
    const evidence: SheetEvidence[] = kase
      ? await tx
          .select({ id: caseEvidence.id, kind: caseEvidence.kind, mime: caseEvidence.mime, filename: caseEvidence.filename, caption: caseEvidence.caption, sizeBytes: caseEvidence.sizeBytes, sha256: caseEvidence.sha256, receivedAt: caseEvidence.receivedAt })
          .from(caseEvidence)
          .where(eq(caseEvidence.caseId, kase.id))
          .orderBy(asc(caseEvidence.receivedAt))
      : [];
    const base = call?.extracted ?? { complaint_type: kase?.fields.complaint_type ?? (kase?.scamType ? scamLabel(kase.scamType) : undefined) };
    return {
      call: call ?? null,
      kase: kase ?? null,
      evidence,
      merged: withWhatsApp(base, kase?.fields),
      branchId: call?.branchId ?? kase?.branchId ?? null,
      phone: call ? (call.direction === "inbound" ? call.fromE164 : call.toE164) : kase!.complainantE164,
    };
  });
}

export type LoadedComplaint = NonNullable<Awaited<ReturnType<typeof loadComplaint>>>;
