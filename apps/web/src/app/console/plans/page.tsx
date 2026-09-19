import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { plans, platformDb } from "@jenai/db";
import { FEATURE_LABELS, LIMIT_LABELS, rupees } from "@jenai/engine";
import { Flash, PageHead, Section } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { updatePlanAction } from "@/server/actions/console-modules";

export const metadata: Metadata = { title: "Plans" };

const MODEL: Record<string, string> = { prepaid: "Prepaid", postpaid_invoice: "Postpaid invoice", contract: "Contract" };

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const flash = await searchParams;
  const ctx = await requirePlatform("platform:billing.view");
  const edit = platformCan(ctx, "platform:billing.manage");
  const list = await platformDb().select().from(plans).orderBy(asc(plans.sort));

  return (
    <>
      <PageHead
        title="Plans"
        sub="Proposed list prices from the September 2026 market research (before GST). Confirm them against one week of measured cost per minute before quoting. Government and enterprise terms are set per client."
      />
      <Flash {...flash} />
      <div className="mb-6 tbl-wrap card">
        <table className="tbl">
          <thead><tr><th>Plan</th><th>Billing</th><th className="num">Fee</th><th className="num">Included minutes</th><th className="num">Extra per minute</th><th>Limits</th><th>Includes</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.key}>
                <td><div className="font-semibold">{p.name}{p.active ? "" : " (inactive)"}</div><div className="max-w-[30ch] text-[12px] text-grey">{p.description}</div></td>
                <td>{MODEL[p.billingModel]}</td>
                <td className="num">{p.feeBasis === "contract" ? "Per contract" : `${rupees(p.monthlyFeePaise)}${p.feeBasis === "per_branch" ? " per branch" : ""}`}</td>
                <td className="num">{p.feeBasis === "contract" ? "Per contract" : p.includedMinutes.toLocaleString("en-IN")}</td>
                <td className="num">{p.overagePaisePerMin != null ? rupees(p.overagePaisePerMin) : ""}</td>
                <td className="text-[12.5px]">{Object.entries(p.limits).map(([k, v]) => `${LIMIT_LABELS[k as keyof typeof LIMIT_LABELS] ?? k}: ${v}`).join(", ") || "Per contract"}</td>
                <td className="text-[12.5px]">{p.features.map((f) => FEATURE_LABELS[f] ?? f).join(", ") || "Test calls only"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((p) => (
            <Section key={p.key} title={`Edit ${p.name}`}>
              <form action={updatePlanAction} className="grid gap-3 px-5 py-4 sm:grid-cols-2">
                <input type="hidden" name="key" value={p.key} />
                <div><label className="label" htmlFor={`${p.key}-n`}>Name</label><input className="input" id={`${p.key}-n`} name="name" defaultValue={p.name} /></div>
                <div><label className="label" htmlFor={`${p.key}-f`}>Monthly fee (₹)</label><input className="input" id={`${p.key}-f`} name="monthlyFee" inputMode="decimal" defaultValue={p.monthlyFeePaise / 100} /></div>
                <div><label className="label" htmlFor={`${p.key}-i`}>Included minutes</label><input className="input" id={`${p.key}-i`} name="includedMinutes" inputMode="numeric" defaultValue={p.includedMinutes} /></div>
                <div><label className="label" htmlFor={`${p.key}-o`}>Extra per minute (₹)</label><input className="input" id={`${p.key}-o`} name="overage" inputMode="decimal" defaultValue={p.overagePaisePerMin != null ? p.overagePaisePerMin / 100 : ""} /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor={`${p.key}-l`}>Limits (JSON)</label><input className="input font-mono text-[12.5px]" id={`${p.key}-l`} name="limits" defaultValue={JSON.stringify(p.limits)} /></div>
                <div className="sm:col-span-2"><label className="label" htmlFor={`${p.key}-x`}>Features (comma separated)</label><input className="input font-mono text-[12.5px]" id={`${p.key}-x`} name="features" defaultValue={p.features.join(", ")} /></div>
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="active" defaultChecked={p.active} className="accent-[#C96A3C]" />Offered to new clients</label>
                <div><SubmitButton pendingText="Saving">Save</SubmitButton></div>
              </form>
            </Section>
          ))}
        </div>
      ) : null}
    </>
  );
}
