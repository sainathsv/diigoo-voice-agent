import type { Metadata } from "next";
import Link from "next/link";
import { Logo, StatusBadge } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { myOrganizations, requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Choose a workspace" };

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const u = await requireUser();
  const orgs = await myOrganizations(u.id);
  const staff = orgs.find((o) => o.kind === "platform");
  const clients = orgs.filter((o) => o.kind !== "platform");

  return (
    <main className="mx-auto max-w-[640px] px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Logo />
        <SignOutButton />
      </div>
      <h1 className="h-display text-[24px]">Hello, {u.name.split(" ")[0]}</h1>
      <p className="mt-1 text-grey">Signed in as {u.email}. Choose where to work.</p>
      {notice === "membership-inactive" ? (
        <div className="notice notice-warn mt-5">Your access to that workspace is paused. Ask its owner to reactivate you.</div>
      ) : null}

      {staff ? (
        <Link href="/console" className="card card-pad mt-6 flex items-center justify-between hover:border-ink">
          <div>
            <div className="eyebrow">Diigoo</div>
            <div className="h-display mt-1 text-[18px]">JENAI console</div>
            <div className="text-grey">Clients, onboarding, support access, staff</div>
          </div>
          <span className="btn btn-dark btn-sm">Open</span>
        </Link>
      ) : null}

      <div className="mt-6 grid gap-3">
        {clients.map((o) => (
          <Link key={o.orgId} href={`/w/${o.slug}`} className="card card-pad flex items-center justify-between hover:border-ink">
            <div>
              <div className="h-display text-[17px]">{o.name}</div>
              <div className="mt-1 flex gap-2">
                <StatusBadge status={o.orgStatus} />
                {o.membershipStatus !== "active" ? <StatusBadge status={o.membershipStatus} /> : null}
              </div>
            </div>
            <span className="btn btn-ghost btn-sm">Open</span>
          </Link>
        ))}
        {!staff && clients.length === 0 ? (
          <div className="card card-pad text-grey">You are not part of any workspace yet. Open the invitation link your admin sent you.</div>
        ) : null}
      </div>
    </main>
  );
}
