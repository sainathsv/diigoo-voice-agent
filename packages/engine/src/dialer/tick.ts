/**
 * One dialer pass (Blueprint Part 6, "Dialer design"). Progressive dialing:
 * a slot is reserved before each dial, so every answered call has an agent.
 * Tenants are served round-robin so one client's campaign cannot starve others.
 *
 * Capacity is counted in Postgres (targets in state "dialing"); this is exact
 * for a single worker. Move the counters to Redis leases before running more
 * than one dialer worker.
 */
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  agents,
  calls,
  campaignTargets,
  campaigns,
  consents,
  dialAttempts,
  phoneNumbers,
  platformDb,
  suppressions,
  withTenant,
  type Campaign,
  type Tx,
} from "@jenai/db";
import { entitlements } from "../plans";
import { voiceClient } from "../voice-conn";
import { decide, nextAttempt, type Outcome, type Purpose } from "./policy";
import { DograhGateway, SimulatedGateway, type DialGateway } from "./gateway";
import { localParts, zoned } from "./time";

export interface TickOptions {
  now?: Date;
  perTenant?: number;
  /** Real calls only when this is true AND the tenant's voice connection is managed. */
  allowRealDials?: boolean;
  simulator?: SimulatedGateway;
  leaseMinutes?: number;
}

export interface TickReport {
  dialed: number;
  deferred: number;
  skipped: number;
  resolved: number;
  gateways: Record<string, number>;
  errors: string[];
}

const sim = new SimulatedGateway();

async function gatewayFor(tx: Tx, tenantId: string, opts: TickOptions): Promise<DialGateway> {
  if (!opts.allowRealDials) return opts.simulator ?? sim;
  const v = await voiceClient(tx, tenantId);
  if (v && v.conn.mode === "managed" && v.conn.authKind === "api_key") return new DograhGateway(v.client);
  return opts.simulator ?? sim;
}

async function policyFacts(tx: Tx, c: Campaign, phone: string, now: Date) {
  const supp = await tx
    .select({ reason: suppressions.reason, scope: suppressions.scope, expiresAt: suppressions.expiresAt })
    .from(suppressions)
    .where(eq(suppressions.phoneE164, phone));
  const cons = await tx
    .select({ purpose: consents.purpose, status: consents.status, expiresAt: consents.expiresAt })
    .from(consents)
    .where(eq(consents.phoneE164, phone));
  const [rel] = await tx.select({ id: calls.id }).from(calls).where(and(eq(calls.fromE164, phone), eq(calls.direction, "inbound"))).limit(1);
  const p = localParts(now, c.timezone);
  const midnight = zoned(p.y, p.m, p.d, 0, c.timezone);
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(dialAttempts)
    .where(and(eq(dialAttempts.phoneE164, phone), eq(dialAttempts.decision, "dial"), gte(dialAttempts.createdAt, midnight)));
  return { suppressions: supp, consents: cons, hasRelationship: !!rel, attemptsToday: n };
}

/** Record how a dial ended and schedule the next attempt (or finish the target). */
export async function applyOutcome(tx: Tx, targetId: string, outcome: Outcome, now: Date, callbackAt?: Date | null) {
  const [t] = await tx.select().from(campaignTargets).where(eq(campaignTargets.id, targetId));
  if (!t) return;
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, t.campaignId));
  const next = nextAttempt(outcome, t.attemptNo, now, c!.windows, c!.timezone, callbackAt);
  const exhausted = !next || t.attemptNo >= c!.maxAttempts;
  await tx
    .update(campaignTargets)
    .set({
      state: exhausted ? "completed" : "scheduled",
      lastOutcome: exhausted && next ? `${outcome} (attempts used up)` : outcome,
      nextAttemptAt: next ?? t.nextAttemptAt,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(eq(campaignTargets.id, targetId));
  await tx
    .update(dialAttempts)
    .set({ outcome })
    .where(and(eq(dialAttempts.targetId, targetId), eq(dialAttempts.externalRunId, t.externalRunId ?? "")));
  if (outcome === "opt_out") {
    await tx
      .insert(suppressions)
      .values({ tenantId: t.tenantId, phoneE164: t.phoneE164, reason: "opt_out", scope: null, source: `campaign ${t.campaignId}` })
      .onConflictDoNothing();
  }
}

function outcomeFromCall(call: { status: string; durationS: number | null; extracted: Record<string, unknown> }): { outcome: Outcome; callbackAt: Date | null } {
  const next = String(call.extracted.next_step ?? "").toLowerCase();
  if (/do.?not.?call|opt.?out|stop calling/.test(`${call.extracted.do_not_call ?? ""} ${next}`)) return { outcome: "opt_out", callbackAt: null };
  if (next === "callback") return { outcome: "callback", callbackAt: null };
  if (call.status === "completed" && (call.durationS ?? 0) >= 10) return { outcome: "answered", callbackAt: null };
  if (call.status === "failed") return { outcome: "failed", callbackAt: null };
  return { outcome: "no_answer", callbackAt: null };
}

export async function runDialerTick(opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const lease = opts.leaseMinutes ?? 20;
  const report: TickReport = { dialed: 0, deferred: 0, skipped: 0, resolved: 0, gateways: {}, errors: [] };

  // 1. Resolve simulated outcomes.
  const simulator = opts.simulator ?? sim;
  for (const r of simulator.poll(now.getTime())) {
    const [t] = await platformDb().select({ tenantId: campaignTargets.tenantId, id: campaignTargets.id }).from(campaignTargets).where(eq(campaignTargets.externalRunId, r.externalRunId));
    if (!t) continue;
    await withTenant(t.tenantId, (tx) => applyOutcome(tx, t.id, r.outcome, now));
    report.resolved++;
  }

  // 2. Which tenants have running campaigns (read-only listing across tenants).
  const running = await platformDb().selectDistinct({ tenantId: campaigns.tenantId }).from(campaigns).where(eq(campaigns.status, "running"));

  for (const { tenantId } of running) {
    try {
      // 2a. Resolve real calls from synced call records; expire stuck leases.
      await withTenant(tenantId, async (tx) => {
        const dialing = await tx.select().from(campaignTargets).where(eq(campaignTargets.state, "dialing"));
        for (const t of dialing) {
          if (t.externalRunId && !t.externalRunId.startsWith("sim-")) {
            const [call] = await tx.select().from(calls).where(and(eq(calls.provider, "dograh"), eq(calls.externalRunId, t.externalRunId)));
            if (call && call.status !== "in_progress" && call.status !== "unknown") {
              await tx.update(calls).set({ campaignId: t.campaignId, targetId: t.id }).where(eq(calls.id, call.id));
              const o = outcomeFromCall(call);
              await applyOutcome(tx, t.id, o.outcome, now, o.callbackAt);
              report.resolved++;
              continue;
            }
          }
          if (t.leaseUntil && t.leaseUntil < now) {
            await applyOutcome(tx, t.id, "failed", now);
            report.resolved++;
          }
        }
      });

      // 2b. Dial due targets within capacity.
      const toDial = await withTenant(tenantId, async (tx) => {
        const ent = await entitlements(tx, tenantId);
        const tenantCap = ent.limits.concurrent_calls ?? 50;
        const [{ inflight } = { inflight: 0 }] = await tx.select({ inflight: sql<number>`count(*)::int` }).from(campaignTargets).where(eq(campaignTargets.state, "dialing"));
        let tenantFree = Math.max(0, tenantCap - inflight);
        const cs = await tx.select().from(campaigns).where(eq(campaigns.status, "running"));
        const plan: Array<{ targetId: string; phone: string; context: Record<string, unknown>; uuid: string | null; voiceConfigId: number | null }> = [];
        const gw = await gatewayFor(tx, tenantId, opts);

        for (const c of cs) {
          if (tenantFree <= 0) break;
          const [num] = await tx.select().from(phoneNumbers).where(eq(phoneNumbers.id, c.callerNumberId));
          const [agent] = await tx.select().from(agents).where(eq(agents.id, c.agentId));
          const [{ busy } = { busy: 0 }] = await tx
            .select({ busy: sql<number>`count(*)::int` })
            .from(campaignTargets)
            .where(and(eq(campaignTargets.campaignId, c.id), eq(campaignTargets.state, "dialing")));
          const free = Math.min(tenantFree, c.maxConcurrency - busy, (num?.maxConcurrency ?? 1) - busy, opts.perTenant ?? 10);
          if (free <= 0) continue;
          const due = await tx
            .select()
            .from(campaignTargets)
            .where(and(eq(campaignTargets.campaignId, c.id), inArray(campaignTargets.state, ["queued", "scheduled"]), lte(campaignTargets.nextAttemptAt, now)))
            .orderBy(campaignTargets.nextAttemptAt)
            .limit(free * 3)
            .for("update", { skipLocked: true });

          let used = 0;
          for (const t of due) {
            if (used >= free) break;
            const facts = await policyFacts(tx, c, t.phoneE164, now);
            const d = decide({
              now,
              campaign: { status: c.status, purpose: c.purpose as Purpose, windows: c.windows, timezone: c.timezone, maxAttempts: c.maxAttempts, dailyCapPerContact: c.dailyCapPerContact, consentAttested: c.consentAttested },
              target: { attemptNo: t.attemptNo },
              number: { status: num?.status ?? "missing", series: (num?.series ?? "landline") as never, purpose: (num?.purpose ?? "inbound") as never, a2pDeclaredAt: num?.a2pDeclaredAt ?? null },
              ...facts,
            });
            await tx.insert(dialAttempts).values({ tenantId, targetId: t.id, campaignId: c.id, phoneE164: t.phoneE164, decision: d.action, reason: d.reason, gateway: d.action === "dial" ? gw.name : null });
            if (d.action === "skip") {
              await tx.update(campaignTargets).set({ state: "skipped", skipReason: d.reason, updatedAt: now }).where(eq(campaignTargets.id, t.id));
              report.skipped++;
            } else if (d.action === "defer") {
              await tx.update(campaignTargets).set({ state: "scheduled", nextAttemptAt: d.until, updatedAt: now }).where(eq(campaignTargets.id, t.id));
              report.deferred++;
            } else {
              await tx
                .update(campaignTargets)
                .set({ state: "dialing", attemptNo: t.attemptNo + 1, leaseUntil: new Date(now.getTime() + lease * 60_000), updatedAt: now })
                .where(eq(campaignTargets.id, t.id));
              plan.push({
                targetId: t.id,
                phone: t.phoneE164,
                context: { ...t.context, caller_name: t.name ?? "", call_purpose: c.callPurposeText ?? "", jenai_campaign_id: c.id, jenai_target_id: t.id },
                uuid: agent?.outboundWorkflowUuid ?? null,
                voiceConfigId: null,
              });
              used++;
              tenantFree--;
            }
          }
        }
        return { plan, gw };
      });

      // 2c. Place the calls outside the transaction (network I/O), then record the run ids.
      for (const p of toDial.plan) {
        try {
          const r = await toDial.gw.dial({ tenantId, targetId: p.targetId, phone: p.phone, context: p.context, outboundWorkflowUuid: p.uuid, voiceConfigId: p.voiceConfigId, at: now });
          await withTenant(tenantId, async (tx) => {
            await tx.update(campaignTargets).set({ externalRunId: r.externalRunId }).where(eq(campaignTargets.id, p.targetId));
            await tx
              .update(dialAttempts)
              .set({ externalRunId: r.externalRunId })
              .where(and(eq(dialAttempts.targetId, p.targetId), eq(dialAttempts.decision, "dial"), isNull(dialAttempts.externalRunId)));
          });
          report.dialed++;
          report.gateways[toDial.gw.name] = (report.gateways[toDial.gw.name] ?? 0) + 1;
        } catch (e) {
          report.errors.push(`dial ${p.phone.slice(0, 6)}...: ${(e as Error).message}`);
          await withTenant(tenantId, (tx) => applyOutcome(tx, p.targetId, "failed", now));
        }
      }

      // 2d. Finish campaigns with nothing left to do.
      await withTenant(tenantId, async (tx) => {
        const cs = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, "running"));
        for (const c of cs) {
          const [{ open } = { open: 0 }] = await tx
            .select({ open: sql<number>`count(*)::int` })
            .from(campaignTargets)
            .where(and(eq(campaignTargets.campaignId, c.id), or(eq(campaignTargets.state, "queued"), eq(campaignTargets.state, "scheduled"), eq(campaignTargets.state, "dialing"))));
          if (open === 0) await tx.update(campaigns).set({ status: "completed", completedAt: now, updatedAt: now }).where(eq(campaigns.id, c.id));
        }
      });
    } catch (e) {
      report.errors.push(`tenant ${tenantId.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  return report;
}
