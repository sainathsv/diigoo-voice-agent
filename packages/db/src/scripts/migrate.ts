/**
 * Forward-only SQL migrations, applied in filename order as the owner role.
 * Each file runs in its own transaction and is recorded in schema_migrations.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { env } from "./env";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const sql = postgres(env("DATABASE_OWNER_URL"), { max: 1, onnotice: () => {} });

try {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const body = await readFile(path.join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${f})`;
    });
    console.log(`applied ${f}`);
    applied++;
  }
  console.log(applied ? `${applied} migration(s) applied` : "database is up to date");
} finally {
  await sql.end();
}
