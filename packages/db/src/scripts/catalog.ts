/**
 * Install or refresh the catalogue: plans, agent templates and call programs.
 *
 *   pnpm --filter @jenai/db catalog
 *
 * Separate from the seeds on purpose. Shipping a new plan or a new call program
 * must not require reseeding demo data, and on a live server there is no demo
 * data to reseed. Idempotent: run it after every deploy that changes the
 * catalogue.
 *
 * Template versions are only ever added, never replaced: an agent is pinned to
 * the version it was built on and keeps working until someone republishes it.
 */
import "./env";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_CATALOG } from "../catalog";
import { agentTemplates, plans, programTemplates } from "../schema";
import { platformDb } from "../client";

const db = platformDb();
const here = path.dirname(fileURLToPath(import.meta.url));

let planCount = 0;
for (const p of PLAN_CATALOG) {
  await db.insert(plans).values(p).onConflictDoUpdate({ target: plans.key, set: { ...p, updatedAt: new Date() } });
  planCount++;
}

let templateCount = 0;
for (const file of ["template.clinic_receptionist.v1.json", "template.clinic_receptionist.v2.json"]) {
  const t = JSON.parse(readFileSync(path.resolve(here, `../../seed-data/${file}`), "utf8"));
  await db
    .insert(agentTemplates)
    .values({ key: t.key, version: t.version, name: t.name, basePrompt: t.base_prompt, endPrompt: t.end_prompt, extraction: t.extraction, extractionPrompt: t.extraction_prompt })
    .onConflictDoNothing();
  templateCount++;
}

const dir = path.resolve(here, "../../seed-data/programs");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
for (const f of files) {
  const g = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const row = {
    key: g.key, version: g.version, vertical: g.vertical, name: g.name, summary: g.summary,
    direction: g.direction ?? "outbound", purpose: g.purpose, goal: g.goal, taskPrompt: g.task_prompt, opening: g.opening,
    variables: g.variables ?? [], clientFields: g.client_fields ?? [], extraction: g.extraction ?? [], outcomes: g.outcomes ?? [],
    defaults: g.defaults ?? {}, requirements: g.requirements ?? {}, complianceNote: g.compliance_note ?? "",
    redteamCases: g.redteam_cases ?? [], status: g.status ?? "active",
  };
  await db.insert(programTemplates).values(row).onConflictDoUpdate({ target: [programTemplates.key, programTemplates.version], set: { ...row, updatedAt: new Date() } });
}

console.log(`catalogue ready: ${planCount} plans, ${templateCount} agent template version(s), ${files.length} call programs`);
process.exit(0);
