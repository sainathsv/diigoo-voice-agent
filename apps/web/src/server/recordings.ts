import "server-only";
import { eq, sql } from "drizzle-orm";
import { callRecordings, withTenant, type Tx } from "@jenai/db";
import { byteRange } from "@jenai/engine";

export interface HeldRecording {
  size: number;
  mime: string;
}

/** The copy of a call's recording kept on this server, if there is one (size and type only). */
export async function heldRecording(tx: Tx, callId: string): Promise<HeldRecording | null> {
  const [r] = await tx.select({ size: callRecordings.sizeBytes, mime: callRecordings.mime }).from(callRecordings).where(eq(callRecordings.callId, callId));
  return r ?? null;
}

/**
 * Plays a recording kept on this server. A Range is honoured so the player can
 * seek, and only the bytes asked for are read from the database.
 */
export async function serveHeldRecording(tenantId: string, callId: string, rec: HeldRecording, range: string | null): Promise<Response> {
  const r = byteRange(range, rec.size);
  if (!r) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${rec.size}` } });
  const { start, end, partial } = r;
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({ chunk: sql<Buffer>`substring(${callRecordings.bytes} from ${start + 1} for ${end - start + 1})` })
      .from(callRecordings)
      .where(eq(callRecordings.callId, callId)),
  );
  if (!row) return new Response("Recording unavailable", { status: 404 });
  const headers = new Headers({ "Content-Type": rec.mime, "Content-Length": String(row.chunk.length), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
  if (partial) headers.set("Content-Range", `bytes ${start}-${start + row.chunk.length - 1}/${rec.size}`);
  return new Response(new Uint8Array(row.chunk), { status: partial ? 206 : 200, headers });
}
