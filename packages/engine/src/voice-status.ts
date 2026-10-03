/**
 * The complaint status lookup at the start of a call. As a call comes in, the voice engine
 * asks this server, with the token it keeps, whether the number calling has a complaint in
 * progress; the agent then tells the caller its status instead of taking the complaint
 * again. The answer is the status alone, never anything from the complaint.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { cases, platformDb, voiceStatusTokens, withTenant } from "@jenai/db";
import { toE164 } from "@jenai/voice";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * What the caller hears for a complaint still open. For now every open case is "In Progress"
 * (the department's instruction); later this reads the status officers set on the case.
 */
export function spokenStatus(status: string): string {
  return status === "closed" ? "none" : "In Progress";
}

/** A new token for this workspace (the one before stops working); only its hash is kept. */
export async function newStatusToken(tenantId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const row = { tokenSha256: sha256(token), createdAt: new Date() };
  await withTenant(tenantId, (tx) => tx.insert(voiceStatusTokens).values({ tenantId, ...row }).onConflictDoUpdate({ target: voiceStatusTokens.tenantId, set: row }));
  return token;
}

/** The workspace a token belongs to. Platform pool on purpose: the engine's request has no login. */
export async function tenantForStatusToken(token: string): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const [row] = await platformDb().select({ tenantId: voiceStatusTokens.tenantId }).from(voiceStatusTokens).where(eq(voiceStatusTokens.tokenSha256, sha256(token))).limit(1);
  return row?.tenantId ?? null;
}

/** The status to say to the number calling: that of its complaint in progress, or "none". */
export async function complaintStatusFor(tenantId: string, number: string | null | undefined): Promise<string> {
  const phone = toE164(String(number ?? ""));
  if (!phone) return "none";
  const [c] = await withTenant(tenantId, (tx) =>
    tx
      .select({ status: cases.status })
      .from(cases)
      .where(
        and(
          inArray(cases.status, ["collecting", "ready", "taken_up"]),
          // The number that called, the one it continued on, or the one given in a hidden-number WhatsApp chat.
          or(eq(cases.complainantE164, phone), sql`${cases.fields}->>'caller_number' = ${phone}`, sql`${cases.fields}->>'mobile_number' = ${phone}`),
        ),
      )
      .orderBy(desc(cases.updatedAt))
      .limit(1),
  );
  return c ? spokenStatus(c.status) : "none";
}
