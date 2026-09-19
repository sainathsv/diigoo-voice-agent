/**
 * Cross-tenant isolation, enforced by Postgres row-level security.
 * Runs against the local database as the app role (jenai_app), exactly like
 * the web app. Requires `pnpm db:migrate && pnpm db:seed` first.
 */
import "./scripts/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appDb, platformDb, withTenant } from "./client";
import { auditEvents, branches, memberships, organizations, supportGrants, user } from "./schema";

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
