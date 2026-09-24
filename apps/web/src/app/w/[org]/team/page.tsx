import type { Metadata } from "next";
import { holdsAnywhere } from "@jenai/authz";
import { Avatar, Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { ConfirmButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { addRoleBinding, removeRoleBinding, revokeInvitation, setMemberStatus } from "@/server/actions/workspace";
import { loadTeam } from "@/server/queries/workspace";
import { InviteForm } from "./invite-form";
import { deny } from "@/server/security-log";
import { displayLogin } from "@jenai/authz";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "users:view")) return deny(ctx, { perm: "users:view" });
  const t = await loadTeam(ctx.org.id);
  const branchName = (id: string | null) => (id ? (t.branches.find((b) => b.id === id)?.name ?? "Branch") : "Whole organization");
  const canAssign = holdsAnywhere(ctx.access, "users:assign_roles");
  const canInvite = holdsAnywhere(ctx.access, "users:invite");
  const activeBranches = t.branches.filter((b) => b.status === "active");

  return (
    <>
      <PageHead title="Team" sub="Everyone who works in this workspace, what they can do, and where. Access is per person; nobody shares a password." />
      <Flash {...flash} />

      <div className="grid gap-6">
        <Section title={`Members (${t.members.length})`}>
          {t.members.length === 0 ? (
            <Empty>No members yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Person</th><th>Roles and where</th><th>Status</th>{canAssign ? <th>Change access</th> : null}</tr>
                </thead>
                <tbody>
                  {t.members.map((m) => {
                    const mine = t.bindings.filter((b) => b.membershipId === m.id);
                    const self = m.id === ctx.membershipId;
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <Avatar name={m.name} />
                            <div>
                              <div className="font-semibold">{m.name}{self ? <span className="ml-1.5 text-[12px] font-normal text-grey">(you)</span> : null}</div>
                              <div className="text-[12.5px] text-grey">{displayLogin(m.email)}</div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            {mine.length === 0 ? <span className="text-grey">No role</span> : null}
                            {mine.map((b) => (
                              <form key={b.id} action={removeRoleBinding} className="inline-flex">
                                <input type="hidden" name="slug" value={slug} />
                                <input type="hidden" name="bindingId" value={b.id} />
                                <span className="badge badge-copper">
                                  {b.roleName} · {branchName(b.branchId)}
                                  {canAssign && !self ? (
                                    <button type="submit" className="ml-0.5 font-bold opacity-60 hover:opacity-100" aria-label={`Remove ${b.roleName}`} title="Remove this role">×</button>
                                  ) : null}
                                </span>
                              </form>
                            ))}
                          </div>
                        </td>
                        <td><StatusBadge status={m.status} /></td>
                        {canAssign ? (
                          <td>
                            {self ? (
                              <span className="text-[12.5px] text-grey">Ask another admin</span>
                            ) : (
                              <div className="grid gap-2">
                                <form action={addRoleBinding} className="flex flex-wrap gap-1.5">
                                  <input type="hidden" name="slug" value={slug} />
                                  <input type="hidden" name="membershipId" value={m.id} />
                                  <select name="roleId" className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Role to add" required defaultValue="">
                                    <option value="" disabled>Add role</option>
                                    {t.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                  </select>
                                  <select name="branchId" className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Where" defaultValue="">
                                    <option value="">Whole org</option>
                                    {activeBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                                  </select>
                                  <button className="btn btn-ghost btn-sm" type="submit">Add</button>
                                </form>
                                <form action={setMemberStatus}>
                                  <input type="hidden" name="slug" value={slug} />
                                  <input type="hidden" name="membershipId" value={m.id} />
                                  <input type="hidden" name="status" value={m.status === "active" ? "suspended" : "active"} />
                                  {m.status === "active" ? (
                                    <ConfirmButton message={`Pause ${m.name}'s access? They are signed out of this workspace until you restore it.`}>Pause access</ConfirmButton>
                                  ) : (
                                    <button className="btn btn-ghost btn-sm" type="submit">Restore access</button>
                                  )}
                                </form>
                              </div>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {canInvite ? (
          <Section title="Invite someone" sub="They get their own login. You can only give access you have yourself.">
            <InviteForm
              slug={slug}
              roles={t.roles.map((r) => ({ id: r.id, name: r.name, defaultScope: r.defaultScope, description: r.description }))}
              branches={activeBranches.map((b) => ({ id: b.id, name: b.name }))}
            />
          </Section>
        ) : null}

        <Section title={`Pending invitations (${t.pending.length})`}>
          {t.pending.length === 0 ? (
            <Empty>No pending invitations.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Email</th><th>Role</th><th>Expires</th>{canInvite ? <th /> : null}</tr></thead>
                <tbody>
                  {t.pending.map((i) => (
                    <tr key={i.id}>
                      <td><div className="font-semibold">{i.name ?? displayLogin(i.email)}</div><div className="text-[12.5px] text-grey">{displayLogin(i.email)}</div></td>
                      <td>{i.roleName} · {branchName(i.branchId)}</td>
                      <td>{fmtDate(i.expiresAt)}</td>
                      {canInvite ? (
                        <td className="text-right">
                          <form action={revokeInvitation}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="id" value={i.id} />
                            <button className="btn btn-danger btn-sm" type="submit">Revoke</button>
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
      </div>
    </>
  );
}
