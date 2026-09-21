import Link from "next/link";
import { holdsAnywhere, type Permission } from "@jenai/authz";
import { Avatar, Logo, StatusBadge, fmtDate } from "@/components/ui";
import { NavLink } from "@/components/client";
import { SignOutButton } from "@/components/sign-out";
import { requireWorkspace } from "@/server/access";
import { exitSupportAndReturn } from "@/server/actions/support-session";

const NAV: Array<{ href: string; label: string; perm?: Permission; group?: string }> = [
  { href: "", label: "Overview" },
  { href: "/calls", label: "Calls", perm: "calls:view" },
  { href: "/leads", label: "Leads", perm: "contacts:view" },
  { href: "/calendar", label: "Calendar", perm: "calendar:view" },
  { href: "/programs", label: "Call programs", perm: "agents:view" },
  { href: "/campaigns", label: "Campaigns", perm: "campaigns:view" },
  { href: "/agents", label: "AI agents", perm: "agents:view" },
  { href: "/numbers", label: "Phone numbers", perm: "numbers:view" },
  { href: "/integrations", label: "Your systems", perm: "integrations:manage" },
  { href: "/plan", label: "Plan and usage", perm: "billing:view" },
  { href: "/team", label: "Team", perm: "users:view" },
  { href: "/roles", label: "Roles and access", perm: "users:view" },
  { href: "/branches", label: "Branches", perm: "users:view" },
  { href: "/activity", label: "Activity log", perm: "audit:view" },
  { href: "/settings", label: "Settings", perm: "org:manage" },
];

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  const base = `/w/${slug}`;
  const visible = NAV.filter((n) => !n.perm || holdsAnywhere(ctx.access, n.perm) || (n.perm === "org:manage" && holdsAnywhere(ctx.access, "support_access:grant")));

  return (
    <div className="min-h-full">
      {ctx.support ? (
        <div className="bg-ink px-4 py-2 text-[13px] text-ivory">
          <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3">
            <span>
              <b>JENAI support session</b> in {ctx.org.name}: {ctx.support.mode === "read" ? "read-only" : "can make changes"}, ends {fmtDate(ctx.support.expiresAt)}. Every action is logged and visible to the client.
            </span>
            <form action={exitSupportAndReturn}>
              <button className="btn btn-sm bg-ivory text-ink">Exit support session</button>
            </form>
          </div>
        </div>
      ) : null}
      {ctx.org.status === "suspended" ? (
        <div className="bg-bad-wash px-4 py-2 text-center text-[13px] text-bad">
          This workspace is suspended{ctx.org.suspendedReason ? `: ${ctx.org.suspendedReason}` : ""}. Calls and changes are paused. Contact JENAI support.
        </div>
      ) : null}

      <div className="mx-auto grid max-w-[1240px] gap-6 px-4 py-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="md:sticky md:top-6 md:self-start">
          <div className="mb-5 flex items-center justify-between md:block">
            <Link href="/" aria-label="Home"><Logo /></Link>
          </div>
          <div className="card mb-4 p-3">
            <div className="eyebrow">Workspace</div>
            <div className="h-display mt-1 text-[16px] leading-tight">{ctx.org.name}</div>
            <div className="mt-2 flex items-center gap-2">
              <StatusBadge status={ctx.org.status} />
              <Link href="/orgs" className="text-[12px] font-semibold text-copper-deep hover:underline">Switch</Link>
            </div>
          </div>
          <nav className="grid gap-0.5" aria-label="Workspace">
            {visible.map((n) => (
              <NavLink key={n.href} href={`${base}${n.href}`} exact={n.href === ""}>{n.label}</NavLink>
            ))}
          </nav>
          <div className="mt-6 flex items-center gap-2.5 border-t border-line pt-4">
            <Avatar name={ctx.user.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{ctx.user.name}</div>
              <div className="truncate text-[12px] text-grey">{ctx.support ? "JENAI support" : ctx.user.email}</div>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <SignOutButton />
            <Link className="btn btn-ghost btn-sm" href="/account/security">Security</Link>
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
