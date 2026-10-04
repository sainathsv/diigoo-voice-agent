"use server";

import { revalidatePath } from "next/cache";
import { branchesFor, holdsAnywhere } from "@jenai/authz";
import { VISIT_IMPORT_MAX_BYTES, VisitImportError, dbErrorCode, decodeVisitFile, importVisits, type VisitReject } from "@jenai/engine";
import { actorFields, requireWorkspace } from "../access";
import { logDenied } from "../security-log";
import { requestMeta } from "../session";

export type VisitUploadState = {
  ok?: string;
  error?: string;
  /** The first refused rows, by row number with a plain reason. Never a value from the row. */
  rejected?: VisitReject[];
  /** Refused rows beyond those listed. */
  moreRejected?: number;
} | null;

/** Refused rows shown on the page; the rest are counted. */
const SHOW_REJECTED = 100;

/**
 * Upload the visit list: the services people took, exported as CSV from the
 * clinic's own software. For workspace admins and branch managers (visits:import);
 * a manager of some branches adds visits for those branches only. Stores the
 * visits and contacts and plans the calls again. Nothing is dialled.
 */
export async function uploadVisitList(_: VisitUploadState, fd: FormData): Promise<VisitUploadState> {
  const slug = String(fd.get("slug"));
  const ctx = await requireWorkspace(slug);
  if (ctx.org.status === "suspended") return { error: "This workspace is suspended. Contact JENAI support." };
  if (!holdsAnywhere(ctx.access, "visits:import")) {
    await logDenied(ctx, { perm: "visits:import", target: null, via: ctx.support ? "support" : "member" });
    return { error: "Your role cannot upload the visit list. Ask a workspace admin or branch manager." };
  }
  const scope = branchesFor(ctx.access, "visits:import");

  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose the visit list file (CSV) to upload." };
  if (file.size > VISIT_IMPORT_MAX_BYTES) return { error: "The file is larger than 5 MB. Split it into smaller files by date." };

  try {
    const r = await importVisits(ctx.org.id, decodeVisitFile(new Uint8Array(await file.arrayBuffer())), {
      source: "upload",
      uploadedBy: ctx.user.userId,
      audit: { ...actorFields(ctx), ...(await requestMeta()) },
      branchIds: scope === "all" ? undefined : scope,
    });
    const refused = r.rejected.length;
    // The call plan page shows the new plan with the result, without a reload.
    revalidatePath(`/w/${ctx.org.slug}/call-plan`);
    return {
      ok:
        `Visit list read: ${r.added} new ${r.added === 1 ? "visit" : "visits"}, ${r.updated} updated, ${r.unchanged} already here` +
        `${refused ? `, ${refused} ${refused === 1 ? "row" : "rows"} not used` : ""}. ` +
        `The call plan is up to date: ${r.plan.byVerdict.call_now} to call now, ${r.plan.byVerdict.scheduled} scheduled. Nothing is dialled from here.`,
      rejected: r.rejected.slice(0, SHOW_REJECTED),
      moreRejected: Math.max(0, refused - SHOW_REJECTED),
    };
  } catch (e) {
    if (e instanceof VisitImportError) return { error: e.message };
    // A failed query's message holds every row it was writing (names, numbers,
    // services), so only Postgres's code for it is logged, and nothing is rethrown.
    console.error(JSON.stringify({ event: "visits.upload_failed", code: dbErrorCode(e) ?? (e instanceof Error ? e.name : "unknown") }));
    return { error: "The visit list could not be stored or planned just now. Try again in a minute: uploading it again adds nothing twice." };
  }
}
