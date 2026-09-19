import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@jenai/authz";
import { Empty, PageHead, Section, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadAudit, loadSecurityAlerts } from "@/server/queries/workspace";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Activity log" };

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ filter?: string }> }) {
  const { org: slug } = await params;
  const { filter } = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!can(ctx.access, "audit:view")) return deny(ctx, { perm: "audit:view" });
  const onlySupport = filter === "support";
  const [rows, alerts] = await Promise.all([loadAudit(ctx.org.id, onlySupport), loadSecurityAlerts(ctx.org.id)]);
  const openAlerts = alerts.filter((a) => a.status === "open" || a.status === "acknowledged");

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
      {alerts.length ? (
        <Section
          title="Security alerts"
          sub={openAlerts.length ? "JENAI's security team is looking into these. Nothing is needed from you unless we contact you." : "Recent alerts about this workspace, all closed by JENAI's security team."}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>What</th><th>Status</th></tr></thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(a.lastSeen)}</td>
                    <td><div>{a.title}</div><div className="text-[12px] text-grey">{a.subject}</div></td>
                    <td className="whitespace-nowrap">
                      <span className={`badge ${a.status === "open" ? "badge-bad" : a.status === "acknowledged" ? "badge-copper" : "badge-muted"}`}>
                        {a.status === "open" ? "Open" : a.status === "acknowledged" ? "Being looked at" : a.status === "false_positive" ? "No issue found" : "Resolved"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
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
