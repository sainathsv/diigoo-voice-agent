import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { listGrants } from "@/server/platform/queries";
import { endSupportGrant, platformApprove } from "@/server/actions/console";
import { enterSupport } from "@/server/actions/support-session";

export const metadata: Metadata = { title: "Support access" };

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const flash = await searchParams;
  const ctx = await requirePlatform("platform:support.request");
  const rows = await listGrants();
  const now = new Date();
  const isLive = (g: (typeof rows)[number]["g"]) => g.status === "approved" && !!g.expiresAt && g.expiresAt > now;
  const mineLive = rows.filter((r) => r.g.staffUserId === ctx.user.userId && isLive(r.g));
  const approver = platformCan(ctx, "platform:support.approve");

  return (
    <>
      <PageHead
        title="Support access"
        sub="Nobody at Diigoo has standing access to client calls, contacts or recordings. Ask the client from their page; every session is time-boxed and shows up in their activity log."
      />
      <Flash {...flash} />
      <div className="grid gap-6">
        <Section title="Your active sessions">
          {mineLive.length === 0 ? (
            <Empty>No active access. Request it from a client&apos;s page.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {mineLive.map(({ g, orgName }) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <div className="font-semibold">{orgName}</div>
                    <div className="text-[12.5px] text-grey">{g.mode === "read" ? "Read-only" : g.mode === "write" ? "Can make changes" : "Emergency"} until {fmtDate(g.expiresAt)}</div>
                  </div>
                  <div className="flex gap-2">
                    <form action={enterSupport}><input type="hidden" name="grantId" value={g.id} /><button className="btn btn-primary btn-sm" type="submit">Enter workspace</button></form>
                    <form action={endSupportGrant}><input type="hidden" name="grantId" value={g.id} /><button className="btn btn-ghost btn-sm" type="submit">End</button></form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="All requests and sessions" sub="Latest 100 across clients.">
          {rows.length === 0 ? (
            <Empty>Nothing yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Client</th><th>Staff</th><th>Access</th><th>Reason</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map(({ g, staffName, orgName }) => {
                    const waitingForJenai = g.mode === "write" && g.status === "requested" && !g.platformApprover;
                    return (
                      <tr key={g.id}>
                        <td><Link className="font-semibold hover:text-copper-deep" href={`/console/clients/${g.tenantId}`}>{orgName}</Link></td>
                        <td>{staffName}</td>
                        <td className="whitespace-nowrap">{g.mode === "read" ? "Read-only" : g.mode === "write" ? "Can change" : "Emergency"} · {g.durationMinutes} min</td>
                        <td className="max-w-[36ch] text-ink-soft">{g.reason}<div className="text-[12px] text-grey">Ticket {g.ticket ?? "none"} · {fmtDate(g.requestedAt)}</div></td>
                        <td>
                          <StatusBadge status={g.status === "approved" ? (isLive(g) ? "active" : "expired") : g.status} />
                          {g.status === "requested" ? (
                            <div className="mt-1 text-[12px] text-grey">
                              {g.decidedBy ? "Client approved" : "Waiting for client"}
                              {g.mode === "write" ? (g.platformApprover ? " · Diigoo co-approved" : " · needs Diigoo co-approval") : ""}
                            </div>
                          ) : null}
                        </td>
                        <td className="text-right">
                          {approver && waitingForJenai && g.staffUserId !== ctx.user.userId ? (
                            <form action={platformApprove}><input type="hidden" name="grantId" value={g.id} /><button className="btn btn-ghost btn-sm" type="submit">Co-approve</button></form>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
