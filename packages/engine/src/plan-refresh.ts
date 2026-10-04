/**
 * Keeping the call plan current without anyone pressing a button: the
 * worker reads each client's CRM on a timer (claimPulls, pullAndPlan) and
 * plans everyone again after each read, and plans again, at most hourly,
 * the clients it does not read, because a plan changes as days pass
 * (plansToRefresh). Also what the command line and, later, the workspace
 * use to look at a plan and change its settings.
 *
 * Still a preview: nothing here dials, creates campaign targets or writes to
 * a client's CRM.
 */
import { asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { audit, callPlanSettings, integrations, plannedCalls, platformDb, tenantDatabases, withTenant, type Db, type PlannedCallVerdict, type Tx } from "@jenai/db";
import { maskPhone } from "@jenai/authz";
import { CONNECTORS } from "./integrations/queue";
import { PULL_LEASE_MINUTES, syncIntegration, type CrmSyncResult } from "./integrations/crm-sync";
import { PLAN_SETTING_KEYS, planSettingProblem, replanTenant, type PlanJourney, type PlanSettingKey, type ReplanResult } from "./care-plan";
import { visitColumnsProblem } from "./visits-import";

// ---------------------------------------------------------------- reading on a timer

/** Minutes between reads of a client's CRM when config.pull.intervalMinutes does not say. */
export const DEFAULT_PULL_INTERVAL_MINUTES = 10;
/**
 * The range config.pull.intervalMinutes may take. A read costs Zoho about
 * four API credits (a listing and a deletions check per module), so every
 * 5 minutes is about 1,200 a day, inside even Zoho's free 5,000.
 */
const INTERVAL_LIMITS = [5, 1440] as const;

/** How long after a read the next is due, from the connection's config.pull.intervalMinutes. */
export function pullIntervalMinutes(config: Record<string, unknown> | null | undefined): number {
  const v = ((config?.pull ?? {}) as Record<string, unknown>).intervalMinutes;
  return typeof v === "number" && Number.isInteger(v) && v >= INTERVAL_LIMITS[0] && v <= INTERVAL_LIMITS[1] ? v : DEFAULT_PULL_INTERVAL_MINUTES;
}

/** The kinds of connection JENAI can read records from. */
export function pullKinds(): string[] {
  return Object.entries(CONNECTORS)
    .filter(([, c]) => typeof c.pull === "function")
    .map(([kind]) => kind);
}

/**
 * A connection the worker reads on its own: working, of a kind that can be
 * read, and not switched off by the client (config.pull.enabled false).
 */
function readOnSchedule(table: string): SQL {
  const kinds = pullKinds();
  if (!kinds.length) return sql`false`;
  const t = sql.raw(table);
  return sql`(${t}.status = 'connected' and ${t}.kind::text in (${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )}) and (${t}.config -> 'pull' -> 'enabled') is distinct from 'false'::jsonb)`;
}

/**
 * A client whose records are on this database and who is in use. On the
 * shared database, a client on their own database still has the rows copied
 * from here before the move; those are stale and are left alone. A client's
 * own database has no registry rows, so there the second part always holds.
 */
function servedHere(tenantColumn: string): SQL {
  const t = sql.raw(tenantColumn);
  return sql`exists (select 1 from organizations o where o.id = ${t} and o.kind = 'client' and o.status in ('onboarding', 'active'))
    and not exists (select 1 from tenant_databases d where d.tenant_id = ${t} and d.status <> 'disabled')`;
}

export interface PullRef {
  tenantId: string;
  id: string;
}

/**
 * Takes up to `limit` connections due a read, for this worker, and holds
 * their lease while it reads them: never read, or next_pull_at passed, and
 * nobody reading them now. Any number of workers can share the work; a
 * connection another worker is taking is passed over, not waited for.
 * Longest waiting first, so a client with a long backlog takes turns.
 */
export async function claimPulls(db: Db | Tx, limit: number): Promise<PullRef[]> {
  const rows = await db.execute<{ tenant_id: string; id: string }>(sql`
    update integrations i set pull_lease_until = now() + make_interval(mins => ${PULL_LEASE_MINUTES})
    from (select c.tenant_id, c.id from integrations c
          where ${readOnSchedule("c")}
            and (c.next_pull_at is null or c.next_pull_at <= now())
            and (c.pull_lease_until is null or c.pull_lease_until < now())
            and ${servedHere("c.tenant_id")}
          order by c.next_pull_at nulls first
          limit ${limit} for update of c skip locked) q
    where i.tenant_id = q.tenant_id and i.id = q.id
    returning i.tenant_id, i.id`);
  return rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
}

/**
 * Leases left behind by a read that died (a worker stopped part way): the
 * connection is free and due again. Its cursor never ran ahead of what was
 * stored, so the next read carries on from there.
 */
export async function requeueStuckPulls(db: Db | Tx): Promise<number> {
  const r = await db.execute(sql`
    update integrations set pull_lease_until = null, next_pull_at = least(next_pull_at, now())
    where pull_lease_until < now()`);
  return (r as unknown as { count?: number }).count ?? 0;
}

export interface PlanRefresh {
  sync: CrmSyncResult;
  /** Null when the plan was left for later: the read is still catching up, or it did not run. */
  plan: ReplanResult | null;
  /** Why the plan could not be worked out, as also added to last_pull_error. */
  planError: string | null;
  /** When the next scheduled read is due. Null when this run did not read. */
  nextPullAt: Date | null;
}

export interface PullAndPlanOptions {
  pageBudget?: number;
  fetchImpl?: typeof fetch;
  /**
   * A read the worker claimed with claimPulls: it holds the lease, and while
   * a large CRM is still being read for the first time, the plan waits until
   * the read catches up rather than being worked out again after every few
   * pages. Without this (a read asked for by hand) the lease is taken here
   * and the plan is always worked out.
   */
  scheduled?: boolean;
  now?: Date;
}

/**
 * Reads one connection's CRM, plans the client's calls again, and sets when
 * the next read is due: after config.pull.intervalMinutes (default 10), or
 * at once while there is more to read. Lets go of the lease. A read that
 * fails is recorded in last_pull_error and tried again at the next interval;
 * it never stops the worker.
 */
export async function pullAndPlan(tenantId: string, integrationId: string, opts: PullAndPlanOptions = {}): Promise<PlanRefresh> {
  const scheduled = opts.scheduled === true;
  let sync: CrmSyncResult;
  try {
    sync = await syncIntegration(tenantId, integrationId, { pageBudget: opts.pageBudget, fetchImpl: opts.fetchImpl, leased: scheduled });
  } catch (e) {
    if (!scheduled) throw e;
    // Nothing was read; the lease is ours to let go of all the same.
    const error = `Reading stopped: ${(e as Error).message}`.slice(0, 300);
    const nextPullAt = await finishPull(tenantId, integrationId, { more: false, release: true, error });
    return { sync: { ran: true, modules: [], pages: 0, done: false, error }, plan: null, planError: null, nextPullAt };
  }
  if (!sync.ran) return { sync, plan: null, planError: null, nextPullAt: null };

  // More to read: the run stopped at its page budget, not at an error or the end.
  const more = !sync.done && !sync.error && sync.pages > 0;
  let plan: ReplanResult | null = null;
  let planError: string | null = null;
  if (!(scheduled && more)) {
    try {
      plan = await replanTenant(tenantId, { now: opts.now });
    } catch (e) {
      planError = `The call plan could not be worked out: ${(e as Error).message}`.slice(0, 300);
    }
  }
  const nextPullAt = await finishPull(tenantId, integrationId, { more, release: scheduled, planError });
  return { sync, plan, planError, nextPullAt };
}

/** Sets when the next read is due, lets go of the lease when asked, and records a problem the read itself did not. */
async function finishPull(tenantId: string, integrationId: string, o: { more: boolean; release: boolean; error?: string; planError?: string | null }): Promise<Date | null> {
  return withTenant(tenantId, async (tx) => {
    const [i] = await tx.select({ config: integrations.config }).from(integrations).where(eq(integrations.id, integrationId));
    if (!i) return null;
    const minutes = o.more ? 0 : pullIntervalMinutes(i.config);
    const problem = o.error
      ? { lastPullAt: new Date(), lastPullError: o.error }
      : o.planError
        ? { lastPullError: sql<string>`left(concat_ws(' ', ${integrations.lastPullError}, ${o.planError}::text), 1000)` }
        : {};
    const [row] = await tx
      .update(integrations)
      .set({ nextPullAt: sql`now() + make_interval(mins => ${minutes})`, ...(o.release ? { pullLeaseUntil: null } : {}), ...problem })
      .where(eq(integrations.id, integrationId))
      .returning({ nextPullAt: integrations.nextPullAt });
    return row?.nextPullAt ?? null;
  });
}

// ---------------------------------------------------------------- plans that age

/**
 * Clients whose plan is over `olderThanMinutes` old (default an hour) and
 * that no read due now will plan again: they have visits or a plan, and no
 * connection the worker reads is due or being read. A reminder due tomorrow
 * evening becomes a call to make now without anything in their records
 * changing. Oldest plan first.
 */
export async function plansToRefresh(db: Db | Tx, limit: number, olderThanMinutes = 60): Promise<string[]> {
  const rows = await db.execute<{ tenant_id: string }>(sql`
    select o.id as tenant_id
    from organizations o
    left join lateral (select p.computed_at from planned_calls p where p.tenant_id = o.id limit 1) last on true
    where ${servedHere("o.id")}
      and (last.computed_at is not null or exists (select 1 from visits v where v.tenant_id = o.id))
      and (last.computed_at is null or last.computed_at < now() - make_interval(mins => ${olderThanMinutes}))
      and not exists (select 1 from integrations i
                      where i.tenant_id = o.id and ${readOnSchedule("i")}
                        and (i.next_pull_at is null or i.next_pull_at <= now() or i.pull_lease_until > now()))
    order by last.computed_at nulls first
    limit ${limit}`);
  return rows.map((r) => r.tenant_id);
}

// ---------------------------------------------------------------- every database

/**
 * Runs fn on the shared database, then inside withTenant on each client's own
 * database that is ready, so clients who keep their records on their own
 * server are kept current too. A database that fails is reported and the
 * rest still run. Errors name the client by the start of its id, never more.
 */
export async function acrossDatabases<T>(fn: (db: Db | Tx) => Promise<T[]>): Promise<{ rows: T[]; errors: string[] }> {
  const rows: T[] = [];
  const errors: string[] = [];
  try {
    rows.push(...(await fn(platformDb())));
  } catch (e) {
    errors.push(`shared database: ${(e as Error).message}`.slice(0, 300));
  }
  const own = await platformDb().select({ tenantId: tenantDatabases.tenantId }).from(tenantDatabases).where(eq(tenantDatabases.status, "ready"));
  for (const { tenantId } of own) {
    try {
      rows.push(...(await withTenant(tenantId, (tx) => fn(tx))));
    } catch (e) {
      errors.push(`client ${tenantId.slice(0, 8)}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  return { rows, errors };
}

// ---------------------------------------------------------------- looking at a plan

export interface PlanSummary {
  /** When the plan was last worked out. Null when there is none yet. */
  computedAt: Date | null;
  rows: number;
  byVerdict: Record<PlannedCallVerdict, number>;
  byJourney: Partial<Record<PlanJourney, Partial<Record<PlannedCallVerdict, number>>>>;
  /**
   * The next calls JENAI would make, soonest first. The number is masked and
   * no name or reason is included: a reason can name a treatment or doctor.
   */
  next: Array<{ callAt: Date | null; journey: PlanJourney; verdict: PlannedCallVerdict; phone: string; origin: string }>;
}

/** Counts per journey and verdict, and the next `upcoming` calls (default 20). */
export async function planSummary(tenantId: string, opts: { upcoming?: number } = {}): Promise<PlanSummary> {
  return withTenant(tenantId, async (tx) => {
    const counts = await tx
      .select({ journey: plannedCalls.journey, verdict: plannedCalls.verdict, n: sql<number>`count(*)::int`, at: sql<Date | null>`max(${plannedCalls.computedAt})`.mapWith(plannedCalls.computedAt) })
      .from(plannedCalls)
      .groupBy(plannedCalls.journey, plannedCalls.verdict);
    const next = await tx
      .select({ callAt: plannedCalls.callAt, journey: plannedCalls.journey, verdict: plannedCalls.verdict, phone: plannedCalls.phoneE164, origin: plannedCalls.originLabel })
      .from(plannedCalls)
      .where(inArray(plannedCalls.verdict, ["call_now", "scheduled"]))
      .orderBy(asc(plannedCalls.callAt), desc(plannedCalls.priority), asc(plannedCalls.id))
      .limit(Math.max(0, opts.upcoming ?? 20));
    const byVerdict: Record<PlannedCallVerdict, number> = { call_now: 0, scheduled: 0, waiting: 0, kept_out: 0 };
    const byJourney: PlanSummary["byJourney"] = {};
    let computedAt: Date | null = null;
    for (const c of counts) {
      const verdict = c.verdict as PlannedCallVerdict;
      byVerdict[verdict] += c.n;
      const j = (byJourney[c.journey as PlanJourney] ??= {});
      j[verdict] = (j[verdict] ?? 0) + c.n;
      if (c.at && (!computedAt || c.at > computedAt)) computedAt = c.at;
    }
    return {
      computedAt,
      rows: counts.reduce((n, c) => n + c.n, 0),
      byVerdict,
      byJourney,
      next: next.map((r) => ({ callAt: r.callAt, journey: r.journey as PlanJourney, verdict: r.verdict as PlannedCallVerdict, phone: maskPhone(r.phone), origin: r.origin })),
    };
  });
}

// ---------------------------------------------------------------- settings

/** Every key of call_plan_settings.settings that can be set: the plan's own, and the visit list's column names. */
export const SETTABLE_PLAN_KEYS: readonly string[] = [...PLAN_SETTING_KEYS, "visitColumns"];

/** A setting refused, with the reason in plain words. */
export class PlanSettingError extends Error {}

/** Why this value cannot be stored under this key, in plain words, or null when it can. */
export function checkPlanSetting(key: string, value: unknown): string | null {
  if (key === "timezone") return "The time zone is the organisation's own and is changed with its details, not here.";
  if (!SETTABLE_PLAN_KEYS.includes(key)) return `"${key}" is not a call plan setting. The settings are: ${SETTABLE_PLAN_KEYS.join(", ")}.`;
  if (value === null) return null; // back to the default
  return key === "visitColumns" ? visitColumnsProblem(value) : planSettingProblem(key as PlanSettingKey, value);
}

export interface SetPlanSettingOptions {
  actorUserId?: string | null;
  via?: "user" | "support" | "api" | "system";
  now?: Date;
}

/**
 * Stores one setting in call_plan_settings (null puts it back to its
 * default), records who changed it, and plans the client's calls again so
 * the plan shows the change at once. Throws PlanSettingError for a key or
 * value the plan could not use.
 */
export async function setPlanSetting(tenantId: string, key: string, value: unknown, opts: SetPlanSettingOptions = {}): Promise<{ settings: Record<string, unknown>; plan: ReplanResult }> {
  const problem = checkPlanSetting(key, value);
  if (problem) throw new PlanSettingError(problem);
  const settings = await withTenant(tenantId, async (tx) => {
    const merged = value === null ? sql`${callPlanSettings.settings} - ${key}::text` : sql`${callPlanSettings.settings} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`;
    const [row] = await tx
      .insert(callPlanSettings)
      .values({ tenantId, settings: value === null ? {} : { [key]: value } })
      .onConflictDoUpdate({ target: callPlanSettings.tenantId, set: { settings: merged, updatedAt: new Date() } })
      .returning({ settings: callPlanSettings.settings });
    await audit(tx, {
      tenantId,
      actorUserId: opts.actorUserId ?? null,
      via: opts.via ?? (opts.actorUserId ? "user" : "system"),
      action: "call_plan.setting_changed",
      targetType: "call_plan_settings",
      targetId: key,
      summary: value === null ? `Call plan setting ${key} put back to its default` : `Call plan setting ${key} changed`,
      diff: { key, value },
    });
    return row!.settings;
  });
  const plan = await replanTenant(tenantId, { now: opts.now });
  return { settings, plan };
}

/** A client's connections JENAI can read records from, oldest first. */
export async function pullableConnections(tenantId: string): Promise<Array<{ id: string; name: string; status: string; kind: string }>> {
  const kinds = pullKinds();
  if (!kinds.length) return [];
  return withTenant(tenantId, (tx) =>
    tx
      .select({ id: integrations.id, name: integrations.name, status: integrations.status, kind: integrations.kind })
      .from(integrations)
      .where(inArray(sql<string>`${integrations.kind}::text`, kinds))
      .orderBy(asc(integrations.createdAt)),
  );
}
