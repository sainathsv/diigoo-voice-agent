/**
 * The call plan as a workspace page shows it: where it comes from (the CRM
 * connections JENAI reads and the visit list), counts per verdict and kind
 * of call, and one page of rows with filters. Read only; numbers are always
 * masked to the last 4 digits, because the page lists everyone a client has
 * on record.
 *
 * Someone added to a do-not-call list since the plan was worked out shows as
 * kept out at once, by the plan's own rule, without waiting for the next plan.
 */
import { and, asc, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { maskPhone } from "@jenai/authz";
import { PLANNED_CALL_VERDICTS, auditEvents, callPlanSettings, contacts, crmRecords, integrations, organizations, plannedCalls, user, visits, withTenant, type PlannedCallVerdict } from "@jenai/db";
import { PLAN_JOURNEYS, PROGRAM_PURPOSE, planSettingsOf, suppressionText, type PlanJourney, type SuppressionReason } from "./care-plan";
import type { Windows } from "./dialer/time";
import { pullKinds } from "./integrations/crm-sync";
import { verticalOf } from "./safety/cases";

/** Rows per page. */
export const PLAN_VIEW_PAGE = 50;

const VERDICTS = new Set<string>(PLANNED_CALL_VERDICTS);
/** How far back the audit log is searched for a visit list upload that stored nothing. */
const UPLOAD_LOOKBACK_MS = 30 * 86_400_000;

/**
 * The live do-not-call entry that stops a planned call now, by the plan's
 * rule (care-plan suppressionFor, which is the dialer's): never the DND
 * register, since no planned call is promotional; an entry with a scope only
 * for calls of that purpose. Null when none does.
 */
export function stoppedBy(): SQL<SuppressionReason | null> {
  // Written out, not bound: the same text in a select and its group by, and every value is a constant of ours.
  const purpose = sql.raw(
    Object.entries(PROGRAM_PURPOSE)
      .filter(([program]) => /^[a-z0-9_.]+$/.test(program))
      .map(([program, p]) => `when '${program}' then '${p}'`)
      .join(" "),
  );
  return sql<SuppressionReason | null>`(select s.reason::text from suppressions s
    where s.phone_e164 = ${plannedCalls.phoneE164}
      and (s.expires_at is null or s.expires_at > now())
      and s.reason <> 'dnd_registry'
      and (s.scope is null or s.scope::text = (case ${plannedCalls.programKey} ${purpose} else 'service' end))
    order by array_position(array['opt_out', 'complaint', 'legal', 'wrong_number']::text[], s.reason::text)
    limit 1)`;
}

/** A planned call's verdict as it stands now: kept out when a do-not-call entry stops it. */
export function effectiveVerdict(): SQL<string> {
  return sql<string>`(case when ${stoppedBy()} is not null then 'kept_out' else ${plannedCalls.verdict} end)`;
}

/** Due calls first, then what has a time, then what waits, then who is kept out. */
const VERDICT_RANK = (v: SQL) => sql`case ${v} when 'call_now' then 0 when 'scheduled' then 1 when 'waiting' then 2 else 3 end`;

export interface PlanViewRow {
  id: string;
  name: string | null;
  /** Masked to the last 4 digits; empty when the record has no usable number. */
  phone: string;
  journey: string;
  verdict: PlannedCallVerdict;
  reason: string;
  callAt: Date | null;
  /** "Zoho Lead", "Zoho Contact", "Visit list" */
  from: string;
  originType: string;
  /** For a CRM record: its status and the treatment asked about. */
  status: string | null;
  treatment: string | null;
  /** For a visit: the service taken and its day ("2026-10-01"). */
  service: string | null;
  visitDate: string | null;
}

export interface PlanViewSource {
  id: string;
  name: string;
  kind: string;
  status: string;
  /** False when the client switched reading off for this connection (config.pull.enabled). */
  reading: boolean;
  lastPullAt: Date | null;
  lastPullError: string | null;
  /** What the last read passed over or noticed. */
  lastPullNotes: string[];
  /** When the worker reads it next, when it does. */
  nextPullAt: Date | null;
  /** Records held from it, per module: { Leads: 1200, Contacts: 300 }. */
  held: Record<string, number>;
}

export interface PlanView {
  sources: PlanViewSource[];
  visits: { total: number; lastUpload: { at: Date; by: string | null; added: number; updated: number; refused: number; batch: string | null } | null };
  /** The client switched their plan on: their CRM is read on a timer. */
  enabled: boolean;
  /** The plan can be switched on for this workspace: it knows clinic calls only for now. */
  canEnable: boolean;
  /** When the plan was last worked out. Null when there is none yet. */
  computedAt: Date | null;
  /** The calling hours the plan keeps to, and the client's time zone, for showing when a due call goes. */
  callingWindow: Windows;
  timezone: string;
  byVerdict: Record<PlannedCallVerdict, number>;
  /** Kinds of call with at least one row, in the plan's own order. */
  byJourney: Array<{ journey: PlanJourney; label: string; total: number } & Record<PlannedCallVerdict, number>>;
  rows: PlanViewRow[];
  /** Rows matching the filters, for the pager. */
  total: number;
  page: number;
  /** The filters used: values not known to the plan are dropped. */
  journey: PlanJourney | undefined;
  verdict: PlannedCallVerdict | undefined;
}

export interface PlanViewOptions {
  journey?: string;
  verdict?: string;
  page?: number;
  /** Branches the viewer may see, or "all". Default "all". */
  branchIds?: readonly string[] | "all";
}

const zero = (): Record<PlannedCallVerdict, number> => ({ call_now: 0, scheduled: 0, waiting: 0, kept_out: 0 });

/**
 * One page of a client's call plan with its sources and counts. Filters may
 * come straight from a URL: only known kinds of call and verdicts are used.
 *
 * A viewer limited to some branches sees the rows of people in them: a
 * visit's own branch, otherwise the person's contact's. A CRM record of
 * someone with no contact in a branch is shown only to viewers of every branch.
 */
export async function planView(tenantId: string, opts: PlanViewOptions = {}): Promise<PlanView> {
  const branches = opts.branchIds ?? "all";
  const journey = opts.journey && Object.hasOwn(PLAN_JOURNEYS, opts.journey) ? (opts.journey as PlanJourney) : undefined;
  const verdict = opts.verdict && VERDICTS.has(opts.verdict) ? (opts.verdict as PlannedCallVerdict) : undefined;
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(opts.page) || 1)));
  const kinds = pullKinds();

  return withTenant(tenantId, async (tx) => {
    // ---- where the plan comes from
    const conns = kinds.length
      ? await tx
          .select({
            id: integrations.id,
            name: integrations.name,
            kind: integrations.kind,
            status: integrations.status,
            config: integrations.config,
            lastPullAt: integrations.lastPullAt,
            lastPullError: integrations.lastPullError,
            lastPullNotes: integrations.lastPullNotes,
            nextPullAt: integrations.nextPullAt,
          })
          .from(integrations)
          .where(inArray(sql<string>`${integrations.kind}::text`, kinds))
          .orderBy(asc(integrations.createdAt))
      : [];
    const held = conns.length
      ? await tx
          .select({ integrationId: crmRecords.integrationId, module: crmRecords.module, n: sql<number>`count(*)::int` })
          .from(crmRecords)
          .where(isNull(crmRecords.deletedAt))
          .groupBy(crmRecords.integrationId, crmRecords.module)
          .orderBy(crmRecords.module)
      : [];
    const sources: PlanViewSource[] = conns.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: c.status,
      reading: ((c.config?.pull ?? {}) as Record<string, unknown>).enabled !== false,
      lastPullAt: c.lastPullAt,
      lastPullError: c.lastPullError,
      lastPullNotes: Array.isArray(c.lastPullNotes) ? c.lastPullNotes : [],
      nextPullAt: c.nextPullAt,
      held: Object.fromEntries(held.filter((h) => h.integrationId === c.id).map((h) => [h.module, h.n])),
    }));
    const [org] = await tx.select({ timezone: organizations.timezone, vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, tenantId));
    const [state] = await tx
      .select({ settings: callPlanSettings.settings, enabled: callPlanSettings.enabled, computedAt: callPlanSettings.computedAt })
      .from(callPlanSettings)
      .where(eq(callPlanSettings.tenantId, tenantId));
    const settings = planSettingsOf(state?.settings, org?.timezone ?? "Asia/Kolkata");

    const [v] = await tx
      .select({ total: sql<number>`count(*)::int`, changed: sql<Date | null>`max(${visits.updatedAt}) filter (where ${visits.source} = 'upload')`.mapWith(visits.updatedAt) })
      .from(visits);
    // The audit log is long. An upload's entry is written in the same
    // transaction as the visits it stores, so the search goes back only to the
    // last stored change, or a month when nothing uploaded is stored (an
    // upload whose every row was refused).
    const since = v?.changed ? new Date(v.changed.getTime() - 60_000) : new Date(Date.now() - UPLOAD_LOOKBACK_MS);
    const [up] = await tx
      .select({ at: auditEvents.createdAt, diff: auditEvents.diff, via: auditEvents.via, by: user.name, batch: auditEvents.targetId })
      .from(auditEvents)
      .leftJoin(user, eq(user.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.action, "visits.imported"), gte(auditEvents.createdAt, since)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    const d = (up?.diff ?? {}) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === "number" ? x : 0);
    const lastUpload = up ? { at: up.at, by: up.via === "support" ? "JENAI support" : (up.by ?? null), added: num(d.added), updated: num(d.updated), refused: num(d.rejected), batch: up.batch } : null;

    // ---- the plan, within the viewer's branches, as it stands now
    const visitJoin = and(eq(plannedCalls.originType, "visit"), eq(visits.tenantId, plannedCalls.tenantId), eq(visits.id, plannedCalls.originId));
    const contactJoin = and(eq(contacts.tenantId, plannedCalls.tenantId), eq(contacts.id, plannedCalls.contactId));
    const scope: SQL | undefined = branches === "all" ? undefined : branches.length ? inArray(sql`coalesce(${visits.branchId}, ${contacts.branchId})`, [...branches]) : sql`false`;
    const current = effectiveVerdict();

    const counts = await tx
      .select({ journey: plannedCalls.journey, verdict: sql<string>`${current}`, n: sql<number>`count(*)::int` })
      .from(plannedCalls)
      .leftJoin(visits, visitJoin)
      .leftJoin(contacts, contactJoin)
      .where(scope)
      .groupBy(plannedCalls.journey, current);
    const byVerdict = zero();
    const perJourney = new Map<string, Record<PlannedCallVerdict, number>>();
    let total = 0;
    for (const c of counts) {
      const vd = c.verdict as PlannedCallVerdict;
      byVerdict[vd] += c.n;
      if (!perJourney.has(c.journey)) perJourney.set(c.journey, zero());
      perJourney.get(c.journey)![vd] += c.n;
      if ((!journey || c.journey === journey) && (!verdict || vd === verdict)) total += c.n;
    }
    const byJourney = (Object.keys(PLAN_JOURNEYS) as PlanJourney[])
      .filter((j) => perJourney.has(j))
      .map((j) => {
        const n = perJourney.get(j)!;
        return { journey: j, label: PLAN_JOURNEYS[j].label, total: n.call_now + n.scheduled + n.waiting + n.kept_out, ...n };
      });

    const list = total
      ? await tx
          .select({
            id: plannedCalls.id,
            name: plannedCalls.name,
            phone: plannedCalls.phoneE164,
            journey: plannedCalls.journey,
            verdict: plannedCalls.verdict,
            stop: stoppedBy(),
            reason: plannedCalls.reason,
            callAt: plannedCalls.callAt,
            from: plannedCalls.originLabel,
            originType: plannedCalls.originType,
            status: crmRecords.status,
            treatment: crmRecords.treatment,
            service: visits.service,
            visitDate: visits.visitDate,
          })
          .from(plannedCalls)
          .leftJoin(crmRecords, and(eq(plannedCalls.originType, "crm_record"), eq(crmRecords.tenantId, plannedCalls.tenantId), eq(crmRecords.id, plannedCalls.originId)))
          .leftJoin(visits, visitJoin)
          .leftJoin(contacts, contactJoin)
          .where(and(scope, journey ? eq(plannedCalls.journey, journey) : undefined, verdict ? sql`${current} = ${verdict}` : undefined))
          .orderBy(VERDICT_RANK(current), asc(plannedCalls.callAt), desc(plannedCalls.priority), asc(plannedCalls.id))
          .limit(PLAN_VIEW_PAGE)
          .offset((page - 1) * PLAN_VIEW_PAGE)
      : [];
    const rows: PlanViewRow[] = list.map(({ stop, ...r }) =>
      stop ? { ...r, verdict: "kept_out" as const, reason: suppressionText(stop), callAt: null, phone: maskPhone(r.phone) } : { ...r, phone: maskPhone(r.phone) },
    );

    return {
      sources,
      visits: { total: v?.total ?? 0, lastUpload },
      enabled: state?.enabled ?? false,
      canEnable: verticalOf(org?.vertical) === "health",
      computedAt: state?.computedAt ?? null,
      callingWindow: settings.callingWindow,
      timezone: settings.timezone,
      byVerdict,
      byJourney,
      rows,
      total,
      page,
      journey,
      verdict,
    };
  });
}
