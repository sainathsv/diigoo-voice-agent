import type { Metadata } from "next";
import { holdsAnywhere } from "@jenai/authz";
import { SERIES_LABEL } from "@jenai/engine";
import { Flash, PageHead, Section } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { loadCampaignForm } from "@/server/queries/modules";
import { createCampaign } from "@/server/actions/modules";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "New campaign" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function NewCampaign({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ error?: string }> }) {
  const { org: slug } = await params;
  const { error } = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "campaigns:create")) return deny(ctx, { perm: "campaigns:create" });
  const f = await loadCampaignForm(ctx.org.id);

  if (!f.campaignsAllowed) {
    return (
      <>
        <PageHead title="New campaign" />
        <div className="card card-pad">Outbound campaigns are not part of the {f.planName} plan. Ask JENAI about the Growth plan.</div>
      </>
    );
  }
  return (
    <>
      <PageHead title="New campaign" sub="After you save, add the people to call, send it for approval, and someone else approves before it can start." />
      <Flash error={error} />
      <Section title="Campaign">
        <form action={createCampaign} className="grid gap-5 px-5 py-5">
          <input type="hidden" name="slug" value={slug} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="label" htmlFor="c-name">Name</label><input className="input" id="c-name" name="name" required minLength={3} placeholder="October cleaning recall" /></div>
            <div>
              <label className="label" htmlFor="c-purpose">Purpose</label>
              <select className="input" id="c-purpose" name="purpose" defaultValue="service">
                <option value="service">Service (reminders, follow-ups for existing patients or customers)</option>
                <option value="transactional">Transactional (appointment or payment confirmations)</option>
                <option value="promotional">Promotional (offers; needs a 140-series number and explicit consent)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="c-agent">AI agent</label>
              <select className="input" id="c-agent" name="agentId" required>
                {f.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="c-num">Caller number</label>
              <select className="input" id="c-num" name="callerNumberId" required>
                {f.numbers.map((n) => <option key={n.id} value={n.id}>{n.e164} · {SERIES_LABEL[n.series]}{n.a2pDeclaredAt ? "" : " (not declared yet)"}</option>)}
              </select>
              {f.numbers.length === 0 ? <p className="help text-bad">No outbound number yet. Ask JENAI to set one up.</p> : null}
            </div>
            <div>
              <label className="label" htmlFor="c-branch">Branch</label>
              <select className="input" id="c-branch" name="branchId" defaultValue="">
                <option value="">Whole organization</option>
                {f.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="c-pt">What the call is about (said in the opening)</label><input className="input" id="c-pt" name="callPurposeText" maxLength={120} placeholder="your six-month dental check-up" /></div>
          </div>
          <fieldset className="grid gap-3">
            <legend className="eyebrow mb-2">Calling hours (never before 9 AM or after 9 PM)</legend>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1.5 text-[13.5px]"><input type="checkbox" name="days" value={i} defaultChecked={i !== 0} className="accent-[#C96A3C]" />{d}</label>
              ))}
            </div>
            <div className="flex flex-wrap gap-4">
              <div><label className="label" htmlFor="c-start">From</label><input className="input w-32" id="c-start" type="time" name="start" defaultValue="10:00" min="09:00" max="21:00" /></div>
              <div><label className="label" htmlFor="c-end">Until</label><input className="input w-32" id="c-end" type="time" name="end" defaultValue="19:00" min="09:00" max="21:00" /></div>
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label className="label" htmlFor="c-att">Attempts per person</label><input className="input" id="c-att" type="number" name="maxAttempts" defaultValue={3} min={1} max={5} /></div>
            <div><label className="label" htmlFor="c-cc">Calls at the same time</label><input className="input" id="c-cc" type="number" name="maxConcurrency" defaultValue={2} min={1} max={50} /></div>
            <div><label className="label" htmlFor="c-cap">Max calls per person per day</label><input className="input" id="c-cap" type="number" name="dailyCap" defaultValue={2} min={1} max={3} /></div>
          </div>
          <div><SubmitButton pendingText="Creating">Create campaign</SubmitButton></div>
        </form>
      </Section>
    </>
  );
}
