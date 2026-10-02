import { NextResponse } from "next/server";
import { channelByOpenWaSession, channelCredentials, parseOpenWaWebhook, queueInbound, recordLink, recordStatuses, validSignature } from "@jenai/engine";

/**
 * Events from the OpenWA gateway on this server. Each session belongs to one
 * workspace, and nothing in a delivery is acted on until the signature made with
 * that workspace's secret checks out. Messages are only queued here; the worker
 * reads them (a model on this server can take minutes), so OpenWA gets its answer
 * at once and does not resend.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 25_000_000) return new NextResponse("Too large", { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }
  const ev = parseOpenWaWebhook(body);
  if (!ev) return new NextResponse("Bad request", { status: 400 });
  const ch = await channelByOpenWaSession(ev.sessionId);
  const secret = ch ? channelCredentials(ch)?.webhookSecret : null;
  if (!ch || ch.mode !== "openwa" || ch.status !== "active" || !secret) return new NextResponse("Unknown session", { status: 404 });
  if (!validSignature(raw, req.headers.get("x-openwa-signature"), secret)) return new NextResponse("Bad signature", { status: 401 });
  if (ev.kind === "message") await queueInbound(ch.tenantId, ev.message);
  else if (ev.kind === "ack") await recordStatuses(ch.tenantId, [{ id: ev.id, status: ev.status }]);
  else if (ev.kind === "link") await recordLink(ch.tenantId, ev);
  return NextResponse.json({ ok: true });
}
