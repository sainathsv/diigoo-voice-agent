/**
 * JENAI background worker: the dialer loop and the calls sync loop.
 *
 * Safety switches (all default OFF):
 *   JENAI_REAL_DIALS=true   place real calls (still only for clients in managed mode with an API key)
 *   JENAI_SYNC=true         pull calls from the voice engine every JENAI_SYNC_SECONDS (default 300)
 *   JENAI_ANALYZE=true      read new transcripts with the analyzer (Bedrock Mumbai) after each sync
 * Without them the dialer uses the simulated carrier and nothing touches the live engine.
 */
import "@jenai/db/env";
import { eq } from "drizzle-orm";
import { platformDb, voiceConnections } from "@jenai/db";
import { BedrockExtractor, analyzeCalls, runDialerTick, syncTenantCalls } from "@jenai/engine";

const REAL = process.env.JENAI_REAL_DIALS === "true";
const SYNC = process.env.JENAI_SYNC === "true";
const ANALYZE = process.env.JENAI_ANALYZE === "true";
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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("worker.stopping", { signal: sig });
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

log("worker.started", { realDials: REAL, sync: SYNC, analyze: ANALYZE, syncSeconds: SYNC_MS / 1000 });
void dialerLoop();
if (SYNC) void syncLoop();
