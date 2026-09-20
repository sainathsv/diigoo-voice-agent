import { createHash } from "node:crypto";
import type { DograhDefinition } from "./dograh";
import { CONTRADICTIONS, GUARDRAILS_VERSION, stripGuardrails, withGuardrails } from "./guardrails";

/**
 * Platform guardrails + per-client facts + one shared behaviour base
 * (Blueprint Part 9). Below the guardrails the layout matches
 * oss-poc/agent_base.py, so legacy live prompts still import cleanly.
 */
export interface TemplateInput {
  basePrompt: string;
  endPrompt: string;
  extraction: Array<{ name: string; type: string; prompt: string }>;
  extractionPrompt: string;
}
export interface VersionInput {
  greeting: string;
  facts: string;
  outboundOpening?: string | null;
  /** A call program's job (migration 0013): what this agent is calling about. */
  taskPrompt?: string | null;
}
export interface Rendered {
  inboundPrompt: string;
  outboundPrompt: string;
  endPrompt: string;
  extraction: Array<{ name: string; type: string; prompt: string }>;
  extractionPrompt: string;
  hash: string;
  guardrailsVersion: number;
}

const FIRST_WORDS = "FIRST WORDS, word for word, once, then stop and listen:";

export function defaultOutboundOpening(greeting: string): string {
  const who = greeting.split(".")[0]!.replace(/^Welcome to\s+/i, "").trim();
  return `Hello {{caller_name}}, this is ${who} calling about {{call_purpose}}. Please tell me, is this a good time?`;
}

/**
 * Placeholders a call fills in. {{caller_name}} and {{call_purpose}} always;
 * a call program adds its own (amount due, last visit, property number), which
 * the dialer passes per person.
 */
export const ALWAYS_ALLOWED = ["caller_name", "call_purpose"] as const;

export function render(t: TemplateInput, v: VersionInput, domain: string): Rendered {
  const job = v.taskPrompt?.trim() ? `\n\n${v.taskPrompt.trim()}` : "";
  const facts = `${v.facts.trim()}${job}`;
  const inboundPrompt = withGuardrails(`${facts}\n\n${FIRST_WORDS}\n"${v.greeting.trim()}"\n\n${t.basePrompt}`);
  const opening = (v.outboundOpening?.trim() || defaultOutboundOpening(v.greeting)).trim();
  const outboundPrompt = withGuardrails(`${facts}\n\n${FIRST_WORDS}\n"${opening}"\n\n${t.basePrompt}`);
  const extraction = t.extraction.map((x) => ({ ...x, prompt: x.prompt.replaceAll("{{domain}}", domain) }));
  const hash = promptHash(inboundPrompt, outboundPrompt, t.endPrompt);
  return { inboundPrompt, outboundPrompt, endPrompt: t.endPrompt, extraction, extractionPrompt: t.extractionPrompt, hash, guardrailsVersion: GUARDRAILS_VERSION };
}

export function promptHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n␞\n")).digest("hex").slice(0, 16);
}

/** Write the rendered prompts into a workflow definition (startCall + endCall nodes). */
export function applyToDefinition(def: DograhDefinition, r: Rendered, direction: "inbound" | "outbound"): DograhDefinition {
  const copy: DograhDefinition = JSON.parse(JSON.stringify(def));
  const start = copy.nodes.find((n) => n.type === "startCall");
  if (!start) throw new Error("Workflow has no startCall node; it cannot carry an agent prompt.");
  start.data = { ...(start.data ?? {}), prompt: direction === "inbound" ? r.inboundPrompt : r.outboundPrompt };
  for (const n of copy.nodes) {
    if (n.type !== "endCall") continue;
    n.data = {
      ...(n.data ?? {}),
      prompt: r.endPrompt,
      extraction_enabled: true,
      extraction_prompt: r.extractionPrompt,
      extraction_variables: r.extraction,
    };
  }
  return copy;
}

export function startPrompt(def: DograhDefinition | null | undefined): string {
  return String(def?.nodes?.find((n) => n.type === "startCall")?.data?.prompt ?? "");
}

/**
 * Recover {facts, greeting} from a prompt built with the shared template, so a
 * live agent can be imported without retyping. Returns null for legacy prompts.
 */
export function parseBuiltPrompt(built: string, basePrompt: string): { facts: string; greeting: string } | null {
  const prompt = stripGuardrails(built).prompt;
  const i = prompt.indexOf(`\n\n${FIRST_WORDS}\n"`);
  if (i < 0) return null;
  const rest = prompt.slice(i + FIRST_WORDS.length + 4); // skip "\n\n" + FIRST_WORDS + "\n\""
  const close = rest.indexOf(`"\n\n`);
  if (close < 0) return null;
  const tail = rest.slice(close + 3);
  if (tail.trim() !== basePrompt.trim()) return null;
  return { facts: prompt.slice(0, i).trim(), greeting: rest.slice(0, close) };
}

export interface LintIssue {
  level: "error" | "warning";
  message: string;
}

/** Gate G0 (Blueprint Part 9): checks every version must pass before it can be published. */
export function lintVersion(v: VersionInput, allowedVariables: readonly string[] = []): LintIssue[] {
  const issues: LintIssue[] = [];
  const text = `${v.greeting}\n${v.outboundOpening ?? ""}`;
  if (v.greeting.trim().length < 10) issues.push({ level: "error", message: "The greeting is too short." });
  if (v.facts.trim().length < 80) issues.push({ level: "error", message: "Add the business facts (services, timings, address, what the agent may and may not say)." });
  const allowed = new Set<string>([...ALWAYS_ALLOWED, ...allowedVariables]);
  const used = [...`${v.facts}\n${v.taskPrompt ?? ""}\n${text}`.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]!.toLowerCase());
  const unknown = [...new Set(used.filter((n) => !allowed.has(n)))];
  if (unknown.length) {
    issues.push({
      level: "error",
      message: `Nothing fills in ${unknown.map((n) => `{{${n}}}`).join(", ")} on a call. Callers would hear it read out. Allowed here: ${[...allowed].map((n) => `{{${n}}}`).join(", ")}.`,
    });
  }
  if (!/\b(AI|artificial intelligence|virtual assistant|automated assistant)\b/i.test(text)) {
    issues.push({
      level: "error",
      message: "Say it is an AI assistant in the greeting (IT Rules 2026 require a spoken AI disclosure; TRAI requires automated calls to identify themselves).",
    });
  }
  for (const c of CONTRADICTIONS) {
    if (c.re.test(`${v.facts}\n${text}`)) issues.push({ level: "error", message: c.message });
  }
  if (/\b(\d{1,3}(,\d{3})+|\d+\s?(rs|rupees|lakh|₹))/i.test(v.facts) && !/ONLY price|only prices/i.test(v.facts)) {
    issues.push({ level: "warning", message: "Prices found in the facts. State which prices are the ONLY ones the agent knows, so it never invents others." });
  }
  return issues;
}
