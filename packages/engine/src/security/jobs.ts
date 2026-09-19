import { sql } from "drizzle-orm";
import type { Db, SecurityAlert } from "@jenai/db";
import { raise } from "./detect";

// ---------------------------------------------------------------- audit-log integrity

export interface ChainCheck {
  chain: string;
  events: number;
  head: number;
  firstBadId: number | null;
  problem: string | null;
}

/**
 * Hourly, sized for tens of thousands of workspaces:
 *   1. anchor: one fingerprint over every chain head, printed as one JSON line
 *      so the log shipper keeps it outside the database;
 *   2. verify only the events added since each chain's last checkpoint;
 *   3. walk a rotating 1/168th of chains in full, so every chain is re-read
 *      from its first event once a week.
 * Any break opens a critical alert.
 */
export async function verifyAuditChains(db: Db, log: (line: string) => void = console.log, opts: { fullShard?: boolean } = {}): Promise<ChainCheck[]> {
  const [anchor] = await db.execute<{ id: string; root: string; chains: number; changed: number }>(sql`select id::text, root, chains, changed from lookup.audit_anchor()`);
  log(JSON.stringify({ type: "audit_anchor", at: new Date().toISOString(), id: Number(anchor!.id), root: anchor!.root, chains: anchor!.chains, changed: anchor!.changed }));

  const todo = (await db.execute<{ chain: string }>(sql`select chain from lookup.audit_chains_to_verify(5000)`)).map((r) => ({ chain: r.chain, full: false }));
  if (opts.fullShard !== false) {
    const hourOfWeek = Math.floor(Date.now() / 3_600_000) % 168;
    const shard = await db.execute<{ chain: string }>(sql`select chain from audit_chain_heads where abs(hashtext(chain)) % 168 = ${hourOfWeek}`);
    for (const r of shard) if (!todo.some((t) => t.chain === r.chain)) todo.push({ chain: r.chain, full: true });
  }

  const out: ChainCheck[] = [];
  for (const t of todo) {
    const [v] = await db.execute<{ checked: string; head_seq: string; first_bad_id: string | null; problem: string | null }>(
      sql`select checked::text, head_seq::text, first_bad_id::text, problem from lookup.verify_audit_chain_since(${t.chain}, ${t.full})`,
    );
    const check: ChainCheck = { chain: t.chain, events: Number(v!.checked), head: Number(v!.head_seq), firstBadId: v!.first_bad_id ? Number(v!.first_bad_id) : null, problem: v!.problem };
    out.push(check);
    if (check.problem) {
      await raise(db, {
        rule: "audit.chain_broken",
        severity: "critical",
        title: "The activity log was changed after it was written",
        subject: t.chain === "platform" ? "platform log" : `workspace ${t.chain}`,
        tenantId: t.chain === "platform" || !/^[0-9a-f-]{36}$/.test(t.chain) ? null : t.chain,
        dedupeKey: `audit.chain_broken:${t.chain}`,
        detail: { firstBadEventId: check.firstBadId, problem: check.problem, afterEvent: check.head },
        hits: 1,
        at: new Date(),
      });
    }
  }
  const broken = out.filter((c) => c.problem).length;
  const [{ n } = { n: 0 }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_chain_heads`);
  for (const [name, v] of [["audit_verified_at", Date.now()], ["audit_broken_chains", broken], ["audit_chains", n]] as const) {
    await db.execute(sql`insert into security_detector_state (name, last_id, updated_at) values (${name}, ${v}, now())
      on conflict (name) do update set last_id = excluded.last_id, updated_at = now()`);
  }
  return out;
}

// ---------------------------------------------------------------- retention

/**
 * Sign-in events live in monthly partitions: this adds the coming months and
 * drops months older than `days` (never under 180, the CERT-In minimum).
 * The audit log is never purged.
 */
export async function maintainSecurityEvents(db: Db, days = 365): Promise<string> {
  const [r] = await db.execute<{ security_events_maintain: string }>(sql`select lookup.security_events_maintain(${days})`);
  return r?.security_events_maintain ?? "";
}

// ---------------------------------------------------------------- notifications

export interface Notifier {
  send(a: SecurityAlert): Promise<void>;
}

/** Writes to the worker log. Used when no alert topic is configured. */
export const logNotifier: Notifier = {
  async send(a) {
    console.warn(`[security] ${a.severity.toUpperCase()} ${a.rule}: ${a.title} (${a.subject})`);
  },
};

/** Amazon SNS (email and SMS to the on-call founders). Region defaults to Mumbai. */
export async function snsNotifier(topicArn: string, region = "ap-south-1"): Promise<Notifier> {
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const client = new SNSClient({ region });
  return {
    async send(a) {
      const lines = [
        `${a.title}`,
        ``,
        `Severity: ${a.severity}`,
        `About: ${a.subject}`,
        `Rule: ${a.rule}`,
        `First seen: ${a.firstSeen.toISOString()}`,
        `Details: ${JSON.stringify(a.detail)}`,
        ``,
        `Open the console Security page to acknowledge or resolve it.`,
        `If this is a real incident, the CERT-In 6-hour reporting clock may have started: docs/security/incident-response.md`,
      ];
      await client.send(new PublishCommand({ TopicArn: topicArn, Subject: `[JENAI ${a.severity}] ${a.title}`.slice(0, 99), Message: lines.join("\n") }));
    },
  };
}

/** Sends each open high or critical alert once. */
export async function notifyPending(db: Db, notifier: Notifier): Promise<number> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select * from security_alerts
    where notified_at is null and status = 'open' and severity in ('high', 'critical')
    order by first_seen limit 20`);
  let sent = 0;
  for (const r of rows) {
    const a = {
      id: String(r.id), tenantId: (r.tenant_id as string) ?? null, rule: String(r.rule), severity: r.severity as SecurityAlert["severity"],
      title: String(r.title), subject: String(r.subject), detail: r.detail, dedupeKey: String(r.dedupe_key), status: r.status as SecurityAlert["status"],
      hits: Number(r.hits), firstSeen: new Date(String(r.first_seen)), lastSeen: new Date(String(r.last_seen)), notifiedAt: null,
      handledBy: null, handledAt: null, note: null,
    } satisfies SecurityAlert;
    try {
      await notifier.send(a);
      await db.execute(sql`update security_alerts set notified_at = now() where id = ${a.id}`);
      sent++;
    } catch (e) {
      console.error(`[security] could not send alert ${a.id}: ${(e as Error).message}`);
    }
  }
  return sent;
}
