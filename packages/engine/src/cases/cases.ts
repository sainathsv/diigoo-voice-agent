import { createHash } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, audit, calls, caseCalls, caseEvidence, caseMessages, cases, organizations, withTenant, type Case, type Tx, type WhatsappChannel } from "@jenai/db";
import { CYBER_INTAKE_DOMAIN, toE164 } from "@jenai/voice";
import { SCAM_TYPES, categoryOf, isNotCyberCrime, scamKeyFromText } from "../scams";
import { isOnOwnNetwork } from "../own-network";
import {
  FIELD_LABELS,
  FRAUDSTER_KEYS,
  callAgainText,
  caseNumber,
  completeText,
  dangerText,
  formLinkText,
  hintFor,
  isFinancial,
  joinedText,
  missingFor,
  openerText,
  questionFor,
  receivedProofText,
  reminderText,
} from "./catalog";
import { fallbackRead, quickRead } from "./quick-read";
import { isLidAddress, whatsappFor, type InboundMessage, type WhatsAppSender } from "./whatsapp";

function one<T>(rows: T[]): T {
  if (!rows[0]) throw new Error("Case row vanished mid-update");
  return rows[0];
}

/** Case numbers read like CY-2026-000123: the workspace's short code, the year, a running number. */
export async function caseNo(tx: Tx, tenantId: string, c: Pick<Case, "seq" | "createdAt">): Promise<string> {
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, tenantId));
  const prefix = (org?.slug.split("-")[0] ?? "CASE").toUpperCase().slice(0, 6);
  return caseNumber(prefix, c.createdAt, c.seq);
}

async function departmentName(tx: Tx, tenantId: string): Promise<string> {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, tenantId));
  return org?.name ?? "Cyber Police";
}

function langKey(v: unknown): string | null {
  const s = String(v ?? "").toLowerCase();
  if (/nepal/.test(s) || s === "ne") return "ne";
  if (/english/.test(s) || s === "en") return "en";
  if (/hindi/.test(s) || s === "hi") return "hi";
  return s ? s.slice(0, 20) : null;
}

function rupeesToPaise(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Form keys the call program fills, copied onto the case as they are (the keys are the department's form). */
const CALL_KEYS = [
  "complainant_name",
  "father_or_husband_name",
  "date_of_birth",
  "house_number",
  "present_address",
  "police_station",
  "district",
  "pincode",
  "victim_bank_and_account",
  "card_last4",
  "transactions",
  "money_lost",
  "happened_when",
  "how_it_happened",
  "fraudster_mobile",
  "fraudster_whatsapp",
  "suspect_account_or_upi",
  "suspect_social_media",
  "suspect_email",
  "apk_or_link",
  "type_details",
  "complaint_type",
] as const;
const clean = (v: unknown) => {
  const t = v === null || v === undefined ? "" : String(v).trim();
  return /^(null|none|unknown|n\/a)$/i.test(t) ? "" : t;
};

/** What the call analyser found, under the form's keys. Empty values are dropped; a card keeps only its last 4 digits. */
export function fieldsFromCall(x: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CALL_KEYS) {
    const v = k === "complainant_name" ? clean(x.complainant_name) || clean(x.caller_name) : k === "how_it_happened" ? clean(x.how_it_happened) || clean(x.summary) : clean(x[k]);
    const kept = k === "card_last4" ? v.replace(/\D/g, "").slice(-4) : v;
    if (kept) out[k] = kept;
  }
  return out;
}

/**
 * The caller said they have no WhatsApp at all. The call tells callers WhatsApp is coming
 * rather than asking, so anything else (yes, a WhatsApp number, not discussed) gets it.
 */
const noWhatsApp = (x: Record<string, unknown>) => /^(no|nahi|nahin|nahi hai|chhaina|false)\b/i.test(clean(x.whatsapp_consent));

async function evidenceCount(tx: Tx, caseId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(caseEvidence).where(eq(caseEvidence.caseId, caseId));
  return r?.n ?? 0;
}

/**
 * Recomputes what is missing and hands the case to officers ("ready") when WhatsApp
 * has nothing left to collect, or is not collecting at all (the caller has no WhatsApp).
 */
async function settle(tx: Tx, tenantId: string, c: Case): Promise<Case> {
  const missing = missingFor(c.fields, c.scamType, await evidenceCount(tx, c.id));
  const ready = c.status === "collecting" && (missing.length === 0 || c.fields.followup === "none");
  const [u] = await tx
    .update(cases)
    .set({
      missing,
      status: ready ? "ready" : c.status,
      readyAt: ready ? new Date() : c.readyAt,
      amountLostPaise: rupeesToPaise(c.fields.money_lost) ?? c.amountLostPaise,
      district: c.fields.district ?? c.district,
      updatedAt: new Date(),
    })
    .where(eq(cases.id, c.id))
    .returning();
  if (ready) {
    const no = await caseNo(tx, tenantId, c);
    await audit(tx, {
      tenantId,
      actorUserId: null,
      via: "system",
      action: "case.ready",
      targetType: "case",
      targetId: c.id,
      summary: missing.length ? `Case ${no} handed to officers without a WhatsApp follow-up (the caller has no WhatsApp)` : `Case ${no} has everything WhatsApp collects; handed to officers`,
    });
  }
  return u!;
}

async function newCase(tx: Tx, tenantId: string, input: { phone: string; contactId?: string | null; callId?: string | null; branchId?: string | null; fields?: Record<string, string>; scamType?: string | null; language?: string | null }): Promise<Case> {
  // One running number per workspace; the advisory lock keeps two calls ending together from sharing one.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cases:${tenantId}`}))`);
  const [m] = await tx.select({ n: sql<number>`coalesce(max(${cases.seq}), 0)::int` }).from(cases);
  const [c] = await tx
    .insert(cases)
    .values({
      tenantId,
      seq: (m?.n ?? 0) + 1,
      branchId: input.branchId ?? null,
      complainantE164: input.phone,
      contactId: input.contactId ?? null,
      firstCallId: input.callId ?? null,
      scamType: input.scamType ?? null,
      fields: input.fields ?? {},
      missing: [],
      language: input.language ?? null,
    })
    .returning();
  await audit(tx, { tenantId, actorUserId: null, via: "system", action: "case.opened", targetType: "case", targetId: c!.id, summary: `Case ${await caseNo(tx, tenantId, c!)} opened ${input.callId ? "from a call" : "on WhatsApp"}` });
  return c!;
}

/**
 * The complainant's case still being worked on, if any; one still being filled in on WhatsApp
 * comes first. A hidden-number chat ("lid:…") also finds the complaint it was joined to.
 */
async function openCaseFor(tx: Tx, address: string): Promise<Case | null> {
  const who = isLidAddress(address) ? or(eq(cases.complainantE164, address), sql`${cases.fields}->>'whatsapp_lid' = ${address}`) : eq(cases.complainantE164, address);
  const [c] = await tx
    .select()
    .from(cases)
    .where(and(who, inArray(cases.status, ["collecting", "ready", "taken_up"])))
    .orderBy(sql`(${cases.status} = 'collecting') desc`, desc(cases.updatedAt))
    .limit(1);
  return c ?? null;
}

/** The case a call already opened or added to, when the call is read a second time. */
async function caseOfCall(tx: Tx, callId: string): Promise<Case | null> {
  const [link] = await tx.select({ caseId: caseCalls.caseId }).from(caseCalls).where(eq(caseCalls.callId, callId)).limit(1);
  const [c] = link ? await tx.select().from(cases).where(eq(cases.id, link.caseId)) : await tx.select().from(cases).where(eq(cases.firstCallId, callId)).limit(1);
  return c ?? null;
}

/**
 * A call continues the complainant's case while it is still being filled in and is about
 * the same kind of complaint (money fraud, social media, frozen account); a different kind
 * is a new complaint with its own case. A type not known yet on either side continues.
 */
function continues(open: Case, scam: string | null): boolean {
  if (open.status !== "collecting") return false;
  const kind = (s: string | null) => (s && s !== "other" ? categoryOf(s) : null);
  const [was, now] = [kind(open.scamType), kind(scam)];
  return !was || !now || was === now;
}

async function record(tx: Tx, tenantId: string, caseId: string, m: { direction: "in" | "out"; body?: string | null; evidenceId?: string | null; externalId?: string | null; status?: string; error?: string | null }) {
  await tx
    .insert(caseMessages)
    .values({ tenantId, caseId, direction: m.direction, body: m.body ?? null, evidenceId: m.evidenceId ?? null, externalId: m.externalId ?? null, status: m.status ?? "sent", error: m.error ?? null })
    .onConflictDoNothing();
}

/** Where the complainant's WhatsApp chat is: their hidden-number chat once one was joined, else their number. */
const chatOf = (c: Case) => c.fields.whatsapp_lid ?? c.complainantE164;

/** The complainant's number to show and call; for a hidden-number chat, the number they gave (or null). */
export function complainantNumber(c: Pick<Case, "complainantE164" | "fields">): string | null {
  return isLidAddress(c.complainantE164) ? (toE164(c.fields.mobile_number ?? "") ?? null) : c.complainantE164;
}

async function send(tx: Tx, tenantId: string, c: Case, sender: WhatsAppSender, body: string, asking?: string | null, at = new Date()) {
  try {
    const r = await sender.sendText(chatOf(c), body);
    await record(tx, tenantId, c.id, { direction: "out", body, externalId: r.id, status: sender.mode === "simulated" ? "simulated" : "sent" });
  } catch (e) {
    await record(tx, tenantId, c.id, { direction: "out", body, status: "failed", error: (e as Error).message.slice(0, 300) });
  }
  await tx.update(cases).set({ lastOutboundAt: at, ...(asking !== undefined ? { asking } : {}), updatedAt: new Date() }).where(eq(cases.id, c.id));
}

type Wa = { channel: WhatsappChannel; sender: WhatsAppSender };

/** A complaint without money lost gets the cyber team's own form, once. */
async function sendFormLink(tx: Tx, tenantId: string, c: Case, wa: Wa) {
  const url = wa.channel.formUrl;
  if (url) await send(tx, tenantId, c, wa.sender, formLinkText(await departmentName(tx, tenantId), await caseNo(tx, tenantId, c), url, c.language), "__form__");
  else await record(tx, tenantId, c.id, { direction: "out", body: "(the complaint form link is not set up)", status: "failed", error: "Add the cyber team's form link on the WhatsApp page" });
  await tx.update(cases).set({ fields: { ...c.fields, followup: "form_link" }, ...(url ? {} : { asking: "__form__" }) }).where(eq(cases.id, c.id));
}

/** Asks for the next missing item; when there is none, sends the form link (no money lost) or closes the loop. */
async function askNext(tx: Tx, tenantId: string, c: Case, wa: Wa, prefix?: string) {
  const next = c.missing[0];
  if (!next) {
    if (c.asking === "__form__" || c.asking === "__done__") return;
    if (c.scamType && !isFinancial(c.fields, c.scamType)) return sendFormLink(tx, tenantId, c, wa);
    if (c.status === "ready") await send(tx, tenantId, c, wa.sender, [prefix, completeText(await caseNo(tx, tenantId, c), c.language)].filter(Boolean).join("\n\n"), "__done__");
    return;
  }
  await send(tx, tenantId, c, wa.sender, [prefix, questionFor(next, c.language)].filter(Boolean).join("\n\n"), next);
}

async function markUrgent(tx: Tx, c: Case, extracted: Record<string, unknown>): Promise<Case> {
  if (!clean(extracted.danger).toLowerCase().startsWith("yes") || c.fields.urgent === "yes") return c;
  return one(await tx.update(cases).set({ fields: { ...c.fields, urgent: "yes" } }).where(eq(cases.id, c.id)).returning());
}

/**
 * After a cyber crime call: open the complainant's case, or add to the one still being
 * filled in on WhatsApp. Unless the caller said they have no WhatsApp, WhatsApp follows:
 * for a money fraud the rest of the department's form, one question at a time (what the
 * call already took is not asked again); otherwise the cyber team's form link. A caller
 * who called again about the case in progress is picked up where WhatsApp left off.
 *
 * A call is read twice: first with what the voice engine took on the call (as soon as it
 * ends), then by the local AI. Only the first reading messages; the second fills in what
 * is new. `message: false` (a call read long after it happened) only fills in the case.
 */
export async function caseFromCall(
  tx: Tx,
  tenantId: string,
  call: { id: string; phone: string | null; contactId: string | null; branchId: string | null; extracted: Record<string, unknown> },
  sender?: WhatsAppSender,
  opts: { message?: boolean } = {},
): Promise<Case | null> {
  // One reading of a call at a time, so the engine's and the AI's readings never both message.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`call:${call.id}`}))`);
  const incoming = fieldsFromCall(call.extracted);
  const scam = scamKeyFromText(clean(call.extracted.complaint_type)) ?? null;
  const language = langKey(call.extracted.call_language);
  const known = await caseOfCall(tx, call.id);
  if (known) {
    // Read again: what is new fills the gaps; what the case already holds stays.
    const c = one(await tx.update(cases).set({ fields: { ...incoming, ...known.fields }, scamType: known.scamType ?? scam, language: known.language ?? language, updatedAt: new Date() }).where(eq(cases.id, known.id)).returning());
    return settle(tx, tenantId, await markUrgent(tx, c, call.extracted));
  }

  // The follow-up goes to the WhatsApp number the caller gave, else to the number that called.
  const whatsapp = toE164(clean(call.extracted.whatsapp_number));
  const phone = whatsapp && whatsapp.replace(/\D/g, "").length >= 10 ? whatsapp : call.phone;
  if (!phone) return null;
  if (scam === null && !incoming.how_it_happened && !FRAUDSTER_KEYS.some((k) => incoming[k])) return null; // nothing to open a case on
  const wantsWhatsApp = !noWhatsApp(call.extracted);
  const money = isFinancial(incoming, scam);
  const followup = !wantsWhatsApp ? "none" : scam && !money ? "form_link" : "questions";
  const open = await openCaseFor(tx, phone);
  const was = open && continues(open, scam) ? open : null;
  const fresh = !was;
  let c: Case;
  if (!was) {
    // The case holds what the call took (name, mobile, what happened, anything more the caller said);
    // WhatsApp asks only what is still missing.
    const fields: Record<string, string> = { ...incoming, followup };
    if (wantsWhatsApp) fields.whatsapp_consent = "yes";
    if (money) fields.financial = "yes";
    if (phone !== call.phone && call.phone) fields.caller_number = call.phone;
    c = await newCase(tx, tenantId, { phone, contactId: call.contactId, callId: call.id, branchId: call.branchId, fields, scamType: scam, language });
  } else {
    // A call about the case in progress adds what is new; what the complainant already wrote stays.
    const fields = { ...incoming, ...was.fields };
    if (was.fields.followup === "none" && wantsWhatsApp) Object.assign(fields, { followup, whatsapp_consent: "yes" });
    if (money) fields.financial = "yes";
    c = one(
      await tx
        .update(cases)
        .set({ fields, scamType: was.scamType ?? scam, language: was.language ?? language, firstCallId: was.firstCallId ?? call.id, contactId: was.contactId ?? call.contactId, updatedAt: new Date() })
        .where(eq(cases.id, was.id))
        .returning(),
    );
  }
  await tx.insert(caseCalls).values({ tenantId, callId: call.id, caseId: c.id }).onConflictDoNothing();
  c = await settle(tx, tenantId, await markUrgent(tx, c, call.extracted));
  if (c.fields.followup === "none" || opts.message === false) return c;

  const wa = await whatsappFor(tx, tenantId, sender);
  if (!wa) return c;
  if (c.fields.followup === "form_link") {
    if (c.asking !== "__form__") await sendFormLink(tx, tenantId, c, wa);
    return c;
  }
  const [department, no] = [await departmentName(tx, tenantId), await caseNo(tx, tenantId, c)];
  await askNext(tx, tenantId, c, wa, fresh ? openerText(department, no, c.language) : callAgainText(department, no, c.language));
  return c;
}

/** A call this recent is followed on WhatsApp; one read later than this (a backlog, a re-read) only fills in its case. */
export const FOLLOWUP_WINDOW_MS = 24 * 3_600_000;

/**
 * Right after calls are copied from the voice engine: what the engine took on the call
 * (name, number, what happened, money lost, WhatsApp) opens the case and starts WhatsApp
 * within a minute of the call ending, instead of after the local AI has read the whole call
 * (several minutes on a server without a graphics card). The AI's reading later fills in
 * the case without messaging again. Returns the number of calls handled.
 */
export async function followUpCalls(tenantId: string, opts: { sender?: WhatsAppSender; now?: Date; withinMs?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const due = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: calls })
      .from(calls)
      .innerJoin(agents, eq(agents.id, calls.agentId))
      .leftJoin(caseCalls, and(eq(caseCalls.tenantId, calls.tenantId), eq(caseCalls.callId, calls.id)))
      .where(
        and(
          eq(agents.domain, CYBER_INTAKE_DOMAIN),
          eq(calls.status, "completed"),
          isNull(calls.analyzedAt),
          isNull(caseCalls.callId),
          gte(calls.startedAt, new Date(now.getTime() - (opts.withinMs ?? 2 * 3_600_000))),
          // The engine's own reading of the call is in: it says what kind of complaint this was.
          sql`coalesce(${calls.extracted}->>'complaint_type', '') <> ''`,
        ),
      )
      .orderBy(desc(calls.startedAt))
      .limit(50),
  );
  let handled = 0;
  for (const { c } of due) {
    if (isNotCyberCrime(String(c.extracted.complaint_type ?? ""))) continue;
    const k = await withTenant(tenantId, (tx) =>
      caseFromCall(tx, tenantId, { id: c.id, phone: c.direction === "inbound" ? c.fromE164 : c.toE164, contactId: c.contactId, branchId: c.branchId, extracted: c.extracted }, opts.sender),
    );
    if (k) handled++;
  }
  return handled;
}

// ------------------------------------------------------------------ reading replies

export const readSchema = z.object({
  language: z.string().max(20).nullable().optional(),
  fields: z.record(z.string(), z.string().max(600)).default({}),
  scam_type: z.string().max(60).nullable().optional(),
  danger: z.boolean().nullable().optional(),
  stop: z.boolean().nullable().optional(),
});
export type ReadResult = z.infer<typeof readSchema>;

/** Reads one WhatsApp reply. The model extracts; code decides what to ask next. */
export interface CaseReader {
  read(input: { asking: string | null; text: string; known: Record<string, string> }): Promise<ReadResult>;
}

/** The form's lines a reply can answer, with how each value must be written. */
const READ_FIELDS: Record<string, string> = {
  mobile_number: "the complainant's own 10-digit mobile number, digits only",
  how_it_happened: "how the fraud happened, 1 to 3 sentences in English",
  complainant_name: "the complainant's own full name, in English letters exactly as written",
  father_or_husband_name: "father's or husband's name in English letters, prefixed 'F: ' or 'H: ' when they say which",
  date_of_birth: "date of birth as YYYY-MM-DD",
  house_number: "house number as written",
  present_address: "present address in English letters",
  police_station: "police station (thana) name",
  district: "district (janpad / jilla) name",
  pincode: "6 digit PIN code, digits only",
  victim_bank_and_account: "the complainant's bank and the account number the money left from, as 'Bank; account number'",
  card_last4: "ONLY the last 4 digits of the card, never more",
  transactions: "each transaction as 'amount | date | UTR or UPI reference', joined by '; '",
  money_lost: "total amount lost in rupees, digits only",
  fraudster_mobile: "the fraudster's mobile number(s), digits, joined by '; '",
  fraudster_whatsapp: "the fraudster's WhatsApp number(s), digits, joined by '; '",
  suspect_account_or_upi: "UPI IDs and bank accounts the money went to, joined by '; '",
  suspect_social_media: "suspect social media profile URLs or usernames, with the platform",
  suspect_email: "suspect email IDs",
  apk_or_link: "'yes: <app or link name>' or 'no'",
};

export function readPrompt(input: { asking: string | null; text: string; known: Record<string, string> }): string {
  return `You read one WhatsApp reply from a citizen completing a cyber crime complaint with the police in India. They may write in Hindi, English, Nepali, Hinglish or another language.
We had just asked for: ${input.asking ? `${input.asking} (${FIELD_LABELS[input.asking] ?? input.asking})` : "nothing specific"}.
Already known: ${JSON.stringify(input.known).slice(0, 1500)}

Return ONLY a JSON object:
{"language": "hi"|"en"|"ne"|other ISO code (the language of THIS reply),
 "fields": {only the keys below that THIS reply clearly answers},
 "scam_type": one of ${SCAM_TYPES.map((s) => s.key).join(", ")} if this reply makes the type clear, else null,
 "danger": true only if they mention self-harm, blackmail with intimate images, a child at risk or threats of violence, else false,
 "stop": true only if they clearly ask to stop receiving messages, else false}
Keys for "fields", and how to write each value (ENGLISH, numbers as digits):
${Object.entries(READ_FIELDS).map(([k, how]) => `  ${k}: ${how}`).join("\n")}
If they clearly say they do not know or do not have what we asked for, return that key with the value "not known" (for the fraudster's details use the key "fraudster_details").
Never invent a value. If the reply does not answer, return "fields": {}. Never include OTPs, PINs, CVVs or passwords, even if they wrote one.

REPLY:
${input.text.slice(0, 3000)}`;
}

/** Reads replies with a model on the client's own server (Ollama, vLLM: any OpenAI-compatible API). */
export class LocalCaseReader implements CaseReader {
  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | null = null,
    private readonly timeoutMs = 180_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async read(input: { asking: string | null; text: string; known: Record<string, string> }): Promise<ReadResult> {
    const r = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: readPrompt(input) }], temperature: 0, max_tokens: 600, response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };
    if (!r.ok) throw new Error(`Local model refused (${r.status}): ${typeof j.error === "string" ? j.error : (j.error?.message ?? "no detail")}`);
    return parseRead(j.choices?.[0]?.message?.content ?? "");
  }
}

export interface ReaderHooks {
  /** Wraps every AI read: the worker uses it to put WhatsApp replies ahead of reading calls. */
  aiTurn?: <T>(read: () => Promise<T>) => Promise<T>;
  /** Told when the AI could not read a reply and the plain reading was used instead. */
  onAiError?: (e: Error) => void;
}

/**
 * Reads a WhatsApp reply: plain answers on the spot (quickRead), the rest with the AI. When
 * the AI cannot be had (busy too long, stopped, out of memory) the reply is kept as written
 * for the item asked, or that item is asked again, so a complainant is never left waiting.
 */
export class ResilientReader implements CaseReader {
  constructor(
    readonly ai: CaseReader | null,
    private readonly hooks: ReaderHooks = {},
  ) {}
  async read(input: { asking: string | null; text: string; known: Record<string, string> }): Promise<ReadResult> {
    const quick = quickRead(input);
    if (quick.confident) return quick.result;
    const ai = this.ai;
    if (ai) {
      try {
        return await (this.hooks.aiTurn ? this.hooks.aiTurn(() => ai.read(input)) : ai.read(input));
      } catch (e) {
        this.hooks.onAiError?.(e as Error);
      }
    }
    return fallbackRead(input);
  }
}

/**
 * The reply reader this server is configured for: plain answers without the AI, the rest
 * with the same model as the call analyser (JENAI_ANALYZER_PROVIDER=local and its base URL,
 * else Bedrock). The police edition reads replies only with a model on its own network, and
 * a police server without its own AI still reads the plain answers.
 */
export function caseReaderFromEnv(env: Record<string, string | undefined> = process.env, hooks: ReaderHooks = {}): ResilientReader {
  return new ResilientReader(aiReaderFromEnv(env), hooks);
}

function aiReaderFromEnv(env: Record<string, string | undefined>): CaseReader | null {
  const police = env.JENAI_EDITION === "police";
  const provider = (env.JENAI_ANALYZER_PROVIDER ?? (police ? "local" : "bedrock")).toLowerCase();
  if (provider === "local" || provider === "openai") {
    const baseUrl = env.JENAI_ANALYZER_BASE_URL;
    const model = env.JENAI_ANALYZER_MODEL;
    if (!baseUrl || !model) {
      if (police && !env.JENAI_ANALYZER_PROVIDER) return null; // this server has no AI of its own
      throw new Error("JENAI_ANALYZER_PROVIDER=local needs JENAI_ANALYZER_BASE_URL and JENAI_ANALYZER_MODEL");
    }
    if (police && !isOnOwnNetwork(baseUrl)) throw new Error("The police edition keeps WhatsApp replies on its own network: JENAI_ANALYZER_BASE_URL must be this server or a private address");
    // A reply is short; one the AI cannot read in time is kept as written rather than left waiting.
    return new LocalCaseReader(model, baseUrl, env.JENAI_ANALYZER_API_KEY ?? null, Number(env.JENAI_READER_TIMEOUT_MS ?? 180_000));
  }
  if (police) throw new Error("The police edition keeps WhatsApp replies on this server: use JENAI_ANALYZER_PROVIDER=local");
  return new BedrockCaseReader();
}

export class BedrockCaseReader implements CaseReader {
  private readonly client: BedrockRuntimeClient;
  constructor(readonly model = process.env.JENAI_ANALYZER_MODEL ?? "deepseek.v3.2", region = process.env.JENAI_ANALYZER_REGION ?? "ap-south-1") {
    this.client = new BedrockRuntimeClient({ region });
  }
  async read(input: { asking: string | null; text: string; known: Record<string, string> }): Promise<ReadResult> {
    const r = await this.client.send(
      new ConverseCommand({ modelId: this.model, messages: [{ role: "user", content: [{ text: readPrompt(input) }] }], inferenceConfig: { maxTokens: 600, temperature: 0 } }),
    );
    const raw = (r.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
    return parseRead(raw);
  }
}

export function parseRead(raw: string): ReadResult {
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const r = readSchema.safeParse(obj);
    if (!r.success) return { fields: {} };
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.data.fields)) {
      let val = v.trim();
      if (k === "fraudster_details") {
        if (/^not known$/i.test(val)) fields[k] = "not known";
        continue;
      }
      if (!(k in READ_FIELDS) || !val) continue;
      // A model echoing a secret must never land in the case file; a card keeps only its last 4 digits.
      if (/\b(otp|cvv|upi pin|atm pin|password)\b/i.test(val)) continue;
      if (k === "card_last4" && !/^not known$/i.test(val)) val = val.replace(/\D/g, "").slice(-4);
      if (val) fields[k] = val;
    }
    return { ...r.data, fields };
  } catch {
    return { fields: {} };
  }
}

/** Handles one inbound WhatsApp message for this workspace. Idempotent on the message id. */
export async function handleInbound(tenantId: string, msg: InboundMessage, reader: CaseReader, sender?: WhatsAppSender): Promise<{ caseId: string; ready: boolean } | null> {
  return withTenant(tenantId, async (tx) => {
    const [seen] = await tx.select({ id: caseMessages.id }).from(caseMessages).where(eq(caseMessages.externalId, msg.id)).limit(1);
    if (seen) return null;
    const wa = await whatsappFor(tx, tenantId, sender);
    if (!wa) return null;

    // Writing to the helpline is consent: someone who said no on the call, or never called, is answered here.
    // Someone whose number WhatsApp hides is asked for it first.
    let c = await openCaseFor(tx, msg.from);
    if (!c) {
      const fields: Record<string, string> = { followup: "questions", whatsapp_consent: "wrote first" };
      if (isLidAddress(msg.from)) fields.number_hidden = "yes";
      if (msg.name) fields.whatsapp_name = msg.name;
      c = await settle(tx, tenantId, await newCase(tx, tenantId, { phone: msg.from, fields }));
    }
    else if (c.fields.followup === "none")
      c = one(await tx.update(cases).set({ fields: { ...c.fields, followup: "questions", whatsapp_consent: "wrote first" }, status: "collecting" }).where(eq(cases.id, c.id)).returning());

    let evidenceId: string | null = null;
    if (msg.media) {
      try {
        // Small files arrive inside the webhook; larger ones are fetched from the gateway.
        const m = msg.media.inline ?? (await wa.sender.fetchMedia(msg.media.id));
        const [ev] = await tx
          .insert(caseEvidence)
          .values({
            tenantId,
            caseId: c.id,
            kind: msg.media.kind,
            mime: m.mime,
            filename: msg.media.filename ?? null,
            caption: msg.media.caption ?? null,
            bytes: m.bytes,
            sizeBytes: m.bytes.length,
            sha256: createHash("sha256").update(m.bytes).digest("hex"),
            externalId: msg.media.id,
          })
          .onConflictDoNothing()
          .returning({ id: caseEvidence.id });
        evidenceId = ev?.id ?? null;
      } catch (e) {
        await record(tx, tenantId, c.id, { direction: "in", body: `[${msg.media.kind} could not be downloaded: ${(e as Error).message.slice(0, 120)}]`, status: "failed" });
      }
    }
    await record(tx, tenantId, c.id, { direction: "in", body: msg.text ?? (msg.media ? `[${msg.media.kind}]` : null), evidenceId, externalId: msg.id, status: "received" });
    c = one(await tx.update(cases).set({ lastInboundAt: msg.at, remindersSent: 0, updatedAt: new Date() }).where(eq(cases.id, c.id)).returning());

    let prefix: string | undefined;
    const asked = c!.asking;
    if (msg.text?.trim()) {
      const r = await reader.read({ asking: asked, text: msg.text, known: c!.fields });
      const fields = { ...c!.fields, ...r.fields };
      const scam = c!.scamType ?? (r.scam_type && SCAM_TYPES.some((s) => s.key === r.scam_type) ? r.scam_type : null) ?? (c!.asking === "scam_type" ? scamKeyFromText(msg.text) : null);
      if (r.danger) fields.urgent = "yes";
      c = one(await tx
        .update(cases)
        .set({ fields, scamType: scam, language: r.language ? langKey(r.language) : c!.language, remindersSent: r.stop ? 99 : 0 })
        .where(eq(cases.id, c!.id))
        .returning());
      if (r.danger) prefix = dangerText(c!.language);
      if (r.stop) return { caseId: c!.id, ready: false };
    }
    if (evidenceId) prefix = [prefix, receivedProofText(c!.language)].filter(Boolean).join("\n\n");
    c = await settle(tx, tenantId, c!);
    // A hidden-number chat whose mobile number has a complaint open (from a call, say) continues that complaint.
    const given = c.fields.number_hidden === "yes" && isLidAddress(c.complainantE164) ? toE164(c.fields.mobile_number ?? "") : null;
    const target = given ? await openCaseFor(tx, given) : null;
    if (target && target.id !== c.id) {
      c = await settle(tx, tenantId, await joinInto(tx, tenantId, c, target));
      const no = await caseNo(tx, tenantId, c);
      const found = [prefix, joinedText(no, c.language)].filter(Boolean).join("\n\n");
      if (c.missing.length || (c.asking !== "__form__" && c.asking !== "__done__")) await askNext(tx, tenantId, c, wa, found);
      else {
        // Nothing left to ask there: say where the complaint stands.
        const url = wa.channel.formUrl;
        const rest = c.fields.followup === "form_link" && url ? formLinkText(await departmentName(tx, tenantId), no, url, c.language) : completeText(no, c.language);
        await send(tx, tenantId, c, wa.sender, `${found}\n\n${rest}`);
      }
      return { caseId: c.id, ready: c.status === "ready" };
    }
    // The reply did not answer what we asked, or not in the right shape: say why before asking again.
    if (asked && msg.text?.trim() && !evidenceId && c.missing[0] === asked) prefix = [prefix, hintFor(asked, c.language)].filter(Boolean).join("\n\n");
    await askNext(tx, tenantId, c, wa, prefix);
    return { caseId: c.id, ready: c.status === "ready" };
  });
}

/**
 * The person behind a hidden-number chat gave the mobile number of a complaint already open:
 * the chat, its messages and proof move to that complaint, which keeps its own answers and
 * takes the chat's for anything it lacks. The chat's own case is closed with a note.
 */
async function joinInto(tx: Tx, tenantId: string, chat: Case, target: Case): Promise<Case> {
  await tx.update(caseMessages).set({ caseId: target.id }).where(eq(caseMessages.caseId, chat.id));
  await tx.update(caseEvidence).set({ caseId: target.id }).where(eq(caseEvidence.caseId, chat.id));
  const { number_hidden: _hidden, followup: _followup, whatsapp_consent: _consent, ...answers } = chat.fields;
  const joined = one(
    await tx
      .update(cases)
      .set({ fields: { ...answers, ...target.fields, whatsapp_lid: chat.complainantE164 }, scamType: target.scamType ?? chat.scamType, language: chat.language ?? target.language, lastInboundAt: chat.lastInboundAt, remindersSent: 0, updatedAt: new Date() })
      .where(eq(cases.id, target.id))
      .returning(),
  );
  const [from, into] = [await caseNo(tx, tenantId, chat), await caseNo(tx, tenantId, target)];
  await tx.update(cases).set({ status: "closed", officerNote: `Same person as complaint ${into}: WhatsApp hid their number, so this chat continues there.`, updatedAt: new Date() }).where(eq(cases.id, chat.id));
  await audit(tx, { tenantId, actorUserId: null, via: "system", action: "case.joined", targetType: "case", targetId: target.id, summary: `WhatsApp chat ${from} (number hidden) joined to complaint ${into} by the mobile number given` });
  return joined;
}

/** Delivery receipts from WhatsApp (sent, delivered, read, failed), matched on the message id. */
export async function recordStatuses(tenantId: string, statuses: Array<{ id: string; status: string }>) {
  if (!statuses.length) return;
  await withTenant(tenantId, async (tx) => {
    for (const s of statuses) await tx.update(caseMessages).set({ status: s.status.slice(0, 20) }).where(eq(caseMessages.externalId, s.id));
  });
}

// ------------------------------------------------------------------ reminders

export interface ReminderPolicy {
  gapHours: number;
  max: number;
  startHour: number;
  endHour: number;
}
/** Every 6 hours between 9 am and 9 pm, until the form is complete, at most 6 times (about 3 days). */
export const DEFAULT_REMINDERS: ReminderPolicy = { gapHours: 6, max: 6, startHour: 9, endHour: 21 };

function istHour(d: Date): number {
  return Number(d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
}

/** Reminds complainants who agreed to WhatsApp and whose form is still missing something. */
export async function remindPending(tenantId: string, now = new Date(), policy = DEFAULT_REMINDERS, sender?: WhatsAppSender): Promise<number> {
  const h = istHour(now);
  if (h < policy.startHour || h >= policy.endHour) return 0;
  return withTenant(tenantId, async (tx) => {
    const wa = await whatsappFor(tx, tenantId, sender);
    if (!wa) return 0;
    const cutoff = new Date(now.getTime() - policy.gapHours * 3_600_000);
    const due = await tx
      .select()
      .from(cases)
      .where(and(eq(cases.status, "collecting"), sql`${cases.fields}->>'followup' = 'questions'`, lt(cases.remindersSent, policy.max), lt(cases.lastOutboundAt, cutoff)))
      .limit(100);
    let sent = 0;
    for (const c of due) {
      if (c.lastInboundAt && c.lastInboundAt > cutoff) continue;
      const no = await caseNo(tx, tenantId, c);
      await send(tx, tenantId, c, wa.sender, `${reminderText(no, c.missing, c.language)}\n\n${questionFor(c.missing[0] ?? "proof", c.language)}`, c.missing[0] ?? null, now);
      await tx.update(cases).set({ remindersSent: c.remindersSent + 1 }).where(eq(cases.id, c.id));
      sent++;
    }
    return sent;
  });
}
