import type { Metadata } from "next";
import { PageHead, Section, fmtDate } from "@/components/ui";
import { requirePlatform } from "@/server/platform/context";
import { platformAudit } from "@/server/platform/queries";

export const metadata: Metadata = { title: "Activity log" };

export default async function PlatformActivity() {
  await requirePlatform("platform:audit.view");
  const rows = await platformAudit();
  return (
    <>
      <PageHead title="Activity log" sub="Every recorded action across all workspaces, append-only. Support and break-glass sessions are marked." />
      <Section title="Latest 300 events">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>When</th><th>Where</th><th>Who</th><th>What happened</th></tr></thead>
            <tbody>
              {rows.map(({ e, actorName, orgName }) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-ink-soft">{fmtDate(e.createdAt)}</td>
                  <td className="whitespace-nowrap">{orgName ?? <span className="text-grey">Platform</span>}</td>
                  <td className="whitespace-nowrap">
                    {e.via === "system" ? <span className="text-grey">System</span> : actorName ?? <span className="text-grey">Unknown</span>}
                    {e.via === "support" ? <span className={`badge ml-1.5 ${e.action === "support.breakglass" ? "badge-bad" : "badge-copper"}`}>{e.action === "support.breakglass" ? "break-glass" : "support"}</span> : null}
                  </td>
                  <td><div>{e.summary}</div><div className="font-mono text-[11.5px] text-grey">{e.action}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
