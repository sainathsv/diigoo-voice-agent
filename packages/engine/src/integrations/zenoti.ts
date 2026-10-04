import type { ClinicAppointmentStatus, PackageCovers, PackageStatus, clinicAppointments, externalPeople, packageBalances } from "@jenai/db";
import { toE164 } from "@jenai/voice";
import { localParts, zoned } from "../dialer/time";
import type { Connector, ConnectorContext, SendResult } from "./types";

/**
 * Zenoti, the front desk and billing system many clinics, salons and spas
 * run. JENAI only reads it, never writes to it, so the call plan knows who
 * took which service, who is booked, who missed a booking and how many
 * package sessions are left.
 *
 * What a key may read is set in Zenoti, per backend app, in its API key
 * groups (docs.zenoti.com/docs/zenoti-api-groups-1): a request outside them
 * is refused with 401 "Authorization has been denied for this request." even
 * though the key itself is good. Clinics grant different things, so test()
 * finds out what this key may read, picks the best way to see services done,
 * and says in plain words what their Zenoti admin can add for more:
 *   appointments    bookings, no-shows and completed visits, with the mobile
 *   sales accrual   services sold, no phone (the guest's profile has it)
 *   sales report    the same from the older report Zenoti has deprecated
 *
 * Zenoti allows an organisation 60 calls a minute, shared with every other
 * app the clinic runs on it (docs.zenoti.com/docs/api-rate-limits-1), so one
 * connection makes at most 40 a minute unless set otherwise, slows down when
 * Zenoti says few calls are left, and waits as long as a 429 asks.
 *
 * Credentials (sealed): {api_key, app_id?, app_secret?}. Only the API key is
 * used; the app id and secret are kept for Zenoti's token sign-in, should a
 * client's setup need it later. Config: baseUrl (default
 * https://api.zenoti.com), rateLimitPerMinute (default 40), defaultCountryCode
 * (for a mobile saved without its country; the centre's own country code is
 * used when this is not set, and no number at all rather than a guess).
 */

export const ZENOTI_API = "https://api.zenoti.com";
/** Calls a minute one connection makes at most, leaving room for the clinic's other apps. */
export const ZENOTI_DEFAULT_PER_MINUTE = 40;
/** Zenoti's own limit for the whole organisation: going faster never helps. */
const ZENOTI_ORG_LIMIT = 60;
const WINDOW_MS = 60_000;
const TIMEOUT_MS = 30_000;
/** One request and up to three retries, for a 429 or a server error. */
const MAX_TRIES = 4;
/** The longest a 429 is waited out. Asked to wait longer, the read stops and tries another time. */
const MAX_WAIT_MS = 65_000;
/** When Zenoti says this few calls are left in the organisation's window, the next one waits for the refill. */
const LOW_REMAINING = 5;
const CENTRES = "/v1/centers";
/** Centres asked for a page: list-all-centers pages its answer (its own example has 10 of 386 on a page). */
const CENTRES_PAGE = 100;
/** A chain bigger than this many pages of centres is not one any client has; the list stops there rather than looping. */
const MAX_CENTRE_PAGES = 50;
/** A guest id nobody has, for checking what the key may read without reading anyone. */
const NO_GUEST = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------- errors

/** Something Zenoti did not give us, in words a clinic can read. Never carries the key or a guest's details. */
export class ZenotiError extends Error {
  override name = "ZenotiError";
  constructor(
    message: string,
    /** Zenoti's HTTP status, 0 when it never answered. */
    readonly status: number,
    /** What was being read, in plain words ("appointments"). */
    readonly what: string,
    /** Nothing will work until someone fixes the connection (a new key, the right address). */
    readonly connectionBroken = false,
    /** Worth trying again later as it is. */
    readonly retryLater = false,
  ) {
    super(message);
  }
}

/** The key works, but Zenoti does not let it read this one thing. Their admin can add it; the rest goes on. */
export class ZenotiPermissionError extends ZenotiError {
  override name = "ZenotiPermissionError";
}

/** The key itself is missing, wrong or revoked: Zenoti refuses the list of centres and a look for a guest alike. */
export class ZenotiKeyError extends ZenotiError {
  override name = "ZenotiKeyError";
  constructor(message: string, status: number, what: string) {
    super(message, status, what, true, false);
  }
}

/** Zenoti's rate limit, still hit after waiting as long as it asked. */
export class ZenotiBusyError extends ZenotiError {
  override name = "ZenotiBusyError";
  constructor(
    message: string,
    status: number,
    what: string,
    /** When Zenoti asked to be left alone until, if longer than JENAI waits within a run (ms on the client's clock). */
    readonly notBefore: number | null = null,
  ) {
    super(message, status, what, false, true);
  }
}

/** Zenoti did not answer, or answered with a server error, through every retry. */
export class ZenotiUnavailableError extends ZenotiError {
  override name = "ZenotiUnavailableError";
  constructor(message: string, status: number, what: string) {
    super(message, status, what, false, true);
  }
}

/** This run has made every call it was given. Nothing is wrong: the rest is read next time. */
export class ZenotiBudgetSpent extends ZenotiError {
  override name = "ZenotiBudgetSpent";
  constructor(what: string, message = `JENAI made every call to Zenoti this run was given before reading ${what}; the rest is read next time.`) {
    super(message, 0, what, false, true);
  }
}

/**
 * This run has used the time it was given: waiting on a busy Zenoti made it
 * slow. It stops, as when out of calls, before its hold on the connection
 * runs out, so no second run can read the same connection at the same time.
 */
export class ZenotiTimeSpent extends ZenotiBudgetSpent {
  override name = "ZenotiTimeSpent";
  constructor(what: string) {
    super(what, `JENAI stopped reading Zenoti before ${what} because this run was out of time, Zenoti being slow to let it in; the rest is read next time.`);
  }
}

/**
 * Calls one run may still make, retries and checks included. The clinic's
 * other apps share Zenoti's minute, so a run never spends more than it was given.
 */
export interface ZenotiCallBudget {
  left: number;
  used: number;
  /** No call is started at or after this time on the client's clock (ms). */
  until?: number;
}

// ---------------------------------------------------------------- pacing

export interface ZenotiClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realClock: ZenotiClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

interface Gate {
  /** When each call in the last minute started. */
  starts: number[];
  /** No call before this, because Zenoti asked us to wait. */
  notBefore: number;
}

/**
 * Pacing per connection, shared by everything in this process that reads it.
 * One worker reads a connection at a time (crm-sync's lease), and the
 * ratelimit headers cover the calls made from anywhere else.
 */
const gates = new Map<string, Gate>();

function gateOf(key: string): Gate {
  let g = gates.get(key);
  if (!g) gates.set(key, (g = { starts: [], notBefore: 0 }));
  return g;
}

/** Waits for a free slot in this connection's minute, then takes it. */
async function take(key: string, perMinute: number, clock: ZenotiClock): Promise<void> {
  const g = gateOf(key);
  for (;;) {
    const t = clock.now();
    while (g.starts.length && g.starts[0]! <= t - WINDOW_MS) g.starts.shift();
    const full = g.starts.length >= perMinute ? g.starts[0]! + WINDOW_MS - t : 0;
    const wait = Math.max(g.notBefore - t, full);
    // Checked and taken with no await between, so two callers never take one slot.
    if (wait <= 0) {
      g.starts.push(t);
      return;
    }
    await clock.sleep(wait);
  }
}

function hold(key: string, ms: number, clock: ZenotiClock): void {
  const g = gateOf(key);
  g.notBefore = Math.max(g.notBefore, clock.now() + ms);
}

function headerNumber(h: Headers, name: string): number | null {
  const raw = h.get(name)?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Slows down when Zenoti says the organisation's minute is nearly spent:
 * the other apps on it share the same 60 calls. RateLimit-Reset is the
 * seconds until the next refill (docs.zenoti.com/docs/api-rate-limits-1).
 */
function heed(key: string, h: Headers, clock: ZenotiClock): void {
  const remaining = headerNumber(h, "ratelimit-remaining");
  if (remaining === null || remaining > LOW_REMAINING) return;
  const reset = headerNumber(h, "ratelimit-reset") ?? LOW_REMAINING - remaining + 1;
  hold(key, Math.min(WINDOW_MS, Math.max(1000, reset * 1000)), clock);
}

/** How long a 429 asks us to wait: Retry-After (seconds or a date), else RateLimit-Reset, else a widening gap. */
function waitAfter429(h: Headers, attempt: number, now: number): number {
  const raw = h.get("retry-after")?.trim();
  if (raw) {
    const s = Number(raw);
    if (Number.isFinite(s)) return Math.max(1000, s * 1000);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(1000, at - now);
  }
  const reset = headerNumber(h, "ratelimit-reset");
  return reset !== null ? Math.max(1000, reset * 1000) : backoff(attempt);
}

/** 1, 2, 4 seconds. */
const backoff = (attempt: number) => 1000 * 2 ** attempt;

function perMinuteOf(config: Record<string, unknown>): number {
  const n = Math.floor(Number(config.rateLimitPerMinute ?? ZENOTI_DEFAULT_PER_MINUTE));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, ZENOTI_ORG_LIMIT) : ZENOTI_DEFAULT_PER_MINUTE;
}

/**
 * The API address. The key goes in every request, so only Zenoti's own
 * hosts, over https, ever receive it, whatever the config says.
 */
export function zenotiBase(config: Record<string, unknown>): string {
  const raw = String(config.baseUrl ?? ZENOTI_API);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ZenotiError("The Zenoti address saved on this connection is not a web address.", 0, "the address", true);
  }
  const zenoti = u.hostname === "zenoti.com" || u.hostname.endsWith(".zenoti.com");
  if (u.protocol !== "https:" || !zenoti || u.username || u.password || u.port) {
    throw new ZenotiError("The Zenoti address saved on this connection is not one of Zenoti's own (https, ending in zenoti.com).", 0, "the address", true);
  }
  return u.origin;
}

// ---------------------------------------------------------------- the requests

interface Req {
  method: "GET" | "POST";
  path: string;
  /** In plain words, for messages. */
  what: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Zenoti refuses a longer span, so asking for one is our mistake, caught before it costs a call. */
function checkRange(from: string, to: string, least: number, most: number, what: string): void {
  if (!DAY.test(from) || !DAY.test(to)) throw new Error(`${what}: dates are YYYY-MM-DD`);
  const n = days(from, to);
  if (!(n >= least && n <= most)) throw new Error(`${what}: Zenoti takes from ${least} to ${most} days between the dates`);
}

/**
 * Each read, as Zenoti documents it. The probes in test() send the same
 * requests, so what the Test says can be read is what the sync reads.
 */
const REQ = {
  /** list-all-centers: paged by Page and Size, page_info {total, page, size} saying how many there are. */
  centres: (page = 1): Req => ({ method: "GET", path: CENTRES, what: "the list of centres", query: { Page: page, Size: CENTRES_PAGE } }),
  /**
   * retrieve-the-list-of-appointments-of-a-center: end_date is exclusive and
   * at most seven days after start_date. No-shows and cancellations only
   * when asked for.
   */
  appointments: (centreId: string, from: string, to: string): Req => ({
    method: "GET",
    path: "/v1/appointments",
    what: "appointments",
    query: { center_id: centreId, start_date: from, end_date: to, include_no_show_cancel: true },
  }),
  /** retrieve-guest-details */
  guest: (id: string): Req => ({ method: "GET", path: `/v1/guests/${encodeURIComponent(id)}`, what: "guest details" }),
  /** list-the-series-packages-of-a-guest (its path is written with a capital P). */
  guestPackages: (id: string, centreId?: string): Req => ({
    method: "GET",
    path: `/v1/guests/${encodeURIComponent(id)}/Packages`,
    what: "guests' packages",
    query: centreId ? { center_id: centreId } : undefined,
  }),
  /**
   * sales-accrual-report: a POST that only reads. Dates are centre time,
   * "YYYY-MM-DD HH:MM:SS", at most a year apart; -1 means every item type
   * and invoice status, as Zenoti's own example sends. Asking for services
   * only would save pages, but the reference does not say which number
   * ReportItemType gives them, so every type is read and only service lines kept.
   */
  salesAccrual: (centreIds: string[], from: string, to: string, page: number, size: number): Req => ({
    method: "POST",
    path: "/v1/reports/sales/accrual_basis/flat_file",
    what: "the sales accrual report",
    query: { Page: page, Size: size },
    body: { center_ids: centreIds, start_date: `${from} 00:00:00`, end_date: `${to} 23:59:59`, item_types: [-1], invoice_statuses: [-1] },
  }),
  /**
   * retrieve-the-sales-report-of-a-center (deprecated by Zenoti): end_date
   * inclusive, at most seven days, centre time. item_type 0 is services;
   * status 1 is closed invoices, the services that were done (its default,
   * 0, is open ones).
   */
  salesReport: (centreId: string, from: string, to: string): Req => ({
    method: "GET",
    path: "/v1/sales/salesreport",
    what: "the sales report",
    query: { center_id: centreId, start_date: from, end_date: to, item_type: 0, status: 1 },
  }),
  /** retrieve-the-list-of-all-countries: Zenoti's country ids and their phone codes. */
  countries: (): Req => ({ method: "GET", path: "/v1/countries", what: "the list of countries" }),
};

interface Answer {
  status: number;
  json: unknown;
  headers: Headers;
  /** A 429 that asked for a longer wait than JENAI makes within a run: no call before this (ms on the client's clock). */
  notBefore?: number;
}

export interface ZenotiCentre {
  id: string;
  name: string | null;
  code: string | null;
  /** The phone code of the centre's country ("91"), when Zenoti gives it. */
  phoneCode: string | null;
  /** The centre's own time zone ("Asia/Kolkata"), when Zenoti names one JENAI knows. */
  timeZone?: string | null;
}

/**
 * Zenoti names a centre's time zone the way Windows does
 * (location.time_zone.standard_name, "India Standard Time" in its own
 * list-all-centers example). These are the IANA zones those names stand for
 * (Unicode CLDR's windowsZones, the zone for the whole region). A name not
 * here gives no zone, and the branch's or the client's is used instead.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  "bangladesh standard time": "Asia/Dhaka",
  "pakistan standard time": "Asia/Karachi",
  "arabian standard time": "Asia/Dubai",
  "arab standard time": "Asia/Riyadh",
  "arabic standard time": "Asia/Baghdad",
  "se asia standard time": "Asia/Bangkok",
  "singapore standard time": "Asia/Singapore",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "south africa standard time": "Africa/Johannesburg",
  "e. africa standard time": "Africa/Nairobi",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax",
  "canada central standard time": "America/Regina",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "cen. australia standard time": "Australia/Adelaide",
  "w. australia standard time": "Australia/Perth",
  "new zealand standard time": "Pacific/Auckland",
};

/** A centre's time zone as Zenoti names it, as an IANA zone, or null. */
export function zenotiTimeZone(timeZone: unknown): string | null {
  const z = obj(timeZone);
  for (const v of [z.standard_name, z.symbol]) {
    const name = text(v, 80)?.toLowerCase();
    if (name && Object.hasOwn(WINDOWS_ZONES, name)) return WINDOWS_ZONES[name]!;
  }
  return null;
}

/**
 * The calling code of the one country a time zone is in, for a mobile saved
 * without its country when nothing nearer says: the centre's zone, then the
 * client's. Only zones that stand for a single calling code are here; any
 * other gives none, and such a mobile then gives no number rather than a guess.
 */
const ZONE_PHONE_CODES: Record<string, string> = {
  "Asia/Kolkata": "91",
  "Asia/Calcutta": "91",
  "Asia/Colombo": "94",
  "Asia/Kathmandu": "977",
  "Asia/Dhaka": "880",
  "Asia/Karachi": "92",
  "Asia/Dubai": "971",
  "Asia/Riyadh": "966",
  "Asia/Singapore": "65",
  "Asia/Tokyo": "81",
  "Europe/London": "44",
  "Africa/Johannesburg": "27",
  "Africa/Nairobi": "254",
  "America/New_York": "1",
  "America/Chicago": "1",
  "America/Denver": "1",
  "America/Phoenix": "1",
  "America/Los_Angeles": "1",
  "America/Anchorage": "1",
  "Pacific/Honolulu": "1",
  "Australia/Sydney": "61",
  "Australia/Melbourne": "61",
  "Australia/Brisbane": "61",
  "Australia/Adelaide": "61",
  "Australia/Perth": "61",
  "Pacific/Auckland": "64",
};

/** The calling code of a time zone's country, or null when the zone does not name one. */
export function phoneCodeForZone(timeZone: string | null | undefined): string | null {
  return timeZone && Object.hasOwn(ZONE_PHONE_CODES, timeZone) ? ZONE_PHONE_CODES[timeZone]! : null;
}

/** Country phone codes by Zenoti country id, read once a day for everyone: the list is Zenoti's, not a clinic's. */
let countryCodes: { at: number; codes: Record<string, string> } | null = null;

/**
 * A read-only client for one Zenoti connection: the key from its sealed
 * credentials, its own pace, retries for a 429 or a server error, and
 * errors that say whether the key is broken or only one thing is not allowed.
 */
export class ZenotiClient {
  readonly base: string;
  private readonly key: string;
  private readonly gate: string;
  private readonly perMinute: number;
  /** Whether Zenoti accepts the key at all, asked at most once per client. */
  private keyOk: Promise<boolean> | null = null;
  private readonly guests = new Map<string, Promise<Record<string, unknown> | null>>();

  constructor(
    private readonly ctx: ConnectorContext,
    private readonly clock: ZenotiClock = realClock,
    /** Shared with everything else one run reads. Left out, no limit beyond the pace. */
    private readonly budget?: ZenotiCallBudget,
  ) {
    this.base = zenotiBase(ctx.integration.config);
    const key = ctx.credentials.api_key?.trim();
    if (!key) throw new ZenotiKeyError("No Zenoti API key is saved on this connection.", 0, "the API key");
    this.key = key;
    this.gate = `${ctx.integration.tenantId}:${ctx.integration.id}`;
    this.perMinute = perMinuteOf(ctx.integration.config);
  }

  /**
   * One request, paced, with retries for a 429 (waiting as asked) and for a
   * server error or no answer (1, 2, 4 seconds). The last answer is handed
   * back whatever it is; status 0 means Zenoti never answered.
   */
  async send(req: Req): Promise<Answer> {
    const url = new URL(req.path, this.base);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `apikey ${this.key}`, Accept: "application/json" };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    let last: Answer = { status: 0, json: null, headers: new Headers() };
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      if (this.budget && this.budget.left <= 0) throw new ZenotiBudgetSpent(req.what);
      this.inTime(req);
      await take(this.gate, this.perMinute, this.clock);
      // Waiting for a slot can take a minute when Zenoti is busy: checked again, so no call starts late.
      this.inTime(req);
      if (this.budget) {
        this.budget.left--;
        this.budget.used++;
      }
      let res: Response;
      try {
        res = await this.ctx.fetch(url.toString(), {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        last = { status: 0, json: null, headers: new Headers() };
        if (attempt < MAX_TRIES - 1) await this.clock.sleep(backoff(attempt));
        continue;
      }
      last = { status: res.status, json: await res.text().then(parse, () => null), headers: res.headers };
      heed(this.gate, res.headers, this.clock);
      if (res.status === 429) {
        const wait = waitAfter429(res.headers, attempt, this.clock.now());
        if (wait > MAX_WAIT_MS) return { ...last, notBefore: this.clock.now() + wait };
        hold(this.gate, wait, this.clock);
        continue;
      }
      if (res.status >= 500) {
        if (attempt < MAX_TRIES - 1) await this.clock.sleep(backoff(attempt));
        continue;
      }
      return last;
    }
    return last;
  }

  private inTime(req: Req): void {
    if (this.budget?.until !== undefined && this.clock.now() >= this.budget.until) throw new ZenotiTimeSpent(req.what);
  }

  /** The answer's body when Zenoti gave it, else the error that says what went wrong. */
  private async read(req: Req): Promise<unknown> {
    const a = await this.send(req);
    if (a.status >= 200 && a.status < 300) return a.json;
    throw await this.failure(a, req);
  }

  private async failure(a: Answer, req: Req): Promise<ZenotiError> {
    // The accrual report says a refused permission this way: 400, {"code": 918, "message": "cannot access"}.
    if (cannotAccess(a)) return new ZenotiPermissionError(`Zenoti does not let this key read ${req.what}.`, a.status, req.what);
    if (a.status === 401 || a.status === 403) {
      // Zenoti refuses a request outside the key's API key groups the same
      // way it refuses a revoked key. Another read tells them apart.
      if (!(await this.keyWorks(req))) {
        return new ZenotiKeyError("Zenoti did not accept this API key. It may be mistyped, or no longer valid in Zenoti.", a.status, req.what);
      }
      return new ZenotiPermissionError(`Zenoti does not let this key read ${req.what}.`, a.status, req.what);
    }
    if (a.status === 429) return new ZenotiBusyError(`Zenoti asked JENAI to slow down while reading ${req.what}.`, a.status, req.what, a.notBefore ?? null);
    if (a.status === 0 || a.status >= 500) {
      return new ZenotiUnavailableError(`Zenoti did not answer a request for ${req.what}${a.status ? ` (HTTP ${a.status})` : ""}.`, a.status, req.what);
    }
    return new ZenotiError(`Zenoti refused a request for ${req.what} (HTTP ${a.status}).`, a.status, req.what);
  }

  /**
   * Whether Zenoti accepts the key at all: it opens the list of centres, or,
   * for a backend app given no access to centres, a guest nobody has is
   * looked for (not found means the key got in). Only when both are refused
   * is the key itself wrong.
   */
  private keyWorks(refused: Req): Promise<boolean> {
    this.keyOk ??= (async () => {
      for (const probe of [REQ.centres(), REQ.guest(NO_GUEST)]) {
        if (probe.path === refused.path) continue;
        const a = await this.send(probe);
        if (a.status !== 401 && a.status !== 403 && !cannotAccess(a)) return true;
      }
      return false;
    })();
    return this.keyOk;
  }

  /**
   * The centres this key sees, every page of them. A refusal here is the key
   * itself, unless the key opens something else: then it is only the
   * centres it may not read (ZenotiPermissionError).
   */
  async centres(): Promise<ZenotiCentre[]> {
    const by = new Map<string, ZenotiCentre>();
    for (let page = 1; page <= MAX_CENTRE_PAGES; page++) {
      const j = await this.read(REQ.centres(page));
      this.keyOk = Promise.resolve(true);
      const list = listOf(j, "centers");
      const before = by.size;
      for (const c of list) {
        const o = obj(c);
        const id = text(o.id, 64);
        const country = obj(o.country);
        const countryId = int(country.id);
        if (id)
          by.set(id, {
            id,
            name: text(o.name, 200),
            code: text(o.code, 40),
            phoneCode: phoneCodeOf(country.phone_code) ?? (countryId !== null ? (ZENOTI_PHONE_CODES[String(countryId)] ?? null) : null),
            timeZone: zenotiTimeZone(obj(o.location).time_zone),
          });
      }
      const total = int(obj(obj(j).page_info).total);
      // The last page: all there are, a short page, or one that brought nobody new (a Zenoti that does not page).
      if ((total !== null ? by.size >= total : list.length < CENTRES_PAGE) || by.size === before) break;
    }
    return [...by.values()];
  }

  /** One centre's bookings from `from` up to, not including, `to` (at most seven days), no-shows and cancellations too. */
  async appointments(centreId: string, from: string, to: string): Promise<Record<string, unknown>[]> {
    checkRange(from, to, 1, 7, "appointments");
    return listOf(await this.read(REQ.appointments(centreId, from, to)), "appointments").map(obj);
  }

  /**
   * One guest's profile, null when Zenoti cannot give it: no such guest, one
   * merged into another, or any other refusal about this guest alone (a 4xx
   * other than 401, 403 and 429; Zenoti documents no other answer). Asked
   * once per guest per client.
   */
  guest(id: string): Promise<Record<string, unknown> | null> {
    let g = this.guests.get(id);
    if (!g) {
      g = this.send(REQ.guest(id)).then(async (a) => {
        if (a.status >= 200 && a.status < 300) return obj(a.json);
        if (noSuchGuest(a)) return null;
        throw await this.failure(a, REQ.guest(id));
      });
      // A failure is not remembered, so the next ask tries again.
      g.catch(() => this.guests.delete(id));
      this.guests.set(id, g);
    }
    return g;
  }

  /** One guest's series packages, at one centre when given; null when Zenoti cannot give them for this guest (as for guest()). */
  async guestPackages(id: string, centreId?: string): Promise<Record<string, unknown>[] | null> {
    const req = REQ.guestPackages(id, centreId);
    const a = await this.send(req);
    if (a.status >= 200 && a.status < 300) return listOf(a.json, "packages", "guest_packages").map(obj);
    if (noSuchGuest(a)) return null;
    throw await this.failure(a, req);
  }

  /** One page of the sales accrual report, whole days in centre time, a year at most (the last day runs to 23:59:59). */
  async salesAccrual(input: { centreIds: string[]; from: string; to: string; page: number; size: number }): Promise<{ rows: Record<string, unknown>[]; total: number | null }> {
    checkRange(input.from, input.to, 0, 364, "the sales accrual report");
    const j = await this.read(REQ.salesAccrual(input.centreIds, input.from, input.to, input.page, input.size));
    return { rows: listOf(j, "sales").map(obj), total: int(obj(obj(j).page_info).total) };
  }

  /** Services on closed invoices at one centre, `from` to `to` inclusive (at most seven days), from Zenoti's deprecated report. */
  async salesReport(centreId: string, from: string, to: string): Promise<Record<string, unknown>[]> {
    checkRange(from, to, 0, 6, "the sales report");
    return listOf(await this.read(REQ.salesReport(centreId, from, to)), "center_sales_report").map(obj);
  }

  /**
   * Phone codes by Zenoti country id, for zenotiPhone(). A key that may not
   * read the list still has the built-in ones.
   */
  async phoneCodes(): Promise<Record<string, string>> {
    if (countryCodes && this.clock.now() - countryCodes.at < 86_400_000) return countryCodes.codes;
    const a = await this.send(REQ.countries());
    if (a.status < 200 || a.status >= 300) return ZENOTI_PHONE_CODES;
    const codes: Record<string, string> = { ...ZENOTI_PHONE_CODES };
    for (const c of listOf(a.json, "countries")) {
      const id = int(obj(c).id);
      const code = phoneCodeOf(obj(c).phone_code);
      if (id !== null && code) codes[String(id)] = code;
    }
    countryCodes = { at: this.clock.now(), codes };
    return codes;
  }
}

/** Zenoti's "you may not see this" in the body of a 400: {"code": 918, "message": "cannot access"} (sales-accrual-report). */
function cannotAccess(a: Answer): boolean {
  if (a.status !== 400 && a.status !== 403) return false;
  const j = obj(a.json);
  const err = obj(j.error);
  const code = int(j.code ?? err.code);
  const message = String(j.message ?? j.Message ?? err.message ?? "").toLowerCase();
  return code === 918 || message.includes("cannot access");
}

/** An answer about this guest alone: not found, merged away, or refused for a reason that is not the key's or Zenoti's load. */
function noSuchGuest(a: Answer): boolean {
  return a.status >= 400 && a.status < 500 && a.status !== 401 && a.status !== 403 && a.status !== 429 && !cannotAccess(a);
}

// ---------------------------------------------------------------- what a key may read

export interface ZenotiCapabilities {
  /** true: allowed. false: not allowed, or Zenoti refused the check. null: Zenoti did not answer the check. */
  appointments: boolean | null;
  guestDetails: boolean | null;
  guestPackages: boolean | null;
  salesAccrual: boolean | null;
  salesReport: boolean | null;
}

/** Where services done are read from, best first. */
export type ZenotiPath = "appointments" | "sales_accrual" | "sales_report";

export interface ZenotiTestResult {
  /** The key works and services done can be read one way or another. */
  ok: boolean;
  /** Everything below in one paragraph, for the connection's status line. */
  message: string;
  centres: ZenotiCentre[];
  capabilities: ZenotiCapabilities;
  path: ZenotiPath | null;
  /** What to ask their Zenoti admin for, or what else to do, one line each. */
  advice: string[];
}

/** Appointments carry the mobile; the accrual report is Zenoti's current one; the older report is the last resort. */
export function zenotiPath(c: ZenotiCapabilities): ZenotiPath | null {
  if (c.appointments) return "appointments";
  if (c.salesAccrual) return "sales_accrual";
  if (c.salesReport) return "sales_report";
  return null;
}

type Probe = { verdict: "allowed" | "denied" | "refused" | "unanswered"; status: number };

/**
 * What one check found. A guest nobody has is refused (404, 400) only after
 * the key's permission was checked, so for those that means allowed. A 400
 * saying "cannot access" (code 918) is the accrual report's own way of
 * refusing a permission (sales-accrual-report), so it is a denial.
 */
function probeVerdict(a: Answer, madeUpGuest: boolean): Probe {
  const s = a.status;
  if (s >= 200 && s < 300) return { verdict: "allowed", status: s };
  if (s === 401 || s === 403 || cannotAccess(a)) return { verdict: "denied", status: s };
  if (s === 0 || s === 429 || s >= 500) return { verdict: "unanswered", status: s };
  if (madeUpGuest && (s === 404 || s === 400)) return { verdict: "allowed", status: s };
  return { verdict: "refused", status: s };
}

const capability = (p: Probe): boolean | null => (p.verdict === "allowed" ? true : p.verdict === "unanswered" ? null : false);

/** Where their admin changes what the key may read, as Zenoti's own setup guide names it. */
const WHERE = "in the API key groups of the backend app that issued this key (in Zenoti: Configuration, then Apps under Integrations)";
const ask = (what: string) => `Ask your Zenoti admin to add read access to ${what} ${WHERE}.`;
/** What to ask their Zenoti admin for, for anything the key may not read. */
export const zenotiAsk = ask;
/**
 * Zenoti checks the security role of the user behind the backend app before
 * its API key groups (docs.zenoti.com/docs/zenoti-api-groups-1), and a report
 * refused with "cannot access" may be either.
 */
const askReport = (what: string) =>
  `Ask your Zenoti admin to add read access to ${what} ${WHERE}, and to make sure the security role of the Zenoti user that app runs as may see reports.`;

const listed = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

function centresLine(centres: ZenotiCentre[]): string {
  const names = centres.map((c) => [c.name, c.code].filter(Boolean).join(", ") || "unnamed");
  const shown = names.length > 5 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
  return `Connected to Zenoti: ${centres.length} centre${centres.length === 1 ? "" : "s"} (${listed(shown)}).`;
}

/**
 * Checks this connection: the key must open the list of centres, every page
 * of it, or, for a key Zenoti accepts but may not list them, the centre ids
 * named on the connection (config.onlyCentres) stand in. Then one small
 * request each finds whether it may read appointments (one day at the first
 * centre), guest details and guests' packages (a guest nobody has), the
 * sales accrual report (one day, one row) and the older sales report (one
 * day). Nothing is written to Zenoti and nobody's details are read. What was
 * found is kept on the connection (config.access, config.centres) for the sync.
 */
export async function testZenoti(ctx: ConnectorContext, clock: ZenotiClock = realClock, budget?: ZenotiCallBudget): Promise<ZenotiTestResult> {
  const none: ZenotiCapabilities = { appointments: null, guestDetails: null, guestPackages: null, salesAccrual: null, salesReport: null };
  const fail = (message: string, advice: string[] = []): ZenotiTestResult => ({ ok: false, message: [message, ...advice].join(" "), centres: [], capabilities: none, path: null, advice });

  const keyAdvice = "Ask your Zenoti admin for the API key of the backend app made for JENAI (in Zenoti: Configuration, then Apps under Integrations) and save it here again.";
  let client: ZenotiClient;
  try {
    client = new ZenotiClient(ctx, clock, budget);
  } catch (e) {
    if (e instanceof ZenotiKeyError) return fail(e.message, [keyAdvice]);
    if (e instanceof ZenotiError) return fail(e.message);
    throw e;
  }
  let centres: ZenotiCentre[];
  /** The key may not list the centres, so the ones named on the connection stand in. */
  let named = false;
  try {
    centres = await client.centres();
  } catch (e) {
    // Out of calls is the caller's to handle, not something wrong with the key.
    if (e instanceof ZenotiBudgetSpent) throw e;
    if (e instanceof ZenotiKeyError) return fail(e.message, [keyAdvice]);
    if (e instanceof ZenotiPermissionError) {
      centres = namedCentres(ctx.integration.config);
      named = true;
      if (!centres.length) {
        return fail("Zenoti accepted the key, but does not let it read the list of centres, so JENAI cannot tell which centres to read.", [ask("centres")]);
      }
    } else if (e instanceof ZenotiError) return fail(e.message, e.retryLater ? ["Test again in a few minutes."] : []);
    else return fail(`Zenoti could not be reached: ${(e as Error).message}`.slice(0, 200));
  }
  if (!centres.length) return fail("Zenoti accepted the key, but it sees no centres, so there is nothing to read.", ["Ask your Zenoti admin which centres this key's backend app can see."]);

  const centre = centres[0]!.id;
  const today = new Date(clock.now()).toISOString().slice(0, 10);
  const tomorrow = new Date(clock.now() + 86_400_000).toISOString().slice(0, 10);
  const probes = {
    appointments: probeVerdict(await client.send(REQ.appointments(centre, today, tomorrow)), false),
    guestDetails: probeVerdict(await client.send(REQ.guest(NO_GUEST)), true),
    guestPackages: probeVerdict(await client.send(REQ.guestPackages(NO_GUEST, centre)), true),
    salesAccrual: probeVerdict(await client.send(REQ.salesAccrual([centre], today, today, 1, 1)), false),
    salesReport: probeVerdict(await client.send(REQ.salesReport(centre, today, today)), false),
  };
  const capabilities: ZenotiCapabilities = {
    appointments: capability(probes.appointments),
    guestDetails: capability(probes.guestDetails),
    guestPackages: capability(probes.guestPackages),
    salesAccrual: capability(probes.salesAccrual),
    salesReport: capability(probes.salesReport),
  };
  const path = zenotiPath(capabilities);
  const fromReport = path === "sales_accrual" || path === "sales_report";

  const said: string[] = [
    named
      ? `Connected to Zenoti, which does not let this key read the list of centres: JENAI reads the ${centres.length === 1 ? "centre" : `${centres.length} centres`} named on this connection.`
      : centresLine(centres),
  ];
  if (path === "appointments") said.push("Services done, bookings and no-shows are read from appointments, with each patient's mobile.");
  else if (path) {
    const report = path === "sales_accrual" ? "the sales accrual report" : "Zenoti's older sales report";
    said.push(`Services done are read from ${report}, ${capabilities.guestDetails ? "with each guest's mobile from their Zenoti profile" : "which has no phone numbers"}.`);
  } else if ([capabilities.appointments, capabilities.salesAccrual, capabilities.salesReport].includes(null)) {
    said.push("JENAI could not yet tell where to read services done from.");
  } else said.push("JENAI cannot see which services were done: this key may not read appointments or either sales report.");
  if (capabilities.guestPackages) said.push("Sessions left on each guest's packages are read too.");

  const advice: string[] = [];
  const denied = (k: keyof typeof probes) => probes[k].verdict === "denied";
  if (named) advice.push(`Zenoti does not let this key read the list of centres. ${ask("centres")} JENAI then reads every centre the key sees, by name.`);
  if (denied("appointments")) {
    advice.push(`Zenoti does not let this key read appointments. ${ask("appointments")} JENAI then sees bookings, no-shows and completed visits with the patient's mobile.`);
  }
  if (path === "sales_report" && denied("salesAccrual")) {
    advice.push(`JENAI is reading Zenoti's older sales report, which Zenoti has deprecated. ${askReport("the sales accrual report")} JENAI then keeps working if Zenoti retires the older one.`);
  }
  if (denied("guestDetails")) {
    advice.push(
      fromReport
        ? `Zenoti does not let this key read guest details, so services read from the sales report have no phone number and wait, uncalled, until one is known. ${ask("guests")} JENAI then has each guest's mobile and whether they agreed to SMS.`
        : `Zenoti does not let this key read guest details, so JENAI cannot see whether each guest agreed to SMS. ${ask("guests")}`,
    );
  }
  if (denied("guestPackages")) {
    advice.push(`Zenoti does not let this key read guests' packages, so JENAI cannot see how many sessions are left on a package. ${ask("guest packages")}`);
  }
  const names: Record<keyof typeof probes, string> = {
    appointments: "appointments",
    guestDetails: "guest details",
    guestPackages: "guests' packages",
    salesAccrual: "the sales accrual report",
    salesReport: "the sales report",
  };
  const keys = Object.keys(probes) as Array<keyof typeof probes>;
  const unanswered = keys.filter((k) => probes[k].verdict === "unanswered");
  if (unanswered.length) advice.push(`Zenoti did not answer JENAI's check of ${listed(unanswered.map((k) => names[k]))} just now. Test again in a few minutes.`);
  for (const k of keys.filter((k) => probes[k].verdict === "refused")) {
    advice.push(`Zenoti refused JENAI's check of ${names[k]} (HTTP ${probes[k].status}). That is for JENAI support to look into, not your Zenoti admin.`);
  }

  await ctx.save({ config: { centres, access: { capabilities, path, checkedAt: new Date(clock.now()).toISOString() } } });
  return { ok: path !== null, message: [...said, ...advice].join(" "), centres, capabilities, path, advice };
}

/**
 * Centres named on the connection by their Zenoti id (config.onlyCentres),
 * for a key that may not read the list of centres. Names and codes a test
 * read earlier are kept with them.
 */
function namedCentres(config: Record<string, unknown>): ZenotiCentre[] {
  const only = Array.isArray(config.onlyCentres) ? config.onlyCentres.map((x) => String(x).trim()).filter((x) => ZENOTI_ID.test(x)) : [];
  const known = Array.isArray(config.centres) ? config.centres.map(obj) : [];
  return [...new Set(only.map((x) => x.toLowerCase()))].map((id) => {
    const k = known.find((c) => String(c.id ?? "").toLowerCase() === id);
    return { id, name: text(k?.name), code: text(k?.code, 40), phoneCode: phoneCodeOf(k?.phoneCode), timeZone: typeof k?.timeZone === "string" ? k.timeZone : null };
  });
}

/** A Zenoti id: a GUID, as their centres, guests and invoices have. */
const ZENOTI_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export const zenotiConnector: Connector = {
  kind: "zenoti",
  // Read only: no event of ours is ever queued for Zenoti.
  wants: () => false,
  test: (ctx) => testZenoti(ctx),
  async send(): Promise<SendResult> {
    return { ok: false, retry: false, response: "JENAI only reads from Zenoti and never writes to it." };
  },
};

// ---------------------------------------------------------------- reading Zenoti's answers

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function parse(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** A list Zenoti hands back bare or under a key, depending on the endpoint. */
function listOf(j: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(j)) return j;
  for (const k of keys) {
    const v = obj(j)[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function text(v: unknown, max = 200): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function int(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}

function digitsOf(v: unknown): string | null {
  const d = text(v, 10)?.replace(/\D/g, "");
  return d || null;
}

/** A country's calling code ("91"): one to four digits, never starting with 0, which Zenoti writes for none. */
function phoneCodeOf(v: unknown): string | null {
  const d = digitsOf(v);
  return d && /^[1-9]\d{0,3}$/.test(d) ? d : null;
}

function personName(first: unknown, last: unknown): string | null {
  return [text(first), text(last)].filter(Boolean).join(" ") || null;
}

/** A wall-clock time with no zone, as Zenoti writes centre time ("2026-09-30T14:45:00"). */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;

/** Zenoti's UTC times carry no zone ("2019-09-15T09:00:00"), so one without is read as UTC. */
function utcInstant(v: unknown): Date | null {
  const s = text(v, 40);
  if (!s || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar day a centre-time value falls on, "YYYY-MM-DD"; from a UTC one, the day in the centre's zone. */
function centreDay(local: unknown, utc: unknown, tz: string): string | null {
  const m = LOCAL.exec(text(local, 40) ?? "");
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    return day.getUTCMonth() === mo - 1 && day.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  const at = utcInstant(utc);
  if (!at) return null;
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** When something starts: Zenoti's UTC time when given, else its centre time read in the centre's zone. */
function startOf(local: unknown, utc: unknown, tz: string): Date | null {
  const at = utcInstant(utc);
  if (at) return at;
  const m = LOCAL.exec(text(local, 40) ?? "");
  if (!m || m[4] === undefined) return null;
  return zoned(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) * 60 + Number(m[5]), tz);
}

// ---------------------------------------------------------------- phones and people

/**
 * Phone codes by Zenoti country id, from Zenoti's own country list
 * (retrieve-the-list-of-all-countries: India is 95, "91"; the United States
 * 225, "1"). A guest's mobile names its country by this id, not by the
 * dialling code (create-a-guest: country_code 225 gives +1).
 */
export const ZENOTI_PHONE_CODES: Record<string, string> = { "95": "91", "225": "1" };

export interface ZenotiPhoneOptions {
  /** For a mobile saved without a country: the connection's setting, else the centre's country. None, and such a mobile gives no number. */
  defaultCountryCode?: string;
  /** Phone codes by Zenoti country id, from ZenotiClient.phoneCodes(), for countries the built-in list lacks. */
  phoneCodes?: Record<string, string>;
}

/**
 * A Zenoti mobile as E.164: an appointment's {country_id, number,
 * display_number} or a guest's {country_code, phone_code, number}. A number
 * written with its "+" is read as it stands; otherwise the country id gives
 * the code (or the phone code beside it), and no country at all means the
 * default the caller gives: the connection's, else the centre's country. A
 * country we cannot place, or no default, gives no number rather than a
 * guess: a wrong country code dials a stranger.
 */
export function zenotiPhone(mobile: unknown, opts: ZenotiPhoneOptions = {}): string | null {
  const m = obj(mobile);
  const fallback = phoneCodeOf(opts.defaultCountryCode);
  const display = text(m.display_number, 40);
  const number = text(m.number, 40);
  if (display?.startsWith("+")) {
    const p = toE164(display);
    if (p) return p;
  }
  if (number?.startsWith("+")) return toE164(number);
  const raw = number ?? display;
  if (!raw) return null;
  const id = int(m.country_code ?? m.country_id);
  // Zenoti writes 0 here for none (retrieve-guest-details' own example).
  const own = phoneCodeOf(m.phone_code);
  const code = id ? (opts.phoneCodes?.[String(id)] ?? ZENOTI_PHONE_CODES[String(id)] ?? own) : (own ?? fallback);
  return code ? dial(raw, code) : null;
}

/**
 * A number Zenoti keeps apart from its country, with that country's code.
 * toE164's rules are written for ten-digit national numbers (India, and the
 * US and Canada under 1); elsewhere the trunk zeros go and the code is put
 * in front, unless the front desk typed it already.
 */
function dial(raw: string, code: string): string | null {
  if (code === "91" || code === "1") return toE164(raw, code);
  const d = raw.replace(/\D/g, "").replace(/^0+/, "");
  return d ? toE164(`+${d.startsWith(code) ? d : `${code}${d}`}`) : null;
}

export type ZenotiPersonRow = Pick<typeof externalPeople.$inferInsert, "externalId" | "phoneE164" | "name" | "marketingSmsConsent" | "transactionalSmsConsent">;

/**
 * Consent as their profile says it: the yes/no flag (receive_marketing_sms)
 * when there is one, else the opt-in number (marketing_sms_optin). Zenoti
 * does not document that number's values, so only 1 counts as a yes. Empty
 * when the profile says neither.
 */
function consent(flag: unknown, optIn: unknown): boolean | null {
  if (typeof flag === "boolean") return flag;
  const n = int(optIn);
  return n === null ? null : n === 1;
}

/**
 * A guest's profile (retrieve-guest-details) as an external_people row: their
 * id, mobile, name and the two SMS consents, nothing else. The consents sit
 * under preferences, as documented, or at the top of an answer that has them there.
 */
export function zenotiPerson(guest: unknown, opts: ZenotiPhoneOptions = {}): ZenotiPersonRow | null {
  const g = obj(guest);
  const externalId = text(g.id, 64);
  if (!externalId) return null;
  const info = obj(g.personal_info);
  const prefs = obj(g.preferences);
  const pref = (k: string) => prefs[k] ?? g[k];
  return {
    externalId,
    phoneE164: zenotiPhone(info.mobile_phone ?? g.mobile, opts),
    name: personName(info.first_name ?? g.first_name, info.last_name ?? g.last_name),
    marketingSmsConsent: consent(pref("receive_marketing_sms"), pref("marketing_sms_optin")),
    transactionalSmsConsent: consent(pref("receive_transactional_sms"), pref("transactional_sms_optin")),
  };
}

// ---------------------------------------------------------------- bookings and visits

/**
 * Zenoti's appointment status, as list-all-appointments-of-a-guest documents
 * it: NoShow -2, Cancelled -1, New 0, Closed 1, Checkin 2, Confirm 4, Break
 * 10, NotSpecified 11, Available 20, Voided 21. The centre list of
 * appointments does not define it, so only these are read; Break,
 * NotSpecified, Available, Voided and anything else are "unknown", neither
 * booked nor done. Closed is a visit that was checked out: completed.
 */
const APPOINTMENT_STATUS: Record<string, ClinicAppointmentStatus> = {
  "-2": "no_show",
  noshow: "no_show",
  "-1": "cancelled",
  cancelled: "cancelled",
  "0": "booked",
  new: "booked",
  "1": "completed",
  closed: "completed",
  "2": "checked_in",
  checkin: "checked_in",
  "4": "confirmed",
  confirm: "confirmed",
};

export function zenotiAppointmentStatus(v: unknown): ClinicAppointmentStatus {
  const key = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_-]/g, "") : "";
  return Object.hasOwn(APPOINTMENT_STATUS, key) ? APPOINTMENT_STATUS[key]! : "unknown";
}

/** The doctor or therapist by the name the clinic shows. */
function therapistName(t: unknown): string | null {
  const o = obj(t);
  return text(o.display_name) ?? personName(o.first_name, o.last_name);
}

/** The category and sub-category, without repeating one. */
function categoriesOf(...names: unknown[]): string[] {
  const parts = names.map((n) => text(n)).filter((x): x is string => !!x);
  return parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
}

/** "Laser / Hair Reduction": the category and sub-category, for the clinic to read. */
function categoryOf(service: Record<string, unknown>): string | null {
  return categoriesOf(obj(service.category).name, obj(service.sub_category).name).join(" / ") || null;
}

export interface ZenotiReadOptions extends ZenotiPhoneOptions {
  /** The Zenoti centre the rows were read for. */
  centreRef?: string | null;
  /** The centre's IANA time zone, for a time Zenoti gives only in centre time. Asia/Kolkata by default. */
  timeZone?: string;
}

export type ZenotiAppointmentRow = Pick<
  typeof clinicAppointments.$inferInsert,
  "externalId" | "guestRef" | "phoneE164" | "name" | "service" | "category" | "startsAt" | "localDay" | "status" | "doctor" | "centreRef"
>;

/**
 * One appointment from a centre's list as a clinic_appointments row. Null
 * for one with no guest or service (a break, a blocked slot).
 */
export function zenotiAppointmentRow(a: unknown, opts: ZenotiReadOptions = {}): ZenotiAppointmentRow | null {
  const r = obj(a);
  const guest = obj(r.guest);
  const service = obj(r.service);
  const externalId = text(r.appointment_id, 64);
  const guestRef = text(guest.id, 64);
  const serviceName = text(service.name, 300);
  const tz = opts.timeZone ?? "Asia/Kolkata";
  const startsAt = startOf(r.start_time, r.start_time_utc, tz);
  if (!externalId || !guestRef || !serviceName || !startsAt) return null;
  return {
    externalId,
    guestRef,
    phoneE164: zenotiPhone(guest.mobile, opts),
    name: personName(guest.first_name, guest.last_name),
    service: serviceName,
    category: categoryOf(service),
    startsAt,
    // The day Zenoti lists it under: its centre-time start, as written.
    localDay: centreDay(r.start_time, r.start_time_utc, tz),
    status: zenotiAppointmentStatus(r.status),
    doctor: therapistName(r.therapist),
    centreRef: opts.centreRef ?? null,
  };
}

/** A service someone took, read from Zenoti, before it is stored as a visit. */
export interface ZenotiVisit {
  /** Their id for this line: the appointment, the invoice item, or invoice and item for the accrual report. */
  externalId: string;
  guestRef: string;
  /** Null when the source has none (the sales reports): the guest's profile supplies it. */
  phoneE164: string | null;
  name: string | null;
  service: string;
  category: string | null;
  /** The service's category and sub-category, each as Zenoti names it, for a package that covers a category. */
  categories: string[];
  /** The day it was done, in centre time, "YYYY-MM-DD". */
  visitDate: string;
  /**
   * The day the source lists it under, in centre time: its sale for a report
   * line (which may be a day after the service), the visit day otherwise.
   * Re-reading those days can then tell a line the source dropped.
   */
  listedOn: string;
  doctor: string | null;
  centreRef: string | null;
  /** The package it was taken under, when the source says. */
  packageName: string | null;
  /** Sessions in that package, read from its name. */
  sessionsTotal: number | null;
}

/**
 * Sessions a package's name promises: "LHR 5 Body Parts 5 Sessions" is 5,
 * "6 sittings" is 6. The number before "sessions" or "sittings" counts, the
 * last one when there are several; anything else is null.
 */
export function packageSessions(name: unknown): number | null {
  const s = text(name, 300);
  if (!s) return null;
  const found = [...s.matchAll(/(\d{1,4})\s*(?:sessions?|sittings?)\b/gi)];
  const n = found.length ? Number(found.at(-1)![1]) : NaN;
  return n >= 1 && n <= 1000 ? n : null;
}

/** A completed appointment as a visit, on the day it was in centre time. Any other status is not a visit. */
export function zenotiAppointmentVisit(a: unknown, opts: ZenotiReadOptions = {}): ZenotiVisit | null {
  const row = zenotiAppointmentRow(a, opts);
  if (!row || row.status !== "completed") return null;
  const r = obj(a);
  const visitDate = centreDay(r.start_time, r.start_time_utc, opts.timeZone ?? "Asia/Kolkata");
  if (!visitDate) return null;
  return {
    externalId: row.externalId,
    guestRef: row.guestRef,
    phoneE164: row.phoneE164 ?? null,
    name: row.name ?? null,
    service: row.service,
    category: row.category ?? null,
    categories: categoriesOf(obj(obj(r.service).category).name, obj(obj(r.service).sub_category).name),
    visitDate,
    listedOn: visitDate,
    doctor: row.doctor ?? null,
    centreRef: row.centreRef ?? null,
    packageName: null,
    sessionsTotal: null,
  };
}

/**
 * A report line for a service: item type 0 in the older report (where 2 is a
 * product, 3 a membership, 4 a package, 6 a gift card), "Service" in the
 * accrual report. A session taken from a package is a service line too, its
 * package_redemption or redeemed saying how much of it the package paid; the
 * package's own sale (4) is not a session.
 */
const isService = (v: unknown) => v === 0 || (typeof v === "string" && /^(0|service)$/i.test(v.trim()));

/** A line that took nothing away (a refund or a correction) is not a visit. */
const nonePositive = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n <= 0;
};

/**
 * A service line from the older sales report (center_sales_report) as a
 * visit, on the day it was serviced in centre time. It names the guest but
 * has no phone. Its free-text fields (tags, notes) are never read.
 */
export function zenotiSalesReportVisit(row: unknown, opts: ZenotiReadOptions = {}): ZenotiVisit | null {
  const r = obj(row);
  const item = obj(r.item);
  const guest = obj(r.guest);
  if (!isService(item.type) || nonePositive(r.quantity)) return null;
  const externalId = text(r.invoice_item_id, 64);
  const guestRef = text(guest.guest_id, 64);
  const service = text(item.name, 300);
  const sold = centreDay(r.sold_on, null, "UTC");
  const visitDate = centreDay(r.serviced_on, null, "UTC") ?? sold;
  if (!externalId || !guestRef || !service || !visitDate) return null;
  const packageName = text(r.package, 300);
  return {
    externalId,
    guestRef,
    phoneE164: null,
    name: text(guest.guest_name),
    service,
    category: null,
    categories: [],
    visitDate,
    listedOn: sold ?? visitDate,
    doctor: text(obj(r.employee).name),
    centreRef: opts.centreRef ?? null,
    packageName,
    sessionsTotal: packageSessions(packageName),
  };
}

/**
 * A service line from the sales accrual report as a visit. Only a closed
 * invoice counts (an open one may not have been served yet), on its sale
 * day; the report has no line id, so the invoice and item together are its
 * id. It names the guest but has no phone, and its notes are never read.
 */
export function zenotiSalesAccrualVisit(row: unknown, opts: ZenotiReadOptions = {}): ZenotiVisit | null {
  const r = obj(row);
  if (!isService(r.item_type) || nonePositive(r.qty)) return null;
  const status = text(r.status, 40);
  if (status && status.toLowerCase() !== "closed") return null;
  const invoice = text(r.invoice_id, 64);
  const item = text(r.item_id, 64);
  const guestRef = text(r.guest_id, 64);
  const service = text(r.item_name, 300);
  const visitDate = centreDay(r.sale_date, null, "UTC");
  if (!invoice || !item || !guestRef || !service || !visitDate) return null;
  const categories = categoriesOf(r.item_category, r.item_sub_category);
  return {
    externalId: `${invoice}:${item}`,
    guestRef,
    phoneE164: null,
    name: text(r.guest_name),
    service,
    category: categories.join(" / ") || null,
    categories,
    visitDate,
    listedOn: visitDate,
    doctor: text(r.provider),
    centreRef: text(r.center_id, 64) ?? opts.centreRef ?? null,
    packageName: null,
    sessionsTotal: null,
  };
}

// ---------------------------------------------------------------- packages

/**
 * A series package's status, as list-the-series-packages-of-a-guest
 * documents it: Active 1, Frozen 3, Expired 5, CancelledRefund 6, NotStarted
 * 7. NotApplicable 8, Default -1 and anything else are "unknown".
 */
const PACKAGE_STATUS: Record<string, PackageStatus> = {
  "1": "active",
  active: "active",
  "3": "frozen",
  frozen: "frozen",
  "5": "expired",
  expired: "expired",
  "6": "cancelled",
  cancelledrefund: "cancelled",
  "7": "not_started",
  notstarted: "not_started",
};

export function zenotiPackageStatus(v: unknown): PackageStatus {
  const key = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_-]/g, "") : "";
  return Object.hasOwn(PACKAGE_STATUS, key) ? PACKAGE_STATUS[key]! : "unknown";
}

export type ZenotiPackageRow = Pick<
  typeof packageBalances.$inferInsert,
  "guestRef" | "packageRef" | "packageName" | "service" | "covers" | "total" | "used" | "balance" | "status" | "expiresOn"
>;

/** Which purchase speaks for a package bought twice: the one in use first. */
const IN_USE: Record<PackageStatus, number> = { active: 5, not_started: 4, frozen: 3, unknown: 2, expired: 1, cancelled: 0 };

/** Sessions left on a package line, when Zenoti says. */
export function sessionsLeft(p: { balance?: number | null; total?: number | null; used?: number | null }): number | null {
  return p.balance ?? (p.total != null && p.used != null ? p.total - p.used : null);
}

/**
 * A purchase with sessions left before one used up: Zenoti has no
 * "completed" status, so a series bought again at checkout sits beside the
 * used-up one, still Active, and the new one is what they will book.
 */
function better(a: ZenotiPackageRow, b: ZenotiPackageRow): boolean {
  // A service and a category of the same name in one package share a row: the service is the one named.
  if (a.covers !== b.covers) return a.covers === "service";
  const open = (p: ZenotiPackageRow) => (sessionsLeft(p) ?? 1) > 0 && p.status !== "expired" && p.status !== "cancelled";
  if (open(a) !== open(b)) return open(a);
  const rank = IN_USE[a.status] - IN_USE[b.status];
  if (rank) return rank > 0;
  if ((a.expiresOn ?? "") !== (b.expiresOn ?? "")) return (a.expiresOn ?? "") > (b.expiresOn ?? "");
  return (a.balance ?? -1) > (b.balance ?? -1);
}

/**
 * What a package line covers, by service_type_info.service_category_type:
 * Default -1, Category 1, Service 2, Tag 3 (list-the-series-packages-of-a-
 * guest). Only a category or a tag is read as one; a Service line, a Default
 * one and an answer without the field name a service.
 */
function coversOf(v: unknown): PackageCovers {
  const n = int(v);
  return n === 1 ? "category" : n === 3 ? "tag" : "service";
}

/**
 * A guest's series packages as package_balances rows, one per package and
 * service (or category, or tag) in it, with sessions bought, used and left,
 * its status and the last day a session can be taken from it: the end of its
 * grace period when it has one (date.end_date_with_grace), else its end.
 * package_balances holds one row per package name and service, so a package
 * bought twice is the purchase with sessions left, then the one in use
 * (active, then not yet started, then frozen), else the one ending later.
 * Products in a package are not sessions and are left out.
 */
export function zenotiPackageBalances(guestRef: string, packages: unknown): ZenotiPackageRow[] {
  const by = new Map<string, ZenotiPackageRow>();
  for (const p of listOf(packages, "packages", "guest_packages")) {
    const pk = obj(p);
    const def = obj(pk.package);
    const packageName = text(def.name, 300);
    if (!packageName) continue;
    const status = zenotiPackageStatus(pk.status);
    const date = obj(pk.date);
    const expiresOn = centreDay(date.end_date_with_grace, null, "UTC") ?? centreDay(date.end, null, "UTC");
    for (const s of listOf(pk.services)) {
      const sv = obj(s);
      const info = obj(sv.service_type_info);
      // Documented under service_type_info; the other two are kept for answers shaped otherwise.
      const service = text(info.name, 300) ?? text(sv.name, 300) ?? text(obj(sv.service).name, 300);
      if (!service) continue;
      const row: ZenotiPackageRow = {
        guestRef,
        packageRef: text(pk.user_package_id, 64) ?? text(def.id, 64),
        packageName,
        service,
        covers: coversOf(info.service_category_type),
        total: int(sv.total),
        used: int(sv.used),
        balance: int(sv.balance),
        status,
        expiresOn,
      };
      const key = `${packageName}\u0000${service}`;
      const had = by.get(key);
      if (!had || better(row, had)) by.set(key, row);
    }
  }
  return [...by.values()];
}
