import type { Metadata } from "next";
import Link from "next/link";
import { holdsAnywhere } from "@jenai/authz";
import { Empty, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadAgents } from "@/server/queries/modules";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "AI agents" };

export default async function AgentsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "agents:view")) return deny(ctx, { perm: "agents:view" });
  const list = await loadAgents(ctx.org.id);

  return (
    <>
      <PageHead title="AI agents" sub="Each agent answers inbound calls and makes outbound calls from one version. Publishing a version updates both at once, after checks pass." />
      <Section title={`${list.length} agent${list.length === 1 ? "" : "s"}`}>
        {list.length === 0 ? (
          <Empty>No agents yet. JENAI sets up your first agent during onboarding.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Branch</th><th>Live version</th><th>Waiting</th><th>Last change</th></tr></thead>
              <tbody>
                {list.map(({ a, branchName, versions }) => {
                  const live = versions.find((v) => v.id === a.liveVersionId);
                  const waiting = versions.filter((v) => v.state === "draft" || v.state === "pending_approval");
                  return (
                    <tr key={a.id}>
                      <td>
                        <Link className="font-semibold hover:text-copper-deep" href={`/w/${slug}/agents/${a.id}`}>{a.name}</Link>
                        <div className="text-[12px] capitalize text-grey">{a.purpose.replace("_", " ")}</div>
                      </td>
                      <td>{branchName ?? "All branches"}</td>
                      <td>{live ? <><span className="font-semibold">v{live.number}</span> <StatusBadge status={live.state === "imported" ? "active" : live.state} /></> : <span className="text-grey">None</span>}</td>
                      <td>{waiting.length ? waiting.map((v) => <span key={v.id} className="mr-1"><StatusBadge status={v.state} /></span>) : <span className="text-grey">Nothing</span>}</td>
                      <td className="whitespace-nowrap text-ink-soft">{fmtDate(versions[0]?.createdAt)}</td>
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
