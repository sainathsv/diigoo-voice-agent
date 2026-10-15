import { and, eq, notInArray } from "drizzle-orm";
import { leads, type Tx } from "@jenai/db";
import { zoned } from "./dialer/time";
import { emitLeadUpdated } from "./integrations/events";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parses the engine's "20 Aug 2026, 2:00 PM" (or "20 Aug 2026") in IST. Returns null otherwise. */
export function parsePreferredTime(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
  if (!month) return null;
  let hour = m[4] ? Number(m[4]) : 10;
  const min = m[5] ? Number(m[5]) : 0;
  const ampm = m[6]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  return zoned(Number(m[3]), month, Number(m[1]), hour * 60 + min, "Asia/Kolkata");
}

type Stage = "new" | "contacted" | "callback" | "booked" | "won" | "lost";
const RANK: Record<Stage, number> = { new: 0, contacted: 1, callback: 2, booked: 3, won: 4, lost: 4 };

export function stageFrom(extracted: Record<string, unknown>): Stage | null {
  const next = String(extracted.next_step ?? "").toLowerCase();
  const temp = String(extracted.interest_level ?? "").toLowerCase();
  if (next === "booked") return "booked";
  if (next === "callback" || next === "whatsapp") return "callback";
  if (temp === "hot" || temp === "warm" || extracted.concern) return "new";
  return null;
}

/**
 * Create or advance the contact's open lead from a finished call. Stages only
 * move forward automatically; people move them back by hand.
 *
 * A call program says what its own outcomes mean for the lead (paid is won, a
 * dispute goes back to callback), and that stage is set as it says, on the
 * open lead only: a lead closed before stays closed. Done here, in the same
 * update, so a call hands on one change, in the right order, before its
 * call.completed is queued.
 */
export async function deriveLead(
  tx: Tx,
  tenantId: string,
  input: { callId: string; contactId: string; branchId: string | null; extracted: Record<string, unknown>; at: Date; programStage?: string | null },
): Promise<boolean> {
  const auto = stageFrom(input.extracted);
  // Checked, not cast: a stage the database does not know would fail the whole analysis.
  const said = input.programStage && Object.hasOwn(RANK, input.programStage) ? (input.programStage as Stage) : null;
  if (!auto && !said) return false;
  const x = input.extracted;
  const temp = ["hot", "warm", "cold"].includes(String(x.interest_level)) ? String(x.interest_level) : null;
  const [open] = await tx
    .select()
    .from(leads)
    .where(and(eq(leads.contactId, input.contactId), notInArray(leads.stage, ["won", "lost"])));
  const preferredAt = parsePreferredTime(x.preferred_time);
  if (!open) {
    // A program's outcome moves a lead; on its own it does not open one.
    if (!auto) return false;
    const stage = said ?? auto;
    await tx.insert(leads).values({
      tenantId,
      contactId: input.contactId,
      branchId: input.branchId,
      source: "call",
      firstCallId: input.callId,
      lastCallId: input.callId,
      stage,
      interest: (x.concern as string) ?? null,
      preferredTimeText: (x.preferred_time as string) ?? null,
      preferredAt,
      temperature: temp,
      nextFollowUpAt: stage === "callback" ? (preferredAt ?? new Date(input.at.getTime() + 86_400_000)) : null,
    });
    return true;
  }
  const stage = said ?? (auto && RANK[auto] > RANK[open.stage as Stage] ? auto : (open.stage as Stage));
  await tx
    .update(leads)
    .set({
      lastCallId: input.callId,
      stage,
      interest: open.interest ?? (x.concern as string) ?? null,
      preferredTimeText: (x.preferred_time as string) ?? open.preferredTimeText,
      preferredAt: preferredAt ?? open.preferredAt,
      temperature: temp ?? open.temperature,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, open.id));
  if (stage !== open.stage) await emitLeadUpdated(tx, tenantId, open.id, ["stage"], input.callId);
  return true;
}
