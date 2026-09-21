import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { apiKeys, platformDb } from "@jenai/db";
import { recordSecurityEvent } from "@/lib/security-events";

/**
 * Keys for the client's own systems (their CRM, their in-house panel). One key
 * belongs to one workspace and carries scopes; it is stored only as a hash, so
 * a leaked database does not hand anyone a working key.
 */

export const SCOPES = ["calls:create", "calls:read", "leads:read", "programs:read"] as const;
export type ApiScope = (typeof SCOPES)[number];

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/** Returns the key once. It is never stored or shown again. */
export function newApiKey(): { key: string; prefix: string; keyHash: string } {
  const live = process.env.NODE_ENV === "production";
  const body = randomBytes(24).toString("base64url");
  const key = `jk_${live ? "live" : "test"}_${body}`;
  return { key, prefix: key.slice(0, 14), keyHash: hash(key) };
}

export interface ApiCaller {
  tenantId: string;
  keyId: string;
  scopes: string[];
  branchId: string | null;
  name: string;
}

export type AuthResult = { ok: true; caller: ApiCaller } | { ok: false; status: number; error: string; message: string };

const RATE = { windowMs: 60_000, max: Number(process.env.JENAI_API_RATE_PER_MIN ?? 120) };
const hits = new Map<string, number[]>();

function rateLimited(keyId: string, now = Date.now()): boolean {
  const list = (hits.get(keyId) ?? []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(keyId, list);
  return list.length > RATE.max;
}

/** Checks the Authorization header and the scope this endpoint needs. */
export async function authenticate(req: Request, need: ApiScope): Promise<AuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const ip = req.headers.get("x-jenai-client-ip");
  if (!presented.startsWith("jk_")) {
    return { ok: false, status: 401, error: "no_key", message: "Send your JENAI key as: Authorization: Bearer jk_live_..." };
  }
  const digest = hash(presented);
  const [row] = await platformDb().select().from(apiKeys).where(eq(apiKeys.keyHash, digest));
  if (!row || !timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(digest))) {
    await recordSecurityEvent("access_denied", { ip, detail: { area: "api", reason: "unknown key", prefix: presented.slice(0, 14) } });
    return { ok: false, status: 401, error: "bad_key", message: "That key is not valid." };
  }
  if (row.revokedAt) return { ok: false, status: 401, error: "revoked", message: "That key was revoked." };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return { ok: false, status: 401, error: "expired", message: "That key has expired." };
  if (row.allowedIps.length && ip && !row.allowedIps.includes(ip)) {
    await recordSecurityEvent("access_denied", { ip, tenantId: row.tenantId, detail: { area: "api", reason: "address not on the key's list", keyId: row.id } });
    return { ok: false, status: 403, error: "ip_not_allowed", message: "This key may only be used from the addresses you listed." };
  }
  if (!row.scopes.includes(need)) {
    return { ok: false, status: 403, error: "missing_scope", message: `This key does not have the ${need} permission.` };
  }
  if (rateLimited(row.id)) {
    return { ok: false, status: 429, error: "too_many", message: `More than ${RATE.max} requests a minute. Slow down or ask JENAI to raise it.` };
  }
  await platformDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip ?? null, callsMade: sql`${apiKeys.callsMade} + 1` })
    .where(and(eq(apiKeys.tenantId, row.tenantId), eq(apiKeys.id, row.id)));
  return { ok: true, caller: { tenantId: row.tenantId, keyId: row.id, scopes: row.scopes, branchId: row.branchId, name: row.name } };
}

/** One shape for every error, so their developer can handle them in one place. */
export function apiError(status: number, error: string, message: string, detail?: Record<string, unknown>) {
  return Response.json({ error, message, ...(detail ?? {}) }, { status, headers: { "Cache-Control": "no-store" } });
}

export function apiOk(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
