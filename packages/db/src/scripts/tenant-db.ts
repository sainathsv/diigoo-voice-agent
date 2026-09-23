/**
 * Client-hosted data: stand up one client's records on their own Postgres.
 *
 *   pnpm --filter @jenai/db tenant-db provision --tenant blue-cloud --host 1.2.3.4 --label "Blue Cloud"
 *   pnpm --filter @jenai/db tenant-db check     --tenant blue-cloud
 *   pnpm --filter @jenai/db tenant-db disable   --tenant blue-cloud
 *
 * The client's admin connection comes from TENANT_DB_ADMIN_URL in the
 * environment, never from an argument, so it stays out of shell history and
 * process listings. The roles this script creates get fresh random passwords;
 * the one the app needs is sealed into the registry and never printed.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { eq, isNull } from "drizzle-orm";
import { appDb, dbFor, platformDb, forgetTenantDb, withTenant, sql } from "../client";
import { sealSecret } from "../secrets";
import { agentTemplates, organizations, plans, programTemplates, roles, tenantDatabases } from "../schema";
import { env } from "./env";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const command = process.argv[2] ?? "";
const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const password = () => randomBytes(24).toString("base64url");

/**
 * Rows come back from the query with the property names the code uses
 * (parentId, createdAt); the columns they go back into are named the way SQL
 * writes them (parent_id, created_at). Translate before inserting.
 */
function columns(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
}

async function org(slug: string) {
  const [row] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!row) throw new Error(`No client with the address "${slug}". Create them in the console first.`);
  if (row.kind !== "client") throw new Error(`"${slug}" is not a client workspace.`);
  return row;
}

/** Applies every migration to a database that has none of them. */
async function migrate(sql: postgres.Sql): Promise<number> {
  await sql`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const body = await readFile(path.join(migrationsDir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${f})`;
    });
    applied++;
  }
  return applied;
}

async function provision() {
  const slug = arg("tenant");
  const host = arg("host");
  const port = Number(arg("port", "5432"));
  if (!slug || !host) throw new Error("need --tenant <address> and --host <their server>");
  const client = await org(slug);
  const label = arg("label", client.name);
  const database = arg("database", `jenai_${slug.replace(/-/g, "_")}`);
  const adminUrl = env("TENANT_DB_ADMIN_URL");

  const creds = { owner: password(), app: password(), platform: password() };
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  console.log(`\n${label}: preparing ${database} on ${host}:${port}`);
  try {
    // On a client's own database none of these may bypass row-level security.
    // jenai_platform exists only because the migrations grant privileges to it;
    // we never connect as it here, and the console reads our database, not
    // theirs. Creating it without that attribute also means the provisioning
    // account does not itself need it, since only a role holding BYPASSRLS may
    // grant it to another.
    for (const [role, attrs, pw] of [
      ["jenai_owner", "nobypassrls", creds.owner],
      ["jenai_app", "nobypassrls", creds.app],
      ["jenai_platform", "nobypassrls", creds.platform],
    ] as const) {
      const [exists] = await admin`select 1 from pg_roles where rolname = ${role}`;
      const stmt = `${exists ? "alter" : "create"} role "${role}" with login ${attrs} password '${pw.replace(/'/g, "''")}'`;
      await admin.unsafe(stmt);
    }
    await admin.unsafe(`grant "jenai_platform" to "jenai_owner"`);
    const [who] = await admin<{ me: string }[]>`select current_user as me`;
    for (const role of ["jenai_owner", "jenai_app", "jenai_platform"]) {
      if (role === who!.me) continue;
      await admin.unsafe(`grant "${role}" to "${who!.me}" with set true`).catch(() => admin.unsafe(`grant "${role}" to "${who!.me}"`).catch(() => undefined));
    }
    const [db] = await admin`select 1 from pg_database where datname = ${database}`;
    if (!db) await admin.unsafe(`create database "${database}" owner "jenai_owner"`);
    console.log(`  roles ready, database ${db ? "already existed" : "created"}`);
  } finally {
    await admin.end();
  }

  // Schema, as the owner, over TLS.
  const u = new URL(adminUrl);
  const ownerUrl = `postgres://jenai_owner:${encodeURIComponent(creds.owner)}@${host}:${port}/${database}?sslmode=require`;
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => {}, ssl: { rejectUnauthorized: false } });
  let version = 0;
  try {
    const applied = await migrate(owner);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    version = files.length;
    console.log(`  schema: ${applied} migration(s) applied, now at ${version}`);

    // Their tables key off organizations and the shared catalogues, so those
    // rows travel with them, keeping the same ids so references still resolve.
    const platform = platformDb();
    const parent = client.parentId ? (await platform.select().from(organizations).where(eq(organizations.id, client.parentId)))[0] : null;
    const builtInRoles = await platform.select().from(roles).where(isNull(roles.tenantId));
    const [planRows, templateRows, programRows] = await Promise.all([
      platform.select().from(plans),
      platform.select().from(agentTemplates),
      platform.select().from(programTemplates),
    ]);
    // These tables are seeded, not written by a tenant, and row-level security
    // has no tenant to check them against: the organizations policy admits only
    // a row whose id is the current tenant, and built-in roles carry no tenant
    // at all. The owner owns these tables, so lifting FORCE lets it seed them
    // and nothing else changes. Restored in the same transaction, always.
    const guarded = ["organizations", "roles"] as const;
    await owner.begin(async (tx) => {
      for (const t of guarded) await tx.unsafe(`alter table ${t} no force row level security`);
      for (const o of [parent, client].filter(Boolean)) {
        await tx`insert into organizations ${tx(columns(o as Record<string, unknown>))} on conflict (id) do nothing`;
      }
      for (const r of builtInRoles) await tx`insert into roles ${tx(columns(r as Record<string, unknown>))} on conflict (id) do nothing`;
      for (const p of planRows) await tx`insert into plans ${tx(columns(p as Record<string, unknown>))} on conflict (key) do nothing`;
      for (const t of templateRows) await tx`insert into agent_templates ${tx(columns(t as Record<string, unknown>))} on conflict do nothing`;
      for (const g of programRows) await tx`insert into program_templates ${tx(columns(g as Record<string, unknown>))} on conflict do nothing`;
      for (const t of guarded) await tx.unsafe(`alter table ${t} force row level security`);
    });
    // Belt and braces: if anything above threw, the transaction rolled the
    // tables back with it, but say so out loud rather than assume.
    const [still] = await owner<{ forced: boolean }[]>`
      select bool_and(relforcerowsecurity) as forced from pg_class
      where relname in ('organizations', 'roles') and relnamespace = 'public'::regnamespace`;
    if (!still?.forced) throw new Error("row-level security was left off on their database; refusing to continue");
    console.log(`  catalogues copied: ${builtInRoles.length} roles, ${planRows.length} plans, ${templateRows.length} agent templates, ${programRows.length} programs`);
  } finally {
    await owner.end();
  }

  await platformDb()
    .insert(tenantDatabases)
    .values({
      tenantId: client.id, label, host, port, database, username: "jenai_app",
      secret: sealSecret(client.id, "tenant_db", creds.app),
      sslmode: arg("sslmode", "verify-full"), status: "ready", schemaVersion: version, lastOkAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tenantDatabases.tenantId,
      set: { label, host, port, database, username: "jenai_app", secret: sealSecret(client.id, "tenant_db", creds.app), status: "ready", schemaVersion: version, lastOkAt: new Date(), lastError: null, updatedAt: new Date() },
    });
  await forgetTenantDb(client.id);
  console.log(`  registered. ${label}'s records now live on ${host}, not ours.`);
  console.log(`  admin URL used: ${u.protocol}//${u.username}@${u.host} (password not shown)\n`);
  await check();
}


/**
 * Tenant-owned tables, in an order that satisfies their references. Rows are
 * copied with the app role inside a tenant transaction, exactly as the
 * application writes them, so row-level security stays on throughout and a row
 * belonging to anyone else cannot travel by accident.
 *
 * audit_events and outbox are deliberately absent: the audit log is a hash
 * chain, and re-inserting links elsewhere would either break it or quietly
 * rewrite history. A client's chain stays where it was written.
 */
const TENANT_TABLES = [
  "branches", "teams", "memberships", "team_members", "roles", "role_bindings",
  "invitations", "api_keys", "provisioning_steps", "support_grants", "subscriptions",
  "carrier_accounts", "phone_numbers", "voice_connections", "agents", "agent_versions",
  "contacts", "consents", "suppressions", "client_programs", "campaigns", "campaign_targets",
  "calls", "dial_attempts", "leads", "resources", "appointments",
  "integrations", "integration_events", "external_links",
  "security_events", "security_alerts", "agent_safety_checks",
] as const;

/** Copies one client's existing rows from the shared database onto their own. */
async function move() {
  const client = await org(arg("tenant"));
  const [row] = await platformDb().select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, client.id));
  if (!row) throw new Error(`${client.name} is not on their own database yet. Provision first.`);

  const shared = appDb();
  const theirs = await dbFor(client.id);
  if (shared === theirs) throw new Error("routing still points at the shared database; nothing to move");

  let moved = 0;
  const report: string[] = [];
  for (const table of TENANT_TABLES) {
    const rows = await withTenant(client.id, (tx) => tx.execute(sql.raw(`select * from ${table}`)), shared);
    if (!rows.length) continue;
    await withTenant(client.id, async (tx) => {
      for (const r of rows as Record<string, unknown>[]) {
        const cols = Object.keys(r);
        const names = sql.raw(cols.map((c) => `"${c}"`).join(", "));
        const values = sql.join(cols.map((c) => sql`${r[c]}`), sql`, `);
        await tx.execute(sql`insert into ${sql.raw(table)} (${names}) values (${values}) on conflict do nothing`);
      }
    }, theirs);
    report.push(`${table} ${rows.length}`);
    moved += rows.length;
  }
  console.log(moved ? `Moved ${moved} row(s) to ${row.label}: ${report.join(", ")}` : "Nothing to move.");
}

async function check() {
  const slug = arg("tenant");
  const client = await org(slug);
  const [row] = await platformDb().select().from(tenantDatabases).where(eq(tenantDatabases.tenantId, client.id));
  if (!row) return console.log(`${client.name} uses the shared database.`);
  try {
    // Read it back the way the application does: as the app role, inside a
    // tenant-scoped transaction. Row-level security hides everything from a
    // connection that has not said which tenant it is acting for, so a read
    // without that context proves nothing.
    const [there] = await withTenant(client.id, (tx) =>
      tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, client.id)),
    );
    const ok = there?.slug === slug;
    await platformDb().update(tenantDatabases).set(ok ? { status: "ready", lastOkAt: new Date(), lastError: null } : { status: "unreachable", lastError: "their database does not carry this client's own row" }).where(eq(tenantDatabases.tenantId, client.id));
    console.log(ok
      ? `${row.label}: reachable on ${row.host}:${row.port}/${row.database}, schema ${row.schemaVersion}, TLS ${row.sslmode}.`
      : `${row.label}: connected, but their database does not carry this client's own row.`);
  } catch (e) {
    await platformDb().update(tenantDatabases).set({ status: "unreachable", lastError: String((e as Error).message).slice(0, 300) }).where(eq(tenantDatabases.tenantId, client.id));
    console.log(`${row.label}: NOT reachable. ${(e as Error).message}`);
  }
}

async function disable() {
  const client = await org(arg("tenant"));
  await platformDb().update(tenantDatabases).set({ status: "disabled", updatedAt: new Date() }).where(eq(tenantDatabases.tenantId, client.id));
  await forgetTenantDb(client.id);
  console.log(`${client.name} is back on the shared database. Their own server still holds the rows; nothing was deleted.`);
}

const run = { provision, check, disable, move }[command as "provision" | "check" | "disable" | "move"];
if (!run) {
  console.log("usage: tenant-db <provision|check|disable|move> --tenant <address> [--host <server>] [--port 5432] [--database <name>] [--label <name>]");
  process.exit(1);
}
await run();
process.exit(0);
