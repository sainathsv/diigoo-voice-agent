import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { audit, branches, clinicAppointments, externalPeople, integrations, packageBalances, visits, withTenant, type Integration, type Tx } from "@jenai/db";
import { replanTenant, type ReplanResult } from "../care-plan";
import { localParts, zoned } from "../dialer/time";
import { branchMatcher } from "../visits-import";
import { endPull, takePullLease } from "./crm-sync";
import { credentialsOf, sealCredentials } from "./queue";
import type { ConnectorContext } from "./types";
import {
  ZenotiBudgetSpent,
  ZenotiClient,
  ZenotiError,
  ZenotiKeyError,
  ZenotiPermissionError,
  packageSessions,
  testZenoti,
  zenotiAppointmentRow,
  zenotiAppointmentVisit,
  zenotiPackageBalances,
  zenotiPerson,
  zenotiPhone,
  zenotiSalesAccrualVisit,
  zenotiSalesReportVisit,
  type ZenotiCallBudget,
  type ZenotiCapabilities,
  type ZenotiCentre,
  type ZenotiClock,
  type ZenotiPackageRow,
  type ZenotiPath,
  type ZenotiPersonRow,
  type ZenotiPhoneOptions,
  type ZenotiTestResult,
  type ZenotiVisit,
} from "./zenoti";

/**
 * Reading a clinic's Zenoti into JENAI for the call plan: their bookings, the
 * services people took, each guest's number and SMS consents, and the
 * sessions left on their packages. Read only: every request is one of
 * ZenotiClient's reads (GETs, and the accrual report, a POST that only reads).
 *
 * A run makes at most callBudget calls (30 unless said), checks and retries
 * included, because the clinic's other apps share Zenoti's 60 a minute. What
 * it does not reach waits for the next run, which carries on from there:
 *  1. what the key may read, as the last Test found, checked again after a
 *     day or when Zenoti refuses the way services done are read;
 *  2. per centre, the days not yet read, back to config.backfillDays (120
 *     unless said), seven at a time, oldest first. pull_cursor.zenoti[centre
 *     id] is the last day fully stored, moved in the transaction that stores it;
 *  3. per centre, the last three days and today again, and on the
 *     appointments path the next fourteen days, because bookings and
 *     statuses change after the fact;
 *  4. guests' profiles, for their number and SMS consents: never read first,
 *     those still without a number before the rest, then any read over 30 days ago;
 *  5. the packages of guests with a visit in the last 180 days, at most once a week each.
 * The call plan is then made again. Nothing here dials, makes campaign
 * targets or writes to any CRM. Logs and messages carry counts and centre
 * names only, never a guest's name or number.
 *
 * Settings (integration config): backfillDays; onlyCentres, Zenoti centre ids
 * or codes to read (every centre the key sees when empty); reportPageSize,
 * rows per page of the accrual report (100); branchMap, Zenoti centre id to
 * JENAI branch id, matched by name or code and kept, so a clinic can correct it.
 * Each run leaves config.lastSync: when, which path, calls used and a summary.
 */

/** Calls to Zenoti one run makes at most when the caller does not say. */
export const ZENOTI_SYNC_CALLS = 30;
const DEFAULT_BACKFILL_DAYS = 120;
const MAX_BACKFILL_DAYS = 365;
/** Zenoti's appointments and older sales report take at most seven days a request. */
const SPAN_DAYS = 7;
/** Days before today read again every run: a visit is closed, a no-show marked, a day or two late. */
const RECENT_DAYS = 3;
/** Days of bookings ahead read every run, on the appointments path. */
const AHEAD_DAYS = 14;
const DAY_MS = 86_400_000;
const RETEST_AFTER_MS = DAY_MS;
const PROFILE_REFRESH_DAYS = 30;
/** A profile read without a number we could use is read again sooner: the front desk may add it. */
const NO_NUMBER_RETRY_DAYS = 1;
const PACKAGE_REFRESH_DAYS = 7;
const PACKAGE_LOOKBACK_DAYS = 180;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
/** Calls a check of what the key may read makes: the centres, then one per kind of read. */
const TEST_CALLS = 6;
/** Rows per write statement. */
const CHUNK = 500;

export interface ZenotiSyncOptions {
  /** Calls to Zenoti this run may make, checks and retries included. */
  callBudget?: number;
  /** Today, for the windows and what is due. */
  now?: Date;
  fetchImpl?: typeof fetch;
  /** For tests: pacing and Zenoti's waits pass on this clock instead of the real one. */
  clock?: ZenotiClock;
}

export interface ZenotiCentreSync {
  centreId: string;
  /** As Zenoti names it. */
  name: string | null;
  /** The JENAI branch it was matched to. */
  branchId: string | null;
  /** The last day fully stored. */
  cursor: string | null;
  /** Spans of up to seven days read this run. */
  spans: number;
  /** Days still to read, history and the recent days together. */
  daysLeft: number;
}

export interface ZenotiSyncResult {
  /** False when another run was reading this connection already, so this one left it alone. */
  ran: boolean;
  /** Where services done were read from. */
  path: ZenotiPath | null;
  /** Calls made to Zenoti, checks and retries included. Never more than the budget. */
  calls: number;
  budget: number;
  /** What the key may read was checked again this run. */
  tested: boolean;
  centres: ZenotiCentreSync[];
  /** Bookings read; of them new or changed in Zenoti; removed because Zenoti no longer lists them, or they can no longer be kept current. */
  bookings: { read: number; changed: number; removed: number };
  /**
   * Services done: read, new, changed, folded into a visit JENAI already had
   * for the same person, service and day, removed because the booking is no
   * longer completed, and given a number from a guest's profile.
   */
  visits: { read: number; added: number; updated: number; merged: number; removed: number; numbered: number };
  /** Guests' profiles read, and still due. */
  guests: { read: number; left: number };
  /** Guests whose packages were read, balance rows stored, visits given session counts, guests still due. */
  packages: { guests: number; rows: number; sessions: number; left: number };
  /** Nothing due was left for next time, and nothing went wrong. */
  done: boolean;
  /** What waits for the next run, in plain words. */
  left: string[];
  /** What went wrong or could not be read, in plain words, as stored in last_pull_error. */
  error: string | null;
  /** Counts in a sentence or two, as kept in config.lastSync. */
  summary: string;
  /** The call plan, made again. */
  plan: ReplanResult | null;
}

/**
 * Reads one Zenoti connection into clinic_appointments, visits,
 * external_people and package_balances, within the call budget, then makes
 * the call plan again. Holds the connection's pull lease while it runs, so a
 * second run started meanwhile returns at once with ran: false. Records
 * last_pull_at, last_pull_error and config.lastSync on the connection.
 */
export async function syncZenoti(tenantId: string, integrationId: string, opts: ZenotiSyncOptions = {}): Promise<ZenotiSyncResult> {
  const budget: ZenotiCallBudget = { left: Math.max(0, Math.floor(opts.callBudget ?? ZENOTI_SYNC_CALLS)), used: 0 };
  const now = opts.now ?? new Date(opts.clock?.now() ?? Date.now());
  const result: ZenotiSyncResult = {
    ran: false,
    path: null,
    calls: 0,
    budget: budget.left,
    tested: false,
    centres: [],
    bookings: { read: 0, changed: 0, removed: 0 },
    visits: { read: 0, added: 0, updated: 0, merged: 0, removed: 0, numbered: 0 },
    guests: { read: 0, left: 0 },
    packages: { guests: 0, rows: 0, sessions: 0, left: 0 },
    done: false,
    left: [],
    error: null,
    summary: "",
    plan: null,
  };
  const taken = await takePullLease(tenantId, integrationId);
  if (!taken) return result;
  result.ran = true;

  const run = new Run(tenantId, taken.i, taken.timeZone, now, budget, opts, result);
  try {
    await run.go();
    await run.account();
  } catch (e) {
    run.problems.push(`Reading Zenoti stopped: ${(e as Error).message}`.slice(0, 300));
  } finally {
    result.calls = budget.used;
    result.path = run.path;
    try {
      result.plan = await replanTenant(tenantId, { now });
    } catch (e) {
      run.problems.push(`The call plan could not be made again: ${(e as Error).message}`.slice(0, 300));
    }
    result.left = run.left;
    result.error = run.problems.length ? run.problems.join(" ").slice(0, 1000) : null;
    result.done = !result.left.length && !result.error;
    result.summary = summaryOf(result);
    try {
      await run.save({ config: { lastSync: { at: now.toISOString(), path: result.path, calls: result.calls, budget: result.budget, done: result.done, summary: result.summary } } });
      if (changedAnything(result)) {
        await withTenant(tenantId, (tx) =>
          audit(tx, {
            tenantId,
            actorUserId: null,
            via: "system",
            action: "zenoti.synced",
            targetType: "integration",
            targetId: integrationId,
            summary: `Zenoti read: ${result.summary}`.slice(0, 500),
            diff: { path: result.path, calls: result.calls, bookings: result.bookings, visits: result.visits, guests: result.guests, packages: result.packages },
          }),
        );
      }
    } finally {
      await endPull(tenantId, integrationId, result.error);
    }
  }
  return result;
}

// ---------------------------------------------------------------- one run

interface Access {
  capabilities: ZenotiCapabilities;
  path: ZenotiPath | null;
  /** Null when it must be checked again before it is trusted. */
  checkedAt: string | null;
}

/** One centre as this run reads it. */
interface CentreState {
  c: ZenotiCentre;
  branchId: string | null;
  timeZone: string;
  cursor: string | null;
  /** The last of the recent days read this run. */
  recentThrough: string | null;
  out: ZenotiCentreSync;
}

/** Days from `from` to `to`, both included. `moves` is where the cursor goes once they are stored. */
interface Span {
  from: string;
  to: string;
  moves: string | null;
  recent: boolean;
}

class Run {
  readonly problems: string[] = [];
  readonly left: string[] = [];
  private config: Record<string, unknown>;
  private access: Access | null;
  private client: ZenotiClient | null = null;
  private ctx: ConnectorContext | null = null;
  private states: CentreState[] = [];
  private codes: Record<string, string> | null = null;
  private codesTried = false;

  constructor(
    private readonly tenantId: string,
    private readonly i: Integration,
    private readonly timeZone: string,
    private readonly now: Date,
    private readonly budget: ZenotiCallBudget,
    private readonly opts: ZenotiSyncOptions,
    private readonly r: ZenotiSyncResult,
  ) {
    this.config = { ...i.config };
    this.access = accessOf(i.config);
  }

  get path(): ZenotiPath | null {
    return this.access?.path ?? null;
  }

  async go(): Promise<void> {
    if (this.i.status === "paused") {
      this.problems.push("The connection is paused, so nothing was read.");
      return;
    }
    try {
      this.ctx = { integration: this.i, credentials: credentialsOf(this.i), fetch: this.opts.fetchImpl ?? fetch, save: (patch) => this.save(patch) };
      this.client = new ZenotiClient(this.ctx, this.opts.clock, this.budget);
      if (this.needsCheck()) {
        if (this.budget.left >= TEST_CALLS) {
          if (!(await this.check())) return;
        } else {
          this.left.push("a check of what the key may read");
          // What the last check found still stands until a run has the calls to check it.
          if (!this.path) return;
        }
      }
      if (!this.path) {
        this.problems.push("Zenoti does not let this key read appointments or either sales report, so JENAI cannot see which services were done. Test the connection to see what to ask your Zenoti admin for.");
        return;
      }
      await this.readServices();
      await this.readProfiles();
      await this.readPackages();
    } catch (e) {
      this.stopped(e);
    }
  }

  /** Why the run stopped, in words the clinic can act on. Out of calls is no problem: what is left says the rest. */
  private stopped(e: unknown): void {
    if (e instanceof ZenotiBudgetSpent) return;
    if (e instanceof ZenotiKeyError) {
      this.problems.push(`${e.message} Ask your Zenoti admin for the API key of the backend app made for JENAI and save it here again.`);
    } else if (e instanceof ZenotiError) {
      this.problems.push(e.retryLater ? `${e.message} JENAI tries again next time.` : e.message);
    } else {
      this.problems.push(`Reading Zenoti stopped: ${(e as Error).message}`.slice(0, 300));
    }
  }

  /** Keeps what the run learnt on the connection, merged into what is there, so nothing saved meanwhile is lost. */
  async save(patch: { credentials?: Record<string, string>; config?: Record<string, unknown> }): Promise<void> {
    await withTenant(this.tenantId, (tx) =>
      tx
        .update(integrations)
        .set({
          ...(patch.credentials ? { credentials: sealCredentials(this.tenantId, patch.credentials) } : {}),
          ...(patch.config ? { config: sql`${integrations.config} || ${JSON.stringify(patch.config)}::jsonb` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, this.i.id)),
    );
    if (patch.config) {
      this.config = { ...this.config, ...patch.config };
      this.access = accessOf(this.config);
    }
  }

  // ---------------------------------------------------------------- what the key may read

  private needsCheck(): boolean {
    const a = this.access;
    if (!a?.checkedAt || !centresOf(this.config).length) return true;
    const at = Date.parse(a.checkedAt);
    if (!Number.isFinite(at) || this.now.getTime() - at > RETEST_AFTER_MS) return true;
    // Zenoti did not answer part of the last check, so it could not tell where services done come from.
    return !a.path && [a.capabilities.appointments, a.capabilities.salesAccrual, a.capabilities.salesReport].includes(null);
  }

  /** The connector's own Test, which keeps what it finds on the connection. False when nothing can be read. */
  private async check(): Promise<boolean> {
    this.r.tested = true;
    let t: ZenotiTestResult;
    try {
      t = await testZenoti(this.ctx!, this.opts.clock, this.budget);
    } catch (e) {
      // Retries spent the calls the check needed: it is made first next time.
      if (e instanceof ZenotiBudgetSpent) this.left.push("a check of what the key may read");
      throw e;
    }
    if (!t.ok) this.problems.push(t.message);
    return t.ok && !!this.path;
  }

  /** Zenoti stopped letting the key read one thing: kept until the next check, a day at most. */
  private async denied(k: keyof ZenotiCapabilities, e: ZenotiPermissionError): Promise<void> {
    this.problems.push(`${e.message} Test the connection to see what to ask your Zenoti admin for.`);
    if (this.access) await this.save({ config: { access: { ...this.access, capabilities: { ...this.access.capabilities, [k]: false } } } });
  }

  // ---------------------------------------------------------------- services done, and bookings

  private async readServices(): Promise<void> {
    const centres = this.centres();
    if (!centres.length) {
      this.problems.push("None of the centres chosen for this connection is one the key sees in Zenoti.");
      return;
    }
    const places = await this.places(centres);
    this.states = centres.map((c) => {
      const p = places.get(c.id)!;
      const cursor = cursorOf(this.i, c.id);
      return { c, ...p, cursor, recentThrough: null, out: { centreId: c.id, name: c.name, branchId: p.branchId, cursor, spans: 0, daysLeft: 0 } };
    });
    this.r.centres = this.states.map((s) => s.out);
    if (this.path !== "appointments") await this.dropFutureBookings();

    for (const s of this.states) {
      for (;;) {
        try {
          await this.readCentre(s);
          break;
        } catch (e) {
          if (!(e instanceof ZenotiPermissionError) || this.r.tested) throw e;
          // Zenoti stopped letting the key read where services done came from:
          // what it may read now decides where they come from instead.
          if (this.budget.left < TEST_CALLS) {
            this.problems.push(`${e.message} JENAI checks what the key may read on its next run.`);
            if (this.access) await this.save({ config: { access: { ...this.access, checkedAt: null } } });
            return;
          }
          const before = this.path;
          if (!(await this.check())) return;
          if (this.path === before) throw e;
          this.problems.push(`${e.message} Services done are read from ${PATH_TEXT[this.path!]} instead.`);
          if (this.path !== "appointments") await this.dropFutureBookings();
        }
      }
    }
  }

  /** The centres to read: config.onlyCentres by id or code, else every one the key sees. */
  private centres(): ZenotiCentre[] {
    const all = centresOf(this.config);
    const only = Array.isArray(this.config.onlyCentres) ? this.config.onlyCentres.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    return only.length ? all.filter((c) => only.includes(c.id.toLowerCase()) || (c.code && only.includes(c.code.toLowerCase()))) : all;
  }

  /**
   * Each centre's JENAI branch and time zone. A branch kept in
   * config.branchMap stands while it exists; otherwise the centre's name or
   * code is matched, and the map saved, so the clinic sees and can correct it.
   */
  private async places(centres: ZenotiCentre[]): Promise<Map<string, { branchId: string | null; timeZone: string }>> {
    const list = await withTenant(this.tenantId, (tx) => tx.select({ id: branches.id, name: branches.name, code: branches.code, timezone: branches.timezone }).from(branches));
    const match = branchMatcher(list);
    const had = obj(this.config.branchMap);
    const map: Record<string, string | null> = { ...(had as Record<string, string | null>) };
    for (const c of centres) {
      const kept = typeof had[c.id] === "string" && list.some((b) => b.id === had[c.id]) ? (had[c.id] as string) : null;
      map[c.id] = kept ?? match(c.name) ?? match(c.code) ?? null;
    }
    if (JSON.stringify(map) !== JSON.stringify(had)) await this.save({ config: { branchMap: map } });
    return new Map(centres.map((c) => [c.id, { branchId: map[c.id] ?? null, timeZone: list.find((b) => b.id === map[c.id])?.timezone ?? this.timeZone }]));
  }

  /**
   * Bookings can be kept current only from appointments. Read any other way,
   * the ones held from now on would go stale (a cancellation never seen), so
   * they go; past ones stay as history.
   */
  private async dropFutureBookings(): Promise<void> {
    const gone = await withTenant(this.tenantId, (tx) =>
      tx
        .delete(clinicAppointments)
        .where(and(eq(clinicAppointments.integrationId, this.i.id), gte(clinicAppointments.startsAt, this.now)))
        .returning({ id: clinicAppointments.id }),
    );
    this.r.bookings.removed += gone.length;
  }

  /** The days one centre still has to read: history from the cursor, oldest first, then the recent days. */
  private spans(s: CentreState): Span[] {
    const today = dayIn(this.now, s.timeZone);
    const recentFrom = addDays(today, -RECENT_DAYS);
    const earliest = addDays(today, -backfillDaysOf(this.config));
    const start = s.cursor && s.cursor >= earliest ? addDays(s.cursor, 1) : earliest;
    const out: Span[] = split(start, addDays(recentFrom, -1)).map((w) => ({ ...w, moves: w.to, recent: false }));
    const until = this.path === "appointments" ? addDays(today, AHEAD_DAYS) : today;
    // Once the recent days through yesterday are stored too, every day before today is.
    split(recentFrom, until).forEach((w, n) => out.push({ ...w, moves: n === 0 ? addDays(today, -1) : null, recent: true }));
    return out;
  }

  private async readCentre(s: CentreState): Promise<void> {
    for (const w of this.spans(s)) {
      const client = this.client!;
      if (this.path === "appointments") {
        const raw = await client.appointments(s.c.id, w.from, addDays(w.to, 1));
        await this.placePhones(raw.map((a) => obj(a.guest).mobile));
        await withTenant(this.tenantId, async (tx) => {
          await this.storeAppointments(tx, s, w, raw);
          await this.moveCursor(tx, s, w);
        });
      } else if (this.path === "sales_accrual") {
        const size = pageSizeOf(this.config);
        for (let page = 1; ; page++) {
          const { rows, total } = await client.salesAccrual({ centreIds: [s.c.id], from: w.from, to: w.to, page, size });
          const last = rows.length < size || (total !== null && page * size >= total);
          // Each page is kept as it comes, so a run that stops part way has not spent its calls for nothing.
          await withTenant(this.tenantId, async (tx) => {
            await this.storeReport(tx, s, rows.map((x) => zenotiSalesAccrualVisit(x, { centreRef: s.c.id })));
            if (last) await this.moveCursor(tx, s, w);
          });
          if (last) break;
        }
      } else {
        const rows = await client.salesReport(s.c.id, w.from, w.to);
        await withTenant(this.tenantId, async (tx) => {
          await this.storeReport(tx, s, rows.map((x) => zenotiSalesReportVisit(x, { centreRef: s.c.id })));
          await this.moveCursor(tx, s, w);
        });
      }
      if (w.moves && w.moves > (s.cursor ?? "")) s.cursor = s.out.cursor = w.moves;
      if (w.recent) s.recentThrough = w.to;
      s.out.spans++;
    }
  }

  private async moveCursor(tx: Tx, s: CentreState, w: Span): Promise<void> {
    if (!w.moves || w.moves <= (s.cursor ?? "")) return;
    await tx
      .update(integrations)
      .set({
        pullCursor: sql`${integrations.pullCursor} || jsonb_build_object('zenoti', coalesce(${integrations.pullCursor} -> 'zenoti', '{}'::jsonb) || jsonb_build_object(${s.c.id}::text, ${w.moves}::text))`,
      })
      .where(eq(integrations.id, this.i.id));
  }

  private async storeAppointments(tx: Tx, s: CentreState, w: Span, raw: Record<string, unknown>[]): Promise<void> {
    const opts = { centreRef: s.c.id, timeZone: s.timeZone, ...this.phoneOpts() };
    const rows = uniqueBy(
      raw.flatMap((a) => zenotiAppointmentRow(a, opts) ?? []),
      (a) => a.externalId,
    );
    const done = uniqueBy(
      raw.flatMap((a) => zenotiAppointmentVisit(a, opts) ?? []),
      (v) => v.externalId,
    );
    await seePeople(tx, this.tenantId, this.i.id, rows.map((a) => ({ externalId: a.guestRef, phoneE164: a.phoneE164 ?? null, name: a.name ?? null })));
    const known = await knownPhones(tx, this.i.id, rows.map((a) => a.guestRef));
    for (const part of chunks(rows)) {
      const json = part.map((a) => ({
        external_id: a.externalId,
        guest_ref: a.guestRef,
        phone_e164: a.phoneE164 ?? known.get(a.guestRef) ?? null,
        name: a.name ?? null,
        service: a.service,
        category: a.category ?? null,
        starts_at: a.startsAt.toISOString(),
        status: a.status,
        doctor: a.doctor ?? null,
        centre_ref: s.c.id,
        branch_id: s.branchId,
      }));
      // A booking Zenoti has as it was is not written again.
      const changed = await tx.execute(sql`
        insert into clinic_appointments (tenant_id, integration_id, external_id, guest_ref, phone_e164, name, service, category, starts_at, status, doctor, centre_ref, branch_id)
        select ${this.tenantId}, ${this.i.id}, a.external_id, a.guest_ref, a.phone_e164, a.name, a.service, a.category, a.starts_at, a.status, a.doctor, a.centre_ref, a.branch_id
        from jsonb_to_recordset(${JSON.stringify(json)}::jsonb) as a(external_id text, guest_ref text, phone_e164 text, name text, service text, category text, starts_at timestamptz, status text, doctor text, centre_ref text, branch_id uuid)
        on conflict (tenant_id, integration_id, external_id) do update set
          guest_ref = excluded.guest_ref,
          phone_e164 = coalesce(excluded.phone_e164, clinic_appointments.phone_e164),
          name = coalesce(excluded.name, clinic_appointments.name),
          service = excluded.service,
          category = excluded.category,
          starts_at = excluded.starts_at,
          status = excluded.status,
          doctor = excluded.doctor,
          centre_ref = excluded.centre_ref,
          branch_id = excluded.branch_id,
          updated_at = now()
        where (clinic_appointments.guest_ref, clinic_appointments.phone_e164, clinic_appointments.name, clinic_appointments.service, clinic_appointments.category,
               clinic_appointments.starts_at, clinic_appointments.status, clinic_appointments.doctor, clinic_appointments.centre_ref, clinic_appointments.branch_id)
          is distinct from (excluded.guest_ref, coalesce(excluded.phone_e164, clinic_appointments.phone_e164), coalesce(excluded.name, clinic_appointments.name),
               excluded.service, excluded.category, excluded.starts_at, excluded.status, excluded.doctor, excluded.centre_ref, excluded.branch_id)
        returning 1`);
      this.r.bookings.changed += changed.length;
    }
    this.r.bookings.read += rows.length;

    // A booking Zenoti no longer lists for these days was deleted there, or
    // moved to a day whose own span puts it back.
    const gone = await tx.execute<{ external_id: string }>(sql`
      delete from clinic_appointments
      where integration_id = ${this.i.id} and centre_ref = ${s.c.id}
        and starts_at >= ${startOfDay(w.from, s.timeZone).toISOString()}::timestamptz
        and starts_at < ${startOfDay(addDays(w.to, 1), s.timeZone).toISOString()}::timestamptz
        and external_id not in ${texts(rows.map((a) => a.externalId))}
      returning external_id`);
    this.r.bookings.removed += gone.length;

    // A visit stands only while its booking is completed in Zenoti.
    const undone = [...rows.filter((a) => a.status !== "completed").map((a) => a.externalId), ...gone.map((g) => g.external_id)];
    if (undone.length) {
      const removed = await tx.execute(sql`delete from visits where integration_id = ${this.i.id} and external_id in ${texts(undone)} returning id`);
      this.r.visits.removed += removed.length;
    }
    await this.storeVisitLines(tx, s, done);
  }

  /** Services done from a sales report: the guest is named, their number comes from their profile once read. */
  private async storeReport(tx: Tx, s: CentreState, lines: Array<ZenotiVisit | null>): Promise<void> {
    const done = lines.filter((v): v is ZenotiVisit => v !== null);
    await seePeople(tx, this.tenantId, this.i.id, done.map((v) => ({ externalId: v.guestRef, phoneE164: v.phoneE164, name: v.name })));
    await this.storeVisitLines(tx, s, done);
  }

  private async storeVisitLines(tx: Tx, s: CentreState, done: ZenotiVisit[]): Promise<void> {
    const res = await storeVisits(
      tx,
      this.tenantId,
      this.i.id,
      done.map((v) => ({
        externalId: v.externalId,
        guestRef: v.guestRef,
        phoneE164: v.phoneE164,
        name: v.name,
        service: v.service,
        visitDate: v.visitDate,
        doctor: v.doctor,
        branch: s.c.name ?? s.c.code,
        branchId: s.branchId,
        sessionsTotal: v.sessionsTotal,
      })),
    );
    this.r.visits.read += done.length;
    this.r.visits.added += res.added;
    this.r.visits.updated += res.updated;
    this.r.visits.merged += res.merged;
  }

  // ---------------------------------------------------------------- phones

  private phoneOpts(): ZenotiPhoneOptions {
    const code = this.config.defaultCountryCode;
    return { defaultCountryCode: code === undefined || code === null ? undefined : String(code), phoneCodes: this.codes ?? undefined };
  }

  /**
   * A mobile whose country the built-in codes cannot place: Zenoti's own
   * country list is read, once a run, and only then.
   */
  private async placePhones(mobiles: unknown[]): Promise<void> {
    if (this.codesTried || !mobiles.some((m) => hasNumber(m) && !zenotiPhone(m, this.phoneOpts()))) return;
    this.codesTried = true;
    try {
      this.codes = await this.client!.phoneCodes();
    } catch (e) {
      // Out of calls: what was read is still stored, with the numbers the built-in codes place.
      if (!(e instanceof ZenotiBudgetSpent)) throw e;
    }
  }

  // ---------------------------------------------------------------- guests' profiles

  private profilesDue() {
    const refresh = new Date(this.now.getTime() - PROFILE_REFRESH_DAYS * DAY_MS);
    const retry = new Date(this.now.getTime() - NO_NUMBER_RETRY_DAYS * DAY_MS);
    return and(
      eq(externalPeople.integrationId, this.i.id),
      or(isNull(externalPeople.fetchedAt), lt(externalPeople.fetchedAt, refresh), and(isNull(externalPeople.phoneE164), lt(externalPeople.fetchedAt, retry))),
    );
  }

  /** Guests' profiles, for their number and consents: no number yet first, never read next, then the oldest read. */
  private async readProfiles(): Promise<void> {
    if (this.access?.capabilities.guestDetails !== true || this.budget.left <= 0) return;
    const due = await withTenant(this.tenantId, (tx) =>
      tx
        .select({ id: externalPeople.externalId })
        .from(externalPeople)
        .where(this.profilesDue())
        .orderBy(sql`${externalPeople.phoneE164} is null desc`, sql`${externalPeople.fetchedAt} asc nulls first`, desc(externalPeople.updatedAt))
        .limit(this.budget.left),
    );
    for (const { id } of due) {
      let guest: Record<string, unknown> | null;
      try {
        guest = await this.client!.guest(id);
      } catch (e) {
        if (e instanceof ZenotiPermissionError) return this.denied("guestDetails", e);
        throw e;
      }
      if (guest) await this.placePhones([obj(guest.personal_info).mobile_phone ?? guest.mobile]);
      const person = guest ? zenotiPerson(guest, this.phoneOpts()) : null;
      await withTenant(this.tenantId, (tx) => this.storeProfile(tx, id, guest ? person : null));
      this.r.guests.read++;
    }
  }

  /**
   * What a profile says, and the number it gives on everything of theirs
   * still waiting for one. A guest Zenoti no longer has is marked read, so
   * they are not asked for again every run.
   */
  private async storeProfile(tx: Tx, guestRef: string, person: ZenotiPersonRow | null): Promise<void> {
    const read = person !== null;
    const [row] = await tx.execute<{ phone_e164: string | null }>(sql`
      insert into external_people (tenant_id, integration_id, external_id, phone_e164, name, marketing_sms_consent, transactional_sms_consent, fetched_at)
      values (${this.tenantId}, ${this.i.id}, ${guestRef}, ${person?.phoneE164 ?? null}, ${person?.name ?? null},
              ${person?.marketingSmsConsent ?? null}::boolean, ${person?.transactionalSmsConsent ?? null}::boolean, ${this.now.toISOString()}::timestamptz)
      on conflict (tenant_id, integration_id, external_id) do update set
        phone_e164 = coalesce(excluded.phone_e164, external_people.phone_e164),
        name = coalesce(excluded.name, external_people.name),
        marketing_sms_consent = case when ${read} then excluded.marketing_sms_consent else external_people.marketing_sms_consent end,
        transactional_sms_consent = case when ${read} then excluded.transactional_sms_consent else external_people.transactional_sms_consent end,
        fetched_at = excluded.fetched_at,
        updated_at = now()
      returning phone_e164`);
    const phone = row?.phone_e164 ?? null;
    if (!phone) return;
    await tx
      .update(clinicAppointments)
      .set({ phoneE164: phone, updatedAt: new Date() })
      .where(and(eq(clinicAppointments.integrationId, this.i.id), eq(clinicAppointments.guestRef, guestRef), isNull(clinicAppointments.phoneE164)));
    await tx
      .update(packageBalances)
      .set({ phoneE164: phone })
      .where(and(eq(packageBalances.integrationId, this.i.id), eq(packageBalances.guestRef, guestRef), sql`${packageBalances.phoneE164} is distinct from ${phone}`));
    const waiting = await tx
      .select()
      .from(visits)
      .where(and(eq(visits.integrationId, this.i.id), eq(visits.guestRef, guestRef), isNull(visits.phoneE164), isNotNull(visits.externalId)));
    if (!waiting.length) return;
    // Stored again with the number, which may make one a copy of a visit JENAI already has: then it folds into that one.
    const res = await storeVisits(
      tx,
      this.tenantId,
      this.i.id,
      waiting.map((v) => ({
        externalId: v.externalId!,
        guestRef,
        phoneE164: phone,
        name: v.name,
        service: v.service,
        visitDate: v.visitDate,
        doctor: v.doctor,
        branch: v.branch,
        branchId: v.branchId,
        sessionsTotal: v.sessionsTotal,
      })),
    );
    this.r.visits.numbered += res.updated;
    this.r.visits.merged += res.merged;
  }

  // ---------------------------------------------------------------- packages

  /** Guests with a visit in the last 180 days whose packages were not read this week, never read first, then the latest visitors. */
  private packagesDue(limit: number | null) {
    const since = addDays(dayIn(this.now, this.timeZone), -PACKAGE_LOOKBACK_DAYS);
    const weekAgo = new Date(this.now.getTime() - PACKAGE_REFRESH_DAYS * DAY_MS).toISOString();
    return sql`
      select v.guest_ref as ref
      from visits v
      left join external_people p on p.tenant_id = v.tenant_id and p.integration_id = v.integration_id and p.external_id = v.guest_ref
      where v.integration_id = ${this.i.id} and v.guest_ref is not null and v.visit_date >= ${since}::date
        and (p.packages_fetched_at is null or p.packages_fetched_at < ${weekAgo}::timestamptz)
      group by v.guest_ref, p.packages_fetched_at
      order by p.packages_fetched_at asc nulls first, max(v.visit_date) desc
      ${limit === null ? sql`` : sql`limit ${limit}`}`;
  }

  private async readPackages(): Promise<void> {
    if (this.access?.capabilities.guestPackages !== true || this.budget.left <= 0) return;
    const due = await withTenant(this.tenantId, (tx) => tx.execute<{ ref: string }>(this.packagesDue(this.budget.left)));
    for (const { ref } of due) {
      let list: Record<string, unknown>[];
      try {
        list = await this.client!.guestPackages(ref);
      } catch (e) {
        if (e instanceof ZenotiPermissionError) return this.denied("guestPackages", e);
        throw e;
      }
      const rows = zenotiPackageBalances(ref, list);
      await withTenant(this.tenantId, (tx) => this.storePackages(tx, ref, rows));
      this.r.packages.guests++;
      this.r.packages.rows += rows.length;
    }
  }

  /**
   * One guest's packages as Zenoti has them now: balances stored, ones gone
   * from Zenoti removed, the week noted on the guest, and the counts of the
   * package in use set on their latest visit for each service in it, which
   * is the one the plan reads for the next session.
   */
  private async storePackages(tx: Tx, guestRef: string, rows: ZenotiPackageRow[]): Promise<void> {
    const phone = (await knownPhones(tx, this.i.id, [guestRef])).get(guestRef) ?? null;
    const json = rows.map((p) => ({
      package_ref: p.packageRef ?? null,
      package_name: p.packageName,
      service: p.service,
      total: p.total ?? null,
      used: p.used ?? null,
      balance: p.balance ?? null,
      status: p.status,
      expires_on: p.expiresOn ?? null,
    }));
    if (json.length) {
      await tx.execute(sql`
        insert into package_balances (tenant_id, integration_id, guest_ref, phone_e164, package_ref, package_name, service, total, used, balance, status, expires_on, fetched_at)
        select ${this.tenantId}, ${this.i.id}, ${guestRef}, ${phone}, p.package_ref, p.package_name, p.service, p.total, p.used, p.balance, p.status, p.expires_on, ${this.now.toISOString()}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(json)}::jsonb) as p(package_ref text, package_name text, service text, total int, used int, balance int, status text, expires_on date)
        on conflict (tenant_id, integration_id, guest_ref, package_name, service) do update set
          phone_e164 = excluded.phone_e164,
          package_ref = excluded.package_ref,
          total = excluded.total,
          used = excluded.used,
          balance = excluded.balance,
          status = excluded.status,
          expires_on = excluded.expires_on,
          fetched_at = excluded.fetched_at`);
    }
    await tx.execute(sql`
      delete from package_balances b
      where b.integration_id = ${this.i.id} and b.guest_ref = ${guestRef}
        and not exists (select 1 from jsonb_to_recordset(${JSON.stringify(json)}::jsonb) as p(package_name text, service text)
                        where p.package_name = b.package_name and p.service = b.service)`);
    await tx.execute(sql`
      insert into external_people (tenant_id, integration_id, external_id, packages_fetched_at)
      values (${this.tenantId}, ${this.i.id}, ${guestRef}, ${this.now.toISOString()}::timestamptz)
      on conflict (tenant_id, integration_id, external_id) do update set packages_fetched_at = excluded.packages_fetched_at`);

    // The package in use speaks for a service: active, then not yet started, then the one ending later.
    const inUse = rows
      .filter((p) => p.status === "active" || p.status === "not_started")
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""));
    const counted = new Set<string>();
    for (const p of inUse) {
      const total = p.total ?? packageSessions(p.packageName);
      const key = p.service.toLowerCase();
      if (!total || total < 1 || counted.has(key)) continue;
      counted.add(key);
      const used = p.used !== null && p.used !== undefined && p.used >= 0 ? p.used : null;
      const set = await tx.execute(sql`
        update visits set sessions_total = ${total}::int, sessions_done = ${used}::int, updated_at = now()
        where id = (select id from visits
                    where integration_id = ${this.i.id} and guest_ref = ${guestRef} and lower(service) = lower(${p.service})
                    order by visit_date desc, created_at desc limit 1)
          and (sessions_total, sessions_done) is distinct from (${total}::int, ${used}::int)
        returning id`);
      this.r.packages.sessions += set.length;
    }
  }

  // ---------------------------------------------------------------- what is left

  /** What waits for the next run, once the run is over. */
  async account(): Promise<void> {
    if (this.i.status === "paused") return;
    for (const s of this.states) {
      s.out.daysLeft = this.path
        ? this.spans(s)
            .filter((w) => !w.recent || !s.recentThrough || w.to > s.recentThrough)
            .reduce((n, w) => n + daysBetween(w.from, w.to) + 1, 0)
        : 0;
      if (s.out.daysLeft) this.left.push(`${count(s.out.daysLeft, "day")} at ${s.c.name ?? s.c.code ?? "a centre"}`);
    }
    const caps = this.access?.capabilities;
    if (caps?.guestDetails === true) {
      const [n] = await withTenant(this.tenantId, (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(externalPeople)
          .where(this.profilesDue()),
      );
      this.r.guests.left = n?.n ?? 0;
      if (this.r.guests.left) this.left.push(count(this.r.guests.left, "guest profile"));
    }
    if (caps?.guestPackages === true) {
      const [n] = await withTenant(this.tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from (${this.packagesDue(null)}) due`));
      this.r.packages.left = n?.n ?? 0;
      if (this.r.packages.left) this.left.push(`${this.r.packages.left} guest${this.r.packages.left === 1 ? "'s" : "s'"} packages`);
    }
  }
}

// ---------------------------------------------------------------- storing visits

interface VisitWrite {
  externalId: string;
  guestRef: string;
  phoneE164: string | null;
  name: string | null;
  service: string;
  visitDate: string;
  doctor: string | null;
  branch: string | null;
  branchId: string | null;
  sessionsTotal: number | null;
}

/**
 * Stores lines read from Zenoti as visits, one per line (their externalId).
 * A line with no number of its own takes the one known for the guest. One
 * visit per person, service and day still holds however it arrived, so a
 * line that would be a second (an uploaded visit, another invoice line, the
 * same service under another path) folds into the visit JENAI has: a new one
 * is not added, and one stored earlier without a number is removed, its
 * twin standing for it. A visit already stored keeps its id, so its planned
 * calls keep theirs.
 */
async function storeVisits(tx: Tx, tenantId: string, integrationId: string, incoming: VisitWrite[]): Promise<{ added: number; updated: number; merged: number }> {
  const out = { added: 0, updated: 0, merged: 0 };
  const list = uniqueBy(incoming, (v) => v.externalId);
  if (!list.length) return out;
  const ids = list.map((v) => v.externalId);
  const stored = new Map<string, { id: string; phone: string | null }>();
  for (const part of chunks(ids)) {
    for (const r of await tx.execute<{ id: string; external_id: string; phone_e164: string | null }>(
      sql`select id, external_id, phone_e164 from visits where integration_id = ${integrationId} and external_id in ${texts(part)}`,
    ))
      stored.set(r.external_id, { id: r.id, phone: r.phone_e164 });
  }
  const known = await knownPhones(
    tx,
    integrationId,
    list.map((v) => v.guestRef),
  );
  const rows = list.map((v) => {
    const had = stored.get(v.externalId);
    return { ...v, id: had?.id ?? null, phoneE164: v.phoneE164 ?? known.get(v.guestRef) ?? had?.phone ?? null };
  });
  const keyOf = (phone: string | null, service: string, day: string) => (phone ? `${phone}|${day}|${service.toLowerCase()}` : null);

  // The same person, service and day held by a visit outside these lines.
  const held = new Set<string>();
  const phones = [...new Set(rows.flatMap((r) => (r.phoneE164 ? [r.phoneE164] : [])))];
  for (const part of chunks(phones)) {
    const others = await tx.execute<{ phone_e164: string; service: string; visit_date: string }>(sql`
      select phone_e164, service, visit_date::text as visit_date from visits
      where phone_e164 in ${texts(part)}
        and not coalesce(integration_id = ${integrationId} and external_id in ${texts(ids)}, false)`);
    for (const o of others) held.add(keyOf(o.phone_e164, o.service, o.visit_date)!);
  }

  const keep: typeof rows = [];
  const drop: string[] = [];
  const taken = new Set<string>();
  // Lines already stored first, so the visit already planned is the one kept.
  for (const r of [...rows].sort((a, b) => Number(a.id === null) - Number(b.id === null) || (a.externalId < b.externalId ? -1 : 1))) {
    const k = keyOf(r.phoneE164, r.service, r.visitDate);
    if (k && (taken.has(k) || held.has(k))) {
      out.merged++;
      if (r.id) drop.push(r.id);
      continue;
    }
    if (k) taken.add(k);
    keep.push(r);
  }
  for (const part of chunks(drop)) await tx.execute(sql`delete from visits where id in ${uuids(part)}`);

  const record = (r: (typeof rows)[number]) => ({
    id: r.id,
    external_id: r.externalId,
    guest_ref: r.guestRef,
    phone_e164: r.phoneE164,
    name: r.name,
    service: r.service,
    visit_date: r.visitDate,
    doctor: r.doctor,
    branch: r.branch,
    branch_id: r.branchId,
    sessions_total: r.sessionsTotal !== null && r.sessionsTotal >= 1 ? r.sessionsTotal : null,
  });
  // A value Zenoti leaves empty keeps the one stored; a visit nothing changed in is not written.
  for (const part of chunks(keep.filter((r) => r.id))) {
    const res = await tx.execute(sql`
      update visits t set
        phone_e164 = v.phone_e164,
        guest_ref = v.guest_ref,
        name = coalesce(v.name, t.name),
        service = v.service,
        visit_date = v.visit_date,
        doctor = coalesce(v.doctor, t.doctor),
        branch = coalesce(v.branch, t.branch),
        branch_id = coalesce(v.branch_id, t.branch_id),
        sessions_total = coalesce(v.sessions_total, t.sessions_total),
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(part.map(record))}::jsonb)
        as v(id uuid, phone_e164 text, guest_ref text, name text, service text, visit_date date, doctor text, branch text, branch_id uuid, sessions_total int)
      where t.id = v.id and t.integration_id = ${integrationId}
        and (t.phone_e164, t.guest_ref, t.name, t.service, t.visit_date, t.doctor, t.branch, t.branch_id, t.sessions_total)
          is distinct from (v.phone_e164, v.guest_ref, coalesce(v.name, t.name), v.service, v.visit_date, coalesce(v.doctor, t.doctor),
                            coalesce(v.branch, t.branch), coalesce(v.branch_id, t.branch_id), coalesce(v.sessions_total, t.sessions_total))
      returning t.id`);
    out.updated += res.length;
  }
  for (const part of chunks(keep.filter((r) => !r.id))) {
    const res = await tx.execute(sql`
      insert into visits (tenant_id, integration_id, external_id, guest_ref, phone_e164, name, service, visit_date, doctor, branch, branch_id, sessions_total, source)
      select ${tenantId}, ${integrationId}, v.external_id, v.guest_ref, v.phone_e164, v.name, v.service, v.visit_date, v.doctor, v.branch, v.branch_id, v.sessions_total, 'api'
      from jsonb_to_recordset(${JSON.stringify(part.map(record))}::jsonb)
        as v(external_id text, guest_ref text, phone_e164 text, name text, service text, visit_date date, doctor text, branch text, branch_id uuid, sessions_total int)
      on conflict do nothing
      returning id`);
    out.added += res.length;
    // Stored meanwhile by an upload: that visit stands for it.
    out.merged += part.length - res.length;
  }
  return out;
}

/** Everyone seen on a booking or a sales line, with what it says. Their profile, read later, has the last word. */
async function seePeople(tx: Tx, tenantId: string, integrationId: string, people: Array<{ externalId: string; phoneE164: string | null; name: string | null }>): Promise<void> {
  const by = new Map<string, { external_id: string; phone_e164: string | null; name: string | null }>();
  for (const p of people) {
    const had = by.get(p.externalId);
    by.set(p.externalId, { external_id: p.externalId, phone_e164: p.phoneE164 ?? had?.phone_e164 ?? null, name: p.name ?? had?.name ?? null });
  }
  for (const part of chunks([...by.values()])) {
    await tx.execute(sql`
      insert into external_people (tenant_id, integration_id, external_id, phone_e164, name)
      select ${tenantId}, ${integrationId}, p.external_id, p.phone_e164, p.name
      from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as p(external_id text, phone_e164 text, name text)
      on conflict (tenant_id, integration_id, external_id) do update set
        phone_e164 = coalesce(excluded.phone_e164, external_people.phone_e164),
        name = coalesce(excluded.name, external_people.name),
        updated_at = now()`);
  }
}

async function knownPhones(tx: Tx, integrationId: string, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(refs)])) {
    const rows = await tx
      .select({ ref: externalPeople.externalId, phone: externalPeople.phoneE164 })
      .from(externalPeople)
      .where(and(eq(externalPeople.integrationId, integrationId), inArray(externalPeople.externalId, part), isNotNull(externalPeople.phoneE164)));
    for (const r of rows) out.set(r.ref, r.phone!);
  }
  return out;
}

// ---------------------------------------------------------------- reading the connection

function accessOf(config: Record<string, unknown>): Access | null {
  const a = obj(config.access);
  if (!Object.keys(a).length) return null;
  const caps = obj(a.capabilities);
  const cap = (k: keyof ZenotiCapabilities) => (caps[k] === true ? true : caps[k] === false ? false : null);
  const path = a.path === "appointments" || a.path === "sales_accrual" || a.path === "sales_report" ? a.path : null;
  return {
    capabilities: { appointments: cap("appointments"), guestDetails: cap("guestDetails"), guestPackages: cap("guestPackages"), salesAccrual: cap("salesAccrual"), salesReport: cap("salesReport") },
    path,
    checkedAt: typeof a.checkedAt === "string" ? a.checkedAt : null,
  };
}

function centresOf(config: Record<string, unknown>): ZenotiCentre[] {
  if (!Array.isArray(config.centres)) return [];
  return config.centres.flatMap((x) => {
    const c = obj(x);
    const id = typeof c.id === "string" && c.id.trim() ? c.id.trim() : null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return id ? [{ id, name: str(c.name), code: str(c.code), phoneCode: str(c.phoneCode) }] : [];
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function cursorOf(i: Integration, centreId: string): string | null {
  const c = obj(obj(i.pullCursor).zenoti)[centreId];
  return typeof c === "string" && DAY.test(c) ? c : null;
}

function backfillDaysOf(config: Record<string, unknown>): number {
  const n = Math.floor(Number(config.backfillDays ?? DEFAULT_BACKFILL_DAYS));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_BACKFILL_DAYS) : DEFAULT_BACKFILL_DAYS;
}

function pageSizeOf(config: Record<string, unknown>): number {
  const n = Math.floor(Number(config.reportPageSize ?? DEFAULT_PAGE_SIZE));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

// ---------------------------------------------------------------- days

const pad = (n: number) => String(n).padStart(2, "0");
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function dayIn(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function startOfDay(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return zoned(y!, m!, d!, 0, tz);
}

/** `from` to `to`, both included, in spans of at most seven days. Empty when `to` is before `from`. */
function split(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let d = from; d <= to; d = addDays(d, SPAN_DAYS)) {
    const end = addDays(d, SPAN_DAYS - 1);
    out.push({ from: d, to: end < to ? end : to });
  }
  return out;
}

// ---------------------------------------------------------------- small things

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A mobile with digits in it, whatever Zenoti calls the field. */
function hasNumber(mobile: unknown): boolean {
  const m = obj(mobile);
  return [m.number, m.display_number].some((x) => (typeof x === "string" || typeof x === "number") && /\d/.test(String(x)));
}

function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}

function* chunks<T>(xs: T[]): Generator<T[]> {
  for (let n = 0; n < xs.length; n += CHUNK) yield xs.slice(n, n + CHUNK);
}

/** A list for `in`, as one parameter: nothing in it matches nothing. */
const texts = (xs: string[]) => sql`(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;
const uuids = (xs: string[]) => sql`(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb)::uuid)`;

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Whether the run changed anything JENAI holds, which is when it is audited: a run that found nothing new leaves no entry. */
function changedAnything(r: ZenotiSyncResult): boolean {
  const v = r.visits;
  return r.bookings.changed + r.bookings.removed + v.added + v.updated + v.removed + v.numbered + r.guests.read + r.packages.guests > 0;
}

const PATH_TEXT: Record<ZenotiPath, string> = { appointments: "appointments", sales_accrual: "the sales accrual report", sales_report: "Zenoti's older sales report" };

/** The run in a sentence or two, counts and centre names only. */
function summaryOf(r: ZenotiSyncResult): string {
  const said: string[] = [];
  const v = r.visits;
  if (r.path) {
    const services = `${count(v.read, "service")} done (${v.added} new)`;
    said.push(
      r.path === "appointments"
        ? `Read ${count(r.bookings.read, "booking")} (${r.bookings.changed} new or changed) and ${services} from appointments.`
        : `Read ${services} from ${PATH_TEXT[r.path]}.`,
    );
  }
  if (r.guests.read) said.push(`Read ${count(r.guests.read, "guest profile")}${v.numbered ? `, which gave ${count(v.numbered, "visit")} a phone number` : ""}.`);
  if (r.packages.guests) said.push(`Read the packages of ${count(r.packages.guests, "guest")}.`);
  const waiting = r.plan?.waitingForPhone ?? 0;
  if (waiting) said.push(`${count(waiting, "service")} done ${waiting === 1 ? "waits" : "wait"} for a phone number.`);
  said.push(r.left.length ? `Left for next time: ${r.left.join(", ")}.` : "Up to date.");
  said.push(`${r.calls} of ${r.budget} calls to Zenoti used.`);
  return said.join(" ");
}
