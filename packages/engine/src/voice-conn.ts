import { eq } from "drizzle-orm";
import { openSecret, sealSecret, voiceConnections, type Tx, type VoiceConnection } from "@jenai/db";
import { DograhClient, type DograhAuth } from "@jenai/voice";

const PURPOSE = "voice-connection";

export interface ConnectionInput {
  baseUrl: string;
  externalOrgId?: number | null;
  mediaBaseUrl?: string | null;
  auth: DograhAuth;
  mode?: "read_only" | "managed";
}

export async function saveVoiceConnection(tx: Tx, tenantId: string, input: ConnectionInput, actorUserId: string | null) {
  const secret = input.auth.kind === "api_key" ? input.auth.apiKey : JSON.stringify({ email: input.auth.email, password: input.auth.password });
  const row = {
    tenantId,
    provider: "dograh",
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    externalOrgId: input.externalOrgId ?? null,
    mediaBaseUrl: input.mediaBaseUrl ?? null,
    authKind: input.auth.kind,
    credentialCiphertext: sealSecret(tenantId, PURPOSE, secret),
    mode: input.mode ?? "read_only",
    status: "unverified",
    lastError: null,
    createdBy: actorUserId,
    updatedAt: new Date(),
  };
  await tx.insert(voiceConnections).values(row).onConflictDoUpdate({ target: voiceConnections.tenantId, set: row });
}

export async function getVoiceConnection(tx: Tx, tenantId: string): Promise<VoiceConnection | null> {
  const [row] = await tx.select().from(voiceConnections).where(eq(voiceConnections.tenantId, tenantId));
  return row ?? null;
}

/** A Dograh client for this tenant, or null when no connection is set up. */
export async function voiceClient(tx: Tx, tenantId: string): Promise<{ client: DograhClient; conn: VoiceConnection } | null> {
  const conn = await getVoiceConnection(tx, tenantId);
  if (!conn) return null;
  const secret = openSecret(tenantId, PURPOSE, conn.credentialCiphertext);
  const auth: DograhAuth =
    conn.authKind === "api_key" ? { kind: "api_key", apiKey: secret } : { kind: "password", ...(JSON.parse(secret) as { email: string; password: string }) };
  return { client: new DograhClient(conn.baseUrl, auth, fetch, 20_000, conn.mediaBaseUrl), conn };
}

export async function markConnection(tx: Tx, tenantId: string, patch: Partial<Pick<VoiceConnection, "status" | "lastError" | "lastVerifiedAt" | "lastSyncAt" | "mode">>) {
  await tx.update(voiceConnections).set({ ...patch, updatedAt: new Date() }).where(eq(voiceConnections.tenantId, tenantId));
}
