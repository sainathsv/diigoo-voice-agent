import type { Metadata } from "next";
import { can } from "@jenai/authz";
import { audit, withTenant } from "@jenai/db";
import { caseNumber } from "@jenai/engine";
import { CaseSheet } from "@/components/case-sheet";
import { actorFields, requireWorkspace } from "@/server/access";
import { loadComplaint } from "@/server/queries/complaint";
import { requestMeta } from "@/server/session";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Case sheet" };

/**
 * A complaint that began with a call, as a case sheet: the call's answers and
 * what the complainant then sent on WhatsApp, with the proof. Every open is
 * logged, since the sheet carries the complainant's personal details.
 */
export default async function CallCaseSheet({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const ctx = await requireWorkspace(slug);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return deny(ctx, { malformedId: id.slice(0, 80) });
  const d = await loadComplaint(ctx.org.id, { callId: id });
  if (!d) return deny(ctx, { missing: id });
  const scope = { branchId: d.branchId };
  if (!can(ctx.access, "calls:view", scope)) return deny(ctx, { perm: "calls:view", id });
  // The sheet carries bank account, date of birth and address: the same rule as the full transcript.
  if (!can(ctx.access, "transcripts:view_raw", scope)) return deny(ctx, { perm: "transcripts:view_raw", id });
  const prefix = slug.split("-")[0]!.toUpperCase().slice(0, 6);
  const reference = `${prefix}-${d.call!.startedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${d.call!.id.slice(0, 6).toUpperCase()}`;
  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()), action: "call.case_sheet_opened", targetType: "call", targetId: id, summary: `Opened the case sheet ${reference}` }),
  );
  return (
    <CaseSheet
      orgName={ctx.org.name}
      slug={slug}
      reference={reference}
      d={d}
      reveal={can(ctx.access, "contacts:reveal_phone", scope)}
      showProof={can(ctx.access, "recordings:play", scope)}
      caseNo={d.kase ? caseNumber(prefix, d.kase.createdAt, d.kase.seq) : null}
      printedBy={ctx.user.name}
    />
  );
}
