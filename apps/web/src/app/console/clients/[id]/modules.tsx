import { desc, eq } from "drizzle-orm";
import { agentVersions, agents, branches, carrierAccounts, phoneNumbers, plans, platformDb, subscriptions, tenantDatabases, voiceConnections, withTenant } from "@jenai/db";
import { PURPOSE_LABEL, SERIES_LABEL, billingPeriod, entitlements, inboundToday, planGate, rupees, statement, usage, voiceClient } from "@jenai/engine";
import { Section, StatusBadge, fmtDate } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/client";
import {
  addCarrierAccountAction,
  addNumberAction,
  declareA2p,
  importAgentAction,
  importNumbersAction,
  saveConnection,
  saveSubscription,
  setConnectionMode,
  setKyc,
  syncNow,
} from "@/server/actions/console-modules";

const KYC_TONE: Record<string, string> = { not_started: "pending", link_sent: "in_progress", submitted: "in_progress", verified: "passed", rejected: "failed" };

export async function VoiceSection({ orgId, canManage, canProvision }: { orgId: string; canManage: boolean; canProvision: boolean }) {
  const db = platformDb();
  const [conn] = await db.select().from(voiceConnections).where(eq(voiceConnections.tenantId, orgId));
  const list = await db.select({ a: agents }).from(agents).where(eq(agents.tenantId, orgId)).orderBy(agents.name);
  const liveVersions = await db.select().from(agentVersions).where(eq(agentVersions.tenantId, orgId)).orderBy(desc(agentVersions.number));
  const bs = await db.select().from(branches).where(eq(branches.tenantId, orgId)).orderBy(branches.name);
  let workflows: Array<{ id: number; name: string }> = [];
  let wfError: string | null = null;
  if (conn && conn.status === "ok") {
    try {
      const v = await withTenant(orgId, (tx) => voiceClient(tx, orgId));
      workflows = (await v!.client.listWorkflows()).map((w) => ({ id: w.id, name: w.name }));
    } catch (e) {
      wfError = (e as Error).message;
    }
  }
  const mapped = new Set(list.flatMap(({ a }) => [a.inboundWorkflowId, a.outboundWorkflowId]).filter(Boolean));

  return (
    <div id="voice">
      <Section
        title="Voice engine"
        sub="How JENAI reads this client's calls and, once managed, publishes agents and places campaign calls."
        actions={conn ? <span className="flex items-center gap-2"><StatusBadge status={conn.status === "ok" ? "active" : conn.status === "error" ? "failed" : "pending"} /><span className={`badge ${conn.mode === "managed" ? "badge-copper" : "badge-muted"}`}>{conn.mode === "managed" ? "Managed" : "Read-only"}</span></span> : null}
      >
        <div className="grid gap-5 px-5 py-4">
          {conn ? (
            <div className="grid gap-2 text-[13px]">
              <div>Engine: <span className="font-mono">{conn.baseUrl}</span>{conn.externalOrgId ? ` · organization ${conn.externalOrgId}` : ""} · signs in with {conn.authKind === "api_key" ? "an API key" : "a login"} (stored encrypted)</div>
              <div className="text-grey">Last verified {fmtDate(conn.lastVerifiedAt) || "never"} · last sync {fmtDate(conn.lastSyncAt) || "never"}{conn.lastError ? ` · last error: ${conn.lastError}` : ""}</div>
              <div className="flex flex-wrap gap-2">
                {canProvision ? (
                  <form action={syncNow} className="flex gap-2">
                    <input type="hidden" name="orgId" value={orgId} />
                    <select name="max" className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="How many recent calls" defaultValue="50">
                      <option value="20">Latest 20 per workflow</option>
                      <option value="50">Latest 50 per workflow</option>
                      <option value="200">Latest 200 per workflow</option>
                    </select>
                    <button className="btn btn-ghost btn-sm" type="submit">Sync calls now</button>
                  </form>
                ) : null}
                {canManage ? (
                  <form action={setConnectionMode}>
                    <input type="hidden" name="orgId" value={orgId} />
                    <input type="hidden" name="mode" value={conn.mode === "managed" ? "read_only" : "managed"} />
                    {conn.mode === "managed" ? (
                      <button className="btn btn-ghost btn-sm" type="submit">Switch to read-only</button>
                    ) : (
                      <ConfirmButton className="btn btn-danger btn-sm" message="Switch to MANAGED? Publishing agent versions and running campaigns will then change this client's LIVE calls. Do this only at the agreed cutover.">Switch to managed</ConfirmButton>
                    )}
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}

          {canManage ? (
            <details className="rounded-lg border border-line p-3" open={!conn}>
              <summary className="cursor-pointer font-semibold">{conn ? "Change connection" : "Connect the voice engine"}</summary>
              <form action={saveConnection} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="orgId" value={orgId} />
                <div><label className="label" htmlFor="v-url">Engine address</label><input className="input" id="v-url" name="baseUrl" defaultValue={conn?.baseUrl ?? "https://voice.jenai.in"} required /></div>
                <div><label className="label" htmlFor="v-org">Engine organization id</label><input className="input" id="v-org" name="externalOrgId" defaultValue={conn?.externalOrgId ?? ""} inputMode="numeric" /></div>
                <div>
                  <label className="label" htmlFor="v-kind">Sign in with</label>
                  <select className="input" id="v-kind" name="authKind" defaultValue={conn?.authKind ?? "api_key"}>
                    <option value="api_key">Organization API key (needed for campaigns)</option>
                    <option value="password">Login email and password (read and publish only)</option>
                  </select>
                </div>
                <div><label className="label" htmlFor="v-key">API key</label><input className="input font-mono" id="v-key" name="apiKey" type="password" autoComplete="off" /></div>
                <div><label className="label" htmlFor="v-email">Login email</label><input className="input" id="v-email" name="email" type="email" autoComplete="off" /></div>
                <div><label className="label" htmlFor="v-pw">Login password</label><input className="input" id="v-pw" name="password" type="password" autoComplete="new-password" /></div>
                <p className="help sm:col-span-2">Credentials are encrypted for this client only and never shown again. Saving always starts in read-only mode.</p>
                <div><SubmitButton pendingText="Connecting">Save and verify</SubmitButton></div>
              </form>
            </details>
          ) : null}

          <div>
            <div className="eyebrow mb-2">Agents</div>
            {list.length === 0 ? (
              <p className="text-[13px] text-grey">No agents imported yet.</p>
            ) : (
              <ul className="grid gap-1.5 text-[13px]">
                {list.map(({ a }) => {
                  const live = liveVersions.find((v) => v.id === a.liveVersionId);
                  return (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ivory px-3 py-2">
                      <span><b>{a.name}</b> · inbound wf {a.inboundWorkflowId ?? "none"}, outbound wf {a.outboundWorkflowId ?? "none"}</span>
                      <span>{live ? <>v{live.number} <StatusBadge status={live.state === "imported" ? "active" : live.state} /></> : null}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {canProvision && conn?.status === "ok" ? (
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer font-semibold">Import a live agent (changes nothing on live calls)</summary>
              {wfError ? <p className="mt-2 text-bad">{wfError}</p> : null}
              <form action={importAgentAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="orgId" value={orgId} />
                <div><label className="label" htmlFor="ia-name">Agent name</label><input className="input" id="ia-name" name="name" required placeholder="Receptionist" /></div>
                <div>
                  <label className="label" htmlFor="ia-branch">Branch</label>
                  <select className="input" id="ia-branch" name="branchId" defaultValue={bs[0]?.id ?? ""}>
                    <option value="">All branches</option>
                    {bs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="ia-in">Inbound workflow</label>
                  <select className="input" id="ia-in" name="inboundWorkflowId" defaultValue="">
                    <option value="">None</option>
                    {workflows.map((w) => <option key={w.id} value={w.id} disabled={mapped.has(w.id)}>{w.id} · {w.name}{mapped.has(w.id) ? " (imported)" : ""}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="ia-out">Outbound workflow</label>
                  <select className="input" id="ia-out" name="outboundWorkflowId" defaultValue="">
                    <option value="">None</option>
                    {workflows.map((w) => <option key={w.id} value={w.id} disabled={mapped.has(w.id)}>{w.id} · {w.name}{mapped.has(w.id) ? " (imported)" : ""}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="ia-purpose">Purpose</label>
                  <select className="input" id="ia-purpose" name="purpose" defaultValue="receptionist">
                    <option value="receptionist">Receptionist</option><option value="reminders">Reminders</option><option value="outbound_sales">Outbound sales</option><option value="grievance">Grievance desk</option><option value="other">Other</option>
                  </select>
                </div>
                <div><label className="label" htmlFor="ia-domain">Domain (used in lead capture)</label><input className="input" id="ia-domain" name="domain" required defaultValue="clinic" placeholder="dental, skin or hair" /></div>
                <div><SubmitButton pendingText="Importing">Import agent</SubmitButton></div>
              </form>
            </details>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

export async function TelephonySection({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const db = platformDb();
  const accounts = await db.select().from(carrierAccounts).where(eq(carrierAccounts.tenantId, orgId)).orderBy(carrierAccounts.createdAt);
  const nums = await db.select().from(phoneNumbers).where(eq(phoneNumbers.tenantId, orgId)).orderBy(phoneNumbers.e164);
  const bs = await db.select().from(branches).where(eq(branches.tenantId, orgId)).orderBy(branches.name);
  const [conn] = await db.select({ status: voiceConnections.status }).from(voiceConnections).where(eq(voiceConnections.tenantId, orgId));

  return (
    <div id="telephony">
      <Section title="Telephony" sub="The client's own carrier account (KYC in the client's name) and every number, with its series, purpose and AI-calling declaration.">
        <div className="grid gap-5 px-5 py-4">
          <div>
            <div className="eyebrow mb-2">Carrier accounts</div>
            {accounts.length === 0 ? <p className="text-[13px] text-grey">None yet.</p> : null}
            <ul className="grid gap-2">
              {accounts.map((a) => (
                <li key={a.id} className="rounded-lg bg-ivory px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><b>{a.displayName}</b> · <span className="capitalize">{a.provider}</span> · {a.mode.replace(/_/g, " ")}{a.externalAccountId ? ` · ${a.externalAccountId}` : ""}</span>
                    <StatusBadge status={KYC_TONE[a.kycStatus] ?? a.kycStatus} />
                  </div>
                  {canManage ? (
                    <form action={setKyc} className="mt-2 flex flex-wrap gap-1.5">
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="accountId" value={a.id} />
                      <select name="kyc" defaultValue={a.kycStatus} className="input h-[30px] w-auto py-0 text-[12.5px]" aria-label="KYC status">
                        {["not_started", "link_sent", "submitted", "verified", "rejected"].map((k) => <option key={k} value={k}>KYC: {k.replace("_", " ")}</option>)}
                      </select>
                      <input name="ref" defaultValue={a.kycReference ?? ""} placeholder="KYC reference" className="input h-[30px] w-40 text-[12.5px]" aria-label="KYC reference" />
                      <button className="btn btn-ghost btn-sm" type="submit">Update</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="eyebrow mb-2">Numbers</div>
            {nums.length === 0 ? <p className="text-[13px] text-grey">None yet.</p> : null}
            <ul className="grid gap-2">
              {nums.map((n) => (
                <li key={n.id} className="rounded-lg bg-ivory px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><b className="font-mono">{n.e164}</b> · {SERIES_LABEL[n.series]} · {PURPOSE_LABEL[n.purpose]}</span>
                    {n.purpose === "inbound" ? <span className="text-grey">Inbound only</span> : n.a2pDeclaredAt ? <span className="badge badge-ok">Declared {fmtDate(n.a2pDeclaredAt, false)}</span> : <span className="badge badge-bad">Not declared</span>}
                  </div>
                  {canManage && n.purpose !== "inbound" && !n.a2pDeclaredAt ? (
                    <form action={declareA2p} className="mt-2 flex flex-wrap gap-1.5">
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="numberId" value={n.id} />
                      <input name="ref" required minLength={3} placeholder="Declaration reference from carrier" className="input h-[30px] w-64 text-[12.5px]" aria-label="Declaration reference" />
                      <button className="btn btn-ghost btn-sm" type="submit">Record declaration</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          {canManage ? (
            <div className="grid gap-3 md:grid-cols-2">
              <details className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer font-semibold">Add a carrier account</summary>
                <form action={addCarrierAccountAction} className="mt-3 grid gap-3">
                  <input type="hidden" name="orgId" value={orgId} />
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label" htmlFor="ca-p">Provider</label><select className="input" id="ca-p" name="provider"><option value="vobiz">Vobiz</option><option value="exotel">Exotel</option><option value="plivo">Plivo</option><option value="tata">Tata Tele</option><option value="other">Other</option></select></div>
                    <div><label className="label" htmlFor="ca-m">Type</label><select className="input" id="ca-m" name="mode"><option value="managed_subaccount">Sub-account under Diigoo</option><option value="client_account">Client&apos;s own account</option><option value="forwarding">Call forwarding only</option></select></div>
                  </div>
                  <div><label className="label" htmlFor="ca-n">Name</label><input className="input" id="ca-n" name="displayName" required placeholder="Zennara Vobiz sub-account" /></div>
                  <div><label className="label" htmlFor="ca-x">Account id</label><input className="input" id="ca-x" name="externalAccountId" /></div>
                  <div><label className="label" htmlFor="ca-c">API credential (encrypted)</label><input className="input font-mono" id="ca-c" name="credential" type="password" autoComplete="off" /></div>
                  <div><SubmitButton pendingText="Adding">Add account</SubmitButton></div>
                </form>
              </details>
              <details className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer font-semibold">Add a number</summary>
                <form action={addNumberAction} className="mt-3 grid gap-3">
                  <input type="hidden" name="orgId" value={orgId} />
                  <div><label className="label" htmlFor="pn-a">Carrier account</label><select className="input" id="pn-a" name="carrierAccountId" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></div>
                  <div><label className="label" htmlFor="pn-e">Number</label><input className="input font-mono" id="pn-e" name="e164" required placeholder="+91 40 1234 5678" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label" htmlFor="pn-s">Series</label><select className="input" id="pn-s" name="series">{Object.entries(SERIES_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                    <div><label className="label" htmlFor="pn-u">Used for</label><select className="input" id="pn-u" name="purpose">{Object.entries(PURPOSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                  </div>
                  <div><label className="label" htmlFor="pn-b">Branch</label><select className="input" id="pn-b" name="branchId" defaultValue=""><option value="">None</option>{bs.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                  <div><label className="label" htmlFor="pn-l">Label</label><input className="input" id="pn-l" name="label" /></div>
                  <div><SubmitButton pendingText="Adding">Add number</SubmitButton></div>
                </form>
              </details>
            </div>
          ) : null}
          {canManage && conn?.status === "ok" ? (
            <form action={importNumbersAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <button className="btn btn-ghost btn-sm" type="submit">Import this client&apos;s numbers from the voice engine</button>
            </form>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

export async function PlanSection({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const db = platformDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, orgId));
  const catalog = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.sort);
  const now = new Date();
  const cur = billingPeriod(now, sub?.billingDay ?? 1);
  const prev = billingPeriod(new Date(cur.from.getTime() - 86_400_000), sub?.billingDay ?? 1);
  const statements = await withTenant(orgId, async (tx) => {
    const ent = await entitlements(tx, orgId);
    const [{ n } = { n: 1 }] = [{ n: (await tx.select({ id: branches.id }).from(branches)).length }];
    return Promise.all([prev, cur].map(async (p) => statement(ent, await usage(tx, orgId, p.from, p.to), p, n)));
  });
  const paise = (v: number | null | undefined) => (v == null ? "" : String(v / 100));

  // Today's allowance and where this client's records actually live. Both are
  // read from the same places that enforce them, so this page cannot claim a
  // cap the dialer is not applying, or a private server that is not connected.
  const today = await withTenant(orgId, async (tx) => ({
    out: await planGate(tx, orgId, now),
    in: await inboundToday(tx, orgId, now),
  }));
  const [ownDb] = await db.select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, orgId));
  const capped = today.out.outboundPerDay !== null || today.in.perDay !== null;

  return (
    <div id="plan">
      <Section title="Plan and billing terms" sub="What the client is on and how the monthly bill is raised. No payments are taken here yet.">
        <div className="grid gap-5 px-5 py-4">
          {capped || ownDb ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {today.in.perDay !== null ? (
                <Stat label={`Inbound today (${today.in.day})`} value={`${today.in.used} of ${today.in.perDay}`}
                  note={today.in.overBy > 0 ? `${today.in.overBy} over the plan` : "within the plan"} bad={today.in.overBy > 0} />
              ) : null}
              {today.out.outboundPerDay !== null ? (
                <Stat label="Outbound today" value={`${today.out.outboundToday} of ${today.out.outboundPerDay}`}
                  note={today.out.outboundToday >= today.out.outboundPerDay ? "the dialer is holding until midnight IST" : "within the plan"}
                  bad={today.out.outboundToday >= today.out.outboundPerDay} />
              ) : null}
              {sub?.endsOn ? (
                <Stat label={`${today.out.name} plan ends`} value={sub.endsOn}
                  note={sub.endsOn < now.toISOString().slice(0, 10) ? "ended: outbound calls are stopped" : "calls stop the day after"}
                  bad={sub.endsOn < now.toISOString().slice(0, 10)} />
              ) : null}
              {ownDb ? (
                <Stat label="Where their data lives" value={ownDb.status === "ready" ? "Their own server" : `Their own server (${ownDb.status})`}
                  note={`${ownDb.label}: ${ownDb.host}:${ownDb.port}, TLS ${ownDb.sslmode}`} bad={ownDb.status !== "ready"} />
              ) : null}
            </div>
          ) : null}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Period</th><th className="num">Calls</th><th className="num">Minutes</th><th className="num">Fee</th><th className="num">Usage</th><th className="num">Before GST</th></tr></thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.period.label}><td>{s.period.label}{s.period.to > now ? " (so far)" : ""}</td><td className="num">{s.usage.calls}</td><td className="num">{s.usage.minutes}</td><td className="num">{rupees(s.fixedFeePaise)}</td><td className="num">{rupees(s.usagePaise)}</td><td className="num font-semibold">{rupees(s.subtotalPaise)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {canManage ? (
            <form action={saveSubscription} className="grid gap-3 sm:grid-cols-3">
              <input type="hidden" name="orgId" value={orgId} />
              <div><label className="label" htmlFor="s-plan">Plan</label><select className="input" id="s-plan" name="planKey" defaultValue={sub?.planKey ?? "trial"}>{catalog.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></div>
              <div>
                <label className="label" htmlFor="s-model">Billing</label>
                <select className="input" id="s-model" name="billingModel" defaultValue={sub?.billingModel ?? "prepaid"}>
                  <option value="prepaid">Prepaid (monthly plan)</option>
                  <option value="postpaid_invoice">Postpaid: monthly physical tax invoice</option>
                  <option value="contract">Annual contract, billed monthly</option>
                </select>
              </div>
              <div><label className="label" htmlFor="s-day">Billing day</label><input className="input" id="s-day" name="billingDay" type="number" min={1} max={28} defaultValue={sub?.billingDay ?? 1} /></div>
              <div><label className="label" htmlFor="s-fee">Contract fee per month (₹)</label><input className="input" id="s-fee" name="contractFee" inputMode="decimal" defaultValue={paise(sub?.contractFeePaise)} placeholder="Use plan fee" /></div>
              <div><label className="label" htmlFor="s-rate">Contract rate per minute (₹)</label><input className="input" id="s-rate" name="contractRate" inputMode="decimal" defaultValue={paise(sub?.contractRatePaisePerMin)} placeholder="Use plan overage" /></div>
              <div><label className="label" htmlFor="s-min">Committed minutes</label><input className="input" id="s-min" name="committedMinutes" inputMode="numeric" defaultValue={sub?.committedMinutes ?? ""} /></div>
              <div><label className="label" htmlFor="s-po">PO / work order number</label><input className="input" id="s-po" name="poNumber" defaultValue={sub?.poNumber ?? ""} /></div>
              <div><label className="label" htmlFor="s-pov">PO valid until</label><input className="input" id="s-pov" name="poValidUntil" type="date" defaultValue={sub?.poValidUntil ?? ""} /></div>
              <div><label className="label" htmlFor="s-terms">Payment terms (days)</label><input className="input" id="s-terms" name="paymentTermsDays" type="number" min={0} max={180} defaultValue={sub?.paymentTermsDays ?? 30} /></div>
              <div><label className="label" htmlFor="s-to">Invoice to</label><input className="input" id="s-to" name="invoiceToName" defaultValue={sub?.invoiceToName ?? ""} /></div>
              <div><label className="label" htmlFor="s-dept">Department</label><input className="input" id="s-dept" name="invoiceToDepartment" defaultValue={sub?.invoiceToDepartment ?? ""} /></div>
              <div><label className="label" htmlFor="s-gst">GSTIN</label><input className="input uppercase" id="s-gst" name="invoiceToGstin" maxLength={15} defaultValue={sub?.invoiceToGstin ?? ""} /></div>
              <div className="sm:col-span-2"><label className="label" htmlFor="s-addr">Billing address</label><input className="input" id="s-addr" name="invoiceToAddress" defaultValue={sub?.invoiceToAddress ?? ""} /></div>
              <div><label className="label" htmlFor="s-email">Invoice email</label><input className="input" id="s-email" name="invoiceEmail" type="email" defaultValue={sub?.invoiceEmail ?? ""} /></div>
              <div className="sm:col-span-3"><label className="label" htmlFor="s-notes">Notes</label><input className="input" id="s-notes" name="notes" defaultValue={sub?.notes ?? ""} /></div>
              <div><SubmitButton pendingText="Saving">Save terms</SubmitButton></div>
            </form>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value, note, bad }: { label: string; value: string; note: string; bad?: boolean }) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${bad ? "border-[var(--bad-border,#e0b4b4)] bg-[var(--bad-bg,#fdf3f3)]" : "border-[var(--line,#e7e2da)]"}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs opacity-70">{note}</div>
    </div>
  );
}
