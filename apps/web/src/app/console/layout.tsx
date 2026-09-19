import Link from "next/link";
import type { PlatformPermission } from "@jenai/authz";
import { Avatar, Logo } from "@/components/ui";
import { NavLink } from "@/components/client";
import { SignOutButton } from "@/components/sign-out";
import { platformCan, requirePlatform } from "@/server/platform/context";

const NAV: Array<{ href: string; label: string; perm?: PlatformPermission }> = [
  { href: "/console", label: "Clients", perm: "platform:clients.view" },
  { href: "/console/clients/new", label: "New client", perm: "platform:clients.manage" },
  { href: "/console/access", label: "Support access", perm: "platform:support.request" },
  { href: "/console/plans", label: "Plans", perm: "platform:billing.view" },
  { href: "/console/staff", label: "Diigoo team", perm: "platform:staff.manage" },
  { href: "/console/activity", label: "Activity log", perm: "platform:audit.view" },
  { href: "/console/security", label: "Security", perm: "platform:security.view" },
  { href: "/console/ai-safety", label: "AI safety", perm: "platform:templates.manage" },
];

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePlatform();
  const roleNames = [...new Set(ctx.access.grants.map((g) => g.roleKey.replace(/_/g, " ")))];
  return (
    <div className="mx-auto grid min-h-full max-w-[1280px] gap-6 px-4 py-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="md:sticky md:top-6 md:self-start">
        <Link href="/console" aria-label="Console home"><Logo suffix="console" /></Link>
        <div className="card mb-4 mt-5 bg-ink p-3 text-ivory">
          <div className="eyebrow text-copper-soft">Diigoo Tech</div>
          <div className="h-display mt-1 text-[15px]">Platform operations</div>
          <div className="mt-1 text-[12px] capitalize text-ivory/70">{roleNames.join(", ")}</div>
        </div>
        <nav className="grid gap-0.5" aria-label="Console">
          {NAV.filter((n) => !n.perm || platformCan(ctx, n.perm)).map((n) => (
            <NavLink key={n.href} href={n.href} exact={n.href === "/console"}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="mt-6 flex items-center gap-2.5 border-t border-line pt-4">
          <Avatar name={ctx.user.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{ctx.user.name}</div>
            <div className="truncate text-[12px] text-grey">{ctx.user.email}</div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Link className="btn btn-ghost btn-sm" href="/orgs">Workspaces</Link>
          <Link className="btn btn-ghost btn-sm" href="/account/security">Security</Link>
          <SignOutButton />
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
