import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { holdsAnywhere } from "@jenai/authz";
import { PURPOSE_LABEL, SERIES_LABEL } from "@jenai/engine";
import { Empty, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadNumbers } from "@/server/queries/modules";

export const metadata: Metadata = { title: "Phone numbers" };

const KYC: Record<string, string> = { not_started: "pending", link_sent: "in_progress", submitted: "in_progress", verified: "passed", rejected: "failed" };

export default async function NumbersPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "numbers:view")) notFound();
  const { nums, accounts } = await loadNumbers(ctx.org.id);

  return (
    <>
      <PageHead title="Phone numbers" sub="Your numbers, which agent answers each one, and whether each caller ID is declared for AI calls as TRAI requires (from 18 Sep 2026)." />
      <div className="grid gap-6">
        <Section title="Numbers">
          {nums.length === 0 ? (
            <Empty>No numbers yet. JENAI connects your number during onboarding.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Number</th><th>Type</th><th>Used for</th><th>Answered by</th><th>AI calling declaration</th><th>Status</th></tr></thead>
                <tbody>
                  {nums.map(({ n, branchName, agentName }) => (
                    <tr key={n.id}>
                      <td><div className="font-mono font-semibold">{n.e164}</div><div className="text-[12px] text-grey">{n.label ?? ""}{branchName ? ` · ${branchName}` : ""}</div></td>
                      <td>{SERIES_LABEL[n.series]}</td>
                      <td>{PURPOSE_LABEL[n.purpose]}</td>
                      <td>{agentName ?? <span className="text-grey">Nobody</span>}</td>
                      <td>
                        {n.purpose === "inbound" ? (
                          <span className="text-grey">Not needed (inbound only)</span>
                        ) : n.a2pDeclaredAt ? (
                          <><span className="badge badge-ok">Declared</span><div className="text-[12px] text-grey">{fmtDate(n.a2pDeclaredAt, false)}{n.a2pReference ? ` · ${n.a2pReference}` : ""}</div></>
                        ) : (
                          <span className="badge badge-bad">Not declared: outbound AI calls blocked</span>
                        )}
                      </td>
                      <td><StatusBadge status={n.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Carrier accounts" sub="Each client should have its own carrier account, verified in its own business name. JENAI manages these with you.">
          {accounts.length === 0 ? (
            <Empty>No carrier account yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <div className="font-semibold">{a.displayName}</div>
                    <div className="text-[12px] capitalize text-grey">{a.provider} · {a.mode.replace(/_/g, " ")}</div>
                  </div>
                  <div className="flex items-center gap-2"><span className="text-[12.5px] text-grey">KYC</span><StatusBadge status={KYC[a.kycStatus] ?? a.kycStatus} /></div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
