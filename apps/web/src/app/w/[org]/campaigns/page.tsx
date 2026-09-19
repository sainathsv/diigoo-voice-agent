import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { holdsAnywhere } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCampaigns } from "@/server/queries/modules";

export const metadata: Metadata = { title: "Campaigns" };

export default async function CampaignsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "campaigns:view")) notFound();
  const list = await loadCampaigns(ctx.org.id, ctx.access);

  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Outbound calls by your AI agent: reminders, recalls, follow-ups. Every call is checked first for do-not-call, DND, consent, calling hours and a declared caller ID."
        actions={holdsAnywhere(ctx.access, "campaigns:create") ? <Link className="btn btn-primary" href={`/w/${slug}/campaigns/new`}>New campaign</Link> : null}
      />
      <Flash {...flash} />
      <Section title={`${list.length} campaign${list.length === 1 ? "" : "s"}`}>
        {list.length === 0 ? (
          <Empty>No campaigns yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Campaign</th><th>Purpose</th><th>Status</th><th>Progress</th><th>Created</th></tr></thead>
              <tbody>
                {list.map(({ c, agentName, number, stats }) => {
                  const total = Object.values(stats).reduce((a, b) => a + b, 0);
                  const done = (stats.completed ?? 0) + (stats.skipped ?? 0) + (stats.cancelled ?? 0) + (stats.failed ?? 0);
                  return (
                    <tr key={c.id}>
                      <td><Link className="font-semibold hover:text-copper-deep" href={`/w/${slug}/campaigns/${c.id}`}>{c.name}</Link><div className="text-[12px] text-grey">{agentName} · from {number}</div></td>
                      <td className="capitalize">{c.purpose}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ivory-2"><div className="h-full bg-copper" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
                          <span className="text-[12.5px] tabular-nums text-ink-soft">{done}/{total}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap text-ink-soft">{fmtDate(c.createdAt, false)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
