import type { Metadata } from "next";
import { can } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { decideSupportGrant, revokeSupportGrant, setStandingSupport, updateOrgProfile } from "@/server/actions/workspace";
import { loadSupport } from "@/server/queries/workspace";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { org: slug } = await params;
  const flash = await searchParams;
  const ctx = await requireWorkspace(slug);
  const profile = can(ctx.access, "org:manage");
  const consent = can(ctx.access, "support_access:grant");
  if (!profile && !consent) return deny(ctx, { perm: "settings" });
  const grants = consent ? await loadSupport(ctx.org.id) : [];
  const now = new Date();
  const pending = grants.filter((x) => x.g.status === "requested");
  const live = grants.filter((x) => x.g.status === "approved" && x.g.expiresAt && x.g.expiresAt > now);
  const past = grants.filter((x) => !pending.includes(x) && !live.includes(x));
  const standing = ctx.org.supportAccessUntil && ctx.org.supportAccessUntil > now ? ctx.org.supportAccessUntil : null;
  const o = ctx.org;

  return (
    <>
      <PageHead title="Settings" />
      <Flash {...flash} />
      <div className="grid gap-6">
        {profile ? (
          <Section title="Business profile" sub="Used on invoices and in your AI agent's greeting.">
            <form action={updateOrgProfile} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              <input type="hidden" name="slug" value={slug} />
              <div><label className="label" htmlFor="o-name">Display name</label><input className="input" id="o-name" name="name" defaultValue={o.name} required /></div>
              <div><label className="label" htmlFor="o-legal">Legal name</label><input className="input" id="o-legal" name="legalName" defaultValue={o.legalName ?? ""} /></div>
              <div><label className="label" htmlFor="o-gstin">GSTIN</label><input className="input uppercase" id="o-gstin" name="gstin" defaultValue={o.gstin ?? ""} maxLength={15} placeholder="36ABCDE1234F1Z5" /></div>
              <div><label className="label" htmlFor="o-city">City</label><input className="input" id="o-city" name="city" defaultValue={o.city ?? ""} /></div>
              <div><SubmitButton pendingText="Saving">Save profile</SubmitButton></div>
            </form>
          </Section>
        ) : null}

        {consent ? (
          <>
            <Section
              title="JENAI support access"
              sub="JENAI staff cannot see your calls, contacts or recordings unless you allow it. Every support session is time-limited and appears in your activity log."
            >
              <div className="grid gap-5 px-5 py-4">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div className="max-w-[60ch]">
                    <div className="font-semibold">Standing read-only access</div>
                    <p className="text-[13px] text-grey">
                      {standing
                        ? `On until ${fmtDate(standing)}. JENAI support can open read-only sessions without asking each time. Recordings and full phone numbers stay hidden.`
                        : "Off. JENAI must ask you each time."}
                    </p>
                  </div>
                  <form action={setStandingSupport} className="flex gap-2">
                    <input type="hidden" name="slug" value={slug} />
                    <select className="input h-9 w-auto" name="days" defaultValue={standing ? "0" : "7"} aria-label="Allow for">
                      <option value="0">Off</option>
                      <option value="1">1 day</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                    </select>
                    <button className="btn btn-ghost" type="submit">Apply</button>
                  </form>
                </div>
              </div>
            </Section>

            <Section title={`Requests waiting for you (${pending.length})`}>
              {pending.length === 0 ? (
                <Empty>No pending requests.</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {pending.map(({ g, staffName }) => (
                    <li key={g.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                      <div className="max-w-[65ch]">
                        <div className="font-semibold">
                          {staffName ?? "JENAI staff"} asks for {g.mode === "read" ? "read-only" : "change"} access for {g.durationMinutes} minutes
                        </div>
                        <div className="text-[13px] text-ink-soft">{g.reason}</div>
                        <div className="text-[12px] text-grey">Ticket {g.ticket ?? "none"} · asked {fmtDate(g.requestedAt)}{g.mode === "write" ? " · change access also needs a second JENAI approver" : ""}</div>
                      </div>
                      <div className="flex gap-2">
                        <form action={decideSupportGrant}>
                          <input type="hidden" name="slug" value={slug} /><input type="hidden" name="grantId" value={g.id} /><input type="hidden" name="decision" value="approve" />
                          <button className="btn btn-primary btn-sm" type="submit">Allow</button>
                        </form>
                        <form action={decideSupportGrant}>
                          <input type="hidden" name="slug" value={slug} /><input type="hidden" name="grantId" value={g.id} /><input type="hidden" name="decision" value="deny" />
                          <button className="btn btn-ghost btn-sm" type="submit">Decline</button>
                        </form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Support sessions">
              {live.length + past.length === 0 ? (
                <Empty>No support sessions yet.</Empty>
              ) : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr><th>Who</th><th>Access</th><th>Reason</th><th>Window</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {[...live, ...past].map(({ g, staffName }) => (
                        <tr key={g.id}>
                          <td>{staffName ?? "JENAI staff"}</td>
                          <td>{g.mode === "read" ? "Read-only" : g.mode === "write" ? "Can change" : "Emergency"}</td>
                          <td className="max-w-[40ch] text-ink-soft">{g.reason}</td>
                          <td className="whitespace-nowrap text-[12.5px]">{g.startsAt ? `${fmtDate(g.startsAt)} to ${fmtDate(g.expiresAt)}` : "Not started"}</td>
                          <td><StatusBadge status={g.status === "approved" ? (g.expiresAt && g.expiresAt > now ? "active" : "expired") : g.status} /></td>
                          <td className="text-right">
                            {g.status === "approved" && g.expiresAt && g.expiresAt > now ? (
                              <form action={revokeSupportGrant}>
                                <input type="hidden" name="slug" value={slug} /><input type="hidden" name="grantId" value={g.id} />
                                <button className="btn btn-danger btn-sm" type="submit">End now</button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </>
        ) : null}
      </div>
    </>
  );
}
