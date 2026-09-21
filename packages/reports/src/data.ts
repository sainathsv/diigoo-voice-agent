import { and, eq, gte, lte, sql } from "drizzle-orm";
import { agents, calls, leads, organizations, phoneNumbers, platformDb, withTenant } from "@jenai/db";

/**
 * The numbers behind a calls report. Read inside the client's own workspace,
 * so a report can never show another client's calls.
 */

export interface DayRow {
  date: string;
  total: number;
  inbound: number;
  avgSeconds: number;
}
export interface Slice {
  label: string;
  value: number;
}
export interface LongCall {
  when: Date;
  direction: string;
  phone: string;
  seconds: number;
}

export interface CallsSummary {
  org: { id: string; name: string };
  from: Date;
  to: Date;
  totals: {
    calls: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    avgSeconds: number;
    minutes: number;
    recordings: number;
    people: number;
  };
  previous: { calls: number; answered: number; avgSeconds: number; minutes: number };
  byDay: DayRow[];
  byHour: Slice[];
  statuses: Slice[];
  longest: LongCall[];
  leads: Slice[];
  booked: number;
  /** How much of the outcome picture we actually have, and why. */
  coverage: { withTranscript: number; analysed: number; withOutcome: number };
  numbers: Array<{ e164: string; label: string | null; series: string }>;
  agents: Array<{ name: string; live: boolean }>;
}

const mask = (p: string | null) => (p && p.length > 6 ? `${p.slice(0, 3)} ${p.slice(3, 5)}••• •${p.slice(-4)}` : "not recorded");

export async function callsSummary(tenantId: string, from: Date, to: Date): Promise<CallsSummary> {
  const [org] = await platformDb().select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, tenantId));
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);

  return withTenant(tenantId, async (tx) => {
    const inPeriod = and(eq(calls.tenantId, tenantId), gte(calls.startedAt, from), lte(calls.startedAt, to));

    const [t] = await tx
      .select({
        calls: sql<number>`count(*)::int`,
        inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
        outbound: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')::int`,
        answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
        missed: sql<number>`count(*) filter (where ${calls.status} in ('no_answer', 'busy', 'failed'))::int`,
        avgSeconds: sql<number>`coalesce(round(avg(${calls.durationS}) filter (where ${calls.durationS} > 0)), 0)::int`,
        seconds: sql<number>`coalesce(sum(${calls.durationS}), 0)::int`,
        recordings: sql<number>`count(*) filter (where ${calls.recordingRef} is not null)::int`,
        people: sql<number>`count(distinct coalesce(${calls.contactId}::text, case when ${calls.direction} = 'inbound' then ${calls.fromE164} else ${calls.toE164} end))::int`,
        withTranscript: sql<number>`count(*) filter (where ${calls.transcript} is not null)::int`,
        analysed: sql<number>`count(*) filter (where ${calls.analyzedAt} is not null)::int`,
        withOutcome: sql<number>`count(*) filter (where ${calls.extracted} ? 'next_step' or ${calls.extracted} ? 'outcome')::int`,
      })
      .from(calls)
      .where(inPeriod);

    const [p] = await tx
      .select({
        calls: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${calls.status} = 'completed')::int`,
        avgSeconds: sql<number>`coalesce(round(avg(${calls.durationS}) filter (where ${calls.durationS} > 0)), 0)::int`,
        seconds: sql<number>`coalesce(sum(${calls.durationS}), 0)::int`,
      })
      .from(calls)
      .where(and(eq(calls.tenantId, tenantId), gte(calls.startedAt, prevFrom), lte(calls.startedAt, from)));

    const byDay = await tx
      .select({
        date: sql<string>`to_char(${calls.startedAt} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
        total: sql<number>`count(*)::int`,
        inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
        avgSeconds: sql<number>`coalesce(round(avg(${calls.durationS}) filter (where ${calls.durationS} > 0)), 0)::int`,
      })
      .from(calls)
      .where(inPeriod)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const byHour = await tx
      .select({
        label: sql<string>`lpad(extract(hour from ${calls.startedAt} at time zone 'Asia/Kolkata')::text, 2, '0') || ':00'`,
        value: sql<number>`count(*)::int`,
      })
      .from(calls)
      .where(inPeriod)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const statuses = await tx
      .select({ label: sql<string>`${calls.status}::text`, value: sql<number>`count(*)::int` })
      .from(calls)
      .where(inPeriod)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`);

    const longestRows = await tx
      .select({ when: calls.startedAt, direction: calls.direction, from: calls.fromE164, to: calls.toE164, seconds: calls.durationS })
      .from(calls)
      .where(inPeriod)
      .orderBy(sql`${calls.durationS} desc nulls last`)
      .limit(5);

    const leadRows = await tx
      .select({ label: sql<string>`${leads.stage}::text`, value: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), gte(leads.createdAt, from), lte(leads.createdAt, to)))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`);

    const [b] = await tx
      .select({ booked: sql<number>`count(*) filter (where ${calls.extracted}->>'next_step' = 'booked')::int` })
      .from(calls)
      .where(inPeriod);

    const numbers = await tx.select({ e164: phoneNumbers.e164, label: phoneNumbers.label, series: phoneNumbers.series }).from(phoneNumbers).where(eq(phoneNumbers.status, "active"));
    const agentRows = await tx.select({ name: agents.name, live: agents.liveVersionId }).from(agents).where(eq(agents.status, "active"));

    return {
      org: org ?? { id: tenantId, name: "Workspace" },
      from,
      to,
      totals: {
        calls: t!.calls,
        inbound: t!.inbound,
        outbound: t!.outbound,
        answered: t!.answered,
        missed: t!.missed,
        avgSeconds: t!.avgSeconds,
        minutes: Math.round(t!.seconds / 60),
        recordings: t!.recordings,
        people: t!.people,
      },
      previous: { calls: p!.calls, answered: p!.answered, avgSeconds: p!.avgSeconds, minutes: Math.round(p!.seconds / 60) },
      byDay,
      byHour,
      statuses,
      longest: longestRows.map((r) => ({ when: r.when, direction: r.direction, phone: mask(r.direction === "inbound" ? r.from : r.to), seconds: r.seconds ?? 0 })),
      leads: leadRows,
      booked: b!.booked,
      coverage: { withTranscript: t!.withTranscript, analysed: t!.analysed, withOutcome: t!.withOutcome },
      numbers,
      agents: agentRows.map((a) => ({ name: a.name, live: Boolean(a.live) })),
    };
  });
}
