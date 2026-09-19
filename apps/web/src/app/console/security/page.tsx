import type { Metadata } from "next";
import type { SecurityAlert } from "@jenai/db";
import { Empty, Flash, PageHead, Section, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { platformCan, requirePlatform } from "@/server/platform/context";
import { closedAlerts, detectorHeartbeat, lastIntegrityCheck, liveAlerts, recentProblems, signInSummary } from "@/server/platform/security";
import { checkAuditLogNow, handleAlert } from "@/server/actions/security";

export const metadata: Metadata = { title: "Security" };

const SEVERITY: Record<SecurityAlert["severity"], string> = {
  critical: "badge-bad",
  high: "badge-bad",
  medium: "badge-copper",
  low: "badge-muted",
};

const KIND: Record<string, string> = {
  signin_failed: "Wrong password",
  signin_locked: "Account locked",
  access_denied: "Access refused",
  mfa_failed: "Wrong 2-step code",
};

function describeDenial(detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  if (d.perm) return `Needs ${String(d.perm)}`;
  if (d.missing) return "Record not visible to them";
  if (d.malformedId) return "Malformed record address";
  if (d.workspace) return `Workspace "${String(d.workspace)}" (not a member)`;
  if (d.area === "console") return "Console (not Diigoo staff)";
  return "";
}

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const ctx = await requirePlatform("platform:security.view");
  const manage = platformCan(ctx, "platform:security.manage");
  const flash = await searchParams;
  const [live, closed, summary, problems, integrity, beat] = await Promise.all([
    liveAlerts(),
    closedAlerts(),
    signInSummary(),
    recentProblems(),
    lastIntegrityCheck(),
    detectorHeartbeat(),
  ]);
  const urgent = live.filter(({ a }) => a.severity === "critical" || a.severity === "high").length;
  const detectorLate = !beat || Date.now() - beat.getTime() > 5 * 60_000;

  return (
    <>
      <PageHead
        title="Security"
        sub="Alerts from the detector, sign-in activity and the integrity of the activity log. High and critical alerts are also sent to the on-call email."
      />
      <Flash ok={flash.ok} error={flash.error} />

      {urgent > 0 ? (
        <div className="notice notice-bad mb-5" role="alert">
          <strong>{urgent} high or critical alert{urgent === 1 ? "" : "s"} open.</strong> If this is a real incident, CERT-In must be told within 6 hours of noticing it.
          Follow the incident runbook (docs/security/incident-response.md) and record who was told and when.
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Open alerts" value={live.length} tone={urgent ? "bad" : live.length ? "warn" : "ok"} />
        <Stat label="Sign-ins, 24 h" value={summary.ok} />
        <Stat label="Wrong passwords, 24 h" value={summary.failed} tone={summary.failed > 20 ? "warn" : undefined} />
        <Stat label="Lockouts, 24 h" value={summary.locked} tone={summary.locked ? "warn" : undefined} />
        <Stat label="Access refused, 24 h" value={summary.denied} tone={summary.denied > 20 ? "warn" : undefined} />
      </div>

      <Section
        title="Activity log integrity"
        sub="Every workspace's log is a hash chain: changing or removing any past event breaks it. The worker checks every hour and ships the chain heads to the server logs."
        actions={
          <form action={checkAuditLogNow}>
            <SubmitButton className="btn btn-ghost btn-sm" pendingText="Checking...">Check now</SubmitButton>
          </form>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
          {integrity ? (
            integrity.broken ? (
              <span className="badge badge-bad">Changed in {integrity.broken} chain{integrity.broken === 1 ? "" : "s"}</span>
            ) : (
              <span className="badge badge-ok">Intact</span>
            )
          ) : (
            <span className="badge badge-muted">Not checked yet</span>
          )}
          <span className="text-ink-soft">
            {integrity ? `${integrity.chains} chains, last checked ${fmtDate(integrity.at)}` : "Press Check now, or start the worker."}
          </span>
          <span className={detectorLate ? "text-bad" : "text-ink-soft"}>
            Detector {beat ? `last ran ${fmtDate(beat)}` : "has not run yet"}
            {detectorLate ? ". Start the worker: alerts are not being raised." : ""}
          </span>
        </div>
      </Section>

      <Section title="Open alerts" sub={manage ? "Acknowledge when you start looking. Resolve or close with a note saying what it was." : "You can see alerts; handling them needs the security manage permission."}>
        {live.length === 0 ? (
          <Empty>No open alerts.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Severity</th><th>What</th><th>Where</th><th className="text-right">Events</th><th>Seen</th>{manage ? <th>Handle</th> : null}</tr>
              </thead>
              <tbody>
                {live.map(({ a, orgName, handler }) => (
                  <tr key={a.id}>
                    <td><span className={`badge ${SEVERITY[a.severity]}`}>{a.severity}</span></td>
                    <td className="min-w-[260px]">
                      <div className="font-semibold">{a.title}</div>
                      <div className="text-[12.5px] text-ink-soft">{a.subject}</div>
                      <Detail detail={a.detail} />
                      {a.status === "acknowledged" ? <div className="mt-1 text-[12px] text-copper-deep">Being looked at by {handler ?? "a colleague"}</div> : null}
                    </td>
                    <td className="whitespace-nowrap">{orgName ?? <span className="text-grey">Platform</span>}</td>
                    <td className="text-right tabular-nums">{a.hits}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-ink-soft">
                      <div>First {fmtDate(a.firstSeen)}</div>
                      <div>Last {fmtDate(a.lastSeen)}</div>
                    </td>
                    {manage ? (
                      <td className="min-w-[230px]">
                        {a.status === "open" ? (
                          <form action={handleAlert} className="mb-2">
                            <input type="hidden" name="id" value={a.id} />
                            <input type="hidden" name="decision" value="acknowledge" />
                            <SubmitButton className="btn btn-ghost btn-sm">Acknowledge</SubmitButton>
                          </form>
                        ) : null}
                        <details>
                          <summary className="cursor-pointer text-[12.5px] font-semibold text-copper-deep">Close with a note</summary>
                          <form action={handleAlert} className="mt-2 grid gap-2">
                            <input type="hidden" name="id" value={a.id} />
                            <label className="sr-only" htmlFor={`note-${a.id}`}>What happened</label>
                            <textarea id={`note-${a.id}`} name="note" className="input h-auto min-h-[64px] py-2" placeholder="What it was and what was done" maxLength={500} required minLength={5} />
                            <div className="flex flex-wrap gap-2">
                              <button className="btn btn-dark btn-sm" name="decision" value="resolve">Resolve</button>
                              <button className="btn btn-ghost btn-sm" name="decision" value="false_positive">False positive</button>
                            </div>
                          </form>
                        </details>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recent sign-in and access problems" sub="Wrong passwords, lockouts and refused access, newest first. Kept 365 days.">
        {problems.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>What</th><th>Account</th><th>Where</th><th>Address</th></tr></thead>
              <tbody>
                {problems.map(({ e, userEmail, orgName }) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(e.createdAt)}</td>
                    <td>
                      <div>{KIND[e.kind] ?? e.kind}</div>
                      {e.kind === "access_denied" ? <div className="text-[12px] text-grey">{describeDenial(e.detail)}</div> : null}
                    </td>
                    <td className="whitespace-nowrap">{e.email ?? userEmail ?? <span className="text-grey">Unknown</span>}</td>
                    <td className="whitespace-nowrap">{orgName ?? <span className="text-grey">None</span>}</td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-ink-soft">{e.ip ?? "not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recently closed alerts">
        {closed.length === 0 ? (
          <Empty>No closed alerts yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Closed</th><th>Alert</th><th>Outcome</th><th>Note</th></tr></thead>
              <tbody>
                {closed.map(({ a, orgName, handler }) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(a.handledAt)}</td>
                    <td>
                      <div><span className={`badge mr-1.5 ${SEVERITY[a.severity]}`}>{a.severity}</span>{a.title}</div>
                      <div className="text-[12px] text-grey">{a.subject}{orgName ? ` · ${orgName}` : ""}</div>
                    </td>
                    <td className="whitespace-nowrap">{a.status === "false_positive" ? "False positive" : "Resolved"}{handler ? ` by ${handler}` : ""}</td>
                    <td className="text-ink-soft">{a.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="card px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 text-[24px] font-semibold tabular-nums ${color}`}>{value.toLocaleString("en-IN")}</div>
    </div>
  );
}

function Detail({ detail }: { detail: unknown }) {
  const d = (detail ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.failuresIn15Min === "number") parts.push(`${d.failuresIn15Min} wrong passwords in 15 min`);
  if (typeof d.accountsIn15Min === "number") parts.push(`${d.accountsIn15Min} accounts tried in 15 min`);
  if (typeof d.failuresBefore === "number") parts.push(`${d.failuresBefore} wrong passwords first`);
  if (typeof d.deniedIn10Min === "number") parts.push(`${d.deniedIn10Min} refusals in 10 min`);
  if (typeof d.playsIn10Min === "number") parts.push(`${d.playsIn10Min} recordings in 10 min`);
  if (Array.isArray(d.permissions)) parts.push(`Gave: ${(d.permissions as string[]).join(", ")}`);
  if (typeof d.summary === "string") parts.push(d.summary);
  if (typeof d.istHour === "number") parts.push(`at ${String(d.istHour).padStart(2, "0")}:00 India time`);
  if (typeof d.problem === "string") parts.push(d.problem);
  return parts.length ? <div className="mt-0.5 text-[12px] text-grey">{parts.join(" · ")}</div> : null;
}
