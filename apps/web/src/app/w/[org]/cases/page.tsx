import type { Metadata } from "next";
import Link from "next/link";
import { can, holdsAnywhere, phoneFor } from "@jenai/authz";
import { FIELD_LABELS, SCAM_TYPES, complainantNumber, scamLabel } from "@jenai/engine";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCases } from "@/server/queries/cases";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Cases" };

const TABS = [
  ["", "All"],
  ["ready", "Ready for officers"],
  ["collecting", "Waiting on complainant"],
  ["taken_up", "Taken up"],
  ["closed", "Closed"],
] as const;

const FOLLOWUP: Record<string, string> = { questions: "Form on WhatsApp", form_link: "Form link sent", portal: "Referred to cybercrime.gov.in (over 15 days)", none: "No WhatsApp (caller said no)" };

export default async function CasesPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ status?: string; type?: string; q?: string; ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "calls:view")) return deny(ctx, { perm: "calls:view" });
  const { rows, counts } = await loadCases(ctx.org.id, ctx.access, sp);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const qs = (s: string) => new URLSearchParams({ ...(s ? { status: s } : {}), ...(sp.type ? { type: sp.type } : {}), ...(sp.q ? { q: sp.q } : {}) }).toString();

  return (
    <>
      <PageHead
        title="Cases"
        sub="Each complaint from the call through WhatsApp. For a money fraud the complainant is asked the department's form on WhatsApp, one question at a time, and reminded until it is complete; other complaints get the form link."
        actions={holdsAnywhere(ctx.access, "integrations:manage") ? <Link className="btn btn-ghost btn-sm" href={`/w/${slug}/whatsapp`}>WhatsApp number</Link> : undefined}
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/w/${slug}/cases?${qs(k)}`} className={`btn btn-sm ${(sp.status ?? "") === k ? "btn-dark" : "btn-ghost"}`}>
            {l} ({k ? counts[k] ?? 0 : total})
          </Link>
        ))}
        <form className="ml-auto flex gap-1.5" action={`/w/${slug}/cases`}>
          {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
          <select name="type" defaultValue={sp.type ?? ""} className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Type of scam">
            <option value="">Every type</option>
            {SCAM_TYPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Name, number, district, fraudster" className="input h-[30px] w-[220px] text-[12.5px]" aria-label="Search cases" />
          <button className="btn btn-ghost btn-sm" type="submit">Search</button>
        </form>
      </div>

      <Section title={`${rows.length} case${rows.length === 1 ? "" : "s"}`}>
        {rows.length === 0 ? (
          <Empty>No cases here yet. A case opens after each complaint call, or when someone writes to the helpline on WhatsApp.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Case</th><th>Complainant</th><th>Scam</th><th>Who did it</th><th>WhatsApp</th><th>Still needed</th><th>Updated</th></tr></thead>
              <tbody>
                {rows.map(({ c, no, proofs }) => {
                  const fraudster = [c.fields.fraudster_mobile, c.fields.fraudster_whatsapp, c.fields.suspect_account_or_upi, c.fields.suspect_social_media, c.fields.suspect_email].filter(Boolean).join("; ");
                  return (
                    <tr key={c.id}>
                      <td className="whitespace-nowrap">
                        <Link href={`/w/${slug}/cases/${c.id}`} className="font-mono font-semibold text-copper-deep hover:underline">{no}</Link>
                        <div className="mt-1 flex gap-1"><StatusBadge status={c.status} />{c.fields.urgent === "yes" ? <span className="badge badge-bad">urgent</span> : null}</div>
                      </td>
                      <td>
                        <div className="font-semibold">{c.fields.complainant_name ?? <span className="text-grey">Not given yet</span>}</div>
                        <div className="font-mono text-[12px] text-grey">{complainantNumber(c) ? phoneFor(can(ctx.access, "contacts:reveal_phone", { branchId: c.branchId }), complainantNumber(c)) : "Number hidden by WhatsApp"}</div>
                      </td>
                      <td className="max-w-[20ch]">
                        {scamLabel(c.scamType)}
                        {c.amountLostPaise ? <div className="text-[12px] text-grey">₹{Math.round(c.amountLostPaise / 100).toLocaleString("en-IN")} lost</div> : null}
                      </td>
                      <td className="max-w-[24ch] truncate text-[13px]">{fraudster || <span className="text-grey">Not given yet</span>}</td>
                      <td className="text-[12.5px]">
                        {FOLLOWUP[c.fields.followup ?? "questions"] ?? "WhatsApp"}
                        <div className="text-[12px] text-grey">{proofs} proof file{proofs === 1 ? "" : "s"}</div>
                      </td>
                      <td className="max-w-[26ch] text-[12.5px]">
                        {c.missing.length ? c.missing.map((k) => FIELD_LABELS[k] ?? k).join(", ") : <span className="text-ok">Complete</span>}
                      </td>
                      <td className="whitespace-nowrap text-[13px]">{fmtDate(c.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
