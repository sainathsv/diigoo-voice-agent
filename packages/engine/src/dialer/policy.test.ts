import { describe, expect, it } from "vitest";
import { decide, nextAttempt, type PolicyInput } from "./policy";
import { inWindow, localParts, nextWindowStart, zoned } from "./time";

const TZ = "Asia/Kolkata";
// Thursday 17 Sep 2026, 11:00 IST
const THU_11 = zoned(2026, 9, 17, 11 * 60, TZ);
const W = { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" };

const base = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  now: THU_11,
  campaign: { status: "running", purpose: "service", windows: W, timezone: TZ, maxAttempts: 3, dailyCapPerContact: 2, consentAttested: false },
  target: { attemptNo: 0 },
  number: { status: "active", series: "landline", purpose: "outbound_service", a2pDeclaredAt: new Date("2026-09-18") },
  suppressions: [],
  consents: [{ purpose: "service", status: "granted", expiresAt: null }],
  hasRelationship: false,
  attemptsToday: 0,
  plan: { outboundToday: 0, outboundPerDay: null, endsOn: null, name: "Growth" },
  ...over,
});

describe("time helpers", () => {
  it("reads local IST wall-clock time", () => {
    expect(localParts(THU_11, TZ)).toMatchObject({ dow: 4, minutes: 660 });
  });
  it("respects the 10-minute end guard and the hard 09:00-21:00 limit", () => {
    expect(inWindow(zoned(2026, 9, 17, 18 * 60 + 55, TZ), W, TZ)).toBe(false);
    const late = { days: [0, 1, 2, 3, 4, 5, 6], start: "07:00", end: "23:00" };
    expect(inWindow(zoned(2026, 9, 17, 8 * 60, TZ), late, TZ)).toBe(false);
    expect(inWindow(zoned(2026, 9, 17, 21 * 60 + 30, TZ), late, TZ)).toBe(false);
  });
  it("finds the next window start, skipping Sunday", () => {
    const satNight = zoned(2026, 9, 19, 20 * 60, TZ);
    expect(nextWindowStart(satNight, W, TZ).toISOString()).toBe(zoned(2026, 9, 21, 10 * 60, TZ).toISOString());
  });
});

describe("decide(): the compliance gate", () => {
  it("dials when every check passes", () => {
    expect(decide(base()).action).toBe("dial");
  });
  it("never dials someone who opted out, for any purpose", () => {
    const d = decide(base({ suppressions: [{ reason: "opt_out", scope: null, expiresAt: null }] }));
    expect(d).toMatchObject({ action: "skip", code: "opted_out" });
  });
  it("applies the DND registry to promotional calls only", () => {
    const dnd = [{ reason: "dnd_registry" as const, scope: null, expiresAt: null }];
    expect(decide(base({ suppressions: dnd })).action).toBe("dial");
    const promo = base({
      suppressions: dnd,
      campaign: { ...base().campaign, purpose: "promotional" },
      number: { ...base().number, series: "series_140", purpose: "outbound_promotional" },
      consents: [{ purpose: "promotional", status: "granted", expiresAt: null }],
    });
    expect(decide(promo)).toMatchObject({ action: "skip", code: "dnd_registry" });
  });
  it("refuses a caller ID that is not declared for AI calls", () => {
    expect(decide(base({ number: { ...base().number, a2pDeclaredAt: null } }))).toMatchObject({ action: "skip", code: "caller_id_not_declared" });
  });
  it("requires 140-series for promotional and forbids it for service calls", () => {
    const promoFromLandline = base({
      campaign: { ...base().campaign, purpose: "promotional" },
      number: { ...base().number, purpose: "both" },
      consents: [{ purpose: "promotional", status: "granted", expiresAt: null }],
    });
    expect(decide(promoFromLandline)).toMatchObject({ action: "skip", code: "wrong_series" });
    expect(decide(base({ number: { ...base().number, series: "series_140", purpose: "both" } }))).toMatchObject({ action: "skip", code: "wrong_series" });
  });
  it("requires explicit promotional consent; expired or revoked consent does not count", () => {
    const promo = (consents: PolicyInput["consents"]) =>
      decide(base({ campaign: { ...base().campaign, purpose: "promotional" }, number: { ...base().number, series: "series_140", purpose: "outbound_promotional" }, consents, hasRelationship: true }));
    expect(promo([])).toMatchObject({ action: "skip", code: "no_consent" });
    expect(promo([{ purpose: "promotional", status: "granted", expiresAt: new Date("2026-09-10") }])).toMatchObject({ code: "no_consent" });
    expect(promo([{ purpose: "promotional", status: "revoked", expiresAt: null }])).toMatchObject({ code: "no_consent" });
    expect(promo([{ purpose: "promotional", status: "granted", expiresAt: null }]).action).toBe("dial");
  });
  it("allows service calls on consent, an existing relationship, or the client's attestation", () => {
    expect(decide(base({ consents: [] }))).toMatchObject({ action: "skip", code: "no_consent" });
    expect(decide(base({ consents: [], hasRelationship: true })).action).toBe("dial");
    expect(decide(base({ consents: [], campaign: { ...base().campaign, consentAttested: true } })).action).toBe("dial");
  });
  it("waits for calling hours instead of dialing at night", () => {
    const night = zoned(2026, 9, 17, 22 * 60, TZ);
    const d = decide(base({ now: night }));
    expect(d.action).toBe("defer");
    if (d.action === "defer") expect(d.until.toISOString()).toBe(zoned(2026, 9, 18, 10 * 60, TZ).toISOString());
  });
  it("caps calls per person per day across campaigns", () => {
    const d = decide(base({ attemptsToday: 2 }));
    expect(d.action).toBe("defer");
  });
  it("stops after the maximum attempts", () => {
    expect(decide(base({ target: { attemptNo: 3 } }))).toMatchObject({ action: "skip", code: "max_attempts" });
  });
  it("checks permanent reasons before waiting reasons", () => {
    const night = zoned(2026, 9, 17, 23 * 60, TZ);
    expect(decide(base({ now: night, suppressions: [{ reason: "opt_out", scope: null, expiresAt: null }] }))).toMatchObject({ action: "skip" });
  });
});

describe("nextAttempt()", () => {
  it("backs off no-answers and keeps retries inside calling hours", () => {
    const first = nextAttempt("no_answer", 1, THU_11, W, TZ)!;
    expect(first.getTime() - THU_11.getTime()).toBe(120 * 60_000);
    const evening = zoned(2026, 9, 17, 18 * 60, TZ);
    expect(nextAttempt("no_answer", 1, evening, W, TZ)!.toISOString()).toBe(zoned(2026, 9, 18, 10 * 60, TZ).toISOString());
  });
  it("finishes on an answered call or an opt-out", () => {
    expect(nextAttempt("answered", 1, THU_11, W, TZ)).toBeNull();
    expect(nextAttempt("opt_out", 1, THU_11, W, TZ)).toBeNull();
  });
  it("honours a requested callback time", () => {
    const at = zoned(2026, 9, 18, 16 * 60, TZ);
    expect(nextAttempt("callback", 1, THU_11, W, TZ, at)!.toISOString()).toBe(at.toISOString());
  });
});

describe("what the plan allows", () => {
  const demo = (over: Partial<PolicyInput["plan"]> = {}) =>
    base({ plan: { outboundToday: 0, outboundPerDay: 30, endsOn: "2026-10-17", name: "Demo", ...over } });

  it("dials while the day's allowance is unspent", () => {
    expect(decide(demo({ outboundToday: 29 })).action).toBe("dial");
  });

  it("stops at the allowance and waits for the next Indian day, not the next UTC one", () => {
    const d = decide(demo({ outboundToday: 30 }));
    expect(d.action).toBe("defer");
    if (d.action !== "defer") throw new Error("expected a defer");
    expect(d.reason).toContain("30 outbound calls a day");
    // 11:00 IST on the 17th, so the allowance comes back at midnight IST on the 18th.
    expect(d.until.toISOString()).toBe(zoned(2026, 9, 18, 0, TZ).toISOString());
  });

  it("keeps refusing once past the allowance, however far past", () => {
    expect(decide(demo({ outboundToday: 400 })).action).toBe("defer");
  });

  it("stops entirely the day after the plan ends", () => {
    const d = decide(demo({ endsOn: "2026-09-16" }));
    expect(d.action).toBe("skip");
    if (d.action !== "skip") throw new Error("expected a skip");
    expect(d.code).toBe("plan_expired");
  });

  it("still runs on the last day of the plan", () => {
    expect(decide(demo({ endsOn: "2026-09-17" })).action).toBe("dial");
  });

  it("checks the workspace before the contact, so being out of plan burns no attempt", () => {
    // Everything about this contact is also wrong; the plan must answer first,
    // otherwise the caller records an attempt against someone we never called.
    const d = decide(base({
      plan: { outboundToday: 30, outboundPerDay: 30, endsOn: null, name: "Demo" },
      target: { attemptNo: 99 },
      suppressions: [{ reason: "opt_out", scope: null, expiresAt: null }],
    }));
    expect(d.action).toBe("defer");
  });

  it("does not cap a plan that has no daily allowance", () => {
    expect(decide(base({ plan: { outboundToday: 9999, outboundPerDay: null, endsOn: null, name: "Growth" } })).action).toBe("dial");
  });
});
