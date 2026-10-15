import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { audit, branches, clinicAppointments, externalPeople, integrations, visits, withTenant, type Integration, type Tx } from "@jenai/db";
import { replanTenant, type ReplanResult } from "../care-plan";
import { localParts, zoned } from "../dialer/time";
import { PULL_LEASE_MINUTES, endPull, leasedPull, takePullLease } from "./crm-sync";
import { credentialsOf } from "./queue";
import type { ConnectorContext } from "./types";
import { applyBranchMap, zenotiBranchMap, zenotiSaver } from "./zenoti-connect";
import {
  ZenotiBudgetSpent,
  ZenotiBusyError,
  ZenotiClient,
  ZenotiError,
  ZenotiKeyError,
  ZenotiPermissionError,
  packageSessions,
  phoneCodeForZone,
  sessionsLeft,
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
 * included, because the clinic's other apps share Zenoti's 60 a minute, and
 * stops two minutes before its hold on the connection runs out however slow
 * Zenoti is. What it does not reach waits for the next run, which carries on
 * from there:
 *  1. what the key may read, as the last Test found, checked again after a
 *     day or when Zenoti refuses the way services done are read;
 *  2. per centre, the least recently read first, the days not yet read, back
 *     to config.backfillDays (120 unless said), oldest first, seven days a
 *     request (thirty for the accrual report, whose pages are kept track of
 *     so a long one is never started again). pull_cursor.zenoti[centre id]
 *     is the last day fully stored, moved in the transaction that stores it,
 *     and pull_cursor.zenotiFrom[centre id] the first. When backfillDays is
 *     widened later, the days before the first are read too, newest first,
 *     so what is stored stays one unbroken run of days;
 *  3. per centre, the last three days and today again, and on the
 *     appointments path the next fourteen days, at most once an hour
 *     (config.recentEveryHours), because bookings and statuses change after
 *     the fact; on the appointments path, once a day, bookings up to sixty
 *     days ahead, so someone already rebooked weeks out is known to be;
 *  4. guests' profiles, for their number and SMS consents, for guests with a
 *     visit or booking in the last 180 days: never read first, then any read
 *     over 30 days ago; one that gave no number is asked for again after 1,
 *     7 and 30 days, then only once they are seen again;
 *  5. the packages of guests with a visit in the last 180 days, at most once a week each.
 * While profiles or packages may be read, services take at most 60% of a
 * run's calls at first; whatever the others leave goes back to them. A
 * centre Zenoti keeps refusing is set aside for a while, named in what the
 * run says, and the other centres are read meanwhile. The call plan is then
 * made again. Nothing here dials, makes campaign targets or writes to any
 * CRM. Logs and messages carry counts and centre names only, never a guest's
 * name or number.
 *
 * Settings (integration config): backfillDays; onlyCentres, Zenoti centre ids
 * or codes to read (every centre the key sees when empty); reportPageSize,
 * rows per page of the accrual report (100); recentEveryHours (1);
 * defaultCountryCode, for a mobile saved without its country (else the
 * centre's country, else the client's); branchMap, Zenoti centre id to JENAI
 * branch id, matched by name or code each time unless the clinic chose it
 * (branchPins). Each run leaves config.lastSync: when, which path, calls
 * used and a summary.
 */

/** Calls to Zenoti one run makes at most when the caller does not say. */
export const ZENOTI_SYNC_CALLS = 30;
/** Days of history read back when the connection does not say (config.backfillDays). */
export const ZENOTI_DEFAULT_BACKFILL_DAYS = 120;
/** The furthest back a connection reads. */
export const ZENOTI_MAX_BACKFILL_DAYS = 365;
/** Hours between reads of a centre's recent and coming days when the connection does not say (config.recentEveryHours). */
export const ZENOTI_RECENT_EVERY_HOURS = 1;
const MAX_RECENT_EVERY_HOURS = 24;
/** Zenoti's appointments and older sales report take at most seven days a request. */
const SPAN_DAYS = 7;
/** The accrual report takes up to a year a request; a month keeps its spans few and its pages many fewer than a year's. */
const ACCRUAL_SPAN_DAYS = 30;
/** Days before today read again: a visit is closed, a no-show marked, a day or two late. */
const RECENT_DAYS = 3;
/** Days of bookings ahead read with the recent days, on the appointments path. */
const AHEAD_DAYS = 14;
/** Bookings read further ahead, once a day: clinics rebook sessions four to six weeks out. */
const FAR_AHEAD_DAYS = 60;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RETEST_AFTER_MS = DAY_MS;
const FAR_EVERY_MS = DAY_MS;
/** While profiles or packages may be read, services take at most this share of a run's calls before they have had their turn. */
const SERVICES_SHARE = 0.6;
const PROFILE_REFRESH_DAYS = 30;
const PACKAGE_REFRESH_DAYS = 7;
/** Guests are read only while they have a visit or a booking this recent: the plan looks no further back. */
const LOOKBACK_DAYS = 180;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
/** Calls a check of what the key may read makes: the centres, then one per kind of read. */
export const ZENOTI_TEST_CALLS = 6;
const TEST_CALLS = ZENOTI_TEST_CALLS;
/** A centre Zenoti keeps refusing is tried again after an hour, then two, four, and so on up to a day. */
const CENTRE_RETRY_MS = HOUR_MS;
const CENTRE_RETRY_MAX_MS = DAY_MS;
/** A run stops this long before its hold on the connection (crm-sync's pull lease) runs out. */
const LEASE_MARGIN_MS = 2 * 60_000;
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
  /**
   * The caller holds the connection's pull lease already, ending then (the
   * worker's claim, claimPulls), and lets go of it itself once the next read
   * is set. Without this the lease is taken here and let go at the end.
   */
  lease?: Date | null;
  /** False leaves the call plan to the caller, which plans only when the read brought something new. Default true. */
  replan?: boolean;
}

export interface ZenotiCentreSync {
  centreId: string;
  /** As Zenoti names it. */
  name: string | null;
  /** The JENAI branch it was matched to. */
  branchId: string | null;
  /** The last day fully stored. */
  cursor: string | null;
  /** The first day stored: every day from it to the cursor is. */
  from: string | null;
  /** Spans of days read this run. */
  spans: number;
  /** Days still to read, history, the recent days and the bookings further ahead together. */
  daysLeft: number;
  /** Why it was not read, when Zenoti refused it, in plain words. */
  problem: string | null;
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
   * Services done: read, new, changed (an uploaded visit for the same
   * person, service and day taken over included), folded into a visit
   * JENAI already had for them, removed because the booking is no
   * longer completed or the sales line is no longer listed, and given a
   * phone number (or a new one) once their guest's was known.
   */
  visits: { read: number; added: number; updated: number; merged: number; removed: number; numbered: number };
  /** Services done from this connection still without a phone number, theirs or their guest's: counted, not planned until one arrives. */
  waitingForPhone: number;
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
  const startedAt = opts.clock?.now() ?? Date.now();
  const leased = opts.lease !== undefined;
  // The lease a caller took may have started a while ago: only what is left of it counts.
  const leaseLeft = Math.min(PULL_LEASE_MINUTES * 60_000, opts.lease ? opts.lease.getTime() - Date.now() : Infinity);
  // No call starts once the lease is nearly out, so no second run can be reading the connection with this one.
  const budget: ZenotiCallBudget = { left: Math.max(0, Math.floor(opts.callBudget ?? ZENOTI_SYNC_CALLS)), used: 0, until: startedAt + leaseLeft - LEASE_MARGIN_MS };
  const now = opts.now ?? new Date(startedAt);
  const result = zenotiResult(budget.left);
  const taken = leased ? await leasedPull(tenantId, integrationId) : await takePullLease(tenantId, integrationId);
  if (!taken) return result;
  result.ran = true;

  const run = new Run(tenantId, taken.i, taken.timeZone, now, budget, opts, result);
  try {
    await run.go();
    await run.account();
  } catch (e) {
    run.problems.push(`Reading Zenoti stopped: ${errorWithoutValues(e)}`.slice(0, 300));
  } finally {
    result.calls = budget.used;
    result.path = run.path;
    if (opts.replan !== false) {
      try {
        result.plan = await replanTenant(tenantId, { now });
      } catch (e) {
        run.problems.push(`The call plan could not be made again: ${errorWithoutValues(e)}`.slice(0, 300));
      }
    }
    // Counted here, not taken from the plan: the worker plans after the read, and the summary must say it all the same.
    try {
      result.waitingForPhone = await waitingForPhone(tenantId, integrationId);
    } catch {
      // Only a count for the summary: a read that went well is not failed over it.
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
      // Only this run's own lease: one that outlived it never frees a lease another run took since.
      // A read that went wrong and read nothing waits longer before the next on the timer.
      await endPull(tenantId, integrationId, result.error, taken.lease, { keepLease: leased, failed: !!result.error && !zenotiProgressed(result) });
    }
  }
  return result;
}

/** Services done from this connection with no number of their own and none known for their guest, as the plan counts them. */
async function waitingForPhone(tenantId: string, integrationId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from visits v
      where v.integration_id = ${integrationId} and v.phone_e164 is null
        and not exists (select 1 from external_people g where g.integration_id = v.integration_id and g.external_id = v.guest_ref and g.phone_e164 is not null)`),
  );
  return row?.n ?? 0;
}

/** A run's result before anything is read. */
export function zenotiResult(budget: number): ZenotiSyncResult {
  return {
    ran: false,
    path: null,
    calls: 0,
    budget,
    tested: false,
    centres: [],
    bookings: { read: 0, changed: 0, removed: 0 },
    visits: { read: 0, added: 0, updated: 0, merged: 0, removed: 0, numbered: 0 },
    waitingForPhone: 0,
    guests: { read: 0, left: 0 },
    packages: { guests: 0, rows: 0, sessions: 0, left: 0 },
    done: false,
    left: [],
    error: null,
    summary: "",
    plan: null,
  };
}

/** The run moved on: it read some days of a centre, guests' profiles or packages. Reading again soon is worth it only then. */
export function zenotiProgressed(r: ZenotiSyncResult): boolean {
  return r.centres.some((c) => c.spans > 0) || r.guests.read > 0 || r.packages.guests > 0;
}

/** What the run changed that the call plan has to take in, counted. */
export function zenotiChanges(r: ZenotiSyncResult): number {
  const v = r.visits;
  return r.bookings.changed + r.bookings.removed + v.added + v.updated + v.removed + v.numbered + r.guests.read + r.packages.guests;
}

// ---------------------------------------------------------------- one run

interface Access {
  capabilities: ZenotiCapabilities;
  path: ZenotiPath | null;
  /** Null when it must be checked again before it is trusted. */
  checkedAt: string | null;
}

/** How far into a span of the accrual report the last run got (pull_cursor.zenotiPage[centre id]). */
interface PagePlace {
  from: string;
  to: string;
  /** The next page to ask for, of `size` rows. */
  page: number;
  size: number;
  /** Rows read so far, against the total Zenoti gives. */
  seen: number;
  /** When the span's first page was read: a line not seen since then is no longer listed. */
  since: string;
}

/** Zenoti's last refusal at one centre (pull_cursor.zenotiErrors[centre id]), and when it is tried again. */
interface CentreError {
  message: string;
  at: string;
  tries: number;
  retryAt: string;
  /** For a permission refused there: the way services done were being read. */
  path?: ZenotiPath;
}

/** One centre as this run reads it. */
interface CentreState {
  c: ZenotiCentre;
  branchId: string | null;
  branchName: string | null;
  timeZone: string;
  cursor: string | null;
  /** The first day stored. */
  from: string | null;
  /** When its recent and coming days, and its bookings further ahead, were last read (ms). */
  recentAt: number | null;
  farAt: number | null;
  page: PagePlace | null;
  error: CentreError | null;
  /** Its resting from refusals has been said this run. */
  said: boolean;
  /** Its first call this run is marked, for which centre goes first next time. */
  served: boolean;
  /** Spans read this run. */
  read: Set<string>;
  out: ZenotiCentreSync;
}

/**
 * Days from `from` to `to`, both included. Once they are stored, the cursor
 * (the last day stored) goes to `moves` and the first day stored to
 * `starts`; `restart` says the stored days begin again there.
 */
interface Span {
  from: string;
  to: string;
  kind: "history" | "recent" | "far";
  moves: string | null;
  starts: string | null;
  restart: boolean;
  /** The last span of its window: once stored, the window was read. */
  last: boolean;
}

/** A guest's profile as read: what it says, Zenoti having no such guest, or a refusal about this guest alone. */
type ProfileRead = { person: ZenotiPersonRow } | "gone" | "failed";

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
  /** Nothing more of services done this run: a check found nothing to read them from, or one is due first. */
  private halted = false;
  /** The run read nothing, Zenoti having asked JENAI to wait. */
  private held = false;
  private readonly guestTrouble = new Set<string>();

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
    const hold = instantOf(obj(this.i.pullCursor).zenotiNotBefore);
    if (hold !== null && hold > this.now.getTime()) {
      this.held = true;
      this.left.push(`everything, as Zenoti asked JENAI to wait until ${whenText(new Date(hold), this.timeZone)}`);
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
      await this.prepareCentres();
      // Services go first, but while guests may be read they leave them a share, so numbers and packages keep coming during a long backfill.
      const caps = this.access?.capabilities;
      const guestsToo = caps?.guestDetails === true || caps?.guestPackages === true;
      await this.readServices(guestsToo ? Math.ceil(this.budget.left * SERVICES_SHARE) : this.budget.left, false);
      await this.readProfiles(this.access?.capabilities.guestPackages === true ? Math.ceil(this.budget.left / 2) : this.budget.left);
      await this.readPackages(this.budget.left);
      // What the shares left goes where there is still something to read: every centre's days, then the bookings further ahead.
      await this.readServices(this.budget.left, false);
      await this.readServices(this.budget.left, true);
      await this.readProfiles(this.budget.left);
      await this.readPackages(this.budget.left);
    } catch (e) {
      await this.stopped(e);
    }
  }

  /** Why the run stopped, in words the clinic can act on. Out of calls or time is no problem: what is left says the rest. */
  private async stopped(e: unknown): Promise<void> {
    if (e instanceof ZenotiBudgetSpent) return;
    if (e instanceof ZenotiKeyError) {
      this.problems.push(`${e.message} Ask your Zenoti admin for the API key of the backend app made for JENAI and save it here again.`);
    } else if (e instanceof ZenotiBusyError && e.notBefore !== null) {
      // Asked to wait longer than a run waits: the next run waits too, rather than asking again at once.
      const until = new Date(e.notBefore);
      await withTenant(this.tenantId, (tx) =>
        tx
          .update(integrations)
          .set({ pullCursor: sql`${integrations.pullCursor} || jsonb_build_object('zenotiNotBefore', ${until.toISOString()}::text)` })
          .where(eq(integrations.id, this.i.id)),
      );
      this.problems.push(`${e.message} It asked JENAI to wait until ${whenText(until, this.timeZone)}, so nothing more is read before then.`);
    } else if (e instanceof ZenotiError) {
      this.problems.push(e.retryLater ? `${e.message} JENAI tries again next time.` : e.message);
    } else {
      this.problems.push(`Reading Zenoti stopped: ${errorWithoutValues(e)}`.slice(0, 300));
    }
  }

  /** Keeps what the run learnt on the connection, merged into what is there, so nothing saved meanwhile is lost. */
  async save(patch: { credentials?: Record<string, string>; config?: Record<string, unknown> }): Promise<void> {
    await zenotiSaver(this.tenantId, this.i.id)(patch);
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

  // ---------------------------------------------------------------- centres

  /** The centres to read and where each got to, the one read least recently first, so every centre gets its turn. */
  private async prepareCentres(): Promise<void> {
    const centres = this.centres();
    if (!centres.length) {
      this.problems.push("None of the centres chosen for this connection is one the key sees in Zenoti.");
      return;
    }
    const places = await this.places(centres);
    // Never read sorts first.
    const served = (id: string) => instantOf(centreMark(this.i, "zenotiServed", id)) ?? -1;
    this.states = centres
      .map((c) => {
        const p = places.get(c.id)!;
        const cursor = dayMark(this.i, "zenoti", c.id);
        const from = dayMark(this.i, "zenotiFrom", c.id);
        return {
          c,
          ...p,
          cursor,
          from,
          recentAt: instantOf(centreMark(this.i, "zenotiRecentAt", c.id)),
          farAt: instantOf(centreMark(this.i, "zenotiFarAt", c.id)),
          page: pagePlaceOf(centreMark(this.i, "zenotiPage", c.id)),
          error: centreErrorOf(centreMark(this.i, "zenotiErrors", c.id)),
          said: false,
          served: false,
          read: new Set<string>(),
          out: { centreId: c.id, name: c.name, branchId: p.branchId, cursor, from, spans: 0, daysLeft: 0, problem: null },
        };
      })
      .sort((a, b) => served(a.c.id) - served(b.c.id));
    this.r.centres = this.states.map((s) => s.out);
    if (this.path !== "appointments") await this.dropFutureBookings();
  }

  /** The centres to read: config.onlyCentres by id or code, else every one the key sees. */
  private centres(): ZenotiCentre[] {
    const all = centresOf(this.config);
    const only = Array.isArray(this.config.onlyCentres) ? this.config.onlyCentres.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    return only.length ? all.filter((c) => only.includes(c.id.toLowerCase()) || (c.code && only.includes(c.code.toLowerCase()))) : all;
  }

  /**
   * Each centre's JENAI branch and time zone. A branch the clinic chose for a
   * centre stands while it exists; any other is matched again by name or
   * code. A changed map is saved, so the clinic sees and can correct it, and
   * put on what is already stored from the centre, in one transaction. The
   * centre's own time zone, as Zenoti gives it, comes first.
   */
  private async places(centres: ZenotiCentre[]): Promise<Map<string, { branchId: string | null; branchName: string | null; timeZone: string }>> {
    const list = await withTenant(this.tenantId, async (tx) => {
      const list = await tx.select({ id: branches.id, name: branches.name, code: branches.code, timezone: branches.timezone }).from(branches);
      const had = obj(this.config.branchMap);
      const map = zenotiBranchMap(centres, list, had, obj(this.config.branchPins));
      if (JSON.stringify(map) !== JSON.stringify(had)) {
        await applyBranchMap(tx, this.i.id, map, had);
        await tx
          .update(integrations)
          .set({ config: sql`${integrations.config} || ${JSON.stringify({ branchMap: map })}::jsonb`, updatedAt: new Date() })
          .where(eq(integrations.id, this.i.id));
        this.config = { ...this.config, branchMap: map };
      }
      return list;
    });
    const map = obj(this.config.branchMap);
    return new Map(
      centres.map((c) => {
        const b = list.find((x) => x.id === map[c.id]) ?? null;
        return [c.id, { branchId: b?.id ?? null, branchName: b?.name ?? null, timeZone: c.timeZone ?? b?.timezone ?? this.timeZone }];
      }),
    );
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
        .where(and(eq(clinicAppointments.integrationId, this.i.id), sql`${clinicAppointments.startsAt} >= ${this.now.toISOString()}::timestamptz`))
        .returning({ id: clinicAppointments.id }),
    );
    this.r.bookings.removed += gone.length;
  }

  private centreName(s: CentreState): string {
    const { name, code } = s.c;
    return name && code ? `${name} (${code})` : (name ?? code ?? "a centre with no name");
  }

  /** The centre that the check of what the key may read looks at: a refusal there says something about the key. */
  private probed(s: CentreState): boolean {
    return centresOf(this.config)[0]?.id === s.c.id;
  }

  /**
   * Set aside after Zenoti refused it, until its time to try again. Said once
   * a run. A permission refused for one way of reading services done says
   * nothing once they are read another way.
   */
  private resting(s: CentreState): boolean {
    if (!s.error || Date.parse(s.error.retryAt) <= this.now.getTime()) return false;
    if (s.error.path && s.error.path !== this.path) return false;
    if (!s.said) {
      s.said = true;
      s.out.problem = s.error.message;
      this.problems.push(`${s.error.message} JENAI tries ${this.centreName(s)} again after ${whenText(new Date(s.error.retryAt), this.timeZone)}.`);
    }
    return true;
  }

  // ---------------------------------------------------------------- services done, and bookings

  /** Centre after centre, until `cap` more calls are made. The bookings further ahead only when `far`. */
  private async readServices(cap: number, far: boolean): Promise<void> {
    if (this.halted || !this.path || cap <= 0) return;
    const stopAt = this.budget.used + cap;
    for (const s of this.states) {
      if (this.halted || this.budget.used >= stopAt) return;
      if (this.resting(s)) continue;
      await this.serve(s, stopAt, far);
    }
  }

  /**
   * One centre's spans. Out of calls or time, a key Zenoti no longer accepts
   * and Zenoti asking to slow down stop the run. Anything else Zenoti says
   * about this centre sets it aside, and the next centre is read: one
   * centre's trouble never stops the others, nor guests and packages.
   */
  private async serve(s: CentreState, stopAt: number, far: boolean): Promise<void> {
    for (;;) {
      try {
        await this.readCentre(s, stopAt, far);
        return;
      } catch (e) {
        if (stopsRun(e)) throw e;
        if (e instanceof ZenotiPermissionError && this.probed(s) && !this.r.tested) {
          // Zenoti stopped letting the key read where services done came from:
          // what it may read now decides where they come from instead.
          if (this.budget.left < TEST_CALLS) {
            this.problems.push(`${e.message} JENAI checks what the key may read on its next run.`);
            if (this.access) await this.save({ config: { access: { ...this.access, checkedAt: null } } });
            this.halted = true;
            return;
          }
          const before = this.path;
          if (!(await this.check())) {
            this.halted = true;
            return;
          }
          if (this.path !== before) {
            this.problems.push(`${e.message} Services done are read from ${PATH_TEXT[this.path!]} instead.`);
            if (this.path !== "appointments") await this.dropFutureBookings();
            continue;
          }
        }
        await this.centreFailed(s, e);
        return;
      }
    }
  }

  /**
   * Sets a centre aside after Zenoti refused it: an hour, then two, four and
   * so on up to a day; a permission refused at this centre alone, until the
   * next daily check. Kept in pull_cursor.zenotiErrors, said in plain words.
   */
  private async centreFailed(s: CentreState, e: unknown): Promise<void> {
    const name = this.centreName(s);
    const denied = e instanceof ZenotiPermissionError;
    const tries = (s.error?.tries ?? 0) + 1;
    const wait = denied ? RETEST_AFTER_MS : Math.min(CENTRE_RETRY_MAX_MS, CENTRE_RETRY_MS * 2 ** (tries - 1));
    const message = denied
      ? `Zenoti does not let this key read ${e.what} at ${name}, though it may at other centres. Ask your Zenoti admin to give the backend app made for JENAI access to that centre (in Zenoti: Configuration, then Apps under Integrations).`
      : `At ${name}: ${e instanceof ZenotiError ? e.message : `reading stopped: ${errorWithoutValues(e)}`}`;
    const error: CentreError = {
      message: message.slice(0, 400),
      at: this.now.toISOString(),
      tries,
      retryAt: new Date(this.now.getTime() + wait).toISOString(),
      ...(denied && this.path ? { path: this.path } : {}),
    };
    await withTenant(this.tenantId, async (tx) => {
      await this.markCentre(tx, "zenotiErrors", s.c.id, error);
      await this.markCentre(tx, "zenotiServed", s.c.id, this.now.toISOString());
    });
    s.error = error;
    s.said = true;
    s.out.problem = error.message;
    this.problems.push(`${error.message} JENAI tries ${name} again after ${whenText(new Date(error.retryAt), this.timeZone)}, and reads the other centres meanwhile.`);
  }

  /**
   * The days one centre still has to read, in order: any days the window was
   * widened by, newest first; history from the cursor, oldest first; the
   * recent and coming days when due; the bookings further ahead when due and
   * asked for. Spans read this run are left out.
   */
  private spans(s: CentreState, far: boolean): Span[] {
    const today = dayIn(this.now, s.timeZone);
    const recentFrom = addDays(today, -RECENT_DAYS);
    const earliest = addDays(today, -zenotiBackfillDays(this.config));
    const len = this.path === "sales_accrual" ? ACCRUAL_SPAN_DAYS : SPAN_DAYS;
    // Carrying on from the cursor, or starting again when there is none or it fell out of the window.
    const carryOn = !!s.cursor && s.cursor >= earliest;
    const out: Span[] = [];
    const span = (w: { from: string; to: string }, kind: Span["kind"], moves: string | null, starts: string | null, last = false): Span => ({ ...w, kind, moves, starts, restart: false, last });
    if (carryOn && s.from && earliest < s.from) {
      // Newest first, so each span stored joins on to what is stored already.
      for (const w of splitBack(earliest, addDays(s.from, -1), len)) out.push(span(w, "history", null, w.from));
    }
    const start = carryOn ? addDays(s.cursor!, 1) : earliest;
    for (const w of split(start, addDays(recentFrom, -1), len)) out.push(span(w, "history", w.to, null));
    if (this.due(s.recentAt, this.recentEvery())) {
      const until = this.path === "appointments" ? addDays(today, AHEAD_DAYS) : today;
      const recent = split(recentFrom, until, len);
      // Once the recent days through yesterday are stored too, every day before today is.
      recent.forEach((w, n) => out.push(span(w, "recent", n === 0 ? addDays(today, -1) : null, null, n === recent.length - 1)));
    }
    if (far && this.path === "appointments" && this.due(s.farAt, FAR_EVERY_MS)) {
      const ahead = split(addDays(today, AHEAD_DAYS + 1), addDays(today, FAR_AHEAD_DAYS), SPAN_DAYS);
      ahead.forEach((w, n) => out.push(span(w, "far", null, null, n === ahead.length - 1)));
    }
    if (!carryOn) {
      // Starting again: the first span stored is where the stored days begin.
      const first = out.find((w) => w.moves);
      if (first) Object.assign(first, { starts: first.from, restart: true });
    }
    return out.filter((w) => !s.read.has(spanKey(w)));
  }

  private due(at: number | null, every: number): boolean {
    return at === null || this.now.getTime() - at >= every;
  }

  private recentEvery(): number {
    const n = Number(this.config.recentEveryHours ?? ZENOTI_RECENT_EVERY_HOURS);
    return (Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_RECENT_EVERY_HOURS) : ZENOTI_RECENT_EVERY_HOURS) * HOUR_MS;
  }

  private async readCentre(s: CentreState, stopAt: number, far: boolean): Promise<void> {
    for (const w of this.spans(s, far)) {
      if (this.budget.used >= stopAt) return;
      if (!s.served) {
        s.served = true;
        await withTenant(this.tenantId, (tx) => this.markCentre(tx, "zenotiServed", s.c.id, this.now.toISOString()));
      }
      const client = this.client!;
      if (this.path === "appointments") {
        const raw = await client.appointments(s.c.id, w.from, addDays(w.to, 1));
        await this.placePhones(
          raw.map((a) => obj(a.guest).mobile),
          s,
        );
        await withTenant(this.tenantId, async (tx) => {
          await this.storeAppointments(tx, s, w, raw);
          await this.spanDone(tx, s, w);
        });
      } else if (this.path === "sales_accrual") {
        if (!(await this.readAccrualSpan(s, w, stopAt))) return;
      } else {
        const rows = await client.salesReport(s.c.id, w.from, w.to);
        await withTenant(this.tenantId, async (tx) => {
          await this.storeReport(
            tx,
            s,
            rows.map((x) => zenotiSalesReportVisit(x, { centreRef: s.c.id })),
          );
          await this.dropUnlisted(tx, s, w, this.now.toISOString());
          await this.spanDone(tx, s, w);
        });
      }
      this.advance(s, w);
    }
  }

  /**
   * One span of the accrual report, page by page, each kept as it comes, and
   * where it got to kept with it (pull_cursor.zenotiPage), so a span longer
   * than a run's calls carries on next run instead of starting again. The
   * last page is the one that brings as many rows as Zenoti said there are,
   * or, when it does not say, a short one. False when it stopped part way.
   */
  private async readAccrualSpan(s: CentreState, w: Span, stopAt: number): Promise<boolean> {
    const had = s.page && s.page.from === w.from && s.page.to === w.to ? s.page : null;
    let size = had?.size ?? pageSizeOf(this.config);
    let page = had?.page ?? 1;
    let seen = had?.seen ?? 0;
    const since = had?.since ?? this.now.toISOString();
    for (let first = true; ; first = false) {
      if (!first && this.budget.used >= stopAt) return false;
      const { rows, total } = await this.client!.salesAccrual({ centreIds: [s.c.id], from: w.from, to: w.to, page, size });
      seen += rows.length;
      const last = !rows.length || (total !== null ? seen >= total : rows.length < size);
      if (!last && rows.length < size) {
        // Zenoti gave fewer than asked with more to come: its own page size, which the next pages go by.
        size = rows.length;
      }
      const place: PagePlace | null = last ? null : { from: w.from, to: w.to, page: Math.floor(seen / size) + 1, size, seen, since };
      await withTenant(this.tenantId, async (tx) => {
        await this.storeReport(
          tx,
          s,
          rows.map((x) => zenotiSalesAccrualVisit(x, { centreRef: s.c.id })),
        );
        await this.markCentre(tx, "zenotiPage", s.c.id, place);
        if (last) {
          await this.dropUnlisted(tx, s, w, since);
          await this.spanDone(tx, s, w);
        }
      });
      s.page = place;
      if (last) return true;
      page = place!.page;
    }
  }

  /** What storing a span moves, in the transaction that stores it. */
  private async spanDone(tx: Tx, s: CentreState, w: Span): Promise<void> {
    if (w.moves && w.moves > (s.cursor ?? "")) await this.markDay(tx, "zenoti", s.c.id, w.moves, false);
    if (w.starts) await this.markDay(tx, "zenotiFrom", s.c.id, w.starts, w.restart);
    if (w.last && w.kind === "recent") await this.markCentre(tx, "zenotiRecentAt", s.c.id, this.now.toISOString());
    if (w.last && w.kind === "far") await this.markCentre(tx, "zenotiFarAt", s.c.id, this.now.toISOString());
    // Read again without trouble: no longer set aside.
    if (s.error) await this.markCentre(tx, "zenotiErrors", s.c.id, null);
  }

  /** The same, for what this run knows. */
  private advance(s: CentreState, w: Span): void {
    if (w.moves && w.moves > (s.cursor ?? "")) s.cursor = s.out.cursor = w.moves;
    if (w.starts && (w.restart || !s.from || w.starts < s.from)) s.from = s.out.from = w.starts;
    if (w.last && w.kind === "recent") s.recentAt = this.now.getTime();
    if (w.last && w.kind === "far") s.farAt = this.now.getTime();
    s.error = null;
    s.out.problem = null;
    s.read.add(spanKey(w));
    s.out.spans++;
  }

  /**
   * pull_cursor[key][centre id] set to a day: the cursor only ever forward and
   * the first day stored only back (unless the stored days start again), so a
   * run that finished late never undoes a newer one's.
   */
  private async markDay(tx: Tx, key: "zenoti" | "zenotiFrom", centreId: string, day: string, force: boolean): Promise<void> {
    const had = sql`(${integrations.pullCursor} -> ${key}::text ->> ${centreId}::text)`;
    const value = force ? sql`${day}::text` : key === "zenoti" ? sql`greatest(${had}, ${day}::text)` : sql`least(${had}, ${day}::text)`;
    await tx
      .update(integrations)
      .set({ pullCursor: sql`${integrations.pullCursor} || jsonb_build_object(${key}::text, coalesce(${integrations.pullCursor} -> ${key}::text, '{}'::jsonb) || jsonb_build_object(${centreId}::text, ${value}))` })
      .where(eq(integrations.id, this.i.id));
  }

  /** pull_cursor[key][centre id] set to a value, every other centre's and key's left as it is; null removes it. */
  private async markCentre(tx: Tx, key: CentreMark, centreId: string, value: unknown): Promise<void> {
    const cursor =
      value === null
        ? sql`${integrations.pullCursor} #- array[${key}::text, ${centreId}::text]`
        : sql`${integrations.pullCursor} || jsonb_build_object(${key}::text, coalesce(${integrations.pullCursor} -> ${key}::text, '{}'::jsonb) || jsonb_build_object(${centreId}::text, ${JSON.stringify(value)}::jsonb))`;
    await tx.update(integrations).set({ pullCursor: cursor }).where(eq(integrations.id, this.i.id));
  }

  private async storeAppointments(tx: Tx, s: CentreState, w: Span, raw: Record<string, unknown>[]): Promise<void> {
    const opts = { centreRef: s.c.id, timeZone: s.timeZone, ...this.phoneOpts(s) };
    const rows = uniqueBy(
      raw.flatMap((a) => zenotiAppointmentRow(a, opts) ?? []),
      (a) => a.externalId,
    );
    const done = uniqueBy(
      raw.flatMap((a) => zenotiAppointmentVisit(a, opts) ?? []),
      (v) => v.externalId,
    );
    await this.seeGuests(
      tx,
      rows.map((a) => ({ externalId: a.guestRef, phoneE164: a.phoneE164 ?? null, name: a.name ?? null })),
    );
    const known = await knownPhones(
      tx,
      this.i.id,
      rows.map((a) => a.guestRef),
    );
    for (const part of chunks(rows)) {
      const json = part.map((a) => ({
        external_id: a.externalId,
        guest_ref: a.guestRef,
        phone_e164: a.phoneE164 ?? known.get(a.guestRef) ?? null,
        name: a.name ?? null,
        service: a.service,
        category: a.category ?? null,
        starts_at: a.startsAt.toISOString(),
        local_day: a.localDay ?? null,
        status: a.status,
        doctor: a.doctor ?? null,
        centre_ref: s.c.id,
        branch_id: s.branchId,
      }));
      // A booking Zenoti has as it was is not written again.
      const changed = await tx.execute(sql`
        insert into clinic_appointments (tenant_id, integration_id, external_id, guest_ref, phone_e164, name, service, category, starts_at, local_day, status, doctor, centre_ref, branch_id)
        select ${this.tenantId}, ${this.i.id}, a.external_id, a.guest_ref, a.phone_e164, a.name, a.service, a.category, a.starts_at, a.local_day, a.status, a.doctor, a.centre_ref, a.branch_id
        from jsonb_to_recordset(${JSON.stringify(json)}::jsonb) as a(external_id text, guest_ref text, phone_e164 text, name text, service text, category text, starts_at timestamptz, local_day date, status text, doctor text, centre_ref text, branch_id uuid)
        on conflict (tenant_id, integration_id, external_id) do update set
          guest_ref = excluded.guest_ref,
          phone_e164 = coalesce(excluded.phone_e164, clinic_appointments.phone_e164),
          name = coalesce(excluded.name, clinic_appointments.name),
          service = excluded.service,
          category = excluded.category,
          starts_at = excluded.starts_at,
          local_day = excluded.local_day,
          status = excluded.status,
          doctor = excluded.doctor,
          centre_ref = excluded.centre_ref,
          branch_id = excluded.branch_id,
          updated_at = now()
        where (clinic_appointments.guest_ref, clinic_appointments.phone_e164, clinic_appointments.name, clinic_appointments.service, clinic_appointments.category,
               clinic_appointments.starts_at, clinic_appointments.local_day, clinic_appointments.status, clinic_appointments.doctor, clinic_appointments.centre_ref, clinic_appointments.branch_id)
          is distinct from (excluded.guest_ref, coalesce(excluded.phone_e164, clinic_appointments.phone_e164), coalesce(excluded.name, clinic_appointments.name),
               excluded.service, excluded.category, excluded.starts_at, excluded.local_day, excluded.status, excluded.doctor, excluded.centre_ref, excluded.branch_id)
        returning 1`);
      this.r.bookings.changed += changed.length;
    }
    this.r.bookings.read += rows.length;

    // A booking Zenoti no longer lists for these days was deleted there, or
    // moved to a day whose own span puts it back. Zenoti lists bookings by
    // their day in centre time, so that day decides, never an instant worked
    // out in a time zone JENAI had to assume for the centre.
    const gone = await tx.execute<{ external_id: string }>(sql`
      delete from clinic_appointments
      where integration_id = ${this.i.id} and centre_ref = ${s.c.id}
        and case when local_day is not null then local_day between ${w.from}::date and ${w.to}::date
                 else starts_at >= ${startOfDay(w.from, s.timeZone).toISOString()}::timestamptz
                  and starts_at < ${startOfDay(addDays(w.to, 1), s.timeZone).toISOString()}::timestamptz end
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
    await this.seeGuests(
      tx,
      done.map((v) => ({ externalId: v.guestRef, phoneE164: v.phoneE164, name: v.name })),
    );
    await this.storeVisitLines(tx, s, done);
  }

  /**
   * A report re-read for some days lists what Zenoti still has for them: a
   * service line stored earlier that it no longer lists (an invoice voided
   * or opened again, a line removed) goes. Only lines both done and listed
   * within the days count, so a line listed under the day after its service
   * is never taken for one that was dropped.
   */
  private async dropUnlisted(tx: Tx, s: CentreState, w: Span, since: string): Promise<void> {
    const gone = await tx.execute(sql`
      delete from visits
      where integration_id = ${this.i.id} and centre_ref = ${s.c.id} and external_id is not null
        and visit_date between ${w.from}::date and ${w.to}::date
        and coalesce(listed_on, visit_date) between ${w.from}::date and ${w.to}::date
        and (seen_at is null or seen_at < ${since}::timestamptz)
      returning id`);
    this.r.visits.removed += gone.length;
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
        // The branch as the clinic names it in JENAI, so the plan's centres treat visits and bookings alike.
        branch: s.branchName ?? s.c.name ?? s.c.code,
        branchId: s.branchId,
        sessionsTotal: v.sessionsTotal,
        centreRef: s.c.id,
        listedOn: v.listedOn,
        categories: v.categories,
        seenAt: this.now.toISOString(),
      })),
    );
    this.r.visits.read += done.length;
    this.r.visits.added += res.added;
    this.r.visits.updated += res.updated;
    this.r.visits.merged += res.merged;
  }

  // ---------------------------------------------------------------- phones

  /**
   * For a mobile saved without its country: the connection's setting, else
   * the centre's country (or its time zone's), else the client's time zone's.
   * Never a guess beyond that: such a mobile then gives no number.
   */
  private phoneOpts(s: CentreState | null): ZenotiPhoneOptions {
    const own = this.config.defaultCountryCode;
    const set = own === undefined || own === null || String(own).trim() === "" ? null : String(own);
    const centre = s ? centreCode(s.c) : this.sharedCentreCode();
    return { defaultCountryCode: set ?? centre ?? phoneCodeForZone(this.timeZone) ?? undefined, phoneCodes: this.codes ?? undefined };
  }

  /** For a guest's profile, which no centre owns: the centres' country when they all share one. */
  private sharedCentreCode(): string | null {
    const codes = new Set(centresOf(this.config).map(centreCode));
    return codes.size === 1 ? ([...codes][0] ?? null) : null;
  }

  /**
   * A mobile whose country the built-in codes cannot place: Zenoti's own
   * country list is read, once a run, and only then.
   */
  private async placePhones(mobiles: unknown[], s: CentreState | null): Promise<void> {
    if (this.codesTried || !mobiles.some((m) => hasNumber(m) && !zenotiPhone(m, this.phoneOpts(s)))) return;
    this.codesTried = true;
    try {
      this.codes = await this.client!.phoneCodes();
    } catch (e) {
      // Out of calls: what was read is still stored, with the numbers the built-in codes place.
      if (!(e instanceof ZenotiBudgetSpent)) throw e;
    }
  }

  /**
   * Everyone seen on a booking or a sales line, with what it says. A booking's
   * mobile that is new for the guest (none known before, or another one)
   * goes on everything of theirs already stored, so a visit read before the
   * number is planned once it arrives, and nothing is planned on an old one.
   */
  private async seeGuests(tx: Tx, people: Array<{ externalId: string; phoneE164: string | null; name: string | null }>): Promise<void> {
    const before = await storedPhones(
      tx,
      this.i.id,
      people.map((p) => p.externalId),
    );
    const now = await seePeople(tx, this.tenantId, this.i.id, people);
    const changed = new Map<string, string | null>();
    for (const [ref, phone] of now) if (before.has(ref) && phone && before.get(ref) !== phone) changed.set(ref, phone);
    await this.applyGuestPhones(tx, changed);
  }

  /**
   * A guest's number, as it now is, on everything of theirs from this
   * connection: bookings, package balances and visits. Visits are stored
   * again under it, so one that becomes a copy of a visit JENAI already has
   * folds into it; with no number, they wait for one, uncalled.
   */
  private async applyGuestPhones(tx: Tx, changes: Map<string, string | null>): Promise<void> {
    if (!changes.size) return;
    const json = [...changes].map(([ref, phone]) => ({ ref, phone }));
    for (const part of chunks(json)) {
      const list = sql`jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as c(ref text, phone text)`;
      await tx.execute(sql`
        update clinic_appointments a set phone_e164 = c.phone, updated_at = now() from ${list}
        where a.integration_id = ${this.i.id} and a.guest_ref = c.ref and a.phone_e164 is distinct from c.phone`);
      await tx.execute(sql`
        update package_balances b set phone_e164 = c.phone from ${list}
        where b.integration_id = ${this.i.id} and b.guest_ref = c.ref and b.phone_e164 is distinct from c.phone`);
    }
    const theirs: Array<typeof visits.$inferSelect> = [];
    for (const part of chunks([...changes.keys()]))
      theirs.push(...(await tx.select().from(visits).where(and(eq(visits.integrationId, this.i.id), inArray(visits.guestRef, part), isNotNull(visits.externalId)))));
    // A visit the clinic uploaded, which Zenoti took over, keeps the number it came with when their profile now has none.
    const move = theirs.filter((v) => {
      const to = changes.get(v.guestRef!) ?? null;
      return v.phoneE164 !== to && !(to === null && v.source === "upload");
    });
    if (!move.length) return;
    const res = await storeVisits(
      tx,
      this.tenantId,
      this.i.id,
      move.map((v) => ({
        externalId: v.externalId!,
        guestRef: v.guestRef!,
        phoneE164: changes.get(v.guestRef!) ?? null,
        name: v.name,
        service: v.service,
        visitDate: v.visitDate,
        doctor: v.doctor,
        branch: v.branch,
        branchId: v.branchId,
        sessionsTotal: v.sessionsTotal,
        // Carried to an uploaded visit this one folds into and becomes: no later read of an older day would give them.
        centreRef: v.centreRef,
        listedOn: v.listedOn,
        categories: v.categories,
        seenAt: v.seenAt?.toISOString(),
      })),
      { exactPhone: true },
    );
    this.r.visits.numbered += res.updated;
    this.r.visits.merged += res.merged;
  }

  /** A refusal about one guest, said once a run: the guest is marked read and the next one is read. */
  private guestProblem(what: string, e: unknown): void {
    if (this.guestTrouble.has(what)) return;
    this.guestTrouble.add(what);
    const status = e instanceof ZenotiError && e.status ? ` (HTTP ${e.status})` : "";
    this.problems.push(`Zenoti refused ${what} for some guests${status}; JENAI read the others and asks for those again later.`);
  }

  // ---------------------------------------------------------------- guests' profiles

  /**
   * Profiles due: guests with a visit or booking in the last 180 days, never
   * read, or read over 30 days ago; one that gave no number, or whom Zenoti
   * did not have, after 1, 7 and 30 days, then only once seen again (a visit
   * after the last read, or a booking after it), never more than monthly.
   */
  private profilesDue(): SQL {
    const ago = (days: number) => new Date(this.now.getTime() - days * DAY_MS).toISOString();
    const since = addDays(dayIn(this.now, this.timeZone), -LOOKBACK_DAYS);
    const seenAgain = sql`(
      exists (select 1 from visits v where v.integration_id = p.integration_id and v.guest_ref = p.external_id and v.visit_date > (p.fetched_at at time zone ${this.timeZone})::date)
      or exists (select 1 from clinic_appointments a where a.integration_id = p.integration_id and a.guest_ref = p.external_id and a.starts_at > p.fetched_at))`;
    return sql`
      p.integration_id = ${this.i.id}
      and (
        p.fetched_at is null
        or (p.profile_misses = 0 and p.fetched_at < ${ago(PROFILE_REFRESH_DAYS)}::timestamptz)
        or (p.profile_misses = 1 and p.fetched_at < ${ago(1)}::timestamptz)
        or (p.profile_misses = 2 and p.fetched_at < ${ago(7)}::timestamptz)
        or (p.profile_misses >= 3 and p.fetched_at < ${ago(30)}::timestamptz and (p.profile_misses = 3 or ${seenAgain})))
      and (
        exists (select 1 from visits v where v.integration_id = p.integration_id and v.guest_ref = p.external_id and v.visit_date >= ${since}::date)
        or exists (select 1 from clinic_appointments a where a.integration_id = p.integration_id and a.guest_ref = p.external_id and a.starts_at >= ${startOfDay(since, this.timeZone).toISOString()}::timestamptz)
        or (p.phone_e164 is not null and exists (select 1 from visits v where v.phone_e164 = p.phone_e164 and v.visit_date >= ${since}::date)))`;
  }

  /** Guests' profiles, for their number and consents, up to `cap` calls: never read first, then the oldest read. */
  private async readProfiles(cap: number): Promise<void> {
    if (this.access?.capabilities.guestDetails !== true || cap <= 0) return;
    const stopAt = this.budget.used + cap;
    const due = await withTenant(this.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select p.external_id as id from external_people p where ${this.profilesDue()}
        order by p.fetched_at asc nulls first, p.updated_at desc limit ${cap}`),
    );
    for (const { id } of due) {
      if (this.budget.used >= stopAt || this.access?.capabilities.guestDetails !== true) return;
      let read: ProfileRead;
      try {
        const guest = await this.client!.guest(id);
        if (guest) {
          await this.placePhones([obj(guest.personal_info).mobile_phone ?? guest.mobile], null);
          const person = zenotiPerson({ ...guest, id: guest.id ?? id }, this.phoneOpts(null));
          read = person ? { person } : "failed";
        } else read = "gone";
      } catch (e) {
        if (e instanceof ZenotiPermissionError) return this.denied("guestDetails", e);
        if (stopsGuests(e)) throw e;
        this.guestProblem("the details of", e);
        read = "failed";
      }
      await withTenant(this.tenantId, (tx) => this.storeProfile(tx, id, read));
      this.r.guests.read++;
    }
  }

  /**
   * What a profile says, as it now is: its number replaces the one held (or
   * clears it, when the profile has none JENAI can dial), and goes on
   * everything of theirs. A guest Zenoti no longer has (merged into another,
   * or deleted) keeps what is held, and is asked for again only much later.
   */
  private async storeProfile(tx: Tx, guestRef: string, read: ProfileRead): Promise<void> {
    const at = this.now.toISOString();
    if (typeof read === "object") {
      const p = read.person;
      const phone = p.phoneE164 ?? null;
      const [had] = await tx.select({ phone: externalPeople.phoneE164 }).from(externalPeople).where(and(eq(externalPeople.integrationId, this.i.id), eq(externalPeople.externalId, guestRef)));
      await tx.execute(sql`
        insert into external_people (tenant_id, integration_id, external_id, phone_e164, name, marketing_sms_consent, transactional_sms_consent, fetched_at, profile_misses)
        values (${this.tenantId}, ${this.i.id}, ${guestRef}, ${phone}, ${p.name ?? null}, ${p.marketingSmsConsent ?? null}::boolean, ${p.transactionalSmsConsent ?? null}::boolean,
                ${at}::timestamptz, ${phone ? 0 : 1})
        on conflict (tenant_id, integration_id, external_id) do update set
          phone_e164 = excluded.phone_e164,
          name = coalesce(excluded.name, external_people.name),
          marketing_sms_consent = excluded.marketing_sms_consent,
          transactional_sms_consent = excluded.transactional_sms_consent,
          fetched_at = excluded.fetched_at,
          profile_misses = case when excluded.phone_e164 is null then external_people.profile_misses + 1 else 0 end,
          updated_at = now()`);
      if (had && (had.phone ?? null) !== phone) await this.applyGuestPhones(tx, new Map([[guestRef, phone]]));
      return;
    }
    // No such guest is not retried the next day, as a profile with no number is: straight to a month.
    await tx.execute(sql`
      insert into external_people (tenant_id, integration_id, external_id, fetched_at, profile_misses)
      values (${this.tenantId}, ${this.i.id}, ${guestRef}, ${at}::timestamptz, ${read === "gone" ? 3 : 1})
      on conflict (tenant_id, integration_id, external_id) do update set
        fetched_at = excluded.fetched_at,
        profile_misses = greatest(external_people.profile_misses + 1, excluded.profile_misses),
        updated_at = now()`);
  }

  // ---------------------------------------------------------------- packages

  /**
   * Guests whose packages were not read this week and who had a visit in the
   * last 180 days: one stored from this connection, or any visit with their
   * number, so a guest whose Zenoti visit folded into an uploaded one still
   * has their packages read. Never read first, then the latest visitors.
   */
  private packagesDue(limit: number | null): SQL {
    const since = addDays(dayIn(this.now, this.timeZone), -LOOKBACK_DAYS);
    const weekAgo = new Date(this.now.getTime() - PACKAGE_REFRESH_DAYS * DAY_MS).toISOString();
    return sql`
      with recent as (
        select v.guest_ref as ref, max(v.visit_date) as last
        from visits v
        where v.integration_id = ${this.i.id} and v.guest_ref is not null and v.visit_date >= ${since}::date
        group by v.guest_ref
        union all
        select g.external_id, max(v.visit_date)
        from external_people g join visits v on v.tenant_id = g.tenant_id and v.phone_e164 = g.phone_e164
        where g.integration_id = ${this.i.id} and v.visit_date >= ${since}::date
        group by g.external_id
      )
      select r.ref as ref
      from recent r
      left join external_people p on p.integration_id = ${this.i.id} and p.external_id = r.ref
      where p.packages_fetched_at is null or p.packages_fetched_at < ${weekAgo}::timestamptz
      group by r.ref, p.packages_fetched_at
      order by p.packages_fetched_at asc nulls first, max(r.last) desc
      ${limit === null ? sql`` : sql`limit ${limit}`}`;
  }

  private async readPackages(cap: number): Promise<void> {
    if (this.access?.capabilities.guestPackages !== true || cap <= 0) return;
    const stopAt = this.budget.used + cap;
    const due = await withTenant(this.tenantId, (tx) => tx.execute<{ ref: string }>(this.packagesDue(cap)));
    for (const { ref } of due) {
      if (this.budget.used >= stopAt || this.access?.capabilities.guestPackages !== true) return;
      let list: Record<string, unknown>[] | null;
      try {
        list = await this.client!.guestPackages(ref);
      } catch (e) {
        if (e instanceof ZenotiPermissionError) return this.denied("guestPackages", e);
        if (stopsGuests(e)) throw e;
        this.guestProblem("the packages of", e);
        list = null;
      }
      if (list === null) {
        // Zenoti has no such guest, or would not say: their balances stay as last read, and they wait a week like anyone.
        await withTenant(this.tenantId, (tx) => this.packagesRead(tx, ref));
      } else {
        const rows = zenotiPackageBalances(ref, list);
        await withTenant(this.tenantId, (tx) => this.storePackages(tx, ref, rows));
        this.r.packages.rows += rows.length;
      }
      this.r.packages.guests++;
    }
  }

  private async packagesRead(tx: Tx, guestRef: string): Promise<void> {
    await tx.execute(sql`
      insert into external_people (tenant_id, integration_id, external_id, packages_fetched_at)
      values (${this.tenantId}, ${this.i.id}, ${guestRef}, ${this.now.toISOString()}::timestamptz)
      on conflict (tenant_id, integration_id, external_id) do update set packages_fetched_at = excluded.packages_fetched_at`);
  }

  /**
   * One guest's packages as Zenoti has them now: balances stored, ones gone
   * from Zenoti removed, the week noted on the guest, and the counts of the
   * package a session was last taken from set on their latest visit for each
   * service (or category) in it, which is the visit the plan reads for the
   * course's next sitting. A package not yet started speaks for no visit already had,
   * and a line for a tag matches none: JENAI does not know services' tags.
   */
  private async storePackages(tx: Tx, guestRef: string, rows: ZenotiPackageRow[]): Promise<void> {
    const phone = (await knownPhones(tx, this.i.id, [guestRef])).get(guestRef) ?? null;
    const json = rows.map((p) => ({
      package_ref: p.packageRef ?? null,
      package_name: p.packageName,
      service: p.service,
      covers: p.covers ?? "service",
      total: p.total ?? null,
      used: p.used ?? null,
      balance: p.balance ?? null,
      status: p.status,
      expires_on: p.expiresOn ?? null,
    }));
    if (json.length) {
      await tx.execute(sql`
        insert into package_balances (tenant_id, integration_id, guest_ref, phone_e164, package_ref, package_name, service, covers, total, used, balance, status, expires_on, fetched_at)
        select ${this.tenantId}, ${this.i.id}, ${guestRef}, ${phone}, p.package_ref, p.package_name, p.service, p.covers, p.total, p.used, p.balance, p.status, p.expires_on, ${this.now.toISOString()}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(json)}::jsonb) as p(package_ref text, package_name text, service text, covers text, total int, used int, balance int, status text, expires_on date)
        on conflict (tenant_id, integration_id, guest_ref, package_name, service) do update set
          phone_e164 = excluded.phone_e164,
          package_ref = excluded.package_ref,
          covers = excluded.covers,
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
    await this.packagesRead(tx, guestRef);

    // A package being worked through before one used up, then the one ending later.
    const left = (p: ZenotiPackageRow) => Number((sessionsLeft(p) ?? 0) > 0);
    const taken = rows
      .filter((p) => p.status === "active" && (p.used ?? 0) > 0 && p.covers !== "tag")
      .sort((a, b) => left(b) - left(a) || (b.expiresOn ?? "").localeCompare(a.expiresOn ?? ""));
    const counted = new Set<string>();
    for (const p of taken) {
      const total = p.total ?? packageSessions(p.packageName);
      const key = `${p.covers}:${p.service.toLowerCase()}`;
      if (!total || total < 1 || counted.has(key)) continue;
      counted.add(key);
      const match = p.covers === "category" ? sql`exists (select 1 from unnest(v.categories) c where lower(c) = lower(${p.service}))` : sql`lower(v.service) = lower(${p.service})`;
      // Their visits from this connection, or any visit with their number (one that folded into an uploaded visit).
      const theirs = phone ? sql`((v.integration_id = ${this.i.id} and v.guest_ref = ${guestRef}) or v.phone_e164 = ${phone})` : sql`(v.integration_id = ${this.i.id} and v.guest_ref = ${guestRef})`;
      const set = await tx.execute(sql`
        update visits set sessions_total = ${total}::int, sessions_done = ${p.used}::int, updated_at = now()
        where id = (select v.id from visits v where ${theirs} and ${match} order by v.visit_date desc, v.created_at desc limit 1)
          and (sessions_total, sessions_done) is distinct from (${total}::int, ${p.used}::int)
        returning id`);
      this.r.packages.sessions += set.length;
    }
  }

  // ---------------------------------------------------------------- what is left

  /** What waits for the next run, once the run is over. */
  async account(): Promise<void> {
    if (this.i.status === "paused" || this.held) return;
    for (const s of this.states) {
      s.out.daysLeft = this.path ? this.spans(s, true).reduce((n, w) => n + daysBetween(w.from, w.to) + 1, 0) : 0;
      if (s.out.daysLeft) this.left.push(`${count(s.out.daysLeft, "day")} at ${s.c.name ?? s.c.code ?? "a centre"}`);
    }
    const caps = this.access?.capabilities;
    if (caps?.guestDetails === true) {
      const [n] = await withTenant(this.tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from external_people p where ${this.profilesDue()}`));
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

/** What stops the whole run rather than one centre: out of calls or time, a key Zenoti no longer takes, Zenoti asking to slow down. */
function stopsRun(e: unknown): boolean {
  return e instanceof ZenotiBudgetSpent || e instanceof ZenotiKeyError || e instanceof ZenotiBusyError;
}

/**
 * What stops reading guests rather than skipping one: as for a centre, and a
 * Zenoti that did not answer (it will not for the next guest either), and
 * anything that is not Zenoti's answer at all.
 */
function stopsGuests(e: unknown): boolean {
  return stopsRun(e) || !(e instanceof ZenotiError) || e.retryLater;
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
  /** Left out, what is stored stays. */
  centreRef?: string | null;
  listedOn?: string | null;
  categories?: string[] | null;
  /** When this read listed it. */
  seenAt?: string;
}

/**
 * Stores lines read from Zenoti as visits, one per line (their externalId).
 * A line with no number of its own takes the one known for the guest, unless
 * `exactPhone` says the number given is the one to keep, none included. One
 * visit per person, service and day still holds however it arrived, so a
 * line that would be a second (an uploaded visit, another invoice line, the
 * same service under another path) folds into the visit JENAI has: a new one
 * is not added, and one stored earlier is removed, its twin standing for
 * it. An uploaded twin becomes the line's own, Zenoti's to keep current, so
 * removing the upload leaves it: Zenoti reads that day once, and would not
 * put it back. A visit already stored keeps its id, so its planned calls
 * keep theirs.
 */
async function storeVisits(
  tx: Tx,
  tenantId: string,
  integrationId: string,
  incoming: VisitWrite[],
  opts: { exactPhone?: boolean } = {},
): Promise<{ added: number; updated: number; merged: number }> {
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
  const known = opts.exactPhone
    ? new Map<string, string>()
    : await knownPhones(
        tx,
        integrationId,
        list.map((v) => v.guestRef),
      );
  const rows = list.map((v) => {
    const had = stored.get(v.externalId);
    return { ...v, id: had?.id ?? null, phoneE164: opts.exactPhone ? v.phoneE164 : (v.phoneE164 ?? known.get(v.guestRef) ?? had?.phone ?? null) };
  });
  const keyOf = (phone: string | null, service: string, day: string) => (phone ? `${phone}|${day}|${service.toLowerCase()}` : null);

  // The same person, service and day held by a visit outside these lines: an uploaded one by its id, any other as null.
  const held = new Map<string, string | null>();
  const phones = [...new Set(rows.flatMap((r) => (r.phoneE164 ? [r.phoneE164] : [])))];
  for (const part of chunks(phones)) {
    const others = await tx.execute<{ id: string; phone_e164: string; service: string; visit_date: string; uploaded: boolean }>(sql`
      select id, phone_e164, service, visit_date::text as visit_date, integration_id is null as uploaded from visits
      where phone_e164 in ${texts(part)}
        and not coalesce(integration_id = ${integrationId} and external_id in ${texts(ids)}, false)`);
    for (const o of others) held.set(keyOf(o.phone_e164, o.service, o.visit_date)!, o.uploaded ? o.id : null);
  }

  const keep: typeof rows = [];
  const adopt: Array<(typeof rows)[number] & { twin: string }> = [];
  const drop: string[] = [];
  const taken = new Set<string>();
  // Lines already stored first, so the visit already planned is the one kept.
  for (const r of [...rows].sort((a, b) => Number(a.id === null) - Number(b.id === null) || (a.externalId < b.externalId ? -1 : 1))) {
    const k = keyOf(r.phoneE164, r.service, r.visitDate);
    const twin = k ? held.get(k) : undefined;
    if (k && (taken.has(k) || twin !== undefined)) {
      if (r.id) drop.push(r.id);
      // The first line onto an uploaded twin takes it over; any other folds into the visit held.
      if (twin && !taken.has(k)) adopt.push({ ...r, twin });
      else out.merged++;
      taken.add(k);
      continue;
    }
    if (k) taken.add(k);
    keep.push(r);
  }
  // First, so a twin can take over a dropped line's Zenoti id, which only one visit may carry.
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
    centre_ref: r.centreRef ?? null,
    listed_on: r.listedOn ?? null,
    categories: r.categories?.length ? r.categories : null,
    seen_at: r.seenAt ?? null,
  });
  // An uploaded twin becomes the line's: out of the upload's batch, Zenoti's word over the file's, as a later read of that day would give it.
  // It keeps its id, number, contact, sessions done and source, the way it first arrived.
  for (const part of chunks(adopt)) {
    const res = await tx.execute(sql`
      update visits t set
        integration_id = ${integrationId},
        external_id = v.external_id,
        guest_ref = v.guest_ref,
        name = coalesce(v.name, t.name),
        service = v.service,
        doctor = coalesce(v.doctor, t.doctor),
        branch = coalesce(v.branch, t.branch),
        branch_id = coalesce(v.branch_id, t.branch_id),
        sessions_total = coalesce(v.sessions_total, t.sessions_total),
        centre_ref = coalesce(v.centre_ref, t.centre_ref),
        listed_on = coalesce(v.listed_on, t.listed_on),
        categories = coalesce(v.categories, t.categories),
        seen_at = coalesce(v.seen_at, t.seen_at),
        batch = null,
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(part.map((r) => ({ ...record(r), id: r.twin })))}::jsonb)
        as v(id uuid, external_id text, guest_ref text, name text, service text, doctor text, branch text, branch_id uuid, sessions_total int,
             centre_ref text, listed_on date, categories text[], seen_at timestamptz)
      where t.id = v.id and t.integration_id is null
      returning t.id`);
    out.updated += res.length;
    // One another connection took over meanwhile stands for it.
    out.merged += part.length - res.length;
  }
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
        centre_ref = coalesce(v.centre_ref, t.centre_ref),
        listed_on = coalesce(v.listed_on, t.listed_on),
        categories = coalesce(v.categories, t.categories),
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(part.map(record))}::jsonb)
        as v(id uuid, phone_e164 text, guest_ref text, name text, service text, visit_date date, doctor text, branch text, branch_id uuid, sessions_total int,
             centre_ref text, listed_on date, categories text[])
      where t.id = v.id and t.integration_id = ${integrationId}
        and (t.phone_e164, t.guest_ref, t.name, t.service, t.visit_date, t.doctor, t.branch, t.branch_id, t.sessions_total, t.centre_ref, t.listed_on, t.categories)
          is distinct from (v.phone_e164, v.guest_ref, coalesce(v.name, t.name), v.service, v.visit_date, coalesce(v.doctor, t.doctor),
                            coalesce(v.branch, t.branch), coalesce(v.branch_id, t.branch_id), coalesce(v.sessions_total, t.sessions_total),
                            coalesce(v.centre_ref, t.centre_ref), coalesce(v.listed_on, t.listed_on), coalesce(v.categories, t.categories))
      returning t.id`);
    out.updated += res.length;
    // Listed again, whether or not anything in it changed: the mark a later re-read goes by.
    const seen = part.filter((r) => r.seenAt);
    if (seen.length)
      await tx.execute(sql`
        update visits t set seen_at = v.seen_at
        from jsonb_to_recordset(${JSON.stringify(seen.map((r) => ({ id: r.id, seen_at: r.seenAt })))}::jsonb) as v(id uuid, seen_at timestamptz)
        where t.id = v.id and t.seen_at is distinct from v.seen_at`);
  }
  for (const part of chunks(keep.filter((r) => !r.id))) {
    const res = await tx.execute(sql`
      insert into visits (tenant_id, integration_id, external_id, guest_ref, phone_e164, name, service, visit_date, doctor, branch, branch_id, sessions_total, centre_ref, listed_on, categories, seen_at, source)
      select ${tenantId}, ${integrationId}, v.external_id, v.guest_ref, v.phone_e164, v.name, v.service, v.visit_date, v.doctor, v.branch, v.branch_id, v.sessions_total,
             v.centre_ref, v.listed_on, v.categories, v.seen_at, 'api'
      from jsonb_to_recordset(${JSON.stringify(part.map(record))}::jsonb)
        as v(external_id text, guest_ref text, phone_e164 text, name text, service text, visit_date date, doctor text, branch text, branch_id uuid, sessions_total int,
             centre_ref text, listed_on date, categories text[], seen_at timestamptz)
      on conflict do nothing
      returning id`);
    out.added += res.length;
    // Stored meanwhile by an upload: that visit stands for it.
    out.merged += part.length - res.length;
  }
  return out;
}

/**
 * Everyone seen on a booking or a sales line, with what it says: a number
 * given replaces the one held, none given keeps it. Their profile, read
 * later, has the last word. The number each now has comes back.
 */
async function seePeople(
  tx: Tx,
  tenantId: string,
  integrationId: string,
  people: Array<{ externalId: string; phoneE164: string | null; name: string | null }>,
): Promise<Map<string, string | null>> {
  const by = new Map<string, { external_id: string; phone_e164: string | null; name: string | null }>();
  for (const p of people) {
    const had = by.get(p.externalId);
    by.set(p.externalId, { external_id: p.externalId, phone_e164: p.phoneE164 ?? had?.phone_e164 ?? null, name: p.name ?? had?.name ?? null });
  }
  const now = new Map<string, string | null>();
  for (const part of chunks([...by.values()])) {
    const rows = await tx.execute<{ external_id: string; phone_e164: string | null }>(sql`
      insert into external_people (tenant_id, integration_id, external_id, phone_e164, name)
      select ${tenantId}, ${integrationId}, p.external_id, p.phone_e164, p.name
      from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as p(external_id text, phone_e164 text, name text)
      on conflict (tenant_id, integration_id, external_id) do update set
        phone_e164 = coalesce(excluded.phone_e164, external_people.phone_e164),
        name = coalesce(excluded.name, external_people.name),
        updated_at = now()
      returning external_id, phone_e164`);
    for (const r of rows) now.set(r.external_id, r.phone_e164);
  }
  return now;
}

/** The guests already held, with the number each has, none included. */
async function storedPhones(tx: Tx, integrationId: string, refs: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const part of chunks([...new Set(refs)])) {
    const rows = await tx
      .select({ ref: externalPeople.externalId, phone: externalPeople.phoneE164 })
      .from(externalPeople)
      .where(and(eq(externalPeople.integrationId, integrationId), inArray(externalPeople.externalId, part)));
    for (const r of rows) out.set(r.ref, r.phone);
  }
  return out;
}

async function knownPhones(tx: Tx, integrationId: string, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [ref, phone] of await storedPhones(tx, integrationId, refs)) if (phone) out.set(ref, phone);
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
    return id ? [{ id, name: str(c.name), code: str(c.code), phoneCode: str(c.phoneCode), timeZone: str(c.timeZone) }] : [];
  });
}

/** A centre's own country calling code, or its time zone's. */
const centreCode = (c: ZenotiCentre): string | null => c.phoneCode ?? phoneCodeForZone(c.timeZone);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Marks kept per centre in pull_cursor, besides the days stored (zenoti, zenotiFrom). */
type CentreMark = "zenotiRecentAt" | "zenotiFarAt" | "zenotiServed" | "zenotiPage" | "zenotiErrors";

function centreMark(i: Integration, key: CentreMark | "zenoti" | "zenotiFrom", centreId: string): unknown {
  return obj(obj(i.pullCursor)[key])[centreId];
}

/** pull_cursor.zenoti holds each centre's last day stored, pull_cursor.zenotiFrom its first. */
function dayMark(i: Integration, key: "zenoti" | "zenotiFrom", centreId: string): string | null {
  const c = centreMark(i, key, centreId);
  return typeof c === "string" && DAY.test(c) ? c : null;
}

function instantOf(v: unknown): number | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function pagePlaceOf(v: unknown): PagePlace | null {
  const p = obj(v);
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null);
  const [page, size, seen] = [n(p.page), n(p.size), n(p.seen)];
  if (typeof p.from !== "string" || typeof p.to !== "string" || typeof p.since !== "string" || !page || !size || seen === null) return null;
  return { from: p.from, to: p.to, page, size, seen, since: p.since };
}

function centreErrorOf(v: unknown): CentreError | null {
  const e = obj(v);
  if (typeof e.message !== "string" || typeof e.retryAt !== "string" || instantOf(e.retryAt) === null) return null;
  const path = e.path === "appointments" || e.path === "sales_accrual" || e.path === "sales_report" ? e.path : undefined;
  return { message: e.message, at: typeof e.at === "string" ? e.at : e.retryAt, tries: typeof e.tries === "number" && e.tries > 0 ? e.tries : 1, retryAt: e.retryAt, ...(path ? { path } : {}) };
}

/** How many days back a connection reads, as its config says, within the limits. */
export function zenotiBackfillDays(config: Record<string, unknown>): number {
  const n = Math.floor(Number(config.backfillDays ?? ZENOTI_DEFAULT_BACKFILL_DAYS));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, ZENOTI_MAX_BACKFILL_DAYS) : ZENOTI_DEFAULT_BACKFILL_DAYS;
}

function pageSizeOf(config: Record<string, unknown>): number {
  const n = Math.floor(Number(config.reportPageSize ?? DEFAULT_PAGE_SIZE));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

// ---------------------------------------------------------------- days

const pad = (n: number) => String(n).padStart(2, "0");
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const spanKey = (w: Span) => `${w.kind}:${w.from}:${w.to}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayIn(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function startOfDay(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return zoned(y!, m!, d!, 0, tz);
}

/** "4 Oct 2026 at 14:05", in the client's time. */
function whenText(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y} at ${pad(Math.floor(p.minutes / 60))}:${pad(p.minutes % 60)}`;
}

/** `from` to `to`, both included, in spans of at most `len` days, newest first. Empty when `to` is before `from`. */
function splitBack(from: string, to: string, len: number): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let end = to; end >= from; end = addDays(end, -len)) {
    const start = addDays(end, -(len - 1));
    out.push({ from: start > from ? start : from, to: end });
  }
  return out;
}

/** `from` to `to`, both included, in spans of at most `len` days. Empty when `to` is before `from`. */
function split(from: string, to: string, len: number): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let d = from; d <= to; d = addDays(d, len)) {
    const end = addDays(d, len - 1);
    out.push({ from: d, to: end < to ? end : to });
  }
  return out;
}

// ---------------------------------------------------------------- small things

/**
 * An unexpected error in words safe to store in last_pull_error and to show.
 * A database error must not be shown as it is: Drizzle puts the statement's
 * values in its message, and here those are guests' names and numbers. So
 * only Postgres's error code and the constraint it names are kept.
 */
export function errorWithoutValues(e: unknown): string {
  const o = obj(e);
  const pg = "query" in o && "params" in o ? obj(o.cause) : o;
  if (typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) && ("severity" in pg || pg !== o)) {
    const constraint = typeof pg.constraint_name === "string" ? `, ${pg.constraint_name}` : "";
    return `JENAI's database refused to store what was read (Postgres error ${pg.code}${constraint}).`;
  }
  if ("query" in o && "params" in o) return "JENAI's database refused to store what was read.";
  return e instanceof Error ? e.message : String(e);
}

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
  return zenotiChanges(r) > 0;
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
  if (r.guests.read) said.push(`Read ${count(r.guests.read, "guest profile")}.`);
  if (v.numbered) said.push(`${count(v.numbered, "visit")} given ${v.numbered === 1 ? "its" : "their"} guest's phone number.`);
  if (r.packages.guests) said.push(`Read the packages of ${count(r.packages.guests, "guest")}.`);
  const waiting = r.waitingForPhone;
  if (waiting) said.push(`${count(waiting, "service")} done ${waiting === 1 ? "waits" : "wait"} for a phone number.`);
  said.push(r.left.length ? `Left for next time: ${r.left.join(", ")}.` : "Up to date.");
  said.push(`${r.calls} of ${r.budget} calls to Zenoti used.`);
  return said.join(" ");
}
