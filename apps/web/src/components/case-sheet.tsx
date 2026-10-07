import { maskPhone } from "@jenai/authz";
import { FIELD_LABELS, complaintHeader, complaintLines } from "@jenai/engine";
import { fmtDate, fmtDuration } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import type { LoadedComplaint } from "@/server/queries/complaint";

const FOOTER = "All software and compliance are taken care of by DIIGOO Tech Private Limited, Hyderabad, Telangana.";
const MAX_IMAGES = 6;
const clip = (v: string, n = 500) => (v.length > n ? `${v.slice(0, n)}… (full text in the portal)` : v);
const FOLLOWUP: Record<string, string> = {
  questions: "Details and proof collected on WhatsApp",
  form_link: "Complaint form link sent on WhatsApp",
  portal: "Referred to cybercrime.gov.in: money lost more than 15 days ago",
  none: "Caller did not agree to WhatsApp; details from the call",
};

function Footer() {
  return <p className="mt-4 border-t border-line pt-1.5 text-center text-[9.5px] text-grey">{FOOTER}</p>;
}

/**
 * A complaint's case sheet in the department's format, at most two A4 pages:
 * the form (from the call and WhatsApp together) on the first, the proof on the
 * second. "Print / Save as PDF" gives officers the file for the case record.
 */
export function CaseSheet(props: { orgName: string; slug: string; reference: string; d: LoadedComplaint; reveal: boolean; showProof: boolean; caseNo: string | null; printedBy: string }) {
  const { d } = props;
  const sheet = { id: d.call?.id ?? d.kase!.id, startedAt: d.call?.startedAt ?? d.kase!.createdAt, durationS: d.call?.durationS ?? null, phone: d.phone, extracted: d.merged, summary: d.call?.summary ?? null };
  const head = complaintHeader(sheet);
  const lines = complaintLines(sheet, props.reveal ? {} : { mask: maskPhone });
  const images = d.evidence.filter((e) => e.kind === "image");
  const files = d.evidence.filter((e) => e.kind !== "image");
  const url = (eid: string) => `/api/w/${props.slug}/cases/${d.kase!.id}/evidence/${eid}`;
  const followup = d.kase?.fields.followup;

  return (
    <main className="mx-auto max-w-[820px] bg-white px-8 py-8 text-ink print:max-w-none print:p-0">
      <style>{"@page { size: A4; margin: 11mm 12mm 12mm; } @media print { .sheet-page + .sheet-page { break-before: page; } }"}</style>
      <section className="sheet-page">
        <div className="mb-4 flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-grey">{props.orgName} · Cyber crime helpline</div>
            <h1 className="h-display mt-1 text-[24px]">शिकायत विवरण / Complaint case sheet</h1>
            <div className="mt-1 text-[12.5px] text-ink-soft">
              Reference <b className="font-mono">{props.reference}</b>
              {props.caseNo ? <> · Case <b className="font-mono">{props.caseNo}</b></> : null}
              {d.call ? <> · Call {fmtDate(d.call.startedAt)} ({fmtDuration(d.call.durationS)})</> : <> · Started on WhatsApp {fmtDate(d.kase!.createdAt)}</>}
            </div>
          </div>
          <PrintButton />
        </div>

        <table className="mb-3 w-full border-collapse text-[12px] leading-snug">
          <tbody>
            <tr>
              <th className="w-[34%] border border-line bg-ivory px-2 py-1 text-left align-top font-semibold">फ्रॉड का प्रकार<div className="text-[10.5px] font-normal text-grey">Type of scam</div></th>
              <td className="border border-line px-2 py-1">{head.scam || "Not given"}</td>
            </tr>
            <tr>
              <th className="border border-line bg-ivory px-2 py-1 text-left align-top font-semibold">घटना कब हुई<div className="text-[10.5px] font-normal text-grey">When it happened</div></th>
              <td className="border border-line px-2 py-1">{head.when || "Not given"}</td>
            </tr>
            {lines.map((l) => (
              <tr key={l.hi} className="break-inside-avoid">
                <th className="border border-line bg-ivory px-2 py-1 text-left align-top font-semibold">{l.hi}<div className="text-[10.5px] font-normal text-grey">{l.en}</div></th>
                <td className="whitespace-pre-wrap border border-line px-2 py-1">{l.value ? clip(l.value) : "Not given"}</td>
              </tr>
            ))}
            <tr>
              <th className="border border-line bg-ivory px-2 py-1 text-left align-top font-semibold">सबूत<div className="text-[10.5px] font-normal text-grey">Proof</div></th>
              <td className="border border-line px-2 py-1">{d.evidence.length ? `${d.evidence.length} file(s) sent on WhatsApp${props.showProof ? ", on the next page" : ""}` : "None received yet"}</td>
            </tr>
          </tbody>
        </table>

        {head.urgent ? <p className="mb-3 rounded border border-bad px-3 py-1.5 text-[12px] font-semibold text-bad">Urgent: danger was mentioned (self-harm, blackmail or threats).</p> : null}
        {d.kase ? (
          <p className="mb-2 text-[11.5px] text-ink-soft">
            WhatsApp: {FOLLOWUP[followup ?? "questions"] ?? "WhatsApp"}
            {d.kase.missing.length ? ` · still needed: ${d.kase.missing.map((k) => FIELD_LABELS[k] ?? k).join(", ")}` : " · complete"}
          </p>
        ) : null}
        {sheet.summary ? <p className="mb-2 text-[12px]"><b>कॉल का सारांश / Call summary:</b> {clip(sheet.summary, 600)}</p> : null}
        {head.alreadyReported || head.reference ? (
          <p className="mb-2 text-[11.5px]">Already reported on 1930 / portal: <b>{head.alreadyReported || "not said"}</b>{head.reference ? ` · reference ${head.reference}` : ""}</p>
        ) : null}

        <div className="mt-6 grid grid-cols-2 gap-10 text-[11.5px] text-grey">
          <div className="border-t border-ink pt-1.5">Received by (officer, name and signature)</div>
          <div className="border-t border-ink pt-1.5">Date</div>
        </div>
        <p className="mt-3 text-[10px] text-grey">
          Taken on a recorded call{d.kase && followup !== "none" ? " and on WhatsApp" : ""}; verify with the complainant before acting. Printed {fmtDate(new Date())} by {props.printedBy}.
        </p>
        <Footer />
      </section>

      {props.showProof && d.evidence.length ? (
        <section className="sheet-page mt-10 print:mt-0">
          <h2 className="mb-2 border-b border-ink pb-1 text-[15px] font-bold">सबूत / Proof sent on WhatsApp ({d.evidence.length})</h2>
          {images.length ? (
            <div className="grid grid-cols-2 gap-2.5">
              {images.slice(0, MAX_IMAGES).map((e) => (
                <figure key={e.id} className="break-inside-avoid border border-line p-1">
                  <img src={url(e.id)} alt={e.caption ?? "Proof"} className="h-[68mm] w-full bg-ivory object-contain" />
                  <figcaption className="mt-1 text-[9.5px] leading-tight text-grey">
                    {e.caption ? <span className="text-ink">{clip(e.caption, 80)} · </span> : null}
                    {fmtDate(e.receivedAt)} · SHA-256 <span className="font-mono">{e.sha256?.slice(0, 16)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
          {images.length > MAX_IMAGES ? <p className="mt-2 text-[11px] text-grey">{images.length - MAX_IMAGES} more image(s) are in the portal.</p> : null}
          {files.length ? (
            <table className="mt-3 w-full border-collapse text-[11px]">
              <tbody>
                {files.slice(0, 8).map((e) => (
                  <tr key={e.id}>
                    <td className="border border-line px-2 py-1">{e.filename ?? e.kind}</td>
                    <td className="border border-line px-2 py-1">{e.mime}</td>
                    <td className="border border-line px-2 py-1">{Math.max(1, Math.round(e.sizeBytes / 1024))} KB</td>
                    <td className="border border-line px-2 py-1 font-mono">{e.sha256?.slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {files.length > 8 ? <p className="mt-1 text-[11px] text-grey">{files.length - 8} more file(s) are in the portal.</p> : null}
          <Footer />
        </section>
      ) : null}
    </main>
  );
}
