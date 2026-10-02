import { scamKeyFromText, scamLabel } from "./scams";

/**
 * The department's complaint format, line for line, filled from what the call
 * captured. Used for the per-call download and the all-complaints export.
 * Labels are the department's own wording (Hindi), with English alongside.
 */
export interface FormLine {
  hi: string;
  en: string;
  value: (x: Record<string, unknown>, ctx: LineContext) => string;
}

export interface LineContext {
  /** The number that actually called (caller ID), when the viewer may see it. */
  phone: string | null;
  /** Masks a phone number for viewers without contacts:reveal_phone. Identity when allowed. */
  mask: (phone: string) => string;
}

const digitsOf = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);

/**
 * The complainant's number is the caller ID: the telephone network reports it,
 * so it cannot be misheard. A different number the caller said is theirs is
 * added, unless it is one they gave for the fraudster.
 */
function complainantNumber(x: Record<string, unknown>, c: LineContext): string {
  const said = s(x.complainant_mobile);
  const fraud = new Set([x.fraudster_mobile, x.fraudster_whatsapp].map(digitsOf).filter((d) => d.length >= 8));
  const other = said && digitsOf(said).length >= 8 && digitsOf(said) !== digitsOf(c.phone) && !fraud.has(digitsOf(said)) ? said : "";
  const main = c.phone ? c.mask(c.phone) : "";
  if (main && other) return `${main} (also gave ${c.mask(other)})`;
  return main || (other ? c.mask(other) : "");
}

const s = (v: unknown): string => {
  const t = v === null || v === undefined ? "" : String(v).trim();
  return /^(null|none|unknown|n\/a)$/i.test(t) ? "" : t;
};
const join = (...v: unknown[]) => v.map(s).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("; ");
const yesNo = (v: unknown) => {
  const t = s(v).toLowerCase();
  if (!t) return "";
  if (t.startsWith("no")) return "नहीं / No";
  return `हाँ / Yes${t.startsWith("yes:") ? ` (${s(v).slice(4).trim()})` : ""}`;
};

export const COMPLAINT_FORM: FormLine[] = [
  { hi: "आपका मोबाइल नंबर", en: "Mobile number", value: (x, c) => complainantNumber(x, c) },
  { hi: "आपका नाम", en: "Name", value: (x) => s(x.complainant_name) || s(x.caller_name) },
  { hi: "पिता/पति का नाम", en: "Father's / husband's name", value: (x) => s(x.father_or_husband_name) },
  { hi: "जन्म तिथि", en: "Date of birth", value: (x) => s(x.date_of_birth) },
  { hi: "मकान न0", en: "House number", value: (x) => s(x.house_number) },
  { hi: "वर्तमान पता जहाँ आप रह रहे हैं", en: "Present address", value: (x) => s(x.present_address) },
  { hi: "आपका पुलिस स्टेशन", en: "Police station", value: (x) => s(x.police_station) },
  { hi: "जनपद", en: "District", value: (x) => s(x.district) },
  { hi: "पिनकोड", en: "PIN code", value: (x) => s(x.pincode) },
  { hi: "अपना बैंक नाम व खाता संख्या जिससे पैसे कटे हैं", en: "Bank and account the money left from", value: (x) => s(x.victim_bank_and_account) },
  { hi: "आपका कार्ड नं. (यदि क्रेडिट कार्ड से फ्रॉड हुआ है तो)", en: "Card (last 4 digits only)", value: (x) => (s(x.card_last4) ? `XXXX XXXX XXXX ${s(x.card_last4).replace(/\D/g, "").slice(-4)}` : "") },
  { hi: "ट्रांजेक्शन (UPI/UTR नंबर)", en: "Transactions (UPI / UTR numbers)", value: (x) => s(x.transactions) },
  { hi: "कुल राशि जो कटी", en: "Total amount lost (₹)", value: (x) => s(x.money_lost) },
  { hi: "फ्रॉड किस प्रकार हुआ", en: "How the fraud happened", value: (x) => join(x.how_it_happened, x.type_details) },
  { hi: "फ्रॉड का मोबाइल नं.", en: "Fraudster's mobile", value: (x) => s(x.fraudster_mobile) },
  { hi: "फ्रॉड का व्हट्सएप नं.", en: "Fraudster's WhatsApp", value: (x) => s(x.fraudster_whatsapp) },
  { hi: "संदिग्ध बैंक खाता/UPI जिसमें पैसे गए हैं", en: "Suspect bank account / UPI", value: (x) => s(x.suspect_account_or_upi) },
  { hi: "संदिग्ध सोशल मीडिया अकाउंट URL", en: "Suspect social media account", value: (x) => s(x.suspect_social_media) },
  { hi: "संदिग्ध ईमेल आईडी", en: "Suspect email ID", value: (x) => s(x.suspect_email) },
  { hi: "यदि कोई APK फ़ाइल/लिंक है (हाँ/नहीं)", en: "APK file or link (yes / no)", value: (x) => yesNo(x.apk_or_link) },
];

export interface ComplaintCall {
  id: string;
  startedAt: Date;
  durationS: number | null;
  phone: string | null;
  extracted: Record<string, unknown>;
  summary: string | null;
  /** Where the WhatsApp follow-up stands, for the export (e.g. "complete", "3 still needed"). */
  whatsapp?: string;
  /** Proof files the complainant sent on WhatsApp. */
  proofs?: number;
  /** Per-row masking (e.g. in an export where the viewer may see some branches' numbers only). */
  mask?: (phone: string) => string;
}

/** Keys a case keeps for itself; they are not lines of the form. */
const CASE_ONLY = new Set(["followup", "whatsapp_consent", "financial", "fraudster_details"]);

/**
 * The complaint as the department sees it: what the call took, overlaid with what the
 * complainant wrote on WhatsApp. Typed answers are never misheard, so they win; "not known"
 * only fills a line the call left empty.
 */
export function withWhatsApp(extracted: Record<string, unknown>, caseFields?: Record<string, string> | null): Record<string, unknown> {
  if (!caseFields) return extracted;
  const out: Record<string, unknown> = { ...extracted };
  for (const [k, v] of Object.entries(caseFields)) {
    if (CASE_ONLY.has(k) || !s(v)) continue;
    if (k === "urgent") {
      if (v === "yes") out.danger = "yes";
      continue;
    }
    if (/^not known$/i.test(v)) {
      if (!s(out[k])) out[k] = "Not known";
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function complaintHeader(c: ComplaintCall) {
  const x = c.extracted;
  const scam = s(x.complaint_type) ? scamKeyFromText(String(x.complaint_type)) : null;
  return {
    scam: scam ? scamLabel(scam) : "",
    when: s(x.happened_when),
    urgent: /^(yes|true)$/i.test(s(x.danger)),
    alreadyReported: s(x.already_reported),
    reference: s(x.reference_given),
    missing: s(x.fields_missing),
  };
}

export interface LineOptions {
  /** Pass a masking function when the viewer lacks contacts:reveal_phone. */
  mask?: (phone: string) => string;
}

export function complaintLines(c: ComplaintCall, o: LineOptions = {}): Array<{ hi: string; en: string; value: string }> {
  const ctx: LineContext = { phone: c.phone, mask: o.mask ?? c.mask ?? ((p) => p) };
  return COMPLAINT_FORM.map((f) => ({ hi: f.hi, en: f.en, value: f.value(c.extracted, ctx) }));
}

const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Written as ="..." so a spreadsheet keeps it as text: no 9.16E+11, no lost digits, no formula. */
const asText = (v: string) => quote(`="${v.replace(/"/g, '""')}"`);

/**
 * One spreadsheet cell. Long numbers (phones, accounts, UTRs) stay exactly as written, and a
 * value that starts like a formula (= + - @, which a caller can influence) is never run as one.
 */
export function csvCell(v: string): string {
  if (/^\+?\d[\d ]{9,}$/.test(v.trim())) return asText(v);
  if (/^[=+\-@\t\r]/.test(v)) return v.length <= 250 ? asText(v) : quote(`'${v}`);
  return quote(v);
}

/** All complaints as CSV. The byte-order mark makes Excel read the Hindi correctly. */
export function complaintsCsv(calls: ComplaintCall[], fmtDate: (d: Date) => string, o: LineOptions = {}): string {
  const head = ["Call time", "Call length (s)", "Type of scam", "When it happened", "Urgent", ...COMPLAINT_FORM.map((f) => `${f.hi} / ${f.en}`), "WhatsApp", "Proof files", "Call summary", "Call id"];
  const rows = calls.map((c) => {
    const h = complaintHeader(c);
    return [fmtDate(c.startedAt), String(c.durationS ?? ""), h.scam, h.when, h.urgent ? "yes" : "", ...complaintLines(c, o).map((l) => l.value), c.whatsapp ?? "", String(c.proofs ?? 0), c.summary ?? "", c.id];
  });
  return "﻿" + [head, ...rows].map((r) => r.map((v) => csvCell(v ?? "")).join(",")).join("\r\n") + "\r\n";
}
