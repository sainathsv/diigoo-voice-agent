import type { Metadata } from "next";
import Link from "next/link";
import { can, maskPhone, phoneFor } from "@jenai/authz";
import { FIELD_LABELS, complainantNumber, complaintLines, scamLabel } from "@jenai/engine";
import { Flash, PageHead, Section, StatusBadge, fmtDate, fmtDuration } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCase } from "@/server/queries/cases";
import { updateCase } from "@/server/actions/cases";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Case" };

const FOLLOWUP: Record<string, string> = {
  questions: "The complainant is asked the department's form on WhatsApp, one question at a time, and reminded every 6 hours (up to 6 times, 9 am to 9 pm) until it is complete.",
  form_link: "No money was lost, so the complainant was sent the cyber team's complaint form link on WhatsApp.",
  none: "The caller did not agree to WhatsApp. These are the details from the call; anything they write to the helpline later is added here.",
};

export default async function CasePage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug, id } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return deny(ctx, { malformedId: id.slice(0, 80) });
  const d = await loadCase(ctx.org.id, id);
  if (!d) return deny(ctx, { missing: id });
  const scope = { branchId: d.c.branchId };
  if (!can(ctx.access, "calls:view", scope)) return deny(ctx, { perm: "calls:view", id });
  const reveal = can(ctx.access, "contacts:reveal_phone", scope);
  const raw = can(ctx.access, "transcripts:view_raw", scope);
  const proof = can(ctx.access, "recordings:play", scope);
  const edit = can(ctx.access, "contacts:edit", scope);
  const followup = d.c.fields.followup ?? "questions";
  const lines = complaintLines(
    { id: d.c.id, startedAt: d.c.createdAt, durationS: null, phone: complainantNumber(d.c), extracted: d.merged, summary: d.callSummary },
    reveal ? {} : { mask: maskPhone },
  );

  return (
    <>
      <PageHead
        title={`Case ${d.no}`}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.c.status} />
            {d.c.fields.urgent === "yes" ? <span className="badge badge-bad">urgent: danger mentioned</span> : null}
            <span>{scamLabel(d.c.scamType)}</span>·<span>opened {fmtDate(d.c.createdAt)}</span>
            {d.c.readyAt ? <>·<span>handed to officers {fmtDate(d.c.readyAt)}</span></> : null}
          </span>
        }
        actions={
          <div className="flex gap-2">
            {raw ? <Link className="btn btn-dark" href={`/print/${slug}/cases/${d.c.id}`} target="_blank">Download case sheet</Link> : null}
            <Link className="btn btn-ghost" href={`/w/${slug}/cases`}>All cases</Link>
          </div>
        }
      />
      <Flash {...flash} />
      <div className={`card card-pad mb-6 ${d.c.missing.length && followup === "questions" ? "border-warn" : ""}`}>
        <div className="text-[13.5px]">{FOLLOWUP[followup] ?? ""}</div>
        {d.c.missing.length ? (
          <div className="mt-1.5 text-[13px]">
            <b>Still needed:</b> {d.c.missing.map((k) => FIELD_LABELS[k] ?? k).join(" · ")}
            {followup === "questions" ? <span className="text-grey"> · reminders sent: {d.c.remindersSent}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Section title="Complaint" sub="The department's form: the call's answers, with what the complainant wrote on WhatsApp on top.">
            {raw ? (
              <dl className="grid grid-cols-[minmax(0,210px)_1fr] gap-x-4 gap-y-2 px-5 py-4 text-[13.5px]">
                <dt className="text-grey">फ्रॉड का प्रकार / Type of scam</dt>
                <dd>{scamLabel(d.c.scamType)}</dd>
                {lines.map((l) => (
                  <div key={l.hi} className="contents">
                    <dt className="text-grey">{l.hi} / {l.en}</dt>
                    <dd className="whitespace-pre-wrap">{l.value || <span className="text-grey">Not given yet</span>}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="px-5 py-4 text-grey">Your role cannot see the complainant's full details.</p>
            )}
          </Section>

          <Section title={`Proof (${d.evidence.length})`} sub={proof ? "Sent by the complainant on WhatsApp. Each file shows its fingerprint (SHA-256) for the record; every open is logged." : "Your role cannot open proof files."}>
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              {d.evidence.length === 0 ? <p className="text-grey">No proof received yet.</p> : null}
              {d.evidence.map((e) => {
                const src = `/api/w/${slug}/cases/${d.c.id}/evidence/${e.id}`;
                return (
                  <div key={e.id} className="card overflow-hidden">
                    {proof && e.kind === "image" ? (
                      <a href={src} target="_blank" rel="noopener"><img src={src} alt={e.caption ?? "Proof"} className="max-h-[260px] w-full bg-ivory-2 object-contain" /></a>
                    ) : proof ? (
                      <a href={src} target="_blank" rel="noopener" className="block px-4 py-6 text-center font-semibold text-copper-deep hover:underline">Open {e.filename ?? e.kind}</a>
                    ) : (
                      <div className="px-4 py-6 text-center text-grey">{e.kind}</div>
                    )}
                    <div className="border-t border-line px-3 py-2 text-[12px] text-grey">
                      {e.caption ? <div className="text-ink">{e.caption}</div> : null}
                      {fmtDate(e.receivedAt)} · {Math.max(1, Math.round(e.sizeBytes / 1024))} KB
                      <div className="truncate font-mono" title={e.sha256 ?? ""}>{e.sha256?.slice(0, 16)}…</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="WhatsApp conversation">
            <div className="grid max-h-[560px] gap-2 overflow-auto px-5 py-4">
              {d.messages.length === 0 ? <p className="text-grey">No messages yet.</p> : null}
              {d.messages.map((m) => (
                <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-[13.5px] ${m.direction === "out" ? "justify-self-end bg-copper-wash" : "justify-self-start bg-ivory-2"}`}>
                  <div className="whitespace-pre-wrap">{raw ? (m.body ?? (m.evidenceId ? "[proof file]" : "")) : m.direction === "out" ? "Helpline message" : "Complainant message"}</div>
                  <div className="mt-1 text-[11px] text-grey">
                    {m.direction === "out" ? "Helpline" : "Complainant"} · {fmtDate(m.at)} · {m.status}
                    {m.error ? <span className="text-bad"> · {m.error}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <div className="grid content-start gap-6">
          <Section title="Officer">
            {edit ? (
              <form action={updateCase} className="grid gap-3 px-5 py-4">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="id" value={d.c.id} />
                <div>
                  <label className="label" htmlFor="c-status">Status</label>
                  <select id="c-status" name="status" defaultValue={d.c.status} className="input">
                    <option value="collecting">Waiting on complainant</option>
                    <option value="ready">Ready for officers</option>
                    <option value="taken_up">Taken up by an officer</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="c-assign">Assigned officer</label>
                  <select id="c-assign" name="assignee" defaultValue="" className="input">
                    <option value="">Unchanged</option>
                    <option value="none">Nobody</option>
                    {d.team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="c-note">Officer note</label>
                  <textarea id="c-note" name="note" defaultValue={d.c.officerNote ?? ""} rows={4} className="input h-auto py-2" />
                </div>
                <div><button className="btn btn-dark" type="submit">Save</button></div>
              </form>
            ) : (
              <p className="px-5 py-4 text-grey">View only. {d.c.officerNote ?? ""}</p>
            )}
          </Section>

          <Section title="Calls from this number">
            <div className="grid gap-3 px-5 py-4 text-[13.5px]">
              {d.relatedCalls.length === 0 ? <p className="text-grey">No calls found.</p> : null}
              {d.relatedCalls.map((c) => (
                <div key={c.id}>
                  <Link href={`/w/${slug}/calls/${c.id}`} className="font-semibold text-copper-deep hover:underline">{fmtDate(c.startedAt)}</Link>
                  <span className="text-grey"> · {fmtDuration(c.durationS)}</span>
                  {c.summary ? <div className="text-[13px] text-ink-soft">{c.summary}</div> : null}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
