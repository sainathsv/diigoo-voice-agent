/**
 * JENAI background worker: the dialer loop and the calls sync loop.
 *
 * Safety switches (all default OFF):
 *   JENAI_REAL_DIALS=true   place real calls (still only for clients in managed mode with an API key)
 *   JENAI_SYNC=true         pull calls from the voice engine every JENAI_SYNC_SECONDS (default 300)
 *   JENAI_ANALYZE=true      read new transcripts with the analyzer (Bedrock Mumbai, or a local model)
 *   JENAI_PULL=true         read the CRM (Zoho Leads and Contacts) and the front desk system
 *                           (Zenoti), read only, of each client who switched their call plan on,
 *                           every config.pull.intervalMinutes (default 10), JENAI_PULL_PAGES
 *                           requests a Zoho read (default 5, at least 2 a module),
 *                           JENAI_PULL_ZENOTI_CALLS calls a Zenoti read (default 30, at least 6),
 *                           JENAI_PULL_CONCURRENCY reads at a time (default 3), and plan their
 *                           calls again when a read brings something new
 * Without them the dialer uses the simulated carrier and nothing touches the live engine.
 * The call plan is a preview: the pull never dials, never creates campaign targets and never
 * writes to a client's CRM or front desk system.
 *
 * The AI safety loop is ON by default (JENAI_SAFETY=false turns it off): it runs
 * the red-team checks that publishing waits for, and re-checks live agents when
 * the suite or model changes, or after JENAI_SAFETY_RECHECK_DAYS (default 90).
 * Cost control for a large fleet: at most JENAI_SAFETY_SWEEP_PER_HOUR (default
 * 100) re-checks are queued per hour; publish checks always go first.
 *
 * The plan refresh loop is ON by default (JENAI_PLAN_REFRESH=false turns it off): every
 * client's call plan is worked out again at least hourly, and within a minute or so of
 * someone being added to or taken off a do-not-call list, JENAI_PLAN_REFRESH_CONCURRENCY
 * clients at a time (default 2). It reads only JENAI's own tables and never dials.
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
  acrossDatabases,
  claimDeliveries,
  claimPulls,
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
  claimReplans,
  deferReplan,
  errorText,
  pullAndPlan,
  pullAndPlanZenoti,
  replanTenant,
  requeueStuckPulls,
  runDialerTick,
  snsNotifier,
  syncTenantCalls,
  verifyAuditChains,
  ZENOTI_SYNC_CALLS,
  ZENOTI_TEST_CALLS,
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
const PULL = !POLICE && process.env.JENAI_PULL === "true"; // a police server sends nothing elsewhere
/** Requests a read may make. Each module is sure of 2 whatever this says (crm-sync), so a low number cannot starve one. */
const PULL_PAGES = Math.max(2, Number(process.env.JENAI_PULL_PAGES ?? 5) || 5);
/**
 * Calls to Zenoti a read may make. The clinic's other apps share Zenoti's 60 a minute, so a read
 * stays small; it is sure of the 6 a check of the key needs.
 */
const PULL_ZENOTI_CALLS = Math.max(ZENOTI_TEST_CALLS, Number(process.env.JENAI_PULL_ZENOTI_CALLS ?? ZENOTI_SYNC_CALLS) || ZENOTI_SYNC_CALLS);
/** Reads under way at once on this worker. Each is a different client's CRM; a slow one holds only its own slot. */
const PULL_CONCURRENCY = Math.max(1, Number(process.env.JENAI_PULL_CONCURRENCY ?? 3) || 3);
const REFRESH = !POLICE && process.env.JENAI_PLAN_REFRESH !== "false";
/** Plans worked out at once by the refresh loop. */
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.JENAI_PLAN_REFRESH_CONCURRENCY ?? 2) || 2);
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

/**
 * Runs up to `slots` jobs at once: as each ends, `claim` is asked for more,
 * so one slow job holds only its own slot. Waits `idleMs` when nothing was
 * claimed and nothing is running. `beforeClaim` runs at most once a minute.
 */
async function pool<T>(name: string, slots: number, claim: (n: number) => Promise<T[]>, run: (job: T) => Promise<void>, idleMs: number, beforeClaim?: () => Promise<void>) {
  const running = new Set<Promise<void>>();
  let lastHousekeeping = 0;
  while (!stopping) {
    try {
      if (beforeClaim && Date.now() - lastHousekeeping > 60_000) {
        lastHousekeeping = Date.now();
        await beforeClaim();
      }
      const free = slots - running.size;
      const jobs = free > 0 ? await claim(free) : [];
      for (const job of jobs) {
        const p: Promise<void> = run(job)
          .catch((e) => log(`${name}.error`, { message: errorText(e).slice(0, 200) }))
          .finally(() => running.delete(p));
        running.add(p);
      }
      if (!running.size) await new Promise((r) => setTimeout(r, idleMs));
      else if (!jobs.length || running.size >= slots) await Promise.race([...running, new Promise((r) => setTimeout(r, 5_000))]);
    } catch (e) {
      log(`${name}.error`, { message: errorText(e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, idleMs));
    }
  }
  await Promise.allSettled([...running]);
}

/**
 * Reads the CRM and the front desk system of each client who switched their
 * call plan on, when each is due, PULL_CONCURRENCY at a time, and plans that
 * client again when a read brings something new. One client failing is
 * logged and the rest carry on. Never dials, never creates campaign targets
 * and never writes to Zoho or Zenoti.
 */
async function pullLoop() {
  await pool(
    "plan",
    PULL_CONCURRENCY,
    async (n) => {
      const due = await acrossDatabases((db) => claimPulls(db, n));
      for (const e of due.errors) log("plan.error", { message: e });
      // Claimed on every database at once, so this can hand back more than asked for; all of it is read.
      return due.rows;
    },
    async (c) => {
      try {
        if (c.kind === "zenoti") {
          const r = await pullAndPlanZenoti(c.tenantId, c.id, { callBudget: PULL_ZENOTI_CALLS, lease: c.lease });
          const v = r.sync.visits;
          log("plan.pulled", {
            tenant: c.tenantId.slice(0, 8),
            kind: "zenoti",
            calls: r.sync.calls,
            bookings: r.sync.bookings.read,
            changed: r.sync.bookings.changed + r.sync.bookings.removed + v.added + v.updated + v.removed + v.numbered,
            guests: r.sync.guests.read,
            waitingForPhone: r.sync.waitingForPhone,
            caughtUp: r.sync.done,
            planned: r.plan?.rows ?? null,
            // What waits names days and centres, never a person.
            left: r.sync.left.map((x) => x.slice(0, 200)),
            error: (r.planError ?? r.sync.error)?.slice(0, 160),
          });
          return;
        }
        const r = await pullAndPlan(c.tenantId, c.id, { pageBudget: PULL_PAGES, scheduled: true, lease: c.lease });
        log("plan.pulled", {
          tenant: c.tenantId.slice(0, 8),
          kind: c.kind,
          read: r.sync.modules.reduce((n, m) => n + m.read, 0),
          changed: r.sync.modules.reduce((n, m) => n + m.changed, 0),
          deleted: r.sync.modules.reduce((n, m) => n + m.deleted, 0),
          pages: r.sync.pages,
          caughtUp: r.sync.done,
          planned: r.plan?.rows ?? null,
          broken: r.sync.connectionBroken ?? false,
          // Notes name modules and counts, never a person.
          notes: r.sync.modules.flatMap((m) => m.notes ?? []).map((x) => x.slice(0, 200)),
          error: (r.planError ?? r.sync.error)?.slice(0, 160),
        });
      } catch (e) {
        log("plan.pull_error", { tenant: c.tenantId.slice(0, 8), message: errorText(e).slice(0, 200) });
      }
    },
    15_000,
    async () => {
      const stuck = await acrossDatabases(async (db) => [await requeueStuckPulls(db)]);
      const n = stuck.rows.reduce((a, b) => a + b, 0);
      if (n) log("plan.pull_requeued", { count: n });
      for (const e of stuck.errors) log("plan.error", { message: e });
    },
  );
}

/**
 * Works out again every client plan that is due on its own clock (hourly,
 * sooner after a do-not-call change), REFRESH_CONCURRENCY at a time, claimed
 * so that several workers never do the same client. Runs whether or not
 * CRMs are read: a plan moves on with the days.
 */
async function refreshLoop() {
  await pool(
    "plan",
    REFRESH_CONCURRENCY,
    async (n) => {
      const due = await acrossDatabases((db) => claimReplans(db, n));
      for (const e of due.errors) log("plan.error", { message: e });
      return due.rows;
    },
    async (tenantId) => {
      try {
        const p = await replanTenant(tenantId);
        log("plan.refreshed", { tenant: tenantId.slice(0, 8), people: p.people, rows: p.rows, written: p.written, removed: p.removed });
      } catch (e) {
        await deferReplan(tenantId).catch(() => undefined);
        log("plan.refresh_error", { tenant: tenantId.slice(0, 8), message: errorText(e).slice(0, 200) });
      }
    },
    60_000,
  );
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("worker.stopping", { signal: sig });
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

log("worker.started", { whatsapp: WHATSAPP, edition: POLICE ? "police" : "full", realDials: REAL, sync: SYNC, analyze: ANALYZE, syncSeconds: SYNC_MS / 1000, security: SECURITY, alertTopic: ALERT_TOPIC ? "sns" : "log", safety: SAFETY, safetyRecheckDays: RECHECK_DAYS, integrations: INTEGRATIONS, pull: PULL, pullPages: PULL_PAGES, pullZenotiCalls: PULL_ZENOTI_CALLS, pullConcurrency: PULL_CONCURRENCY, planRefresh: REFRESH });
void dialerLoop();
if (SYNC) void syncLoop();
if (SYNC && ANALYZE) void analyzeLoop();
if (SECURITY) void securityLoop();
if (SAFETY) void safetyLoop();
if (INTEGRATIONS) void integrationsLoop();
if (WHATSAPP) void whatsappLoop();
if (PULL) void pullLoop();
if (REFRESH) void refreshLoop();
try {
  const line = lineConfigFromEnv();
  if (line) void lineLoop(line);
} catch (e) {
  log("line.config_error", { message: (e as Error).message });
}
