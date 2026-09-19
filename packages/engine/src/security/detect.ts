import { sql } from "drizzle-orm";
import { privilegedIn } from "@jenai/authz";
import type { AlertSeverity, Db } from "@jenai/db";
import { istHour } from "./time";

/**
 * Security detector (blue team). Runs in the worker every minute against the
 * console pool (BYPASSRLS: it must see every workspace). Each source table has
 * a watermark so every event is judged once; window rules look back over a
 * short period when new events arrive for the same person or address.
 *
 * Rules and thresholds are documented in docs/security/detection-rules.md.
 */

export const THRESHOLDS = {
  accountFailures: { window: "15 minutes", medium: 5, high: 10 },
  sprayIp: { window: "15 minutes", accounts: 5 },
  successAfterFailures: { window: "30 minutes", failures: 5 },
  probing: { window: "10 minutes", denials: 10 },
  twoStepFailures: { window: "15 minutes", codes: 3 },
  massPlays: { window: "10 minutes", plays: 20 },
  massExport: { window: "60 minutes", exports: 3 },
  /** Working hours in India; admin changes and support sessions outside them are flagged. */
  workingHours: { from: 8, to: 21 },
  batch: 5000,
} as const;

/** Actions that change who can do what, or where calls go. */
const ADMIN_ACTIONS = new Set([
  "org.updated", "org.went_live", "plan.updated", "staff.invited", "staff.role_removed",
  "support.approved_by_jenai", "voice.connection_saved", "voice.mode_changed",
  "carrier.account_added", "number.added", "role.created", "role.updated",
  "member.role_added", "member.role_removed", "member.invited",
]);

export interface Candidate {
  rule: string;
  severity: AlertSeverity;
  title: string;
  subject: string;
  tenantId: string | null;
  dedupeKey: string;
  detail: Record<string, unknown>;
  /** Events this tick adds to the alert. */
  hits: number;
  at: Date;
}

type AuditRow = {
  id: number;
  tenant_id: string | null;
  actor_user_id: string | null;
  via: string;
  action: string;
  summary: string;
  diff: Record<string, unknown> | null;
  ip: string | null;
  created_at: Date;
  actor_email: string | null;
  platform_actor: boolean;
};

type EventRow = { id: string; kind: string; email: string | null; user_id: string | null; tenant_id: string | null; ip: string | null; created_at: Date; detail: unknown };

async function watermark(db: Db, name: string): Promise<number> {
  const [r] = await db.execute<{ last_id: string }>(sql`select last_id::text as last_id from security_detector_state where name = ${name}`);
  return r ? Number(r.last_id) : 0;
}

async function setWatermark(db: Db, name: string, id: number) {
  await db.execute(sql`
    insert into security_detector_state (name, last_id, updated_at) values (${name}, ${id}, now())
    on conflict (name) do update set last_id = excluded.last_id, updated_at = now()`);
}

const toDate = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));

// ---------------------------------------------------------------- sign-in and access events

/** Distinct non-empty values, for one grouped query per rule instead of one query per person. */
const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))];

/** How many new events each subject had in this batch, and when the last one was. */
function tally(list: EventRow[], key: (r: EventRow) => string | null) {
  const m = new Map<string, { n: number; last: Date }>();
  for (const r of list) {
    const k = key(r);
    if (!k) continue;
    const e = m.get(k) ?? { n: 0, last: toDate(r.created_at) };
    e.n++;
    e.last = toDate(r.created_at);
    m.set(k, e);
  }
  return m;
}

async function fromSecurityEvents(db: Db): Promise<{ out: Candidate[]; upTo: number | null; n: number }> {
  const since = await watermark(db, "security_events");
  const rows: EventRow[] = await db.execute<EventRow>(sql`
    select id::text, kind::text, email, user_id, tenant_id, ip, created_at, detail
    from security_events where id > ${since} order by id limit ${THRESHOLDS.batch}`);
  if (!rows.length) return { out: [], upTo: null, n: 0 };
  const out: Candidate[] = [];

  // 1. Repeated failures on one account (password guessing).
  const failed = rows.filter((r) => r.kind === "signin_failed" || r.kind === "signin_locked");
  const byEmail = tally(failed, (r) => r.email);
  if (byEmail.size) {
    const agg = await db.execute<{ email: string; fails: number; locked: number; ips: number }>(sql`
      select email, count(*) filter (where kind = 'signin_failed')::int as fails,
             count(*) filter (where kind = 'signin_locked')::int as locked, count(distinct ip)::int as ips
      from security_events
      where email in ${[...byEmail.keys()]} and kind in ('signin_failed', 'signin_locked')
        and created_at > now() - ${THRESHOLDS.accountFailures.window}::interval
      group by email`);
    for (const w of agg) {
      const locked = w.locked > 0;
      if (w.fails < THRESHOLDS.accountFailures.medium && !locked) continue;
      const fresh = byEmail.get(w.email)!;
      out.push({
        rule: "signin.account_guessing",
        severity: locked || w.fails >= THRESHOLDS.accountFailures.high ? "high" : "medium",
        title: locked ? "Account locked after repeated wrong passwords" : "Repeated wrong passwords on one account",
        subject: w.email,
        tenantId: null,
        dedupeKey: `signin.account_guessing:${w.email}`,
        detail: { failuresIn15Min: w.fails, locked, distinctIps: w.ips },
        hits: fresh.n,
        at: fresh.last,
      });
    }
  }

  // 2. One address trying many accounts (password spraying).
  const byIp = tally(rows.filter((r) => r.kind === "signin_failed"), (r) => r.ip);
  if (byIp.size) {
    const agg = await db.execute<{ ip: string; accounts: number; fails: number }>(sql`
      select ip, count(distinct email)::int as accounts, count(*)::int as fails from security_events
      where ip in ${[...byIp.keys()]} and kind = 'signin_failed' and created_at > now() - ${THRESHOLDS.sprayIp.window}::interval
      group by ip`);
    for (const w of agg) {
      if (w.accounts < THRESHOLDS.sprayIp.accounts) continue;
      const fresh = byIp.get(w.ip)!;
      out.push({
        rule: "signin.password_spray",
        severity: "high",
        title: "One address is trying many accounts",
        subject: w.ip,
        tenantId: null,
        dedupeKey: `signin.password_spray:${w.ip}`,
        detail: { accountsIn15Min: w.accounts, failuresIn15Min: w.fails },
        hits: fresh.n,
        at: fresh.last,
      });
    }
  }

  // 3. A successful sign-in right after a run of failures (the guess may have worked).
  const okIds = rows.filter((x) => x.kind === "signin_ok" && x.email).map((x) => Number(x.id));
  if (okIds.length) {
    const agg = await db.execute<{ id: string; email: string; ip: string | null; user_id: string | null; created_at: Date; fails: number }>(sql`
      select s.id::text, s.email, s.ip, s.user_id, s.created_at,
             (select count(*) from security_events f where f.email = s.email and f.kind = 'signin_failed' and f.id < s.id
                and f.created_at > s.created_at - ${THRESHOLDS.successAfterFailures.window}::interval)::int as fails
      from security_events s where s.id in ${okIds} and s.kind = 'signin_ok'`);
    for (const w of agg) {
      if (w.fails < THRESHOLDS.successAfterFailures.failures) continue;
      out.push({
        rule: "signin.success_after_failures",
        severity: "high",
        title: "Signed in after many wrong passwords",
        subject: w.email,
        tenantId: null,
        dedupeKey: `signin.success_after_failures:${w.email}:${w.id}`,
        detail: { failuresBefore: w.fails, ip: w.ip, userId: w.user_id },
        hits: 1,
        at: toDate(w.created_at),
      });
    }
  }

  // 4. Someone repeatedly opening things they may not see (probing for IDs or pages).
  const byUser = tally(rows.filter((r) => r.kind === "access_denied"), (r) => r.user_id);
  if (byUser.size) {
    const agg = await db.execute<{ user_id: string; n: number; tenants: number; email: string | null }>(sql`
      select e.user_id, count(*)::int as n, count(distinct e.tenant_id)::int as tenants, max(u.email) as email
      from security_events e left join "user" u on u.id = e.user_id
      where e.user_id in ${[...byUser.keys()]} and e.kind = 'access_denied' and e.created_at > now() - ${THRESHOLDS.probing.window}::interval
      group by e.user_id`);
    for (const w of agg) {
      if (w.n < THRESHOLDS.probing.denials) continue;
      const fresh = byUser.get(w.user_id)!;
      out.push({
        rule: "access.probing",
        severity: "high",
        title: "Repeated attempts to open records or pages without access",
        subject: w.email ?? w.user_id,
        tenantId: null,
        dedupeKey: `access.probing:${w.user_id}`,
        detail: { deniedIn10Min: w.n, workspaces: w.tenants, userId: w.user_id },
        hits: fresh.n,
        at: fresh.last,
      });
    }
  }

  // 5. Right password, wrong 2-step codes: the password is probably known to someone else.
  const byMfaIp = tally(rows.filter((r) => r.kind === "mfa_failed"), (r) => r.ip);
  if (byMfaIp.size) {
    const agg = await db.execute<{ ip: string; n: number; emails: string | null }>(sql`
      select f.ip, count(*)::int as n,
             (select string_agg(distinct s.email, ', ') from security_events s where s.ip = f.ip and s.kind = 'signin_ok'
                and s.detail->>'twoStep' = 'pending' and s.created_at > now() - ${THRESHOLDS.twoStepFailures.window}::interval) as emails
      from security_events f
      where f.ip in ${[...byMfaIp.keys()]} and f.kind = 'mfa_failed' and f.created_at > now() - ${THRESHOLDS.twoStepFailures.window}::interval
      group by f.ip`);
    for (const w of agg) {
      if (w.n < THRESHOLDS.twoStepFailures.codes) continue;
      const fresh = byMfaIp.get(w.ip)!;
      out.push({
        rule: "signin.two_step_failing",
        severity: "high",
        title: "Right password, but the 2-step code keeps failing",
        subject: w.emails ?? w.ip,
        tenantId: null,
        dedupeKey: `signin.two_step_failing:${w.ip}`,
        detail: { wrongCodesIn15Min: w.n, ip: w.ip, advice: "Reset this person's password" },
        hits: fresh.n,
        at: fresh.last,
      });
    }
  }

  // 6. Two-step sign-in switched off (weakens the account; staff should never do this).
  const off = rows.filter((x) => x.kind === "mfa_disabled" && x.user_id);
  if (off.length) {
    const staff = new Set(
      (
        await db.execute<{ user_id: string }>(sql`
          select distinct m.user_id from memberships m join organizations o on o.id = m.tenant_id
          where m.user_id in ${uniq(off.map((r) => r.user_id))} and o.kind = 'platform' and m.status = 'active'`)
      ).map((r) => r.user_id),
    );
    for (const r of off) {
      const isStaff = staff.has(r.user_id!);
      out.push({
        rule: "signin.two_step_disabled",
        severity: isStaff ? "high" : "medium",
        title: isStaff ? "A Diigoo staff member turned off two-step sign-in" : "Two-step sign-in was turned off",
        subject: r.email ?? r.user_id!,
        tenantId: null,
        dedupeKey: `signin.two_step_disabled:${r.id}`,
        detail: { ip: r.ip, userId: r.user_id },
        hits: 1,
        at: toDate(r.created_at),
      });
    }
  }

  return { out, upTo: Number(rows[rows.length - 1]!.id), n: rows.length };
}

// ---------------------------------------------------------------- audit log

export function judgeAuditEvent(e: AuditRow): Candidate[] {
  const out: Candidate[] = [];
  const at = toDate(e.created_at);
  const hour = istHour(at);
  const offHours = hour < THRESHOLDS.workingHours.from || hour >= THRESHOLDS.workingHours.to;
  const who = e.actor_email ?? e.actor_user_id ?? "system";
  const base = { tenantId: e.tenant_id, hits: 1, at, subject: who };
  const d = e.diff ?? {};

  if (e.action === "support.breakglass" || (e.action === "support.session_started" && d.mode === "breakglass")) {
    out.push({
      ...base,
      rule: "support.breakglass",
      severity: "critical",
      title: e.action === "support.breakglass" ? "Break-glass access was used" : "A break-glass session was opened",
      dedupeKey: `support.breakglass:${e.id}`,
      detail: { auditId: e.id, summary: e.summary, ip: e.ip },
    });
  }

  if (e.action === "support.session_started" && offHours) {
    out.push({
      ...base,
      rule: "support.off_hours",
      severity: "medium",
      title: "Support session opened outside working hours",
      dedupeKey: `support.off_hours:${e.id}`,
      detail: { auditId: e.id, summary: e.summary, istHour: hour, ip: e.ip },
    });
  }

  const privileged = Array.isArray(d.privileged) ? (d.privileged as string[]) : [];
  const added = Array.isArray(d.added) ? (d.added as string[]) : [];
  const grantedPrivileged = ["member.role_added", "member.invited", "staff.invited"].includes(e.action) ? privileged : e.action === "role.updated" ? privilegedIn(added) : [];
  if (grantedPrivileged.length) {
    out.push({
      ...base,
      rule: "roles.privilege_granted",
      severity: e.platform_actor || grantedPrivileged.some((p) => p.startsWith("platform:") || p === "org:transfer_ownership") ? "high" : "medium",
      title: e.action === "role.updated" ? "Admin-level permissions were added to a role" : "Admin-level access was given to someone",
      dedupeKey: `roles.privilege_granted:${e.id}`,
      detail: { auditId: e.id, action: e.action, summary: e.summary, permissions: grantedPrivileged },
    });
  }

  if (e.action === "voice.connection_saved" || e.action === "voice.mode_changed") {
    out.push({
      ...base,
      rule: "voice.connection_changed",
      severity: e.action === "voice.mode_changed" ? "high" : "medium",
      title: e.action === "voice.mode_changed" ? "A client's voice engine was switched to managed mode" : "A client's voice engine credentials were changed",
      dedupeKey: `voice.connection_changed:${e.id}`,
      detail: { auditId: e.id, summary: e.summary },
    });
  }

  if (offHours && e.via !== "system" && ADMIN_ACTIONS.has(e.action)) {
    out.push({
      ...base,
      rule: "admin.off_hours",
      severity: e.action.startsWith("staff.") ? "medium" : "low",
      title: "Admin change outside working hours",
      dedupeKey: `admin.off_hours:${e.id}`,
      detail: { auditId: e.id, action: e.action, summary: e.summary, istHour: hour },
    });
  }
  return out;
}

async function fromAudit(db: Db): Promise<{ out: Candidate[]; upTo: number | null; n: number }> {
  const since = await watermark(db, "audit_events");
  const rows = await db.execute<AuditRow & { id: string }>(sql`
    select a.id::text as id, a.tenant_id, a.actor_user_id, a.via::text as via, a.action, a.summary, a.diff, a.ip, a.created_at,
           u.email as actor_email,
           exists (select 1 from organizations o where o.id = a.tenant_id and o.kind = 'platform') as platform_actor
    from audit_events a left join "user" u on u.id = a.actor_user_id
    where a.id > ${since} order by a.id limit ${THRESHOLDS.batch}`);
  if (!rows.length) return { out: [], upTo: null, n: 0 };
  const out: Candidate[] = rows.flatMap((r) => judgeAuditEvent({ ...r, id: Number(r.id) }));

  // Many recording plays by one person in a short time (bulk listening or scraping).
  const plays = rows.filter((x) => x.action === "call.recording_played" && x.actor_user_id && x.tenant_id);
  if (plays.length) {
    const fresh = new Map<string, { n: number; last: Date; email: string | null }>();
    for (const r of plays) {
      const k = `${r.tenant_id}:${r.actor_user_id}`;
      const e = fresh.get(k) ?? { n: 0, last: toDate(r.created_at), email: r.actor_email };
      e.n++;
      e.last = toDate(r.created_at);
      fresh.set(k, e);
    }
    const agg = await db.execute<{ tenant_id: string; actor_user_id: string; n: number }>(sql`
      select tenant_id, actor_user_id, count(*)::int as n from audit_events
      where actor_user_id in ${uniq(plays.map((r) => r.actor_user_id))} and action = 'call.recording_played'
        and created_at > now() - ${THRESHOLDS.massPlays.window}::interval
      group by tenant_id, actor_user_id`);
    for (const w of agg) {
      const k = `${w.tenant_id}:${w.actor_user_id}`;
      const f = fresh.get(k);
      if (!f || w.n < THRESHOLDS.massPlays.plays) continue;
      out.push({
        rule: "data.mass_recording_plays",
        severity: "high",
        title: "Unusually many call recordings played by one person",
        subject: f.email ?? w.actor_user_id,
        tenantId: w.tenant_id,
        dedupeKey: `data.mass_recording_plays:${k}`,
        detail: { playsIn10Min: w.n, userId: w.actor_user_id },
        hits: f.n,
        at: f.last,
      });
    }
  }

  // Bulk exports (contacts, reports). Fires once export features write "*.exported".
  const exports = rows.filter((x) => x.action.endsWith(".exported") && x.actor_user_id);
  if (exports.length) {
    const fresh = new Map<string, { tenant: string | null; n: number; rows: number; last: Date; email: string | null }>();
    for (const r of exports) {
      const k = r.actor_user_id!;
      const e = fresh.get(k) ?? { tenant: r.tenant_id, n: 0, rows: 0, last: toDate(r.created_at), email: r.actor_email };
      e.n++;
      e.rows += Number((r.diff as { rows?: number } | null)?.rows ?? 0);
      e.last = toDate(r.created_at);
      fresh.set(k, e);
    }
    const agg = await db.execute<{ actor_user_id: string; n: number }>(sql`
      select actor_user_id, count(*)::int as n from audit_events
      where actor_user_id in ${[...fresh.keys()]} and action like '%.exported' and created_at > now() - ${THRESHOLDS.massExport.window}::interval
      group by actor_user_id`);
    for (const w of agg) {
      const f = fresh.get(w.actor_user_id)!;
      if (w.n < THRESHOLDS.massExport.exports && f.rows < 1000) continue;
      out.push({
        rule: "data.mass_export",
        severity: "high",
        title: "Large or repeated data export",
        subject: f.email ?? w.actor_user_id,
        tenantId: f.tenant,
        dedupeKey: `data.mass_export:${w.actor_user_id}`,
        detail: { exportsInHour: w.n, rows: f.rows, userId: w.actor_user_id },
        hits: f.n,
        at: f.last,
      });
    }
  }

  return { out, upTo: Number(rows[rows.length - 1]!.id), n: rows.length };
}

// ---------------------------------------------------------------- alerts

/** Opens a new alert, or adds hits to the live one with the same key. */
export async function raise(db: Db, c: Candidate): Promise<{ id: string; created: boolean }> {
  const [r] = await db.execute<{ id: string; created: boolean }>(sql`
    insert into security_alerts (tenant_id, rule, severity, title, subject, detail, dedupe_key, hits, first_seen, last_seen)
    values (${c.tenantId}, ${c.rule}, ${c.severity}::alert_severity, ${c.title}, ${c.subject}, ${JSON.stringify(c.detail)}::jsonb, ${c.dedupeKey}, ${c.hits}, ${c.at.toISOString()}::timestamptz, ${c.at.toISOString()}::timestamptz)
    on conflict (dedupe_key) where status in ('open', 'acknowledged') do update set
      hits = security_alerts.hits + excluded.hits,
      last_seen = greatest(security_alerts.last_seen, excluded.last_seen),
      severity = greatest(security_alerts.severity, excluded.severity),
      title = case when excluded.severity > security_alerts.severity then excluded.title else security_alerts.title end,
      detail = excluded.detail
    returning id::text as id, (xmax = 0) as created`);
  return r!;
}

export interface DetectResult {
  judged: { securityEvents: number; auditEvents: number };
  raised: Candidate[];
  opened: string[];
}

/**
 * One detector pass. Drains up to `maxBatches` batches per source so a burst
 * (a spraying attack across thousands of workspaces) is caught up within the
 * minute. Alerts are raised before the watermark moves: at-least-once.
 */
export async function detect(db: Db, opts: { maxBatches?: number } = {}): Promise<DetectResult> {
  const maxBatches = opts.maxBatches ?? 20;
  const raised: Candidate[] = [];
  const opened: string[] = [];
  const judged = { securityEvents: 0, auditEvents: 0 };
  for (const [source, run, key] of [
    ["security_events", fromSecurityEvents, "securityEvents"],
    ["audit_events", fromAudit, "auditEvents"],
  ] as const) {
    for (let i = 0; i < maxBatches; i++) {
      const r = await run(db);
      for (const c of r.out) {
        const x = await raise(db, c);
        if (x.created) opened.push(x.id);
      }
      raised.push(...r.out);
      if (r.upTo !== null) await setWatermark(db, source, r.upTo);
      judged[key] += r.n;
      if (r.n < THRESHOLDS.batch) break;
    }
  }
  await setWatermark(db, "detector_heartbeat", Date.now());
  return { judged, raised, opened };
}
