/**
 * The compliance gate every outbound attempt passes (Blueprint Part 5).
 * Pure: no I/O, so every rule is unit-tested. Order matters: permanent
 * reasons to skip are checked before reasons to wait.
 */
import { inWindow, nextDayWindowStart, nextWindowStart, type Windows } from "./time";
import { istDay, startOfNextIstDay } from "./time-ist";

export type Purpose = "service" | "transactional" | "promotional";
export type Series = "landline" | "mobile" | "series_140" | "series_1600" | "toll_free";
export type NumberPurpose = "inbound" | "outbound_service" | "outbound_promotional" | "both";

export interface PolicyInput {
  now: Date;
  campaign: {
    status: string;
    purpose: Purpose;
    windows: Windows;
    timezone: string;
    maxAttempts: number;
    dailyCapPerContact: number;
    consentAttested: boolean;
  };
  target: { attemptNo: number };
  number: { status: string; series: Series; purpose: NumberPurpose; a2pDeclaredAt: Date | null };
  /** Active suppression entries for this phone (client list plus platform-wide DND). */
  suppressions: Array<{ reason: "opt_out" | "dnd_registry" | "complaint" | "legal" | "wrong_number"; scope: Purpose | null; expiresAt: Date | null }>;
  consents: Array<{ purpose: Purpose; status: "granted" | "revoked"; expiresAt: Date | null }>;
  /** The person has dealt with this client before (called in, booked, visited). */
  hasRelationship: boolean;
  /** Dial decisions for this phone in this client today (all campaigns). */
  attemptsToday: number;
  /**
   * The workspace's own allowance, not this contact's. A plan may cap how many
   * calls a client may place in a day, and a demo or trial ends on a date.
   * Both are checked here so every outbound path is covered by one rule:
   * the campaign dialer and a call their own CRM asks for go through this.
   */
  plan: {
    /** Outbound calls already placed by this client today (IST). */
    outboundToday: number;
    /** The plan's daily allowance, or null when the plan does not cap it. */
    outboundPerDay: number | null;
    /** The last day the subscription covers (yyyy-mm-dd, IST), or null when open-ended. */
    endsOn: string | null;
    name: string;
  };
}

export type SkipCode =
  | "plan_expired"
  | "daily_cap"
  | "max_attempts"
  | "opted_out"
  | "dnd_registry"
  | "caller_id_not_declared"
  | "caller_id_inactive"
  | "wrong_series"
  | "number_not_outbound"
  | "no_consent";

export type Decision =
  | { action: "dial"; reason: string }
  | { action: "defer"; until: Date; reason: string }
  | { action: "skip"; code: SkipCode; reason: string };

const live = (expiresAt: Date | null, now: Date) => !expiresAt || expiresAt.getTime() > now.getTime();



export function decide(i: PolicyInput): Decision {
  const { now, campaign: c } = i;

  // The workspace's allowance is checked before anything about this contact:
  // being out of plan is not the contact's fault and must not burn an attempt.
  if (i.plan.endsOn && istDay(now) > i.plan.endsOn) {
    return { action: "skip", code: "plan_expired", reason: `The ${i.plan.name} plan ended on ${i.plan.endsOn}. Calls resume when a plan is in place.` };
  }
  if (i.plan.outboundPerDay !== null && i.plan.outboundToday >= i.plan.outboundPerDay) {
    return {
      action: "defer",
      until: startOfNextIstDay(now),
      reason: `The ${i.plan.name} plan allows ${i.plan.outboundPerDay} outbound calls a day, and ${i.plan.outboundToday} have been placed today.`,
    };
  }

  if (c.status !== "running") return { action: "defer", until: new Date(now.getTime() + 5 * 60_000), reason: "Campaign is not running" };

  if (i.target.attemptNo >= c.maxAttempts) return { action: "skip", code: "max_attempts", reason: `Reached ${c.maxAttempts} attempts` };

  for (const s of i.suppressions) {
    if (!live(s.expiresAt, now)) continue;
    if (s.reason === "dnd_registry") {
      if (c.purpose === "promotional") return { action: "skip", code: "dnd_registry", reason: "Number is on the DND (NCPR) registry; promotional calls are not allowed" };
      continue;
    }
    if (s.scope === null || s.scope === c.purpose) return { action: "skip", code: "opted_out", reason: `Do-not-call: ${s.reason.replace("_", " ")}` };
  }

  const n = i.number;
  if (n.status !== "active") return { action: "skip", code: "caller_id_inactive", reason: "Caller ID number is not active" };
  if (!n.a2pDeclaredAt) return { action: "skip", code: "caller_id_not_declared", reason: "Caller ID is not declared to the operator for AI calls (TRAI, 18 Sep 2026)" };
  const outbound = c.purpose === "promotional" ? ["outbound_promotional", "both"] : ["outbound_service", "both"];
  if (!outbound.includes(n.purpose)) return { action: "skip", code: "number_not_outbound", reason: `Caller ID is not set up for ${c.purpose} calls` };
  if (c.purpose === "promotional" && n.series !== "series_140") return { action: "skip", code: "wrong_series", reason: "Promotional calls must come from a 140-series number" };
  if (c.purpose !== "promotional" && n.series === "series_140") return { action: "skip", code: "wrong_series", reason: "140-series numbers are for promotional calls only" };

  const valid = i.consents.filter((x) => x.status === "granted" && live(x.expiresAt, now));
  if (c.purpose === "promotional") {
    if (!valid.some((x) => x.purpose === "promotional")) return { action: "skip", code: "no_consent", reason: "No recorded consent for promotional calls" };
  } else if (!valid.length && !i.hasRelationship && !c.consentAttested) {
    return { action: "skip", code: "no_consent", reason: "No consent or existing relationship on record" };
  }

  if (!inWindow(now, c.windows, c.timezone)) {
    return { action: "defer", until: nextWindowStart(now, c.windows, c.timezone), reason: "Outside calling hours" };
  }
  if (i.attemptsToday >= c.dailyCapPerContact) {
    return { action: "defer", until: nextDayWindowStart(now, c.windows, c.timezone), reason: `Already called ${i.attemptsToday} time(s) today` };
  }
  return { action: "dial", reason: "All checks passed" };
}

export type Outcome = "answered" | "no_answer" | "busy" | "unreachable" | "voicemail" | "failed" | "opt_out" | "callback";

/** When to try again after an outcome, or null when the target is finished. */
export function nextAttempt(outcome: Outcome, attemptNo: number, now: Date, w: Windows, tz: string, callbackAt?: Date | null): Date | null {
  const inMin = (m: number) => new Date(now.getTime() + m * 60_000);
  let at: Date;
  switch (outcome) {
    case "answered":
    case "opt_out":
      return null;
    case "callback":
      at = callbackAt && callbackAt > now ? callbackAt : inMin(120);
      break;
    case "busy":
      at = inMin(20);
      break;
    case "unreachable":
      at = inMin(180);
      break;
    case "voicemail":
      return nextDayWindowStart(now, w, tz);
    case "failed":
      at = inMin(5 * Math.max(1, attemptNo));
      break;
    case "no_answer":
    default:
      if (attemptNo <= 1) at = inMin(120);
      else if (attemptNo === 2) at = inMin(240);
      else return nextDayWindowStart(now, w, tz);
  }
  return nextWindowStart(at, w, tz);
}
