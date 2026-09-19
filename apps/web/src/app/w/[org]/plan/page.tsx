import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { holdsAnywhere } from "@jenai/authz";
import { FEATURE_LABELS, LIMIT_LABELS, rupees } from "@jenai/engine";
import { PageHead, Section, fmtDate } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadPlanUsage } from "@/server/queries/modules";

export const metadata: Metadata = { title: "Plan and usage" };

const MODEL: Record<string, string> = {
  prepaid: "Prepaid monthly plan",
  postpaid_invoice: "Postpaid: monthly tax invoice",
  contract: "Annual contract, billed monthly",
};

export default async function PlanPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "billing:view")) notFound();
  const { ent, period, statement: s, counts } = await loadPlanUsage(ctx.org.id);
  const sub = ent.subscription;
  const pct = s.includedMinutes ? Math.min(100, (s.usage.minutes / s.includedMinutes) * 100) : 0;

  return (
    <>
      <PageHead title="Plan and usage" sub={`${ent.plan.name} · ${MODEL[ent.billingModel]}`} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title={`This billing period: ${period.label}`} sub={`${fmtDate(period.from, false)} to ${fmtDate(new Date(period.to.getTime() - 1), false)}`}>
          <div className="grid gap-4 px-5 py-4">
            <div className="grid grid-cols-3 gap-3">
              <div><div className="eyebrow">Calls</div><div className="h-display text-[24px] tabular-nums">{s.usage.calls}</div><div className="text-[12px] text-grey">{s.usage.inboundCalls} in · {s.usage.outboundCalls} out</div></div>
              <div><div className="eyebrow">Minutes</div><div className="h-display text-[24px] tabular-nums">{s.usage.minutes}</div><div className="text-[12px] text-grey">each started minute counts</div></div>
              <div><div className="eyebrow">{sub?.contractRatePaisePerMin != null ? "Committed" : "Included"}</div><div className="h-display text-[24px] tabular-nums">{s.includedMinutes || "Per contract"}</div></div>
            </div>
            {s.includedMinutes ? (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-ivory-2"><div className={`h-full ${pct >= 90 ? "bg-bad" : "bg-copper"}`} style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 text-[12px] text-grey">{Math.round(pct)}% of {sub?.contractRatePaisePerMin != null ? "committed" : "included"} minutes used</div>
              </div>
            ) : null}
            <table className="tbl">
              <tbody>
                <tr><td>{ent.plan.feeBasis === "per_branch" ? `Plan fee (${counts.branches} branch${counts.branches === 1 ? "" : "es"})` : "Plan or contract fee"}</td><td className="num">{rupees(s.fixedFeePaise)}</td></tr>
                <tr><td>{s.ratePaisePerMin ? `${s.billableMinutes} minutes at ${rupees(s.ratePaisePerMin)}` : "Usage"}</td><td className="num">{rupees(s.usagePaise)}</td></tr>
                <tr><td className="font-semibold">Estimated amount before GST</td><td className="num font-semibold">{rupees(s.subtotalPaise)}</td></tr>
              </tbody>
            </table>
            <p className="text-[12px] text-grey">{s.note} GST is added on the tax invoice. This is an estimate until the period closes.</p>
          </div>
        </Section>
        <div className="grid content-start gap-6">
          <Section title="What your plan includes">
            <div className="grid gap-4 px-5 py-4">
              <table className="tbl">
                <tbody>
                  {(Object.keys(LIMIT_LABELS) as Array<keyof typeof LIMIT_LABELS>).map((k) => {
                    const max = ent.limits[k];
                    const used = (counts as Record<string, number>)[k];
                    return (
                      <tr key={k}><td>{LIMIT_LABELS[k]}</td><td className="num">{used !== undefined ? `${used} of ` : ""}{max ?? "No limit"}</td></tr>
                    );
                  })}
                </tbody>
              </table>
              <ul className="grid gap-1 text-[13px]">
                {[...ent.features].map((f) => <li key={f}>✓ {FEATURE_LABELS[f] ?? f}</li>)}
              </ul>
            </div>
          </Section>
          {sub && (sub.poNumber || sub.invoiceToName) ? (
            <Section title="Invoice details">
              <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 px-5 py-4 text-[13px]">
                {sub.poNumber ? <><dt className="text-grey">PO / work order</dt><dd>{sub.poNumber}{sub.poValidUntil ? ` (valid until ${sub.poValidUntil})` : ""}</dd></> : null}
                {sub.invoiceToName ? <><dt className="text-grey">Invoice to</dt><dd>{sub.invoiceToName}{sub.invoiceToDepartment ? `, ${sub.invoiceToDepartment}` : ""}</dd></> : null}
                {sub.invoiceToAddress ? <><dt className="text-grey">Address</dt><dd>{sub.invoiceToAddress}</dd></> : null}
                {sub.invoiceToGstin ? <><dt className="text-grey">GSTIN</dt><dd>{sub.invoiceToGstin}</dd></> : null}
                <dt className="text-grey">Payment terms</dt><dd>{sub.paymentTermsDays} days</dd>
              </dl>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
