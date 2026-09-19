import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Tenant-bound secret encryption (AES-256-GCM). The additional authenticated
 * data binds each ciphertext to one tenant and one purpose, so a value copied
 * into another tenant's row, or used for another purpose, fails to decrypt.
 *
 * Key: JENAI_DATA_KEY (32 bytes, hex). Production swaps this for per-tenant
 * data keys wrapped by AWS KMS (Blueprint Part 6); the "v1:" prefix leaves room.
 */
function key(): Buffer {
  const hex = process.env.JENAI_DATA_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("JENAI_DATA_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

const aad = (tenantId: string, purpose: string) => Buffer.from(`jenai:v1:${tenantId}:${purpose}`);

export function sealSecret(tenantId: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(tenantId, purpose));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function openSecret(tenantId: string, purpose: string, sealed: string): string {
  const [v, iv, tag, body] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAAD(aad(tenantId, purpose));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}
