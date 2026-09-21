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
import { programExtraction } from "./programs";
import { emitAppointmentBooked, emitCallCompleted, emitDoNotCall } from "./integrations/events";

export const extractionSchema = z.object({
  caller_name: z.string().trim().min(1).max(80).nullable(),
  concern: z.string().trim().min(2).max(120).nullable(),
  preferred_time: z.string().trim().max(40).nullable(),
  interest_level: z.enum(["hot", "warm", "cold"]).nullable(),
  next_step: z.enum(["booked", "callback", "whatsapp", "none"]).nullable(),
  do_not_call: z.boolean().nullable(),
  summary: z.string().trim().max(400).nullable(),
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
  extract(input: { transcript: string; startedAt: Date; domain: string; direction: "inbound" | "outbound"; program?: ProgramAsk | null }): Promise<unknown>;
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
  return `You analyse one phone call handled by an AI receptionist for a ${input.domain} business in India. The call was ${input.direction} on ${today} (IST). The transcript may mix Telugu, Hindi and English.

Return ONLY a JSON object with exactly these keys, null when not said. Every value must be in ENGLISH: translate Telugu or Hindi, never copy the caller's words.
{"caller_name": string|null (in English letters), "concern": string|null (what they asked about, 3 to 8 English words, e.g. "hair fall treatment"),
 "preferred_time": string|null (the agreed appointment, written like "20 Sep 2026, 11:00 AM" or "20 Sep 2026" if no time; resolve words like today, tomorrow, repu, kal, next Monday against the call date),
 "interest_level": "hot"|"warm"|"cold"|null, "next_step": "booked"|"callback"|"whatsapp"|"none"|null ("booked" only if a day AND exact time were confirmed),
 "do_not_call": true|false|null (true only if they asked not to be called again), "summary": string|null (one sentence)}
Never invent a name, time or detail that is not in the transcript.${programBlock(input.program)}

TRANSCRIPT:
${input.transcript.slice(0, 24_000)}`;
}

/** Amazon Bedrock in Mumbai (ap-south-1) by default, so transcripts stay in India. */
export class BedrockExtractor implements Extractor {
  private readonly client: BedrockRuntimeClient;
  constructor(readonly model = process.env.JENAI_ANALYZER_MODEL ?? "deepseek.v3.2", region = process.env.JENAI_ANALYZER_REGION ?? "ap-south-1") {
    this.client = new BedrockRuntimeClient({ region });
  }
  async extract(input: { transcript: string; startedAt: Date; domain: string; direction: "inbound" | "outbound"; program?: ProgramAsk | null }) {
    const r = await this.client.send(
      new ConverseCommand({
        modelId: this.model,
        messages: [{ role: "user", content: [{ text: prompt(input) }] }],
        inferenceConfig: { maxTokens: input.program ? 700 : 400, temperature: 0 },
      }),
    );
    return (r.output?.message?.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  }
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

/** Analyse finished calls that have a transcript and have not been analysed yet. */
export async function analyzeCalls(tenantId: string, extractor: Extractor, opts: { limit?: number } = {}): Promise<AnalyzeStats> {
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
    try {
      let program: ProgramAsk | null = null;
      if (c.agentId) {
        if (!programs.has(c.agentId)) {
          const row = await withTenant(tenantId, (tx) => programExtraction(tx, tenantId, c.agentId!));
          programs.set(c.agentId, row ? { key: row.key, extraction: row.extraction, outcomes: row.outcomes } : null);
        }
        program = programs.get(c.agentId) ?? null;
      }
      const raw = await extractor.extract({ transcript: c.transcript!, startedAt: c.startedAt, domain: domain ?? "clinic", direction: c.direction, program });
      const x = cleanExtraction(raw);
      const extra = program ? cleanProgramFields(raw, program) : {};
      await withTenant(tenantId, async (tx) => {
        const merged: Record<string, unknown> = { ...c.extracted };
        if (x) for (const [k, v] of Object.entries(x)) if (v !== null && (merged[k] === undefined || merged[k] === null || merged[k] === "")) merged[k] = v;
        for (const [k, v] of Object.entries(extra)) merged[k] = v;
        await tx
          .update(calls)
          .set({ extracted: merged, summary: x?.summary ?? c.summary, disposition: (x?.next_step as string) ?? c.disposition, analyzedAt: new Date(), analysisModel: extractor.model })
          .where(eq(calls.id, c.id));
        if (x?.do_not_call && c.contactId) {
          const phone = c.direction === "inbound" ? c.fromE164 : c.toE164;
          if (phone) {
            await tx.insert(suppressions).values({ tenantId, phoneE164: phone, reason: "opt_out", scope: null, source: `said on call ${c.externalRunId}` }).onConflictDoNothing();
            await emitDoNotCall(tx, tenantId, phone, `said so on call ${c.id}`);
            stats.optOuts++;
          }
        }
        if (c.contactId && (await deriveLead(tx, tenantId, { callId: c.id, contactId: c.contactId, branchId: c.branchId, extracted: merged, at: c.startedAt }))) stats.leads++;
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
      stats.failed++;
    }
  }
  return stats;
}
