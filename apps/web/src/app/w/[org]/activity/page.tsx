import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@jenai/authz";
import { Empty, PageHead, Section, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadAudit } from "@/server/queries/workspace";

export const metadata: Metadata = { title: "Activity log" };

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ filter?: string }> }) {
  const { org: slug } = await params;
  const { filter } = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!can(ctx.access, "audit:view")) notFound();
  const onlySupport = filter === "support";
  const rows = await loadAudit(ctx.org.id, onlySupport);

  return (
    <>
      <PageHead
        title="Activity log"
        sub="Every change in this workspace, who made it and when. Entries cannot be edited or deleted, including by JENAI."
        actions={
          <div className="flex gap-2">
            <Link className={`btn btn-sm ${onlySupport ? "btn-ghost" : "btn-dark"}`} href={`/w/${slug}/activity`}>Everything</Link>
            <Link className={`btn btn-sm ${onlySupport ? "btn-dark" : "btn-ghost"}`} href={`/w/${slug}/activity?filter=support`}>JENAI support only</Link>
          </div>
        }
      />
      <Section title={onlySupport ? "JENAI support activity" : "Latest 200 events"}>
        {rows.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Who</th><th>What happened</th></tr></thead>
              <tbody>
                {rows.map(({ e, actorName }) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(e.createdAt)}</td>
                    <td className="whitespace-nowrap">
                      {e.via === "system" ? <span className="text-grey">System</span> : actorName ?? <span className="text-grey">Unknown</span>}
                      {e.via === "support" ? <span className="badge badge-copper ml-1.5">JENAI support</span> : null}
                    </td>
                    <td>
                      <div>{e.summary}</div>
                      <div className="font-mono text-[11.5px] text-grey">{e.action}</div>
                    </td>
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
