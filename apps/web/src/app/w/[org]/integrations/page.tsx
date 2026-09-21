import type { Metadata } from "next";
import { can } from "@jenai/authz";
import { Empty, Flash, PageHead, Section, StatusBadge, fmtDate } from "@/components/ui";
import { CopyField, SubmitButton } from "@/components/client";
import { requireWorkspace } from "@/server/access";
import { loadIntegrations } from "@/server/queries/integrations";
import { connectSystem, createApiKey, retryDeliveries, revealSigningSecret, revokeApiKey, setSystemStatus, testSystem } from "@/server/actions/integrations";
import { deny } from "@/server/security-log";

export const metadata: Metadata = { title: "Your systems" };

const KIND: Record<string, string> = {
  webhook_out: "Webhook",
  rest_generic: "Your API",
  zoho_crm: "Zoho CRM",
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  leadsquared: "LeadSquared",
  sap_odata: "SAP",
  google_sheets: "Google Sheets",
};

export default async function IntegrationsPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ ok?: string; error?: string; new_key?: string; add?: string }> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const ctx = await requireWorkspace(slug);
  if (!can(ctx.access, "integrations:manage") && !can(ctx.access, "apikeys:manage")) return deny(ctx, { perm: "integrations:manage" });
  const manage = can(ctx.access, "integrations:manage");
  const keysAllowed = can(ctx.access, "apikeys:manage");
  const { conns, keys, recent, programs, counts } = await loadIntegrations(ctx.org.id);
  const base = process.env.JENAI_PUBLIC_URL ?? "http://localhost:3100";
  const example = programs[0]?.key ?? "clinic.appointment_reminder";

  return (
    <>
      <PageHead
        title="Your systems"
        sub="Keep running Zoho, SAP or whatever you already use. JENAI sends every call result back into it, and a button in your system can start a call here. Nothing has to move."
      />
      <Flash ok={sp.ok} error={sp.error} />
      {sp.new_key ? (
        <div className="notice notice-warn mb-5">
          <div className="mb-2 font-semibold">Copy this now. It is not shown again.</div>
          <CopyField label="Secret" value={sp.new_key} />
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Connected systems" value={conns.filter((c) => c.status === "connected").length} />
        <Stat label="Sent, last 24 h" value={counts.sentToday} />
        <Stat label="Waiting to send" value={counts.waiting} tone={counts.waiting > 50 ? "warn" : undefined} />
        <Stat label="Could not be sent" value={counts.failed} tone={counts.failed > 0 ? "bad" : undefined} />
      </div>

      <Section title="Connected systems" sub="Each one gets the call result within seconds. If it is down, JENAI keeps trying for a day.">
        {conns.length === 0 ? (
          <Empty>Nothing connected yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>System</th><th>Type</th><th>Gets</th><th>State</th><th>Last</th>{manage ? <th /> : null}</tr></thead>
              <tbody>
                {conns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="font-semibold">{c.name}</div>
                      <div className="max-w-[320px] truncate font-mono text-[11.5px] text-grey">{String(c.config.url ?? c.config.module ?? "")}</div>
                    </td>
                    <td className="whitespace-nowrap">{KIND[c.kind] ?? c.kind}</td>
                    <td className="text-[12.5px]">{c.events.length ? c.events.join(", ") : "everything"}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="whitespace-nowrap text-[12.5px] text-ink-soft">
                      {c.lastError ? <span className="text-bad">{c.lastError.slice(0, 60)}</span> : c.lastOkAt ? `worked ${fmtDate(c.lastOkAt)}` : "not tested"}
                    </td>
                    {manage ? (
                      <td>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Act slug={slug} id={c.id} action={testSystem} label="Test" />
                          {c.kind === "webhook_out" ? <Act slug={slug} id={c.id} action={revealSigningSecret} label="Signing secret" /> : null}
                          {c.status === "paused" ? <Act slug={slug} id={c.id} action={setSystemStatus} label="Resume" to="connected" /> : <Act slug={slug} id={c.id} action={setSystemStatus} label="Pause" to="paused" />}
                          <Act slug={slug} id={c.id} action={retryDeliveries} label="Send failed again" />
                          <Act slug={slug} id={c.id} action={setSystemStatus} label="Remove" to="removed" danger />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {manage ? (
        <Section title="Connect a system" sub="A webhook is the quickest. Zoho writes a note on the right record after every call.">
          <form action={connectSystem} className="grid gap-4 px-5 py-4 lg:grid-cols-2">
            <input type="hidden" name="slug" value={slug} />
            <div className="lg:col-span-2">
              <label className="label" htmlFor="kind">What are you connecting</label>
              <select className="input" id="kind" name="kind" defaultValue="webhook_out">
                <option value="webhook_out">A webhook in our own system</option>
                <option value="rest_generic">Our own API</option>
                <option value="zoho_crm">Zoho CRM</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="name">Name it</label>
              <input className="input" id="name" name="name" required minLength={2} maxLength={60} placeholder="Our CRM" />
            </div>
            <div>
              <label className="label" htmlFor="url">Address (webhook or your API)</label>
              <input className="input" id="url" name="url" placeholder="https://crm.example.in/jenai/calls" maxLength={400} />
            </div>
            <fieldset className="lg:col-span-2">
              <legend className="label">Send us</legend>
              <div className="flex flex-wrap gap-4 text-[13.5px]">
                <label className="flex items-center gap-2"><input type="checkbox" name="event_call.completed" defaultChecked /> Call results</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="event_appointment.booked" defaultChecked /> Bookings</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="event_do_not_call.added" /> Do-not-call requests</label>
              </div>
            </fieldset>
            <details className="lg:col-span-2">
              <summary className="cursor-pointer text-[13px] font-semibold text-copper-deep">Zoho CRM details</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <label className="label" htmlFor="dc">Zoho data centre</label>
                  <select className="input" id="dc" name="dc" defaultValue="in">
                    <option value="in">India (zoho.in)</option>
                    <option value="com">Global (zoho.com)</option>
                    <option value="eu">Europe</option>
                    <option value="au">Australia</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="module">Which records</label>
                  <select className="input" id="module" name="module" defaultValue="Leads">
                    <option>Leads</option>
                    <option>Contacts</option>
                    <option>Deals</option>
                  </select>
                </div>
                <div><label className="label" htmlFor="client_id">Client id</label><input className="input" id="client_id" name="client_id" maxLength={200} /></div>
                <div><label className="label" htmlFor="client_secret">Client secret</label><input className="input" id="client_secret" name="client_secret" type="password" maxLength={200} /></div>
                <div className="md:col-span-2"><label className="label" htmlFor="refresh_token">Refresh token</label><input className="input" id="refresh_token" name="refresh_token" type="password" maxLength={400} /></div>
                <p className="md:col-span-2 text-[12px] text-grey">From your Zoho API console: a Self Client with the CRM modules scope. JENAI stores these encrypted and uses them only to write your call results back.</p>
              </div>
            </details>
            <div className="lg:col-span-2">
              <SubmitButton className="btn btn-primary" pendingText="Connecting">Connect</SubmitButton>
            </div>
          </form>
        </Section>
      ) : null}

      {keysAllowed ? (
        <Section title="Keys for your own systems" sub="A key lets your system ask JENAI to call someone, and read what happened.">
          <div className="grid gap-4 px-5 py-4">
            {keys.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Key</th><th>May</th><th>Last used</th><th>Calls</th><th /></tr></thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id} className={k.revokedAt ? "opacity-50" : ""}>
                        <td>{k.name}</td>
                        <td className="font-mono text-[12px]">{k.prefix}...</td>
                        <td className="text-[12.5px]">{k.scopes.join(", ")}</td>
                        <td className="whitespace-nowrap text-[12.5px] text-ink-soft">{k.lastUsedAt ? fmtDate(k.lastUsedAt) : "never"}</td>
                        <td className="tabular-nums">{k.callsMade}</td>
                        <td className="text-right">
                          {k.revokedAt ? <span className="badge badge-muted">revoked</span> : <Act slug={slug} id={k.id} action={revokeApiKey} label="Revoke" danger />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <form action={createApiKey} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
              <input type="hidden" name="slug" value={slug} />
              <div>
                <label className="label" htmlFor="key-name">New key for</label>
                <input className="input" id="key-name" name="name" placeholder="Zoho button" maxLength={60} required />
              </div>
              <div>
                <label className="label" htmlFor="allowedIps">Only from these addresses (optional)</label>
                <input className="input" id="allowedIps" name="allowedIps" placeholder="103.21.58.4" maxLength={300} />
              </div>
              <SubmitButton className="btn btn-dark" pendingText="Creating">Create key</SubmitButton>
              <fieldset className="md:col-span-3">
                <legend className="label">This key may</legend>
                <div className="flex flex-wrap gap-4 text-[13.5px]">
                  <label className="flex items-center gap-2"><input type="checkbox" name="scope_calls:create" defaultChecked /> Ask for calls</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="scope_calls:read" defaultChecked /> Read call results</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="scope_programs:read" defaultChecked /> List programs</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="scope_leads:read" /> Read leads</label>
                </div>
              </fieldset>
            </form>
          </div>
        </Section>
      ) : null}

      <Section title="How your developer calls us" sub="Two endpoints do most of it. Every call still follows your calling rules: do-not-call, consent, caller ID and calling hours.">
        <div className="grid gap-3 px-5 py-4">
          <pre className="overflow-x-auto rounded-lg bg-ink px-4 py-3 text-[12px] leading-relaxed text-ivory">{`# Ask JENAI to call someone (from a button or a workflow in your system)
curl -X POST ${base}/api/v1/calls \\
  -H "Authorization: Bearer jk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "program": "${example}",
    "phone": "98765 43210",
    "name": "Ravi",
    "external_id": "YOUR-RECORD-ID",
    "context": { "appointment_date": "25 Sep 2026", "appointment_time": "11:00 AM" },
    "idempotency_key": "your-ticket-9001"
  }'

# What happened on it
curl ${base}/api/v1/calls/<id> -H "Authorization: Bearer jk_live_..."

# Which programs this workspace runs, and what each call needs
curl ${base}/api/v1/programs -H "Authorization: Bearer jk_live_..."`}</pre>
          <p className="text-[12.5px] text-grey">
            The answer tells you at once whether the call is allowed, so your screen can show &quot;will call&quot; or the reason it cannot. Results come back to the systems above, signed, with the same reference you sent as external_id.
          </p>
        </div>
      </Section>

      <Section title="Recent deliveries">
        {recent.length === 0 ? (
          <Empty>Nothing sent yet.</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>What</th><th>Direction</th><th>State</th><th>Their answer</th></tr></thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-ink-soft">{fmtDate(e.createdAt)}</td>
                    <td className="font-mono text-[12px]">{e.kind}</td>
                    <td>{e.direction === "out" ? "to your system" : "from your system"}</td>
                    <td><StatusBadge status={e.status === "done" ? "passed" : e.status === "failed" ? "failed" : e.status} /></td>
                    <td className="max-w-[320px] truncate text-[12.5px] text-ink-soft">{e.error ?? e.response ?? (e.httpStatus ? `HTTP ${e.httpStatus}` : "")}</td>
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  return (
    <div className="card px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 text-[24px] font-semibold tabular-nums ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value.toLocaleString("en-IN")}</div>
    </div>
  );
}

function Act({ slug, id, action, label, to, danger }: { slug: string; id: string; action: (fd: FormData) => Promise<void>; label: string; to?: string; danger?: boolean }) {
  return (
    <form action={action}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={id} />
      {to ? <input type="hidden" name="to" value={to} /> : null}
      <SubmitButton className={`btn btn-sm ${danger ? "btn-danger" : "btn-ghost"}`} pendingText="...">{label}</SubmitButton>
    </form>
  );
}
