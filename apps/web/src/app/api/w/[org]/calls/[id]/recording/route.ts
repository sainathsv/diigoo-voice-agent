import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { can } from "@jenai/authz";
import { audit, calls, withTenant } from "@jenai/db";
import { voiceClient } from "@jenai/engine";
import { actorFields, requireWorkspace } from "@/server/access";
import { heldRecording, serveHeldRecording } from "@/server/recordings";
import { requestMeta } from "@/server/session";
import { logDenied } from "@/server/security-log";

/**
 * Recording playback behind a permission check. A copy kept on this server is
 * played from here; otherwise the engine's download URL (never sent to the
 * browser) is fetched server-side and streamed, with Range forwarded so the
 * player can seek. Each first request is audited.
 */
export async function GET(req: Request, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const ctx = await requireWorkspace(slug);
  const found = await withTenant(ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(calls).where(eq(calls.id, id));
    const held = c ? await heldRecording(tx, id) : null;
    const v = c && !held ? await voiceClient(tx, ctx.org.id) : null;
    return { c, held, v };
  });
  const c = found.c;
  const has = !!c && (!!found.held || !!c.recordingRef);
  if (!c || !has || !can(ctx.access, "recordings:play", { branchId: c.branchId })) {
    if (!c || has) await logDenied(ctx, { perm: "recordings:play", id });
    return new NextResponse("Not found", { status: 404 });
  }
  if (!found.held && !found.v) return new NextResponse("Voice engine not connected", { status: 503 });

  const range = req.headers.get("range");
  if (!range || /^bytes=0-/.test(range)) {
    await withTenant(ctx.org.id, async (tx) =>
      audit(tx, { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()), action: "call.recording_played", targetType: "call", targetId: id, summary: "Played a call recording" }),
    );
  }
  if (found.held) return serveHeldRecording(ctx.org.id, id, found.held, range);
  const upstream = await found.v!.client.fetchArtifact(c.recordingRef!, range);
  if (!upstream.ok && upstream.status !== 206) return new NextResponse("Recording unavailable", { status: 502 });
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "audio/wav", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" });
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
