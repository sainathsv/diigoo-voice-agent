"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  PlanSettingError,
  PlanSwitchError,
  STATUS_LISTS,
  VisitRemovalError,
  dbErrorCode,
  eraseNumber,
  planSettingsPage,
  removeTreatmentRule,
  removeVisitUpload,
  setPlanEnabled,
  setPlanSettings,
  setPullFieldLabels,
  setTreatmentRule,
  statusMoved,
  type StatusList,
} from "@jenai/engine";
import { actorFields, workspaceAction, type WorkspaceCtx } from "../access";
import { requestMeta } from "../session";

type Where = "plan" | "settings";
const go = (slug: string, where: Where, msg: { ok?: string; error?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`/w/${slug}/call-plan${where === "settings" ? "/settings" : ""}?${q}`);
};

async function who(ctx: WorkspaceCtx) {
  const a = actorFields(ctx);
  const m = await requestMeta();
  return { actorUserId: a.actorUserId, via: a.via, audit: { impersonatorUserId: "impersonatorUserId" in a ? a.impersonatorUserId : null, ip: m.ip, userAgent: m.userAgent } };
}

/**
 * Runs a change and says how it went in plain words. A change the plan
 * refused says why; anything else is logged with Postgres's code only (a
 * failed query's message carries its values) and reported plainly.
 */
async function attempt(slug: string, where: Where, what: string, change: () => Promise<string>): Promise<never> {
  let ok: string;
  try {
    ok = await change();
  } catch (e) {
    if (e instanceof PlanSettingError || e instanceof PlanSwitchError || e instanceof VisitRemovalError) go(slug, where, { error: e.message });
    console.error(JSON.stringify({ event: "call_plan.change_failed", what, code: dbErrorCode(e) }));
    go(slug, where, { error: `${what} could not be saved just now. Try again in a minute.` });
  }
  revalidatePath(`/w/${slug}/call-plan`);
  return go(slug, where, { ok: ok! });
}

/** Switches the call plan on (JENAI reads the CRM on a timer) or off. Workspace admins. */
export async function switchCallPlan(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const on = fd.get("to") === "on";
  await attempt(slug, "plan", "The switch", async () => {
    await setPlanEnabled(ctx.org.id, on, await who(ctx));
    return on
      ? "Call plan switched on. JENAI reads your CRM and front desk system on a timer from now on, only to plan. Nobody is called."
      : "Call plan switched off. JENAI stops reading your CRM and front desk system on a timer.";
  });
}

/** Takes out the visits one upload added or last changed. Needs visits:import across the workspace. */
export async function removeUpload(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "visits:import");
  const batch = String(fd.get("batch") ?? "");
  await attempt(slug, "plan", "Removing the upload", async () => {
    const r = await removeVisitUpload(ctx.org.id, batch, { removedBy: ctx.user.userId, audit: { ...(await who(ctx)).audit, via: ctx.support ? "support" : "user" } });
    const kept = r.kept ? `; ${r.kept} also read from your front desk system ${r.kept === 1 ? "stays" : "stay"}` : "";
    return `Upload removed: ${r.removed} ${r.removed === 1 ? "visit" : "visits"} taken out${kept}, and the plan worked out again.`;
  });
}

/** Erases one number from the call plan's copies, for someone who asked the clinic to erase their data. Workspace admins. */
export async function eraseFromPlan(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  await attempt(slug, "settings", "The erasure", async () => {
    const r = await eraseNumber(ctx.org.id, String(fd.get("phone") ?? ""), { removedBy: ctx.user.userId, audit: { ...(await who(ctx)).audit, via: ctx.support ? "support" : "user" } });
    return `Erased: ${r.visits} visits, ${r.records} CRM records, ${r.frontDesk} front desk records and ${r.planned} planned calls. Delete them in your CRM and front desk system too, or the next read brings them back.`;
  });
}

/** Puts one of their CRM's statuses in a list, or out of every list. */
export async function moveStatus(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const status = String(fd.get("status") ?? "").trim();
  const raw = String(fd.get("list") ?? "");
  const to = (STATUS_LISTS as readonly string[]).includes(raw) ? (raw as StatusList) : null;
  if (!status) go(slug, "settings", { error: "Choose a status." });
  await attempt(slug, "settings", "The status", async () => {
    const { settings } = await planSettingsPage(ctx.org.id);
    await setPlanSettings(ctx.org.id, statusMoved(settings, status, to), await who(ctx));
    return `"${status}" saved. The plan is worked out again with it.`;
  });
}

/** Counts a lead source as an enquiry the person made, or as the clinic's own outreach. */
export async function setSourceKind(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const source = String(fd.get("source") ?? "").trim();
  const outbound = fd.get("kind") === "outbound";
  if (!source) go(slug, "settings", { error: "Choose a lead source." });
  await attempt(slug, "settings", "The lead source", async () => {
    const { settings } = await planSettingsPage(ctx.org.id);
    const same = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === source.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const out = settings.outboundSources.filter((x) => !same(x));
    const patch: Record<string, unknown> = { outboundSources: outbound ? [...out, source] : out };
    if (settings.enquirySources.length) patch.enquirySources = outbound ? settings.enquirySources.filter((x) => !same(x)) : [...settings.enquirySources.filter((x) => !same(x)), source];
    await setPlanSettings(ctx.org.id, patch, await who(ctx));
    return outbound ? `"${source}" counts as your own outreach: no enquiry call to those leads.` : `"${source}" counts as an enquiry the person made.`;
  });
}

const list = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
const whole = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : Number(t);
};

/** The plan's numbers, calling hours, centres and contact-only modules, from the settings form. */
export async function savePlanSettings(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const patch: Record<string, unknown> = {};
  for (const key of ["freshDays", "minGapDays", "reminderHour", "consultationWithinDays", "checkInAfterDays", "feedbackWithinDays", "resultCheckWithinDays", "recallWithinDays", "packageEndingWithinDays", "checkinLeadDays", "courseGapDays", "maxCallsPer30Days"]) {
    if (fd.has(key)) patch[key] = whole(fd.get(key));
  }
  for (const key of ["centres", "contactOnlyModules"]) if (fd.has(key)) patch[key] = list(fd.get(key));
  if (fd.has("windowStart")) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => fd.get(`day${d}`) === "on");
    patch.callingWindow = { days, start: String(fd.get("windowStart")), end: String(fd.get("windowEnd")) };
  }
  await attempt(slug, "settings", "The plan settings", async () => {
    // Only what changed, so the activity log shows what someone actually changed.
    const { settings, own } = await planSettingsPage(ctx.org.id);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => (v === null ? k in own : JSON.stringify(v) !== JSON.stringify(settings[k as keyof typeof settings]))));
    if (!Object.keys(changed).length) return "Nothing was changed.";
    await setPlanSettings(ctx.org.id, changed, await who(ctx));
    return "Plan settings saved. The plan is worked out again with them.";
  });
}

/** The clinic's own timing for a treatment. */
export async function saveTreatmentRule(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  const match = String(fd.get("match") ?? "").trim();
  await attempt(slug, "settings", "The treatment timing", async () => {
    await setTreatmentRule(
      ctx.org.id,
      {
        match,
        label: String(fd.get("label") ?? ""),
        feedbackAfterDays: whole(fd.get("feedbackAfterDays")),
        resultCheckAfterDays: whole(fd.get("resultCheckAfterDays")),
        sessionIntervalDays: whole(fd.get("sessionIntervalDays")),
        courseSessions: whole(fd.get("courseSessions")),
        maintenanceAfterDays: whole(fd.get("maintenanceAfterDays")),
      },
      await who(ctx),
    );
    return `Timing for "${match}" saved. It replaces JENAI's default for that treatment.`;
  });
}

export async function deleteTreatmentRule(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "org:manage");
  await attempt(slug, "settings", "Removing the timing", async () => {
    await removeTreatmentRule(ctx.org.id, String(fd.get("id") ?? ""), await who(ctx));
    return "Timing removed. JENAI's default applies again.";
  });
}

/** Which of their CRM's fields one item is read from. Needs integrations:manage, as it changes what JENAI reads. */
export async function saveFieldLabels(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  const item = String(fd.get("item") ?? "");
  const labels = list(fd.get("labels"));
  await attempt(slug, "settings", "The field labels", async () => {
    await setPullFieldLabels(ctx.org.id, String(fd.get("id") ?? ""), item, labels.length ? labels : null, await who(ctx));
    return labels.length ? `Saved. The next read reads every record again from ${labels.join(", ")}.` : "Put back to the usual fields. The next read reads every record again.";
  });
}
