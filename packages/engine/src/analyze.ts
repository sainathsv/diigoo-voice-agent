/**
 * Post-call analysis. The voice engine's own end-of-call extraction is empty on
 * most live calls (Gemini speech-to-speech rarely reaches the end node; seen on
 * 39 of 40 Zennara calls on 2026-09-19), so JENAI reads the transcript itself.
 *
 * Output is schema-validated; anything that does not validate is dropped rather
 * than stored (the "literal DD Mon YYYY as a date" bug cannot recur).
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { agents, calls, leads, suppressions, withTenant } from "@jenai/db";
import { deriveLead, parsePreferredTime } from "./leads";
import { isOnOwnNetwork } from "./own-network";
import { CY_POLICE_PROGRAM, latestProgramVersion, programExtraction } from "./programs";
import { CYBER_INTAKE_DOMAIN } from "@jenai/voice";
import { emitAppointmentBooked, emitCallCompleted, emitDoNotCall } from "./integrations/events";
import { appointmentFromCall } from "./calendar";
import { FOLLOWUP_WINDOW_MS, caseFromCall } from "./cases/cases";
import type { WhatsAppSender } from "./cases/whatsapp";
import { isNotCyberCrime } from "./scams";

export const extractionSchema = z.object({
  caller_name: z.string().trim().min(1).max(80).nullable(),
  concern: z.string().trim().min(2).max(120).nullable(),
  preferred_time: z.string().trim().max(40).nullable(),
  interest_level: z.enum(["hot", "warm", "cold"]).nullable(),
  next_step: z.enum(["booked", "callback", "whatsapp", "none"]).nullable(),
  do_not_call: z.boolean().nullable(),
  summary: z.string().trim().max(400).nullable(),
  // The basic history the advisor gathers on the call (template v2). Health
  // detail, so it lives under the client's tenant like the transcript does.
  duration: z.string().trim().max(60).nullable(),
  tried_before: z.string().trim().max(160).nullable(),
  background: z.string().trim().max(200).nullable(),
  advice_given: z.string().trim().max(200).nullable(),
  urgent: z.boolean().nullable(),
});
export type Extraction = z.infer<typeof extractionSchema>;

/** A call program's own questions, appended to the standard ones (migration 0013). */
export interface ProgramAsk {
  key: string;
  extraction: Array<{ name: string; type: string; prompt: string }>;
  outcomes: Array<{ key: string; label: string; stage?: string }>;
}

export interface Extractor {
  readonly model: string;
  /** `signal` stops a read part-way (the worker does, to let a WhatsApp reply use the AI first). */
  extract(input: { transcript: string; startedAt: Date; domain: string; direction: "inbound" | "outbound"; program?: ProgramAsk | null }, signal?: AbortSignal): Promise<unknown>;
}

const PLACEHOLDER = /\b(DD|MM|YYYY|Mon|HH)\b|<[^>]+>|\{\{/;

/** Validates raw model output and normalises it. Invalid fields become null. */
export function cleanExtraction(raw: unknown): Extraction | null {
  let obj = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const pick = <K extends keyof Extraction>(k: K): Extraction[K] => {
    const r = extractionSchema.shape[k].safeParse(o[k] === "" || o[k] === "null" ? null : o[k]);
    return r.success ? (r.data as Extraction[K]) : null;
  };
  const out: Extraction = {
    caller_name: pick("caller_name"),
    concern: pick("concern"),
    preferred_time: pick("preferred_time"),
    interest_level: pick("interest_level"),
    next_step: pick("next_step"),
    do_not_call: pick("do_not_call"),
    summary: pick("summary"),
    duration: pick("duration"),
    tried_before: pick("tried_before"),
    background: pick("background"),
    advice_given: pick("advice_given"),
    urgent: pick("urgent"),
  };
  if (out.preferred_time && (PLACEHOLDER.test(out.preferred_time) || !parsePreferredTime(out.preferred_time))) out.preferred_time = null;
  // A booking without a real day and time is not a booking.
  if (out.next_step === "booked" && !out.preferred_time) out.next_step = "callback";
  return out;
}

function programBlock(p: ProgramAsk | null | undefined): string {
  if (!p?.extraction.length) return "";
  const keys = p.extraction.map((e) => ` "${e.name}": string|null (${e.prompt})`).join(",\n");
  const outcomes = p.outcomes.map((o) => `"${o.key}"`).join("|");
  return `\n\nThis call was part of the "${p.key}" program. ALSO include these keys, null when not said:\n{\n${keys}${outcomes ? `,\n "outcome": ${outcomes}|null (how the call ended)` : ""}\n}`;
}

function prompt(input: { transcript: string; startedAt: Date; domain: string; direction: string; program?: ProgramAsk | null }) {
  const today = input.startedAt.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", weekday: "long" });
  return `You analyse one phone call handled by an AI ${input.domain === "cyber crime" ? "complaint assistant for a police cyber crime helpline" : `receptionist for a ${input.domain} business`} in India. The call was ${input.direction} on ${today} (IST). The transcript may mix Telugu, Hindi and English.

Return ONLY a JSON object with exactly these keys, null when not said. Every value must be in ENGLISH: translate Telugu or Hindi, never copy the caller's words.
{"caller_name": string|null (in English letters), "concern": string|null (what they asked about, 3 to 8 English words, e.g. "hair fall treatment"),
 "preferred_time": string|null (the agreed appointment, written like "20 Sep 2026, 11:00 AM" or "20 Sep 2026" if no time; resolve words like today, tomorrow, repu, kal, next Monday against the call date),
 "interest_level": "hot"|"warm"|"cold"|null, "next_step": "booked"|"callback"|"whatsapp"|"none"|null ("booked" only if a day AND exact time were confirmed),
 "do_not_call": true|false|null (true only if they asked not to be called again), "summary": string|null (one sentence),
 "duration": string|null (how long they have had the problem, as they said it, e.g. "6 months", "since last winter"),
 "tried_before": string|null (what they already tried: home remedies, shampoos, creams, other doctors or clinics; up to 15 words),
 "background": string|null (background they mentioned: recent delivery, thyroid, sugar, PCOD, a new medicine, colouring, family history, stress, sleep; up to 20 words),
 "advice_given": string|null (the everyday care advice the agent actually gave on this call; up to 20 words),
 "urgent": true|false|null (true only if they described something needing to be seen the same day: spreading redness with fever, a hot painful swelling, a non-healing wound, a mole that changed or bleeds, sudden patchy hair loss with a painful scalp, blistering after a product)}
Never invent a name, time or detail that is not in the transcript. Never write a diagnosis: report only what the caller said.${programBlock(input.program)}

TRANSCRIPT:
${input.transcript.slice(0, 24_000)}`;
}

/** Amazon Bedrock in Mumbai (ap-south-1) by default, so transcripts stay in India. */
export class BedrockExtractor implements Extractor {
  private readonly client: BedrockRuntimeClient;
  constructor(readonly model = process.env.JENAI_ANALYZER_MODEL ?? "deepseek.v3.2", region = process.env.JENAI_ANALYZER_REGION ?? "ap-south-1") {
    this.client = new BedrockRuntimeClient({ region });
  }
  async extract(input: { transcript: string; startedAt: Date; domain: string; direction: "inbound" | "outbound"; program?: ProgramAsk | null }, signal?: AbortSignal) {
    const r = await this.client.send(
      new ConverseCommand({
        modelId: this.model,
        messages: [{ role: "user", content: [{ text: prompt(input) }] }],
        inferenceConfig: { maxTokens: input.program ? 900 : 600, temperature: 0 },
      }),
      signal ? { abortSignal: signal } : {},
    );
    return (r.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  }
}

/**
 * A model running on the client's own server (Ollama, vLLM, llama.cpp, LM Studio: anything
 * with an OpenAI-compatible /chat/completions). For deployments where transcripts may not
 * leave the premises, such as a police department's private server.
 */
export class LocalModelExtractor implements Extractor {
  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | null = null,
    private readonly timeoutMs = 180_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async extract(input: { transcript: string; startedAt: Date; domain: string; direction: "inbound" | "outbound"; program?: ProgramAsk | null }, signal?: AbortSignal) {
    const r = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt(input) }],
        temperature: 0,
        max_tokens: input.program ? 900 : 600,
        response_format: { type: "json_object" },
      }),
      // A local model on modest hardware can take a while; a stuck one must not hold the worker.
      signal: signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal]) : AbortSignal.timeout(this.timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } | string };
    if (!r.ok) throw new Error(`Local model refused (${r.status}): ${typeof j.error === "string" ? j.error : (j.error?.message ?? "no detail")}`);
    return j.choices?.[0]?.message?.content ?? "";
  }
}

/**
 * The analyser this server is configured for:
 *   JENAI_ANALYZER_PROVIDER=local  + JENAI_ANALYZER_BASE_URL (e.g. http://127.0.0.1:11434/v1) + JENAI_ANALYZER_MODEL
 *   JENAI_ANALYZER_PROVIDER=bedrock (default) + JENAI_ANALYZER_REGION / JENAI_ANALYZER_MODEL
 * The police edition (JENAI_EDITION=police) reads calls only with a model on its own network.
 */
export function extractorFromEnv(env: Record<string, string | undefined> = process.env): Extractor {
  const police = env.JENAI_EDITION === "police";
  const provider = (env.JENAI_ANALYZER_PROVIDER ?? (police ? "local" : "bedrock")).toLowerCase();
  if (provider === "local" || provider === "openai") {
    const baseUrl = env.JENAI_ANALYZER_BASE_URL;
    const model = env.JENAI_ANALYZER_MODEL;
    if (!baseUrl || !model) throw new Error("JENAI_ANALYZER_PROVIDER=local needs JENAI_ANALYZER_BASE_URL and JENAI_ANALYZER_MODEL");
    if (police && !isOnOwnNetwork(baseUrl)) throw new Error("The police edition keeps transcripts on its own network: JENAI_ANALYZER_BASE_URL must be this server or a private address");
    return new LocalModelExtractor(model, baseUrl, env.JENAI_ANALYZER_API_KEY ?? null, Number(env.JENAI_ANALYZER_TIMEOUT_MS ?? 180_000));
  }
  if (provider !== "bedrock") throw new Error(`Unknown JENAI_ANALYZER_PROVIDER "${provider}" (use local or bedrock)`);
  if (police) throw new Error("The police edition keeps transcripts on this server: use JENAI_ANALYZER_PROVIDER=local");
  return new BedrockExtractor(env.JENAI_ANALYZER_MODEL ?? "deepseek.v3.2", env.JENAI_ANALYZER_REGION ?? "ap-south-1");
}

export interface AnalyzeStats {
  analyzed: number;
  leads: number;
  optOuts: number;
  failed: number;
}

/** Program answers are free text from a model: keep them short, strings only. */
function cleanProgramFields(raw: unknown, p: ProgramAsk): Record<string, string> {
  const obj = (() => {
    if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
    if (typeof raw !== "string") return {};
    try {
      return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const out: Record<string, string> = {};
  for (const e of p.extraction) {
    const v = obj[e.name];
    if (v === null || v === undefined || v === "") continue;
    const text = String(v).trim().slice(0, 200);
    if (text && !PLACEHOLDER.test(text)) out[e.name] = text;
  }
  const outcome = obj.outcome;
  if (typeof outcome === "string" && p.outcomes.some((o) => o.key === outcome)) out.outcome = outcome;
  return out;
}

/**
 * Analyse finished calls that have a transcript and have not been analysed yet. `signal`
 * stops the batch: the call being read is left for the next round.
 */
export async function analyzeCalls(tenantId: string, extractor: Extractor, opts: { limit?: number; whatsapp?: WhatsAppSender; signal?: AbortSignal } = {}): Promise<AnalyzeStats> {
  const stats: AnalyzeStats = { analyzed: 0, leads: 0, optOuts: 0, failed: 0 };
  const todo = await withTenant(tenantId, (tx) =>
    tx
      .select({ c: calls, domain: agents.domain })
      .from(calls)
      .leftJoin(agents, eq(agents.id, calls.agentId))
      .where(and(eq(calls.status, "completed"), isNull(calls.analyzedAt), isNotNull(calls.transcript)))
      .orderBy(desc(calls.startedAt))
      .limit(opts.limit ?? 20),
  );
  const programs = new Map<string, ProgramAsk | null>();
  for (const { c, domain } of todo) {
    if (opts.signal?.aborted) break;
    try {
      let program: ProgramAsk | null = null;
      if (c.agentId) {
        if (!programs.has(c.agentId)) {
          const row = await withTenant(tenantId, (tx) => programExtraction(tx, tenantId, c.agentId!));
          programs.set(c.agentId, row ? { key: row.key, extraction: row.extraction, outcomes: row.outcomes } : null);
        }
        program = programs.get(c.agentId) ?? null;
      }
      // Cyber crime lines read every call with the complaint questions, even an agent imported as it was.
      const cyber = domain === CYBER_INTAKE_DOMAIN;
      if (!program && cyber) {
        if (!programs.has(CY_POLICE_PROGRAM)) {
          const p = await withTenant(tenantId, (tx) => latestProgramVersion(tx, CY_POLICE_PROGRAM).catch(() => null));
          programs.set(CY_POLICE_PROGRAM, p ? { key: p.key, extraction: p.extraction, outcomes: p.outcomes } : null);
        }
        program = programs.get(CY_POLICE_PROGRAM) ?? null;
      }
      const raw = await extractor.extract({ transcript: c.transcript!, startedAt: c.startedAt, domain: domain ?? "clinic", direction: c.direction, program }, opts.signal);
      const x = cleanExtraction(raw);
      const extra = program ? cleanProgramFields(raw, program) : {};
      await withTenant(tenantId, async (tx) => {
        const merged: Record<string, unknown> = { ...c.extracted };
        // A police complaint keeps only the general answers; clinic questions (interest, booking,
        // treatment history) mean nothing on a cyber crime report.
        const keep = cyber ? new Set(["caller_name", "summary", "do_not_call", "urgent"]) : null;
        if (x) for (const [k, v] of Object.entries(x)) if (v !== null && (!keep || keep.has(k)) && (merged[k] === undefined || merged[k] === null || merged[k] === "")) merged[k] = v;
        for (const [k, v] of Object.entries(extra)) merged[k] = v;
        await tx
          .update(calls)
          .set({ extracted: merged, summary: x?.summary ?? c.summary, disposition: cyber ? c.disposition : ((x?.next_step as string) ?? c.disposition), analyzedAt: new Date(), analysisModel: extractor.model })
          .where(eq(calls.id, c.id));
        if (x?.do_not_call && c.contactId) {
          const phone = c.direction === "inbound" ? c.fromE164 : c.toE164;
          if (phone) {
            await tx.insert(suppressions).values({ tenantId, phoneE164: phone, reason: "opt_out", scope: null, source: `said on call ${c.externalRunId}` }).onConflictDoNothing();
            await emitDoNotCall(tx, tenantId, phone, `said so on call ${c.id}`);
            stats.optOuts++;
          }
        }
        // A complaint is not a sales lead: it opens (or adds to) the complainant's case, and
        // WhatsApp collects what the call did not. A call that was not a cyber crime opens nothing.
        // Usually the case is already open from the engine's reading; this fills in what the AI found.
        if (cyber) {
          if (!isNotCyberCrime(String(merged.complaint_type ?? "")))
            await caseFromCall(tx, tenantId, { id: c.id, phone: c.direction === "inbound" ? c.fromE164 : c.toE164, contactId: c.contactId, branchId: c.branchId, extracted: merged, at: c.startedAt }, opts.whatsapp, {
              message: Date.now() - c.startedAt.getTime() < FOLLOWUP_WINDOW_MS,
            });
        } else if (c.contactId && (await deriveLead(tx, tenantId, { callId: c.id, contactId: c.contactId, branchId: c.branchId, extracted: merged, at: c.startedAt }))) stats.leads++;
        // A booking goes straight into the calendar, so the front desk sees it without asking.
        if (merged.next_step === "booked" && typeof merged.preferred_time === "string") {
          const when = parsePreferredTime(merged.preferred_time);
          if (when) {
            await appointmentFromCall(tx, tenantId, {
              callId: c.id,
              contactId: c.contactId,
              branchId: c.branchId,
              when,
              personName: (merged.caller_name as string) ?? null,
              phone: c.direction === "inbound" ? c.fromE164 : c.toE164,
              note: merged.concern ? `About: ${String(merged.concern)}` : null,
            });
          }
        }
        // Hand the result back to the client's own system (their CRM stays the record of truth).
        await emitCallCompleted(tx, tenantId, c.id);
        if (merged.next_step === "booked" && typeof merged.preferred_time === "string") await emitAppointmentBooked(tx, tenantId, c.id, merged.preferred_time);
        // A program says what its own outcomes mean for the lead (paid, disputed, booked).
        if (c.contactId && program && typeof extra.outcome === "string") {
          const stage = program.outcomes.find((o) => o.key === extra.outcome)?.stage;
          if (stage) {
            await tx
              .update(leads)
              .set({ stage: stage as never, updatedAt: new Date() })
              .where(and(eq(leads.tenantId, tenantId), eq(leads.contactId, c.contactId)));
          }
        }
      });
      stats.analyzed++;
    } catch {
      if (opts.signal?.aborted) break; // stopped, not failed: read again next round
      stats.failed++;
    }
  }
  return stats;
}
