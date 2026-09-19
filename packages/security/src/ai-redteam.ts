/**
 * AI red team from the command line. The same suite the platform runs on
 * every publish and in the weekly fleet sweep (packages/engine/src/safety),
 * for trying a fix before shipping it.
 *
 *   pnpm --filter @jenai/security ai-redteam -- --agent <id>             what callers hear now
 *   pnpm --filter @jenai/security ai-redteam -- --agent <id> --preview   the same facts rebuilt with today's template and guardrails
 *        [--greeting "..."]                                              ...with a different greeting
 *   pnpm --filter @jenai/security ai-redteam -- --file prompt.txt [--vertical health]
 *
 * Nothing is saved or published. Exits 1 when a critical case fails.
 */
import "@jenai/db/env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";
import { agentTemplates, agentVersions, agents, organizations, platformDb } from "@jenai/db";
import { BedrockSafetyModel, casesFor, runSuite, summarise, verticalOf, type CaseResult } from "@jenai/engine";
import { guardrailsVersionOf, parseBuiltPrompt, render } from "@jenai/voice";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (n: string) => process.argv.includes(`--${n}`);

async function subject(): Promise<{ label: string; prompt: string; vertical: string }> {
  const file = arg("file");
  if (file) return { label: path.basename(file), prompt: readFileSync(file, "utf8"), vertical: arg("vertical") ?? "general" };
  const id = arg("agent");
  if (!id) throw new Error("Pass --agent <id> or --file <prompt.txt>.");
  const db = platformDb();
  const [a] = await db.select({ agent: agents, org: organizations }).from(agents).innerJoin(organizations, eq(organizations.id, agents.tenantId)).where(eq(agents.id, id));
  if (!a) throw new Error("No such agent.");
  const [v] = await db.select().from(agentVersions).where(eq(agentVersions.agentId, id)).orderBy(desc(agentVersions.number)).limit(1);
  if (!flag("preview")) return { label: `${a.org.name}: ${a.agent.name} v${v!.number} (live prompt)`, prompt: v!.inboundPrompt ?? "", vertical: a.org.vertical ?? "general" };
  const [t] = await db.select().from(agentTemplates).where(eq(agentTemplates.key, a.agent.templateKey));
  const parsed = parseBuiltPrompt(v!.inboundPrompt ?? "", t!.basePrompt) ?? { facts: v!.facts, greeting: v!.greeting };
  const greeting = arg("greeting") ?? parsed.greeting;
  const r = render({ basePrompt: t!.basePrompt, endPrompt: t!.endPrompt, extraction: t!.extraction as never, extractionPrompt: t!.extractionPrompt }, { greeting, facts: parsed.facts }, a.agent.domain);
  return { label: `${a.org.name}: ${a.agent.name} (preview, guardrails v${r.guardrailsVersion})`, prompt: r.inboundPrompt, vertical: a.org.vertical ?? "general" };
}

function report(label: string, results: CaseResult[], model: BedrockSafetyModel): string {
  const s = summarise(results);
  const lines = [
    `# AI red team: ${label}`,
    "",
    `${new Date().toISOString()} · target ${model.target} · judge ${model.judge} · result **${s.status}** (${s.held} held, ${s.failed} failed, ${s.review} to review)`,
    "",
    "| Case | Severity | Result | Why |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.severity} | ${r.verdict === "failed" ? "**FAILED**" : r.verdict} | ${r.reason.replace(/\|/g, "/")} |`),
    "",
  ];
  for (const r of results.filter((x) => x.verdict !== "held")) {
    lines.push(`## ${r.id} (${r.severity}, ${r.verdict})`, "", `> **Agent:** ${r.greeting}`, ">");
    for (const t of r.turns) lines.push(`> **Caller:** ${t.caller}`, ">", `> **Agent:** ${t.agent.replace(/\n/g, " ")}`, ">");
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const s = await subject();
  const model = new BedrockSafetyModel();
  const cases = casesFor(s.vertical);
  console.log(`${s.label}\n${cases.length} cases (${verticalOf(s.vertical)} pack), guardrails ${guardrailsVersionOf(s.prompt) ?? "none"}`);
  const results = await runSuite(model, s.prompt, cases, 4);
  for (const r of results) console.log(`  ${r.verdict.padEnd(6)} ${r.severity.padEnd(8)} ${r.id}: ${r.reason}`);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ai-redteam-${new Date().toISOString().slice(0, 16).replace(":", "")}-${s.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50)}.md`);
  writeFileSync(file, report(s.label, results, model));
  const sum = summarise(results);
  console.log(`\n  ${sum.status.toUpperCase()}: ${sum.held} held, ${sum.failed} failed (${sum.criticalFailed} critical), ${sum.review} to review\n  report: ${path.relative(process.cwd(), file)}`);
  process.exit(sum.criticalFailed ? 1 : 0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(2);
});
