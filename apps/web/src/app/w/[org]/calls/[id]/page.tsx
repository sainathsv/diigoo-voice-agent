import type { Metadata } from "next";
import Link from "next/link";
import { can, maskPhone, phoneFor } from "@jenai/authz";
import { Flash, PageHead, Section, StatusBadge, fmtDate, fmtDuration } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCall } from "@/server/queries/modules";
import { setDoNotCall } from "@/server/actions/modules";
import { deny } from "@/server/security-log";
import { isCaseWorkspace } from "@/server/queries/helpline";
import { complaintHeader, complaintLines } from "@jenai/engine";

export const metadata: Metadata = { title: "Call" };

const LABELS: Record<string, string> = {
  caller_name: "Name",
  concern: "Asked about",
  preferred_time: "Preferred time",
  interest_level: "Interest",
  next_step: "Next step",
  call_disposition: "Disposition",
};

export default async function CallPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug, id } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return deny(ctx, { malformedId: id.slice(0, 80) });
  const d = await loadCall(ctx.org.id, id);
  if (!d) return deny(ctx, { missing: id });
  const scope = { branchId: d.c.branchId };
  if (!can(ctx.access, "calls:view", scope)) return deny(ctx, { perm: "calls:view", id });
  const reveal = can(ctx.access, "contacts:reveal_phone", scope);
  const play = can(ctx.access, "recordings:play", scope) && (d.recordingHeld || !!d.c.recordingRef);
  const raw = can(ctx.access, "transcripts:view_raw", scope);
  const blocked = d.blocked.some((b) => b.tenantId === ctx.org.id && b.reason === "opt_out");
  const extracted = Object.entries(d.c.extracted).filter(([, v]) => typeof v !== "object");
  // A cyber crime helpline reads each call as a complaint in the department's own format.
  const complaintCall = { id: d.c.id, startedAt: d.c.startedAt, durationS: d.c.durationS, phone: d.contact?.phoneE164 ?? d.c.fromE164, extracted: d.c.extracted, summary: d.c.summary };
  const complaint = (await isCaseWorkspace(ctx.org.id))
    ? { head: complaintHeader(complaintCall), lines: complaintLines(complaintCall, reveal ? {} : { mask: maskPhone }) }
    : null;
  // On a complaint the form above already carries the answers; show only what is not on it.
  const OTHER_COMPLAINT_KEYS = new Set(["already_reported", "reference_given", "call_language", "fields_missing", "call_disposition"]);
  const otherDetails = complaint ? extracted.filter(([k]) => OTHER_COMPLAINT_KEYS.has(k)) : extracted;

  return (
    <>
      <PageHead
        title={d.contact?.name ?? (d.c.extracted.caller_name as string) ?? "Call"}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.c.status} />
            <span className="capitalize">{d.c.direction}</span>·<span>{fmtDate(d.c.startedAt)}</span>·<span>{fmtDuration(d.c.durationS)}</span>
            {d.agentName ? <>·<span>{d.agentName}</span></> : null}
            {d.branchName ? <>·<span>{d.branchName}</span></> : null}
          </span>
        }
        actions={
          <div className="flex gap-2">
            {complaint && raw ? <Link className="btn btn-dark" href={`/print/${slug}/calls/${d.c.id}`} target="_blank">Download case sheet</Link> : null}
            <Link className="btn btn-ghost" href={`/w/${slug}/calls`}>All calls</Link>
          </div>
        }
      />
      <Flash {...flash} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          {play ? (
            <Section title="Recording" sub="Every play is recorded in the activity log.">
              <div className="px-5 py-4">
                <audio controls preload="none" className="w-full" src={`/api/w/${slug}/calls/${d.c.id}/recording`}>
                  Your browser cannot play this recording.
                </audio>
              </div>
            </Section>
          ) : null}
          <Section title="Transcript" sub={raw ? undefined : "Your role sees the summary only. Full transcripts need the QA or Admin role."}>
            <div className="px-5 py-4">
              {raw ? (
                d.c.transcript ? <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">{d.c.transcript}</pre> : <p className="text-grey">No transcript for this call.</p>
              ) : (
                <p>{d.c.summary ?? "No summary."}</p>
              )}
            </div>
          </Section>
        </div>
        <div className="grid content-start gap-6">
          <Section title="Caller">
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 px-5 py-4 text-[13.5px]">
              <dt className="text-grey">Number</dt>
              <dd className="font-mono">{phoneFor(reveal, d.contact?.phoneE164)}</dd>
              <dt className="text-grey">First seen</dt>
              <dd>{fmtDate(d.contact?.firstSeenAt)}</dd>
              {d.lead && !complaint ? (
                <>
                  <dt className="text-grey">Lead</dt>
                  <dd><StatusBadge status={d.lead.stage} /> <Link className="ml-1 text-[12.5px] font-semibold text-copper-deep" href={`/w/${slug}/leads`}>Open leads</Link></dd>
                </>
              ) : null}
            </dl>
            {d.contact && can(ctx.access, "contacts:edit", scope) ? (
              <form action={setDoNotCall} className="border-t border-line px-5 py-3">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="phone" value={d.contact.phoneE164} />
                <input type="hidden" name="back" value={`calls/${d.c.id}`} />
                <input type="hidden" name="on" value={blocked ? "0" : "1"} />
                {blocked ? <span className="badge badge-bad mr-2">Do not call</span> : null}
                <button className="btn btn-ghost btn-sm" type="submit">{blocked ? "Allow calls again" : "Mark do-not-call"}</button>
              </form>
            ) : null}
          </Section>
          {complaint ? (
            <Section title="Complaint" sub={complaint.head.scam ? `Type of scam: ${complaint.head.scam}${complaint.head.when ? ` · happened ${complaint.head.when}` : ""}` : "Filled in from the call. Blank lines were not given on the call."}>
              {complaint.head.urgent ? <div className="mx-5 mt-4 rounded-lg bg-bad-wash px-3 py-2 text-[13px] font-semibold text-bad">Urgent: the caller mentioned danger (self-harm, blackmail or threats).</div> : null}
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-x-4 gap-y-2.5 px-5 py-4 text-[13.5px]">
                {/* Bank account, date of birth and address are as sensitive as the transcript itself. */}
                {(raw ? complaint.lines : []).map((l) => (
                  <div key={l.hi} className="contents">
                    <dt className="text-grey">{l.hi}<div className="text-[11.5px]">{l.en}</div></dt>
                    <dd className="whitespace-pre-wrap">{l.value || <span className="text-grey">Not given</span>}</dd>
                  </div>
                ))}
                {raw ? (
                  <>
                    <dt className="text-grey">ट्रांजेक्शन स्क्रीनशॉट<div className="text-[11.5px]">Transaction screenshot</div></dt>
                    <dd className="text-grey">Cannot be received on a call; collect from the complainant.</dd>
                  </>
                ) : (
                  <p className="col-span-2 text-grey">Your role sees the type of scam and the summary only. The complainant&apos;s personal and bank details need the QA or Admin role.</p>
                )}
              </dl>
            </Section>
          ) : null}
          <Section title={complaint ? "Other details from the call" : "What the AI captured"}>
            {otherDetails.length === 0 ? (
              <p className="px-5 py-4 text-grey">Nothing captured on this call.</p>
            ) : (
              <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 px-5 py-4 text-[13.5px]">
                {otherDetails.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-grey">{LABELS[k] ?? k.replace(/_/g, " ")}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
