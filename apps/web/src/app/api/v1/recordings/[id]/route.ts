import { eq } from "drizzle-orm";
import { audit, calls, platformDb, withTenant } from "@jenai/db";
import { checkRecordingLink, voiceClient } from "@jenai/engine";

/**
 * GET /api/v1/recordings/{callId}?exp=...&sig=...
 * The link JENAI puts in a CRM note. It carries its own permission (a signature
 * that expires), so the client's staff can listen from their own system without
 * a JENAI login. Every play is still recorded in the activity log.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const exp = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  // The link does not carry the workspace; find it, then check the signature against it.
  const [owner] = await platformDb().select({ tenantId: calls.tenantId }).from(calls).where(eq(calls.id, id));
  if (!owner || !checkRecordingLink(owner.tenantId, id, exp, sig)) {
    return new Response("This link is wrong or has expired. Open the call in JENAI instead.", { status: 403 });
  }

  const found = await withTenant(owner.tenantId, async (tx) => {
    const [c] = await tx.select().from(calls).where(eq(calls.id, id));
    const v = c?.recordingRef ? await voiceClient(tx, owner.tenantId) : null;
    return { c, v };
  });
  if (!found.c?.recordingRef) return new Response("No recording for this call", { status: 404 });
  if (!found.v) return new Response("The voice engine is not connected", { status: 503 });

  const range = req.headers.get("range");
  if (!range || /^bytes=0-/.test(range)) {
    await withTenant(owner.tenantId, async (tx) =>
      audit(tx, {
        tenantId: owner.tenantId,
        actorUserId: null,
        via: "api",
        action: "call.recording_played",
        targetType: "call",
        targetId: id,
        summary: "Played a call recording from a link in their own system",
        ip: req.headers.get("x-jenai-client-ip"),
        userAgent: req.headers.get("user-agent"),
      }),
    );
  }
  const res = await found.v.client.fetchArtifact(found.c.recordingRef, range ?? undefined);
  if (!res.ok && res.status !== 206) return new Response("Could not fetch the recording", { status: 502 });
  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers });
}
