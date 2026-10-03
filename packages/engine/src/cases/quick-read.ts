/**
 * Plain WhatsApp answers, read on the spot without the AI: a PIN code, a date, an amount,
 * a name or a place in English letters, a bank and account number, yes or no, the
 * fraudster's numbers and UPI IDs, "don't know". The AI on this server is asked only when a
 * reply needs understanding (what happened, Hindi script, a sentence, several answers in
 * one), so the form keeps moving at once, even while the AI is busy reading a call or is
 * not running. When no AI can read a reply, `fallbackRead` keeps it as written for the
 * item that was asked.
 */
import { answered, mayBeUnknown } from "./catalog";
import type { ReadResult } from "./cases";

export interface ReplyInput {
  asking: string | null;
  text: string;
  known: Record<string, string>;
}

/** confident: this is what the reply says and no AI is needed; otherwise the AI should read it. */
export interface QuickRead {
  result: ReadResult;
  confident: boolean;
}

const sure = (fields: Record<string, string>, extra: Partial<ReadResult> = {}): QuickRead => ({ result: { ...extra, fields }, confident: true });
const unsure: QuickRead = { result: { fields: {} }, confident: false };

/** Digits typed on a Hindi or Nepali keyboard (०-९) as 0-9. */
const ascii = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
const joinDigits = (s: string) => s.replace(/(\d)[\s-]+(?=\d)/g, "$1");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(" ").filter(Boolean).length;
const DEVANAGARI = /\p{Script=Devanagari}/u;
const LATIN_WORDS = /^[A-Za-z][A-Za-z .'-]*$/;

const SECRET = /\b(otp|cvv|upi ?pin|atm ?pin|m-?pin|password)\b/i;
/** Might be danger: the AI reads these replies, so an officer is alerted when it is real. */
const RISK = /suicide|kill (my|him|her)self|jaan de|maar (du|de|da)|khud ?kushi|aatm ?hatya|आत्महत्या|जान दे|nude|nangi|naked|obscene|morph|blackmail|viral|वायरल|ब्लैकमेल|threat|धमकी/i;
/** Danger beyond doubt, flagged even when no AI could read the reply. */
const DANGER = /suicide|kill (my)?self|khud ?kushi|aatm ?hatya|आत्महत्या|nude|blackmail|ब्लैकमेल/i;
const STOP = /^(stop|unsubscribe|band karo|band kar do|mat bhejo|message mat bhejo|बंद करो|मत भेजो|मैसेज मत भेजो)[\s.!]*$/i;
const UNKNOWN = /^(pata nahi+n?|nahi+n? pata|maloom nahi+n?|malum nahi+n?|nahi+n? maloom|don'?t know|do not know|no idea|not known|unknown|n\/a|पता नहीं|नहीं पता|मालूम नहीं|नहीं मालूम|थाहा छैन|थाहा भएन)[\s.!]*$/i;
/** Words that make a reply a sentence ("mera naam Ramesh hai") rather than the bare answer: the AI reads those. */
const SENTENCE = /\b(mera|meri|mere|naam|nam|hai|hain|hu|hoon|main|mai|my|name|is|am|ji|sir|madam|mam|ka|ki|ke|ko|se|aur|and|the|of|from|pata|nahi|nahin|kya|wala|wali)\b/i;

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_, before: string, c: string) => before + c.toUpperCase())
    .replace(/ (Of|And) /g, (w) => w.toLowerCase());

const BANK_SHORT = new Set(["sbi", "hdfc", "icici", "pnb", "bob", "idbi", "uco", "idfc", "rbl", "kvb", "csb", "dcb", "iob", "ubi", "boi", "au", "jk", "sbm", "ippb"]);
const bankName = (s: string) => titleCase(s).split(" ").map((w) => (BANK_SHORT.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(" ");

function pincode(t: string): QuickRead {
  const groups = joinDigits(ascii(t)).match(/\d+/g) ?? [];
  if (groups.length === 1 && groups[0]!.length === 6) return sure({ pincode: groups[0]! });
  return groups.length ? sure({}) : unsure; // digits that are no PIN code: asked again with the hint
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dateOfBirth(t: string): QuickRead {
  const s = squash(ascii(t).toLowerCase());
  let [y, m, d] = [0, 0, 0];
  let r = /^(\d{1,2})[\s/.-]+(\d{1,2})[\s/.-]+(\d{4})$/.exec(s);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{4})[\s/.-]+(\d{1,2})[\s/.-]+(\d{1,2})$/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)?[\s,-]*([a-z]{3,9})[\s,-]*(\d{4})$/.exec(s)) && MONTHS.includes(r[2]!.slice(0, 3))) [d, m, y] = [Number(r[1]), MONTHS.indexOf(r[2]!.slice(0, 3)) + 1, Number(r[3])];
  else return unsure;
  const real = m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  return real ? sure({ date_of_birth: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` }) : sure({});
}

function amount(t: string): QuickRead {
  const s = squash(ascii(t).toLowerCase())
    .replace(/^(rs\.?|inr|₹)\s*/, "")
    .replace(/\s*(\/-|rs\.?|rupees?|rupaye|rupay|rupiya|₹)$/, "");
  let r = /^(\d[\d,]*(?:\.\d{1,2})?)$/.exec(s);
  if (r) {
    const n = Number(r[1]!.replace(/,/g, ""));
    return n > 0 ? sure({ money_lost: String(Math.round(n)) }) : sure({});
  }
  r = /^(\d+(?:\.\d+)?)\s*(k|thousand|hazaa?r|lakhs?|lacs?)$/.exec(s);
  if (r) return sure({ money_lost: String(Math.round(Number(r[1]) * (/^(k|thousand|hazaa?r)$/.test(r[2]!) ? 1_000 : 100_000))) });
  return unsure;
}

/** The complainant's own mobile number, asked when WhatsApp hides it: kept as +91 and 10 digits. */
function mobile(t: string): QuickRead {
  const d = joinDigits(ascii(t)).replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  if (/^[6-9]\d{9}$/.test(ten)) return sure({ mobile_number: `+91${ten}` });
  return d.length ? sure({}) : unsure; // digits that are no mobile number: asked again with the hint
}

function card(t: string): QuickRead {
  const d = ascii(t).replace(/\D/g, "");
  if (d.length === 4) return sure({ card_last4: d });
  if (d.length >= 12 && d.length <= 19) return sure({ card_last4: d.slice(-4) }); // a whole card number: only the last 4 are kept
  return d.length ? sure({}) : unsure;
}

function personName(t: string, key: "complainant_name" | "father_or_husband_name"): QuickRead {
  let s = squash(t);
  let prefix = "";
  if (key === "father_or_husband_name") {
    const r = /^(f|father|pita|h|husband|pati|s\/o|d\/o|w\/o)(?:\s*[:.-]\s*|\s+)(.+)$/i.exec(s);
    if (r) {
      prefix = /^(h|husband|pati|w\/o)$/i.test(r[1]!) ? "H: " : "F: ";
      s = r[2]!;
    }
  }
  if (!LATIN_WORDS.test(s) || s.length > 60 || words(s) > 5 || SENTENCE.test(s)) return unsure;
  return sure({ [key]: prefix + titleCase(s) });
}

function place(t: string, key: "district" | "police_station"): QuickRead {
  const s = squash(t.replace(/\b(district|distt?|jila|zila|janpad|thana|police station|p\.?s)(?=$|[\s.,])\.?/gi, " "));
  if (!s || !LATIN_WORDS.test(s) || s.length > 40 || words(s) > 4 || SENTENCE.test(s)) return unsure;
  return sure({ [key]: titleCase(s) });
}

function house(t: string): QuickRead {
  const s = squash(t).replace(/^(house\s*(number|no\.?)|h\.?\s*no\.?|makaa?n\s*(number|no\.?|nambar)?|ghar\s*(number|no\.?)?)\s*[:.-]?\s*/i, "");
  if (!s || s.length > 30 || !/\d/.test(ascii(s)) || DEVANAGARI.test(s.replace(/[०-९]/g, "")) || SENTENCE.test(s)) return unsure;
  return sure({ house_number: ascii(s) });
}

function address(t: string): QuickRead {
  const s = squash(t);
  if (s.length < 8 || s.length > 300 || DEVANAGARI.test(s) || !/[A-Za-z]{3,}/.test(s) || /\b(mera|meri|naam|address|pata|hai|my)\b/i.test(s)) return unsure;
  return sure({ present_address: s });
}

/** "SBI 30012345678", or the bank and the number in two messages (the second completes the first). */
function bank(t: string, known: string | undefined): QuickRead {
  if (DEVANAGARI.test(t.replace(/[०-९]/g, ""))) return unsure;
  const s = joinDigits(ascii(t));
  const acct = /(?<!\d)\d{9,18}(?!\d)/.exec(s)?.[0] ?? null;
  const rest = squash(
    s
      .replace(/\d+/g, " ")
      .replace(/\b(account|acct|acc|a\/c|ac|no|number|num|khata|sankhya|saving|savings|current)\b\.?/gi, " ")
      .replace(/[^A-Za-z ]/g, " "),
  );
  if (!acct && !rest) return /\d/.test(s) ? sure({}) : unsure; // digits that are no account number: asked again
  if (rest && (words(rest) > 4 || /\b(mera|meri|mere|naam|hai|hain|main|mai|my|is|se|kata|kate|gaya|gaye)\b/i.test(rest))) return unsure;
  const name = rest ? bankName(rest) : null;
  const had = known?.trim() ?? "";
  const hadBank = had && !/\d/.test(had) ? had : null;
  const hadAcct = /^\d{9,18}$/.test(had) ? had : null;
  if (name && acct) return sure({ victim_bank_and_account: `${name}; ${acct}` });
  if (name && hadAcct) return sure({ victim_bank_and_account: `${name}; ${hadAcct}` });
  if (acct && hadBank) return sure({ victim_bank_and_account: `${hadBank}; ${acct}` });
  // Half an answer is kept; the hint then asks for the other half.
  return sure({ victim_bank_and_account: (name ?? acct)! });
}

const NO = /^(no|nahi+n?|nai|nope|na|never|नहीं|नही|ना|होइन|छैन)(?=$|[\s.,!])/i;
const YES = /^(yes|haa?n?|ji haa?n|हाँ|हां|हा|हो)(?=$|[\s.,!:-])[\s.,!:-]*(.*)$/i;
function apk(t: string): QuickRead {
  const s = squash(t);
  if (NO.test(s)) return sure({ apk_or_link: "no" });
  const r = YES.exec(s);
  return r ? sure({ apk_or_link: r[2] ? `yes: ${r[2].slice(0, 200)}` : "yes" }) : unsure;
}

const PHONE = /(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/g;
/** The fraudster's numbers, UPI IDs, accounts, emails and profile links, each under its own line of the form. */
function fraudster(t: string): QuickRead {
  const out: Record<string, string> = {};
  const add = (k: string, v: string) => {
    const have = out[k] ? out[k]!.split("; ") : [];
    if (!have.includes(v)) out[k] = [...have, v].join("; ");
  };
  let rest = ascii(t);
  for (const e of rest.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
    add("suspect_email", e.toLowerCase());
    rest = rest.replace(e, " ");
  }
  for (const u of rest.match(/https?:\/\/\S+|\b(?:www\.)?(?:instagram\.com|facebook\.com|fb\.com|t\.me|telegram\.me|x\.com|twitter\.com|wa\.me)\/\S+/gi) ?? []) {
    add("suspect_social_media", u);
    rest = rest.replace(u, " ");
  }
  for (const u of rest.match(/[\w.-]{2,}@[a-z][a-z0-9]+/gi) ?? []) {
    add("suspect_account_or_upi", u);
    rest = rest.replace(u, " ");
  }
  const digits = joinDigits(rest);
  const onWhatsApp = /whats\s?app|व्हाट्सएप/i.test(t);
  for (const p of digits.match(PHONE) ?? []) {
    add("fraudster_mobile", p.slice(-10));
    if (onWhatsApp) add("fraudster_whatsapp", p.slice(-10));
  }
  for (const a of digits.replace(PHONE, " ").match(/(?<!\d)\d{9,18}(?!\d)/g) ?? []) add("suspect_account_or_upi", a);
  return Object.keys(out).length ? sure(out) : unsure;
}

/** Reads a reply without the AI when it is a plain answer to what was asked. */
export function quickRead(input: ReplyInput): QuickRead {
  const t = input.text.trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return sure({}); // "??" or an emoji: the question is asked again
  if (STOP.test(t)) return sure({}, { stop: true });
  if (SECRET.test(t) || RISK.test(t) || t.length > 300) return unsure;
  const k = input.asking;
  if (UNKNOWN.test(t)) return k === "fraudster_details" ? sure({ fraudster_details: "not known" }) : k && mayBeUnknown(k) ? sure({ [k]: "not known" }) : sure({});
  switch (k) {
    case "mobile_number":
      return mobile(t);
    case "pincode":
      return pincode(t);
    case "date_of_birth":
      return dateOfBirth(t);
    case "money_lost":
      return amount(t);
    case "card_last4":
      return card(t);
    case "complainant_name":
    case "father_or_husband_name":
      return personName(t, k);
    case "district":
    case "police_station":
      return place(t, k);
    case "house_number":
      return house(t);
    case "present_address":
      return address(t);
    case "victim_bank_and_account":
      return bank(t, input.known.victim_bank_and_account);
    case "apk_or_link":
      return apk(t);
    case "fraudster_details":
      return fraudster(t);
    default:
      return unsure;
  }
}

/** Items a reply can answer as written, when no AI could read it (officers read it as the complainant wrote it). */
const AS_WRITTEN = new Set(["mobile_number", "complainant_name", "father_or_husband_name", "date_of_birth", "house_number", "present_address", "police_station", "district", "victim_bank_and_account", "transactions", "how_it_happened"]);

/** The reply kept as written for the item asked, when it fits that item; otherwise nothing (the item is asked again). */
export function fallbackRead(input: ReplyInput): ReadResult {
  const t = squash(input.text).slice(0, 600);
  const danger = DANGER.test(t);
  const k = input.asking;
  if (!k || !AS_WRITTEN.has(k) || SECRET.test(t) || !answered(k, { [k]: t })) return { fields: {}, danger };
  return { fields: { [k]: t }, danger };
}
