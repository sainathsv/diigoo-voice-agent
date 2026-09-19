import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { listClients } from "@/server/platform/queries";

export const metadata: Metadata = { title: "Clients" };

export default async function ConsoleHome({ searchParams }: { searchParams: Promise<{ denied?: string; ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePlatform();
  if (!platformCan(ctx, "platform:clients.view")) {
    return (
      <>
        <PageHead title="Console" />
        <div className="card card-pad text-grey">Your Diigoo role does not include client accounts. Use the menu for the areas you work in.</div>
      </>
    );
  }
  const clients = await listClients();
  const live = clients.filter((c) => c.status === "active").length;
  const onboarding = clients.filter((c) => c.status === "onboarding").length;
  const blocked = clients.filter((c) => c.failed > 0).length;
  const requests = clients.reduce((n, c) => n + c.openRequests, 0);

  return (
    <>
      <PageHead
        title="Clients"
        sub="Every client workspace, how far it is from fully live, and what needs attention."
        actions={platformCan(ctx, "platform:clients.manage") ? <Link className="btn btn-primary" href="/console/clients/new">New client</Link> : null}
      />
      {sp.denied ? <div className="notice notice-warn mb-5">Your role does not allow that ({sp.denied}).</div> : null}
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Live", live],
          ["Onboarding", onboarding],
          ["With failed checks", blocked],
          ["Support requests waiting on clients", requests],
        ].map(([label, n]) => (
          <div key={label as string} className="card card-pad">
            <div className="eyebrow">{label}</div>
            <div className="h-display mt-1 text-[28px] tabular-nums">{n}</div>
          </div>
        ))}
      </div>

      <Section title={`All clients (${clients.length})`}>
        {clients.length === 0 ? (
          <Empty>No clients yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Client</th><th>Type</th><th>Plan</th><th>Status</th><th>Go-live checks</th><th className="num">People</th><th>Since</th></tr></thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/console/clients/${c.id}`} className="font-semibold text-ink hover:text-copper-deep">{c.name}</Link>
                      <div className="font-mono text-[12px] text-grey">{c.slug}</div>
                    </td>
                    <td className="capitalize">{c.vertical?.replace("_", " ") ?? ""}</td>
                    <td className="capitalize">{c.plan.replace("_", " ")}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ivory-2">
                          <div className={`h-full ${c.failed ? "bg-bad" : "bg-copper"}`} style={{ width: `${c.totalSteps ? (c.passed / c.totalSteps) * 100 : 0}%` }} />
                        </div>
                        <span className="text-[12.5px] tabular-nums text-ink-soft">{c.passed}/{c.totalSteps}</span>
                        {c.failed ? <span className="badge badge-bad">{c.failed} failed</span> : null}
                      </div>
                    </td>
                    <td className="num">{c.people}</td>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(c.createdAt, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
