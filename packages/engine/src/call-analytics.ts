import { and, desc, eq, gte } from "drizzle-orm";
import { agents, calls, withTenant } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { scamKeyFromText, type ScamType } from "./scams";

export interface Complaint {
  callId: string;
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
}

export interface CallAnalytics {
  complaints: Complaint[];
  total: number;
  people: number;
  lostRupees: number;
  urgent: number;
  byType: Array<{ type: ScamType | null; count: number; lostRupees: number }>;
  byDistrict: Array<{ district: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
}

const text = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s && !/^(null|none|unknown|n\/a)$/i.test(s) ? s : null;
};
const rupees = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Analytics for a cyber crime helpline, straight from its calls: what kind of
 * scam, how many, who complained, where, how much money went. Uses what the
 * call analyser pulled out of each transcript.
 */
export async function callAnalytics(tenantId: string, days = 30): Promise<CallAnalytics> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: calls })
      .from(calls)
      .innerJoin(agents, eq(agents.id, calls.agentId))
      .where(and(eq(agents.domain, CYBER_INTAKE_DOMAIN), eq(calls.status, "completed"), gte(calls.startedAt, since)))
      .orderBy(desc(calls.startedAt))
      .limit(5000),
  );
  const complaints: Complaint[] = rows.map(({ c }) => {
    const x = c.extracted;
    const fraudster = [x.fraudster_mobile, x.fraudster_whatsapp, x.suspect_account_or_upi, x.suspect_social_media, x.suspect_email, x.fraudster_identifiers]
      .map(text)
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ");
    const place = [text(x.police_station) && `PS ${text(x.police_station)}`, text(x.district)].filter(Boolean).join(", ") || text(x.present_address);
    return {
      callId: c.id,
      at: c.startedAt,
      durationS: c.durationS,
      phone: c.direction === "inbound" ? c.fromE164 : c.toE164,
      name: text(x.complainant_name) ?? text(x.caller_name),
      scam: text(x.complaint_type) ? scamKeyFromText(String(x.complaint_type)) : null,
      lostRupees: rupees(x.money_lost),
      fraudster: fraudster || null,
      place,
      summary: c.summary ?? text(x.how_it_happened),
      urgent: text(x.danger) === "yes",
    };
  });

  const byType = new Map<ScamType | null, { count: number; lostRupees: number }>();
  const byDistrict = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const k of complaints) {
    const t = byType.get(k.scam) ?? { count: 0, lostRupees: 0 };
    t.count++;
    t.lostRupees += k.lostRupees;
    byType.set(k.scam, t);
    const src = rows.find((r) => r.c.id === k.callId)!.c.extracted;
    const d = text(src.district) ?? "Not given";
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
    byType: [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
    byDistrict: [...byDistrict].map(([district, count]) => ({ district, count })).sort((a, b) => b.count - a.count).slice(0, 15),
    byDay: [...byDay].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
