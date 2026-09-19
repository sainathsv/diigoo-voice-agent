import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentSafetyChecks,
  agentVersions,
  agents,
  organizations,
  platformDb,
  withTenant,
  type AgentSafetyCheck,
  type Db,
  type Tx,
} from "@jenai/db";
import { guardrailsVersionOf, render } from "@jenai/voice";
import { templateOf } from "../agents";
import { SUITE_VERSION, casesFor, verticalOf } from "./cases";
import { runSuite, summarise, type SafetyModel } from "./runner";
import { raise } from "../security/detect";

/**
 * AI safety checks as a platform service. Every agent version is attacked by
 * the red-team suite before it can go live; every live agent is re-checked by
 * the fleet sweep. Checks queue in the database and any number of workers can
 * drain the queue (FOR UPDATE SKIP LOCKED), so this scales with the fleet.
 */

const LIVE = ["queued", "running", "passed", "needs_review"] as const;

/** The exact prompts a version would put in front of callers, rendered if it is a draft. */
async function promptsOf(tx: Tx, versionId: string) {
  const [v] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId));
  if (!v) throw new Error("Version not found.");
  const [a] = await tx.select().from(agents).where(eq(agents.id, v.agentId));
  const [org] = await tx.select({ vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, v.tenantId));
  if (v.state === "imported" || v.state === "live" || v.state === "superseded") {
    // What callers hear (or heard): check it as it is, legacy prompts included.
    return { version: v, agent: a!, vertical: org?.vertical ?? null, inbound: v.inboundPrompt ?? "", hash: v.promptHash ?? "", guardrails: guardrailsVersionOf(v.inboundPrompt ?? "") };
  }
  const tpl = await templateOf(tx, a!);
  const r = render(tpl, v, a!.domain);
  if (v.promptHash !== r.hash) {
    await tx.update(agentVersions).set({ inboundPrompt: r.inboundPrompt, outboundPrompt: r.outboundPrompt, promptHash: r.hash, guardrailsVersion: r.guardrailsVersion }).where(eq(agentVersions.id, v.id));
  }
  return { version: v, agent: a!, vertical: org?.vertical ?? null, inbound: r.inboundPrompt, hash: r.hash, guardrails: r.guardrailsVersion };
}

/**
 * Ask for a check of one version. Returns the existing check when one is
 * already queued, running or done for these exact prompts, and reuses a
 * passing result for identical prompts instead of paying for a new run.
 */
export async function requestSafetyCheck(
  tx: Tx,
  input: { tenantId: string; versionId: string; reason: "publish" | "manual" | "sweep"; requestedBy: string | null; model?: Pick<SafetyModel, "target" | "judge"> },
): Promise<AgentSafetyCheck> {
  const p = await promptsOf(tx, input.versionId);
  if (!p.inbound.trim()) throw new Error("This version has no prompt to check.");
  const target = input.model?.target ?? process.env.JENAI_SAFETY_TARGET_MODEL ?? "deepseek.v3.2";
  const judge = input.model?.judge ?? process.env.JENAI_SAFETY_JUDGE_MODEL ?? "deepseek.v3.2";
  const [existing] = await tx
    .select()
    .from(agentSafetyChecks)
    // A sweep wants a fresh run, so it only joins one already in progress.
    .where(and(eq(agentSafetyChecks.versionId, input.versionId), eq(agentSafetyChecks.promptHash, p.hash), eq(agentSafetyChecks.suiteVersion, SUITE_VERSION), inArray(agentSafetyChecks.status, input.reason === "sweep" ? ["queued", "running"] : [...LIVE])))
    .orderBy(desc(agentSafetyChecks.createdAt))
    .limit(1);
  if (existing) return existing;

  const [cached] = input.reason === "sweep" ? [] : await tx
    .select()
    .from(agentSafetyChecks)
    .where(and(eq(agentSafetyChecks.promptHash, p.hash), eq(agentSafetyChecks.suiteVersion, SUITE_VERSION), eq(agentSafetyChecks.targetModel, target), eq(agentSafetyChecks.status, "passed")))
    .orderBy(desc(agentSafetyChecks.finishedAt))
    .limit(1);
  const base = {
    tenantId: input.tenantId,
    agentId: p.agent.id,
    versionId: input.versionId,
    promptHash: p.hash,
    suiteVersion: SUITE_VERSION,
    guardrailsVersion: p.guardrails,
    vertical: verticalOf(p.vertical),
    targetModel: target,
    judgeModel: judge,
    reason: input.reason,
    requestedBy: input.requestedBy,
  };
  const [row] = await tx
    .insert(agentSafetyChecks)
    .values(
      cached
        ? { ...base, status: "passed", held: cached.held, failed: cached.failed, review: cached.review, criticalFailed: cached.criticalFailed, results: cached.results, cachedFrom: cached.id, startedAt: new Date(), finishedAt: new Date() }
        : base,
    )
    .returning();
  return row!;
}

export interface GateResult {
  ok: boolean;
  check: AgentSafetyCheck | null;
  message: string;
}

/** The publish gate. Passing, or reviewed and approved by JENAI, for the exact prompts being published. */
export async function safetyGate(tx: Tx, versionId: string, promptHash: string): Promise<GateResult> {
  const [c] = await tx
    .select()
    .from(agentSafetyChecks)
    .where(and(eq(agentSafetyChecks.versionId, versionId), eq(agentSafetyChecks.promptHash, promptHash), eq(agentSafetyChecks.suiteVersion, SUITE_VERSION)))
    .orderBy(desc(agentSafetyChecks.createdAt))
    .limit(1);
  if (!c) return { ok: false, check: null, message: "This version has not been safety-checked yet." };
  switch (c.status) {
    case "passed":
      return { ok: true, check: c, message: c.reviewedBy ? "Safety check approved after review by JENAI." : "Safety check passed." };
    case "needs_review":
      return { ok: false, check: c, message: "The safety check needs a JENAI reviewer to read some answers before this can go live." };
    case "failed": {
      const bad = (c.results as Array<{ id: string; verdict: string; severity: string }>).filter((r) => r.verdict === "failed" && r.severity !== "medium").map((r) => r.id.replace(/_/g, " "));
      return { ok: false, check: c, message: `The agent failed the safety check (${bad.join(", ")}). Fix the facts or greeting and try again.` };
    }
    case "error":
      return { ok: false, check: c, message: "The safety check could not run. Start it again." };
    default:
      return { ok: false, check: c, message: "The safety check is running (about 2 minutes). Publish again when it has passed." };
  }
}

// ---------------------------------------------------------------- the queue (worker, console pool)

/** Takes up to `limit` queued checks for this worker. Safe with many workers. */
export async function claimSafetyChecks(db: Db, limit: number): Promise<Array<{ tenantId: string; id: string }>> {
  const rows = await db.execute<{ tenant_id: string; id: string }>(sql`
    update agent_safety_checks c set status = 'running', started_at = now(), attempts = attempts + 1
    from (select tenant_id, id from agent_safety_checks where status = 'queued' order by
            case reason when 'publish' then 0 when 'manual' then 1 else 2 end, created_at
          limit ${limit} for update skip locked) q
    where c.tenant_id = q.tenant_id and c.id = q.id
    returning c.tenant_id, c.id`);
  return rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
}

/** Runs one claimed check and stores the verdicts, inside that client's tenant. */
export async function runSafetyCheck(ref: { tenantId: string; id: string }, model: SafetyModel, concurrency = 4): Promise<AgentSafetyCheck> {
  const { check, prompt } = await withTenant(ref.tenantId, async (tx) => {
    const [check] = await tx.select().from(agentSafetyChecks).where(eq(agentSafetyChecks.id, ref.id));
    if (!check) throw new Error("Check not found.");
    const [v] = await tx.select({ p: agentVersions.inboundPrompt, hash: agentVersions.promptHash }).from(agentVersions).where(eq(agentVersions.id, check.versionId));
    // Only ever judge the exact prompts the check was asked for.
    return { check, prompt: v && v.hash === check.promptHash ? (v.p ?? "") : "" };
  });
  try {
    if (!prompt.trim()) throw new Error("The version changed after this check was queued; start a new check.");
    const results = await runSuite(model, prompt, casesFor(check.vertical), concurrency);
    const s = summarise(results);
    const row = await withTenant(ref.tenantId, async (tx) => {
      const [row] = await tx
        .update(agentSafetyChecks)
        .set({ status: s.status, held: s.held, failed: s.failed, review: s.review, criticalFailed: s.criticalFailed, results: results as never, finishedAt: new Date(), error: null })
        .where(eq(agentSafetyChecks.id, ref.id))
        .returning();
      return row!;
    });
    // A LIVE agent failing (sweep) means callers are exposed right now: open a security alert.
    if (check.reason === "sweep" && s.status === "failed") {
      const failedCases = results.filter((r) => r.verdict === "failed" && r.severity !== "medium").map((r) => r.id);
      await raise(platformDb(), {
        rule: "ai.live_agent_unsafe",
        severity: s.criticalFailed ? "critical" : "high",
        title: "A live AI agent failed the safety check",
        subject: `agent ${check.agentId}`,
        tenantId: check.tenantId,
        dedupeKey: `ai.live_agent_unsafe:${check.agentId}:${check.promptHash}`,
        detail: { versionId: check.versionId, checkId: check.id, failedCases, guardrailsVersion: check.guardrailsVersion },
        hits: 1,
        at: new Date(),
      });
    }
    return row;
  } catch (e) {
    return withTenant(ref.tenantId, async (tx) => {
      const [row] = await tx
        .update(agentSafetyChecks)
        .set({ status: check.attempts >= 3 ? "error" : "queued", error: (e as Error).message.slice(0, 500), finishedAt: new Date() })
        .where(eq(agentSafetyChecks.id, ref.id))
        .returning();
      return row!;
    });
  }
}

/** Checks left "running" by a worker that died go back in the queue. */
export async function requeueStuckChecks(db: Db, minutes = 15): Promise<number> {
  const r = await db.execute(sql`
    update agent_safety_checks set status = case when attempts >= 3 then 'error'::safety_status else 'queued'::safety_status end,
      error = coalesce(error, 'worker stopped mid-check')
    where status = 'running' and started_at < now() - make_interval(mins => ${minutes})`);
  return (r as unknown as { count?: number }).count ?? 0;
}

/**
 * Fleet sweep: queue a check for every live agent whose prompts have no
 * passing check under the current suite in the last `days`. Capped per call
 * so a new suite version rolls across tens of thousands of agents gradually.
 */
export async function enqueueFleetSweep(db: Db, opts: { max?: number; days?: number; onlyTenants?: string[] } = {}): Promise<number> {
  const max = opts.max ?? 200;
  const days = opts.days ?? 7;
  const due = await db.execute<{ tenant_id: string; version_id: string }>(sql`
    select a.tenant_id, a.live_version_id as version_id
    from agents a
    join agent_versions v on v.tenant_id = a.tenant_id and v.id = a.live_version_id
    where a.live_version_id is not null and coalesce(v.inbound_prompt, '') <> ''
      ${opts.onlyTenants?.length ? sql`and a.tenant_id in ${opts.onlyTenants}` : sql``}
      and not exists (
        select 1 from agent_safety_checks c
        where c.tenant_id = a.tenant_id and c.version_id = v.id and c.prompt_hash = v.prompt_hash
          and c.suite_version = ${SUITE_VERSION}
          and (c.status in ('queued', 'running') or c.finished_at > now() - make_interval(days => ${days}))
      )
    order by (select max(c2.finished_at) from agent_safety_checks c2 where c2.tenant_id = a.tenant_id and c2.version_id = v.id) nulls first
    limit ${max}`);
  let n = 0;
  for (const d of due) {
    try {
      await withTenant(d.tenant_id, (tx) => requestSafetyCheck(tx, { tenantId: d.tenant_id, versionId: d.version_id, reason: "sweep", requestedBy: null }));
      n++;
    } catch (e) {
      console.error(`[safety] sweep could not queue ${d.version_id}: ${(e as Error).message}`);
    }
  }
  return n;
}

/** A JENAI reviewer read the unverified answers: approve (publishable) or reject (failed). */
export async function reviewSafetyCheck(tenantId: string, checkId: string, decision: "approve" | "reject", reviewer: string, note: string): Promise<AgentSafetyCheck> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .update(agentSafetyChecks)
      .set({ status: decision === "approve" ? "passed" : "failed", reviewedBy: reviewer, reviewedAt: new Date(), reviewNote: note })
      .where(and(eq(agentSafetyChecks.id, checkId), eq(agentSafetyChecks.status, "needs_review")))
      .returning();
    if (!row) throw new Error("That check is not waiting for review.");
    return row;
  });
}
