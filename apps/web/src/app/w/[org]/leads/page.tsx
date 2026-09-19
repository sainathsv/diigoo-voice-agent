import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, holdsAnywhere, phoneFor } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadLeads } from "@/server/queries/modules";
import { updateLead } from "@/server/actions/modules";

export const metadata: Metadata = { title: "Leads" };

const STAGES = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["callback", "Callback"],
  ["booked", "Booked"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;

export default async function LeadsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ stage?: string; mine?: string; ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "contacts:view")) notFound();
  const { rows, counts, team } = await loadLeads(ctx.org.id, ctx.access, { stage: sp.stage, mine: sp.mine, membershipId: ctx.membershipId });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Leads" sub="People who showed interest on a call. The AI moves a lead forward (new, callback, booked); your team closes it (won or lost)." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/w/${slug}/leads`} className={`btn btn-sm ${!sp.stage ? "btn-dark" : "btn-ghost"}`}>All ({Object.values(counts).reduce((a, b) => a + b, 0)})</Link>
        {STAGES.map(([k, l]) => (
          <Link key={k} href={`/w/${slug}/leads?stage=${k}`} className={`btn btn-sm ${sp.stage === k ? "btn-dark" : "btn-ghost"}`}>{l} ({counts[k] ?? 0})</Link>
        ))}
        {ctx.membershipId ? <Link href={`/w/${slug}/leads?mine=1${sp.stage ? `&stage=${sp.stage}` : ""}`} className={`btn btn-sm ml-auto ${sp.mine ? "btn-dark" : "btn-ghost"}`}>Assigned to me</Link> : null}
      </div>
      <Section title={`${rows.length} lead${rows.length === 1 ? "" : "s"}`}>
        {rows.length === 0 ? (
          <Empty>No leads here yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Person</th><th>Interested in</th><th>Stage</th><th>Follow-up</th><th>Update</th></tr></thead>
              <tbody>
                {rows.map(({ l, name, phone, branchName, ownerName }) => {
                  const edit = can(ctx.access, "contacts:edit", { branchId: l.branchId });
                  return (
                    <tr key={l.id}>
                      <td>
                        <div className="font-semibold">{name ?? "Unknown"}</div>
                        <div className="font-mono text-[12px] text-grey">{phoneFor(can(ctx.access, "contacts:reveal_phone", { branchId: l.branchId }), phone)}</div>
                        <div className="text-[12px] text-grey">{branchName ?? ""}{ownerName ? ` · ${ownerName}` : ""}</div>
                      </td>
                      <td className="max-w-[28ch]">
                        {l.interest ?? <span className="text-grey">Not captured</span>}
                        {l.preferredTimeText ? <div className="text-[12px] text-grey">Wants: {l.preferredTimeText}</div> : null}
                        {l.temperature ? <span className={`badge mt-1 ${l.temperature === "hot" ? "badge-bad" : l.temperature === "warm" ? "badge-warn" : "badge-muted"}`}>{l.temperature}</span> : null}
                      </td>
                      <td><StatusBadge status={l.stage} />{l.lostReason ? <div className="text-[12px] text-grey">{l.lostReason}</div> : null}</td>
                      <td className="whitespace-nowrap">{l.nextFollowUpAt ? fmtDate(l.nextFollowUpAt, false) : <span className="text-grey">None</span>}</td>
                      <td>
                        {edit ? (
                          <form action={updateLead} className="flex flex-wrap gap-1.5">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="id" value={l.id} />
                            <input type="hidden" name="back" value={`leads${sp.stage ? `?stage=${sp.stage}` : ""}`} />
                            <select name="stage" defaultValue={l.stage} className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Stage">
                              {STAGES.map(([k, lab]) => <option key={k} value={k}>{lab}</option>)}
                            </select>
                            <input type="date" name="followUp" min={today} className="input h-[30px] w-[140px] py-0 text-[12.5px]" aria-label="Follow-up date" />
                            <select name="owner" defaultValue="" className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Owner">
                              <option value="">Owner unchanged</option>
                              <option value="none">Nobody</option>
                              {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                            <input name="lostReason" placeholder="If lost, why" className="input h-[30px] w-[130px] text-[12.5px]" aria-label="Lost reason" />
                            <button className="btn btn-ghost btn-sm" type="submit">Save</button>
                          </form>
                        ) : (
                          <span className="text-[12.5px] text-grey">View only</span>
                        )}
                      </td>
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
