import type { Metadata } from "next";
import Link from "next/link";
import { branchesFor, can, holdsAnywhere, phoneFor } from "@jenai/authz";
import { SCAM_CATEGORIES, callAnalytics, categoryLabel, categoryOf, scamLabel, SCAM_TYPES, type WhatsAppProgress } from "@jenai/engine";
import { Empty, PageHead, Section, fmtDate, fmtDuration } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCase } from "@/server/queries/cases";
import { TelephoneLineCard } from "@/components/telephone-line";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Analytics" };

const RANGES = [7, 30, 90, 365] as const;
const inr = (r: number) => `₹${r.toLocaleString("en-IN")}`;

/** Where the WhatsApp follow-up stands, in a few words. */
function WhatsAppCell({ w }: { w: WhatsAppProgress | null }) {
  if (!w) return <span className="text-[12px] text-grey">None</span>;
  const state =
    w.followup === "none" ? "Caller said no" : w.followup === "form_link" ? "Form link sent" : w.followup === "portal" ? "Referred to cybercrime.gov.in (over 15 days)" : w.stillNeeded ? `${w.stillNeeded} still needed` : "Complete";
  const tone = w.followup === "questions" && !w.stillNeeded ? "text-ok" : w.followup === "questions" ? "text-warn" : "text-grey";
  return (
    <div className="text-[12.5px]">
      <div className={`font-semibold ${tone}`}>{state}</div>
      <div className="text-grey">{w.proofs} proof file{w.proofs === 1 ? "" : "s"}</div>
    </div>
  );
}

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

/** The WhatsApp conversation of one complaint, beside the board. */
async function ChatPanel({ slug, tenantId, caseId, canSee, closeHref }: { slug: string; tenantId: string; caseId: string; canSee: (branchId: string | null, perm: "calls:view" | "transcripts:view_raw" | "recordings:play") => boolean; closeHref: string }) {
  const d = /^[0-9a-f-]{36}$/i.test(caseId) ? await loadCase(tenantId, caseId) : null;
  if (!d || !canSee(d.c.branchId, "calls:view")) return null;
  const raw = canSee(d.c.branchId, "transcripts:view_raw");
  const proof = canSee(d.c.branchId, "recordings:play");
  const files = new Map(d.evidence.map((e) => [e.id, e]));
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[460px] max-w-full flex-col border-l border-line bg-white shadow-2xl" aria-label="WhatsApp chat">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="eyebrow">WhatsApp chat</div>
          <div className="h-display text-[17px]">Case <span className="font-mono">{d.no}</span></div>
          <div className="text-[12px] text-grey">{d.messages.length} message{d.messages.length === 1 ? "" : "s"} · {d.evidence.length} proof file{d.evidence.length === 1 ? "" : "s"}</div>
        </div>
        <div className="flex gap-1.5">
          <Link href={`/w/${slug}/cases/${d.c.id}`} className="btn btn-ghost btn-sm">Open case</Link>
          <Link href={closeHref} className="btn btn-ghost btn-sm" aria-label="Close the chat">Close</Link>
        </div>
      </div>
      <div className="grid flex-1 content-start gap-2 overflow-auto bg-ivory px-4 py-4">
        {d.messages.length === 0 ? <p className="text-[13px] text-grey">No WhatsApp messages for this complaint.</p> : null}
        {d.messages.map((m) => {
          const ev = m.evidenceId ? files.get(m.evidenceId) : undefined;
          return (
            <div key={m.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] shadow-sm ${m.direction === "out" ? "justify-self-end bg-copper-wash" : "justify-self-start bg-white"}`}>
              {ev && proof && ev.kind === "image" ? (
                <a href={`/api/w/${slug}/cases/${d.c.id}/evidence/${ev.id}`} target="_blank" rel="noopener">
                  <img src={`/api/w/${slug}/cases/${d.c.id}/evidence/${ev.id}`} alt={ev.caption ?? "Proof"} className="mb-1 max-h-[220px] rounded object-contain" />
                </a>
              ) : null}
              <div className="whitespace-pre-wrap">{raw ? (m.body ?? (ev ? `[${ev.kind}]` : "")) : m.direction === "out" ? "Helpline message" : "Complainant message"}</div>
              <div className="mt-1 text-[10.5px] text-grey">
                {m.direction === "out" ? "Helpline" : "Complainant"} · {fmtDate(m.at)}
                {m.direction === "out" ? ` · ${m.status}` : ""}
                {m.error ? <span className="text-bad"> · {m.error}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ days?: string; type?: string; cat?: string; chat?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  const branches = branchesFor(ctx.access, "calls:view");
  if (branches !== "all" && !branches.length) return deny(ctx, { perm: "calls:view" });
  const days = RANGES.find((d) => String(d) === sp.days) ?? 30;
  const a = await callAnalytics(ctx.org.id, days, { branches });
  const type = SCAM_TYPES.some((s) => s.key === sp.type) ? sp.type : sp.type === "none" ? "none" : undefined;
  const cat = SCAM_CATEGORIES.some((c) => c.key === sp.cat) ? sp.cat : undefined;
  const list = a.complaints.filter((c) => (!type || (type === "none" ? c.scam === null : c.scam === type)) && (!cat || categoryOf(c.scam) === cat));
  const types = cat ? a.byType.filter((t) => categoryOf(t.type) === cat) : a.byType;
  const exportable = holdsAnywhere(ctx.access, "contacts:export") && holdsAnywhere(ctx.access, "transcripts:view_raw");
  const sheets = holdsAnywhere(ctx.access, "transcripts:view_raw");
  const maxType = Math.max(0, ...types.map((t) => t.count));
  const maxDistrict = Math.max(0, ...a.byDistrict.map((d) => d.count));
  const maxDay = Math.max(0, ...a.byDay.map((d) => d.count));
  const q = (extra: Record<string, string>) => `/w/${slug}/analytics?${new URLSearchParams({ days: String(days), ...extra })}`;
  const keep: Record<string, string> = { ...(type ? { type } : {}), ...(cat ? { cat } : {}) };

  return (
    <>
      <PageHead
        title="Analytics"
        sub="Every complaint the helpline took, by call and on WhatsApp: what kind of scam, how many, who complained, where, and how much money went."
        actions={
          <div className="flex flex-wrap gap-1.5">
            {exportable ? <a href={`/api/w/${slug}/complaints?days=${days}`} className="btn btn-sm btn-dark">Download all (Excel)</a> : null}
            {RANGES.map((d) => (
              <Link key={d} href={`/w/${slug}/analytics?days=${d}${type ? `&type=${type}` : ""}`} className={`btn btn-sm ${d === days ? "btn-dark" : "btn-ghost"}`}>{d === 365 ? "1 year" : `${d} days`}</Link>
            ))}
          </div>
        }
      />
      <TelephoneLineCard tenantId={ctx.org.id} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card card-pad"><div className="eyebrow">Complaints</div><div className="h-display mt-1 text-[28px]">{a.total}</div></div>
        <div className="card card-pad"><div className="eyebrow">People who complained</div><div className="h-display mt-1 text-[28px]">{a.people}</div></div>
        <div className="card card-pad"><div className="eyebrow">Money reported lost</div><div className="h-display mt-1 text-[28px]">{inr(a.lostRupees)}</div></div>
        <div className="card card-pad"><div className="eyebrow">Urgent (danger mentioned)</div><div className={`h-display mt-1 text-[28px] ${a.urgent ? "text-bad" : ""}`}>{a.urgent}</div></div>
      </div>

      {a.total > 0 ? (
        <section className="mb-6" aria-label="Main categories">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="h-display text-[17px]">Main categories</h2>
            {cat ? <Link href={q({})} className="text-[12.5px] font-semibold text-copper-deep hover:underline">Show all categories</Link> : <span className="text-[12px] text-grey">From the calls and WhatsApp together. Click one to see only those complaints.</span>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {a.byCategory.map((c) => (
              <Link
                key={c.category}
                href={cat === c.category ? q({}) : q({ cat: c.category })}
                className={`card card-pad block transition hover:border-ink ${cat === c.category ? "border-ink ring-1 ring-ink" : ""}`}
                aria-current={cat === c.category ? "true" : undefined}
              >
                <div className="eyebrow">{categoryLabel(c.category)}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="h-display text-[28px] tabular-nums">{c.count}</span>
                  <span className="text-[12.5px] text-grey">{a.total ? Math.round((c.count / a.total) * 100) : 0}% of complaints</span>
                </div>
                <div className="mt-1 text-[12.5px] tabular-nums text-ink-soft">{c.lostRupees ? `${inr(c.lostRupees)} reported lost` : "No money reported lost"}</div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {a.total === 0 ? (
        <Section title="No complaints yet"><Empty>Complaints appear here within a minute or two of each call.</Empty></Section>
      ) : (
        <>
          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <Section title="By type of scam" sub="Click a type to list only those complaints.">
              <div className="grid gap-4 px-5 py-4">
                {types.map((t) => (
                  <Bar key={t.type ?? "none"} value={t.count} max={maxType} label={t.type ? scamLabel(t.type) : "Type not clear yet"} sub={t.lostRupees ? `${inr(t.lostRupees)} lost` : undefined} href={q({ ...(cat ? { cat } : {}), type: t.type ?? "none" })} />
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
            title={`${list.length} complaint${list.length === 1 ? "" : "s"}${cat ? `: ${categoryLabel(cat)}` : ""}${type ? `: ${type === "none" ? "type not clear yet" : scamLabel(type)}` : ""}`}
            actions={type || cat ? <Link href={q({})} className="btn btn-ghost btn-sm">Show every complaint</Link> : undefined}
          >
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Case sheet</th><th>When</th><th>Complainant</th><th>Scam</th><th>What happened</th><th>Who did it</th><th>Where</th><th>Lost</th><th>WhatsApp</th></tr></thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.callId ?? c.whatsapp?.caseId}>
                      <td>
                        {sheets ? (
                          <Link href={c.callId ? `/print/${slug}/calls/${c.callId}` : `/print/${slug}/cases/${c.whatsapp!.caseId}`} target="_blank" className="btn btn-ghost btn-sm">Download</Link>
                        ) : (
                          <span className="text-[12px] text-grey">No access</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {c.callId ? (
                          <Link href={`/w/${slug}/calls/${c.callId}`} className="font-semibold text-copper-deep hover:underline">{fmtDate(c.at)}</Link>
                        ) : (
                          <Link href={`/w/${slug}/cases/${c.whatsapp!.caseId}`} className="font-semibold text-copper-deep hover:underline">{fmtDate(c.at)}</Link>
                        )}
                        <div className="text-[12px] text-grey">{c.callId ? fmtDuration(c.durationS) : "on WhatsApp"}</div>
                      </td>
                      <td>
                        <div className="font-semibold">{c.name ?? <span className="text-grey">Not given</span>}</div>
                        <div className="font-mono text-[12px] text-grey">{phoneFor(can(ctx.access, "contacts:reveal_phone", { branchId: c.branchId }), c.phone)}</div>
                        {c.urgent ? <span className="badge badge-bad mt-1">urgent</span> : null}
                      </td>
                      <td className="max-w-[18ch]">{c.scam ? scamLabel(c.scam) : <span className="text-grey">Not clear yet</span>}</td>
                      <td className="max-w-[40ch] text-[13px]">{c.summary ?? <span className="text-grey">No summary</span>}</td>
                      <td className="max-w-[22ch] break-words text-[13px]">{c.fraudster ?? <span className="text-grey">Not given</span>}</td>
                      <td className="max-w-[16ch] text-[13px]">{c.place ?? <span className="text-grey">Not given</span>}</td>
                      <td className="whitespace-nowrap tabular-nums">{c.lostRupees ? inr(c.lostRupees) : <span className="text-grey">None</span>}</td>
                      <td className="whitespace-nowrap">
                        {c.whatsapp ? (
                          <Link href={q({ ...keep, chat: c.whatsapp.caseId })} scroll={false} className="block rounded px-1 hover:bg-ivory-2" title="Show the WhatsApp chat">
                            <WhatsAppCell w={c.whatsapp} />
                            <div className="text-[11.5px] font-semibold text-copper-deep">View chat</div>
                          </Link>
                        ) : (
                          <WhatsAppCell w={null} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
      {sp.chat ? <ChatPanel slug={slug} tenantId={ctx.org.id} caseId={sp.chat} canSee={(branchId, perm) => can(ctx.access, perm, { branchId })} closeHref={q(keep)} /> : null}
    </>
  );
}
