"use server";

import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit, platformDb, securityAlerts, withTenant } from "@jenai/db";
import { verifyAuditChains } from "@jenai/engine";
import { requirePlatform } from "../platform/context";
import { requestMeta } from "../session";

const go = (msg: { ok?: string; error?: string }): never => {
  redirect(`/console/security?${new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" })}`);
};

const Handle = z.object({
  id: z.uuid(),
  decision: z.enum(["acknowledge", "resolve", "false_positive"]),
  note: z.string().trim().max(500).optional().default(""),
});

const LABEL = { acknowledge: "acknowledged", resolve: "resolved", false_positive: "closed as a false positive" } as const;

/** Acknowledge (someone is looking), resolve, or close as a false positive. Closing needs a note. */
export async function handleAlert(fd: FormData) {
  const ctx = await requirePlatform("platform:security.manage");
  const p = Handle.safeParse(Object.fromEntries(fd));
  if (!p.success) go({ error: "Choose what to do with the alert." });
  const { id, decision, note } = p.data!;
  if (decision !== "acknowledge" && note.length < 5) go({ error: "Write a short note on what happened before closing the alert." });
  const status = decision === "acknowledge" ? "acknowledged" : decision === "resolve" ? "resolved" : "false_positive";
  const [a] = await platformDb()
    .update(securityAlerts)
    .set({ status, handledBy: ctx.user.userId, handledAt: new Date(), ...(note ? { note } : {}) })
    .where(and(eq(securityAlerts.id, id), inArray(securityAlerts.status, decision === "acknowledge" ? ["open"] : ["open", "acknowledged"])))
    .returning();
  if (!a) go({ error: "That alert was already handled by someone else." });
  await withTenant(ctx.platformOrgId, async (tx) =>
    audit(tx, {
      tenantId: ctx.platformOrgId,
      actorUserId: ctx.user.userId,
      action: `security.alert_${decision}`,
      targetType: "security_alert",
      targetId: id,
      summary: `${LABEL[decision][0]!.toUpperCase()}${LABEL[decision].slice(1)} alert: ${a!.title}`,
      diff: { rule: a!.rule, severity: a!.severity, note: note || null },
      ...(await requestMeta()),
    }),
  );
  go({ ok: `Alert ${LABEL[decision]}.` });
}

/** Re-walks every activity-log chain now instead of waiting for the hourly check. */
export async function checkAuditLogNow() {
  const ctx = await requirePlatform("platform:security.view");
  const checks = await verifyAuditChains(platformDb(), () => {}, { fullShard: false });
  const broken = checks.filter((c) => c.problem);
  await withTenant(ctx.platformOrgId, async (tx) =>
    audit(tx, { tenantId: ctx.platformOrgId, actorUserId: ctx.user.userId, action: "security.audit_verified", summary: `Checked the activity log: ${checks.length} chains, ${broken.length} broken`, ...(await requestMeta()) }),
  );
  if (broken.length) go({ error: `The activity log was changed in ${broken.length} place(s). A critical alert is open.` });
  go({ ok: `Activity log intact: ${checks.reduce((n, c) => n + c.events, 0).toLocaleString("en-IN")} new events checked in ${checks.length} changed chain(s); older events were verified earlier.` });
}
