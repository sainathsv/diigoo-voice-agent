/**
 * Connect a client's Zoho CRM, or connect it again after their admin changed
 * what JENAI may do.
 *
 *   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_CODE=... \
 *     pnpm --filter @jenai/db zoho connect --tenant zennara --dc in --module Leads
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
import { exchangeGrantCode, saveZohoConnection, testConnection } from "@jenai/engine";
import { organizations, platformDb, withTenant } from "../index";

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

if (process.argv[2] !== "connect") {
  console.log("usage: zoho connect --tenant <address> [--dc in] [--module Leads]\n  with ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_CODE in the environment");
  process.exit(1);
}
await connect();
process.exit(0);
