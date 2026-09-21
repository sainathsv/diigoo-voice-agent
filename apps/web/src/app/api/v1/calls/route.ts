import { z } from "zod";
import { audit, withTenant } from "@jenai/db";
import { CallRequestError, ProgramSetupError, requestCall } from "@jenai/engine";
import { apiError, apiOk, authenticate } from "@/server/api/key";

/**
 * POST /api/v1/calls
 * Their system asks JENAI to call someone: a button in their CRM, a workflow
 * rule, their nightly job. The same rules as any other call still apply.
 */
const Body = z.object({
  program: z.string().min(1),
  phone: z.string().min(6),
  name: z.string().trim().max(80).optional(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  external_id: z.string().max(120).optional(),
  branch_id: z.uuid().optional(),
  idempotency_key: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const auth = await authenticate(req, "calls:create");
  if (!auth.ok) return apiError(auth.status, auth.error, auth.message);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return apiError(400, "bad_request", "Check the fields.", { problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  const b = parsed.data;
  try {
    const r = await requestCall(auth.caller.tenantId, {
      programKey: b.program,
      phone: b.phone,
      name: b.name ?? null,
      context: b.context ?? {},
      externalId: b.external_id ?? null,
      branchId: b.branch_id ?? auth.caller.branchId,
      idempotencyKey: b.idempotency_key ?? req.headers.get("idempotency-key") ?? undefined,
      source: `api key ${auth.caller.name}`,
    });
    await withTenant(auth.caller.tenantId, (tx) =>
      audit(tx, {
        tenantId: auth.caller.tenantId,
        actorUserId: null,
        via: "api",
        action: "call.requested_by_api",
        targetType: "campaign_target",
        targetId: r.targetId,
        summary: `${auth.caller.name} asked for a ${r.program.name} call`,
        diff: { external_id: b.external_id ?? null, preview: r.preview.action },
        ip: req.headers.get("x-jenai-client-ip"),
      }),
    );
    return apiOk(
      {
        status: r.status,
        call_request_id: r.targetId,
        program: r.program,
        will_call: r.preview.action !== "skip",
        outcome_preview: r.preview,
      },
      r.status === "duplicate" ? 200 : 202,
    );
  } catch (e) {
    if (e instanceof CallRequestError) return apiError(e.code === "missing_fields" ? 422 : 400, e.code, e.message, e.detail);
    // The program is not finished being set up (no number chosen, no agent live).
    if (e instanceof ProgramSetupError) return apiError(409, "not_ready", e.message);
    console.error("[api] call request failed", e);
    return apiError(500, "server_error", "Something went wrong at our end. Try again.");
  }
}
