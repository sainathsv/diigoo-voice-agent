import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agents, calls, caseCalls, cases, withTenant, type Case } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { complainantNumber } from "./cases/cases";
import { withWhatsApp } from "./complaint-form";
import { SCAM_CATEGORIES, categoryOf, isNotCyberCrime, scamKeyFromText, type ScamCategory, type ScamType } from "./scams";

/** Where the WhatsApp follow-up of a complaint stands. */
export interface WhatsAppProgress {
  caseId: string;
  status: Case["status"];
  /** questions: the form is being asked; form_link: the link was sent; portal: referred to cybercrime.gov.in (money lost more than 15 days ago); none: the caller did not agree. */
  followup: string;
  stillNeeded: number;
  proofs: number;
}

export interface Complaint {
  /** The call it came from; null for a complaint that started on WhatsApp. */
  callId: string | null;
  branchId: string | null;
  at: Date;
  durationS: number | null;
  phone: string | null;
  name: string | null;
  scam: ScamType | null;
  lostRupees: number;
  fraudster: string | null;
  place: string | null;
  summary: string | null;
  urgent: boolean;
  district: string | null;
  whatsapp: WhatsAppProgress | null;
}

export interface CallAnalytics {
  complaints: Complaint[];
  total: number;
  people: number;
  lostRupees: number;
  urgent: number;
  /** The four main categories, always all four, in the department's order. */
  byCategory: Array<{ category: ScamCategory; count: number; lostRupees: number }>;
  byType: Array<{ type: ScamType | null; count: number; lostRupees: number }>;
  byDistrict: Array<{ district: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
}

const text = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s && !/^(null|none|unknown|n\/a)$/i.test(s) ? s : null;
};
/** Rupees from what the analyser wrote: "40000", "₹40,000", "Rs. 40,000", "2 lakh", "1.5 crore". */
export function parseRupees(v: unknown): number {
  const t = String(v ?? "").toLowerCase().replace(/(rs\.?|inr|₹|rupees?)/g, " ");
  const m = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|k\b|thousand)?/);
  if (!m) return 0;
  let n = Number(m[1]!.replace(/,/g, ""));
  const unit = m[2] ?? "";
  if (/^la/.test(unit)) n *= 100_000;
  else if (/^cr/.test(unit)) n *= 10_000_000;
  else if (unit === "k" || unit === "thousand") n *= 1_000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Analytics for a cyber crime helpline: what kind of scam, how many, who
 * complained, where, how much money went. Each call is read together with what
 * the complainant then sent on WhatsApp; a complaint that started on WhatsApp is
 * counted too.
 */
export async function callAnalytics(tenantId: string, days = 30, opts: { branches?: string[] | "all" } = {}): Promise<CallAnalytics> {
  const branches = opts.branches ?? "all";
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: calls })
      .from(calls)
      .innerJoin(agents, eq(agents.id, calls.agentId))
      .where(
        and(
          eq(agents.domain, CYBER_INTAKE_DOMAIN),
          eq(calls.status, "completed"),
          gte(calls.startedAt, since),
          // Staff limited to some branches see only those branches' complaints.
          branches === "all" ? undefined : branches.length ? inArray(calls.branchId, branches) : sql`false`,
        ),
      )
      .orderBy(desc(calls.startedAt))
      .limit(5000),
  );
  const caseRows = await withTenant(tenantId, (tx) =>
    tx
      .select({ k: cases, proofs: sql<number>`(select count(*)::int from case_evidence e where e.tenant_id = ${cases.tenantId} and e.case_id = ${cases.id})` })
      .from(cases)
      .where(and(gte(cases.createdAt, since), branches === "all" ? undefined : branches.length ? inArray(cases.branchId, branches) : sql`false`))
      .limit(5000),
  );
  const progress = (k: Case, proofs: number): WhatsAppProgress => ({ caseId: k.id, status: k.status, followup: k.fields.followup ?? "questions", stillNeeded: k.missing.length, proofs });
  const caseByCall = new Map(caseRows.filter((r) => r.k.firstCallId).map((r) => [r.k.firstCallId!, r]));
  // A later call about the same complaint shows that case's WhatsApp too.
  const caseById = new Map(caseRows.map((r) => [r.k.id, r]));
  const links = await withTenant(tenantId, (tx) => tx.select({ callId: caseCalls.callId, caseId: caseCalls.caseId }).from(caseCalls).where(gte(caseCalls.linkedAt, since)).limit(10_000));
  for (const l of links) {
    const r = caseById.get(l.caseId);
    if (r && !caseByCall.has(l.callId)) caseByCall.set(l.callId, r);
  }

  const toComplaint = (x: Record<string, unknown>, base: { callId: string | null; branchId: string | null; at: Date; durationS: number | null; phone: string | null; summary: string | null }, wa: WhatsAppProgress | null): Complaint => {
    const fraudster = [x.fraudster_mobile, x.fraudster_whatsapp, x.suspect_account_or_upi, x.suspect_social_media, x.suspect_email, x.fraudster_identifiers]
      .map(text)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ");
    const place = [text(x.police_station) && `PS ${text(x.police_station)}`, text(x.district)].filter(Boolean).join(", ") || text(x.present_address);
    return {
      ...base,
      name: text(x.complainant_name) ?? text(x.caller_name),
      scam: text(x.complaint_type) ? scamKeyFromText(String(x.complaint_type)) : null,
      lostRupees: parseRupees(x.money_lost),
      fraudster: fraudster || null,
      place,
      summary: base.summary ?? text(x.how_it_happened),
      urgent: /^(yes|true)$/i.test(String(x.danger ?? "").trim()),
      district: text(x.district),
      whatsapp: wa,
    };
  };

  // A call the analyser judged not to be a cyber crime (a theft, a family matter) is not a complaint.
  const complaints: Complaint[] = rows
    .filter(({ c }) => !isNotCyberCrime(text(c.extracted.complaint_type)))
    .map(({ c }) => {
      const k = caseByCall.get(c.id);
      return toComplaint(
        withWhatsApp(c.extracted, k?.k.fields),
        { callId: c.id, branchId: c.branchId, at: c.startedAt, durationS: c.durationS, phone: c.direction === "inbound" ? c.fromE164 : c.toE164, summary: c.summary },
        k ? progress(k.k, k.proofs) : null,
      );
    });
  // Someone who wrote to the helpline on WhatsApp without calling.
  for (const r of caseRows.filter((r) => !r.k.firstCallId)) {
    const x: Record<string, unknown> = { ...r.k.fields, complaint_type: r.k.fields.complaint_type ?? r.k.scamType ?? undefined };
    complaints.push(toComplaint(withWhatsApp({}, x as Record<string, string>), { callId: null, branchId: r.k.branchId, at: r.k.createdAt, durationS: null, phone: complainantNumber(r.k), summary: null }, progress(r.k, r.proofs)));
  }
  complaints.sort((a, b) => b.at.getTime() - a.at.getTime());

  const byType = new Map<ScamType | null, { count: number; lostRupees: number }>();
  const byDistrict = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const k of complaints) {
    const t = byType.get(k.scam) ?? { count: 0, lostRupees: 0 };
    t.count++;
    t.lostRupees += k.lostRupees;
    byType.set(k.scam, t);
    const d = k.district ?? "Not given";
    byDistrict.set(d, (byDistrict.get(d) ?? 0) + 1);
    const day = k.at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return {
    complaints,
    total: complaints.length,
    people: new Set(complaints.map((c) => c.phone).filter(Boolean)).size,
    lostRupees: complaints.reduce((a, c) => a + c.lostRupees, 0),
    urgent: complaints.filter((c) => c.urgent).length,
    byCategory: SCAM_CATEGORIES.map(({ key }) => {
      const mine = complaints.filter((c) => categoryOf(c.scam) === key);
      return { category: key, count: mine.length, lostRupees: mine.reduce((n, c) => n + c.lostRupees, 0) };
    }),
    byType: [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
    byDistrict: [...byDistrict].map(([district, count]) => ({ district, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    byDay: [...byDay].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
