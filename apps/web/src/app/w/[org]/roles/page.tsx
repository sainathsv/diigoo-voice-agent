import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CLIENT_MODULES, can, holdsAnywhere } from "@jenai/authz";
import { Flash, PageHead, Section } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { cloneRole, updateRolePermissions } from "@/server/actions/workspace";
import { loadTeam } from "@/server/queries/workspace";

export const metadata: Metadata = { title: "Roles and access" };

export default async function RolesPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ role?: string; ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "users:view")) notFound();
  const t = await loadTeam(ctx.org.id);
  const selected = t.roles.find((r) => r.id === sp.role) ?? t.roles.find((r) => r.key === "front_desk") ?? t.roles[0];
  const manage = can(ctx.access, "roles:manage");
  const editable = !!selected && selected.tenantId === ctx.org.id && manage;
  const people = (roleId: string) => new Set(t.bindings.filter((b) => b.roleId === roleId).map((b) => b.membershipId)).size;

  return (
    <>
      <PageHead title="Roles and access" sub="A role says what someone can do; the branch you grant it for says where. Templates are fixed; clone one to make your own." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="card overflow-hidden">
          <ul className="divide-y divide-line">
            {t.roles.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/w/${slug}/roles?role=${r.id}`}
                  className={`block px-4 py-3 hover:bg-ivory ${selected?.id === r.id ? "bg-copper-wash" : ""}`}
                  aria-current={selected?.id === r.id ? "true" : undefined}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{r.name}</span>
                    <span className="text-[12px] text-grey">{people(r.id)} people</span>
                  </div>
                  <div className="text-[12px] text-grey">{r.tenantId ? "Custom role" : "Template"} · {r.defaultScope === "branch" ? "per branch" : "whole organization"}</div>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {selected ? (
          <div className="grid content-start gap-6">
            <Section title={selected.name} sub={selected.description}>
              <form action={updateRolePermissions}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="roleId" value={selected.id} />
                <div className="grid gap-px bg-line sm:grid-cols-2">
                  {Object.entries(CLIENT_MODULES).map(([key, mod]) => (
                    <fieldset key={key} className="bg-paper px-5 py-4">
                      <legend className="eyebrow mb-2">{mod.label}</legend>
                      <div className="grid gap-1.5">
                        {Object.entries(mod.permissions).map(([perm, label]) => {
                          const on = selected.permissions.includes(perm);
                          return (
                            <label key={perm} className={`flex items-start gap-2 text-[13px] ${on ? "text-ink" : "text-grey"}`}>
                              <input type="checkbox" name="perm" value={perm} defaultChecked={on} disabled={!editable || perm === "org:transfer_ownership"} className="mt-0.5 accent-[#C96A3C]" />
                              <span>{label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                </div>
                {editable ? (
                  <div className="border-t border-line px-5 py-3"><SubmitButton pendingText="Saving">Save permissions</SubmitButton></div>
                ) : null}
              </form>
            </Section>
            {manage ? (
              <Section title="Make a custom role" sub={`Starts as a copy of ${selected.name}. You can only include permissions you hold yourself.`}>
                <form action={cloneRole} className="flex flex-wrap items-end gap-3 px-5 py-4">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="fromId" value={selected.id} />
                  <div className="min-w-[240px] flex-1">
                    <label className="label" htmlFor="role-name">New role name</label>
                    <input className="input" id="role-name" name="name" required minLength={2} placeholder="Senior receptionist" />
                  </div>
                  <SubmitButton pendingText="Creating">Clone role</SubmitButton>
                </form>
              </Section>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
