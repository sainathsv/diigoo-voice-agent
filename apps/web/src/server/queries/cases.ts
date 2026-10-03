import "server-only";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { branchesFor, type AccessContext } from "@jenai/authz";
import { calls, caseEvidence, caseMessages, cases, memberships, user, whatsappChannels, whatsappInbox, withTenant, type WhatsappChannel } from "@jenai/db";
import { INBOX_MAX_ATTEMPTS, caseNo, complainantNumber, openWaFor, scamLabel, withWhatsApp, type OpenWaSession } from "@jenai/engine";

const STATUSES = new Set(["collecting", "ready", "taken_up", "closed"]);

export async function loadCases(tenantId: string, access: AccessContext, f: { status?: string; type?: string; q?: string }) {
  const b = branchesFor(access, "calls:view");
  if (b !== "all" && !b.length) return { rows: [], counts: {} as Record<string, number> };
  return withTenant(tenantId, async (tx) => {
    const conds: SQL[] = [];
    if (b !== "all") conds.push(inArray(cases.branchId, b));
    const scope = conds.length ? and(...conds) : undefined;
    if (f.status && STATUSES.has(f.status)) conds.push(eq(cases.status, f.status as never));
    if (f.type && /^[a-z_]{2,40}$/.test(f.type)) conds.push(eq(cases.scamType, f.type));
    const q = (f.q ?? "").trim().slice(0, 60);
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "")}%`;
      conds.push(sql`(${cases.complainantE164} ilike ${like} or ${cases.fields}->>'complainant_name' ilike ${like} or ${cases.fields}->>'fraudster_details' ilike ${like} or ${cases.district} ilike ${like})`);
    }
    const rows = await tx
      .select({ c: cases, proofs: sql<number>`(select count(*)::int from case_evidence e where e.tenant_id = ${cases.tenantId} and e.case_id = ${cases.id})` })
      .from(cases)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(sql`case ${cases.status} when 'ready' then 0 when 'collecting' then 1 when 'taken_up' then 2 else 3 end`, desc(cases.updatedAt))
      .limit(300);
    const counts = await tx.select({ s: cases.status, n: sql<number>`count(*)::int` }).from(cases).where(scope).groupBy(cases.status);
    const withNo = await Promise.all(rows.map(async (r) => ({ ...r, no: await caseNo(tx, tenantId, r.c) })));
    return { rows: withNo, counts: Object.fromEntries(counts.map((c) => [c.s, c.n])) as Record<string, number> };
  });
}

export async function loadCase(tenantId: string, id: string) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, id));
    if (!c) return null;
    const evidence = await tx
      .select({ id: caseEvidence.id, kind: caseEvidence.kind, mime: caseEvidence.mime, filename: caseEvidence.filename, caption: caseEvidence.caption, sizeBytes: caseEvidence.sizeBytes, sha256: caseEvidence.sha256, receivedAt: caseEvidence.receivedAt })
      .from(caseEvidence)
      .where(eq(caseEvidence.caseId, id))
      .orderBy(asc(caseEvidence.receivedAt));
    const messages = await tx.select().from(caseMessages).where(eq(caseMessages.caseId, id)).orderBy(asc(caseMessages.at));
    const relatedCalls = await tx
      .select({ id: calls.id, startedAt: calls.startedAt, durationS: calls.durationS, summary: calls.summary })
      .from(calls)
      .where(sql`${calls.fromE164} = ${complainantNumber(c) ?? c.complainantE164} or ${calls.toE164} = ${complainantNumber(c) ?? c.complainantE164}`)
      .orderBy(desc(calls.startedAt))
      .limit(20);
    const team = await tx
      .select({ id: memberships.id, name: user.name })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.status, "active"));
    // The form as officers read it: the first call's answers with what was written on WhatsApp on top.
    const [first] = c.firstCallId ? await tx.select({ extracted: calls.extracted, summary: calls.summary }).from(calls).where(eq(calls.id, c.firstCallId)) : [];
    const merged = withWhatsApp(first?.extracted ?? { complaint_type: c.fields.complaint_type ?? (c.scamType ? scamLabel(c.scamType) : undefined) }, c.fields);
    return { c, no: await caseNo(tx, tenantId, c), evidence, messages, relatedCalls, team, merged, callSummary: first?.summary ?? null };
  });
}

/** The channel without its sealed credentials. */
function safe(ch: WhatsappChannel) {
  return { ...ch, credentials: ch.credentials ? "set" : null };
}

/**
 * The WhatsApp number and, for OpenWA, what the gateway says right now: linked,
 * waiting for its QR code to be scanned (with the code), or disconnected.
 */
export async function loadWhatsappLink(tenantId: string) {
  const [ch] = await withTenant(tenantId, (tx) => tx.select().from(whatsappChannels).where(eq(whatsappChannels.tenantId, tenantId)).limit(1));
  const [q] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        waiting: sql<number>`count(*) filter (where ${whatsappInbox.processedAt} is null)::int`,
        stuck: sql<number>`count(*) filter (where ${whatsappInbox.processedAt} is null and ${whatsappInbox.attempts} >= ${INBOX_MAX_ATTEMPTS})::int`,
        retrying: sql<number>`count(*) filter (where ${whatsappInbox.processedAt} is null and ${whatsappInbox.attempts} between 1 and ${INBOX_MAX_ATTEMPTS - 1})::int`,
        // Why the newest unread message could not be read, in the reader's words.
        lastError: sql<string | null>`(array_agg(${whatsappInbox.lastError} order by ${whatsappInbox.receivedAt} desc) filter (where ${whatsappInbox.processedAt} is null and ${whatsappInbox.lastError} is not null))[1]`,
      })
      .from(whatsappInbox),
  );
  const queue = { waiting: q?.waiting ?? 0, stuck: q?.stuck ?? 0, retrying: q?.retrying ?? 0, lastError: q?.lastError ?? null };
  // Replies WhatsApp did not take in the last day (the worker sends them again by itself).
  const [o] = await withTenant(tenantId, (tx) =>
    tx
      .select({ failed: sql<number>`count(*)::int`, lastError: sql<string | null>`(array_agg(${caseMessages.error} order by ${caseMessages.at} desc))[1]` })
      .from(caseMessages)
      .where(and(eq(caseMessages.direction, "out"), eq(caseMessages.status, "failed"), sql`${caseMessages.at} > now() - interval '1 day'`)),
  );
  const outbox = { failed: o?.failed ?? 0, lastError: o?.lastError ?? null };
  if (!ch) return { channel: null, live: null as OpenWaSession | null, qr: null as string | null, error: null as string | null, queue, outbox };
  const gw = openWaFor(ch);
  if (!gw) return { channel: safe(ch), live: null, qr: null, error: null, queue, outbox };
  try {
    const live = await gw.session();
    const qr = live.status === "qr_ready" ? await gw.qr().catch(() => null) : null;
    return { channel: safe(ch), live, qr, error: null, queue, outbox };
  } catch (e) {
    return { channel: safe(ch), live: null, qr: null, error: (e as Error).message.slice(0, 300), queue, outbox };
  }
}
