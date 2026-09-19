/**
 * Cross-tenant isolation, enforced by Postgres row-level security.
 * Runs against the local database as the app role (jenai_app), exactly like
 * the web app. Requires `pnpm db:migrate && pnpm db:seed` first.
 */
import "./scripts/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appDb, platformDb, withTenant } from "./client";
import { auditEvents, branches, invitations, memberships, organizations, roleBindings, roles, supportGrants, user } from "./schema";
import { and, isNull } from "drizzle-orm";

let zennara = "";
let lbr = "";

beforeAll(async () => {
  const orgs = await platformDb().select({ id: organizations.id, slug: organizations.slug }).from(organizations);
  zennara = orgs.find((o) => o.slug === "zennara")!.id;
  lbr = orgs.find((o) => o.slug === "lbr-dental")!.id;
  expect(zennara && lbr).toBeTruthy();
});

afterAll(async () => {
  // Pools are reused process-wide; let vitest exit cleanly.
});

/** Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is on .cause. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.cause?.message ?? ""} ${err.message ?? ""}`;
  }
  return "no error";
}

describe("row-level security (app role)", () => {
  it("returns nothing when no tenant is set", async () => {
    const rows = await appDb().select().from(branches);
    expect(rows).toHaveLength(0);
    const orgs = await appDb().select().from(organizations);
    expect(orgs).toHaveLength(0);
  });

  it("shows only the current tenant's rows", async () => {
    const rows = await withTenant(zennara, (tx) => tx.select().from(branches));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === zennara)).toBe(true);
    const orgs = await withTenant(zennara, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.id)).toEqual([zennara]);
  });

  it("hides another tenant's rows even when asked for them by id", async () => {
    const rows = await withTenant(zennara, (tx) => tx.select().from(memberships).where(eq(memberships.tenantId, lbr)));
    expect(rows).toHaveLength(0);
  });

  it("refuses to write a row into another tenant", async () => {
    const msg = await pgError(
      withTenant(zennara, (tx) => tx.insert(branches).values({ tenantId: lbr, name: "Injected", languages: ["en"] })),
    );
    expect(msg).toMatch(/row-level security/i);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(zennara, (tx) =>
      tx.update(branches).set({ name: "Hijacked" }).where(eq(branches.tenantId, lbr)).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(zennara, (tx) => tx.delete(supportGrants).where(eq(supportGrants.tenantId, lbr)).returning());
    expect(deleted).toHaveLength(0);
  });

  it("does not leak the tenant setting to the next transaction on the same pool", async () => {
    await withTenant(zennara, (tx) => tx.select().from(branches));
    const after = await appDb().execute(sql`select current_setting('app.tenant_id', true) as t`);
    expect([null, ""]).toContain((after as unknown as Array<{ t: string | null }>)[0]?.t ?? null);
    expect(await appDb().select().from(branches)).toHaveLength(0);
  });

  it("keeps the audit log append-only", async () => {
    expect(await pgError(withTenant(zennara, (tx) => tx.update(auditEvents).set({ summary: "edited" })))).toMatch(/permission denied/i);
    expect(await pgError(withTenant(zennara, (tx) => tx.delete(auditEvents)))).toMatch(/permission denied/i);
  });

  it("lists a user's organizations only through the narrow lookup function", async () => {
    const [consultant] = await platformDb().select().from(user).where(eq(user.email, "consultant@jenai.test"));
    const orgs = await appDb().execute(sql`select slug from lookup.my_organizations(${consultant!.id})`);
    const slugs = (orgs as unknown as Array<{ slug: string }>).map((r) => r.slug).sort();
    expect(slugs).toEqual(["lbr-dental", "zennara"]);
  });

  it("does not let the app role bypass row-level security", async () => {
    const r = await appDb().execute(sql`select rolbypassrls from pg_roles where rolname = current_user`);
    expect((r as unknown as Array<{ rolbypassrls: boolean }>)[0]?.rolbypassrls).toBe(false);
  });
});


describe("invitations (lookup.accept_invitation)", () => {
  async function invite(email: string) {
    const token = randomBytes(24).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    const [frontDesk] = await platformDb().select().from(roles).where(and(eq(roles.key, "front_desk"), isNull(roles.tenantId)));
    const [br] = await platformDb().select().from(branches).where(eq(branches.tenantId, zennara));
    await withTenant(zennara, (tx) =>
      tx.insert(invitations).values({ tenantId: zennara, email, roleId: frontDesk!.id, scopeType: "branch", branchId: br!.id, tokenHash: hash, expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    return hash;
  }
  async function newUser(email: string) {
    const id = randomUUID();
    await platformDb().insert(user).values({ id, email, name: "Test Person" });
    return id;
  }
  const accept = (hash: string, userId: string) => pgError(appDb().execute(sql`select lookup.accept_invitation(${hash}, ${userId})`));

  it("refuses a user whose email does not match", async () => {
    const hash = await invite(`fd-${randomUUID().slice(0, 8)}@zennara.test`);
    const other = await newUser(`other-${randomUUID().slice(0, 8)}@example.test`);
    expect(await accept(hash, other)).toMatch(/invitation_email_mismatch/);
  });

  it("joins the right tenant with the invited role and branch, once", async () => {
    const email = `fd-${randomUUID().slice(0, 8)}@zennara.test`;
    const hash = await invite(email);
    const uid = await newUser(email);
    expect(await accept(hash, uid)).toBe("no error");
    const rows = await withTenant(zennara, (tx) =>
      tx.select({ scope: roleBindings.scopeType, branchId: roleBindings.branchId }).from(roleBindings).innerJoin(memberships, eq(memberships.id, roleBindings.membershipId)).where(eq(memberships.userId, uid)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe("branch");
    expect(await accept(hash, uid)).toMatch(/invitation_not_pending/);
    // Nothing leaked into another tenant.
    expect(await withTenant(lbr, (tx) => tx.select().from(memberships).where(eq(memberships.userId, uid)))).toHaveLength(0);
  });
});
