import type { Metadata } from "next";
import Link from "next/link";
import type { ProgramTemplate } from "@jenai/db";
import { can, holdsAnywhere } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { loadPrograms } from "@/server/queries/programs";
import { startProgram, startProgramCampaign } from "@/server/actions/programs";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Call programs" };

const PURPOSE: Record<string, { badge: string; label: string; rule: string }> = {
  promotional: {
    badge: "badge-copper",
    label: "Promotional",
    rule: "Needs a 140-series number, written consent from each person, and the list scrubbed against DND before every round.",
  },
  transactional: {
    badge: "badge-muted",
    label: "Transactional",
    rule: "About something the person already has with you (a booking, a bill, a licence). May be called on DND numbers. Never mix an offer into it.",
  },
  service: {
    badge: "badge-muted",
    label: "Service",
    rule: "About the person's own care, complaint or experience. May be called on DND numbers. Never mix an offer into it.",
  },
};

export default async function ProgramsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string; set_up?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "agents:view")) return deny(ctx, { perm: "agents:view" });
  const canSetUp = can(ctx.access, "agents:edit");
  const canCall = can(ctx.access, "campaigns:create");
  const { catalogue, running, numbers } = await loadPrograms(ctx.org.id);
  const started = new Set(running.map((r) => r.program.programKey));
  const available = catalogue.filter((c) => !started.has(c.key));
  const opening = catalogue.find((c) => c.key === sp.set_up) ?? null;

  return (
    <>
      <PageHead
        title="Call programs"
        sub="Ready-made calling jobs. Switch one on, answer a few questions, and JENAI writes the script, sets the calling rules and drafts the agent that makes those calls."
      />
      <Flash ok={sp.ok} error={sp.error} />

      {opening ? <SetUpForm slug={slug} program={opening} numbers={numbers} /> : null}

      <Section title="Your programs" sub={running.length ? "Each one has its own agent, script and calling rules." : undefined}>
        {running.length === 0 ? (
          <Empty>Nothing set up yet. Pick one below.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Program</th><th>Type</th><th>Agent</th><th>Calling rounds</th><th>Set up</th>{canCall ? <th /> : null}</tr></thead>
              <tbody>
                {running.map(({ program, template, agent, liveVersion, campaigns, live }) => (
                  <tr key={program.id}>
                    <td>
                      <div className="font-semibold">{program.name}</div>
                      <div className="text-[12px] text-grey">{template?.summary ?? program.programKey}</div>
                    </td>
                    <td className="whitespace-nowrap">{template ? <span className={`badge ${PURPOSE[template.purpose]!.badge}`}>{PURPOSE[template.purpose]!.label}</span> : null}</td>
                    <td className="whitespace-nowrap">
                      {agent ? (
                        <Link className="font-semibold hover:underline" href={`/w/${slug}/agents/${agent.id}`}>{agent.name}</Link>
                      ) : (
                        <span className="text-grey">not created</span>
                      )}
                      <div className="text-[12px] text-grey">{liveVersion ? `v${liveVersion} live` : "draft, not live yet"}</div>
                    </td>
                    <td className="whitespace-nowrap">{campaigns === 0 ? <span className="text-grey">none</span> : `${campaigns} total${live ? `, ${live} running` : ""}`}</td>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(program.createdAt, false)}</td>
                    {canCall ? (
                      <td className="text-right">
                        <form action={startProgramCampaign} className="flex flex-wrap items-center justify-end gap-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="clientProgramId" value={program.id} />
                          {program.callerNumberId ? null : (
                            <select className="input h-8 w-auto py-0 text-[12.5px]" name="callerNumberId" aria-label="Call from">
                              <option value="">Call from...</option>
                              {numbers.map((n) => (
                                <option key={n.id} value={n.id}>{n.e164}</option>
                              ))}
                            </select>
                          )}
                          <SubmitButton className="btn btn-ghost btn-sm" pendingText="Creating">New calling round</SubmitButton>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Available programs" sub="Written for your kind of business, with the rules that apply to each type of call already built in.">
        {available.length === 0 ? (
          <Empty>You are running every program we have for your business. Tell JENAI what else you call people about.</Empty>
        ) : (
          <ul className="grid gap-3 px-5 py-4 md:grid-cols-2">
            {available.map((p) => (
              <li key={p.key} className="card flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <span className={`badge ${PURPOSE[p.purpose]!.badge}`}>{PURPOSE[p.purpose]!.label}</span>
                </div>
                <p className="text-ink-soft">{p.summary}</p>
                <p className="text-[12.5px] text-grey">{PURPOSE[p.purpose]!.rule}</p>
                <details className="text-[12.5px]">
                  <summary className="cursor-pointer font-semibold text-copper-deep">What it needs</summary>
                  <div className="mt-1.5 grid gap-1 text-ink-soft">
                    <p><span className="font-semibold">For each person:</span> {p.variables.map((v) => v.label).join(", ")}</p>
                    {p.requirements.records?.length ? <p><span className="font-semibold">Before you start:</span> {p.requirements.records.join("; ")}</p> : null}
                    <p><span className="font-semibold">Calls:</span> {(p.defaults.windows?.start ?? "10:00")} to {(p.defaults.windows?.end ?? "19:00")}, up to {p.defaults.maxAttempts ?? 3} attempts.</p>
                  </div>
                </details>
                {canSetUp ? (
                  <div className="mt-auto pt-1">
                    <Link className="btn btn-primary btn-sm" href={`/w/${slug}/programs?set_up=${p.key}#set-up`}>Set up</Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function SetUpForm({ slug, program, numbers }: { slug: string; program: ProgramTemplate; numbers: Array<{ id: string; e164: string; series: string }> }) {
  const promo = program.purpose === "promotional";
  const usable = numbers.filter((n) => (promo ? n.series === "series_140" : n.series !== "series_140"));
  return (
    <Section
      title={`Set up: ${program.name}`}
      sub={program.goal}
      actions={<Link className="btn btn-ghost btn-sm" href={`/w/${slug}/programs`}>Cancel</Link>}
    >
      <div id="set-up" className="grid gap-4 px-5 py-4">
        <div className={`notice ${promo ? "notice-warn" : "notice-ok"}`}>{program.complianceNote}</div>
        <form action={startProgram} className="grid gap-4">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="programKey" value={program.key} />
          {program.clientFields.map((f) => (
            <div key={f.name}>
              <label className="label" htmlFor={`f-${f.name}`}>{f.label}{f.required ? "" : " (optional)"}</label>
              <input className="input" id={`f-${f.name}`} name={`f_${f.name}`} required={f.required} placeholder={f.example} maxLength={400} />
              {f.help ? <p className="mt-1 text-[12px] text-grey">{f.help}</p> : null}
            </div>
          ))}
          <div>
            <label className="label" htmlFor="callerNumberId">Call from</label>
            <select className="input" id="callerNumberId" name="callerNumberId" defaultValue="">
              <option value="">Choose later</option>
              {usable.map((n) => (
                <option key={n.id} value={n.id}>{n.e164}</option>
              ))}
            </select>
            <p className="mt-1 text-[12px] text-grey">
              {promo
                ? "Promotional calls must come from a 140-series number that JENAI has declared for AI calling."
                : "Any of your ordinary numbers. A 140-series number is only for promotional calls."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton className="btn btn-primary" pendingText="Setting up">Set up this program</SubmitButton>
            <span className="text-[12.5px] text-grey">JENAI drafts the agent and the script. Nothing calls anyone until you approve and publish it.</span>
          </div>
        </form>
        <div className="rounded-xl border border-line px-4 py-3">
          <div className="eyebrow mb-1">What the agent records on each call</div>
          <p className="text-[13px] text-ink-soft">{program.outcomes.map((o) => o.label).join(" · ")}</p>
        </div>
      </div>
    </Section>
  );
}
