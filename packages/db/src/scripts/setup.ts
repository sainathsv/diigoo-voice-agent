/**
 * One-time local setup: creates the three database roles and the database.
 * Needs a Postgres superuser (on a Mac with Homebrew Postgres, the login user).
 *   pnpm db:setup           create if missing
 *   pnpm db:setup --drop    drop and recreate the database (local only)
 */
import postgres from "postgres";
import { env } from "./env";

const drop = process.argv.includes("--drop");
const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres:///postgres";

function parts(url: string) {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), db: u.pathname.slice(1) };
}

const owner = parts(env("DATABASE_OWNER_URL"));
const app = parts(env("DATABASE_URL"));
const plat = parts(env("DATABASE_PLATFORM_URL"));

if (drop && process.env.NODE_ENV === "production") throw new Error("refusing to drop in production");

const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });

// Roles are NOSUPERUSER by default. Never say so out loud: a managed database's
// administrator is not a superuser and refuses to set that attribute at all.
async function ensureRole(name: string, password: string, attrs: string) {
  const [r] = await sql`select 1 from pg_roles where rolname = ${name}`;
  if (r) await sql.unsafe(`alter role "${name}" with login ${attrs} password '${password.replace(/'/g, "''")}'`);
  else await sql.unsafe(`create role "${name}" with login ${attrs} password '${password.replace(/'/g, "''")}'`);
}

try {
  await ensureRole(owner.user, owner.password, "nobypassrls");
  await ensureRole(app.user, app.password, "nobypassrls");
  await ensureRole(plat.user, plat.password, "bypassrls");
  // The owner must be able to hand function ownership to the platform role (SECURITY DEFINER lookups).
  await sql.unsafe(`grant "${plat.user}" to "${owner.user}"`);
  // On a managed database (RDS) the administrator is not a superuser, so it has
  // to be a member of a role before it can create a database owned by it.
  const [who] = await sql<{ me: string }[]>`select current_user as me`;
  const me = who!.me;
  for (const role of [owner.user, app.user, plat.user]) {
    if (role === me) continue;
    await sql.unsafe(`grant "${role}" to "${me}" with set true`).catch(async () => {
      await sql.unsafe(`grant "${role}" to "${me}"`).catch(() => undefined); // older servers
    });
  }

  if (drop) {
    await sql.unsafe(`drop database if exists "${owner.db}" with (force)`);
    console.log(`dropped ${owner.db}`);
  }
  const [d] = await sql`select 1 from pg_database where datname = ${owner.db}`;
  if (!d) {
    await sql.unsafe(`create database "${owner.db}" owner "${owner.user}"`);
    console.log(`created database ${owner.db}`);
  }
  // Some clusters keep public owned by the bootstrap superuser; hand it to the owner role.
  const adminOnDb = new URL(adminUrl);
  adminOnDb.pathname = `/${owner.db}`;
  const dbSql = postgres(adminOnDb.toString(), { max: 1, onnotice: () => {} });
  try {
    await dbSql.unsafe(`alter schema public owner to "${owner.user}"`);
    await dbSql.unsafe(`revoke create on schema public from public`);
  } finally {
    await dbSql.end();
  }
  console.log(`roles ready: ${owner.user} (owner), ${app.user} (row-level security), ${plat.user} (console, bypass)`);
} finally {
  await sql.end();
}
