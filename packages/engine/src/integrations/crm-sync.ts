import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { crmRecords, integrations, organizations, withTenant, type Integration, type Tx } from "@jenai/db";
import { errorText } from "../errors";
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
 * only values read out of them. A record their system deleted is deleted
 * here too, not kept with a mark: the clinic erasing someone erases our copy.
 */

/** Requests for records one run makes when the caller does not say: up to 2,000 changed records. */
const DEFAULT_PAGE_BUDGET = 10;
/**
 * Requests each module is sure of in one run, whatever the budget: a listing
 * (which always hands back the newest change already stored) and, when due,
 * the deletions check. With less, a module could never finish a run.
 */
export const MIN_PAGES_PER_MODULE = 2;
/** Long enough for a run's requests. A worker that dies lets go of the connection after this. */
export const PULL_LEASE_MINUTES = 15;
/** Rows per insert statement. */
const CHUNK = 200;

export interface ModuleSync {
  module: string;
  /** Records read. */
  read: number;
  /** Records new or changed since the copy held, deleted, or gone in a full read: what the plan has to take in. */
  changed: number;
  /** Deletions their system reported. */
  deleted: number;
  /** Caught up: nothing more to read until something changes there. */
  done: boolean;
  /** The read moved past where the last one got to. */
  advanced?: boolean;
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
  /** Their system refused the connection itself: it was set to error and is not read again until reconnected. */
  connectionBroken?: boolean;
}

export interface SyncOptions {
  pageBudget?: number;
  fetchImpl?: typeof fetch;
  /**
   * The caller holds the lease already (claimPulls) and lets go of it itself,
   * once it has also set when the next read is due. Without this the lease is
   * taken here and let go at the end.
   */
  leased?: boolean;
}

/** The kinds of connection JENAI can read records from. */
export function pullKinds(): string[] {
  return Object.entries(CONNECTORS)
    .filter(([, c]) => typeof c.pull === "function")
    .map(([kind]) => kind);
}

/** Records new, changed or gone in this read, over every module. */
export const changedIn = (r: CrmSyncResult) => r.modules.reduce((n, m) => n + m.changed, 0);

/**
 * Reads what changed in each module of one connection's CRM since the last
 * run (config.pull.modules, else the connector's own list, for Zoho Leads
 * then Contacts) into crm_records, within a budget of requests shared by the
 * modules in order, each sure of at least MIN_PAGES_PER_MODULE. Records
 * last_pull_at, last_pull_error and last_pull_notes on the connection, and
 * sets it to error when their system refuses the connection itself.
 *
 * Holds the connection's pull lease while it runs, so a second run started
 * meanwhile returns at once with ran: false.
 */
export async function syncIntegration(tenantId: string, integrationId: string, opts: SyncOptions = {}): Promise<CrmSyncResult> {
  const taken = await withTenant(tenantId, async (tx) => {
    const [i] = opts.leased
      ? await tx.select().from(integrations).where(eq(integrations.id, integrationId))
      : await tx
          .update(integrations)
          .set({ pullLeaseUntil: sql`now() + make_interval(mins => ${PULL_LEASE_MINUTES})` })
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
  if (!taken) return { ran: false, modules: [], pages: 0, done: false, error: null };
  const { i, timeZone } = taken;

  const result: CrmSyncResult = { ran: true, modules: [], pages: 0, done: false, error: null };
  const problems: string[] = [];
  let failed = false;
  try {
    const connector = CONNECTORS[i.kind];
    if (!connector?.pull) problems.push("JENAI cannot read records from this kind of system yet.");
    else if (i.status === "paused") problems.push("The connection is paused, so nothing was read.");
    else {
      const ctx: ConnectorContext = {
        integration: i,
        credentials: credentialsOf(i),
        fetch: opts.fetchImpl ?? fetch,
        // A refreshed token or a refused scope is kept at once, in its own
        // transaction. A delivery may hold the connection's row meanwhile: then
        // this gives up after a few seconds rather than wait on it, and the
        // token stays in use in memory until the next caller stores it.
        save: (patch) =>
          withTenant(tenantId, async (tx) => {
            await tx.execute(sql`set local lock_timeout = '5s'`);
            await saver(tx, tenantId, i)(patch);
          }).catch(() => undefined),
      };
      const modules = modulesOf(i, connector.pullModules);
      let budget = Math.max(MIN_PAGES_PER_MODULE * modules.length, Math.floor(opts.pageBudget ?? DEFAULT_PAGE_BUDGET));
      for (const [n, module] of modules.entries()) {
        // What the modules after this one are sure of is kept back for them.
        const mine = budget - MIN_PAGES_PER_MODULE * (modules.length - n - 1);
        let r: PullResult;
        try {
          r = await connector.pull(ctx, { module, cursor: cursorOf(i, module), pageBudget: mine, timeZone });
        } catch (e) {
          r = { records: [], deleted: [], cursor: cursorOf(i, module), done: false, pages: 0, error: `Reading ${module} stopped: ${errorText(e)}`.slice(0, 300) };
        }
        budget -= r.pages;
        result.pages += r.pages;
        let stored = { read: 0, changed: 0 };
        try {
          stored = await withTenant(tenantId, (tx) => store(tx, tenantId, i.id, module, r));
        } catch (e) {
          // Nothing of this read was kept and its cursor did not move: the next run reads it again.
          r = { ...r, done: false, advanced: false, error: `${module} could not be stored: ${errorText(e)}`.slice(0, 300) };
        }
        result.modules.push({
          module,
          read: stored.read,
          changed: stored.changed,
          deleted: r.deleted.length,
          done: r.done,
          advanced: r.advanced,
          skipped: r.skipped,
          error: r.error,
          notes: r.notes?.length ? r.notes : undefined,
        });
        if (r.skipped) problems.push(r.skipped);
        if (r.error) {
          problems.push(r.error);
          failed = true;
        }
        if (r.connectionBroken) {
          result.connectionBroken = true;
          break;
        }
      }
      result.done = result.modules.length > 0 && result.modules.every((m) => m.done);
    }
  } catch (e) {
    problems.push(`Reading stopped: ${errorText(e)}`.slice(0, 300));
    failed = true;
  } finally {
    result.error = problems.length ? problems.join(" ").slice(0, 1000) : null;
    const notes = result.modules.flatMap((m) => m.notes ?? []).slice(0, 20);
    await withTenant(tenantId, (tx) =>
      tx
        .update(integrations)
        .set({
          lastPullAt: new Date(),
          lastPullError: result.error,
          lastPullNotes: notes,
          pullFailures: failed ? sql`${integrations.pullFailures} + 1` : 0,
          ...(opts.leased ? {} : { pullLeaseUntil: null }),
          // The same as a delivery that finds the grant gone: the connection
          // shows as not working, and is not read again until reconnected.
          ...(result.connectionBroken ? { status: "error" as const, lastError: (result.error ?? "Their system refused the connection.").slice(0, 300), lastErrorAt: new Date(), updatedAt: new Date() } : {}),
        })
        .where(eq(integrations.id, i.id)),
    );
  }
  return result;
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
 * Stores one module's read and moves its cursor, together. A copy no newer
 * than the one stored leaves it alone (the newest change is read again on
 * every run), unless the module is being read again in full, when every
 * record is written. A
 * record deleted in their system is deleted here, unless it changed after the
 * deletion; one listed again later is simply stored again. At the end of a
 * full read, records not seen in it are gone from their system and go here.
 */
async function store(tx: Tx, tenantId: string, integrationId: string, module: string, r: PullResult): Promise<{ read: number; changed: number }> {
  const rows = newestOnly(r.records);
  let changed = 0;
  // Read again in full, every record is written: it carries the new reading, and counts as seen for the sweep.
  const newer = r.rereading ? sql`true` : sql`${crmRecords.modifiedExt} is null or excluded.modified_ext is null or excluded.modified_ext > ${crmRecords.modifiedExt}`;
  for (let n = 0; n < rows.length; n += CHUNK) {
    const written = await tx
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
          appointmentHasTime: x.appointmentHasTime,
          followUpAt: x.followUpAt,
          notesSayDoNotCall: x.notesSayDoNotCall,
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
          appointmentHasTime: sql`excluded.appointment_has_time`,
          followUpAt: sql`excluded.follow_up_at`,
          notesSayDoNotCall: sql`excluded.notes_say_do_not_call`,
          treatment: sql`excluded.treatment`,
          consultant: sql`excluded.consultant`,
          deletedAt: null,
          syncedAt: sql`now()`,
        },
        setWhere: newer,
      })
      .returning({ id: crmRecords.id });
    changed += written.length;
  }
  for (let n = 0; n < r.deleted.length; n += CHUNK) {
    const gone = r.deleted.slice(n, n + CHUNK).map((d) => sql`(${d.externalId}::text, ${d.deletedAt.toISOString()}::timestamptz)`);
    const removed = await tx.execute(sql`
      delete from crm_records c
      using (values ${sql.join(gone, sql`, `)}) as d(id, at)
      where c.integration_id = ${integrationId} and c.module = ${module} and c.external_id = d.id
        and (c.modified_ext is null or c.modified_ext <= d.at)
      returning c.id`);
    changed += removed.length;
  }
  if (r.sweepBefore) {
    const swept = await tx.execute(sql`
      delete from crm_records
      where integration_id = ${integrationId} and module = ${module} and synced_at < ${r.sweepBefore.toISOString()}::timestamptz
      returning id`);
    changed += swept.length;
  }
  await tx
    .update(integrations)
    .set({ pullCursor: sql`${integrations.pullCursor} || jsonb_build_object(${module}::text, ${JSON.stringify(r.cursor)}::jsonb)` })
    .where(eq(integrations.id, integrationId));
  return { read: rows.length, changed };
}

/**
 * Forgets what was read from one connection: its records and where each
 * module got to, so the next read starts again from nothing. For a
 * connection now pointing at another Zoho account, or an operator starting
 * over. The plan rows built from those records go at the next plan.
 */
export async function forgetPulled(tx: Tx, integrationId: string): Promise<number> {
  const gone = await tx.delete(crmRecords).where(eq(crmRecords.integrationId, integrationId)).returning({ id: crmRecords.id });
  await tx.update(integrations).set({ pullCursor: {}, nextPullAt: null, lastPullNotes: [] }).where(eq(integrations.id, integrationId));
  return gone.length;
}
