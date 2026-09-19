import { and, eq, notInArray } from "drizzle-orm";
import { leads, type Tx } from "@jenai/db";
import { zoned } from "./dialer/time";

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
 */
export async function deriveLead(
  tx: Tx,
  tenantId: string,
  input: { callId: string; contactId: string; branchId: string | null; extracted: Record<string, unknown>; at: Date },
): Promise<boolean> {
  const stage = stageFrom(input.extracted);
  if (!stage) return false;
  const x = input.extracted;
  const temp = ["hot", "warm", "cold"].includes(String(x.interest_level)) ? String(x.interest_level) : null;
  const [open] = await tx
    .select()
    .from(leads)
    .where(and(eq(leads.contactId, input.contactId), notInArray(leads.stage, ["won", "lost"])));
  const preferredAt = parsePreferredTime(x.preferred_time);
  if (!open) {
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
  await tx
    .update(leads)
    .set({
      lastCallId: input.callId,
      stage: RANK[stage] > RANK[open.stage as Stage] ? stage : open.stage,
      interest: open.interest ?? (x.concern as string) ?? null,
      preferredTimeText: (x.preferred_time as string) ?? open.preferredTimeText,
      preferredAt: preferredAt ?? open.preferredAt,
      temperature: temp ?? open.temperature,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, open.id));
  return true;
}
