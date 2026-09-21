import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, calls, clientPrograms, contacts, leads, organizations, programTemplates, type Tx } from "@jenai/db";
import { enqueueEvent } from "./queue";

/**
 * What JENAI hands back to the client's own system after a call. This shape is
 * a public contract: their CRM code reads it, so add fields, never rename them.
 */

export const EVENT_KINDS = ["call.completed", "lead.created", "lead.updated", "appointment.booked", "do_not_call.added"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * A link to the recording that works for a few days and then stops. The
 * client's CRM stores the link, not the audio, and every play is still checked
 * and recorded on our side.
 */
export function signRecordingLink(tenantId: string, callId: string, ttlSeconds = 7 * 24 * 3600, now = Date.now()): { url: string; expiresAt: Date } {
  const key = process.env.JENAI_DATA_KEY ?? "";
  const base = (process.env.JENAI_PUBLIC_URL ?? "http://localhost:3100").replace(/\/+$/, "");
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = createHmac("sha256", key).update(`${tenantId}.${callId}.${exp}`).digest("hex").slice(0, 32);
  return { url: `${base}/api/v1/recordings/${callId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000) };
}

export function checkRecordingLink(tenantId: string, callId: string, exp: string, sig: string, now = Date.now()): boolean {
  const seconds = Number(exp);
  if (!Number.isFinite(seconds) || seconds * 1000 < now) return false;
  const key = process.env.JENAI_DATA_KEY ?? "";
  const expected = createHmac("sha256", key).update(`${tenantId}.${callId}.${seconds}`).digest("hex").slice(0, 32);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Builds the call payload and queues it for every connected system. */
export async function emitCallCompleted(tx: Tx, tenantId: string, callId: string): Promise<number> {
  const [row] = await tx
    .select({ c: calls, agent: agents, contact: contacts })
    .from(calls)
    .leftJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(contacts, eq(contacts.id, calls.contactId))
    .where(eq(calls.id, callId));
  if (!row) return 0;
  const { c, agent, contact } = row;
  const [org] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, tenantId));
  const [program] = agent?.clientProgramId
    ? await tx
        .select({ key: programTemplates.key, name: clientPrograms.name, outcomes: programTemplates.outcomes })
        .from(clientPrograms)
        .innerJoin(programTemplates, and(eq(programTemplates.key, clientPrograms.programKey), eq(programTemplates.version, clientPrograms.programVersion)))
        .where(eq(clientPrograms.id, agent.clientProgramId))
    : [];
  const [lead] = c.contactId ? await tx.select().from(leads).where(eq(leads.contactId, c.contactId)).limit(1) : [];

  const extracted = (c.extracted ?? {}) as Record<string, unknown>;
  const standard = new Set(["caller_name", "concern", "preferred_time", "interest_level", "next_step", "do_not_call", "summary", "outcome"]);
  const fields = Object.fromEntries(Object.entries(extracted).filter(([k]) => !standard.has(k)));
  const phone = c.direction === "inbound" ? c.fromE164 : c.toE164;
  const recording = c.recordingRef ? signRecordingLink(tenantId, c.id) : null;

  const payload = {
    event: "call.completed",
    at: new Date().toISOString(),
    workspace: { id: org?.id, name: org?.name },
    program: program ? { key: program.key, name: program.name } : null,
    call: {
      id: c.id,
      direction: c.direction,
      started_at: c.startedAt.toISOString(),
      seconds: c.durationS ?? null,
      status: c.status,
      outcome: (extracted.outcome as string) ?? c.disposition ?? null,
      outcome_label: program?.outcomes.find((o) => o.key === extracted.outcome)?.label ?? null,
      summary: c.summary ?? null,
      recording_url: recording?.url ?? null,
      recording_expires_at: recording?.expiresAt.toISOString() ?? null,
      agent: agent?.name ?? null,
    },
    person: { contact_id: c.contactId, name: contact?.name ?? (extracted.caller_name as string) ?? null, phone },
    fields,
    lead: lead ? { id: lead.id, stage: lead.stage, next_follow_up_at: lead.nextFollowUpAt?.toISOString() ?? null } : null,
    appointment: extracted.preferred_time ? { at: String(extracted.preferred_time), booked: extracted.next_step === "booked" } : null,
  };

  return enqueueEvent(tx, tenantId, {
    kind: "call.completed",
    refType: "call",
    refId: c.id,
    payload,
    idempotencyKey: `call.completed:${c.id}`,
  });
}

/** Queued when a call books a visit, for systems that keep a diary. */
export async function emitAppointmentBooked(tx: Tx, tenantId: string, callId: string, when: string): Promise<number> {
  const [c] = await tx.select().from(calls).where(eq(calls.id, callId));
  if (!c) return 0;
  const [contact] = c.contactId ? await tx.select().from(contacts).where(eq(contacts.id, c.contactId)) : [];
  return enqueueEvent(tx, tenantId, {
    kind: "appointment.booked",
    refType: "call",
    refId: c.id,
    payload: {
      event: "appointment.booked",
      at: new Date().toISOString(),
      appointment: { at: when, source_call: c.id },
      person: { contact_id: c.contactId, name: contact?.name ?? null, phone: c.direction === "inbound" ? c.fromE164 : c.toE164 },
    },
    idempotencyKey: `appointment.booked:${c.id}`,
  });
}

/** Queued when someone asks not to be called, so their system stops too. */
export async function emitDoNotCall(tx: Tx, tenantId: string, phone: string, source: string): Promise<number> {
  return enqueueEvent(tx, tenantId, {
    kind: "do_not_call.added",
    refType: "phone",
    refId: phone,
    payload: { event: "do_not_call.added", at: new Date().toISOString(), person: { phone }, source },
    idempotencyKey: `do_not_call:${phone}:${new Date().toISOString().slice(0, 10)}`,
  });
}
