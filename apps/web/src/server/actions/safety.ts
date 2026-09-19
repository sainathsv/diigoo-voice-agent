"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, platformDb, withTenant } from "@jenai/db";
import { enqueueFleetSweep, reviewSafetyCheck } from "@jenai/engine";
import { requirePlatform } from "../platform/context";
import { requestMeta } from "../session";

const go = (msg: { ok?: string; error?: string }): never => {
  redirect(`/console/ai-safety?${new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Done" })}`);
};

const Review = z.object({
  tenantId: z.uuid(),
  checkId: z.uuid(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().min(5).max(500),
});

/** A reviewer read the answers the judges could not agree on: approve (publishable) or reject. */
export async function reviewCheck(fd: FormData) {
  const ctx = await requirePlatform("platform:templates.manage");
  const p = Review.safeParse(Object.fromEntries(fd));
  if (!p.success) go({ error: "Write a short note on what you read before deciding." });
  const d = p.data!;
  try {
    await reviewSafetyCheck(d.tenantId, d.checkId, d.decision, ctx.user.userId, d.note);
  } catch (e) {
    go({ error: (e as Error).message });
  }
  // Recorded in the client's own log too: they can see JENAI judged their agent.
  await withTenant(d.tenantId, async (tx) =>
    audit(tx, { tenantId: d.tenantId, actorUserId: ctx.user.userId, via: "support", impersonatorUserId: ctx.user.userId, action: `agent.safety_${d.decision}d`, targetType: "safety_check", targetId: d.checkId, summary: `JENAI ${d.decision === "approve" ? "approved" : "rejected"} an AI safety check after review: ${d.note}`, ...(await requestMeta()) }),
  );
  go({ ok: d.decision === "approve" ? "Approved. The client can publish this version." : "Rejected. The client sees it as failed." });
}

/** Queue re-checks of live agents now, instead of waiting for the hourly sweep. */
export async function sweepNow() {
  const ctx = await requirePlatform("platform:templates.manage");
  const n = await enqueueFleetSweep(platformDb(), { max: 200, days: Number(process.env.JENAI_SAFETY_RECHECK_DAYS ?? 90) });
  await withTenant(ctx.platformOrgId, async (tx) =>
    audit(tx, { tenantId: ctx.platformOrgId, actorUserId: ctx.user.userId, action: "safety.sweep_queued", summary: `Queued ${n} AI safety re-checks of live agents`, ...(await requestMeta()) }),
  );
  go({ ok: n ? `Queued ${n} live agents for a safety re-check. The worker works through them.` : "Every live agent has a recent check." });
}
