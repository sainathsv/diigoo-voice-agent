import { clientPrograms, withTenant } from "@jenai/db";
import { callableProgram } from "@jenai/engine";
import { apiError, apiOk, authenticate } from "@/server/api/key";

/** GET /api/v1/programs : what this workspace can be asked to call about, and the data each call needs. */
export async function GET(req: Request) {
  const auth = await authenticate(req, "programs:read");
  if (!auth.ok) return apiError(auth.status, auth.error, auth.message);
  const list = await withTenant(auth.caller.tenantId, async (tx) => {
    const mine = await tx.select().from(clientPrograms);
    const out = [];
    for (const m of mine) {
      const p = await callableProgram(tx, m.programKey);
      if (p) out.push(p);
    }
    return out;
  });
  return apiOk({ programs: list });
}
