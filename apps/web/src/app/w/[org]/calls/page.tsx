import type { Metadata } from "next";
import Link from "next/link";
import { can, holdsAnywhere, phoneFor } from "@jenai/authz";
import { Empty, Flash, PageHead, Pager, Section, StatusBadge, fmtDate, fmtDuration } from "@/components/ui";
import { requireWorkspace } from "@/server/access";
import { loadCalls } from "@/server/queries/modules";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Calls" };

export default async function CallsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ direction?: string; status?: string; branch?: string; page?: string; ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "calls:view")) return deny(ctx, { perm: "calls:view" });
  const page = Number(sp.page ?? 1) || 1;
  const { rows, total, branches } = await loadCalls(ctx.org.id, ctx.access, { direction: sp.direction, status: sp.status, branch: sp.branch, page });
  const q = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams(Object.entries({ direction: sp.direction, status: sp.status, branch: sp.branch, ...over }).filter(([, v]) => v) as [string, string][]);
    return `/w/${slug}/calls${u.size ? `?${u}` : ""}`;
  };
  const chip = (label: string, key: "direction" | "status", value?: string) => (
    <Link key={label} href={q({ [key]: value, page: undefined })} className={`btn btn-sm ${sp[key] === value || (!sp[key] && !value) ? "btn-dark" : "btn-ghost"}`}>{label}</Link>
  );

  return (
    <>
      <PageHead title="Calls" sub="Every call your AI agents handled, newest first. Numbers are masked unless your role allows full numbers." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {chip("All", "direction")}
        {chip("Inbound", "direction", "inbound")}
        {chip("Outbound", "direction", "outbound")}
        <span className="mx-1 h-5 w-px bg-line" />
        {chip("Any outcome", "status")}
        {chip("Completed", "status", "completed")}
        {chip("Not answered", "status", "no_answer")}
        {chip("In progress", "status", "in_progress")}
        {branches.length > 1 ? (
          <form className="ml-auto flex gap-2" action={`/w/${slug}/calls`}>
            {sp.direction ? <input type="hidden" name="direction" value={sp.direction} /> : null}
            {sp.status ? <input type="hidden" name="status" value={sp.status} /> : null}
            <select name="branch" defaultValue={sp.branch ?? ""} className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="Branch">
              <option value="">All my branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" type="submit">Filter</button>
          </form>
        ) : null}
      </div>
      <Section title={`${total} call${total === 1 ? "" : "s"}`}>
        {rows.length === 0 ? (
          <Empty>No calls yet. Calls appear here once JENAI syncs them from your AI agents.</Empty>
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>When</th><th>Caller</th><th>Direction</th><th>Agent · branch</th><th className="num">Length</th><th>Outcome</th></tr></thead>
                <tbody>
                  {rows.map(({ c, contactName, contactPhone, agentName, branchName }) => (
                    <tr key={c.id}>
                      <td className="whitespace-nowrap"><Link className="font-semibold hover:text-copper-deep" href={`/w/${slug}/calls/${c.id}`}>{fmtDate(c.startedAt)}</Link></td>
                      <td>
                        <div className="font-semibold">{contactName ?? (c.extracted.caller_name as string) ?? "Unknown caller"}</div>
                        <div className="font-mono text-[12px] text-grey">{phoneFor(can(ctx.access, "contacts:reveal_phone", { branchId: c.branchId }), contactPhone)}</div>
                      </td>
                      <td className="capitalize">{c.direction}</td>
                      <td className="text-ink-soft">{agentName ?? ""}{branchName ? ` · ${branchName}` : ""}</td>
                      <td className="num">{fmtDuration(c.durationS)}</td>
                      <td>
                        <StatusBadge status={c.status} />
                        {c.summary ? <div className="mt-1 max-w-[42ch] text-[12.5px] text-ink-soft">{c.summary}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} total={total} perPage={50} href={(p) => q({ page: String(p) })} />
          </>
        )}
      </Section>
    </>
  );
}
