import type { Metadata } from "next";
import { PROVISIONING_STEPS } from "@jenai/db";
import { can, holdsAnywhere } from "@jenai/authz";
import { PageHead, Section, StatusBadge, TextLink, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadOverview } from "@/server/queries/workspace";

export const metadata: Metadata = { title: "Overview" };

const NEXT_MODULES = [
  ["Calls and recordings", "Every AI call with summary, transcript and recording, filtered by branch."],
  ["Leads and contacts", "Leads from calls, forms and WhatsApp with owner, stage and follow-up."],
  ["Campaigns", "Reminder, recall and outreach calls that respect calling hours, DND and consent."],
  ["AI agents", "Versioned agents with test calls; one publish updates inbound and outbound together."],
  ["Phone numbers", "Your own numbers and caller IDs, declared for AI calling."],
  ["Billing", "Plan, prepaid wallet, usage and GST invoices."],
] as const;

export default async function Overview({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  const o = await loadOverview(ctx.org.id);
  const passed = o.steps.filter((s) => s.status === "passed").length;
  const total = PROVISIONING_STEPS.length;
  const myRoles = [...new Set(ctx.access.grants.map((g) => g.roleKey.replace(/_/g, " ")))];

  return (
    <>
      <PageHead
        title={`Welcome${ctx.support ? "" : `, ${ctx.user.name.split(" ")[0]}`}`}
        sub={ctx.support ? "You are viewing this workspace as JENAI support." : myRoles.length ? `Your access: ${myRoles.join(", ")}.` : undefined}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="card card-pad">
          <div className="eyebrow">Go-live checks</div>
          <div className="h-display mt-1 text-[28px]">{passed}<span className="text-[18px] text-grey"> / {total}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ivory-2"><div className="h-full bg-copper" style={{ width: `${(passed / total) * 100}%` }} /></div>
        </div>
        <div className="card card-pad">
          <div className="eyebrow">Team members</div>
          <div className="h-display mt-1 text-[28px]">{o.memberCount}</div>
          {holdsAnywhere(ctx.access, "users:view") ? <TextLink href={`/w/${slug}/team`} className="mt-1 inline-block text-[13px]">Manage team</TextLink> : null}
        </div>
        <div className="card card-pad">
          <div className="eyebrow">Branches</div>
          <div className="h-display mt-1 text-[28px]">{o.branchCount}</div>
          {o.pendingSupport && can(ctx.access, "support_access:grant") ? (
            <TextLink href={`/w/${slug}/settings`} className="mt-1 inline-block text-[13px]">{o.pendingSupport} support request waiting</TextLink>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Section title="Getting fully live" sub="JENAI runs these checks with you. A workspace goes live only when every one passes.">
          <ul className="divide-y divide-line">
            {PROVISIONING_STEPS.map((s) => {
              const st = o.steps.find((x) => x.step === s.key);
              return (
                <li key={s.key} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div>
                    <div className="font-semibold">{s.label}</div>
                    <div className="text-[12.5px] text-grey">{st?.detail ?? s.help}</div>
                  </div>
                  <StatusBadge status={st?.status ?? "pending"} />
                </li>
              );
            })}
          </ul>
        </Section>

        <div className="grid content-start gap-6">
          {can(ctx.access, "audit:view") ? (
            <Section title="Recent activity" actions={<TextLink href={`/w/${slug}/activity`} className="text-[13px]">All activity</TextLink>}>
              <ul className="divide-y divide-line">
                {o.recent.map((e) => (
                  <li key={e.id} className="px-5 py-2.5">
                    <div className="text-[13.5px]">{e.summary}</div>
                    <div className="text-[12px] text-grey">{fmtDate(e.createdAt)}{e.via === "support" ? " · JENAI support" : ""}</div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title="Coming to this workspace" sub="Being built now, in this order.">
            <ul className="divide-y divide-line">
              {NEXT_MODULES.map(([t, d]) => (
                <li key={t} className="px-5 py-2.5">
                  <div className="font-semibold">{t}</div>
                  <div className="text-[12.5px] text-grey">{d}</div>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
