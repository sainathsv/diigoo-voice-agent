/**
 * What a client sets for their own call plan, from the workspace: the switch
 * that starts reading their CRM on a timer, which of their CRM's words mean
 * what (statuses, lead sources, centres), when each treatment's calls fall
 * due, and which of their Zoho fields hold what. Every change is audited and
 * the plan is worked out again at once. Nothing here dials.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { audit, callPlanSettings, crmRecords, integrations, organizations, treatmentRules, withTenant, type TreatmentRule } from "@jenai/db";
import {
  DEFAULT_HEALTH_RULES,
  DEFAULT_PLAN_SETTINGS,
  FALLBACK_RULE,
  PLAN_NUMBER_LIMITS,
  STATUS_LISTS,
  planSettingsOf,
  replanTenant,
  statusListOf,
  type PlanNumberKey,
  type PlanRule,
  type PlanSettings,
  type ReplanResult,
  type StatusList,
} from "./care-plan";
import { planReadKinds, pullKinds } from "./integrations/crm-sync";
import { ZOHO_PULL_ITEMS, ZOHO_PULL_LABELS } from "./integrations/zoho";
import { auditedBy, type SetPlanSettingOptions } from "./plan-refresh";
import { verticalOf } from "./safety/cases";

/** A change the plan cannot take, with the reason in plain words. */
export class PlanSwitchError extends Error {}

/**
 * Switches a client's call plan on or off. On, JENAI reads their CRM and
 * front desk system on a timer (when the worker reads at all) and the plan is
 * worked out at once;
 * off, nothing more is read and what is held stays until they remove the
 * connection. Only for clinics for now: every call the plan knows is a
 * clinic's.
 */
export async function setPlanEnabled(tenantId: string, enabled: boolean, opts: SetPlanSettingOptions = {}): Promise<{ enabled: boolean; plan: ReplanResult | null }> {
  await withTenant(tenantId, async (tx) => {
    const [org] = await tx.select({ vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, tenantId));
    if (enabled && verticalOf(org?.vertical) !== "health")
      throw new PlanSwitchError("The call plan knows clinic calls only for now (reminders, check-ins, feedback, next sittings), so it cannot be switched on for this workspace.");
    await tx
      .insert(callPlanSettings)
      .values({ tenantId, enabled, nextReplanAt: sql`now()` })
      .onConflictDoUpdate({ target: callPlanSettings.tenantId, set: { enabled, updatedAt: new Date() } });
    // Read at once, rather than at the end of an interval set before: their CRM and their front desk system alike.
    if (enabled) await tx.update(integrations).set({ nextPullAt: null }).where(sql`${integrations.kind}::text in (${sql.join(planReadKinds().map((k) => sql`${k}`), sql`, `)})`);
    await audit(tx, {
      ...auditedBy(tenantId, opts),
      action: enabled ? "call_plan.switched_on" : "call_plan.switched_off",
      targetType: "call_plan_settings",
      targetId: tenantId,
      summary: enabled ? "Call plan switched on: JENAI reads the CRM on a timer" : "Call plan switched off: JENAI stops reading the CRM on a timer",
    });
  });
  return { enabled, plan: enabled ? await replanTenant(tenantId, { now: opts.now }) : null };
}

// ---------------------------------------------------------------- what each number means

export interface PlanNumberSetting {
  key: PlanNumberKey;
  /** What it sets, in the clinic's words. */
  label: string;
  /** What it changes in the plan, or "" when the label says it all. */
  help: string;
  min: number;
  max: number;
  /** JENAI's value when the client sets none. */
  standard: number;
}

/**
 * The plan's numbers as a client reads them, in the order the settings page
 * shows them. The settings page and `plan set` both say these, so the words
 * are written once; plan-settings.test.ts checks every number has them.
 */
export const PLAN_NUMBER_SETTINGS: readonly PlanNumberSetting[] = (
  [
    ["freshDays", "Enquiries stay warm for (days)", "Older, a call is a cold call, which needs a promotional number and consent."],
    ["minGapDays", "Days between calls to one person", "Appointment reminders are not held back by this."],
    ["reminderHour", "Reminder hour, the evening before", "Kept inside your calling hours."],
    ["consultationWithinDays", "Check in after a consultation within (days)", ""],
    ["checkInAfterDays", "Check-in this many days after a consultation", ""],
    ["feedbackWithinDays", "Ask for feedback while the visit is this recent (days)", ""],
    ["resultCheckWithinDays", "Result check up to this many days past due", ""],
    [
      "recallWithinDays",
      "Course check-in or maintenance up to this many days past due",
      "Later, a call is a win-back offer, which needs a promotional number and consent. Sessions left on a package they paid for are always theirs to book.",
    ],
    [
      "packageEndingWithinDays",
      "Call about a package ending within (days)",
      "From your front desk system (Zenoti): sessions left on a package that ends this soon are called about in time, so they can use what they paid for.",
    ],
    [
      "checkinLeadDays",
      "Course check-in this many days before the next sitting is due",
      "The one call between sittings of a course: how they have been, whether they see a difference, and booking the next sitting. Never sooner than a week after a sitting, and none when the next sitting is already booked.",
    ],
    [
      "courseGapDays",
      "A break longer than this starts a new course (days)",
      "Sittings of one treatment closer together than this are one course, with one check-in between each. For a treatment with a long gap between sittings, 2.5 times that gap counts when it is longer.",
    ],
    [
      "maxCallsPer30Days",
      "Most calls to one person in any 30 days",
      "A safety net, so nobody is called too often: a later call waits until the 30 days allow it. Appointment reminders are not held back by this.",
    ],
  ] as const
).map(([key, label, help]) => ({ key, label, help, min: PLAN_NUMBER_LIMITS[key][0], max: PLAN_NUMBER_LIMITS[key][1], standard: DEFAULT_PLAN_SETTINGS[key] }));

// ---------------------------------------------------------------- what the settings page shows

export interface PlanSettingsPage {
  settings: PlanSettings;
  /** The keys the client set themselves; the rest are the defaults. */
  own: Record<string, unknown>;
  enabled: boolean;
  canEnable: boolean;
  /** Every status their CRM uses, how many records have it, and which list it falls in now (null: none, so those records prompt no call). */
  statuses: Array<{ status: string; records: number; list: StatusList | null }>;
  /** Every lead source their CRM uses, and whether the plan counts it as an enquiry the person made. */
  sources: Array<{ source: string; records: number; enquiry: boolean }>;
  /** Every centre their CRM names, and the modules records come from. */
  centres: Array<{ centre: string; records: number }>;
  modules: Array<{ module: string; records: number }>;
  /** Their own treatment timings, then JENAI's defaults for their industry. */
  rules: { own: TreatmentRule[]; defaults: PlanRule[] };
  /** Their CRM connections JENAI reads, with the field labels each reads from. */
  connections: Array<{ id: string; name: string; labels: Record<string, string[]>; ownLabels: string[] }>;
}

const MAX_SEEN = 200;

/** Everything the plan settings page needs: the settings in force and what their CRM actually holds. */
export async function planSettingsPage(tenantId: string): Promise<PlanSettingsPage> {
  return withTenant(tenantId, async (tx) => {
    const [org] = await tx.select({ timezone: organizations.timezone, vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, tenantId));
    const [state] = await tx.select().from(callPlanSettings).where(eq(callPlanSettings.tenantId, tenantId));
    const settings = planSettingsOf(state?.settings, org?.timezone ?? "Asia/Kolkata");
    const seen = async (col: typeof crmRecords.status | typeof crmRecords.source | typeof crmRecords.centre | typeof crmRecords.module) =>
      (
        await tx
          .select({ value: col, n: sql<number>`count(*)::int` })
          .from(crmRecords)
          .where(and(isNull(crmRecords.deletedAt), sql`coalesce(trim(${col}), '') <> ''`))
          .groupBy(col)
          .orderBy(sql`count(*) desc`)
          .limit(MAX_SEEN)
      ).map((r) => ({ value: String(r.value), n: r.n }));
    const enquiry = (source: string) => !settings.outboundSources.some((x) => same(x, source)) && (!settings.enquirySources.length || settings.enquirySources.some((x) => same(x, source)));
    const own = await tx.select().from(treatmentRules).orderBy(asc(treatmentRules.match));
    const conns = await tx
      .select({ id: integrations.id, name: integrations.name, config: integrations.config })
      .from(integrations)
      .where(sql`${integrations.kind}::text in (${sql.join(pullKinds().map((k) => sql`${k}`), sql`, `)})`)
      .orderBy(asc(integrations.createdAt));
    return {
      settings,
      own: (state?.settings ?? {}) as Record<string, unknown>,
      enabled: state?.enabled ?? false,
      canEnable: verticalOf(org?.vertical) === "health",
      statuses: (await seen(crmRecords.status)).map((s) => ({ status: s.value, records: s.n, list: statusListOf(s.value, settings) })),
      sources: (await seen(crmRecords.source)).map((s) => ({ source: s.value, records: s.n, enquiry: enquiry(s.value) })),
      centres: (await seen(crmRecords.centre)).map((s) => ({ centre: s.value, records: s.n })),
      modules: (await seen(crmRecords.module)).map((s) => ({ module: s.value, records: s.n })),
      rules: { own, defaults: [...(verticalOf(org?.vertical) === "health" ? DEFAULT_HEALTH_RULES : []), FALLBACK_RULE] },
      connections: conns.map((c) => {
        const theirs = (((c.config?.pull ?? {}) as Record<string, unknown>).fieldLabels ?? {}) as Record<string, unknown>;
        const ownLabels = ZOHO_PULL_ITEMS.filter((k) => Array.isArray(theirs[k]) && (theirs[k] as unknown[]).length);
        return { id: c.id, name: c.name, labels: Object.fromEntries(ZOHO_PULL_ITEMS.map((k) => [k, ownLabels.includes(k) ? (theirs[k] as unknown[]).map(String) : ZOHO_PULL_LABELS[k]])), ownLabels };
      }),
    };
  });
}

const same = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Puts one of their CRM's statuses in a status list, taking it out of the
 * others, or out of every list (null): the plan then says it does not know it.
 * The lists the client never changed start from the defaults.
 */
export function statusMoved(settings: PlanSettings, status: string, to: StatusList | null): Partial<Record<StatusList, string[]>> {
  const out: Partial<Record<StatusList, string[]>> = {};
  for (const list of STATUS_LISTS) {
    const had = settings[list];
    const without = had.filter((x) => !same(x, status));
    const next = list === to ? [...without, status] : without;
    if (next.length !== had.length || list === to) out[list] = next;
  }
  return out;
}

// ---------------------------------------------------------------- treatment timings

export interface TreatmentRuleInput {
  match: string;
  label?: string;
  feedbackAfterDays?: number | null;
  resultCheckAfterDays?: number | null;
  sessionIntervalDays?: number | null;
  courseSessions?: number | null;
  maintenanceAfterDays?: number | null;
}

const RULE_LIMITS: Record<Exclude<keyof TreatmentRuleInput, "match" | "label">, [number, number, string]> = {
  feedbackAfterDays: [0, 60, "Feedback after"],
  resultCheckAfterDays: [0, 365, "Result check after"],
  sessionIntervalDays: [1, 365, "Days between sessions"],
  courseSessions: [1, 50, "Sessions in a course"],
  maintenanceAfterDays: [1, 730, "Maintenance after"],
};

/** Why a treatment timing cannot be stored, in plain words, or null when it can. */
export function treatmentRuleProblem(r: TreatmentRuleInput): string | null {
  const match = r.match?.trim() ?? "";
  if (match.length < 2 || match.length > 60) return "Give the words to look for in the service name, 2 to 60 characters, such as hydrafacial.";
  for (const [k, [min, max, label]] of Object.entries(RULE_LIMITS)) {
    const v = r[k as keyof typeof RULE_LIMITS];
    if (v !== null && v !== undefined && !(Number.isInteger(v) && v >= min && v <= max)) return `${label} must be a whole number from ${min} to ${max}, or empty for none.`;
  }
  return null;
}

/**
 * Stores the clinic's own timing for a treatment (one per word to look for,
 * whatever its case), records who set it and plans again. The doctors'
 * timing then replaces JENAI's default wherever that treatment is planned.
 */
export async function setTreatmentRule(tenantId: string, r: TreatmentRuleInput, opts: SetPlanSettingOptions = {}): Promise<ReplanResult> {
  const problem = treatmentRuleProblem(r);
  if (problem) throw new PlanSwitchError(problem);
  const match = r.match.trim();
  const row = {
    label: (r.label?.trim() || match).slice(0, 80),
    feedbackAfterDays: r.feedbackAfterDays ?? null,
    resultCheckAfterDays: r.resultCheckAfterDays ?? null,
    sessionIntervalDays: r.sessionIntervalDays ?? null,
    courseSessions: r.courseSessions ?? null,
    maintenanceAfterDays: r.maintenanceAfterDays ?? null,
  };
  await withTenant(tenantId, async (tx) => {
    // treatment_rules_match is on lower(match), an expression an upsert cannot name.
    const [had] = await tx.select({ id: treatmentRules.id }).from(treatmentRules).where(sql`lower(${treatmentRules.match}) = lower(${match})`);
    if (had) await tx.update(treatmentRules).set({ ...row, match, updatedAt: new Date() }).where(eq(treatmentRules.id, had.id));
    else await tx.insert(treatmentRules).values({ tenantId, match, ...row });
    await audit(tx, { ...auditedBy(tenantId, opts), action: "call_plan.treatment_rule_set", targetType: "treatment_rule", targetId: match.toLowerCase(), summary: `Treatment timing for "${match}" set`, diff: { match, ...row } });
  });
  return replanTenant(tenantId, { now: opts.now });
}

/** Removes the clinic's own timing for a treatment: JENAI's default applies again. */
export async function removeTreatmentRule(tenantId: string, id: string, opts: SetPlanSettingOptions = {}): Promise<ReplanResult> {
  await withTenant(tenantId, async (tx) => {
    const [gone] = await tx.delete(treatmentRules).where(eq(treatmentRules.id, id)).returning({ match: treatmentRules.match });
    if (gone) await audit(tx, { ...auditedBy(tenantId, opts), action: "call_plan.treatment_rule_removed", targetType: "treatment_rule", targetId: gone.match.toLowerCase(), summary: `Treatment timing for "${gone.match}" removed` });
  });
  return replanTenant(tenantId, { now: opts.now });
}

// ---------------------------------------------------------------- their CRM's fields

/**
 * Sets the field labels one connection reads an item from (the label their
 * admin gave the field, or its API name), or puts back the defaults (null).
 * The next read reads every record again with the new fields.
 */
export async function setPullFieldLabels(tenantId: string, integrationId: string, item: string, labels: string[] | null, opts: SetPlanSettingOptions = {}): Promise<void> {
  if (!(ZOHO_PULL_ITEMS as readonly string[]).includes(item)) throw new PlanSwitchError(`"${item}" is not something the plan reads. It reads: ${ZOHO_PULL_ITEMS.join(", ")}.`);
  const clean = labels?.map((l) => l.trim()).filter((l) => l && l.length <= 80) ?? null;
  if (labels && !clean?.length) throw new PlanSwitchError("Give at least one field label, such as Clinic Branch.");
  await withTenant(tenantId, async (tx) => {
    const [i] = await tx.select({ config: integrations.config, name: integrations.name }).from(integrations).where(eq(integrations.id, integrationId));
    if (!i) throw new PlanSwitchError("No such connection.");
    const pull = { ...((i.config.pull ?? {}) as Record<string, unknown>) };
    const fieldLabels = { ...((pull.fieldLabels ?? {}) as Record<string, unknown>) };
    if (clean) fieldLabels[item] = clean;
    else delete fieldLabels[item];
    pull.fieldLabels = fieldLabels;
    await tx.update(integrations).set({ config: { ...i.config, pull }, nextPullAt: null, updatedAt: new Date() }).where(eq(integrations.id, integrationId));
    await audit(tx, {
      ...auditedBy(tenantId, opts),
      action: "call_plan.field_labels_set",
      targetType: "integration",
      targetId: integrationId,
      summary: clean ? `${i.name}: ${item} read from ${clean.join(", ")}` : `${i.name}: ${item} read from the default fields`,
      diff: { item, labels: clean },
    });
  });
}
