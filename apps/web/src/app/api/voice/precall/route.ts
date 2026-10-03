import { NextResponse } from "next/server";
import { complaintStatusFor, tenantForStatusToken } from "@jenai/engine";

/**
 * The voice engine's pre-call lookup: as a call comes in, it asks whether the number calling
 * has a complaint in progress, with the token it keeps as a credential. The answer is the
 * status alone, which the call script reads as {{complaint_status}}. nginx lets only the
 * voice engine's private network address reach this.
 */
export async function POST(req: Request) {
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const tenantId = await tenantForStatusToken(token);
  if (!tenantId) return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { call_inbound?: { from_number?: unknown } } | null;
  const from = body?.call_inbound?.from_number;
  return NextResponse.json({ initial_context: { complaint_status: await complaintStatusFor(tenantId, typeof from === "string" ? from : null) } });
}
