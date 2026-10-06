/**
 * JENAI background worker: the dialer loop and the calls sync loop.
 *
 * Safety switches (all default OFF):
 *   JENAI_REAL_DIALS=true   place real calls (still only for clients in managed mode with an API key)
 *   JENAI_SYNC=true         pull calls from the voice engine every JENAI_SYNC_SECONDS (default 300)
 *   JENAI_ANALYZE=true      read new transcripts with the analyzer (Bedrock Mumbai, or a local model)
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
 *
 * The WhatsApp loop is ON by default (JENAI_WHATSAPP=false turns it off) and idle until a
 * workspace has a WhatsApp channel: it reads queued replies in order with the configured
 * model and sends reminders (every 6 hours, 9 am to 9 pm, until the form is complete).
 * The first WhatsApp message after a cyber crime call goes from the sync loop, as soon as
 * the call is copied, from what the voice engine took on the call (no model needed).
 *
 * The telephone line monitor runs when JENAI_TEL_IFACE names the port of the government
 * cable (or "auto"): every minute it checks the cable, the address on that port, the
 * telecom team's SIP system (JENAI_TEL_SIP_PEER) and our gateway, for the home page.
 *
 * The police edition (JENAI_EDITION=police) runs on a department's own server and
 * sends nothing elsewhere: no AI safety loop (it uses Bedrock), no integrations,
 * alerts only to this log, recordings kept here, and calls read by a model on its
 * own network (the analyser refuses any other).
 */
import "@jenai/db/env";
import { eq, inArray } from "drizzle-orm";
import { platformDb, telephoneLineStatus, voiceConnections, whatsappChannels } from "@jenai/db";
import {
  extractorFromEnv,
  BedrockSafetyModel,
  analyzeCalls,
  caseReaderFromEnv,
  checkLine,
  lineConfigFromEnv,
  readNetFacts,
  followUpCalls,
  processInbox,
  remindPending,
  resendFailed,
  keepWhatsappConnected,
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

const POLICE = process.env.JENAI_EDITION === "police";
const REAL = !POLICE && process.env.JENAI_REAL_DIALS === "true"; // a police server never places calls
const SYNC = process.env.JENAI_SYNC === "true";
const ANALYZE = process.env.JENAI_ANALYZE === "true";
const SECURITY = process.env.JENAI_SECURITY !== "false";
const ALERT_TOPIC = POLICE ? "" : (process.env.JENAI_ALERT_SNS_TOPIC_ARN ?? "");
const SAFETY = !POLICE && process.env.JENAI_SAFETY !== "false";
const SAFETY_PARALLEL = Math.max(1, Number(process.env.JENAI_SAFETY_PARALLEL ?? 2));
const SWEEP_PER_HOUR = Math.max(0, Number(process.env.JENAI_SAFETY_SWEEP_PER_HOUR ?? 100));
const RECHECK_DAYS = Math.max(1, Number(process.env.JENAI_SAFETY_RECHECK_DAYS ?? 90));
const INTEGRATIONS = !POLICE && process.env.JENAI_INTEGRATIONS !== "false";
const WHATSAPP = process.env.JENAI_WHATSAPP !== "false";
const DELIVERY_BATCH = Math.max(1, Number(process.env.JENAI_INTEGRATIONS_BATCH ?? 10));
// A police line copies calls every 15 seconds, so WhatsApp follows a call as soon as it ends.
const SYNC_MS = Math.max(15, Number(process.env.JENAI_SYNC_SECONDS ?? 300)) * 1000;
const TICK_MS = 3000;
let stopping = false;
// Bedrock by default; JENAI_ANALYZER_PROVIDER=local keeps transcripts on this server.
const extractor = ANALYZE ? extractorFromEnv() : null;
const LOCAL_AI = (process.env.JENAI_ANALYZER_PROVIDER ?? (POLICE ? "local" : "bedrock")).toLowerCase() !== "bedrock";

/**
 * An AI on this server reads one thing at a time. A WhatsApp reply that needs it goes
 * first: reading a call (minutes without a graphics card) is stopped and done again after,
 * so the complainant is answered at once.
 */
const ai = { replies: 0, call: null as AbortController | null };
async function aiTurn<T>(read: () => Promise<T>): Promise<T> {
  ai.replies++;
  ai.call?.abort();
  try {
    return await read();
  } finally {
    ai.replies--;
  }
}

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

// "error" connections are retried too: a Dograh outage or a refused key must not stop a
// workspace's calls for good once it recovers.
const connectedTenants = () => platformDb().select({ id: voiceConnections.tenantId }).from(voiceConnections).where(inArray(voiceConnections.status, ["ok", "error"]));

async function syncLoop() {
  while (!stopping) {
    try {
      for (const t of await connectedTenants()) {
        if (stopping) break;
        try {
          const s = await syncTenantCalls(t.id, { maxPerWorkflow: 100 });
          log("sync.tenant", { tenant: t.id.slice(0, 8), ...s, errors: s.errors.length, firstError: s.errors[0]?.slice(0, 160) });
        } catch (e) {
          log("sync.error", { tenant: t.id.slice(0, 8), message: (e as Error).message });
        }
        // A finished complaint call opens its case and starts WhatsApp now, not after the local AI.
        try {
          const n = await followUpCalls(t.id);
          if (n) log("cases.followed_up", { tenant: t.id.slice(0, 8), calls: n });
        } catch (e) {
          log("cases.followup_error", { tenant: t.id.slice(0, 8), message: (e as Error).message });
        }
      }
    } catch (e) {
      log("sync.error", { message: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, SYNC_MS));
  }
}

/**
 * Reads new transcripts apart from the sync, so a slow model (one on the client's own
 * server can take minutes a call) never holds up copying new calls. A call that fails
 * is tried again after the pause.
 */
async function analyzeLoop() {
  while (!stopping) {
    let progressed = false;
    try {
      for (const t of await connectedTenants()) {
        if (stopping) break;
        while (ai.replies > 0 && !stopping) await new Promise((r) => setTimeout(r, 2_000)); // a WhatsApp reply is using the AI
        ai.call = new AbortController();
        const a = await analyzeCalls(t.id, extractor!, { limit: 10, signal: ai.call.signal }).finally(() => (ai.call = null));
        if (a.analyzed || a.failed) log("analyze.tenant", { tenant: t.id.slice(0, 8), ...a });
        if (a.analyzed) progressed = true;
      }
    } catch (e) {
      log("analyze.error", { message: (e as Error).message });
    }
    if (!progressed) await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** Reads queued WhatsApp replies (oldest first) and, every 10 minutes, reminds complainants who went quiet. */
async function whatsappLoop() {
  let reader: ReturnType<typeof caseReaderFromEnv>;
  try {
    reader = caseReaderFromEnv(process.env, {
      ...(LOCAL_AI ? { aiTurn } : {}),
      onAiError: (e) => log("whatsapp.ai_unavailable", { message: e.message.slice(0, 200) }),
    });
  } catch (e) {
    // A reader set up wrongly (a cloud model on a police server): messages stay queued.
    log("whatsapp.no_reader", { message: (e as Error).message });
    return;
  }
  log("whatsapp.reader", { ai: reader.ai ? (LOCAL_AI ? "on this server" : "cloud") : "none: plain answers only" });
  let lastReminders = 0;
  let lastResend = 0;
  while (!stopping) {
    let progressed = false;
    try {
      const tenants = await platformDb().selectDistinct({ id: whatsappChannels.tenantId }).from(whatsappChannels).where(eq(whatsappChannels.status, "active"));
      for (const t of tenants) {
        if (stopping) break;
        const r = await processInbox(t.id, reader);
        if (r.handled || r.failed) log("whatsapp.inbox", { tenant: t.id.slice(0, 8), ...r });
        if (r.handled) progressed = true;
      }
      // The linked number is reconnected if the gateway dropped it, and a message WhatsApp could
      // not take (gateway busy, disconnected, pacing) goes again.
      if (Date.now() - lastResend > 2 * 60_000) {
        lastResend = Date.now();
        for (const t of tenants) {
          const k = await keepWhatsappConnected(t.id).catch((e: Error) => (log("whatsapp.gateway_error", { tenant: t.id.slice(0, 8), message: e.message.slice(0, 200) }), null));
          if (k?.reconnecting) log("whatsapp.reconnecting", { tenant: t.id.slice(0, 8), was: k.status });
          const n = await resendFailed(t.id);
          if (n) log("whatsapp.resent", { tenant: t.id.slice(0, 8), count: n });
        }
      }
      if (Date.now() - lastReminders > 10 * 60_000) {
        lastReminders = Date.now();
        for (const t of tenants) {
          const n = await remindPending(t.id);
          if (n) log("cases.reminded", { tenant: t.id.slice(0, 8), count: n });
        }
      }
    } catch (e) {
      log("whatsapp.error", { message: (e as Error).message });
    }
    if (!progressed) await new Promise((r) => setTimeout(r, 5_000));
  }
}

/** The government telephone line, checked every minute and kept for the portal's home page. */
async function lineLoop(cfg: NonNullable<ReturnType<typeof lineConfigFromEnv>>) {
  let last = "";
  while (!stopping) {
    try {
      const status = await checkLine(cfg, await readNetFacts());
      const row = { status: status as unknown as Record<string, unknown>, checkedAt: new Date() };
      await platformDb().insert(telephoneLineStatus).values({ id: "line", ...row }).onConflictDoUpdate({ target: telephoneLineStatus.id, set: row });
      const summary = `${status.overall}:${status.checks.filter((c) => c.state === "fail").map((c) => c.key).join(",")}`;
      if (summary !== last) log("line.status", { overall: status.overall, port: status.iface, failing: status.checks.filter((c) => c.state === "fail").map((c) => c.key) });
      last = summary;
    } catch (e) {
      log("line.error", { message: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, 60_000));
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

log("worker.started", { whatsapp: WHATSAPP, edition: POLICE ? "police" : "full", realDials: REAL, sync: SYNC, analyze: ANALYZE, syncSeconds: SYNC_MS / 1000, security: SECURITY, alertTopic: ALERT_TOPIC ? "sns" : "log", safety: SAFETY, safetyRecheckDays: RECHECK_DAYS, integrations: INTEGRATIONS });
void dialerLoop();
if (SYNC) void syncLoop();
if (SYNC && ANALYZE) void analyzeLoop();
if (SECURITY) void securityLoop();
if (SAFETY) void safetyLoop();
if (INTEGRATIONS) void integrationsLoop();
if (WHATSAPP) void whatsappLoop();
try {
  const line = lineConfigFromEnv();
  if (line) void lineLoop(line);
} catch (e) {
  log("line.config_error", { message: (e as Error).message });
}
