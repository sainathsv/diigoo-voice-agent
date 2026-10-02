import { withTenant, telephoneLineStatus } from "@jenai/db";
import type { LineStatus } from "@jenai/engine";
import { fmtDate } from "@/components/ui";

const OVERALL: Record<string, { text: string; tone: string }> = {
  ok: { text: "Working", tone: "bg-ok-wash text-ok" },
  waiting: { text: "Waiting for the telecom team's details", tone: "bg-warn-wash text-warn" },
  fail: { text: "Needs attention", tone: "bg-bad-wash text-bad" },
};
const DOT: Record<string, string> = { ok: "bg-ok", waiting: "bg-warn", fail: "bg-bad" };

/**
 * The government telephone line on the home page: the cable, the address on its
 * port, the telecom system, our gateway and the automatic AI test call, each with
 * what to do. Shown only on a server where the line monitor runs.
 */
export async function TelephoneLineCard({ tenantId }: { tenantId: string }) {
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(telephoneLineStatus).limit(1));
  if (!row) return null;
  const s = row.status as unknown as LineStatus;
  const stale = Date.now() - row.checkedAt.getTime() > 3 * 60_000;
  const o = stale ? { text: "Monitor not reporting", tone: "bg-bad-wash text-bad" } : (OVERALL[s.overall] ?? OVERALL.waiting!);
  return (
    <section className="card mb-6 overflow-hidden" aria-label="Government telephone line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <div>
          <div className="eyebrow">Government telephone line{s.iface ? ` · port ${s.iface}` : ""}</div>
          <div className="text-[12px] text-grey">Checked {fmtDate(row.checkedAt)}, every minute</div>
        </div>
        <span className={`rounded-full px-3 py-1 text-[12.5px] font-semibold ${o.tone}`}>{o.text}</span>
      </div>
      {stale ? <p className="px-5 pt-3 text-[13px] text-bad">The line monitor has not reported for {Math.round((Date.now() - row.checkedAt.getTime()) / 60_000)} minutes. The background service may be stopped: run sudo systemctl restart jenai-worker on the server.</p> : null}
      <ul className="grid gap-x-6 gap-y-3 px-5 py-4 md:grid-cols-2">
        {s.checks.map((c) => (
          <li key={c.key} className="flex gap-2.5 text-[13px]">
            <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.state] ?? "bg-grey"}`} aria-hidden="true" />
            <div>
              <div className="font-semibold">{c.label} <span className="sr-only">{c.state}</span></div>
              <div className="text-ink-soft">{c.detail}</div>
              {c.fix && c.state !== "ok" ? <div className="mt-0.5 text-[12.5px] text-grey">What to do: {c.fix}</div> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
