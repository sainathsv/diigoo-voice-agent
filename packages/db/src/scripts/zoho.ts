/**
 * Connect a client's Zoho CRM, or connect it again after their admin changed
 * what JENAI may do. Or read it now for the call plan.
 *
 *   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_CODE=... \
 *     pnpm --filter @jenai/db zoho connect --tenant zennara --dc in --module Leads
 *
 *   pnpm --filter @jenai/db zoho pull --tenant zennara [--pages 10]
 *
 * pull reads what changed in their Leads and Contacts since the last read
 * (read only), plans everyone's calls again and prints counts: per module,
 * and per journey and verdict. Nothing is dialled and nothing is written to
 * Zoho. It never prints a name or number.
 *
 * The three secrets come from the environment, never from arguments, so they
 * stay out of shell history and the process list. The grant code is spent here
 * once, and what gets stored is the refresh token, which does not expire.
 * Connecting again keeps the connection's settings; --module changes only
 * which records it writes to.
 *
 * Their admin grants, in the Zoho API console: ZohoCRM.modules.ALL (or the
 * READ, CREATE and UPDATE scopes of the modules JENAI writes to),
 * ZohoSearch.securesearch.READ, without which no caller can be found by
 * number, and ZohoCRM.settings.READ.
 */
import "./env";
import { eq } from "drizzle-orm";
import { exchangeGrantCode, pullAndPlan, pullableConnections, saveZohoConnection, testConnection } from "@jenai/engine";
import { organizations, platformDb, withTenant } from "../index";
import { planTable, when } from "./plan-text";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Put the three Zoho secrets in the environment, not on the command line.`);
  return v;
};

async function connect() {
  const slug = arg("tenant");
  if (!slug) throw new Error("need --tenant <address>");
  const dc = arg("dc", "in");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) throw new Error(`No client with the address "${slug}".`);

  console.log(`\n${org.name}: exchanging the grant code at the ${dc} data centre`);
  const t = await exchangeGrantCode({ dc, clientId: need("ZOHO_CLIENT_ID"), clientSecret: need("ZOHO_CLIENT_SECRET"), code: need("ZOHO_CODE") });
  console.log(`  got a refresh token${t.apiDomain ? `, api domain ${t.apiDomain}` : ""}`);
  console.log(t.scopes ? `  granted: ${t.scopes.join(" ")}` : "  Zoho did not list the scopes it granted, so none are recorded: each write will be tried, and one Zoho refuses is left out from then on.");

  const saved = await withTenant(org.id, (tx) =>
    saveZohoConnection(tx, org.id, {
      dc,
      module: arg("module") || undefined,
      scopes: t.scopes,
      credentials: {
        client_id: need("ZOHO_CLIENT_ID"),
        client_secret: need("ZOHO_CLIENT_SECRET"),
        refresh_token: t.refreshToken,
        access_token: t.accessToken,
        access_token_until: String(Date.now() + t.expiresIn * 1000),
      },
    }),
  );

  // Ask Zoho whether this actually works before calling it connected. Holding a
  // valid token proves the handshake, not that the CRM will answer: an account
  // without API access authorises happily and then refuses every request.
  const state = await withTenant(org.id, (tx) => testConnection(tx, org.id, saved.integration));

  console.log(`  ${saved.reconnected ? "reconnected, settings kept" : "stored"} against ${org.name}, writing to ${String(saved.integration.config.module)}.`);
  console.log(state.ok ? `  VERIFIED: ${state.message}` : `  STORED BUT NOT WORKING: ${state.message}`);
  console.log(`  The grant code is now spent. The refresh token is sealed and does not expire.\n`);
}

async function pull() {
  const slug = arg("tenant");
  if (!slug) throw new Error("need --tenant <address>");
  const pages = Math.max(1, Math.floor(Number(arg("pages", "10")) || 10));
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org || org.kind !== "client") throw new Error(`No client with the address "${slug}".`);
  const connections = await pullableConnections(org.id);
  if (!connections.length) {
    console.error(`\n  ${org.name} has no connection JENAI can read records from. Connect Zoho first with: zoho connect --tenant ${slug}\n`);
    process.exit(1);
  }

  for (const c of connections) {
    console.log(`\n${org.name}: reading ${c.name} (${c.status}), up to ${pages} requests`);
    const r = await pullAndPlan(org.id, c.id, { pageBudget: pages });
    if (!r.sync.ran) {
      console.log("  Another read of this connection is running now. Try again in a few minutes.");
      continue;
    }
    for (const m of r.sync.modules) {
      const state = m.skipped ? "left out" : m.error ? "stopped" : m.done ? "caught up" : "more to read";
      console.log(`  ${m.module.padEnd(10)} ${String(m.read).padStart(6)} read  ${String(m.deleted).padStart(5)} deleted  ${state}`);
      for (const n of m.notes ?? []) console.log(`    note: ${n}`);
    }
    console.log(`  requests   ${r.sync.pages}`);
    if (r.sync.error) console.log(`  problem    ${r.sync.error}`);
    if (r.planError) console.log(`  problem    ${r.planError}`);
    if (r.plan) {
      console.log(`\n  call plan  ${r.plan.people} people, ${r.plan.rows} rows (${r.plan.removed} no longer apply)`);
      for (const line of planTable(r.plan.byVerdict, r.plan.byJourney)) console.log(`  ${line}`);
    }
    if (r.nextPullAt) console.log(`\n  next scheduled read ${when(r.nextPullAt, org.timezone)} (when the worker reads on a timer)`);
  }
  console.log("  Nothing was dialled and nothing was written to Zoho. This is the plan only.\n");
}

const command = process.argv[2];
if (command === "connect") await connect();
else if (command === "pull") await pull();
else {
  console.log(
    "usage: zoho connect --tenant <address> [--dc in] [--module Leads]\n  with ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_CODE in the environment\n" +
      "       zoho pull --tenant <address> [--pages 10]",
  );
  process.exit(1);
}
process.exit(0);
