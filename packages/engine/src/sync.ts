import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, calls, contacts, withTenant, type Agent, type Tx } from "@jenai/db";
import { toE164, type DograhClient, type DograhRun } from "@jenai/voice";
import { deriveLead } from "./leads";
import { emitCallCompleted } from "./integrations/events";
import { markConnection, voiceClient } from "./voice-conn";

export interface SyncStats {
  workflows: number;
  runsSeen: number;
  inserted: number;
  updated: number;
  leadsTouched: number;
  errors: string[];
}

const INTERNAL_KEYS = new Set(["nodes_visited", "extracted_variables", "call_tags", "_meta"]);

function cleanExtracted(g: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g ?? {})) {
    if (INTERNAL_KEYS.has(k) || v === null || v === "" || v === undefined) continue;
    out[k] = v;
  }
  const nested = (g?.extracted_variables ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(nested)) if (out[k] === undefined && v !== null && v !== "") out[k] = v;
  return out;
}

function statusOf(run: DograhRun, durationS: number | null): "in_progress" | "completed" | "no_answer" | "failed" {
  if (!run.is_completed) return "in_progress";
  const disp = String(run.gathered_context?.call_disposition ?? "").toLowerCase();
  if (/no.?answer|busy|unreachable/.test(disp)) return "no_answer";
  if (/fail|error/.test(disp)) return "failed";
  if (!durationS || durationS < 3) return "no_answer";
  return "completed";
}

function summarize(x: Record<string, unknown>): string | null {
  const parts = [x.concern, x.next_step && `next step: ${x.next_step}`, x.preferred_time && `time: ${x.preferred_time}`].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

async function upsertContact(tx: Tx, tenantId: string, phone: string, name: string | null, branchId: string | null, at: Date): Promise<string> {
  const [row] = await tx
    .insert(contacts)
    .values({ tenantId, phoneE164: phone, name, branchId, source: "call", tags: [], firstSeenAt: at, lastCallAt: at })
    .onConflictDoUpdate({
      target: [contacts.tenantId, contacts.phoneE164],
      set: { lastCallAt: sql`greatest(${contacts.lastCallAt}, excluded.last_call_at)`, name: sql`coalesce(${contacts.name}, excluded.name)`, updatedAt: new Date() },
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function syncOne(tx: Tx, tenantId: string, client: DograhClient, agent: Agent, wf: number, direction: "inbound" | "outbound", max: number, fetchTranscripts: boolean, stats: SyncStats) {
  // Newest first; stop at the first run we already hold as finished.
  const collected: DograhRun[] = [];
  for (let page = 1; collected.length < max; page++) {
    const p = await client.listRuns(wf, page, Math.min(50, max));
    if (!p.runs.length) break;
    const ids = p.runs.map((r) => String(r.id));
    const known = await tx
      .select({ id: calls.externalRunId, status: calls.status })
      .from(calls)
      .where(and(eq(calls.provider, "dograh"), inArray(calls.externalRunId, ids)));
    const done = new Set(known.filter((k) => k.status !== "in_progress" && k.status !== "unknown").map((k) => k.id));
    let reachedKnown = false;
    for (const r of p.runs) {
      if (done.has(String(r.id))) {
        reachedKnown = true;
        break;
      }
      collected.push(r);
      if (collected.length >= max) break;
    }
    if (reachedKnown || page >= p.total_pages) break;
  }
  stats.runsSeen += collected.length;

  for (const summary of collected) {
    try {
      const run = await client.getRun(wf, summary.id);
      const ic = (run.initial_context ?? {}) as Record<string, unknown>;
      const dir = run.call_type === "inbound" || run.call_type === "outbound" ? run.call_type : direction;
      const caller = toE164(String(ic.caller_number ?? ic.from_number ?? ""));
      const called = toE164(String(ic.called_number ?? ic.phone_number ?? ic.to_number ?? ""));
      const person = dir === "inbound" ? caller : (toE164(String(ic.phone_number ?? "")) ?? called);
      const durationS = run.cost_info?.call_duration_seconds != null ? Math.round(Number(run.cost_info.call_duration_seconds)) : null;
      const extracted = cleanExtracted(run.gathered_context);
      const startedAt = new Date(run.created_at);
      const status = statusOf(run, durationS);
      let transcript: string | null = null;
      if (fetchTranscripts && run.is_completed && run.transcript_public_url) {
        const res = await client.fetchArtifact(run.transcript_public_url);
        if (res.ok) transcript = (await res.text()).slice(0, 200_000);
      }
      // Network work is done above; database writes for this call get their own savepoint,
      // so one bad record cannot abort the rest of the batch.
      await tx.transaction(async (sp) => {
        const contactId = person ? await upsertContact(sp, tenantId, person, (extracted.caller_name as string) ?? (ic.caller_name as string) ?? null, agent.branchId, startedAt) : null;
        const values = {
          tenantId,
          branchId: agent.branchId,
          agentId: agent.id,
          agentVersionId: agent.liveVersionId,
          contactId,
          direction: dir,
          status,
          provider: "dograh",
          externalRunId: String(run.id),
          externalWorkflowId: wf,
          fromE164: dir === "inbound" ? caller : called,
          toE164: dir === "inbound" ? called : person,
          startedAt,
          durationS,
          disposition: (extracted.next_step as string) ?? (run.gathered_context?.call_disposition as string) ?? null,
          summary: summarize(extracted),
          transcript,
          extracted,
          recordingRef: run.recording_public_url ?? null,
          transcriptRef: run.transcript_public_url ?? null,
          syncedAt: new Date(),
        };
        const [row] = await sp
          .insert(calls)
          .values(values)
          .onConflictDoUpdate({ target: [calls.tenantId, calls.provider, calls.externalRunId], set: { ...values, transcript: sql`coalesce(excluded.transcript, ${calls.transcript})` } })
          .returning({ id: calls.id, inserted: sql<boolean>`(xmax = 0)` });
        if (row?.inserted) stats.inserted++;
        else stats.updated++;
        if (contactId && status === "completed" && (await deriveLead(sp, tenantId, { callId: row!.id, contactId, branchId: agent.branchId, extracted, at: startedAt }))) stats.leadsTouched++;
        // Hand the call back to the client's own system. When the analyser is on it
        // emits later with the outcome; the same key means only one delivery either way.
        if (status === "completed" && (process.env.JENAI_ANALYZE !== "true" || !transcript)) await emitCallCompleted(sp, tenantId, row!.id);
      });
    } catch (e) {
      stats.errors.push(`run ${summary.id}: ${(e as Error).message}`);
    }
  }
}

/**
 * Pull new calls for one client from the voice engine. Read-only against the
 * engine; idempotent (upsert on the engine's run id). Limited per workflow so
 * a first sync never floods the database.
 */
export async function syncTenantCalls(tenantId: string, opts: { maxPerWorkflow?: number; fetchTranscripts?: boolean } = {}): Promise<SyncStats> {
  const stats: SyncStats = { workflows: 0, runsSeen: 0, inserted: 0, updated: 0, leadsTouched: 0, errors: [] };
  const max = opts.maxPerWorkflow ?? 50;
  const setup = await withTenant(tenantId, async (tx) => {
    const v = await voiceClient(tx, tenantId);
    const list = v ? await tx.select().from(agents).where(eq(agents.status, "active")) : [];
    return { v, list };
  });
  if (!setup.v) return { ...stats, errors: ["No voice connection"] };
  for (const agent of setup.list) {
    for (const [wf, dir] of [
      [agent.inboundWorkflowId, "inbound"],
      [agent.outboundWorkflowId, "outbound"],
    ] as const) {
      if (!wf) continue;
      stats.workflows++;
      try {
        // One transaction per workflow keeps each batch atomic without holding locks across the whole sync.
        await withTenant(tenantId, (tx) => syncOne(tx, tenantId, setup.v!.client, agent, wf, dir, max, opts.fetchTranscripts ?? true, stats));
      } catch (e) {
        stats.errors.push(`workflow ${wf}: ${(e as Error).message}`);
      }
    }
  }
  await withTenant(tenantId, (tx) =>
    markConnection(tx, tenantId, stats.errors.length && !stats.inserted && !stats.updated ? { status: "error", lastError: stats.errors[0]!.slice(0, 300) } : { status: "ok", lastError: null, lastSyncAt: new Date() }),
  );
  return stats;
}

