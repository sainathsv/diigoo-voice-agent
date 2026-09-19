/**
 * Local seed. Idempotent: skips when the platform organization already exists.
 * Every login uses SEED_PASSWORD. All emails are *.test (development only).
 * Checklist states for live clients reflect the 19 Sep 2026 audit, not guesses.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { CLIENT_ROLE_TEMPLATES, PLATFORM_ROLE_TEMPLATES } from "@jenai/authz";
import { env } from "./env";
import { platformDb } from "../client";
import { audit } from "../audit";
import { PROVISIONING_STEPS } from "../provisioning";
import {
  account,
  branches,
  memberships,
  organizations,
  provisioningSteps,
  roleBindings,
  roles,
  supportGrants,
  teamMembers,
  teams,
  user,
} from "../schema";

env("DATABASE_PLATFORM_URL");
const password = env("SEED_PASSWORD");
const db = platformDb();

type StepState = Partial<Record<(typeof PROVISIONING_STEPS)[number]["key"], [status: "pending" | "in_progress" | "passed" | "failed" | "skipped", detail?: string]>>;

const LIVE_CLIENT_GAPS: StepState = {
  kyc: ["pending", "Runs on the shared Diigoo carrier account; client KYC not yet filed."],
  telephony_account: ["failed", "Shared Vobiz account and application. Move to an own sub-account."],
  number: ["passed", "Live number in service."],
  a2p_declaration: ["pending", "Caller IDs not yet declared under the 18 Sep 2026 TRAI amendment."],
  agent: ["in_progress", "Live, but past edits were saved as drafts and not published to inbound."],
  test_inbound: ["pending"],
  test_outbound: ["pending"],
  writeback: ["in_progress", "Leads rebuilt from transcripts by the analyzer; no CRM write-back."],
  wallet: ["pending", "Billed manually; no wallet."],
  dpa: ["pending"],
};

const CLIENTS = [
  {
    slug: "zennara",
    name: "Zennara Clinics",
    vertical: "derma",
    city: "Hyderabad",
    status: "active" as const,
    plan: "growth",
    branches: [{ key: "kondapur", name: "Kondapur", city: "Hyderabad" }],
    people: [
      { email: "owner@zennara.test", name: "Zennara Owner", role: "owner" },
      { email: "admin@zennara.test", name: "Clinic Admin", role: "admin" },
      { email: "manager@zennara.test", name: "Kondapur Manager", role: "branch_manager", branch: "kondapur" },
      { email: "frontdesk@zennara.test", name: "Front Desk, Kondapur", role: "front_desk", branch: "kondapur", team: "Front desk" },
      { email: "marketing@zennara.test", name: "Marketing Lead", role: "marketing" },
      { email: "doctor@zennara.test", name: "Dr. Sample", role: "practitioner", branch: "kondapur", team: "Doctors" },
    ],
    steps: LIVE_CLIENT_GAPS,
  },
  {
    slug: "lbr-dental",
    name: "LBR Dental Implants",
    vertical: "dental",
    city: "Hyderabad",
    status: "active" as const,
    plan: "growth",
    branches: [{ key: "main", name: "Main clinic", city: "Hyderabad" }],
    people: [
      { email: "owner@lbr.test", name: "LBR Owner", role: "owner" },
      { email: "frontdesk@lbr.test", name: "Front Desk", role: "front_desk", branch: "main", team: "Front desk" },
    ],
    steps: LIVE_CLIENT_GAPS,
  },
  {
    slug: "ghmc",
    name: "Greater Hyderabad Municipal Corporation",
    vertical: "municipal",
    city: "Hyderabad",
    status: "active" as const,
    plan: "enterprise",
    branches: [{ key: "hq", name: "Head office", city: "Hyderabad" }],
    people: [
      { email: "owner@ghmc.test", name: "GHMC Nodal Officer", role: "owner" },
      { email: "qa@ghmc.test", name: "Grievance Supervisor", role: "qa_supervisor" },
    ],
    steps: { ...LIVE_CLIENT_GAPS, number: ["failed", "Inbound number inactive."] } as StepState,
  },
  {
    slug: "demo-clinic",
    name: "Demo Skin Clinic (sample)",
    vertical: "derma",
    city: "Hyderabad",
    status: "onboarding" as const,
    plan: "trial",
    branches: [
      { key: "madhapur", name: "Madhapur", city: "Hyderabad" },
      { key: "kukatpally", name: "Kukatpally", city: "Hyderabad" },
    ],
    people: [{ email: "owner@democlinic.test", name: "Demo Owner", role: "owner" }],
    steps: { kyc: ["passed"], telephony_account: ["in_progress", "Vobiz sub-account created; waiting for KYC link."] } as StepState,
  },
];

const STAFF = [
  { email: "founder@diigoo.test", name: "Founder", role: "super_admin" },
  { email: "ops@diigoo.test", name: "Platform Ops", role: "platform_ops" },
  { email: "bd@diigoo.test", name: "BD Executive", role: "sales" },
  { email: "success@diigoo.test", name: "Customer Success", role: "customer_success" },
  { email: "support@diigoo.test", name: "Support Agent", role: "support" },
  { email: "finance@diigoo.test", name: "Finance", role: "finance" },
];

async function main() {
  const existing = await db.select().from(organizations).where(eq(organizations.kind, "platform"));
  if (existing.length) {
    console.log("seed: already seeded (platform organization exists). Use pnpm db:reset to start over.");
    return;
  }
  const hash = await hashPassword(password);
  const users = new Map<string, string>();

  async function ensureUser(email: string, name: string) {
    const found = users.get(email);
    if (found) return found;
    const id = randomUUID();
    await db.insert(user).values({ id, email, name, emailVerified: true });
    await db.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash });
    users.set(email, id);
    return id;
  }

  // System role templates (tenant_id NULL, read-only).
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

  // Diigoo, the platform organization.
  const [platform] = await db
    .insert(organizations)
    .values({ kind: "platform", name: "Diigoo Tech Private Limited", slug: "diigoo", status: "active", city: "Hyderabad", state: "Telangana", plan: "internal", languages: ["te", "hi", "en"] })
    .returning();
  for (const s of STAFF) {
    const uid = await ensureUser(s.email, s.name);
    const [m] = await db.insert(memberships).values({ tenantId: platform!.id, userId: uid, title: s.name }).returning();
    await db.insert(roleBindings).values({ tenantId: platform!.id, membershipId: m!.id, roleId: roleIds.get(`platform:${s.role}`)!, scopeType: "org" });
  }
  await audit(db, { tenantId: null, actorUserId: null, via: "system", action: "platform.seeded", summary: "Platform organization and staff created (development seed)" });

  for (const c of CLIENTS) {
    const [org] = await db
      .insert(organizations)
      .values({ kind: "client", parentId: platform!.id, name: c.name, slug: c.slug, status: c.status, vertical: c.vertical, city: c.city, state: "Telangana", plan: c.plan, languages: ["te", "hi", "en"] })
      .returning();
    const tenantId = org!.id;
    const branchIds = new Map<string, string>();
    for (const b of c.branches) {
      const [row] = await db.insert(branches).values({ tenantId, name: b.name, city: b.city, languages: ["te", "hi", "en"] }).returning({ id: branches.id });
      branchIds.set(b.key, row!.id);
    }
    const teamIds = new Map<string, string>();
    for (const p of c.people) {
      const uid = await ensureUser(p.email, p.name);
      const [m] = await db.insert(memberships).values({ tenantId, userId: uid, title: p.name }).returning();
      const branchId = "branch" in p && p.branch ? branchIds.get(p.branch)! : null;
      await db.insert(roleBindings).values({
        tenantId,
        membershipId: m!.id,
        roleId: roleIds.get(`client:${p.role}`)!,
        scopeType: branchId ? "branch" : "org",
        branchId,
      });
      if ("team" in p && p.team) {
        let teamId = teamIds.get(p.team);
        if (!teamId) {
          const [t] = await db.insert(teams).values({ tenantId, name: p.team, branchId, kind: p.team.toLowerCase().replace(/\s+/g, "_") }).returning({ id: teams.id });
          teamId = t!.id;
          teamIds.set(p.team, teamId);
        }
        await db.insert(teamMembers).values({ tenantId, teamId, membershipId: m!.id });
      }
    }
    for (const s of PROVISIONING_STEPS) {
      const st = c.steps[s.key];
      await db.insert(provisioningSteps).values({ tenantId, step: s.key, status: st?.[0] ?? "pending", detail: st?.[1] ?? null });
    }
    await audit(db, { tenantId, actorUserId: null, via: "system", action: "org.seeded", targetType: "organization", targetId: tenantId, summary: `${c.name} created with ${c.people.length} team members (development seed)` });
  }

  // A consultant who belongs to two clients, to exercise the organization switcher.
  const consultant = await ensureUser("consultant@jenai.test", "Visiting Consultant");
  for (const slug of ["zennara", "lbr-dental"]) {
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    const [m] = await db.insert(memberships).values({ tenantId: org!.id, userId: consultant, title: "Consultant" }).returning();
    await db.insert(roleBindings).values({ tenantId: org!.id, membershipId: m!.id, roleId: roleIds.get("client:analyst")!, scopeType: "org" });
  }

  // One pending support request, so the consent flow is visible.
  const [zen] = await db.select().from(organizations).where(eq(organizations.slug, "zennara"));
  await db.insert(supportGrants).values({
    tenantId: zen!.id,
    staffUserId: users.get("support@diigoo.test")!,
    mode: "read",
    reason: "Inbound persona still using the old greeting; need to compare call summaries.",
    ticket: "SUP-1042",
    durationMinutes: 60,
  });

  console.log(`seed: ${users.size} users, ${CLIENTS.length} clients, platform org "diigoo". Password for every login: SEED_PASSWORD from .env`);
}

try {
  await main();
} finally {
  process.exit(0);
}
