import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@jenai/authz";
import { withTenant } from "@jenai/db";
import { checkDrift, getVoiceConnection } from "@jenai/engine";
import { defaultOutboundOpening, lintVersion } from "@jenai/voice";
import { Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { loadAgent } from "@/server/queries/modules";
import { approveAndPublish, saveAgentDraft, submitForApproval } from "@/server/actions/modules";

export const metadata: Metadata = { title: "AI agent" };

export default async function AgentPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: Promise<{ v?: string; ok?: string; error?: string }> }) {
  const { org: slug, id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireWorkspace(slug);
  const d = await loadAgent(ctx.org.id, id);
  if (!d) notFound();
  const scope = { branchId: d.a.branchId };
  if (!can(ctx.access, "agents:view", scope)) notFound();
  const canEdit = can(ctx.access, "agents:edit", scope) || can(ctx.access, "knowledge:edit", scope);
  const canPublish = can(ctx.access, "agents:publish", scope);
  const conn = await withTenant(ctx.org.id, (tx) => getVoiceConnection(tx, ctx.org.id));
  const managed = conn?.mode === "managed";
  const live = d.versions.find((x) => x.v.id === d.a.liveVersionId)?.v;
  const selected = d.versions.find((x) => x.v.id === sp.v)?.v ?? d.versions.find((x) => ["draft", "pending_approval", "failed"].includes(x.v.state))?.v ?? live;
  const base = selected ?? live;
  let drift: Awaited<ReturnType<typeof checkDrift>> | null = null;
  let driftError: string | null = null;
  if (live && conn) {
    try {
      drift = await checkDrift(ctx.org.id, id);
    } catch (e) {
      driftError = (e as Error).message;
    }
  }
  const issues = selected ? lintVersion(selected) : [];

  return (
    <>
      <PageHead
        title={d.a.name}
        sub={<span className="flex flex-wrap items-center gap-2"><span className="capitalize">{d.a.purpose.replace("_", " ")}</span>·<span>{d.branchName ?? "All branches"}</span>·<span>Inbound workflow {d.a.inboundWorkflowId ?? "none"}, outbound {d.a.outboundWorkflowId ?? "none"}</span></span>}
        actions={<Link className="btn btn-ghost" href={`/w/${slug}/agents`}>All agents</Link>}
      />
      <Flash ok={sp.ok} error={sp.error} />
      {!managed ? (
        <div className="notice notice-warn mb-5">
          Read-only: this agent is live on the current system. You can prepare and approve versions here; JENAI switches publishing on when your workspace moves to the new platform, so nothing you do here changes live calls yet.
        </div>
      ) : null}
      {drift && !drift.inSync ? (
        <div className="notice notice-bad mb-5">
          What callers hear right now differs from v{live?.number} ({[!drift.inboundMatches && "inbound", !drift.outboundMatches && "outbound"].filter(Boolean).join(" and ")} changed outside JENAI). Publish a version to bring both back in line.
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          {selected ? (
            <Section
              title={`Version ${selected.number}`}
              sub={<span className="flex items-center gap-2"><StatusBadge status={selected.state} />{selected.changeNote ?? ""}</span>}
              actions={
                <div className="flex flex-wrap gap-2">
                  {selected.state === "draft" && canEdit ? (
                    <form action={submitForApproval}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="versionId" value={selected.id} />
                      <button className="btn btn-ghost btn-sm" type="submit" disabled={issues.some((i) => i.level === "error")}>Send for approval</button>
                    </form>
                  ) : null}
                  {["draft", "pending_approval", "failed"].includes(selected.state) && canPublish ? (
                    <form action={approveAndPublish}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="versionId" value={selected.id} />
                      <button className="btn btn-primary btn-sm" type="submit" disabled={!managed || issues.some((i) => i.level === "error")} title={managed ? "Publish to inbound and outbound" : "Publishing is off until your workspace moves over"}>
                        Approve and publish
                      </button>
                    </form>
                  ) : null}
                </div>
              }
            >
              <div className="grid gap-4 px-5 py-4">
                {issues.length ? (
                  <ul className="grid gap-1.5">
                    {issues.map((i) => (
                      <li key={i.message} className={`notice ${i.level === "error" ? "notice-bad" : "notice-warn"}`}>{i.level === "error" ? "Must fix: " : "Check: "}{i.message}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="notice notice-ok">All pre-publish checks pass.</div>
                )}
                <div><div className="eyebrow mb-1">Inbound greeting</div><p className="rounded-lg bg-ivory px-3 py-2">{selected.greeting || <span className="text-grey">Not set</span>}</p></div>
                <div><div className="eyebrow mb-1">Outbound opening</div><p className="rounded-lg bg-ivory px-3 py-2">{selected.outboundOpening || defaultOutboundOpening(selected.greeting || "Welcome to your clinic.")}</p></div>
                <div><div className="eyebrow mb-1">Business facts</div><pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg bg-ivory px-3 py-2 font-sans text-[13px]">{selected.facts}</pre></div>
                {selected.publishResult ? (
                  <div className="text-[12.5px] text-grey">Publish result: {JSON.stringify(selected.publishResult)}</div>
                ) : null}
              </div>
            </Section>
          ) : null}

          {canEdit && base ? (
            <Section title="Prepare a new version" sub="Only your business facts, greeting and opening change; the shared JENAI behaviour rules (languages, booking checks, no invented prices) stay the same for every client.">
              <form action={saveAgentDraft} className="grid gap-4 px-5 py-4">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="agentId" value={id} />
                <div>
                  <label className="label" htmlFor="greeting">Inbound greeting (first words when someone calls)</label>
                  <textarea className="input" id="greeting" name="greeting" rows={2} required defaultValue={base.greeting} />
                  <p className="help">Must say it is an AI assistant, for example: "I am Ananya, the clinic&apos;s AI assistant."</p>
                </div>
                <div>
                  <label className="label" htmlFor="opening">Outbound opening (optional)</label>
                  <textarea className="input" id="opening" name="outboundOpening" rows={2} defaultValue={base.outboundOpening ?? ""} placeholder={defaultOutboundOpening(base.greeting || "Welcome to your clinic.")} />
                  <p className="help">You can use {"{{caller_name}}"} and {"{{call_purpose}}"}.</p>
                </div>
                <div>
                  <label className="label" htmlFor="facts">Business facts</label>
                  <textarea className="input font-mono text-[12.5px]" id="facts" name="facts" rows={12} required defaultValue={base.facts} />
                  <p className="help">Services, timings, address, doctors, and the ONLY prices the agent may say.</p>
                </div>
                <div><label className="label" htmlFor="note">What changed</label><input className="input" id="note" name="changeNote" placeholder="New Sunday timings" /></div>
                <div><SubmitButton pendingText="Saving draft">Save as draft</SubmitButton></div>
              </form>
            </Section>
          ) : null}
        </div>

        <div className="grid content-start gap-6">
          <Section title="Versions">
            <ul className="divide-y divide-line">
              {d.versions.map(({ v, createdByName }) => (
                <li key={v.id}>
                  <Link href={`/w/${slug}/agents/${id}?v=${v.id}`} className={`block px-5 py-3 hover:bg-ivory ${selected?.id === v.id ? "bg-copper-wash" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">v{v.number}{v.id === d.a.liveVersionId ? " · live" : ""}</span>
                      <StatusBadge status={v.state} />
                    </div>
                    <div className="text-[12px] text-grey">{fmtDate(v.createdAt)}{createdByName ? ` · ${createdByName}` : ""}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Live check">
            <div className="px-5 py-4 text-[13.5px]">
              {drift ? (drift.inSync ? <span className="badge badge-ok">In sync with live calls</span> : <span className="badge badge-bad">Differs from live calls</span>) : <span className="text-grey">{driftError ?? "Not checked"}</span>}
              {drift ? <div className="mt-1 text-[12px] text-grey">Checked {fmtDate(drift.checkedAt)}</div> : null}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
