import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PROVISIONING_STEPS } from "@jenai/db";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/client";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { clientDetail } from "@/server/platform/queries";
import { goLive, requestSupport, setClientStatus, setStepStatus } from "@/server/actions/console";
import { PlanSection, TelephonySection, VoiceSection } from "./modules";

export const metadata: Metadata = { title: "Client" };

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { id } = await params;
  const flash = await searchParams;
  const ctx = await requirePlatform("platform:clients.view");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await clientDetail(id);
  if (!d) notFound();
  const { org } = d;
  const provision = platformCan(ctx, "platform:clients.provision");
  const manage = platformCan(ctx, "platform:clients.manage");
  const passed = d.steps.filter((s) => s.status === "passed").length;
  const branchName = (bid: string | null) => (bid ? (d.branches.find((b) => b.id === bid)?.name ?? "branch") : "whole org");
  const now = new Date();
  const standing = org.supportAccessUntil && org.supportAccessUntil > now;

  return (
    <>
      <PageHead
        title={org.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={org.status} />
            <span className="capitalize">{org.vertical?.replace("_", " ")}</span>·<span className="capitalize">{org.plan.replace("_", " ")} plan</span>·<span className="font-mono text-[12.5px]">/w/{org.slug}</span>
            {org.suspendedReason ? <span className="text-bad">Suspended: {org.suspendedReason}</span> : null}
          </span>
        }
        actions={
          manage ? (
            org.status === "suspended" ? (
              <form action={setClientStatus}>
                <input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="status" value="active" />
                <button className="btn btn-ghost" type="submit">Reactivate</button>
              </form>
            ) : (
              <form action={setClientStatus} className="flex gap-2">
                <input type="hidden" name="orgId" value={org.id} /><input type="hidden" name="status" value="suspended" />
                <input className="input h-9 w-56" name="reason" placeholder="Reason (e.g. unpaid invoice)" aria-label="Suspension reason" />
                <ConfirmButton message={`Suspend ${org.name}? Calls and changes pause for the whole workspace.`} className="btn btn-danger">Suspend</ConfirmButton>
              </form>
            )
          ) : null
        }
      />
      <Flash {...flash} />

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <VoiceSection orgId={org.id} canManage={manage} canProvision={provision} />
        <div className="grid content-start gap-6">
          <TelephonySection orgId={org.id} canManage={platformCan(ctx, "platform:telephony.manage")} />
        </div>
      </div>
      <div className="mb-6">
        <PlanSection orgId={org.id} canManage={manage && platformCan(ctx, "platform:billing.view")} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Section
          title={`Go-live checklist (${passed}/${PROVISIONING_STEPS.length})`}
          sub="Each step is recorded in the client's own activity log."
          actions={
            provision && org.status === "onboarding" ? (
              <form action={goLive}>
                <input type="hidden" name="orgId" value={org.id} />
                <button className="btn btn-primary btn-sm" type="submit" disabled={passed < PROVISIONING_STEPS.length}>Go live</button>
              </form>
            ) : null
          }
        >
          <ul className="divide-y divide-line">
            {PROVISIONING_STEPS.map((s) => {
              const st = d.steps.find((x) => x.step === s.key);
              return (
                <li key={s.key} className="grid gap-2 px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{s.label}</div>
                      <div className="text-[12.5px] text-grey">{st?.detail ?? s.help}</div>
                    </div>
                    <StatusBadge status={st?.status ?? "pending"} />
                  </div>
                  {provision ? (
                    <form action={setStepStatus} className="flex flex-wrap gap-1.5">
                      <input type="hidden" name="orgId" value={org.id} />
                      <input type="hidden" name="step" value={s.key} />
                      <select name="status" defaultValue={st?.status ?? "pending"} className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label={`Status of ${s.label}`}>
                        {["pending", "in_progress", "passed", "failed", "skipped"].map((v) => <option key={v} value={v}>{v.replace("_", " ")}</option>)}
                      </select>
                      <input name="detail" defaultValue={st?.detail ?? ""} placeholder="Note (evidence, blocker)" className="input h-[30px] min-w-[200px] flex-1 text-[12.5px]" aria-label={`Note for ${s.label}`} />
                      <button className="btn btn-ghost btn-sm" type="submit">Update</button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>

        <div className="grid content-start gap-6">
          {platformCan(ctx, "platform:support.request") ? (
            <Section title="Ask for support access" sub={standing ? `Client allows read-only support until ${fmtDate(org.supportAccessUntil)}; read requests start immediately.` : "The client approves each request. Change access also needs a second Diigoo approver."}>
              <form action={requestSupport} className="grid gap-3 px-5 py-4">
                <input type="hidden" name="orgId" value={org.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="s-mode">Access</label>
                    <select className="input" id="s-mode" name="mode" defaultValue="read">
                      <option value="read">Read-only</option>
                      <option value="write">Can make changes</option>
                      {platformCan(ctx, "platform:breakglass") ? <option value="breakglass">Emergency (break-glass, 15 min)</option> : null}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="s-min">For</label>
                    <select className="input" id="s-min" name="minutes" defaultValue="60">
                      <option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option>
                    </select>
                  </div>
                </div>
                <div><label className="label" htmlFor="s-ticket">Ticket</label><input className="input" id="s-ticket" name="ticket" placeholder="SUP-1043" /></div>
                <div><label className="label" htmlFor="s-reason">Reason the client will see</label><textarea className="input" id="s-reason" name="reason" rows={2} required minLength={10} /></div>
                <div><SubmitButton pendingText="Sending">Send request</SubmitButton></div>
              </form>
            </Section>
          ) : null}

          <Section title={`People (${new Set(d.members.map((m) => m.membershipId)).size})`} sub="Names and roles only. Their calls and contacts need a support grant.">
            {d.members.length === 0 ? (
              <Empty>Waiting for the Owner to accept the invitation.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {[...new Set(d.members.map((m) => m.membershipId))].map((mid) => {
                  const rows = d.members.filter((m) => m.membershipId === mid);
                  const m = rows[0]!;
                  return (
                    <li key={mid} className="px-5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{m.name}</span>
                        <StatusBadge status={m.status} />
                      </div>
                      <div className="text-[12.5px] text-grey">{rows.filter((r) => r.role).map((r) => `${r.role} (${branchName(r.branchId)})`).join(", ") || "No role"}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Recent activity in this workspace">
            <ul className="divide-y divide-line">
              {d.recent.map((e) => (
                <li key={e.id} className="px-5 py-2.5">
                  <div className="text-[13px]">{e.summary}</div>
                  <div className="text-[12px] text-grey">{fmtDate(e.createdAt)}</div>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
