import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { crmRecords, integrations, organizations, withTenant, type Integration, type Tx } from "@jenai/db";
import { CONNECTORS, credentialsOf, saver } from "./queue";
import type { ConnectorContext, PullResult, PulledRecord } from "./types";

/**
 * Reading a client's CRM into crm_records, for the call plan. Read only:
 * nothing is written to their system. Each module is read from where it got
 * to last time (integrations.pull_cursor), and the cursor moves in the same
 * transaction that stores the records, so a run that dies part way repeats
 * at most what it had not yet stored.
 *
 * Their free-text notes never reach the database: the connector hands over
 * only values read out of them.
 */

/** Requests for records one run makes when the caller does not say: up to 2,000 changed records. */
const DEFAULT_PAGE_BUDGET = 10;
/** Long enough for a run's requests. A worker that dies lets go of the connection after this. */
const LEASE_MINUTES = 15;
/** Rows per insert statement. */
const CHUNK = 200;

export interface ModuleSync {
  module: string;
  /** Records read and stored. */
  read: number;
  /** Deletions their system reported. */
  deleted: number;
  /** Caught up: nothing more to read until something changes there. */
  done: boolean;
  skipped?: string;
  error?: string;
  notes?: string[];
}

export interface CrmSyncResult {
  /** False when another run was reading this connection already, so this one left it alone. */
  ran: boolean;
  modules: ModuleSync[];
  /** Requests for records made, against the page budget. */
  pages: number;
  /** Every module caught up. */
  done: boolean;
  /** What went wrong or was left out, in plain words, as stored in last_pull_error. */
  error: string | null;
}

/**
 * Reads what changed in each module of one connection's CRM since the last
 * run (config.pull.modules, else the connector's own list, for Zoho Leads
 * then Contacts) into crm_records, within a budget of requests shared by the
 * modules in order. Records last_pull_at and last_pull_error on the connection.
 *
 * Holds the connection's pull lease while it runs, so a second run started
 * meanwhile returns at once with ran: false.
 */
export async function syncIntegration(tenantId: string, integrationId: string, opts: { pageBudget?: number; fetchImpl?: typeof fetch } = {}): Promise<CrmSyncResult> {
  const taken = await takePullLease(tenantId, integrationId);
  if (!taken) return { ran: false, modules: [], pages: 0, done: false, error: null };
  const { i, timeZone } = taken;

  const result: CrmSyncResult = { ran: true, modules: [], pages: 0, done: false, error: null };
  const problems: string[] = [];
  try {
    const connector = CONNECTORS[i.kind];
    if (!connector?.pull) problems.push("JENAI cannot read records from this kind of system yet.");
    else if (i.status === "paused") problems.push("The connection is paused, so nothing was read.");
    else {
      const ctx: ConnectorContext = {
        integration: i,
        credentials: credentialsOf(i),
        fetch: opts.fetchImpl ?? fetch,
        // A refreshed token or a refused scope is kept at once, in its own transaction.
        save: (patch) => withTenant(tenantId, (tx) => saver(tx, tenantId, i)(patch)),
      };
      let budget = Math.max(0, Math.floor(opts.pageBudget ?? DEFAULT_PAGE_BUDGET));
      for (const module of modulesOf(i, connector.pullModules)) {
        if (budget <= 0) {
          result.modules.push({ module, read: 0, deleted: 0, done: false });
          continue;
        }
        let r: PullResult;
        try {
          r = await connector.pull(ctx, { module, cursor: cursorOf(i, module), pageBudget: budget, timeZone });
        } catch (e) {
          r = { records: [], deleted: [], cursor: cursorOf(i, module), done: false, pages: 0, error: `Reading ${module} stopped: ${(e as Error).message}`.slice(0, 300) };
        }
        budget -= r.pages;
        result.pages += r.pages;
        let read = 0;
        try {
          read = await withTenant(tenantId, (tx) => store(tx, tenantId, i.id, module, r));
        } catch (e) {
          // Nothing of this read was kept and its cursor did not move: the next run reads it again.
          r = { ...r, done: false, error: `${module} could not be stored: ${(e as Error).message}`.slice(0, 300) };
        }
        result.modules.push({ module, read, deleted: r.deleted.length, done: r.done, skipped: r.skipped, error: r.error, notes: r.notes?.length ? r.notes : undefined });
        if (r.skipped) problems.push(r.skipped);
        if (r.error) problems.push(r.error);
      }
      result.done = result.modules.length > 0 && result.modules.every((m) => m.done);
    }
  } catch (e) {
    problems.push(`Reading stopped: ${(e as Error).message}`.slice(0, 300));
  } finally {
    result.error = problems.length ? problems.join(" ").slice(0, 1000) : null;
    await endPull(tenantId, i.id, result.error);
  }
  return result;
}

/**
 * Takes a connection's pull lease, so one run reads it at a time: null when
 * another run holds it. Throws when the client has no such connection.
 */
export async function takePullLease(tenantId: string, integrationId: string): Promise<{ i: Integration; timeZone: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const [i] = await tx
      .update(integrations)
      .set({ pullLeaseUntil: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
      .where(and(eq(integrations.id, integrationId), or(isNull(integrations.pullLeaseUntil), lt(integrations.pullLeaseUntil, sql`now()`))))
      .returning();
    if (!i) {
      const [there] = await tx.select({ id: integrations.id }).from(integrations).where(eq(integrations.id, integrationId));
      if (!there) throw new Error("No such connection for this client");
      return null;
    }
    const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, tenantId));
    return { i, timeZone: org?.timezone ?? "Asia/Kolkata" };
  });
}

/** Lets go of the pull lease and records when the run ended and what went wrong, in plain words. */
export async function endPull(tenantId: string, integrationId: string, error: string | null): Promise<void> {
  await withTenant(tenantId, (tx) => tx.update(integrations).set({ lastPullAt: new Date(), lastPullError: error, pullLeaseUntil: null }).where(eq(integrations.id, integrationId)));
}

function modulesOf(i: Integration, fallback: string[] | undefined): string[] {
  const pull = (i.config.pull ?? {}) as Record<string, unknown>;
  const theirs = Array.isArray(pull.modules) ? pull.modules.map(String).filter(Boolean) : [];
  return [...new Set(theirs.length ? theirs : (fallback ?? []))];
}

function cursorOf(i: Integration, module: string): Record<string, unknown> {
  const c = i.pullCursor?.[module];
  return c && typeof c === "object" ? (c as Record<string, unknown>) : {};
}

/**
 * The newest copy of each record. Zoho can hand the same record twice in one
 * read (changed again while it was being paged), and one insert cannot update
 * the same row twice.
 */
function newestOnly(records: PulledRecord[]): PulledRecord[] {
  const by = new Map<string, PulledRecord>();
  for (const r of records) {
    const key = `${r.module}\u0000${r.externalId}`;
    const had = by.get(key);
    if (!had || !had.modifiedAt || (r.modifiedAt && r.modifiedAt >= had.modifiedAt)) by.set(key, r);
  }
  return [...by.values()];
}

/**
 * Stores one module's read and moves its cursor, together. A copy older than
 * the one stored never replaces it, and a record listed again is live again.
 * A deletion is marked only on a record not changed after it.
 */
async function store(tx: Tx, tenantId: string, integrationId: string, module: string, r: PullResult): Promise<number> {
  const rows = newestOnly(r.records);
  for (let n = 0; n < rows.length; n += CHUNK) {
    await tx
      .insert(crmRecords)
      .values(
        rows.slice(n, n + CHUNK).map((x) => ({
          tenantId,
          integrationId,
          module: x.module,
          externalId: x.externalId,
          phoneE164: x.phone,
          name: x.name,
          status: x.status,
          source: x.source,
          centre: x.centre,
          createdExt: x.createdAt,
          modifiedExt: x.modifiedAt,
          appointmentAt: x.appointmentAt,
          followUpAt: x.followUpAt,
          treatment: x.treatment,
          consultant: x.consultant,
        })),
      )
      .onConflictDoUpdate({
        target: [crmRecords.tenantId, crmRecords.integrationId, crmRecords.module, crmRecords.externalId],
        set: {
          phoneE164: sql`excluded.phone_e164`,
          name: sql`excluded.name`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          centre: sql`excluded.centre`,
          createdExt: sql`excluded.created_ext`,
          modifiedExt: sql`excluded.modified_ext`,
          appointmentAt: sql`excluded.appointment_at`,
          followUpAt: sql`excluded.follow_up_at`,
          treatment: sql`excluded.treatment`,
          consultant: sql`excluded.consultant`,
          deletedAt: null,
          syncedAt: sql`now()`,
        },
        setWhere: sql`${crmRecords.modifiedExt} is null or excluded.modified_ext is null or excluded.modified_ext >= ${crmRecords.modifiedExt}`,
      });
  }
  for (let n = 0; n < r.deleted.length; n += CHUNK) {
    const gone = r.deleted.slice(n, n + CHUNK).map((d) => sql`(${d.externalId}::text, ${d.deletedAt.toISOString()}::timestamptz)`);
    await tx.execute(sql`
      update crm_records c set deleted_at = d.at, synced_at = now()
      from (values ${sql.join(gone, sql`, `)}) as d(id, at)
      where c.integration_id = ${integrationId} and c.module = ${module} and c.external_id = d.id
        and (c.modified_ext is null or c.modified_ext <= d.at)`);
  }
  await tx
    .update(integrations)
    .set({ pullCursor: sql`${integrations.pullCursor} || jsonb_build_object(${module}::text, ${JSON.stringify(r.cursor)}::jsonb)` })
    .where(eq(integrations.id, integrationId));
  return rows.length;
}
