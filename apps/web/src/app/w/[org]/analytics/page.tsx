import type { Metadata } from "next";
import Link from "next/link";
import { holdsAnywhere, phoneFor } from "@jenai/authz";
import { callAnalytics, scamLabel, SCAM_TYPES } from "@jenai/engine";
import { Empty, PageHead, Section, fmtDate, fmtDuration } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Analytics" };

const RANGES = [7, 30, 90, 365] as const;
const inr = (r: number) => `₹${r.toLocaleString("en-IN")}`;

function Bar({ value, max, label, sub, href }: { value: number; max: number; label: string; sub?: string; href?: string }) {
  const pct = max ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <div className="truncate text-[13.5px] font-semibold">{href ? <Link href={href} className="hover:underline">{label}</Link> : label}</div>
      <div className="text-right text-[13px] tabular-nums"><b>{value}</b>{sub ? <span className="text-grey"> · {sub}</span> : null}</div>
      <div className="col-span-2 h-2 rounded-full bg-ivory-2"><div className="h-2 rounded-full bg-copper" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ days?: string; type?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "calls:view")) return deny(ctx, { perm: "calls:view" });
  const days = RANGES.find((d) => String(d) === sp.days) ?? 30;
  const a = await callAnalytics(ctx.org.id, days);
  const type = SCAM_TYPES.some((s) => s.key === sp.type) ? sp.type : sp.type === "none" ? "none" : undefined;
  const list = type ? a.complaints.filter((c) => (type === "none" ? c.scam === null : c.scam === type)) : a.complaints;
  const reveal = holdsAnywhere(ctx.access, "contacts:reveal_phone");
  const maxType = Math.max(0, ...a.byType.map((t) => t.count));
  const maxDistrict = Math.max(0, ...a.byDistrict.map((d) => d.count));
  const maxDay = Math.max(0, ...a.byDay.map((d) => d.count));
  const q = (extra: Record<string, string>) => `/w/${slug}/analytics?${new URLSearchParams({ days: String(days), ...extra })}`;

  return (
    <>
      <PageHead
        title="Analytics"
        sub="Every complaint the helpline took: what kind of scam, how many, who complained, where, and how much money went."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {RANGES.map((d) => (
              <Link key={d} href={`/w/${slug}/analytics?days=${d}${type ? `&type=${type}` : ""}`} className={`btn btn-sm ${d === days ? "btn-dark" : "btn-ghost"}`}>{d === 365 ? "1 year" : `${d} days`}</Link>
            ))}
          </div>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad"><div className="eyebrow">Complaints</div><div className="h-display mt-1 text-[28px]">{a.total}</div></div>
        <div className="card card-pad"><div className="eyebrow">People who called</div><div className="h-display mt-1 text-[28px]">{a.people}</div></div>
        <div className="card card-pad"><div className="eyebrow">Money reported lost</div><div className="h-display mt-1 text-[28px]">{inr(a.lostRupees)}</div></div>
        <div className="card card-pad"><div className="eyebrow">Urgent (danger mentioned)</div><div className={`h-display mt-1 text-[28px] ${a.urgent ? "text-bad" : ""}`}>{a.urgent}</div></div>
      </div>

      {a.total === 0 ? (
        <Section title="No complaints yet"><Empty>Complaints appear here within a minute or two of each call.</Empty></Section>
      ) : (
        <>
          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <Section title="By type of scam" sub="Click a type to list only those complaints.">
              <div className="grid gap-4 px-5 py-4">
                {a.byType.map((t) => (
                  <Bar key={t.type ?? "none"} value={t.count} max={maxType} label={t.type ? scamLabel(t.type) : "Type not clear yet"} sub={t.lostRupees ? `${inr(t.lostRupees)} lost` : undefined} href={q({ type: t.type ?? "none" })} />
                ))}
              </div>
            </Section>
            <div className="grid content-start gap-6">
              <Section title="By district">
                <div className="grid gap-4 px-5 py-4">{a.byDistrict.map((d) => <Bar key={d.district} value={d.count} max={maxDistrict} label={d.district} />)}</div>
              </Section>
              <Section title="Complaints per day">
                <div className="flex h-32 items-end gap-1 px-5 py-4" role="img" aria-label="Complaints per day">
                  {a.byDay.map((d) => <div key={d.day} className="flex-1 rounded-t bg-copper" style={{ height: `${Math.max(4, Math.round((d.count / (maxDay || 1)) * 100))}%` }} title={`${d.day}: ${d.count}`} />)}
                </div>
                <div className="flex justify-between px-5 pb-3 text-[11.5px] text-grey"><span>{a.byDay[0]?.day}</span><span>{a.byDay.at(-1)?.day}</span></div>
              </Section>
            </div>
          </div>

          <Section
            title={`${list.length} complaint${list.length === 1 ? "" : "s"}${type ? `: ${type === "none" ? "type not clear yet" : scamLabel(type)}` : ""}`}
            actions={type ? <Link href={q({})} className="btn btn-ghost btn-sm">Show every type</Link> : undefined}
          >
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>When</th><th>Complainant</th><th>Scam</th><th>What happened</th><th>Who did it</th><th>Where</th><th>Lost</th></tr></thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.callId}>
                      <td className="whitespace-nowrap">
                        <Link href={`/w/${slug}/calls/${c.callId}`} className="font-semibold text-copper-deep hover:underline">{fmtDate(c.at)}</Link>
                        <div className="text-[12px] text-grey">{fmtDuration(c.durationS)}</div>
                      </td>
                      <td>
                        <div className="font-semibold">{c.name ?? <span className="text-grey">Not given</span>}</div>
                        <div className="font-mono text-[12px] text-grey">{phoneFor(reveal, c.phone)}</div>
                        {c.urgent ? <span className="badge badge-bad mt-1">urgent</span> : null}
                      </td>
                      <td className="max-w-[18ch]">{c.scam ? scamLabel(c.scam) : <span className="text-grey">Not clear yet</span>}</td>
                      <td className="max-w-[40ch] text-[13px]">{c.summary ?? <span className="text-grey">No summary</span>}</td>
                      <td className="max-w-[22ch] break-words text-[13px]">{c.fraudster ?? <span className="text-grey">Not given</span>}</td>
                      <td className="max-w-[16ch] text-[13px]">{c.place ?? <span className="text-grey">Not given</span>}</td>
                      <td className="whitespace-nowrap tabular-nums">{c.lostRupees ? inr(c.lostRupees) : <span className="text-grey">None</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
