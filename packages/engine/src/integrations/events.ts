import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { agents, calls, campaignTargets, clientPrograms, contacts, leads, organizations, programTemplates, type Call, type Tx } from "@jenai/db";
import { verticalOf } from "../safety/cases";
import { enqueueEvent } from "./queue";
import type { Withheld } from "./types";

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

/**
 * Which try at reaching the person this was, for a call the dialer placed:
 * the count on its target, while the target is still on this call. Null for
 * a call they made to us, or once the target has been dialled again, rather
 * than a number that may be wrong.
 */
async function attemptOf(tx: Tx, c: Call): Promise<number | null> {
  if (c.direction !== "outbound") return null;
  const [t] = await tx
    .select({ attemptNo: campaignTargets.attemptNo, runId: campaignTargets.externalRunId })
    .from(campaignTargets)
    .where(c.targetId ? eq(campaignTargets.id, c.targetId) : eq(campaignTargets.externalRunId, c.externalRunId))
    .limit(1);
  return t && t.runId === c.externalRunId && t.attemptNo > 0 ? t.attemptNo : null;
}

/**
 * What a health call holds back from a system that has not chosen to have it
 * (sharedWith): the model's summary, which retells the whole conversation,
 * what they asked about, the recording, every answer, and the outcome, unless
 * the program marks that answer or outcome shareable. An allow list, so a
 * new program that forgets to mark its health questions still keeps them in.
 * An outcome held back reads as the lead stage it means, which the lead says
 * anyway. A call on no program has only the standard questions, and those
 * are the health history.
 */
export function healthWithheld(
  fields: Record<string, unknown>,
  outcome: string | null,
  program: { extraction: Array<{ name: string; shareable?: boolean }>; outcomes: Array<{ key: string; stage?: string; shareable?: boolean }> } | null,
): Withheld {
  const shareable = new Set((program?.extraction ?? []).filter((x) => x.shareable).map((x) => x.name));
  const names = ["summary", "concern", "recording", ...Object.keys(fields).filter((k) => !shareable.has(k))];
  const o = program?.outcomes.find((x) => x.key === outcome);
  return o && !o.shareable ? { names: [...names, "outcome"], outcome: o.stage ?? null } : { names };
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
  const [org] = await tx.select({ id: organizations.id, name: organizations.name, vertical: organizations.vertical }).from(organizations).where(eq(organizations.id, tenantId));
  const [program] = agent?.clientProgramId
    ? await tx
        .select({ key: programTemplates.key, name: clientPrograms.name, vertical: programTemplates.vertical, extraction: programTemplates.extraction, outcomes: programTemplates.outcomes })
        .from(clientPrograms)
        .innerJoin(programTemplates, and(eq(programTemplates.key, clientPrograms.programKey), eq(programTemplates.version, clientPrograms.programVersion)))
        .where(eq(clientPrograms.id, agent.clientProgramId))
    : [];
  // The lead this call moved, even one it just closed (a program's "paid" is
  // won), else the person's open lead (the database allows one), newest
  // first. Never an old closed one: its stage is not where they stand now.
  const [lead] = c.contactId
    ? await tx
        .select()
        .from(leads)
        .where(and(eq(leads.contactId, c.contactId), or(eq(leads.lastCallId, c.id), notInArray(leads.stage, ["won", "lost"]))))
        .orderBy(desc(sql`(${leads.lastCallId} = ${c.id}) is true`), desc(leads.createdAt))
        .limit(1)
    : [];
  const attempt = await attemptOf(tx, c);

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
      // What the call was about and where it left things, read from the call
      // itself. The agreed time is under appointment.
      attempt,
      concern: (extracted.concern as string) ?? null,
      interest_level: (extracted.interest_level as string) ?? null,
      next_step: (extracted.next_step as string) ?? null,
    },
    person: { contact_id: c.contactId, name: contact?.name ?? (extracted.caller_name as string) ?? null, phone },
    fields,
    lead: lead ? { id: lead.id, stage: lead.stage, next_follow_up_at: lead.nextFollowUpAt?.toISOString() ?? null } : null,
    appointment: extracted.preferred_time ? { at: String(extracted.preferred_time), booked: extracted.next_step === "booked" } : null,
  };

  // A health call is one on a health program, or for a health client when on none (as a safety check reads it).
  const health = verticalOf(program?.vertical ?? org?.vertical) === "health";
  return enqueueEvent(tx, tenantId, {
    kind: "call.completed",
    refType: "call",
    refId: c.id,
    payload,
    idempotencyKey: `call.completed:${c.id}`,
    withheld: health ? healthWithheld(fields, typeof extracted.outcome === "string" ? extracted.outcome : null, program ?? null) : undefined,
  });
}

/**
 * Why a queue write failed, without what it was writing. Drizzle's message
 * carries the statement's parameters (the person's phone and name, the
 * payload), and process logs leave the tenant boundary.
 */
function failure(e: unknown): string {
  const cause = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
  return [cause?.code ? `postgres ${cause.code}` : "", cause?.constraint_name ?? ""].filter(Boolean).join(" ") || (e as Error).name || "error";
}

/**
 * Queued when a lead's stage or follow-up date changes, by a call or by
 * someone on the team, so a CRM that tracks the same person keeps step. The
 * key carries the new state and the moment, so each change is one delivery.
 *
 * Like an opt-out, the change is already written in the same transaction, and
 * a queue error rolls back to a savepoint and is logged: handing it on must
 * never undo the change, or fail the call analysis it came from.
 */
export async function emitLeadUpdated(tx: Tx, tenantId: string, leadId: string, changed: Array<"stage" | "next_follow_up_at">, callId: string | null = null): Promise<number> {
  try {
    return await tx.transaction(async (sp) => {
      const [row] = await sp.select({ lead: leads, contact: contacts }).from(leads).leftJoin(contacts, eq(contacts.id, leads.contactId)).where(eq(leads.id, leadId));
      if (!row) return 0;
      const { lead, contact } = row;
      const followUp = lead.nextFollowUpAt?.toISOString() ?? null;
      return enqueueEvent(sp, tenantId, {
        kind: "lead.updated",
        refType: "lead",
        refId: lead.id,
        payload: {
          event: "lead.updated",
          at: new Date().toISOString(),
          // The same shape as call.completed's lead, so one field mapping (lead.stage) serves both.
          lead: { id: lead.id, stage: lead.stage, next_follow_up_at: followUp },
          changed,
          source_call: callId,
          person: { contact_id: lead.contactId, name: contact?.name ?? null, phone: contact?.phoneE164 ?? null },
        },
        idempotencyKey: `lead.updated:${lead.id}:${lead.stage}:${followUp ?? ""}:${lead.updatedAt.getTime()}`,
      });
    });
  } catch (e) {
    console.error(`[integrations] lead.updated not queued for tenant ${tenantId}: ${failure(e)}`);
    return 0;
  }
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

/**
 * Queued when someone asks not to be called, so their system stops too. The
 * contact id is how the queue finds their record for this person.
 *
 * The caller has already written the opt-out in the same transaction, and our
 * own suppression list is what stops the calls. So a queue error here rolls
 * back to a savepoint and is logged: it can never take the opt-out with it.
 */
export async function emitDoNotCall(tx: Tx, tenantId: string, phone: string, contactId: string | null, source: string): Promise<number> {
  try {
    return await tx.transaction((sp) =>
      enqueueEvent(sp, tenantId, {
        kind: "do_not_call.added",
        refType: "phone",
        refId: phone,
        payload: { event: "do_not_call.added", at: new Date().toISOString(), person: { contact_id: contactId, phone }, source },
        idempotencyKey: `do_not_call:${phone}:${new Date().toISOString().slice(0, 10)}`,
      }),
    );
  } catch (e) {
    console.error(`[integrations] do_not_call.added not queued for tenant ${tenantId}: ${failure(e)}`);
    return 0;
  }
}
