import { NextResponse } from "next/server";
import { branchesFor, can, holdsAnywhere, maskPhone } from "@jenai/authz";
import { audit, withTenant } from "@jenai/db";
import { callAnalytics, complaintsCsv } from "@jenai/engine";
import { actorFields, requireWorkspace } from "@/server/access";
import { loadComplaint } from "@/server/queries/complaint";
import { requestMeta } from "@/server/session";
import { logDenied } from "@/server/security-log";

/**
 * Every complaint in the chosen period as a spreadsheet, one row per complaint
 * and one column per line of the department's form, filled from the call and
 * from what the complainant sent on WhatsApp. Opens in Excel with Hindi intact.
 * Needs the export permission; each download is logged.
 */
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  const branches = branchesFor(ctx.access, "calls:view");
  if ((branches !== "all" && !branches.length) || !holdsAnywhere(ctx.access, "contacts:export") || !holdsAnywhere(ctx.access, "transcripts:view_raw")) {
    await logDenied(ctx, { perm: "contacts:export", what: "complaints export" });
    return new NextResponse("Your role cannot download complaints.", { status: 403 });
  }
  const days = [7, 30, 90, 365].find((d) => String(d) === new URL(req.url).searchParams.get("days")) ?? 30;
  const a = await callAnalytics(ctx.org.id, days, { branches });
  const rows = [];
  for (const c of a.complaints) {
    const d = await loadComplaint(ctx.org.id, c.callId ? { callId: c.callId } : { caseId: c.whatsapp!.caseId });
    if (!d) continue;
    // Full numbers only for the branches where this viewer may see them.
    const reveal = can(ctx.access, "contacts:reveal_phone", { branchId: c.branchId });
    const w = c.whatsapp;
    const whatsapp = !w ? "" : w.followup === "none" ? "caller said no" : w.followup === "form_link" ? "form link sent" : w.followup === "portal" ? "referred to cybercrime.gov.in (over 15 days)" : w.stillNeeded ? `${w.stillNeeded} still needed` : "complete";
    rows.push({
      id: d.call?.id ?? d.kase!.id,
      startedAt: d.call?.startedAt ?? d.kase!.createdAt,
      durationS: d.call?.durationS ?? null,
      phone: c.phone,
      extracted: d.merged,
      summary: d.call?.summary ?? null,
      whatsapp,
      proofs: d.evidence.length,
      mask: reveal ? undefined : maskPhone,
    });
  }
  const fmt = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const csv = complaintsCsv(rows, fmt);
  await withTenant(ctx.org.id, async (tx) =>
    audit(tx, { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()), action: "complaints.exported", summary: `Downloaded ${rows.length} complaint(s), last ${days} days` }),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="complaints-${slug}-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
