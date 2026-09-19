import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Pools = { app?: Db; platform?: Db };
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
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, db: Db = appDb()): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error("withTenant: invalid tenant id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export { sql };
