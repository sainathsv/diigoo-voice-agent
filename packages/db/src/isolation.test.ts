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
import postgres from "postgres";
import { audit } from "./audit";
import { auditEvents, branches, invitations, memberships, organizations, roleBindings, roles, securityAlerts, securityEvents, supportGrants, user } from "./schema";
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

describe("tamper-evident audit log (migration 0009)", () => {
  const owner = () => postgres(process.env.DATABASE_OWNER_URL!, { max: 1, onnotice: () => {} });

  it("links every new event to the end of its workspace's chain", async () => {
    const [before] = await platformDb().execute<{ n: string }>(sql`select count(*)::text as n from audit_events where chain = ${zennara}`);
    await withTenant(zennara, (tx) => audit(tx, { tenantId: zennara, actorUserId: null, via: "system", action: "test.chain", summary: "chain test" }));
    await withTenant(zennara, (tx) => audit(tx, { tenantId: zennara, actorUserId: null, via: "system", action: "test.chain", summary: "chain test 2" }));
    const rows = await platformDb().execute<{ chain_seq: string; prev_hash: string; hash: string }>(
      sql`select a.chain_seq::text as chain_seq, a.prev_hash, a.hash from audit_events a where a.chain = ${zennara} order by a.chain_seq desc limit 2`,
    );
    expect(Number(rows[0]!.chain_seq)).toBe(Number(before!.n) + 2);
    expect(rows[0]!.prev_hash).toBe(rows[1]!.hash);
    const [v] = await platformDb().execute<{ first_bad_id: string | null }>(sql`select * from lookup.verify_audit_chain(${zennara})`);
    expect(v!.first_bad_id).toBeNull();
  });

  it("stops even the owner role from editing or deleting history", async () => {
    const db = owner();
    // Layer 1: row-level security has no update or delete policy, so nothing matches.
    await db`select set_config('app.tenant_id', ${zennara}, false)`;
    expect((await db`update audit_events set summary = 'rewritten' where chain = ${zennara}`).count).toBe(0);
    expect((await db`delete from audit_events where chain = ${zennara}`).count).toBe(0);
    // Layer 2: an insider who switches layer 1 off still hits the append-only trigger.
    const attempt = (stmt: string) =>
      db.begin(async (tx) => {
        await tx`alter table audit_events no force row level security`;
        await tx.unsafe(stmt);
      });
    try {
      await expect(attempt(`update audit_events set summary = 'rewritten' where chain = '${zennara}'`)).rejects.toThrow(/append-only/);
      await expect(attempt(`delete from audit_events where chain = '${zennara}'`)).rejects.toThrow(/append-only/);
      await expect(attempt(`truncate audit_events`)).rejects.toThrow(/append-only|cannot truncate/);
    } finally {
      await db.end();
    }
  });

  it("detects an edit made by someone who switched the protection off", async () => {
    const db = owner();
    try {
      // Everything happens inside a transaction that is rolled back.
      await db
        .begin(async (tx) => {
          await tx`alter table audit_events no force row level security`;
          await tx`alter table audit_events disable trigger audit_events_no_update`;
          await tx`update audit_events set summary = 'rewritten' where chain = ${zennara} and chain_seq = 1`;
          const [v] = await tx`select first_bad_id, problem from lookup.verify_audit_chain(${zennara})`;
          expect(v!.first_bad_id).not.toBeNull();
          expect(v!.problem).toMatch(/changed/);
          throw new Error("rollback");
        })
        .catch((e) => expect((e as Error).message).toBe("rollback"));
      const [v] = await platformDb().execute<{ first_bad_id: string | null }>(sql`select * from lookup.verify_audit_chain(${zennara})`);
      expect(v!.first_bad_id).toBeNull();
    } finally {
      await db.end();
    }
  });
});

describe("security tables", () => {
  it("lets the app append sign-in events but never read them", async () => {
    await appDb().insert(securityEvents).values({ kind: "signin_failed", email: "probe@test", ip: "203.0.113.9" });
    expect(await pgError(appDb().select().from(securityEvents).limit(1))).toMatch(/permission denied/i);
  });
  it("shows a client only its own security alerts", async () => {
    const key = `test:${randomUUID()}`;
    await platformDb().insert(securityAlerts).values({ tenantId: lbr, rule: "test", severity: "low", title: "t", subject: "s", dedupeKey: key });
    expect(await withTenant(zennara, (tx) => tx.select().from(securityAlerts).where(eq(securityAlerts.dedupeKey, key)))).toHaveLength(0);
    expect(await withTenant(lbr, (tx) => tx.select().from(securityAlerts).where(eq(securityAlerts.dedupeKey, key)))).toHaveLength(1);
    expect(await pgError(withTenant(lbr, (tx) => tx.update(securityAlerts).set({ status: "resolved" }).where(eq(securityAlerts.dedupeKey, key))))).toMatch(/permission denied/i);
    await platformDb().update(securityAlerts).set({ status: "resolved" }).where(eq(securityAlerts.dedupeKey, key));
  });
});
