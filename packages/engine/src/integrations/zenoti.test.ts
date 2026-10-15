/**
 * The Zenoti connector against a fake Zenoti: nothing here reaches the real
 * one. The fake answers the way Zennara's key was seen to (401 "Authorization
 * has been denied for this request." for what the key may not read) and as
 * Zenoti's documentation describes the rest. A fake clock stands in for
 * waiting, so pacing and 429s are checked without the test sleeping.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Integration } from "@jenai/db";
import type { ConnectorContext } from "./types";
import {
  ZenotiBudgetSpent,
  ZenotiClient,
  ZenotiKeyError,
  ZenotiPermissionError,
  ZenotiTimeSpent,
  ZenotiUnavailableError,
  packageSessions,
  phoneCodeForZone,
  testZenoti,
  zenotiAppointmentRow,
  zenotiAppointmentStatus,
  zenotiAppointmentVisit,
  zenotiConnector,
  zenotiPackageBalances,
  zenotiPackageStatus,
  zenotiPath,
  zenotiPerson,
  zenotiPhone,
  zenotiSalesAccrualVisit,
  zenotiSalesReportVisit,
  zenotiTimeZone,
  type ZenotiCapabilities,
} from "./zenoti";

const KEY = "zen-test-key-not-real";
const KONDAPUR = "80963e4e-6625-4b83-8b88-9708c0cb2303";
const DENIED = { Message: "Authorization has been denied for this request." };
const CENTRES = { centers: [{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", country: { name: "India" } }] };

interface Seen {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string | null;
}
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A Zenoti that answers by method and path, and remembers every request. */
function fakeZenoti(answer: (r: Seen) => Reply | "network") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const r: Seen = {
      method: init?.method ?? "GET",
      host: url.host,
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    seen.push(r);
    const a = answer(r);
    if (a === "network") throw new TypeError("fetch failed");
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json", ...a.headers } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function fakeClock(start = Date.parse("2026-10-04T06:00:00Z")) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

/** A connection of its own each time, so pacing from one test never slows another. */
function connection(fetchImpl: typeof fetch, config: Record<string, unknown> = {}, credentials: Record<string, string> = { api_key: KEY }) {
  const saved: Array<Record<string, unknown>> = [];
  const ctx: ConnectorContext = {
    integration: { tenantId: randomUUID(), id: randomUUID(), kind: "zenoti", name: "Zenoti", config, mapping: {} } as unknown as Integration,
    credentials,
    fetch: fetchImpl,
    async save(patch) {
      if (patch.config) saved.push(patch.config);
    },
  };
  return { ctx, saved };
}

const ENDPOINTS = ["appointments", "guestDetails", "guestPackages", "salesAccrual", "salesReport"] as const;
type Endpoint = (typeof ENDPOINTS)[number];

function endpointOf(r: Seen): Endpoint | "centres" | null {
  if (r.method === "GET" && r.path === "/v1/centers") return "centres";
  if (r.method === "GET" && r.path === "/v1/appointments") return "appointments";
  if (r.method === "GET" && /^\/v1\/guests\/[^/]+$/.test(r.path)) return "guestDetails";
  if (r.method === "GET" && /^\/v1\/guests\/[^/]+\/Packages$/.test(r.path)) return "guestPackages";
  if (r.method === "POST" && r.path === "/v1/reports/sales/accrual_basis/flat_file") return "salesAccrual";
  if (r.method === "GET" && r.path === "/v1/sales/salesreport") return "salesReport";
  return null;
}

/** What Zenoti answers an allowed check: data, or for a guest nobody has, not found. */
const ALLOWED: Record<Endpoint, Reply> = {
  appointments: { status: 200, body: [] },
  guestDetails: { status: 404, body: { code: "404", message: "Guest not found" } },
  guestPackages: { status: 400, body: { code: "400", message: "Invalid guest" } },
  salesAccrual: { status: 200, body: { sales: [], page_info: { total: 0, page: 1, size: 1 } } },
  salesReport: { status: 200, body: { center_sales_report: [], Error: null } },
};

/** A Zenoti whose key may read exactly `allowed`, as Zennara's denials were seen. */
function zenotiAllowing(allowed: Set<Endpoint>, overrides: Partial<Record<Endpoint, Reply>> = {}) {
  return fakeZenoti((r) => {
    const e = endpointOf(r);
    if (e === "centres") return { status: 200, body: CENTRES, headers: { "ratelimit-remaining": "55", "ratelimit-reset": "1" } };
    if (!e) return { status: 404 };
    return overrides[e] ?? (allowed.has(e) ? ALLOWED[e] : { status: 401, body: DENIED });
  });
}

describe("zenoti: what a key may read", () => {
  it("finds every combination of what a key may read, picks the best path and says what to ask for", async () => {
    for (let mask = 0; mask < 32; mask++) {
      const allowed = new Set(ENDPOINTS.filter((_, i) => mask & (1 << i)));
      const { fetchImpl, seen } = zenotiAllowing(allowed);
      const { ctx, saved } = connection(fetchImpl);
      const r = await testZenoti(ctx, fakeClock());
      const can = (e: Endpoint) => allowed.has(e);
      const label = [...allowed].join(",") || "nothing";

      expect(r.capabilities, label).toEqual({
        appointments: can("appointments"),
        guestDetails: can("guestDetails"),
        guestPackages: can("guestPackages"),
        salesAccrual: can("salesAccrual"),
        salesReport: can("salesReport"),
      });
      const path = can("appointments") ? "appointments" : can("salesAccrual") ? "sales_accrual" : can("salesReport") ? "sales_report" : null;
      expect(r.path, label).toBe(path);
      expect(r.ok, label).toBe(path !== null);
      expect(r.centres, label).toEqual([{ id: KONDAPUR, name: "Kondapur", code: "ZNKD", phoneCode: null, timeZone: null }]);

      // Advice for exactly what is missing and worth having.
      const said = (re: RegExp) => r.advice.some((a) => re.test(a));
      expect(said(/does not let this key read appointments/), label).toBe(!can("appointments"));
      expect(said(/does not let this key read guest details/), label).toBe(!can("guestDetails"));
      expect(said(/does not let this key read guests' packages/), label).toBe(!can("guestPackages"));
      expect(said(/older sales report, which Zenoti has deprecated/), label).toBe(path === "sales_report");
      if (!can("guestDetails")) expect(said(path === "sales_accrual" || path === "sales_report" ? /have no phone number/ : /agreed to SMS/), label).toBe(true);
      for (const a of r.advice) expect(a, label).toMatch(/API key groups of the backend app that issued this key \(in Zenoti: Configuration, then Apps under Integrations\)|deprecated/);
      expect(r.message, label).toContain(r.advice.join(" "));
      expect(`${r.message}${r.advice.join("")}`, label).not.toMatch(/\u2014/);
      expect(JSON.stringify(r), label).not.toContain(KEY);

      // One request each: the centres and five checks. Only the report is a POST, and it only reads.
      expect(seen.map(endpointOf), label).toEqual(["centres", ...ENDPOINTS]);
      expect(seen.every((s) => s.host === "api.zenoti.com" && s.auth === `apikey ${KEY}`), label).toBe(true);
      expect(seen.filter((s) => s.method !== "GET").map((s) => s.path), label).toEqual(["/v1/reports/sales/accrual_basis/flat_file"]);

      // Kept on the connection for the sync.
      expect(saved, label).toEqual([{ centres: r.centres, access: { capabilities: r.capabilities, path, checkedAt: "2026-10-04T06:00:00.000Z" } }]);
    }
  });

  it("sends the cheapest checks: one day at the first centre, one report row, a guest nobody has", async () => {
    const { fetchImpl, seen } = zenotiAllowing(new Set(ENDPOINTS));
    await testZenoti(connection(fetchImpl).ctx, fakeClock());
    const by = (e: Endpoint) => seen.find((s) => endpointOf(s) === e)!;
    expect(Object.fromEntries(by("appointments").query)).toEqual({ center_id: KONDAPUR, start_date: "2026-10-04", end_date: "2026-10-05", include_no_show_cancel: "true" });
    expect(by("guestDetails").path).toBe("/v1/guests/00000000-0000-0000-0000-000000000000");
    expect(Object.fromEntries(by("guestPackages").query)).toEqual({ center_id: KONDAPUR });
    expect(Object.fromEntries(by("salesAccrual").query)).toEqual({ Page: "1", Size: "1" });
    expect(by("salesAccrual").body).toEqual({ center_ids: [KONDAPUR], start_date: "2026-10-04 00:00:00", end_date: "2026-10-04 23:59:59", item_types: [-1], invoice_statuses: [-1] });
    expect(Object.fromEntries(by("salesReport").query)).toEqual({ center_id: KONDAPUR, start_date: "2026-10-04", end_date: "2026-10-04", item_type: "0", status: "1" });
  });

  it("tells Zennara, whose key may read the sales report but not appointments, what to ask for", async () => {
    const { fetchImpl } = zenotiAllowing(new Set(["salesReport", "guestDetails", "guestPackages"]));
    const r = await testZenoti(connection(fetchImpl).ctx, fakeClock());
    expect(r.ok).toBe(true);
    expect(r.path).toBe("sales_report");
    expect(r.message).toBe(
      "Connected to Zenoti: 1 centre (Kondapur, ZNKD). Services done are read from Zenoti's older sales report, with each guest's mobile from their Zenoti profile. Sessions left on each guest's packages are read too. " +
        "Zenoti does not let this key read appointments. Ask your Zenoti admin to add read access to appointments in the API key groups of the backend app that issued this key (in Zenoti: Configuration, then Apps under Integrations). JENAI then sees bookings, no-shows and completed visits with the patient's mobile. " +
        "JENAI is reading Zenoti's older sales report, which Zenoti has deprecated. Ask your Zenoti admin to add read access to the sales accrual report in the API key groups of the backend app that issued this key (in Zenoti: Configuration, then Apps under Integrations), and to make sure the security role of the Zenoti user that app runs as may see reports. JENAI then keeps working if Zenoti retires the older one.",
    );
  });

  it("reads a refused check of a guest nobody has as allowed only for not found or bad request", async () => {
    const run = async (reply: Reply) => {
      const { fetchImpl } = zenotiAllowing(new Set(ENDPOINTS), { guestDetails: reply });
      return testZenoti(connection(fetchImpl).ctx, fakeClock());
    };
    expect((await run({ status: 404 })).capabilities.guestDetails).toBe(true);
    expect((await run({ status: 400 })).capabilities.guestDetails).toBe(true);
    expect((await run({ status: 200, body: { id: null } })).capabilities.guestDetails).toBe(true);
    expect((await run({ status: 401, body: DENIED })).capabilities.guestDetails).toBe(false);
    expect((await run({ status: 403 })).capabilities.guestDetails).toBe(false);
    // Something else is not about the key's permission: not blamed on their admin.
    const odd = await run({ status: 405 });
    expect(odd.capabilities.guestDetails).toBe(false);
    expect(odd.advice).toEqual(["Zenoti refused JENAI's check of guest details (HTTP 405). That is for JENAI support to look into, not your Zenoti admin."]);
  });

  it("does not take a check Zenoti never answered as a refusal", async () => {
    const { fetchImpl, seen } = zenotiAllowing(new Set(ENDPOINTS), { appointments: { status: 503 } });
    const clock = fakeClock();
    const r = await testZenoti(connection(fetchImpl).ctx, clock);
    expect(r.capabilities.appointments).toBeNull();
    // The next best path is used meanwhile, and the clinic is told to test again, not to change anything.
    expect(r.path).toBe("sales_accrual");
    expect(r.advice).toEqual(["Zenoti did not answer JENAI's check of appointments just now. Test again in a few minutes."]);
    expect(seen.filter((s) => endpointOf(s) === "appointments")).toHaveLength(4);
    expect(clock.slept).toEqual([1000, 2000, 4000]);

    // With nothing else to read from, it is not called broken for good either.
    const quiet = zenotiAllowing(new Set(), { appointments: { status: 503 } });
    const none = await testZenoti(connection(quiet.fetchImpl).ctx, fakeClock());
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/JENAI could not yet tell where to read services done from\./);
    expect(none.advice.at(-1)).toBe("Zenoti did not answer JENAI's check of appointments just now. Test again in a few minutes.");
  });

  it("says the key itself is wrong when Zenoti refuses the list of centres, and asks nothing else", async () => {
    const { fetchImpl, seen } = fakeZenoti(() => ({ status: 401, body: DENIED }));
    const { ctx, saved } = connection(fetchImpl);
    const r = await testZenoti(ctx, fakeClock());
    expect(r.ok).toBe(false);
    expect(r.path).toBeNull();
    expect(r.centres).toEqual([]);
    expect(Object.values(r.capabilities).every((c) => c === null)).toBe(true);
    expect(r.message).toBe(
      "Zenoti did not accept this API key. It may be mistyped, or no longer valid in Zenoti. Ask your Zenoti admin for the API key of the backend app made for JENAI (in Zenoti: Configuration, then Apps under Integrations) and save it here again.",
    );
    // The centres, then a guest nobody has: refused too, so it is the key, not a missing permission.
    expect(seen.map((s) => s.path)).toEqual(["/v1/centers", "/v1/guests/00000000-0000-0000-0000-000000000000"]);
    expect(saved).toEqual([]);
    expect(r.message).not.toContain(KEY);
  });

  it("calls nobody without a key, or at an address that is not Zenoti's", async () => {
    const { fetchImpl, seen } = zenotiAllowing(new Set(ENDPOINTS));
    expect((await testZenoti(connection(fetchImpl, {}, {}).ctx, fakeClock())).message).toMatch(/^No Zenoti API key is saved on this connection\. Ask your Zenoti admin for the API key/);
    for (const baseUrl of ["https://zenoti.example.com", "http://api.zenoti.com", "https://api.zenoti.com.evil.io", "https://user:pw@api.zenoti.com", "not a url"]) {
      const r = await testZenoti(connection(fetchImpl, { baseUrl }).ctx, fakeClock());
      expect(r.ok, baseUrl).toBe(false);
      expect(r.message, baseUrl).toMatch(/The Zenoti address saved on this connection is not/);
    }
    expect(seen).toHaveLength(0);
    // Another of Zenoti's own hosts is fine.
    const r = await testZenoti(connection(fetchImpl, { baseUrl: "https://apiasia03.zenoti.com/" }).ctx, fakeClock());
    expect(r.ok).toBe(true);
    expect(seen.every((s) => s.host === "apiasia03.zenoti.com")).toBe(true);
  });

  it("says a key that sees no centres has nothing to read", async () => {
    const { fetchImpl } = fakeZenoti(() => ({ status: 200, body: { centers: [] } }));
    const r = await testZenoti(connection(fetchImpl).ctx, fakeClock());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Zenoti accepted the key, but it sees no centres/);
  });

  it("picks the path in order: appointments, then the accrual report, then the older report", () => {
    const c = (x: Partial<ZenotiCapabilities>): ZenotiCapabilities => ({ appointments: null, guestDetails: null, guestPackages: null, salesAccrual: null, salesReport: null, ...x });
    expect(zenotiPath(c({ appointments: true, salesAccrual: true, salesReport: true }))).toBe("appointments");
    expect(zenotiPath(c({ appointments: false, salesAccrual: true, salesReport: true }))).toBe("sales_accrual");
    expect(zenotiPath(c({ appointments: null, salesAccrual: null, salesReport: true }))).toBe("sales_report");
    expect(zenotiPath(c({ appointments: false, salesAccrual: false, salesReport: false }))).toBeNull();
  });

  it("never writes to Zenoti", async () => {
    const { fetchImpl, seen } = zenotiAllowing(new Set(ENDPOINTS));
    expect(zenotiConnector.kind).toBe("zenoti");
    expect(zenotiConnector.wants!(connection(fetchImpl).ctx.integration, "call.completed")).toBe(false);
    const r = await zenotiConnector.send(connection(fetchImpl).ctx, { id: "e", kind: "call.completed", idempotencyKey: "k", externalId: null, payload: {} });
    expect(r).toEqual({ ok: false, retry: false, response: "JENAI only reads from Zenoti and never writes to it." });
    expect(seen).toHaveLength(0);
  });
});

describe("zenoti: keys that may not read everything", () => {
  it("reads every page of the centres, as list-all-centers pages them", async () => {
    const all = Array.from({ length: 250 }, (_, n) => ({ id: `c-${n}`, name: `Centre ${n}`, code: `C${n}`, country: { id: 95, phone_code: 0 }, location: { time_zone: { standard_name: "India Standard Time" } } }));
    const z = fakeZenoti((r) => {
      if (r.path !== "/v1/centers") return { status: 404 };
      const [page, size] = [Number(r.query.get("Page")), Number(r.query.get("Size"))];
      return { status: 200, body: { centers: all.slice((page - 1) * size, page * size), page_info: { total: all.length, page, size } } };
    });
    const centres = await new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock()).centres();
    expect(centres).toHaveLength(250);
    expect(z.seen.map((s) => [s.query.get("Page"), s.query.get("Size")])).toEqual([
      ["1", "100"],
      ["2", "100"],
      ["3", "100"],
    ]);
    // phone_code 0 is none, so the country id (95, India) gives it; the time zone is the centre's own.
    expect(centres[0]).toEqual({ id: "c-0", name: "Centre 0", code: "C0", phoneCode: "91", timeZone: "Asia/Kolkata" });
    // A Zenoti that does not page hands the same list back: read once, not looped over.
    const flat = fakeZenoti(() => ({ status: 200, body: { centers: all.slice(0, 120) } }));
    expect(await new ZenotiClient(connection(flat.fetchImpl).ctx, fakeClock()).centres()).toHaveLength(120);
    expect(flat.seen).toHaveLength(2);
  });

  it("tells a key that may not list the centres from a wrong one, and reads the centres named on the connection", async () => {
    const z = fakeZenoti((r) => {
      const e = endpointOf(r);
      if (e === "centres") return { status: 401, body: DENIED };
      return e ? ALLOWED[e] : { status: 404 };
    });
    const bare = await testZenoti(connection(z.fetchImpl).ctx, fakeClock());
    expect(bare).toMatchObject({ ok: false, path: null });
    expect(bare.message).toBe(
      "Zenoti accepted the key, but does not let it read the list of centres, so JENAI cannot tell which centres to read. Ask your Zenoti admin to add read access to centres in the API key groups of the backend app that issued this key (in Zenoti: Configuration, then Apps under Integrations).",
    );

    // The centre ids the clinic named stand in for the list; a code alone cannot.
    const named = connection(z.fetchImpl, { onlyCentres: [KONDAPUR, "ZNKD"] });
    const r = await testZenoti(named.ctx, fakeClock());
    expect(r).toMatchObject({ ok: true, path: "appointments" });
    expect(r.centres).toEqual([{ id: KONDAPUR, name: null, code: null, phoneCode: null, timeZone: null }]);
    expect(r.message).toMatch(/^Connected to Zenoti, which does not let this key read the list of centres: JENAI reads the centre named on this connection\./);
    expect(r.advice[0]).toBe(
      "Zenoti does not let this key read the list of centres. Ask your Zenoti admin to add read access to centres in the API key groups of the backend app that issued this key (in Zenoti: Configuration, then Apps under Integrations). JENAI then reads every centre the key sees, by name.",
    );
    expect(named.saved[0]).toMatchObject({ centres: r.centres, access: { path: "appointments" } });
  });

  it("takes the accrual report's 'cannot access' for a permission the key lacks, and asks for reports", async () => {
    const cannot: Reply = { status: 400, body: { code: 918, message: "cannot access" } };
    const { fetchImpl } = zenotiAllowing(new Set(["salesReport", "guestDetails"]), { salesAccrual: cannot });
    const r = await testZenoti(connection(fetchImpl).ctx, fakeClock());
    expect(r.capabilities.salesAccrual).toBe(false);
    expect(r.path).toBe("sales_report");
    expect(r.advice.some((a) => /add read access to the sales accrual report .+ security role of the Zenoti user that app runs as may see reports/.test(a))).toBe(true);
    expect(r.advice.join(" ")).not.toMatch(/JENAI support/);

    // Met while reading, it is a missing permission too, so the sync tries another way.
    const z = fakeZenoti((req) => (endpointOf(req) === "centres" ? { status: 200, body: CENTRES } : cannot));
    const err = await new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock()).salesAccrual({ centreIds: [KONDAPUR], from: "2026-10-01", to: "2026-10-02", page: 1, size: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenotiPermissionError);
    expect(err).toMatchObject({ status: 400, what: "the sales accrual report" });
  });

  it("reads a guest Zenoti no longer has, merged or deleted, as none, and only a refused permission as a refusal", async () => {
    const z = fakeZenoti((r) => {
      if (r.path === "/v1/centers") return { status: 200, body: CENTRES };
      if (r.path.startsWith("/v1/guests/g-merged")) return { status: 400, body: {} };
      if (r.path.startsWith("/v1/guests/g-gone")) return { status: 404, body: { message: "Guest not found" } };
      if (r.path.startsWith("/v1/guests/g-odd")) return { status: 422, body: {} };
      return { status: 401, body: DENIED };
    });
    const client = new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock());
    for (const id of ["g-merged", "g-gone", "g-odd"]) {
      expect(await client.guest(id), id).toBeNull();
      expect(await client.guestPackages(id), id).toBeNull();
    }
    await expect(client.guest("g-1")).rejects.toBeInstanceOf(ZenotiPermissionError);
    await expect(client.guestPackages("g-1")).rejects.toBeInstanceOf(ZenotiPermissionError);
  });

  it("knows a centre's time zone by Zenoti's name for it, and a zone's calling code only where it names one country", () => {
    expect(zenotiTimeZone({ id: 68, name: "(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi", standard_name: "India Standard Time", symbol: "India Standard Time" })).toBe("Asia/Kolkata");
    expect(zenotiTimeZone({ standard_name: "Arabian Standard Time" })).toBe("Asia/Dubai");
    expect(zenotiTimeZone({ standard_name: "Somewhere Standard Time" })).toBeNull();
    expect(zenotiTimeZone(null)).toBeNull();
    expect(["Asia/Kolkata", "Asia/Dubai", "America/New_York", "Europe/Berlin", "Asia/Hong_Kong", null].map(phoneCodeForZone)).toEqual(["91", "971", "1", null, null, null]);
  });
});

describe("zenoti: pace and retries", () => {
  const ok: Reply = { status: 200, body: CENTRES };

  it("waits as long as a 429 asks, by Retry-After in seconds or as a date, or by RateLimit-Reset", async () => {
    for (const [headers, wait] of [
      [{ "retry-after": "3" }, 3000],
      [{ "retry-after": new Date(Date.parse("2026-10-04T06:00:20Z")).toUTCString() }, 20_000],
      [{ "ratelimit-reset": "7" }, 7000],
      [{}, 1000],
    ] as Array<[Record<string, string>, number]>) {
      let n = 0;
      const { fetchImpl, seen } = fakeZenoti(() => (n++ === 0 ? { status: 429, headers } : ok));
      const clock = fakeClock();
      const centres = await new ZenotiClient(connection(fetchImpl).ctx, clock).centres();
      expect(centres.map((c) => c.code)).toEqual(["ZNKD"]);
      expect(seen).toHaveLength(2);
      expect(clock.slept).toEqual([wait]);
    }
  });

  it("gives up on a 429 after three retries, or at once when asked to wait too long", async () => {
    let r = await testZenoti(connection(fakeZenoti(() => ({ status: 429, headers: { "retry-after": "2" } })).fetchImpl).ctx, fakeClock());
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Zenoti asked JENAI to slow down while reading the list of centres. Test again in a few minutes.");

    const { fetchImpl, seen } = fakeZenoti(() => ({ status: 429, headers: { "retry-after": "2" } }));
    const clock = fakeClock();
    await expect(new ZenotiClient(connection(fetchImpl).ctx, clock).centres()).rejects.toMatchObject({ name: "ZenotiBusyError", retryLater: true, connectionBroken: false });
    expect(seen).toHaveLength(4);
    expect(clock.slept).toEqual([2000, 2000, 2000]);

    const long = fakeZenoti(() => ({ status: 429, headers: { "retry-after": "600" } }));
    const quick = fakeClock();
    await expect(new ZenotiClient(connection(long.fetchImpl).ctx, quick).centres()).rejects.toMatchObject({ name: "ZenotiBusyError" });
    expect(long.seen).toHaveLength(1);
    expect(quick.slept).toEqual([]);
    r = await testZenoti(connection(long.fetchImpl).ctx, fakeClock());
    expect(r.ok).toBe(false);
  });

  it("slows down when Zenoti says the organisation's minute is nearly spent", async () => {
    const { fetchImpl } = fakeZenoti(() => ({ status: 200, body: CENTRES, headers: { "ratelimit-remaining": "2", "ratelimit-reset": "9" } }));
    const clock = fakeClock();
    const client = new ZenotiClient(connection(fetchImpl).ctx, clock);
    await client.centres();
    expect(clock.slept).toEqual([]);
    await client.centres();
    expect(clock.slept).toEqual([9000]);
  });

  it("makes at most 40 calls a minute by default, the client's own number up to Zenoti's 60 when set", async () => {
    for (const [config, most] of [
      [{}, 40],
      [{ rateLimitPerMinute: 3 }, 3],
      [{ rateLimitPerMinute: 500 }, 60],
      [{ rateLimitPerMinute: "nonsense" }, 40],
    ] as Array<[Record<string, unknown>, number]>) {
      const { fetchImpl } = fakeZenoti(() => ok);
      const clock = fakeClock();
      const client = new ZenotiClient(connection(fetchImpl, config).ctx, clock);
      const at: number[] = [];
      for (let i = 0; i <= most; i++) {
        await client.centres();
        at.push(clock.now());
      }
      // The first `most` go at once; the next waits until the first is a minute old.
      expect(clock.slept, JSON.stringify(config)).toEqual([60_000]);
      expect(at.at(-1)! - at[0]!).toBe(60_000);
    }
  });

  it("paces calls made at the same moment as well as one after another", async () => {
    const { fetchImpl } = fakeZenoti(() => ok);
    const clock = fakeClock();
    const client = new ZenotiClient(connection(fetchImpl, { rateLimitPerMinute: 2 }).ctx, clock);
    await Promise.all([client.centres(), client.centres(), client.centres()]);
    expect(clock.slept.filter((ms) => ms > 0).length).toBeGreaterThan(0);
    expect(clock.now()).toBeGreaterThanOrEqual(Date.parse("2026-10-04T06:01:00Z"));
  });

  it("starts no call after the time a run was given, however long Zenoti makes it wait", async () => {
    // The organisation's minute is spent every time: each call waits a minute for the refill.
    const { fetchImpl, seen } = fakeZenoti(() => ({ status: 200, body: CENTRES, headers: { "ratelimit-remaining": "0", "ratelimit-reset": "60" } }));
    const clock = fakeClock();
    const budget = { left: 100, used: 0, until: clock.now() + 3 * 60_000 };
    const client = new ZenotiClient(connection(fetchImpl).ctx, clock, budget);
    const err = await (async () => {
      for (;;) await client.centres();
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenotiTimeSpent);
    // Handled as a run out of calls: the rest is read next time, and the key is not blamed.
    expect(err).toBeInstanceOf(ZenotiBudgetSpent);
    expect(seen).toHaveLength(3);
    expect(budget.used).toBe(3);
  });

  it("retries a server error or no answer at 1, 2 and 4 seconds, then says Zenoti is unavailable", async () => {
    let n = 0;
    const flaky = fakeZenoti(() => (n++ === 0 ? { status: 502 } : ok));
    const clock = fakeClock();
    await new ZenotiClient(connection(flaky.fetchImpl).ctx, clock).centres();
    expect(clock.slept).toEqual([1000]);

    for (const reply of [{ status: 500 }, "network"] as const) {
      const down = fakeZenoti(() => reply);
      const c = fakeClock();
      const err = await new ZenotiClient(connection(down.fetchImpl).ctx, c).centres().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZenotiUnavailableError);
      expect(err).toMatchObject({ retryLater: true, connectionBroken: false });
      expect(down.seen).toHaveLength(4);
      expect(c.slept).toEqual([1000, 2000, 4000]);
    }
  });

  it("stops at the calls it was given, retries and checks counted, and says so without blaming the key", async () => {
    const flaky = fakeZenoti(() => ({ status: 503 }));
    const budget = { left: 2, used: 0 };
    const err = await new ZenotiClient(connection(flaky.fetchImpl).ctx, fakeClock(), budget).centres().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenotiBudgetSpent);
    expect(err).toMatchObject({ retryLater: true, connectionBroken: false });
    expect(flaky.seen).toHaveLength(2);
    expect(budget).toEqual({ left: 0, used: 2 });

    // A Test that runs out part way hands that back, rather than reporting the key as wrong.
    const z = zenotiAllowing(new Set(ENDPOINTS));
    const { ctx, saved } = connection(z.fetchImpl);
    await expect(testZenoti(ctx, fakeClock(), { left: 3, used: 0 })).rejects.toBeInstanceOf(ZenotiBudgetSpent);
    expect(z.seen).toHaveLength(3);
    expect(saved).toEqual([]);
    expect((await testZenoti(connection(z.fetchImpl).ctx, fakeClock(), { left: 6, used: 0 })).ok).toBe(true);
  });
});

describe("zenoti: refusals", () => {
  it("tells a missing permission from a revoked key", async () => {
    // The key opens the centres, so a refused appointment list is only that.
    let z = fakeZenoti((r) => (r.path === "/v1/centers" ? { status: 200, body: CENTRES } : { status: 401, body: DENIED }));
    let err = await new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock()).appointments(KONDAPUR, "2026-10-01", "2026-10-08").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenotiPermissionError);
    expect(err).toMatchObject({ connectionBroken: false, retryLater: false, what: "appointments", status: 401, message: "Zenoti does not let this key read appointments." });

    // Refused everywhere, the centres included: the key is the problem, and the connection is broken.
    z = fakeZenoti(() => ({ status: 401, body: DENIED }));
    const client = new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock());
    err = await client.appointments(KONDAPUR, "2026-10-01", "2026-10-08").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenotiKeyError);
    expect(err).toMatchObject({ connectionBroken: true });
    const nobody = "/v1/guests/00000000-0000-0000-0000-000000000000";
    expect(z.seen.map((s) => s.path)).toEqual(["/v1/appointments", "/v1/centers", nobody]);
    // The key is checked once per client, not once per refusal.
    await client.salesReport(KONDAPUR, "2026-10-01", "2026-10-07").catch(() => null);
    expect(z.seen.map((s) => s.path)).toEqual(["/v1/appointments", "/v1/centers", nobody, "/v1/sales/salesreport"]);

    z = fakeZenoti(() => ({ status: 401, body: DENIED }));
    await expect(new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock()).centres()).rejects.toBeInstanceOf(ZenotiKeyError);
  });

  it("refuses a date span Zenoti would refuse, before asking", async () => {
    const z = fakeZenoti(() => ({ status: 200, body: [] }));
    const client = new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock());
    await expect(client.appointments(KONDAPUR, "2026-10-01", "2026-10-09")).rejects.toThrow(/at most|from 1 to 7/);
    await expect(client.appointments(KONDAPUR, "2026-10-01", "2026-10-01")).rejects.toThrow(/from 1 to 7/);
    await expect(client.salesReport(KONDAPUR, "2026-10-01", "2026-10-08")).rejects.toThrow(/from 0 to 6/);
    await expect(client.salesAccrual({ centreIds: [KONDAPUR], from: "2025-10-01", to: "2026-10-01", page: 1, size: 100 })).rejects.toThrow(/from 0 to 364/);
    expect(z.seen).toHaveLength(0);
  });
});

describe("zenoti: reads", () => {
  it("reads appointments, guests, packages and both reports in the shapes Zenoti documents", async () => {
    const z = fakeZenoti((r) => {
      if (r.path === "/v1/appointments") return { status: 200, body: [{ appointment_id: "a-1" }] };
      if (r.path === "/v1/guests/g-1") return { status: 200, body: { id: "g-1" } };
      if (r.path === "/v1/guests/g-gone") return { status: 404 };
      if (r.path === "/v1/guests/g-1/Packages") return { status: 200, body: [{ user_package_id: "up-1" }] };
      if (r.path === "/v1/reports/sales/accrual_basis/flat_file") return { status: 200, body: { sales: [{ invoice_id: "i-1" }], page_info: { total: 31, page: 2, size: 1 } } };
      if (r.path === "/v1/sales/salesreport") return { status: 200, body: { center_sales_report: [{ invoice_item_id: "ii-1" }], Error: null } };
      if (r.path === "/v1/countries") return { status: 200, body: { countries: [{ id: 95, phone_code: "91" }, { id: 77, phone_code: "+44" }] } };
      return { status: 404 };
    });
    const client = new ZenotiClient(connection(z.fetchImpl).ctx, fakeClock());
    expect(await client.appointments(KONDAPUR, "2026-10-01", "2026-10-08")).toEqual([{ appointment_id: "a-1" }]);
    expect(await client.guest("g-1")).toEqual({ id: "g-1" });
    expect(await client.guest("g-1")).toEqual({ id: "g-1" });
    expect(await client.guest("g-gone")).toBeNull();
    expect(z.seen.filter((s) => s.path === "/v1/guests/g-1")).toHaveLength(1);
    expect(await client.guestPackages("g-1", KONDAPUR)).toEqual([{ user_package_id: "up-1" }]);
    expect(await client.salesAccrual({ centreIds: [KONDAPUR], from: "2026-09-01", to: "2026-09-30", page: 2, size: 1 })).toEqual({ rows: [{ invoice_id: "i-1" }], total: 31 });
    expect(await client.salesReport(KONDAPUR, "2026-09-24", "2026-09-30")).toEqual([{ invoice_item_id: "ii-1" }]);
    expect(await client.phoneCodes()).toEqual({ "95": "91", "225": "1", "77": "44" });
    expect(z.seen.every((s) => s.method === "GET" || s.path === "/v1/reports/sales/accrual_basis/flat_file")).toBe(true);
  });
});

describe("zenoti: mappers", () => {
  it("reads appointment statuses as Zenoti documents them, and anything else as unknown", () => {
    expect([-2, -1, 0, 1, 2, 4].map(zenotiAppointmentStatus)).toEqual(["no_show", "cancelled", "booked", "completed", "checked_in", "confirmed"]);
    expect(["NoShow", "Cancelled", "New", "Closed", "Checkin", "Confirm"].map(zenotiAppointmentStatus)).toEqual(["no_show", "cancelled", "booked", "completed", "checked_in", "confirmed"]);
    for (const odd of [10, 11, 20, 21, 3, 99, "Break", "Voided", "toString", null, undefined, {}]) expect(zenotiAppointmentStatus(odd)).toBe("unknown");
  });

  const appointment = {
    appointment_id: "a-1",
    invoice_id: "i-1",
    guest: { id: "g-1", first_name: "Test", last_name: "Guest", mobile: { country_id: 95, number: "9876543210", display_number: "+91 98765 43210" }, email: "guest@example.com" },
    service: { id: "s-1", name: "Laser Hair Reduction Full Legs", category: { name: "Laser" }, sub_category: { name: "Hair Reduction" } },
    therapist: { id: "t-1", first_name: "Asha", last_name: "Rao", display_name: "Dr. Asha" },
    // Half past midnight in Kondapur is still the evening before in UTC.
    start_time: "2026-10-01T00:30:00",
    start_time_utc: "2026-09-30T19:00:00",
    status: 1,
    progress: 0,
    source: 0,
    notes: "private note from the front desk",
  };

  it("turns an appointment into a clinic_appointments row, the time read as UTC and the rest of it left behind", () => {
    const row = zenotiAppointmentRow(appointment, { centreRef: KONDAPUR });
    expect(row).toEqual({
      externalId: "a-1",
      guestRef: "g-1",
      phoneE164: "+919876543210",
      name: "Test Guest",
      service: "Laser Hair Reduction Full Legs",
      category: "Laser / Hair Reduction",
      startsAt: new Date("2026-09-30T19:00:00Z"),
      // The day Zenoti lists it under: the centre's, though it is still the day before in UTC.
      localDay: "2026-10-01",
      status: "completed",
      doctor: "Dr. Asha",
      centreRef: KONDAPUR,
    });
    expect(JSON.stringify(row)).not.toMatch(/private note|example\.com/);
    // Only centre time: read in the centre's zone.
    expect(zenotiAppointmentRow({ ...appointment, start_time_utc: null }, { timeZone: "Asia/Kolkata" })?.startsAt).toEqual(new Date("2026-09-30T19:00:00Z"));
    expect(zenotiAppointmentRow({ ...appointment, start_time_utc: null }, { timeZone: "America/New_York" })?.startsAt).toEqual(new Date("2026-10-01T04:30:00Z"));
    expect(zenotiAppointmentRow({ ...appointment, start_time_utc: "2026-09-30T19:00:00Z" })?.startsAt).toEqual(new Date("2026-09-30T19:00:00Z"));
    expect(zenotiAppointmentRow({ ...appointment, therapist: { first_name: "Asha", last_name: "Rao", display_name: null } })?.doctor).toBe("Asha Rao");
    expect(zenotiAppointmentRow({ ...appointment, therapist: null })?.doctor).toBeNull();
    expect(zenotiAppointmentRow({ ...appointment, status: 21 })?.status).toBe("unknown");
    // A break or a blocked slot has no guest.
    expect(zenotiAppointmentRow({ ...appointment, guest: null, status: 10 })).toBeNull();
    expect(zenotiAppointmentRow({ ...appointment, start_time: null, start_time_utc: null })).toBeNull();
  });

  it("makes a visit only of a completed appointment, on its day in centre time", () => {
    expect(zenotiAppointmentVisit(appointment, { centreRef: KONDAPUR })).toEqual({
      externalId: "a-1",
      guestRef: "g-1",
      phoneE164: "+919876543210",
      name: "Test Guest",
      service: "Laser Hair Reduction Full Legs",
      category: "Laser / Hair Reduction",
      categories: ["Laser", "Hair Reduction"],
      visitDate: "2026-10-01",
      listedOn: "2026-10-01",
      doctor: "Dr. Asha",
      centreRef: KONDAPUR,
      packageName: null,
      sessionsTotal: null,
    });
    // Only UTC given: the day is the centre's.
    expect(zenotiAppointmentVisit({ ...appointment, start_time: null }, { timeZone: "Asia/Kolkata" })?.visitDate).toBe("2026-10-01");
    for (const status of [-2, -1, 0, 2, 4, 21, 99]) expect(zenotiAppointmentVisit({ ...appointment, status })).toBeNull();
  });

  const reportLine = {
    invoice_no: "ZNKD-1001",
    invoice_item_id: "ii-1",
    guest: { guest_id: "g-2", guest_name: "Test Guest", guest_code: "ZN001" },
    sold_on: "2026-09-30T18:57:04",
    serviced_on: "2026-09-30T14:45:00",
    center: { center_name: "Kondapur", center_code: "ZNKD" },
    item: { type: 0, name: "LHR Full Legs", code: "LHR-FL" },
    quantity: 1,
    unit_price: 0,
    sale_price: 0,
    final_sale_price: 0,
    package_redemption: 1,
    employee: { name: "Dr. Asha", code: "E1", job_code: "TH" },
    tags: "private",
    promotion: "Package: LHR 5 Body Parts 5 Sessions",
    first_visit: "No",
    package: "LHR 5 Body Parts 5 Sessions",
    payment_type: "Package",
  };

  it("turns a line of the older sales report into a visit waiting for its phone", () => {
    expect(zenotiSalesReportVisit(reportLine, { centreRef: KONDAPUR })).toEqual({
      externalId: "ii-1",
      guestRef: "g-2",
      phoneE164: null,
      name: "Test Guest",
      service: "LHR Full Legs",
      category: null,
      categories: [],
      visitDate: "2026-09-30",
      listedOn: "2026-09-30",
      doctor: "Dr. Asha",
      centreRef: KONDAPUR,
      packageName: "LHR 5 Body Parts 5 Sessions",
      sessionsTotal: 5,
    });
    expect(zenotiSalesReportVisit({ ...reportLine, serviced_on: null })?.visitDate).toBe("2026-09-30");
    // Invoiced the day after the service: done on its day, listed under the sale's.
    expect(zenotiSalesReportVisit({ ...reportLine, sold_on: "2026-10-01T10:15:00" })).toMatchObject({ visitDate: "2026-09-30", listedOn: "2026-10-01" });
    expect(zenotiSalesReportVisit({ ...reportLine, item: { ...reportLine.item, type: 2 } })).toBeNull();
    expect(zenotiSalesReportVisit({ ...reportLine, quantity: -1 })).toBeNull();
    expect(zenotiSalesReportVisit({ ...reportLine, invoice_item_id: null })).toBeNull();
  });

  const accrualLine = {
    sale_date: "2026-09-30T00:00:00",
    invoice_id: "inv-1",
    invoice_no: "R1",
    guest_id: "g-3",
    guest_name: "Test Guest",
    center_id: KONDAPUR,
    item_id: "item-1",
    item_name: "Hydrafacial",
    item_type: "Service",
    qty: 1,
    item_category: "Facials",
    item_sub_category: "Facials",
    provider: "Dr. Asha",
    status: "Closed",
    invoice_notes: "private",
  };

  it("turns a closed service line of the accrual report into a visit", () => {
    expect(zenotiSalesAccrualVisit(accrualLine)).toEqual({
      externalId: "inv-1:item-1",
      guestRef: "g-3",
      phoneE164: null,
      name: "Test Guest",
      service: "Hydrafacial",
      category: "Facials",
      categories: ["Facials"],
      visitDate: "2026-09-30",
      listedOn: "2026-09-30",
      doctor: "Dr. Asha",
      centreRef: KONDAPUR,
      packageName: null,
      sessionsTotal: null,
    });
    expect(zenotiSalesAccrualVisit({ ...accrualLine, status: "Open" })).toBeNull();
    expect(zenotiSalesAccrualVisit({ ...accrualLine, item_type: "Product" })).toBeNull();
    expect(zenotiSalesAccrualVisit({ ...accrualLine, qty: 0 })).toBeNull();
    expect(JSON.stringify(zenotiSalesAccrualVisit(accrualLine))).not.toMatch(/private/);
  });

  it("reads the sessions a package's name promises", () => {
    expect(packageSessions("LHR 5 Body Parts 5 Sessions")).toBe(5);
    expect(packageSessions("6 sittings")).toBe(6);
    expect(packageSessions("Hydrafacial 1 Session")).toBe(1);
    expect(packageSessions("PRP 4sittings + 1 free")).toBe(4);
    expect(packageSessions("LHR 5 Body Parts")).toBeNull();
    expect(packageSessions("Pack of 6")).toBeNull();
    expect(packageSessions("0 sessions")).toBeNull();
    expect(packageSessions(null)).toBeNull();
  });

  it("writes a Zenoti mobile as E.164, by its country id and never by a guess", () => {
    expect(zenotiPhone({ country_id: 0, number: null, display_number: "+91 98765 43210" })).toBe("+919876543210");
    expect(zenotiPhone({ country_code: 95, number: "9876543210" })).toBe("+919876543210");
    expect(zenotiPhone({ country_code: 95, number: "09876543210" })).toBe("+919876543210");
    expect(zenotiPhone({ country_code: 225, number: "2025550123" })).toBe("+12025550123");
    expect(zenotiPhone({ country_code: 95, number: "+44 7700 900123" })).toBe("+447700900123");
    // No country: the default the caller gives (the connection's, the centre's country, the client's), never a guess.
    expect(zenotiPhone({ country_code: 0, number: "9876543210" })).toBeNull();
    expect(zenotiPhone({ country_code: 0, number: "9876543210" }, { defaultCountryCode: "91" })).toBe("+919876543210");
    expect(zenotiPhone({ number: "2125551234" }, { defaultCountryCode: "1" })).toBe("+12125551234");
    expect(zenotiPhone({ number: "0501234567" }, { defaultCountryCode: "971" })).toBe("+971501234567");
    // retrieve-guest-details writes phone_code 0 for none: not a country code.
    expect(zenotiPhone({ country_code: 0, phone_code: 0, number: "9876543210" })).toBeNull();
    expect(zenotiPhone({ country_code: 0, phone_code: 0, number: "9876543210" }, { defaultCountryCode: "91" })).toBe("+919876543210");
    expect(zenotiPhone({ country_code: 0, phone_code: 971, number: "501234567" })).toBe("+971501234567");
    expect(zenotiPhone({ number: "9876543210" }, { defaultCountryCode: "0" })).toBeNull();
    expect(zenotiPhone({ number: "971501234567" }, { defaultCountryCode: "971" })).toBe("+971501234567");
    // A country we cannot place: no number, unless Zenoti's country list names it.
    expect(zenotiPhone({ country_code: 999, number: "7700900123" })).toBeNull();
    expect(zenotiPhone({ country_code: 999, number: "7700900123" }, { phoneCodes: { "999": "44" } })).toBe("+447700900123");
    expect(zenotiPhone(null)).toBeNull();
    expect(zenotiPhone({ number: "" })).toBeNull();
  });

  it("keeps of a guest's profile only the number, the name and the two SMS consents", () => {
    const guest = {
      id: "g-1",
      code: "ZN001",
      personal_info: { first_name: "Test", last_name: "Guest", email: "guest@example.com", date_of_birth: "1990-01-01", mobile_phone: { country_code: 95, number: "9876543210" } },
      address_info: { city: "Hyderabad" },
      preferences: { receive_marketing_sms: false, receive_transactional_sms: true, marketing_sms_optin: 1, transactional_sms_optin: 0 },
    };
    const row = zenotiPerson(guest);
    expect(row).toEqual({ externalId: "g-1", phoneE164: "+919876543210", name: "Test Guest", marketingSmsConsent: false, transactionalSmsConsent: true });
    // Only the opt-in numbers: 1 is a yes, anything else is not.
    const optIn = (marketing: unknown, transactional: unknown) => zenotiPerson({ id: "g-1", preferences: { marketing_sms_optin: marketing, transactional_sms_optin: transactional } });
    expect(optIn(1, 0)).toMatchObject({ marketingSmsConsent: true, transactionalSmsConsent: false });
    expect(optIn(2, 1)).toMatchObject({ marketingSmsConsent: false, transactionalSmsConsent: true });
    // Nothing said: empty, not a no.
    expect(zenotiPerson({ id: "g-1" })).toEqual({ externalId: "g-1", phoneE164: null, name: null, marketingSmsConsent: null, transactionalSmsConsent: null });
    expect(zenotiPerson({ personal_info: { first_name: "Test" } })).toBeNull();
  });

  it("reads package statuses as Zenoti documents them", () => {
    expect([1, 3, 5, 6, 7].map(zenotiPackageStatus)).toEqual(["active", "frozen", "expired", "cancelled", "not_started"]);
    for (const odd of [8, -1, 0, 2, "Unknown", null]) expect(zenotiPackageStatus(odd)).toBe("unknown");
  });

  it("turns a guest's packages into balances per service, the purchase in use speaking for one bought twice", () => {
    const packages = [
      { user_package_id: "up-old", status: 5, package: { id: "p-1", name: "LHR 5 Body Parts 5 Sessions" }, date: { end: "2026-03-01T00:00:00" }, services: [{ id: "s-1", name: "LHR Full Legs", total: 5, used: 5, balance: 0 }] },
      {
        user_package_id: "up-new",
        status: 1,
        package: { id: "p-1", name: "LHR 5 Body Parts 5 Sessions" },
        date: { start: "2026-04-01T10:00:00", end: "2027-03-01T00:00:00" },
        services: [
          { id: "s-1", name: "LHR Full Legs", total: 5, used: 2, balance: 3 },
          { id: "s-2", name: "LHR Underarms", total: 5, used: 2, balance: 3 },
        ],
        products: [{ product_type_info: { name: "Sunscreen" }, total: 1, used: 0, balance: 1 }],
      },
      { user_package_id: "up-x", status: 8, package: { name: "Hydrafacial 6 sittings" }, date: { end: null }, services: [{ name: "Hydrafacial", total: 6, used: 1, balance: 5 }] },
    ];
    const rows = zenotiPackageBalances("g-1", packages);
    expect(rows).toEqual([
      { guestRef: "g-1", packageRef: "up-new", packageName: "LHR 5 Body Parts 5 Sessions", service: "LHR Full Legs", covers: "service", total: 5, used: 2, balance: 3, status: "active", expiresOn: "2027-03-01" },
      { guestRef: "g-1", packageRef: "up-new", packageName: "LHR 5 Body Parts 5 Sessions", service: "LHR Underarms", covers: "service", total: 5, used: 2, balance: 3, status: "active", expiresOn: "2027-03-01" },
      { guestRef: "g-1", packageRef: "up-x", packageName: "Hydrafacial 6 sittings", service: "Hydrafacial", covers: "service", total: 6, used: 1, balance: 5, status: "unknown", expiresOn: null },
    ]);
    // The same whichever order Zenoti lists them in.
    expect(zenotiPackageBalances("g-1", [...packages].reverse()).find((r) => r.service === "LHR Full Legs")?.packageRef).toBe("up-new");
    // Wrapped under a key, as some answers are.
    expect(zenotiPackageBalances("g-1", { packages })).toHaveLength(3);
    // As list-the-series-packages-of-a-guest documents it: the service's name under service_type_info.
    const documented = {
      user_package_id: "c3122758",
      status: 1,
      package: { type: 0, id: "f784690e", name: "Luxury Series Package" },
      date: { end_date_with_grace: "2020-05-14T00:00:00", start: "2020-02-03T21:43:42", end: "2020-04-29T00:00:00" },
      products: [{ product_type_info: { product_category_type: 1, name: "Mask", id: "29893bd5" }, total: 4, used: 1, balance: 3 }],
      services: [{ service_type_info: { service_category_type: 1, id: "21077983", name: "Feet Massage", duration: 0 }, exists_in_current_center: true, total: 1, used: 0, balance: 1, balance_amount: 205.25 }],
    };
    // Its line is a Category (service_category_type 1), and its sessions can be taken until the grace period ends.
    expect(zenotiPackageBalances("g-2", [documented])).toEqual([
      { guestRef: "g-2", packageRef: "c3122758", packageName: "Luxury Series Package", service: "Feet Massage", covers: "category", total: 1, used: 0, balance: 1, status: "active", expiresOn: "2020-05-14" },
    ]);
    const line = (service_category_type: number) => zenotiPackageBalances("g-2", [{ ...documented, services: [{ ...documented.services[0], service_type_info: { service_category_type, name: "Feet Massage" } }] }])[0]!.covers;
    expect([-1, 1, 2, 3].map(line)).toEqual(["service", "category", "service", "tag"]);
    expect(zenotiPackageBalances("g-2", [{ ...documented, date: { end: "2020-04-29T00:00:00" } }])[0]!.expiresOn).toBe("2020-04-29");
    expect(zenotiPackageBalances("g-1", null)).toEqual([]);
  });

  it("keeps a series bought again over the used-up one, whatever their statuses", () => {
    const lhr = (id: string, status: number, used: number, balance: number, end: string) => ({
      user_package_id: id,
      status,
      package: { name: "LHR 5 Body Parts 5 Sessions" },
      date: { end },
      services: [{ service_type_info: { service_category_type: 2, name: "LHR Full Legs" }, total: 5, used, balance }],
    });
    // Zenoti has no "completed": the used-up one stays Active beside the one bought again at checkout, not started yet.
    const usedUp = lhr("up-old", 1, 5, 0, "2027-01-01T00:00:00");
    const again = lhr("up-again", 7, 0, 5, "2027-06-01T00:00:00");
    for (const order of [[usedUp, again], [again, usedUp]]) expect(zenotiPackageBalances("g-1", order).map((r) => [r.packageRef, r.status, r.balance])).toEqual([["up-again", "not_started", 5]]);
    // Two being used: the one in use speaks, as before.
    expect(zenotiPackageBalances("g-1", [lhr("a", 7, 0, 5, "2027-06-01T00:00:00"), lhr("b", 1, 2, 3, "2027-01-01T00:00:00")])[0]!.packageRef).toBe("b");
    // A service and a category of the same name in one package: the service.
    const both = { ...again, services: [{ service_type_info: { service_category_type: 1, name: "LHR Full Legs" }, total: 9, used: 0, balance: 9 }, ...again.services] };
    expect(zenotiPackageBalances("g-1", [both]).map((r) => [r.covers, r.total])).toEqual([["service", 5]]);
  });
});
