/**
 * Connect a client's Zoho CRM.
 *
 *   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_CODE=... \
 *     pnpm --filter @jenai/db zoho connect --tenant zennara --dc in --module Leads
 *
 * The three secrets come from the environment, never from arguments, so they
 * stay out of shell history and the process list. The grant code is spent here
 * once, and what gets stored is the refresh token, which does not expire.
 */
import "./env";
import { eq, and } from "drizzle-orm";
import { exchangeGrantCode, sealCredentials } from "@jenai/engine";
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
  const crmModule = arg("module", "Leads");
  const [org] = await platformDb().select().from(organizations).where(eq(organizations.slug, slug));
  if (!org) throw new Error(`No client with the address "${slug}".`);

  console.log(`\n${org.name}: exchanging the grant code at the ${dc} data centre`);
  const t = await exchangeGrantCode({ dc, clientId: need("ZOHO_CLIENT_ID"), clientSecret: need("ZOHO_CLIENT_SECRET"), code: need("ZOHO_CODE") });
  console.log(`  got a refresh token${t.apiDomain ? `, api domain ${t.apiDomain}` : ""}`);

  // sealCredentials, never sealSecret by hand: the purpose is part of the seal,
  // and a mismatch stores a blob nothing can open.
  const credentials = sealCredentials(org.id, {
    client_id: need("ZOHO_CLIENT_ID"),
    client_secret: need("ZOHO_CLIENT_SECRET"),
    refresh_token: t.refreshToken,
    access_token: t.accessToken,
    access_token_until: String(Date.now() + t.expiresIn * 1000),
  });

  await withTenant(org.id, async (tx) => {
    const [existing] = await tx.select().from(integrations).where(and(eq(integrations.kind, "zoho_crm"), eq(integrations.tenantId, org.id)));
    const row = {
      kind: "zoho_crm" as const,
      name: `Zoho CRM (${dc})`,
      status: "connected" as const,
      config: { dc, module: crmModule },
      events: ["call.completed", "lead.created", "lead.updated", "appointment.booked", "do_not_call.added"],
      credentials,
      direction: "both",
      lastOkAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    };
    if (existing) await tx.update(integrations).set(row).where(and(eq(integrations.id, existing.id), eq(integrations.tenantId, org.id)));
    else await tx.insert(integrations).values({ tenantId: org.id, ...row });
  });

  console.log(`  stored against ${org.name}, writing to ${crmModule}.`);
  console.log(`  The grant code is now spent. The refresh token is sealed and does not expire.\n`);
}

if (process.argv[2] !== "connect") {
  console.log("usage: zoho connect --tenant <address> [--dc in] [--module Leads]\n  with ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_CODE in the environment");
  process.exit(1);
}
await connect();
process.exit(0);
