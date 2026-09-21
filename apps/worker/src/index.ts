/**
 * JENAI background worker: the dialer loop and the calls sync loop.
 *
 * Safety switches (all default OFF):
 *   JENAI_REAL_DIALS=true   place real calls (still only for clients in managed mode with an API key)
 *   JENAI_SYNC=true         pull calls from the voice engine every JENAI_SYNC_SECONDS (default 300)
 *   JENAI_ANALYZE=true      read new transcripts with the analyzer (Bedrock Mumbai) after each sync
 * Without them the dialer uses the simulated carrier and nothing touches the live engine.
 *
 * The AI safety loop is ON by default (JENAI_SAFETY=false turns it off): it runs
 * the red-team checks that publishing waits for, and re-checks live agents when
 * the suite or model changes, or after JENAI_SAFETY_RECHECK_DAYS (default 90).
 * Cost control for a large fleet: at most JENAI_SAFETY_SWEEP_PER_HOUR (default
 * 100) re-checks are queued per hour; publish checks always go first.
 *
 * The integrations loop is ON by default (JENAI_INTEGRATIONS=false turns it
 * off): it hands call results back to each client's own system (their CRM),
 * retrying with a widening gap and never sending the same event twice.
 *
 * The security loop is ON by default (JENAI_SECURITY=false turns it off): the
 * detector every minute, audit-log integrity and retention every hour. High and
 * critical alerts go to JENAI_ALERT_SNS_TOPIC_ARN when set, else to this log.
 */
import "@jenai/db/env";
import { eq } from "drizzle-orm";
import { platformDb, voiceConnections } from "@jenai/db";
import {
  BedrockExtractor,
  BedrockSafetyModel,
  analyzeCalls,
  claimDeliveries,
  claimSafetyChecks,
  deliver,
  enqueueFleetSweep,
  requeueStuckChecks,
  requeueStuckDeliveries,
  runSafetyCheck,
  detect,
  logNotifier,
  notifyPending,
  maintainSecurityEvents,
  runDialerTick,
  snsNotifier,
  syncTenantCalls,
  verifyAuditChains,
  type Notifier,
} from "@jenai/engine";

const REAL = process.env.JENAI_REAL_DIALS === "true";
const SYNC = process.env.JENAI_SYNC === "true";
const ANALYZE = process.env.JENAI_ANALYZE === "true";
const SECURITY = process.env.JENAI_SECURITY !== "false";
const ALERT_TOPIC = process.env.JENAI_ALERT_SNS_TOPIC_ARN ?? "";
const SAFETY = process.env.JENAI_SAFETY !== "false";
const SAFETY_PARALLEL = Math.max(1, Number(process.env.JENAI_SAFETY_PARALLEL ?? 2));
const SWEEP_PER_HOUR = Math.max(0, Number(process.env.JENAI_SAFETY_SWEEP_PER_HOUR ?? 100));
const RECHECK_DAYS = Math.max(1, Number(process.env.JENAI_SAFETY_RECHECK_DAYS ?? 90));
const INTEGRATIONS = process.env.JENAI_INTEGRATIONS !== "false";
const DELIVERY_BATCH = Math.max(1, Number(process.env.JENAI_INTEGRATIONS_BATCH ?? 10));
const SYNC_MS = Math.max(60, Number(process.env.JENAI_SYNC_SECONDS ?? 300)) * 1000;
const TICK_MS = 3000;
let stopping = false;
const extractor = new BedrockExtractor();

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function dialerLoop() {
  while (!stopping) {
    try {
      const r = await runDialerTick({ allowRealDials: REAL });
      if (r.dialed || r.resolved || r.skipped || r.deferred || r.errors.length) log("dialer.tick", { ...r });
    } catch (e) {
      log("dialer.error", { message: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

async function syncLoop() {
  while (!stopping) {
    const tenants = await platformDb().select({ id: voiceConnections.tenantId }).from(voiceConnections).where(eq(voiceConnections.status, "ok"));
    for (const t of tenants) {
      if (stopping) break;
      try {
        const s = await syncTenantCalls(t.id, { maxPerWorkflow: 100 });
        log("sync.tenant", { tenant: t.id.slice(0, 8), ...s, errors: s.errors.length });
        if (ANALYZE) {
          const a = await analyzeCalls(t.id, extractor, { limit: 50 });
          if (a.analyzed || a.failed) log("analyze.tenant", { tenant: t.id.slice(0, 8), ...a });
        }
      } catch (e) {
        log("sync.error", { tenant: t.id.slice(0, 8), message: (e as Error).message });
      }
    }
    await new Promise((r) => setTimeout(r, SYNC_MS));
  }
}

async function securityLoop() {
  const notifier: Notifier = ALERT_TOPIC ? await snsNotifier(ALERT_TOPIC) : logNotifier;
  let lastHourly = 0;
  while (!stopping) {
    const db = platformDb();
    try {
      const r = await detect(db);
      if (r.opened.length) log("security.alerts_opened", { count: r.opened.length, rules: [...new Set(r.raised.map((c) => c.rule))] });
      const sent = await notifyPending(db, notifier);
      if (sent) log("security.alerts_sent", { count: sent });
      if (Date.now() - lastHourly > 3_600_000) {
        lastHourly = Date.now();
        const chains = await verifyAuditChains(db, (line) => console.log(line));
        const broken = chains.filter((c) => c.problem);
        log(broken.length ? "security.audit_chain_broken" : "security.audit_chain_ok", { verified: chains.length, events: chains.reduce((n, c) => n + c.events, 0), broken: broken.map((c) => c.chain) });
        log("security.events_retention", { result: await maintainSecurityEvents(db) });
      }
    } catch (e) {
      log("security.error", { message: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function safetyLoop() {
  const model = new BedrockSafetyModel();
  let lastSweep = 0;
  while (!stopping) {
    const db = platformDb();
    let claimed: Array<{ tenantId: string; id: string }> = [];
    try {
      const stuck = await requeueStuckChecks(db);
      if (stuck) log("safety.requeued", { count: stuck });
      if (SWEEP_PER_HOUR && Date.now() - lastSweep > 3_600_000) {
        lastSweep = Date.now();
        const n = await enqueueFleetSweep(db, { max: SWEEP_PER_HOUR, days: RECHECK_DAYS });
        if (n) log("safety.sweep_queued", { count: n });
      }
      claimed = await claimSafetyChecks(db, SAFETY_PARALLEL);
      await Promise.all(
        claimed.map(async (c) => {
          const r = await runSafetyCheck(c, model, 4);
          log("safety.checked", { tenant: c.tenantId.slice(0, 8), check: c.id.slice(0, 8), reason: r.reason, status: r.status, held: r.held, failed: r.failed, review: r.review });
        }),
      );
    } catch (e) {
      log("safety.error", { message: (e as Error).message });
    }
    if (!claimed.length) await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function integrationsLoop() {
  while (!stopping) {
    const db = platformDb();
    let claimed: Array<{ tenantId: string; id: string }> = [];
    try {
      const stuck = await requeueStuckDeliveries(db);
      if (stuck) log("integration.requeued", { count: stuck });
      claimed = await claimDeliveries(db, DELIVERY_BATCH);
      const results = await Promise.all(claimed.map((c) => deliver(c)));
      const failed = results.filter((r) => !r.ok);
      if (results.length) log("integration.delivered", { sent: results.length - failed.length, retrying: failed.length, firstError: failed[0]?.message?.slice(0, 120) });
    } catch (e) {
      log("integration.error", { message: (e as Error).message });
    }
    if (!claimed.length) await new Promise((r) => setTimeout(r, 5_000));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("worker.stopping", { signal: sig });
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

log("worker.started", { realDials: REAL, sync: SYNC, analyze: ANALYZE, syncSeconds: SYNC_MS / 1000, security: SECURITY, alertTopic: ALERT_TOPIC ? "sns" : "log", safety: SAFETY, safetyRecheckDays: RECHECK_DAYS, integrations: INTEGRATIONS });
void dialerLoop();
if (SYNC) void syncLoop();
if (SECURITY) void securityLoop();
if (SAFETY) void safetyLoop();
if (INTEGRATIONS) void integrationsLoop();
