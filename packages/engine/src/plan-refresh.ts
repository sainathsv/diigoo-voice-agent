/**
 * Keeping the call plan current without anyone pressing a button: the
 * worker reads the CRM of each client who switched their plan on, on a timer
 * (claimPulls, pullAndPlan), and plans them again when a read brought
 * something new. Every client's plan is also worked out again on its own
 * clock, at least hourly, because a plan changes as days pass (claimReplans).
 * Also what the command line and the workspace use to look at a plan, switch
 * it on and change its settings.
 *
 * Still a preview: nothing here dials, creates campaign targets or writes to
 * a client's CRM.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { audit, callPlanSettings, integrations, organizations, plannedCalls, platformDb, tenantDatabases, withTenant, type AuditInput, type Db, type PlannedCallVerdict, type Tx } from "@jenai/db";
import { maskPhone } from "@jenai/authz";
import { errorText } from "./errors";
import { PULL_LEASE_MINUTES, changedIn, pullKinds, syncIntegration, type CrmSyncResult } from "./integrations/crm-sync";
import { PLAN_SETTING_KEYS, planSettingProblem, replanTenant, type PlanJourney, type PlanSettingKey, type ReplanResult } from "./care-plan";
import { effectiveVerdict } from "./plan-view";
import { visitColumnsProblem } from "./visits-import";

// ---------------------------------------------------------------- reading on a timer

/** Minutes between reads of a client's CRM when config.pull.intervalMinutes does not say. */
export const DEFAULT_PULL_INTERVAL_MINUTES = 10;
/**
 * The range config.pull.intervalMinutes may take. Zoho counts API credits
 * (api-limits): 1 for a page of records, 2 for the list of deleted records.
 * A read with nothing new costs 1 per module, and the hourly deletions check
 * 2 per module, so Leads and Contacts every 5 minutes cost about 2 x 288 +
 * 4 x 24 = 672 credits a day, inside even Zoho's free 5,000.
 */
const INTERVAL_LIMITS = [5, 1440] as const;
/** While a large CRM is still being read, the next read follows this soon, not at once. */
const REREAD_SECONDS = 30;
/** A connection that keeps failing is read at most this seldom. */
const MAX_BACKOFF_MINUTES = 24 * 60;
/** How long a worker holds a client's plan while it works it out again. */
const REPLAN_LEASE_MINUTES = 10;
/** After a plan that failed, the next try. */
const REPLAN_RETRY_MINUTES = 60;
/** Changes stored while a large read is still catching up are planned within this. */
const PLAN_SOON_MINUTES = 5;

/** How long after a read the next is due, from the connection's config.pull.intervalMinutes. */
export function pullIntervalMinutes(config: Record<string, unknown> | null | undefined): number {
  const v = ((config?.pull ?? {}) as Record<string, unknown>).intervalMinutes;
  return typeof v === "number" && Number.isInteger(v) && v >= INTERVAL_LIMITS[0] && v <= INTERVAL_LIMITS[1] ? v : DEFAULT_PULL_INTERVAL_MINUTES;
}

/**
 * A connection the worker reads on its own: working, of a kind that can be
 * read, not one that only receives call results, not switched off by the
 * client (config.pull.enabled false), and of a client who switched their
 * call plan on. Without that switch nothing is read: a client who connected
 * Zoho only for call results never has their records copied.
 */
function readOnSchedule(table: string): SQL {
  const kinds = pullKinds();
  if (!kinds.length) return sql`false`;
  const t = sql.raw(table);
  return sql`(${t}.status = 'connected' and ${t}.direction <> 'out' and ${t}.kind::text in (${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )}) and (${t}.config -> 'pull' -> 'enabled') is distinct from 'false'::jsonb
    and exists (select 1 from call_plan_settings s where s.tenant_id = ${t}.tenant_id and s.enabled))`;
}

/**
 * A client whose records are on this database and who is in use. On the
 * shared database, a client on their own database still has the rows copied
 * from here before the move; those are stale and are left alone. A client's
 * own database has no registry rows, so there the second part always holds;
 * whether that client is in use is checked against the shared registry
 * before their database is visited at all (acrossDatabases).
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
  if (limit <= 0) return [];
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
  /** Null when the plan was not worked out here: nothing new was read, the read is still catching up, or it did not run. */
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
   * A read the worker claimed with claimPulls: it holds the lease, the plan
   * is worked out only when the read brought something new and has caught
   * up (otherwise the client's own plan clock sees to it), and while a large
   * CRM is still being read the next read follows shortly. Without this (a
   * read asked for by hand) the lease is taken here and the plan is always
   * worked out.
   */
  scheduled?: boolean;
  now?: Date;
}

/**
 * Reads one connection's CRM, plans the client's calls again when that is
 * worth it, and sets when the next read is due: after
 * config.pull.intervalMinutes (default 10), longer after reads that failed in
 * a row, or shortly while the read is still moving through a backlog. Lets
 * go of the lease. A read that fails is recorded in last_pull_error; it
 * never stops the worker.
 */
export async function pullAndPlan(tenantId: string, integrationId: string, opts: PullAndPlanOptions = {}): Promise<PlanRefresh> {
  const scheduled = opts.scheduled === true;
  let sync: CrmSyncResult;
  try {
    sync = await syncIntegration(tenantId, integrationId, { pageBudget: opts.pageBudget, fetchImpl: opts.fetchImpl, leased: scheduled });
  } catch (e) {
    if (!scheduled) throw e;
    // Nothing was read; the lease is ours to let go of all the same.
    const error = `Reading stopped: ${errorText(e)}`.slice(0, 300);
    const nextPullAt = await finishPull(tenantId, integrationId, { more: false, release: true, error });
    return { sync: { ran: true, modules: [], pages: 0, done: false, error }, plan: null, planError: null, nextPullAt };
  }
  if (!sync.ran) return { sync, plan: null, planError: null, nextPullAt: null };

  // More to read at once: the run stopped at its budget while still moving
  // forward. A module that only ran out of budget, or a deletions check, waits
  // for the next interval: reading again at once would only repeat it.
  const more = !sync.done && !sync.error && sync.modules.some((m) => m.advanced);
  const changed = changedIn(sync);
  let plan: ReplanResult | null = null;
  let planError: string | null = null;
  if (!scheduled || (!more && changed > 0)) {
    try {
      plan = await replanTenant(tenantId, { now: opts.now });
    } catch (e) {
      planError = `The call plan could not be worked out: ${errorText(e)}`.slice(0, 300);
    }
  } else if (changed > 0) await planSoon(tenantId);
  const nextPullAt = await finishPull(tenantId, integrationId, { more, release: scheduled, planError });
  return { sync, plan, planError, nextPullAt };
}

/** Sets when the next read is due, lets go of the lease when asked, and records a problem the read itself did not. */
async function finishPull(tenantId: string, integrationId: string, o: { more: boolean; release: boolean; error?: string; planError?: string | null }): Promise<Date | null> {
  return withTenant(tenantId, async (tx) => {
    const [i] = await tx.select({ config: integrations.config, failures: integrations.pullFailures }).from(integrations).where(eq(integrations.id, integrationId));
    if (!i) return null;
    const failures = i.failures + (o.error ? 1 : 0);
    // Each failure in a row doubles the wait, up to a day.
    const seconds = o.more ? REREAD_SECONDS : Math.min(MAX_BACKOFF_MINUTES, pullIntervalMinutes(i.config) * 2 ** Math.min(failures, 8)) * 60;
    const problem = o.error
      ? { lastPullAt: new Date(), lastPullError: o.error, pullFailures: failures }
      : o.planError
        ? { lastPullError: sql<string>`left(concat_ws(' ', ${integrations.lastPullError}, ${o.planError}::text), 1000)` }
        : {};
    const [row] = await tx
      .update(integrations)
      .set({ nextPullAt: sql`now() + make_interval(secs => ${seconds})`, ...(o.release ? { pullLeaseUntil: null } : {}), ...problem })
      .where(eq(integrations.id, integrationId))
      .returning({ nextPullAt: integrations.nextPullAt });
    return row?.nextPullAt ?? null;
  });
}

/** Brings a client's plan forward on its clock: changes were stored that the plan has not taken in yet. */
async function planSoon(tenantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .update(callPlanSettings)
      .set({ nextReplanAt: sql`least(coalesce(${callPlanSettings.nextReplanAt}, now()), now() + make_interval(mins => ${PLAN_SOON_MINUTES}))` })
      .where(eq(callPlanSettings.tenantId, tenantId)),
  );
}

// ---------------------------------------------------------------- plans that age

/**
 * Takes up to `limit` clients whose plan is due to be worked out again, for
 * this worker, and holds them while it does: next_replan_at passed (set an
 * hour after each plan, brought forward when someone is added to a
 * do-not-call list or a large read stored changes) and nobody working on it
 * now. Any number of workers share the work without doing a client twice.
 * replanTenant lets go and sets the next time; deferReplan after a failure.
 */
export async function claimReplans(db: Db | Tx, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db.execute<{ tenant_id: string }>(sql`
    update call_plan_settings s set replan_lease_until = now() + make_interval(mins => ${REPLAN_LEASE_MINUTES})
    from (select c.tenant_id from call_plan_settings c
          where c.next_replan_at <= now()
            and (c.replan_lease_until is null or c.replan_lease_until < now())
            and ${servedHere("c.tenant_id")}
          order by c.next_replan_at
          limit ${limit} for update of c skip locked) q
    where s.tenant_id = q.tenant_id
    returning s.tenant_id`);
  return rows.map((r) => r.tenant_id);
}

/** A plan that failed is tried again in an hour, by whichever worker is free then, and lets go meanwhile. */
export async function deferReplan(tenantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx
      .update(callPlanSettings)
      .set({ nextReplanAt: sql`now() + make_interval(mins => ${REPLAN_RETRY_MINUTES})`, replanLeaseUntil: null })
      .where(eq(callPlanSettings.tenantId, tenantId)),
  );
}

// ---------------------------------------------------------------- every database

/** The migration the call plan's tables and clocks need (0027). A client's database behind it is left alone. */
export const PLAN_SCHEMA_VERSION = 27;
/** How long one client's own database may take, before the rest go on without it. */
const OWN_DB_TIMEOUT_MS = 20_000;
/** A client's own database that failed is left alone this long. */
const OWN_DB_BACKOFF_MS = 5 * 60_000;
const ownDbResting = new Map<string, number>();
const ownDbBehind = new Set<string>();

/**
 * Runs fn on the shared database, then inside withTenant on each client's own
 * database that is ready, so clients who keep their records on their own
 * server are kept current too. Only clients the shared registry has in use
 * (onboarding or active) are visited: their own copy of that row is not
 * kept up to date. Own databases are visited side by side, each with a time
 * limit; one that fails is reported and left alone for a few minutes, and one
 * whose schema is behind is reported once and skipped until it is migrated.
 * Errors name the client by the start of its id, never more.
 */
export async function acrossDatabases<T>(fn: (db: Db | Tx) => Promise<T[]>): Promise<{ rows: T[]; errors: string[] }> {
  const rows: T[] = [];
  const errors: string[] = [];
  try {
    rows.push(...(await fn(platformDb())));
  } catch (e) {
    errors.push(`shared database: ${errorText(e)}`.slice(0, 300));
  }
  const own = await platformDb()
    .select({ tenantId: tenantDatabases.tenantId, schemaVersion: tenantDatabases.schemaVersion })
    .from(tenantDatabases)
    .innerJoin(organizations, eq(organizations.id, tenantDatabases.tenantId))
    .where(and(eq(tenantDatabases.status, "ready"), eq(organizations.kind, "client"), inArray(organizations.status, ["onboarding", "active"])));
  const now = Date.now();
  const visit = own.filter(({ tenantId, schemaVersion }) => {
    if (schemaVersion < PLAN_SCHEMA_VERSION) {
      if (!ownDbBehind.has(tenantId)) errors.push(`client ${tenantId.slice(0, 8)}: their database is at schema ${schemaVersion}, behind the ${PLAN_SCHEMA_VERSION} the call plan needs; run tenant-db migrate for them.`);
      ownDbBehind.add(tenantId);
      return false;
    }
    ownDbBehind.delete(tenantId);
    return (ownDbResting.get(tenantId) ?? 0) <= now;
  });
  const settled = await Promise.allSettled(
    visit.map(({ tenantId }) =>
      timeLimit(
        withTenant(tenantId, async (tx) => {
          // SET takes no bound parameters; the value is a constant of ours.
          await tx.execute(sql.raw(`set local statement_timeout = ${Math.floor(OWN_DB_TIMEOUT_MS)}`));
          return fn(tx);
        }),
        OWN_DB_TIMEOUT_MS,
      ),
    ),
  );
  settled.forEach((s, k) => {
    const tenantId = visit[k]!.tenantId;
    if (s.status === "fulfilled") {
      rows.push(...s.value);
      ownDbResting.delete(tenantId);
    } else {
      ownDbResting.set(tenantId, now + OWN_DB_BACKOFF_MS);
      errors.push(`client ${tenantId.slice(0, 8)}: ${errorText(s.reason)}`.slice(0, 300));
    }
  });
  return { rows, errors };
}

function timeLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
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

/**
 * Counts per journey and verdict, and the next `upcoming` calls (default 20).
 * Someone added to a do-not-call list since the plan was worked out counts
 * as kept out at once.
 */
export async function planSummary(tenantId: string, opts: { upcoming?: number } = {}): Promise<PlanSummary> {
  return withTenant(tenantId, async (tx) => {
    const verdict = effectiveVerdict();
    const counts = await tx
      .select({ journey: plannedCalls.journey, verdict: sql<string>`${verdict}`, n: sql<number>`count(*)::int` })
      .from(plannedCalls)
      .groupBy(plannedCalls.journey, verdict);
    const [state] = await tx.select({ computedAt: callPlanSettings.computedAt }).from(callPlanSettings).where(eq(callPlanSettings.tenantId, tenantId));
    const next = await tx
      .select({ callAt: plannedCalls.callAt, journey: plannedCalls.journey, verdict: plannedCalls.verdict, phone: plannedCalls.phoneE164, origin: plannedCalls.originLabel })
      .from(plannedCalls)
      .where(inArray(verdict, ["call_now", "scheduled"]))
      .orderBy(asc(plannedCalls.callAt), desc(plannedCalls.priority), asc(plannedCalls.id))
      .limit(Math.max(0, opts.upcoming ?? 20));
    const byVerdict: Record<PlannedCallVerdict, number> = { call_now: 0, scheduled: 0, waiting: 0, kept_out: 0 };
    const byJourney: PlanSummary["byJourney"] = {};
    for (const c of counts) {
      const v = c.verdict as PlannedCallVerdict;
      byVerdict[v] += c.n;
      const j = (byJourney[c.journey as PlanJourney] ??= {});
      j[v] = (j[v] ?? 0) + c.n;
    }
    return {
      computedAt: state?.computedAt ?? null,
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
  /** The rest of the audit entry, from the web app: support sessions, address, browser. */
  audit?: Pick<AuditInput, "impersonatorUserId" | "ip" | "userAgent">;
  now?: Date;
}

/** The audit entry's who and how, from a setting change's options. */
export const auditedBy = (tenantId: string, opts: SetPlanSettingOptions) => ({
  tenantId,
  actorUserId: opts.actorUserId ?? null,
  impersonatorUserId: opts.audit?.impersonatorUserId ?? null,
  via: opts.via ?? (opts.audit?.impersonatorUserId ? ("support" as const) : opts.actorUserId ? ("user" as const) : ("system" as const)),
  ip: opts.audit?.ip ?? null,
  userAgent: opts.audit?.userAgent ?? null,
});

/**
 * Stores one setting in call_plan_settings (null puts it back to its
 * default), records who changed it, and plans the client's calls again so
 * the plan shows the change at once. Throws PlanSettingError for a key or
 * value the plan could not use.
 */
export async function setPlanSetting(tenantId: string, key: string, value: unknown, opts: SetPlanSettingOptions = {}): Promise<{ settings: Record<string, unknown>; plan: ReplanResult }> {
  return setPlanSettings(tenantId, { [key]: value }, opts);
}

/**
 * Stores several settings at once (null puts one back to its default), with
 * an audit entry each, and plans again once. Nothing is stored unless every
 * one of them can be.
 */
export async function setPlanSettings(tenantId: string, patch: Record<string, unknown>, opts: SetPlanSettingOptions = {}): Promise<{ settings: Record<string, unknown>; plan: ReplanResult }> {
  const entries = Object.entries(patch);
  if (!entries.length) throw new PlanSettingError("Nothing to change.");
  for (const [key, value] of entries) {
    const problem = checkPlanSetting(key, value);
    if (problem) throw new PlanSettingError(problem);
  }
  const settings = await withTenant(tenantId, async (tx) => {
    let settings: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      const merged = value === null ? sql`${callPlanSettings.settings} - ${key}::text` : sql`${callPlanSettings.settings} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`;
      const [row] = await tx
        .insert(callPlanSettings)
        .values({ tenantId, settings: value === null ? {} : { [key]: value } })
        .onConflictDoUpdate({ target: callPlanSettings.tenantId, set: { settings: merged, updatedAt: new Date() } })
        .returning({ settings: callPlanSettings.settings });
      settings = row!.settings;
      await audit(tx, {
        ...auditedBy(tenantId, opts),
        action: "call_plan.setting_changed",
        targetType: "call_plan_settings",
        targetId: key,
        summary: value === null ? `Call plan setting ${key} put back to its default` : `Call plan setting ${key} changed`,
        diff: { key, value },
      });
    }
    return settings;
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
