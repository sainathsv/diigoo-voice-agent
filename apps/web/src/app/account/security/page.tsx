import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { appDb, sql } from "@jenai/db";
import { Flash, Logo, Section, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { SignOutButton } from "@/components/sign-out";
import { auth } from "@/lib/auth";
import { STAFF_MFA_REQUIRED } from "@/lib/mfa-policy";
import { getSession, myOrganizations, requireUser } from "@/server/session";
import { signOutDevice, signOutEverywhereElse } from "@/server/actions/account";
import { TwoStepPanel } from "./two-step";

export const metadata: Metadata = { title: "Sign-in and security" };

const EVENT: Record<string, string> = {
  signin_ok: "Signed in",
  signin_failed: "Wrong password",
  signin_locked: "Locked after wrong passwords",
  mfa_failed: "Wrong 2-step code",
  mfa_enabled: "Two-step sign-in turned on",
  mfa_disabled: "Two-step sign-in turned off",
  session_revoked: "Signed out other devices",
  password_changed: "Password changed",
};

/** "Chrome on macOS" from a user-agent string; good enough to recognise your own devices. */
function device(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? "Script" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export default async function AccountSecurity({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; required?: string }> }) {
  const u = await requireUser();
  const flash = await searchParams;
  const current = await getSession();
  const [sessions, orgs, events] = await Promise.all([
    auth.api.listSessions({ headers: await headers() }),
    myOrganizations(u.id),
    appDb().execute<{ kind: string; ip: string | null; user_agent: string | null; created_at: string }>(
      sql`select kind::text, ip, user_agent, created_at from lookup.my_security_events(${u.id}, ${u.email}, 20)`,
    ),
  ]);
  const enabled = Boolean((u as { twoFactorEnabled?: boolean }).twoFactorEnabled);
  const staff = orgs.some((o) => o.kind === "platform" && o.membershipStatus === "active");
  const required = staff && STAFF_MFA_REQUIRED;
  const others = sessions.filter((s) => s.id !== current?.session.id);
  const home = staff ? "/console" : "/orgs";

  return (
    <main className="mx-auto grid max-w-[880px] gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href={home} aria-label="Home"><Logo /></Link>
        <div className="flex gap-2">
          <Link className="btn btn-ghost btn-sm" href={home}>Back</Link>
          <SignOutButton />
        </div>
      </header>

      <div>
        <h1 className="h-display text-[26px]">Sign-in and security</h1>
        <p className="mt-1 text-ink-soft">{u.name} · {u.email}</p>
      </div>

      <Flash ok={flash.ok} error={flash.error} />
      {flash.required && !enabled ? (
        <div className="notice notice-bad" role="alert">
          Diigoo staff must use two-step sign-in. Set it up below to open the console.
        </div>
      ) : null}

      <Section title="Two-step sign-in" sub="A 6-digit code from an app on your phone, asked for after your password.">
        <TwoStepPanel enabled={enabled} required={required} />
      </Section>

      <div id="sessions">
        <Section
          title="Where you are signed in"
          sub="Sign out of any device you do not recognise, then change your password."
          actions={
            others.length ? (
              <form action={signOutEverywhereElse}>
                <SubmitButton className="btn btn-danger btn-sm" pendingText="Signing out">Sign out everywhere else</SubmitButton>
              </form>
            ) : null
          }
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Device</th><th>Address</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
              <tbody>
                {sessions.map((s) => {
                  const here = s.id === current?.session.id;
                  return (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">
                        {device(s.userAgent)}
                        {here ? <span className="badge badge-ok ml-1.5">This device</span> : null}
                      </td>
                      <td className="whitespace-nowrap font-mono text-[12px] text-ink-soft">{s.ipAddress || "not recorded"}</td>
                      <td className="whitespace-nowrap text-ink-soft">{fmtDate(s.createdAt)}</td>
                      <td className="whitespace-nowrap text-ink-soft">{fmtDate(s.updatedAt)}</td>
                      <td className="text-right">
                        {here ? null : (
                          <form action={signOutDevice}>
                            <input type="hidden" name="sessionId" value={s.id} />
                            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Signing out">Sign out</SubmitButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <Section title="Recent sign-in activity" sub="If you see a wrong password or sign-in you did not make, change your password and tell your admin.">
        {events.length === 0 ? (
          <div className="px-5 py-6 text-grey">Nothing recorded yet.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>What</th><th>Device</th><th>Address</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(e.created_at)}</td>
                    <td className={e.kind === "signin_failed" || e.kind === "signin_locked" || e.kind === "mfa_failed" || e.kind === "mfa_disabled" ? "text-bad" : ""}>{EVENT[e.kind] ?? e.kind}</td>
                    <td className="whitespace-nowrap">{device(e.user_agent)}</td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-ink-soft">{e.ip ?? "not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  );
}
