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

/** A complaint's case sheet by its case (also one that began on WhatsApp, without a call). Every open is logged. */
export default async function CaseCaseSheet({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const ctx = await requireWorkspace(slug);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return deny(ctx, { malformedId: id.slice(0, 80) });
  const d = await loadComplaint(ctx.org.id, { caseId: id });
  if (!d) return deny(ctx, { missing: id });
  const scope = { branchId: d.branchId };
  if (!can(ctx.access, "calls:view", scope)) return deny(ctx, { perm: "calls:view", id });
  if (!can(ctx.access, "transcripts:view_raw", scope)) return deny(ctx, { perm: "transcripts:view_raw", id });
  const prefix = slug.split("-")[0]!.toUpperCase().slice(0, 6);
  const no = caseNumber(prefix, d.kase!.createdAt, d.kase!.seq);
  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()), action: "case.case_sheet_opened", targetType: "case", targetId: id, summary: `Opened the case sheet ${no}` }),
  );
  return (
    <CaseSheet
      orgName={ctx.org.name}
      slug={slug}
      reference={no}
      d={d}
      reveal={can(ctx.access, "contacts:reveal_phone", scope)}
      showProof={can(ctx.access, "recordings:play", scope)}
      caseNo={null}
      printedBy={ctx.user.name}
    />
  );
}
