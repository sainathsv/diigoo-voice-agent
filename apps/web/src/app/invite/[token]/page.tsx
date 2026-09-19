import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { appDb } from "@jenai/db";
import { Logo } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { hashToken } from "@/server/invitations";
import { getSession } from "@/server/session";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Join your team" };

type Row = { email: string; name: string | null; org_name: string; role_name: string; status: string; expires_at: string | Date };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rows = (await appDb().execute(
    sql`select email, name, org_name, role_name, status, expires_at from lookup.invitation_by_token(${hashToken(token)})`,
  )) as unknown as Row[];
  const inv = rows[0];
  const session = await getSession();

  let body: React.ReactNode;
  if (!inv) body = <p className="text-grey">This invitation link is not valid. Ask your admin for a new one.</p>;
  else if (inv.status !== "pending") body = <p className="text-grey">This invitation was already used or revoked.</p>;
  else if (new Date(inv.expires_at) < new Date()) body = <p className="text-grey">This invitation has expired. Ask your admin for a new one.</p>;
  else if (session && session.user.email.toLowerCase() !== inv.email.toLowerCase())
    body = (
      <div className="grid gap-3">
        <p>This invitation is for <b>{inv.email}</b>, but you are signed in as <b>{session.user.email}</b>.</p>
        <SignOutButton className="btn btn-dark" />
      </div>
    );
  else
    body = (
      <>
        <p className="mb-5 text-ink-soft">
          You are invited to <b className="text-ink">{inv.org_name}</b> as <b className="text-ink">{inv.role_name}</b>.
        </p>
        <AcceptForm token={token} email={inv.email} name={inv.name ?? ""} signedIn={!!session} />
        {!session ? (
          <p className="mt-4 text-[12.5px] text-grey">
            Already use JENAI with this email? <Link className="font-semibold text-copper-deep" href={`/login?next=/invite/${token}`}>Sign in first</Link>.
          </p>
        ) : null}
      </>
    );

  return (
    <main className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 text-center"><Logo /></div>
        <div className="card card-pad">
          <h1 className="h-display mb-3 text-[22px]">Join your team</h1>
          {body}
        </div>
      </div>
    </main>
  );
}
