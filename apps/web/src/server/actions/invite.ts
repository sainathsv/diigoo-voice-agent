"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appDb, user } from "@jenai/db";
import { auth } from "@/lib/auth";
import { hashToken } from "../invitations";
import { getSession, myOrganizations } from "../session";

export type InviteState = { error?: string } | null;

type Invite = { tenant_id: string; email: string; status: string; expires_at: string | Date };

async function loadInvite(token: string): Promise<Invite | null> {
  const rows = (await appDb().execute(sql`select tenant_id, email, status, expires_at from lookup.invitation_by_token(${hashToken(token)})`)) as unknown as Invite[];
  return rows[0] ?? null;
}

const ERRORS: Record<string, string> = {
  invitation_not_found: "This invitation link is not valid.",
  invitation_not_pending: "This invitation was already used or revoked.",
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_email_mismatch: "This invitation is for a different email address.",
};

/** Join a workspace from an invitation. New people set a name and password; existing people must be signed in. */
export async function acceptInvite(_: InviteState, fd: FormData): Promise<InviteState> {
  const token = String(fd.get("token") ?? "");
  const inv = await loadInvite(token);
  if (!inv) return { error: ERRORS.invitation_not_found! };
  if (inv.status !== "pending") return { error: ERRORS.invitation_not_pending! };
  if (new Date(inv.expires_at) < new Date()) return { error: ERRORS.invitation_expired! };

  let userId: string;
  const session = await getSession();
  if (session) {
    if (session.user.email.toLowerCase() !== inv.email.toLowerCase()) return { error: `You are signed in as ${session.user.email}. Sign out, then open this link again.` };
    userId = session.user.id;
  } else {
    const p = z
      .object({
        name: z.string().trim().min(2, "Enter your name").max(120),
        password: z.string().min(10, "Use at least 10 characters").max(128),
        confirm: z.string(),
      })
      .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] })
      .safeParse(Object.fromEntries(fd));
    if (!p.success) return { error: p.error.issues[0]?.message ?? "Check the form." };
    const [exists] = await appDb().select({ id: user.id }).from(user).where(eq(user.email, inv.email.toLowerCase()));
    if (exists) return { error: "You already have a JENAI login. Sign in first, then open this link again." };

    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser({ email: inv.email.toLowerCase(), name: p.data.name, emailVerified: true }, { method: "email-password" });
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(p.data.password),
    });
    await auth.api.signInEmail({ body: { email: inv.email.toLowerCase(), password: p.data.password }, headers: await headers() });
    userId = created.id;
  }

  try {
    await appDb().execute(sql`select lookup.accept_invitation(${hashToken(token)}, ${userId})`);
  } catch (e) {
    const code = Object.keys(ERRORS).find((k) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message).includes(k));
    return { error: code ? ERRORS[code]! : "Could not accept the invitation." };
  }
  const org = (await myOrganizations(userId)).find((o) => o.orgId === inv.tenant_id);
  redirect(org?.kind === "platform" ? "/console" : org ? `/w/${org.slug}` : "/");
}
