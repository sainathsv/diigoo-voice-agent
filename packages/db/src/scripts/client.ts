/**
 * Create a client workspace from the command line.
 *
 *   pnpm --filter @jenai/db client create --name "Blue Cloud" --slug blue-cloud \
 *     --owner owner@bluecloud.example --owner-name "Their Owner" --vertical clinic --plan growth
 *
 * Does exactly what the console's New client form does: the workspace, its
 * first branch, the onboarding checklist, the subscription, and a one-time
 * invitation for the owner. No password is ever set for anyone: the owner
 * follows the link and chooses their own, then turns on two-step sign-in.
 *
 * The console is fine for one client. This exists because a fleet is not
 * onboarded by hand.
 */
import { and, eq, isNull } from "drizzle-orm";
import "./env";
import {
  PROVISIONING_STEPS, audit, branches, createInvitation, organizations, plans,
  platformDb, provisioningSteps, roles, subscriptions, withTenant,
} from "../index";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

async function create() {
  const name = arg("name");
  const slug = arg("slug");
  const ownerEmail = arg("owner");
  if (!name || !slug || !ownerEmail) throw new Error('need --name "..." --slug ... --owner someone@example.com');
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) throw new Error(`"${slug}" is not a valid address: lowercase letters, numbers and hyphens.`);
  const vertical = arg("vertical", "clinic");
  const planKey = arg("plan", "trial");
  const branch = arg("branch", "Main");
  const city = arg("city", "");
  const ownerName = arg("owner-name", "");

  const db = platformDb();
  const [taken] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
  if (taken) throw new Error(`The address ${slug} is taken.`);
  const [ownerRole] = await db.select().from(roles).where(and(eq(roles.key, "owner"), eq(roles.side, "client"), isNull(roles.tenantId)));
  if (!ownerRole) throw new Error("Role templates are missing. Run the platform seed.");
  const [plan] = await db.select().from(plans).where(eq(plans.key, planKey));
  if (!plan) throw new Error(`No plan called "${planKey}".`);
  const [platformOrg] = await db.select().from(organizations).where(eq(organizations.kind, "platform"));

  const [org] = await db
    .insert(organizations)
    .values({ kind: "client", parentId: platformOrg?.id ?? null, name, slug, vertical, city: city || null, plan: planKey, status: "onboarding", languages: ["te", "hi", "en"] })
    .returning();

  const link = await withTenant(org!.id, async (tx) => {
    const [b] = await tx.insert(branches).values({ tenantId: org!.id, name: branch, city: city || null, languages: ["te", "hi", "en"] }).returning({ id: branches.id });
    for (const s of PROVISIONING_STEPS) await tx.insert(provisioningSteps).values({ tenantId: org!.id, step: s.key });
    await tx.insert(subscriptions).values({ tenantId: org!.id, planKey, billingModel: plan.billingModel ?? "prepaid", startsOn: new Date().toISOString().slice(0, 10), extraFeatures: [] });
    const inv = await createInvitation(tx, { tenantId: org!.id, email: ownerEmail, name: ownerName || null, roleId: ownerRole.id, invitedBy: null });
    await audit(tx, {
      tenantId: org!.id, actorUserId: null, via: "system", action: "org.created",
      targetType: "organization", targetId: org!.id,
      summary: `Created from the command line (${planKey}) with branch ${branch}; Owner invited: ${ownerEmail}`,
      diff: { branchId: b!.id },
    });
    return inv.url;
  }, db);

  console.log(`\n${name} created.`);
  console.log(`  address    ${slug}`);
  console.log(`  plan       ${planKey}`);
  console.log(`  branch     ${branch}`);
  console.log(`  status     onboarding (${PROVISIONING_STEPS.filter((s) => s.required).length} steps to pass before going live)`);
  console.log(`\nSend the owner this link. It works once, lasts 7 days, and they choose their own password:\n\n  ${link}\n`);
}

async function list() {
  const rows = await platformDb().select({ slug: organizations.slug, name: organizations.name, status: organizations.status, plan: organizations.plan }).from(organizations).where(eq(organizations.kind, "client"));
  if (!rows.length) return console.log("No clients yet.");
  for (const r of rows) console.log(`  ${r.slug.padEnd(20)} ${r.name.padEnd(28)} ${r.status.padEnd(12)} ${r.plan}`);
}

const run = { create, list }[process.argv[2] as "create" | "list"];
if (!run) {
  console.log('usage: client <create|list> --name "..." --slug ... --owner someone@example.com [--owner-name "..."] [--vertical clinic] [--plan trial] [--branch Main] [--city ...]');
  process.exit(1);
}
await run();
process.exit(0);
