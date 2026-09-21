import { eq } from "drizzle-orm";
import { calls, campaignTargets, withTenant } from "@jenai/db";
import { apiError, apiOk, authenticate } from "@/server/api/key";

/** GET /api/v1/calls/{id} : the state of a call, by our call id or the id we returned when they asked for it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, "calls:read");
  if (!auth.ok) return apiError(auth.status, auth.error, auth.message);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(400, "bad_id", "That is not a call id.");
  const body = await withTenant(auth.caller.tenantId, async (tx) => {
    const [c] = await tx.select().from(calls).where(eq(calls.id, id));
    if (c) {
      const extracted = (c.extracted ?? {}) as Record<string, unknown>;
      return {
        id: c.id,
        state: c.status,
        direction: c.direction,
        started_at: c.startedAt.toISOString(),
        seconds: c.durationS,
        outcome: (extracted.outcome as string) ?? c.disposition ?? null,
        summary: c.summary,
        fields: extracted,
      };
    }
    const [t] = await tx.select().from(campaignTargets).where(eq(campaignTargets.id, id));
    if (!t) return null;
    return {
      id: t.id,
      state: t.state === "skipped" ? "not_called" : t.state,
      reason: t.skipReason,
      attempts: t.attemptNo,
      next_attempt_at: t.nextAttemptAt.toISOString(),
      call_id: t.lastCallId,
      outcome: t.lastOutcome,
    };
  });
  return body ? apiOk(body) : apiError(404, "not_found", "No such call in this workspace.");
}
