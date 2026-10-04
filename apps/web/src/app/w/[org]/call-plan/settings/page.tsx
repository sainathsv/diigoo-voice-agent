import type { Metadata } from "next";
import { can } from "@jenai/authz";
import { ZOHO_PULL_ITEMS, planSettingsPage, type StatusList } from "@jenai/engine";
import { Empty, Flash, PageHead, Section, TextLink } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import {
  deleteTreatmentRule,
  eraseFromPlan,
  moveStatus,
  saveFieldLabels,
  savePlanSettings,
  saveTreatmentRule,
  setSourceKind,
} from "@/server/actions/call-plan";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Call plan settings" };

/** What each status list means for the calls, in the clinic's words. */
const LIST_TEXT: Record<StatusList, string> = {
  openStatuses: "An enquiry: call to book",
  bookedStatuses: "Booked: remind them",
  noShowStatuses: "Missed their appointment: call to rebook",
  customerStatuses: "A patient: care calls after each visit",
  neverStatuses: "No call about this record",
  declinedStatuses: "Said no: stop calls to book them",
  doNotCallStatuses: "Do not call this person at all",
};
const LIST_ORDER: StatusList[] = ["openStatuses", "bookedStatuses", "noShowStatuses", "customerStatuses", "neverStatuses", "declinedStatuses", "doNotCallStatuses"];

/** What the plan reads from their CRM, in plain words. */
const ITEM_TEXT: Record<string, string> = {
  phone: "Phone number",
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  status: "Lead status",
  source: "Lead source",
  notes: "Notes (only a callback date and a do-not-call are read from them)",
  appointment: "Appointment date and time",
  followUp: "Follow-up date",
  treatment: "Treatment",
  subTreatment: "Sub treatment",
  category: "Category",
  consultant: "Doctor or consultant",
  centre: "Centre or branch",
};

const NUMBERS: Array<{ key: string; label: string; help: string }> = [
  { key: "freshDays", label: "Enquiries stay warm for (days)", help: "Older, a call is a cold call, which needs a promotional number and consent." },
  { key: "minGapDays", label: "Days between calls to one person", help: "Appointment reminders are not held back by this." },
  { key: "reminderHour", label: "Reminder hour, the evening before (0 to 23)", help: "Kept inside your calling hours." },
  { key: "consultationWithinDays", label: "Check in after a consultation within (days)", help: "" },
  { key: "checkInAfterDays", label: "Check-in this many days after a consultation", help: "" },
  { key: "feedbackWithinDays", label: "Ask for feedback while the visit is this recent (days)", help: "" },
  { key: "resultCheckWithinDays", label: "Result check up to this many days past due", help: "" },
  { key: "recallWithinDays", label: "Next session or maintenance up to this many days past due", help: "Later, a call is a win-back offer, which needs a promotional number and consent." },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function CallPlanSettingsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  const manage = can(ctx.access, "org:manage") && ctx.org.status !== "suspended";
  const fields = can(ctx.access, "integrations:manage") && ctx.org.status !== "suspended";
  if (!can(ctx.access, "org:manage") && !can(ctx.access, "integrations:manage")) return deny(ctx, { perm: "org:manage" });
  const p = await planSettingsPage(ctx.org.id);
  const s = p.settings;
  const hidden = <input type="hidden" name="slug" value={slug} />;

  return (
    <>
      <PageHead title="Call plan settings" sub="How JENAI reads your records to plan calls. Every change is worked into the plan at once. Nobody is called from here." actions={<TextLink href={`/w/${slug}/call-plan`}>Back to the call plan</TextLink>} />
      <Flash {...flash} />
      <div className="grid gap-6">
        <Section title="Statuses in your CRM" sub="Each status your CRM uses, and the call it leads to. A status in no list prompts no call, and the plan says so.">
          {p.statuses.length === 0 ? (
            <Empty>No CRM records read yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Status</th><th className="num">Records</th><th>Means</th></tr></thead>
                <tbody>
                  {p.statuses.map((st) => (
                    <tr key={st.status}>
                      <td className="font-semibold">{st.status}{st.list ? null : <div className="text-[12px] text-bad">Not in any list: no call</div>}</td>
                      <td className="num">{st.records.toLocaleString("en-IN")}</td>
                      <td>
                        {manage ? (
                          <form action={moveStatus} className="flex flex-wrap gap-2">
                            {hidden}
                            <input type="hidden" name="status" value={st.status} />
                            <select className="input h-[30px] w-auto py-0 text-[12.5px]" name="list" defaultValue={st.list ?? ""} aria-label={`What "${st.status}" means`}>
                              <option value="">Not in any list: no call</option>
                              {LIST_ORDER.map((l) => <option key={l} value={l}>{LIST_TEXT[l]}</option>)}
                            </select>
                            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Saving">Save</SubmitButton>
                          </form>
                        ) : st.list ? LIST_TEXT[st.list] : "Not in any list"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Lead sources" sub="An enquiry call is a service call only when the person asked you first. Leads your team found or bought (cold calls, purchased or imported lists) need a promotional number and consent, so the plan keeps them out.">
          {p.sources.length === 0 ? (
            <Empty>No lead sources read yet.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Lead source</th><th className="num">Records</th><th>Counts as</th></tr></thead>
                <tbody>
                  {p.sources.map((src) => (
                    <tr key={src.source}>
                      <td className="font-semibold">{src.source}</td>
                      <td className="num">{src.records.toLocaleString("en-IN")}</td>
                      <td>
                        {manage ? (
                          <form action={setSourceKind} className="flex flex-wrap gap-2">
                            {hidden}
                            <input type="hidden" name="source" value={src.source} />
                            <select className="input h-[30px] w-auto py-0 text-[12.5px]" name="kind" defaultValue={src.enquiry ? "enquiry" : "outbound"} aria-label={`What "${src.source}" counts as`}>
                              <option value="enquiry">An enquiry they made</option>
                              <option value="outbound">Your own outreach: no enquiry call</option>
                            </select>
                            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Saving">Save</SubmitButton>
                          </form>
                        ) : src.enquiry ? "An enquiry they made" : "Your own outreach"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Timing and calling hours" sub="Blank puts a number back to JENAI's default.">
          <form action={savePlanSettings} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            {hidden}
            {NUMBERS.map((n) => (
              <div key={n.key}>
                <label className="label" htmlFor={`n-${n.key}`}>{n.label}</label>
                <input className="input" id={`n-${n.key}`} name={n.key} type="number" step={1} defaultValue={n.key in p.own ? String(s[n.key as keyof typeof s]) : ""} placeholder={String(s[n.key as keyof typeof s])} disabled={!manage} />
                {n.help ? <p className="help">{n.help}</p> : null}
              </div>
            ))}
            <fieldset className="sm:col-span-2">
              <legend className="label">Calling days and hours (kept within 09:00 to 21:00)</legend>
              <div className="flex flex-wrap items-center gap-3">
                {DAYS.map((d, i) => (
                  <label key={d} className="flex items-center gap-1 text-[13px]">
                    <input type="checkbox" name={`day${i}`} defaultChecked={s.callingWindow.days.includes(i)} disabled={!manage} /> {d}
                  </label>
                ))}
                <input className="input h-9 w-auto" name="windowStart" type="time" defaultValue={s.callingWindow.start} aria-label="From" disabled={!manage} />
                <input className="input h-9 w-auto" name="windowEnd" type="time" defaultValue={s.callingWindow.end} aria-label="To" disabled={!manage} />
              </div>
            </fieldset>
            <div>
              <label className="label" htmlFor="n-centres">Centres this plan covers</label>
              <textarea className="input" id="n-centres" name="centres" rows={2} defaultValue={s.centres.join(", ")} placeholder="Empty: every centre" disabled={!manage} />
              <p className="help">Comma separated. A centre matches when one name holds the other, so Kondapur covers Zennara Clinics Kondapur.{p.centres.length ? ` Your CRM names: ${p.centres.slice(0, 12).map((c) => c.centre).join(", ")}.` : ""}</p>
            </div>
            <div>
              <label className="label" htmlFor="n-modules">CRM lists that are only people, not enquiries</label>
              <textarea className="input" id="n-modules" name="contactOnlyModules" rows={2} defaultValue={s.contactOnlyModules.join(", ")} disabled={!manage} />
              <p className="help">A record there with no status prompts no call by itself.{p.modules.length ? ` Read so far: ${p.modules.map((m) => `${m.module} (${m.records.toLocaleString("en-IN")})`).join(", ")}.` : ""}</p>
            </div>
            {manage ? <div className="sm:col-span-2"><SubmitButton pendingText="Saving">Save timing and hours</SubmitButton></div> : null}
          </form>
        </Section>

        <Section title="Treatment timings" sub="When each treatment's calls fall due. JENAI's defaults are a starting point for your doctors to confirm or change, never medical advice.">
          <div className="grid gap-4 px-5 py-4">
            {p.rules.own.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Your timing for</th><th className="num">Feedback</th><th className="num">Result check</th><th className="num">Between sessions</th><th className="num">Sessions</th><th className="num">Maintenance</th><th /></tr></thead>
                  <tbody>
                    {p.rules.own.map((r) => (
                      <tr key={r.id}>
                        <td><div className="font-semibold">{r.label}</div><div className="text-[12px] text-grey">Service names containing "{r.match}"</div></td>
                        <td className="num">{r.feedbackAfterDays ?? "2"}</td>
                        <td className="num">{r.resultCheckAfterDays ?? "-"}</td>
                        <td className="num">{r.sessionIntervalDays ?? "-"}</td>
                        <td className="num">{r.courseSessions ?? "-"}</td>
                        <td className="num">{r.maintenanceAfterDays ?? "-"}</td>
                        <td>
                          {manage ? (
                            <form action={deleteTreatmentRule}>
                              {hidden}
                              <input type="hidden" name="id" value={r.id} />
                              <ConfirmButton className="btn btn-ghost btn-sm" message={`Remove your timing for "${r.match}"? JENAI's default applies again.`}>Remove</ConfirmButton>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[13px] text-ink-soft">No timings of your own yet: every treatment uses JENAI's default below.</p>
            )}
            {manage ? (
              <form action={saveTreatmentRule} className="grid gap-3 sm:grid-cols-4">
                {hidden}
                <div className="sm:col-span-2"><label className="label" htmlFor="t-match">Service name contains</label><input className="input" id="t-match" name="match" required maxLength={60} placeholder="hydrafacial" /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor="t-label">Shown as</label><input className="input" id="t-label" name="label" maxLength={80} placeholder="Hydrafacial" /></div>
                <div><label className="label" htmlFor="t-fb">Feedback after (days)</label><input className="input" id="t-fb" name="feedbackAfterDays" type="number" min={0} placeholder="2" /></div>
                <div><label className="label" htmlFor="t-rc">Result check after (days)</label><input className="input" id="t-rc" name="resultCheckAfterDays" type="number" min={0} /></div>
                <div><label className="label" htmlFor="t-si">Days between sessions</label><input className="input" id="t-si" name="sessionIntervalDays" type="number" min={1} /></div>
                <div><label className="label" htmlFor="t-cs">Sessions in a course</label><input className="input" id="t-cs" name="courseSessions" type="number" min={1} /></div>
                <div><label className="label" htmlFor="t-mt">Maintenance after (days)</label><input className="input" id="t-mt" name="maintenanceAfterDays" type="number" min={1} /></div>
                <div className="sm:col-span-4"><SubmitButton pendingText="Saving">Save timing</SubmitButton><p className="help">Saving a timing for words you already have replaces it.</p></div>
              </form>
            ) : null}
            <details>
              <summary className="cursor-pointer text-[13px] font-semibold">JENAI's defaults</summary>
              <div className="tbl-wrap mt-2">
                <table className="tbl">
                  <thead><tr><th>Treatment</th><th className="num">Result check</th><th className="num">Between sessions</th><th className="num">Sessions</th><th className="num">Maintenance</th></tr></thead>
                  <tbody>
                    {p.rules.defaults.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}{r.match.length ? <div className="text-[12px] text-grey">{r.match.join(", ")}</div> : null}</td>
                        <td className="num">{r.resultCheckAfterDays ?? "-"}</td>
                        <td className="num">{r.sessionIntervalDays ?? "-"}</td>
                        <td className="num">{r.courseSessions ?? "-"}</td>
                        <td className="num">{r.maintenanceAfterDays ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </Section>

        {p.connections.map((c) => (
          <Section key={c.id} title={`Fields read from ${c.name}`} sub="The labels your CRM gives the fields JENAI reads, tried in order. Changing one reads every record again on the next read.">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>What the plan reads</th><th>From your fields</th></tr></thead>
                <tbody>
                  {ZOHO_PULL_ITEMS.map((item) => (
                    <tr key={item}>
                      <td className="max-w-[28ch]">{ITEM_TEXT[item] ?? item}{c.ownLabels.includes(item) ? <div className="text-[12px] text-grey">Set by you</div> : null}</td>
                      <td>
                        {fields ? (
                          <form action={saveFieldLabels} className="flex flex-wrap gap-2">
                            {hidden}
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="item" value={item} />
                            <input className="input h-[30px] min-w-[260px] flex-1 py-0 text-[12.5px]" name="labels" defaultValue={(c.labels[item] ?? []).join(", ")} aria-label={`Fields for ${ITEM_TEXT[item] ?? item}`} />
                            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Saving">Save</SubmitButton>
                          </form>
                        ) : (c.labels[item] ?? []).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fields ? <p className="help px-5 pb-4">Save an empty box to put back JENAI's usual labels.</p> : null}
          </Section>
        ))}

        {manage ? (
          <Section title="Erase a person from the plan" sub="For someone who asked you to erase their data: their visits, the CRM records JENAI read for them and their planned calls go. Delete them in your CRM too, or the next read brings those records back.">
            <form action={eraseFromPlan} className="flex flex-wrap items-end gap-3 px-5 py-4">
              {hidden}
              <div><label className="label" htmlFor="e-phone">Their phone number</label><input className="input" id="e-phone" name="phone" inputMode="tel" autoComplete="off" required /></div>
              <ConfirmButton message="Erase this number from the call plan? This cannot be undone.">Erase</ConfirmButton>
            </form>
          </Section>
        ) : null}
      </div>
    </>
  );
}
