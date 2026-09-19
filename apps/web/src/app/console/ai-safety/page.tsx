import type { Metadata } from "next";
import Link from "next/link";
import { GUARDRAILS_VERSION } from "@jenai/voice";
import { SUITE_VERSION } from "@jenai/engine";
import { Empty, Flash, PageHead, Section, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { failuresByCase, fleetSummary, queueHealth, reviewQueue, unsafeLiveAgents } from "@/server/platform/safety";
import { reviewCheck, sweepNow } from "@/server/actions/safety";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "AI safety" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "0%");

export default async function AiSafetyPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const ctx = await requirePlatform();
  const canView = platformCan(ctx, "platform:security.view") || platformCan(ctx, "platform:templates.manage");
  if (!canView) return deny({ user: ctx.user, org: { id: ctx.platformOrgId } }, { area: "console", perm: "platform:security.view" });
  const canReview = platformCan(ctx, "platform:templates.manage");
  const flash = await searchParams;
  const [s, byCase, unsafe, review, q] = await Promise.all([fleetSummary(), failuresByCase(), unsafeLiveAgents(), reviewQueue(), queueHealth()]);

  return (
    <>
      <PageHead
        title="AI safety"
        sub={`Every live agent, attacked by the red-team suite (v${SUITE_VERSION}) and carrying JENAI's safety rules (v${GUARDRAILS_VERSION}). Nothing goes live without passing; live agents are re-checked when the suite, model or prompts change.`}
        actions={
          canReview ? (
            <form action={sweepNow}>
              <SubmitButton className="btn btn-ghost btn-sm" pendingText="Queuing">Re-check live agents now</SubmitButton>
            </form>
          ) : null
        }
      />
      <Flash ok={flash.ok} error={flash.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Live agents" value={s.live ?? 0} />
        <Stat label="Passing" value={s.passed ?? 0} note={pct(s.passed ?? 0, s.live ?? 0)} tone="ok" />
        <Stat label="Failing" value={s.failed ?? 0} note="exposed callers" tone={(s.failed ?? 0) > 0 ? "bad" : undefined} />
        <Stat label="Not checked yet" value={(s.unchecked ?? 0) + (s.in_progress ?? 0)} note={s.in_progress ? `${s.in_progress} running` : undefined} tone={(s.unchecked ?? 0) > 0 ? "warn" : undefined} />
      </div>

      <Section title="Safety rules on live agents" sub="Agents carrying older rules, or none (prompts from before the platform), get the current rules when the next version is published.">
        <div className="grid gap-3 px-5 py-4">
          <Bar parts={[
            { label: `Current rules (v${GUARDRAILS_VERSION})`, n: s.guard_current ?? 0, cls: "bg-ok" },
            { label: "Older rules", n: s.guard_old ?? 0, cls: "bg-copper" },
            { label: "No rules (legacy prompt)", n: s.guard_none ?? 0, cls: "bg-bad" },
          ]} />
          {s.passed_old_suite ? <p className="text-[13px] text-ink-soft">{s.passed_old_suite} agents last passed an older suite and are due for a re-check.</p> : null}
        </div>
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Which tricks work, fleet-wide" sub="Failures counted across all live agents. A trick that works on many clients means the template or the safety rules need fixing once for everyone.">
          {byCase.length === 0 ? (
            <Empty>No live agent fails any case.</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Case</th><th>Severity</th><th className="text-right">Agents failing</th></tr></thead>
                <tbody>
                  {byCase.map((c) => (
                    <tr key={c.id}>
                      <td className="font-mono text-[12.5px]">{c.id}</td>
                      <td><span className={`badge ${c.severity === "critical" || c.severity === "high" ? "badge-bad" : "badge-muted"}`}>{c.severity}</span></td>
                      <td className="text-right tabular-nums">{c.agents} <span className="text-grey">({pct(c.agents, s.live ?? 0)})</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Check queue" sub="Publish checks jump the queue; fleet re-checks are capped per hour to control cost.">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 text-[13.5px]">
            <Row k="Waiting" v={`${q.queued}${q.oldest_minutes ? `, oldest ${q.oldest_minutes} min` : ""}`} bad={(q.oldest_minutes ?? 0) > 30} />
            <Row k="Running" v={String(q.running)} />
            <Row k="Finished, last 24 h" v={String(q.done_24h)} />
            <Row k="Reused (same prompts)" v={String(q.cached_24h)} />
            <Row k="Could not run, last 24 h" v={String(q.errors_24h)} bad={q.errors_24h > 0} />
          </dl>
        </Section>
      </div>

      <Section title="Live agents failing now" sub="Callers of these agents are exposed. Each also opened a security alert. Fix the facts or template, then publish a new version.">
        {unsafe.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Client</th><th>Agent</th><th>Failed</th><th>Rules</th><th>Checked</th></tr></thead>
              <tbody>
                {unsafe.map((u) => (
                  <tr key={u.agent_id}>
                    <td className="whitespace-nowrap"><Link className="font-semibold hover:underline" href={`/console/clients/${u.tenant_id}`}>{u.org_name}</Link></td>
                    <td className="whitespace-nowrap">{u.agent_name} <span className="text-grey">v{u.number}</span></td>
                    <td className="font-mono text-[12px]">{u.critical_failed ? <span className="badge badge-bad mr-1.5">{u.critical_failed} critical</span> : null}{u.failed_cases}</td>
                    <td className="whitespace-nowrap">{u.guardrails_version ? `v${u.guardrails_version}` : <span className="text-bad">none</span>}</td>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(u.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Waiting for a reviewer" sub="The two judges disagreed, or could not quote the agent. Read the conversation, then approve (the client may publish) or reject.">
        {review.length === 0 ? (
          <Empty>Nothing to review.</Empty>
        ) : (
          <ul className="grid gap-3 px-5 py-4">
            {review.map((r) => {
              const cases = (r.results as Array<{ id: string; verdict: string; reason: string; greeting: string; turns: Array<{ caller: string; agent: string }> }>).filter((x) => x.verdict !== "held");
              return (
                <li key={r.id} className="rounded-xl border border-line p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.org_name}</span>
                    <span className="text-ink-soft">{r.agent_name} v{r.number}</span>
                    <span className="badge badge-muted">{r.reason}</span>
                  </div>
                  {cases.map((c) => (
                    <details key={c.id} className="mb-2 rounded-lg bg-ivory px-3 py-2">
                      <summary className="cursor-pointer"><span className="font-mono text-[12.5px]">{c.id}</span> <span className="text-ink-soft">({c.verdict})</span>: {c.reason}</summary>
                      <div className="mt-2 grid gap-1 text-[13px]">
                        <p><span className="font-semibold">Agent:</span> {c.greeting}</p>
                        {c.turns.map((t, i) => (
                          <div key={i}>
                            <p><span className="font-semibold">Caller:</span> {t.caller}</p>
                            <p><span className="font-semibold">Agent:</span> {t.agent}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                  {canReview ? (
                    <form action={reviewCheck} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="tenantId" value={r.tenant_id} />
                      <input type="hidden" name="checkId" value={r.id} />
                      <div className="min-w-[240px] flex-1">
                        <label className="label" htmlFor={`note-${r.id}`}>What you read</label>
                        <input className="input" id={`note-${r.id}`} name="note" required minLength={5} maxLength={500} placeholder="e.g. Offered a visit; no diagnosis given" />
                      </div>
                      <button className="btn btn-dark btn-sm" name="decision" value="approve">Approve</button>
                      <button className="btn btn-danger btn-sm" name="decision" value="reject">Reject</button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="card px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 text-[24px] font-semibold tabular-nums ${color}`}>{value.toLocaleString("en-IN")}</div>
      {note ? <div className="text-[12px] text-grey">{note}</div> : null}
    </div>
  );
}

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <>
      <dt className="text-ink-soft">{k}</dt>
      <dd className={`text-right tabular-nums ${bad ? "font-semibold text-bad" : ""}`}>{v}</dd>
    </>
  );
}

function Bar({ parts }: { parts: Array<{ label: string; n: number; cls: string }> }) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  return (
    <div className="grid gap-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-ivory-2" role="img" aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(", ")}>
        {parts.map((p) => (p.n ? <div key={p.label} className={p.cls} style={{ width: `${(p.n / Math.max(total, 1)) * 100}%` }} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-soft">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5"><span className={`inline-block h-2.5 w-2.5 rounded-full ${p.cls}`} />{p.label}: <span className="tabular-nums text-ink">{p.n.toLocaleString("en-IN")}</span></span>
        ))}
      </div>
    </div>
  );
}
