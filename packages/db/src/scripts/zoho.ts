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
 */
import "./env";
import { eq, and } from "drizzle-orm";
import { credentialsOf, exchangeGrantCode, saveZohoConnection, sealCredentials, zohoConnector } from "@jenai/engine";
import { integrations, organizations, platformDb, withTenant } from "../index";

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
  console.log(t.scopes ? `  granted: ${t.scopes.join(" ")}` : "  Zoho did not list the scopes it granted, so none are recorded: each write will be tried.");

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
  const id = saved.integration.id;

  // Ask Zoho whether this actually works before calling it connected. Holding a
  // valid token proves the handshake, not that the CRM will answer: an account
  // without API access authorises happily and then refuses every request.
  const state = await withTenant(org.id, async (tx) => {
    const [i] = await tx.select().from(integrations).where(and(eq(integrations.id, id), eq(integrations.tenantId, org.id)));
    const res = await zohoConnector.test({
      integration: i!,
      credentials: credentialsOf(i!),
      fetch,
      async save(patch) {
        // sealCredentials, never sealSecret by hand: the purpose is part of the
        // seal, and a mismatch stores a blob nothing can open.
        await tx.update(integrations)
          .set({ ...(patch.credentials ? { credentials: sealCredentials(org.id, patch.credentials) } : {}), ...(patch.config ? { config: { ...i!.config, ...patch.config } } : {}), updatedAt: new Date() })
          .where(and(eq(integrations.id, i!.id), eq(integrations.tenantId, org.id)));
      },
    });
    await tx.update(integrations)
      .set({ status: res.ok ? "connected" : "error", lastOkAt: res.ok ? new Date() : null, lastError: res.ok ? null : res.message, lastErrorAt: res.ok ? null : new Date(), updatedAt: new Date() })
      .where(and(eq(integrations.id, i!.id), eq(integrations.tenantId, org.id)));
    return res;
  });

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
