import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { can } from "@jenai/authz";
import { audit, caseEvidence, cases, withTenant } from "@jenai/db";
import { actorFields, requireWorkspace } from "@/server/access";
import { requestMeta } from "@/server/session";
import { logDenied } from "@/server/security-log";

const SAFE_INLINE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf|audio\/(ogg|mpeg|mp4|aac|amr)|video\/mp4)$/;

/** A piece of proof from a case, behind the same check as call recordings. Every open is audited. */
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; id: string; eid: string }> }) {
  const { org: slug, id, eid } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(eid)) return new NextResponse("Not found", { status: 404 });
  const ctx = await requireWorkspace(slug);
  const found = await withTenant(ctx.org.id, async (tx) => {
    const [c] = await tx.select({ branchId: cases.branchId }).from(cases).where(eq(cases.id, id));
    const [e] = c ? await tx.select().from(caseEvidence).where(and(eq(caseEvidence.id, eid), eq(caseEvidence.caseId, id))) : [];
    return { c, e };
  });
  if (!found.c || !found.e?.bytes || !can(ctx.access, "recordings:play", { branchId: found.c.branchId })) {
    if (found.c && !can(ctx.access, "recordings:play", { branchId: found.c.branchId })) await logDenied(ctx, { perm: "recordings:play", evidence: eid });
    return new NextResponse("Not found", { status: 404 });
  }
  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()), action: "case.evidence_viewed", targetType: "case", targetId: id, summary: `Opened proof ${found.e!.filename ?? found.e!.kind}` }),
  );
  const inline = SAFE_INLINE.test(found.e.mime);
  return new NextResponse(new Uint8Array(found.e.bytes), {
    headers: {
      // Anything that is not a plain image, PDF or audio downloads instead of rendering in our origin.
      "Content-Type": inline ? found.e.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${(found.e.filename ?? `proof-${eid.slice(0, 8)}`).replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
