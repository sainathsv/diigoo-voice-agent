import type { Metadata } from "next";
import { Avatar, Flash, PageHead, Section, StatusBadge } from "@/components/ui";
import { requirePlatform } from "@/server/platform/context";
import { listStaff } from "@/server/platform/queries";
import { removeStaffRole } from "@/server/actions/console";
import { StaffInvite } from "./staff-invite";

export const metadata: Metadata = { title: "Diigoo team" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const flash = await searchParams;
  const ctx = await requirePlatform("platform:staff.manage");
  const s = await listStaff(ctx.platformOrgId);

  return (
    <>
      <PageHead title="Diigoo team" sub="Staff who run JENAI. Roles decide which console areas they see; none of them includes client call data." />
      <Flash {...flash} />
      <div className="grid gap-6">
        <Section title={`Staff (${s.people.length})`}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Person</th><th>Roles</th><th>Status</th></tr></thead>
              <tbody>
                {s.people.map((p) => (
                  <tr key={p.membershipId}>
                    <td>
                      <div className="flex items-center gap-2.5"><Avatar name={p.name} /><div><div className="font-semibold">{p.name}</div><div className="text-[12.5px] text-grey">{p.email}</div></div></div>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        {s.bindings.filter((b) => b.membershipId === p.membershipId).map((b) => (
                          <form key={b.id} action={removeStaffRole} className="inline-flex">
                            <input type="hidden" name="bindingId" value={b.id} />
                            <span className="badge badge-copper">
                              {b.roleName}
                              {p.email !== ctx.user.email ? (
                                <button type="submit" className="ml-0.5 font-bold opacity-60 hover:opacity-100" aria-label={`Remove ${b.roleName}`}>×</button>
                              ) : null}
                            </span>
                          </form>
                        ))}
                      </div>
                    </td>
                    <td><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Invite a colleague" sub="Only a super admin can add another super admin.">
          <StaffInvite roles={s.platformRoles.map((r) => ({ id: r.id, name: r.name, description: r.description }))} />
        </Section>
        <Section title="What each role can do">
          <ul className="divide-y divide-line">
            {s.platformRoles.map((r) => (
              <li key={r.id} className="px-5 py-2.5"><div className="font-semibold">{r.name}</div><div className="text-[12.5px] text-grey">{r.description}</div></li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}
