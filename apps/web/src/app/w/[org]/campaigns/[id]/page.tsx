import type { Metadata } from "next";
import Link from "next/link";
import { can, phoneFor } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { loadCampaign } from "@/server/queries/modules";
import { addTargets, campaignTransition } from "@/server/actions/modules";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Campaign" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Move({ slug, id, to, label, primary = false }: { slug: string; id: string; to: string; label: string; primary?: boolean }) {
  return (
    <form action={campaignTransition}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="campaignId" value={id} />
      <input type="hidden" name="to" value={to} />
      <button className={`btn btn-sm ${primary ? "btn-primary" : "btn-ghost"}`} type="submit">{label}</button>
    </form>
  );
}

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug, id } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return deny(ctx, { malformedId: id.slice(0, 80) });
  const d = await loadCampaign(ctx.org.id, id);
  if (!d) return deny(ctx, { missing: id });
  const scope = { branchId: d.c.branchId };
  if (!can(ctx.access, "campaigns:view", scope)) return deny(ctx, { perm: "campaigns:view", id });
  const c = d.c;
  const reveal = can(ctx.access, "contacts:reveal_phone", scope);
  const counts = d.targets.reduce<Record<string, number>>((m, t) => ((m[t.state] = (m[t.state] ?? 0) + 1), m), {});
  const canCreate = can(ctx.access, "campaigns:create", scope);
  const canApprove = can(ctx.access, "campaigns:approve", scope) && c.createdBy !== ctx.user.userId;
  const canLaunch = can(ctx.access, "campaigns:launch", scope);

  return (
    <>
      <PageHead
        title={c.name}
        sub={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={c.status} /><span className="capitalize">{c.purpose}</span>·<span>{d.agentName}</span>·<span className="font-mono">{d.number?.e164}</span>·<span>{c.windows.days.map((x) => DAYS[x]).join(" ")} {c.windows.start} to {c.windows.end}</span></span>}
        actions={
          <div className="flex flex-wrap gap-2">
            {c.status === "draft" && canCreate ? <Move slug={slug} id={id} to="pending_approval" label="Send for approval" primary /> : null}
            {c.status === "pending_approval" && canApprove ? <Move slug={slug} id={id} to="approved" label="Approve" primary /> : null}
            {(c.status === "approved" || c.status === "paused") && canLaunch ? <Move slug={slug} id={id} to="running" label={c.status === "paused" ? "Resume" : "Start calling"} primary /> : null}
            {c.status === "running" && canLaunch ? <Move slug={slug} id={id} to="paused" label="Pause" /> : null}
            {["draft", "pending_approval", "approved", "paused"].includes(c.status) && canCreate ? <Move slug={slug} id={id} to="cancelled" label="Cancel" /> : null}
            <Link className="btn btn-ghost btn-sm" href={`/w/${slug}/campaigns`}>All campaigns</Link>
          </div>
        }
      />
      <Flash {...flash} />
      {c.status === "pending_approval" && c.createdBy === ctx.user.userId ? <div className="notice notice-warn mb-5">Waiting for someone else to approve. The person who creates a campaign cannot approve it.</div> : null}
      {d.number && !d.number.a2pDeclaredAt ? <div className="notice notice-bad mb-5">The caller number {d.number.e164} is not declared for AI calls yet, so this campaign cannot be approved. JENAI files the declaration with the operator.</div> : null}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        {[["Waiting", (counts.queued ?? 0) + (counts.scheduled ?? 0)], ["Calling now", counts.dialing ?? 0], ["Done", counts.completed ?? 0], ["Skipped by checks", counts.skipped ?? 0], ["Cancelled", counts.cancelled ?? 0]].map(([l, n]) => (
          <div key={l as string} className="card card-pad"><div className="eyebrow">{l}</div><div className="h-display mt-1 text-[24px] tabular-nums">{n}</div></div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Section title="People to call" sub="Latest 300, most recently updated first.">
          {d.targets.length === 0 ? (
            <Empty>Nobody added yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Person</th><th>State</th><th className="num">Tries</th><th>Next try or result</th></tr></thead>
                <tbody>
                  {d.targets.map((t) => (
                    <tr key={t.id}>
                      <td><div className="font-semibold">{t.name ?? "Unknown"}</div><div className="font-mono text-[12px] text-grey">{phoneFor(reveal, t.phoneE164)}</div></td>
                      <td><StatusBadge status={t.state === "scheduled" ? "pending" : t.state === "dialing" ? "in_progress" : t.state} /></td>
                      <td className="num">{t.attemptNo}</td>
                      <td className="text-[12.5px]">{t.skipReason ?? (t.state === "completed" ? t.lastOutcome : t.state === "scheduled" || t.state === "queued" ? fmtDate(t.nextAttemptAt) : t.lastOutcome ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <div className="grid content-start gap-6">
          {canCreate && can(ctx.access, "contacts:import", scope) && ["draft", "pending_approval", "approved", "paused"].includes(c.status) ? (
            <Section title="Add people" sub="One per line: phone number, then name. Up to 5,000 at a time.">
              <form action={addTargets} className="grid gap-3 px-5 py-4">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="campaignId" value={id} />
                <textarea className="input font-mono text-[12.5px]" name="lines" rows={7} required placeholder={"9876543210, Ravi Kumar\n+91 91234 56789, Priya"} aria-label="People to call" />
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" name="attest" className="mt-0.5 accent-[#C96A3C]" required />
                  <span>I confirm these people agreed to receive {c.purpose} calls from us (for example, they are existing patients or asked to be contacted). This confirmation is saved with my name.</span>
                </label>
                <div><SubmitButton pendingText="Adding">Add to campaign</SubmitButton></div>
              </form>
            </Section>
          ) : null}
          <Section title="Why each call was placed or not" sub="The compliance check result for the latest attempts.">
            {d.log.length === 0 ? (
              <Empty>No attempts yet.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {d.log.map((l) => (
                  <li key={l.id} className="px-5 py-2.5 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`badge ${l.decision === "dial" ? "badge-ok" : l.decision === "skip" ? "badge-bad" : "badge-muted"}`}>{l.decision === "dial" ? "Called" : l.decision === "skip" ? "Not called" : "Waiting"}</span>
                      <span className="text-[12px] text-grey">{fmtDate(l.createdAt)}</span>
                    </div>
                    <div className="mt-1">{l.reason}{l.outcome ? `: ${l.outcome.replace("_", " ")}` : ""}{l.gateway === "simulated" ? " (simulated)" : ""}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Approvals">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 px-5 py-4 text-[13px]">
              <dt className="text-grey">Created by</dt><dd>{d.people[c.createdBy ?? ""] ?? "Unknown"}</dd>
              <dt className="text-grey">Approved by</dt><dd>{c.approvedBy ? `${d.people[c.approvedBy] ?? "Unknown"}, ${fmtDate(c.approvedAt)}` : "Not yet"}</dd>
              <dt className="text-grey">Started</dt><dd>{c.launchedAt ? fmtDate(c.launchedAt) : "Not yet"}</dd>
            </dl>
          </Section>
        </div>
      </div>
    </>
  );
}
