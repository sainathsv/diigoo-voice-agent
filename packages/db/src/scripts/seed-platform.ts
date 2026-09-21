/**
 * The first run of a real JENAI installation: nothing but the platform itself.
 *
 *   pnpm --filter @jenai/db run seed:platform -- --admin you@company.com --name "Your Name"
 *
 * It creates the Diigoo organisation, the built-in roles, the plan catalogue,
 * the call program catalogue and the agent template, then prints a one-time
 * link for the first super admin to set their own password. No demo clients,
 * no sample calls, and nobody's password is ever chosen for them.
 */
import "./env";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { CLIENT_ROLE_TEMPLATES, PLATFORM_ROLE_TEMPLATES } from "@jenai/authz";
import { platformDb } from "../client";
import { audit } from "../audit";
import { PLAN_CATALOG } from "../catalog";
import { agentTemplates, invitations, memberships, organizations, plans, programTemplates, roles } from "../schema";
import { env } from "./env";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const adminEmail = arg("admin").trim().toLowerCase();
const adminName = arg("name", "Founder").trim();
const companyName = arg("company", "Diigoo Tech Private Limited").trim();
const baseUrl = (process.env.BETTER_AUTH_URL ?? "https://app.jenai.in").replace(/\/+$/, "");
if (!adminEmail.includes("@")) {
  console.error('Give the first admin\'s email: --admin you@company.com [--name "Your Name"]');
  process.exit(2);
}

env("DATABASE_PLATFORM_URL");
const db = platformDb();
const here = path.dirname(fileURLToPath(import.meta.url));

const [already] = await db.select().from(organizations).where(eq(organizations.kind, "platform"));
if (already) {
  console.log(`This installation is already set up (${already.name}). Nothing changed.`);
  process.exit(0);
}

// 1. Roles, exactly as the code defines them.
const roleIds = new Map<string, string>();
for (const [side, list] of [["client", CLIENT_ROLE_TEMPLATES], ["platform", PLATFORM_ROLE_TEMPLATES]] as const) {
  for (const t of list) {
    const [r] = await db
      .insert(roles)
      .values({ side, key: t.key, name: t.name, description: t.description, permissions: [...t.permissions], defaultScope: t.defaultScope, isSystem: true })
      .returning({ id: roles.id });
    roleIds.set(`${side}:${t.key}`, r!.id);
  }
}

// 2. What clients can buy.
for (const p of PLAN_CATALOG) {
  await db.insert(plans).values(p).onConflictDoUpdate({ target: plans.key, set: { ...p, updatedAt: new Date() } });
}

// 3. The shared agent behaviour and the call programs on offer.
const tpl = JSON.parse(readFileSync(path.resolve(here, "../../seed-data/template.clinic_receptionist.v1.json"), "utf8"));
await db
  .insert(agentTemplates)
  .values({ key: tpl.key, version: tpl.version, name: tpl.name, basePrompt: tpl.base_prompt, endPrompt: tpl.end_prompt, extraction: tpl.extraction, extractionPrompt: tpl.extraction_prompt })
  .onConflictDoNothing();

const programDir = path.resolve(here, "../../seed-data/programs");
const files = existsSync(programDir) ? readdirSync(programDir).filter((f) => f.endsWith(".json")).sort() : [];
for (const f of files) {
  const g = JSON.parse(readFileSync(path.join(programDir, f), "utf8"));
  const row = {
    key: g.key, version: g.version, vertical: g.vertical, name: g.name, summary: g.summary,
    direction: g.direction ?? "outbound", purpose: g.purpose, goal: g.goal, taskPrompt: g.task_prompt, opening: g.opening,
    variables: g.variables ?? [], clientFields: g.client_fields ?? [], extraction: g.extraction ?? [], outcomes: g.outcomes ?? [],
    defaults: g.defaults ?? {}, requirements: g.requirements ?? {}, complianceNote: g.compliance_note ?? "",
    redteamCases: g.redteam_cases ?? [], status: g.status ?? "active",
  };
  await db.insert(programTemplates).values(row).onConflictDoUpdate({ target: [programTemplates.key, programTemplates.version], set: { ...row, updatedAt: new Date() } });
}

// 4. The company itself.
const [platform] = await db
  .insert(organizations)
  .values({ kind: "platform", name: companyName, slug: "diigoo", status: "active", city: "Hyderabad", state: "Telangana", plan: "internal", languages: ["te", "hi", "en"] })
  .returning();

// 5. The first super admin, invited rather than created: they choose their own password.
const token = randomBytes(32).toString("base64url");
await db.insert(invitations).values({
  tenantId: platform!.id,
  email: adminEmail,
  name: adminName,
  roleId: roleIds.get("platform:super_admin")!,
  scopeType: "org",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  invitedBy: null,
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
});

await audit(db, { tenantId: null, actorUserId: null, via: "system", action: "platform.installed", summary: `${companyName} installed; first admin invited (${adminEmail})` });

const [{ count: memberCount } = { count: 0 }] = [{ count: (await db.select().from(memberships)).length }];
console.log(`
Installed.

  Company        ${companyName}
  Roles          ${roleIds.size} built in
  Plans          ${PLAN_CATALOG.length}
  Call programs  ${files.length}
  People         ${memberCount} (nobody yet: the first admin sets their own password)

Open this once, within 7 days, and choose a password:

  ${baseUrl}/invite/${token}

Then turn on two-step sign-in when it asks. It is required for staff in production.
`);
process.exit(0);
