import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { invitations, type Tx } from "@jenai/db";

export const INVITE_DAYS = 7;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteUrl(token: string) {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3100";
  return `${base}/invite/${token}`;
}

/** Creates a pending invitation and returns the one-time link. Only the hash is stored. */
export async function createInvitation(
  tx: Tx,
  input: { tenantId: string; email: string; name?: string | null; roleId: string; branchId?: string | null; invitedBy: string | null },
) {
  const token = randomBytes(32).toString("base64url");
  const [row] = await tx
    .insert(invitations)
    .values({
      tenantId: input.tenantId,
      email: input.email.toLowerCase(),
      name: input.name ?? null,
      roleId: input.roleId,
      scopeType: input.branchId ? "branch" : "org",
      branchId: input.branchId ?? null,
      tokenHash: hashToken(token),
      invitedBy: input.invitedBy,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    })
    .returning({ id: invitations.id });
  return { id: row!.id, url: inviteUrl(token) };
}
