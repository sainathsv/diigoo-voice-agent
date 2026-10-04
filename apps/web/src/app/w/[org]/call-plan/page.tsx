import type { Metadata } from "next";
import Link from "next/link";
import { branchesFor, can, holdsAnywhere } from "@jenai/authz";
import type { PlannedCallVerdict } from "@jenai/db";
import { PLAN_JOURNEYS, inWindow, nextWindowStart, type PlanJourney, type Windows } from "@jenai/engine";
import { Empty, Flash, PageHead, Pager, Section, StatusBadge, TextLink, fmtDate } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { removeUpload, switchCallPlan } from "@/server/actions/call-plan";
import { CALL_PLAN_PAGE, loadCallPlan, type CallPlanRow, type CallPlanSource, type CallPlanView } from "@/server/queries/call-plan";
import { deny } from "@/server/security-log";
import { VisitUploadForm } from "./visit-upload-form";

export const metadata: Metadata = { title: "Call plan" };

const VERDICTS: Array<{ key: PlannedCallVerdict; label: string; badge: string; sub: string }> = [
  { key: "call_now", label: "Call now", badge: "badge-ok", sub: "Due now, within calling hours" },
  { key: "scheduled", label: "Scheduled", badge: "badge-copper", sub: "Due at a set time" },
  { key: "waiting", label: "Waiting", badge: "badge-warn", sub: "Another call to them comes first" },
  { key: "kept_out", label: "Kept out", badge: "badge-muted", sub: "Not called, with the reason" },
];
const VERDICT_OF = Object.fromEntries(VERDICTS.map((v) => [v.key, v])) as Record<PlannedCallVerdict, (typeof VERDICTS)[number]>;

const KIND: Record<string, string> = { zoho_crm: "Zoho CRM", salesforce: "Salesforce", hubspot: "HubSpot", leadsquared: "LeadSquared", google_sheets: "Google Sheets", zenoti: "Zenoti (front desk)" };

/** A front desk booking's status, in words. */
const BOOKING_STATUS: Record<string, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  completed: "Done",
  no_show: "No-show",
  cancelled: "Cancelled",
  unknown: "Status not known",
};

export default async function CallPlanPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ journey?: string; verdict?: string; page?: string; ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "contacts:view")) return deny(ctx, { perm: "contacts:view" });
  const plan = await loadCallPlan(ctx.org.id, ctx.access, { journey: sp.journey, verdict: sp.verdict, page: Number(sp.page ?? 1) });
  const canUpload = holdsAnywhere(ctx.access, "visits:import") && ctx.org.status !== "suspended";
  // Taking a whole upload out can reach every branch, so it needs the permission across the workspace.
  const canRemoveUpload = can(ctx.access, "visits:import") && ctx.org.status !== "suspended";
  const canSwitch = can(ctx.access, "org:manage") && ctx.org.status !== "suspended";
  const canTune = can(ctx.access, "org:manage") || can(ctx.access, "integrations:manage");
  const someBranches = branchesFor(ctx.access, "contacts:view") !== "all";
  const tz = zoneOf(ctx.org.timezone);
  const now = new Date();
  const planned = VERDICTS.reduce((n, v) => n + plan.byVerdict[v.key], 0);
  const nothing = !plan.sources.length && !plan.visits.total && !plan.visits.lastUpload && !planned;

  const q = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries({ journey: plan.journey, verdict: plan.verdict, ...over }).filter(([, v]) => v) as [string, string][]);
    return `/w/${slug}/call-plan${u.size ? `?${u}` : ""}`;
  };

  return (
    <>
      <PageHead
        title="Call plan"
        sub="Everyone in your records, the call JENAI would make to each of them, when and why, or why they are kept out."
        actions={canTune ? <TextLink href={`/w/${slug}/call-plan/settings`}>Plan settings</TextLink> : null}
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="notice notice-warn mb-5" role="status">
        <b>Preview.</b> Nobody is being called yet. JENAI shows who it would call and why. Calls start only when calling is switched on for this workspace.
      </div>
      {plan.stale && plan.computedAt ? (
        <div className="notice notice-warn mb-5" role="status">
          This plan was worked out {fmtDate(plan.computedAt, true, tz)} and could not be worked out again just now, so some times may have moved on. It is tried again on your next visit.
        </div>
      ) : null}

      <div className="grid gap-6">
        <Section title="Where the plan comes from" sub="Your CRM records and your front desk system (Zenoti), which JENAI only reads to make this plan, and the visit list your team uploads.">
          {nothing ? (
            <Empty>
              Connect Zoho, ask JENAI support to connect your Zenoti, or upload a visit list to see who JENAI would call.
              {can(ctx.access, "integrations:manage") ? (
                <div className="mt-2"><TextLink href={`/w/${slug}/integrations`}>Connect Zoho</TextLink></div>
              ) : null}
            </Empty>
          ) : (
            <div className="grid gap-5 px-5 py-4 md:grid-cols-2">
              <div>
                <div className="eyebrow">CRM and front desk</div>
                {plan.sources.length ? (
                  <>
                    <ul className="mt-2 grid gap-3">
                      {plan.sources.map((s) => <SourceLine key={s.id} s={s} tz={tz} plan={plan} />)}
                    </ul>
                    <PlanSwitch plan={plan} slug={slug} canSwitch={canSwitch} />
                  </>
                ) : (
                  <p className="mt-2 text-ink-soft">
                    No CRM or front desk system connected.{" "}
                    {can(ctx.access, "integrations:manage") ? <TextLink href={`/w/${slug}/integrations`}>Connect Zoho</TextLink> : "An admin can connect Zoho under Your systems."}
                  </p>
                )}
              </div>
              <div>
                <div className="eyebrow">Visit list</div>
                <div className="mt-2 grid gap-1">
                  <div className="font-semibold">{plan.visits.total ? `${plan.visits.total.toLocaleString("en-IN")} ${plan.visits.total === 1 ? "visit" : "visits"} on file` : "No visits on file yet"}</div>
                  {plan.visits.lastUpload ? (
                    <div className="text-[13px] text-ink-soft">
                      Last upload {fmtDate(plan.visits.lastUpload.at, true, tz)}
                      {plan.visits.lastUpload.by ? ` by ${plan.visits.lastUpload.by}` : ""}: {plan.visits.lastUpload.added.toLocaleString("en-IN")} added, {plan.visits.lastUpload.updated.toLocaleString("en-IN")} updated
                      {plan.visits.lastUpload.refused ? `, ${plan.visits.lastUpload.refused.toLocaleString("en-IN")} ${plan.visits.lastUpload.refused === 1 ? "row" : "rows"} not used` : ""}.
                      {canRemoveUpload && plan.visits.lastUpload.batch && plan.visits.lastUpload.added + plan.visits.lastUpload.updated > 0 ? (
                        <form action={removeUpload} className="mt-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="batch" value={plan.visits.lastUpload.batch} />
                          <ConfirmButton className="btn btn-ghost btn-sm" message="Take out the visits this upload added or changed? The plan is worked out again without them.">Remove this upload</ConfirmButton>
                        </form>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-[13px] text-ink-soft">{canUpload ? "Upload it below." : "A workspace admin or branch manager can upload it."}</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </Section>

        {planned ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {VERDICTS.map((v) => (
                <Link key={v.key} href={q({ verdict: plan.verdict === v.key ? undefined : v.key, page: undefined })} className={`card px-4 py-3 hover:border-copper ${plan.verdict === v.key ? "border-copper" : ""}`} aria-current={plan.verdict === v.key ? "true" : undefined}>
                  <div className="eyebrow">{v.label}</div>
                  <div className="mt-1 text-[24px] font-semibold tabular-nums text-ink">{plan.byVerdict[v.key].toLocaleString("en-IN")}</div>
                  <div className="text-[12px] text-grey">{v.sub}</div>
                </Link>
              ))}
            </div>

            <Section title="By kind of call" sub={`${plan.computedAt ? `Worked out ${fmtDate(plan.computedAt, true, tz)}. ` : ""}One call per person at a time: the one that comes first.${someBranches ? " Showing people in your branches." : ""}`}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>What JENAI would do</th>{VERDICTS.map((v) => <th key={v.key} className="num">{v.label}</th>)}<th className="num">Total</th></tr></thead>
                  <tbody>
                    {plan.byJourney.map((j) => (
                      <tr key={j.journey}>
                        <td><Link className="font-semibold hover:text-copper-deep" href={q({ journey: j.journey, page: undefined })}>{j.label}</Link></td>
                        {VERDICTS.map((v) => <td key={v.key} className={`num ${j[v.key] ? "" : "text-grey"}`}>{j[v.key].toLocaleString("en-IN")}</td>)}
                        <td className="num font-semibold">{j.total.toLocaleString("en-IN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={`${plan.total.toLocaleString("en-IN")} ${plan.total === 1 ? "person or record" : "people and records"}${plan.journey || plan.verdict ? " matching" : ""}`} sub="Phone numbers show the last 4 digits only.">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
                <Link href={q({ verdict: undefined, page: undefined })} className={`btn btn-sm ${!plan.verdict ? "btn-dark" : "btn-ghost"}`}>Any</Link>
                {VERDICTS.map((v) => (
                  <Link key={v.key} href={q({ verdict: v.key, page: undefined })} className={`btn btn-sm ${plan.verdict === v.key ? "btn-dark" : "btn-ghost"}`}>{v.label}</Link>
                ))}
                <form className="ml-auto flex gap-2" action={`/w/${slug}/call-plan`}>
                  {plan.verdict ? <input type="hidden" name="verdict" value={plan.verdict} /> : null}
                  <select name="journey" defaultValue={plan.journey ?? ""} className="input h-[30px] w-auto max-w-[260px] py-0 text-[12.5px]" aria-label="Kind of call">
                    <option value="">Every kind of call</option>
                    {(Object.keys(PLAN_JOURNEYS) as PlanJourney[]).map((j) => <option key={j} value={j}>{PLAN_JOURNEYS[j].label}</option>)}
                  </select>
                  <button className="btn btn-ghost btn-sm" type="submit">Filter</button>
                </form>
              </div>
              {plan.rows.length === 0 ? (
                <Empty>Nobody matches these filters. <TextLink href={`/w/${slug}/call-plan`}>Show everyone</TextLink></Empty>
              ) : (
                <>
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead><tr><th>Person</th><th>From</th><th>Status or service</th><th>What JENAI would do</th><th>When ({zoneLabel(tz)})</th><th>Why</th></tr></thead>
                      <tbody>
                        {plan.rows.map((r) => (
                          <tr key={r.id}>
                            <td>
                              <div className="font-semibold">{r.name ?? <span className="text-grey">No name</span>}</div>
                              <div className="font-mono text-[12px] text-grey">{r.phone || "No number"}</div>
                            </td>
                            <td className="whitespace-nowrap">{r.from}</td>
                            <td className="max-w-[22ch]"><StatusOrService r={r} tz={tz} /></td>
                            <td className="max-w-[30ch]">
                              <span className={`badge ${VERDICT_OF[r.verdict]?.badge ?? "badge-muted"}`}>{VERDICT_OF[r.verdict]?.label ?? r.verdict}</span>
                              <div className={`mt-1 ${r.verdict === "kept_out" ? "text-grey" : ""}`}>{PLAN_JOURNEYS[r.journey as PlanJourney]?.label ?? r.journey}</div>
                            </td>
                            <td className="whitespace-nowrap">{whenText(r, tz, now, plan.callingWindow)}</td>
                            <td className="max-w-[44ch] text-[13px] text-ink-soft">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={plan.page} total={plan.total} perPage={CALL_PLAN_PAGE} href={(p) => q({ page: String(p) })} labels={["Previous", "Next"]} />
                </>
              )}
            </Section>
          </>
        ) : !nothing ? (
          <Section title="Nobody in the plan yet">
            <Empty>
              The plan is worked out after JENAI reads your CRM or front desk system, or a visit list is uploaded. It shows here once there is someone to plan for.
              {plan.sources.length && !plan.enabled ? " They are read once the call plan is switched on." : ""}
            </Empty>
          </Section>
        ) : null}

        {canUpload ? (
          <Section title="Upload visit list" sub="The services people actually took, from your billing or front-desk software. Each visit becomes its feedback call, result check or next session in the plan.">
            <VisitUploadForm slug={slug} />
          </Section>
        ) : null}
      </div>
    </>
  );
}

/** How JENAI reads one CRM or front desk connection, in plain words. */
function SourceLine({ s, tz, plan }: { s: CallPlanSource; tz: string; plan: CallPlanView }) {
  const held = Object.entries(s.held).map(([module, n]) => `${n.toLocaleString("en-IN")} ${module}`);
  const last = s.lastPullAt ? ` Last read ${fmtDate(s.lastPullAt, true, tz)}.` : "";
  const state =
    s.status === "paused" ? "Paused, so JENAI does not read it."
    : s.status === "error" ? "Not working. Connect it again under Your systems."
    : s.status === "draft" ? "Not finished connecting."
    : !s.reading ? "Reading is switched off for this connection."
    : !plan.enabled ? `Not read on a timer: the call plan is switched off.${last}`
    : !plan.readingOnTimer ? `JENAI is not reading on a timer on this server yet, so it is read only when JENAI support reads it.${last}`
    : s.lastPullAt ? `Last read ${fmtDate(s.lastPullAt, true, tz)}${s.nextPullAt ? `, next ${fmtDate(s.nextPullAt, true, tz)}` : ""}.`
    : "Switched on: read for the first time within a few minutes.";
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{s.name}</span>
        <span className="text-[12px] text-grey">{KIND[s.kind] ?? s.kind}</span>
        <StatusBadge status={s.status} />
      </div>
      <div className="text-[13px] text-ink-soft">{state}{held.length ? ` ${held.join(", ")} on file.` : ""}</div>
      {s.lastSummary ? <div className="mt-0.5 text-[13px] text-ink-soft">{s.lastSummary}</div> : null}
      {s.lastPullError ? (
        <div className="mt-0.5 text-[13px] text-bad" title={s.lastPullError}>
          Last read had a problem: {s.lastPullError.length > 300 ? `${s.lastPullError.slice(0, 300)}...` : s.lastPullError}
        </div>
      ) : null}
      {s.lastPullNotes.length ? (
        <ul className="mt-0.5 list-disc pl-5 text-[13px] text-ink-soft">
          {s.lastPullNotes.slice(0, 5).map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

/** The call plan's own switch: reading the CRM and front desk system on a timer starts only when the workspace asks for it. */
function PlanSwitch({ plan, slug, canSwitch }: { plan: CallPlanView; slug: string; canSwitch: boolean }) {
  const what = plan.sources.some((s) => s.kind === "zenoti") ? (plan.sources.some((s) => s.kind !== "zenoti") ? "your CRM and Zenoti" : "your Zenoti") : "your CRM";
  const zohoCredits = plan.sources.some((s) => s.kind === "zoho_crm") ? " Switching it on uses a few hundred of your Zoho API credits a day." : "";
  if (!canSwitch) return plan.enabled ? null : <p className="mt-3 text-[13px] text-ink-soft">A workspace admin can switch the call plan on, so JENAI reads {what} on a timer.</p>;
  if (!plan.enabled && !plan.canEnable) return <p className="mt-3 text-[13px] text-ink-soft">The call plan knows clinic calls only for now, so it cannot be switched on for this workspace.</p>;
  return (
    <form action={switchCallPlan} className="mt-3 flex flex-wrap items-center gap-3">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="to" value={plan.enabled ? "off" : "on"} />
      <span className="text-[13px] text-ink-soft">
        {plan.enabled ? `The call plan is on: JENAI reads ${what} on a timer, only to plan.` : `The call plan is off: JENAI does not read ${what} on a timer.${zohoCredits}`}
      </span>
      <SubmitButton className={plan.enabled ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"} pendingText="Saving">
        {plan.enabled ? "Switch off" : "Switch on"}
      </SubmitButton>
    </form>
  );
}

function StatusOrService({ r, tz }: { r: CallPlanRow; tz: string }) {
  if (r.originType === "clinic_appointment") {
    return (
      <>
        <div>{r.service ?? <span className="text-grey">Service not given</span>}</div>
        <div className="text-[12px] text-grey">
          {r.status ? `${BOOKING_STATUS[r.status] ?? r.status}, ` : ""}
          {r.bookedFor ? `for ${fmtDate(r.bookedFor, true, tz)}` : ""}
        </div>
      </>
    );
  }
  if (r.originType === "visit") {
    return (
      <>
        <div>{r.service ?? <span className="text-grey">Service not given</span>}</div>
        {r.visitDate ? <div className="text-[12px] text-grey">Visit on {fmtDate(`${r.visitDate}T00:00:00Z`, false, "UTC")}</div> : null}
      </>
    );
  }
  // Zoho shows an empty pick list as "-None-".
  const status = r.status && r.status.trim() !== "-None-" ? r.status : null;
  return (
    <>
      <div>{status ?? <span className="text-grey">No status</span>}</div>
      {r.treatment ? <div className="text-[12px] text-grey">{r.treatment}</div> : null}
    </>
  );
}

/**
 * When a call goes. A call already due keeps the time it fell due, so "now"
 * is shown only inside calling hours; outside them, the next opening.
 */
function whenText(r: CallPlanRow, tz: string, now: Date, window: Windows): React.ReactNode {
  if (r.verdict === "kept_out") return <span className="text-grey">Not called</span>;
  if (r.verdict === "waiting") return <span className="text-grey">{r.callAt && r.callAt > now ? fmtDate(r.callAt, true, tz) : "After the first call"}</span>;
  if (r.callAt && r.callAt > now) return fmtDate(r.callAt, true, tz);
  if (inWindow(now, window, tz)) return <span className="font-semibold">Now</span>;
  return <span className="font-semibold">Next calling hours, {fmtDate(nextWindowStart(now, window, tz), true, tz)}</span>;
}

/** The organisation's time zone, or India's when it is not one the runtime knows. */
function zoneOf(tz: string | null | undefined): string {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: tz || "Asia/Kolkata" });
    return tz || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
}

/** "IST" for India; otherwise whatever short name the runtime gives the zone. */
function zoneLabel(tz: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? tz;
}
