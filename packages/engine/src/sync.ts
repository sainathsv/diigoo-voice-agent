import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, callRecordings, calls, contacts, withTenant, type Agent, type Tx } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN, toE164, type DograhClient, type DograhRun } from "@jenai/voice";
import { deriveLead } from "./leads";
import { emitCallCompleted } from "./integrations/events";
import { copyRecording, type Recording } from "./recordings";
import { markConnection, voiceClient } from "./voice-conn";

export interface SyncStats {
  workflows: number;
  runsSeen: number;
  inserted: number;
  updated: number;
  leadsTouched: number;
  /** Finished calls whose transcript could not be downloaded this time (retried for 48 hours). */
  transcriptMisses: number;
  /** Recordings copied to this server this time (when recordings are kept here). */
  recordingsStored: number;
  /** Finished calls whose recording could not be copied this time (retried for 48 hours). */
  recordingMisses: number;
  failedWorkflows: number;
  errors: string[];
}

/** A finished call is re-read while its transcript (or kept recording) is still missing, for this long after the call. */
const RETRY_MS = 48 * 3_600_000;
/** Pages of run history read per workflow per sync (50 runs each), so a busy line stays cheap. */
const MAX_PAGES = 10;

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

interface SyncOptions {
  max: number;
  fetchTranscripts: boolean;
  /** Keep a copy of each recording in this server's database (a client's private server). */
  storeRecordings: boolean;
  /** Re-read every answered call still missing something, however old. */
  full: boolean;
  /** Calls before this moment are never imported (JENAI_SYNC_SINCE: e.g. test calls made before going live). */
  since: Date | null;
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

async function syncOne(tx: Tx, tenantId: string, client: DograhClient, agent: Agent, wf: number, direction: "inbound" | "outbound", o: SyncOptions, stats: SyncStats) {
  const { max, fetchTranscripts, storeRecordings, full, since } = o;
  // Newest first. Runs from the last 48 hours are all looked at, so a recent call that is still
  // open (in progress, or a download failed) is retried even behind newer finished ones; older
  // than that, the first run already held as finished ends the scan.
  const collected: DograhRun[] = [];
  // Runs whose recording is already kept here, so a re-read never downloads it twice.
  const stored = new Set<string | null>();
  for (let page = 1; collected.length < max && page <= MAX_PAGES; page++) {
    const p = await client.listRuns(wf, page, Math.min(50, max));
    if (!p.runs.length) break;
    const ids = p.runs.map((r) => String(r.id));
    const known = await tx
      .select({
        id: calls.externalRunId,
        status: calls.status,
        hasTranscript: sql<boolean>`${calls.transcript} is not null`,
        hasRecording: sql<boolean>`exists (select 1 from ${callRecordings} where ${callRecordings.tenantId} = ${calls.tenantId} and ${callRecordings.callId} = ${calls.id})`,
        startedAt: calls.startedAt,
      })
      .from(calls)
      .where(and(eq(calls.provider, "dograh"), inArray(calls.externalRunId, ids)));
    for (const k of known) if (k.hasRecording) stored.add(k.id);
    // Finished means nothing left to fetch. A recent call whose transcript (or, where recordings
    // are kept here, recording) download failed stays open, so the next sync fills it in. Dograh
    // marks a run finished before it uploads them, so a missing link is retried too. A full
    // re-read (--refetch) retries every answered call still missing one, however old.
    const retry = (k: (typeof known)[number]) =>
      k.status === "completed" &&
      ((fetchTranscripts && !k.hasTranscript) || (storeRecordings && !k.hasRecording)) &&
      (full || Date.now() - k.startedAt.getTime() < RETRY_MS);
    const done = new Set(known.filter((k) => k.status !== "in_progress" && k.status !== "unknown" && !retry(k)).map((k) => k.id));
    let reachedKnown = false;
    for (const r of p.runs) {
      // Newest first: the first run before the start date ends the scan.
      if (since && new Date(r.created_at) < since) {
        reachedKnown = true;
        break;
      }
      if (done.has(String(r.id))) {
        if (full || Date.now() - new Date(r.created_at).getTime() < RETRY_MS) continue;
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
        const res = await client.fetchArtifact(run.transcript_public_url, undefined, 30_000);
        if (res.ok) transcript = (await res.text()).slice(0, 200_000);
        else {
          stats.transcriptMisses++;
          if (stats.transcriptMisses === 1) stats.errors.push(`run ${summary.id}: transcript download refused (${res.status})`);
        }
      }
      let recording: Recording | null = null;
      if (storeRecordings && run.is_completed && run.recording_public_url && !stored.has(String(run.id))) {
        const got = await copyRecording(client, run.recording_public_url);
        if (typeof got !== "string") recording = got;
        else {
          stats.recordingMisses++;
          if (stats.recordingMisses === 1) stats.errors.push(`run ${summary.id}: recording not copied (${got})`);
        }
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
          .onConflictDoUpdate({
            target: [calls.tenantId, calls.provider, calls.externalRunId],
            set: {
              ...values,
              transcript: sql`coalesce(excluded.transcript, ${calls.transcript})`,
              // Until the analyser has read the call the engine's newer values win; after that,
              // what the analyser found stays and the engine's fields only fill gaps.
              extracted: sql`case when ${calls.analyzedAt} is null then ${calls.extracted} || excluded.extracted else excluded.extracted || ${calls.extracted} end`,
              summary: sql`case when ${calls.analyzedAt} is null then coalesce(excluded.summary, ${calls.summary}) else coalesce(${calls.summary}, excluded.summary) end`,
              disposition: sql`coalesce(excluded.disposition, ${calls.disposition})`,
            },
          })
          .returning({ id: calls.id, inserted: sql<boolean>`(xmax = 0)` });
        if (row?.inserted) stats.inserted++;
        else stats.updated++;
        if (recording) {
          const kept = await sp
            .insert(callRecordings)
            .values({ tenantId, callId: row!.id, mime: recording.mime, bytes: recording.bytes, sizeBytes: recording.bytes.length, sha256: recording.sha256 })
            .onConflictDoNothing()
            .returning({ callId: callRecordings.callId });
          if (kept.length) stats.recordingsStored++;
        }
        // A police complaint is not a sales lead.
        if (agent.domain !== CYBER_INTAKE_DOMAIN && contactId && status === "completed" && (await deriveLead(sp, tenantId, { callId: row!.id, contactId, branchId: agent.branchId, extracted, at: startedAt }))) stats.leadsTouched++;
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
/** JENAI_SYNC_SINCE as a date; a value that is not a date is refused rather than ignored. */
export function syncSinceFromEnv(env: Record<string, string | undefined> = process.env): Date | null {
  const v = env.JENAI_SYNC_SINCE?.trim();
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`JENAI_SYNC_SINCE is not a date: ${v}`);
  return d;
}

export async function syncTenantCalls(
  tenantId: string,
  opts: { maxPerWorkflow?: number; fetchTranscripts?: boolean; full?: boolean; storeRecordings?: boolean; since?: Date | null } = {},
): Promise<SyncStats> {
  const stats: SyncStats = { workflows: 0, runsSeen: 0, inserted: 0, updated: 0, leadsTouched: 0, transcriptMisses: 0, recordingsStored: 0, recordingMisses: 0, failedWorkflows: 0, errors: [] };
  // A client's own server keeps every recording there (JENAI_STORE_RECORDINGS=true; always in the police edition).
  const o: SyncOptions = {
    max: opts.maxPerWorkflow ?? 50,
    fetchTranscripts: opts.fetchTranscripts ?? true,
    storeRecordings: opts.storeRecordings ?? (process.env.JENAI_STORE_RECORDINGS === "true" || process.env.JENAI_EDITION === "police"),
    full: opts.full ?? false,
    since: opts.since !== undefined ? opts.since : syncSinceFromEnv(),
  };
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
        await withTenant(tenantId, (tx) => syncOne(tx, tenantId, setup.v!.client, agent, wf, dir, o, stats));
      } catch (e) {
        stats.failedWorkflows++;
        stats.errors.push(`workflow ${wf}: ${(e as Error).message}`);
      }
    }
  }
  await withTenant(tenantId, (tx) =>
    // Only a connection where every workflow failed is broken; one retired or missing agent is not.
    markConnection(
      tx,
      tenantId,
      stats.workflows > 0 && stats.failedWorkflows === stats.workflows
        ? { status: "error", lastError: stats.errors[0]!.slice(0, 300) }
        : { status: "ok", lastError: stats.errors[0]?.slice(0, 300) ?? null, lastSyncAt: new Date() },
    ),
  );
  return stats;
}

