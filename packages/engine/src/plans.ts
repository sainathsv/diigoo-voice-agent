import { and, eq, gte, lt, sql } from "drizzle-orm";
import { calls, dialAttempts, plans, subscriptions, type Plan, type PlanLimits, type Subscription, type Tx } from "@jenai/db";
import { istDay, startOfNextIstDay } from "./dialer/time-ist";

export { PLAN_CATALOG } from "@jenai/db";

export const FEATURE_LABELS: Record<string, string> = {
  inbound_ai: "AI answers inbound calls",
  leads: "Leads from calls",
  outbound_campaigns: "Outbound campaigns (reminders, recalls, follow-ups)",
  ai_qa_sampled: "AI call quality review (sampled)",
  ai_qa: "AI call quality review (every call)",
  api_webhooks: "API and webhooks",
  integrations: "CRM, calendar and clinic software integrations",
  multi_branch_number: "One number across branches",
  custom_voice: "Custom voice and pronunciation list",
  sla: "Uptime and support SLA",
  dedicated_success: "Dedicated success manager",
  india_only: "India-only hosting and processing",
  series_1600: "1600-series numbers",
};

export const LIMIT_LABELS: Record<keyof PlanLimits, string> = {
  branches: "Branches",
  phone_numbers: "Phone numbers",
  concurrent_calls: "Calls at the same time",
  agents: "AI agents",
  users: "Team members",
  campaigns_per_month: "Campaigns per month",
  inbound_calls_per_day: "Inbound calls a day",
  outbound_calls_per_day: "Outbound calls a day",
};

export interface Entitlements {
  plan: Plan;
  subscription: Subscription | null;
  billingModel: Plan["billingModel"];
  limits: PlanLimits;
  features: Set<string>;
}

/** Effective limits and features: plan defaults, then per-client contract overrides. */
export function effective(plan: Plan, sub: Subscription | null): Entitlements {
  return {
    plan,
    subscription: sub,
    billingModel: sub?.billingModel ?? plan.billingModel,
    limits: { ...plan.limits, ...(sub?.limitOverrides ?? {}) },
    features: new Set([...plan.features, ...(sub?.extraFeatures ?? [])]),
  };
}

export async function entitlements(tx: Tx, tenantId: string, fallbackPlanKey = "trial"): Promise<Entitlements> {
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
  const key = sub?.planKey ?? fallbackPlanKey;
  const [plan] = await tx.select().from(plans).where(eq(plans.key, key));
  if (!plan) throw new Error(`Plan ${key} is missing from the catalog`);
  return effective(plan, sub ?? null);
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

/** Throws a clear, user-facing error when adding one more would pass the plan limit. */
export function assertWithinLimit(e: Entitlements, key: keyof PlanLimits, current: number) {
  const max = e.limits[key];
  if (max === undefined || max === null) return;
  if (current + 1 > max) throw new LimitError(`${e.plan.name} plan allows ${max} ${LIMIT_LABELS[key].toLowerCase()}. Ask JENAI to change the plan.`);
}

export function assertFeature(e: Entitlements, feature: string) {
  if (!e.features.has(feature)) throw new LimitError(`${FEATURE_LABELS[feature] ?? feature} is not included in the ${e.plan.name} plan.`);
}

/** Billing period that contains `at`, based on the subscription's billing day (1-28), in IST. */
export function billingPeriod(at: Date, billingDay = 1): { from: Date; to: Date; label: string } {
  const ist = new Date(at.getTime() + 330 * 60_000);
  let y = ist.getUTCFullYear();
  let m = ist.getUTCMonth();
  if (ist.getUTCDate() < billingDay) m -= 1;
  if (m < 0) {
    m += 12;
    y -= 1;
  }
  const from = new Date(Date.UTC(y, m, billingDay) - 330 * 60_000);
  const to = new Date(Date.UTC(y, m + 1, billingDay) - 330 * 60_000);
  const label = new Date(Date.UTC(y, m, billingDay)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return { from, to, label };
}

export interface Usage {
  calls: number;
  inboundCalls: number;
  outboundCalls: number;
  minutes: number; // billed per started minute, per call
}

export async function usage(tx: Tx, tenantId: string, from: Date, to: Date): Promise<Usage> {
  const [r] = await tx
    .select({
      calls: sql<number>`count(*)::int`,
      inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
      outbound: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')::int`,
      minutes: sql<number>`coalesce(sum(ceil(greatest(${calls.durationS}, 0) / 60.0)), 0)::int`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), gte(calls.startedAt, from), lt(calls.startedAt, to)));
  return { calls: r?.calls ?? 0, inboundCalls: r?.inbound ?? 0, outboundCalls: r?.outbound ?? 0, minutes: r?.minutes ?? 0 };
}

export interface Statement {
  period: { from: Date; to: Date; label: string };
  usage: Usage;
  fixedFeePaise: number;
  includedMinutes: number;
  billableMinutes: number;
  ratePaisePerMin: number | null;
  usagePaise: number;
  subtotalPaise: number;
  note: string;
}

/**
 * Monthly statement a finance person uses to raise the (physical) tax invoice.
 * Not an invoice itself: numbering, GST and e-invoicing belong to the billing
 * module that comes later.
 */
export function statement(e: Entitlements, u: Usage, period: Statement["period"], branches = 1): Statement {
  const sub = e.subscription;
  const perBranch = e.plan.feeBasis === "per_branch" ? Math.max(1, branches) : 1;
  const fixedFeePaise = sub?.contractFeePaise ?? e.plan.monthlyFeePaise * perBranch;
  const includedMinutes = sub?.committedMinutes ?? e.plan.includedMinutes * perBranch;
  const rate = sub?.contractRatePaisePerMin ?? e.plan.overagePaisePerMin ?? null;
  const contractRate = sub?.contractRatePaisePerMin != null;
  // Contract rates bill every minute (committed minutes are a floor); list plans bill only overage.
  const billableMinutes = contractRate ? Math.max(u.minutes, includedMinutes) : Math.max(0, u.minutes - includedMinutes);
  const usagePaise = rate ? billableMinutes * rate : 0;
  return {
    period,
    usage: u,
    fixedFeePaise,
    includedMinutes,
    billableMinutes,
    ratePaisePerMin: rate,
    usagePaise,
    subtotalPaise: fixedFeePaise + usagePaise,
    note: contractRate ? "Contract rate applied to all minutes (committed minutes are the minimum)." : "Minutes beyond the included allowance are billed at the overage rate.",
  };
}

export const rupees = (paise: number | null | undefined) =>
  paise == null ? "" : `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/**
 * What the plan allows this workspace right now: how much of today's outbound
 * allowance is spent, and whether the subscription still runs.
 *
 * Counted from dial attempts rather than call records, because an attempt is
 * written the moment we decide to dial. Call records arrive on the next sync,
 * which is minutes later, and a cap that lags by minutes is not a cap.
 */
export async function planGate(tx: Tx, tenantId: string, now: Date) {
  const e = await entitlements(tx, tenantId);
  const perDay = e.limits.outbound_calls_per_day ?? null;
  const endsOn = e.subscription?.endsOn ?? null;
  if (perDay === null) return { outboundToday: 0, outboundPerDay: null, endsOn, name: e.plan.name };

  const midnight = new Date(startOfNextIstDay(now).getTime() - 86_400_000);
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(dialAttempts)
    .where(and(eq(dialAttempts.tenantId, tenantId), eq(dialAttempts.decision, "dial"), gte(dialAttempts.createdAt, midnight)));
  return { outboundToday: n, outboundPerDay: perDay, endsOn, name: e.plan.name };
}

/** Inbound calls this workspace has already taken today, and what it is allowed. */
export async function inboundToday(tx: Tx, tenantId: string, now: Date) {
  const e = await entitlements(tx, tenantId);
  const perDay = e.limits.inbound_calls_per_day ?? null;
  const midnight = new Date(startOfNextIstDay(now).getTime() - 86_400_000);
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.direction, "inbound"), gte(calls.startedAt, midnight)));
  return { used: n, perDay, day: istDay(now), overBy: perDay === null ? 0 : Math.max(0, n - perDay), plan: e.plan.name };
}
