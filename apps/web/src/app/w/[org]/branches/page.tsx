import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can, holdsAnywhere } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { createBranch, setBranchStatus } from "@/server/actions/workspace";
import { loadBranches } from "@/server/queries/workspace";

export const metadata: Metadata = { title: "Branches" };

export default async function BranchesPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "users:view")) notFound();
  const rows = await loadBranches(ctx.org.id);
  const manage = can(ctx.access, "branches:manage");

  return (
    <>
      <PageHead title="Branches" sub="Clinics, centres or wards. Phone numbers, AI agents, hours and staff access attach to a branch." />
      <Flash {...flash} />
      <div className="grid gap-6">
        <Section title={`All branches (${rows.length})`}>
          {rows.length === 0 ? (
            <Empty>No branches yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Branch</th><th>City</th><th>Languages</th><th className="num">People with branch access</th><th>Status</th>{manage ? <th /> : null}</tr></thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td><div className="font-semibold">{b.name}</div>{b.address ? <div className="text-[12.5px] text-grey">{b.address}</div> : null}</td>
                      <td>{b.city ?? ""}</td>
                      <td className="uppercase text-[12.5px] text-ink-soft">{b.languages.join(" · ")}</td>
                      <td className="num">{b.people}</td>
                      <td><StatusBadge status={b.status} /></td>
                      {manage ? (
                        <td className="text-right">
                          <form action={setBranchStatus}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="id" value={b.id} />
                            <input type="hidden" name="status" value={b.status === "active" ? "inactive" : "active"} />
                            <button className="btn btn-ghost btn-sm" type="submit">{b.status === "active" ? "Mark inactive" : "Reactivate"}</button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        {manage ? (
          <Section title="Add a branch">
            <form action={createBranch} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              <input type="hidden" name="slug" value={slug} />
              <div><label className="label" htmlFor="b-name">Branch name</label><input className="input" id="b-name" name="name" required minLength={2} placeholder="Gachibowli" /></div>
              <div><label className="label" htmlFor="b-city">City</label><input className="input" id="b-city" name="city" placeholder="Hyderabad" /></div>
              <div><label className="label" htmlFor="b-phone">Front desk phone</label><input className="input" id="b-phone" name="phone" placeholder="+91 40 1234 5678" /></div>
              <div><label className="label" htmlFor="b-address">Address</label><input className="input" id="b-address" name="address" /></div>
              <div><SubmitButton pendingText="Adding">Add branch</SubmitButton></div>
            </form>
          </Section>
        ) : null}
      </div>
    </>
  );
}
