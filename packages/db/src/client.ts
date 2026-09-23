import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { openSecret } from "./secrets";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Pools = { app?: Db; platform?: Db };
/** One pool per client-hosted database, plus the lookup that found it. */
type TenantPool = { db: Db; checkedAt: number };
const tenantPools = new Map<string, TenantPool>();
/** How long we trust the registry before looking again. Short enough that disabling a client takes effect quickly. */
const REGISTRY_TTL_MS = 60_000;
// Reuse pools across Next.js dev hot reloads.
const g = globalThis as unknown as { __jenaiPools?: Pools };
const pools: Pools = (g.__jenaiPools ??= {});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** App pool: role jenai_app, subject to row-level security. */
export function appDb(): Db {
  return (pools.app ??= drizzle(postgres(required("DATABASE_URL"), { max: 10 }), { schema }));
}

/**
 * Platform pool: role jenai_platform (BYPASSRLS). Only for the Diigoo console,
 * only after requirePlatform() succeeded. Never import this in client-workspace code.
 */
export function platformDb(): Db {
  return (pools.platform ??= drizzle(postgres(required("DATABASE_PLATFORM_URL"), { max: 5 }), { schema }));
}

/**
 * Run fn inside a transaction bound to one tenant. Row-level security then
 * filters every table to that tenant. The setting is transaction-local
 * (set_config(..., true)), so it never leaks to another request on a pooled connection.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, db?: Db): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("withTenant: invalid tenant id");
  const target = db ?? (await dbFor(tenantId));
  return target.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * The database holding one client's own records.
 *
 * Most clients live in the shared database and this returns appDb(). A client
 * with a row in tenant_databases keeps their records on their own Postgres, and
 * this returns a pool pointed at it. Callers do not need to know which.
 *
 * The connection is assembled from the registry's separate fields, never from a
 * stored URL, so a tampered row cannot smuggle in connection options. TLS is
 * required and the server's identity is verified unless the client's row says
 * otherwise, which only a platform admin can set.
 */
export async function dbFor(tenantId: string): Promise<Db> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("dbFor: invalid tenant id");
  const cached = tenantPools.get(tenantId);
  if (cached && Date.now() - cached.checkedAt < REGISTRY_TTL_MS) return cached.db;

  const [row] = await platformDb()
    .select()
    .from(schema.tenantDatabases)
    .where(eq(schema.tenantDatabases.tenantId, tenantId));

  if (!row || row.status === "disabled") {
    if (cached) {
      tenantPools.delete(tenantId);
      void (cached.db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    }
    return appDb();
  }
  if (row.status === "pending" || row.status === "migrating") {
    throw new Error(`${row.label}: their database is not ready yet (${row.status}).`);
  }
  if (cached) return (cached.checkedAt = Date.now()), cached.db;

  const db = drizzle(
    postgres({
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: openSecret(tenantId, "tenant_db", row.secret),
      max: 5,
      idle_timeout: 60,
      connect_timeout: 10,
      ssl:
        row.sslmode === "verify-full"
          ? { rejectUnauthorized: true, ...(row.caCertificate ? { ca: row.caCertificate } : {}) }
          : row.sslmode === "require"
            ? { rejectUnauthorized: false }
            : (() => {
                throw new Error(`${row.label}: sslmode ${row.sslmode} is not allowed; client data must travel encrypted.`);
              })(),
    }),
    { schema },
  );
  tenantPools.set(tenantId, { db, checkedAt: Date.now() });
  return db;
}

/**
 * Run a tenant-scoped transaction against OUR database, even for a client whose
 * records live on their own server.
 *
 * Five things stay here whatever a client hosts, and each for a reason:
 *   billing        a client must not be able to edit their own subscription;
 *   API keys       our API authenticates against them, so their outage would
 *                  otherwise lock everyone out of their own integrations;
 *   security events and alerts
 *                  our record of abuse. Evidence is not kept where the subject
 *                  of it can delete it;
 *   audit anchors  the chain follows the client, but the hourly fingerprint
 *                  stays here, so tampering with their copy still shows up;
 *   the registry   the map to their database cannot live inside it.
 *
 * Use this deliberately. Everything else belongs in withTenant().
 */
export function withCentralTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(tenantId, fn, appDb());
}

/** Drops a cached pool, so the next call re-reads the registry. Use after changing a client's database. */
export async function forgetTenantDb(tenantId: string): Promise<void> {
  const p = tenantPools.get(tenantId);
  if (!p) return;
  tenantPools.delete(tenantId);
  await (p.db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

export { sql };
