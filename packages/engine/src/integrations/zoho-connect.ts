import { and, eq } from "drizzle-orm";
import { externalLinks, integrations, type Integration, type Tx } from "@jenai/db";
import { assertClientUrl } from "@jenai/voice";
import { sealCredentials } from "./queue";
import { ACCOUNTS, zohoScopes } from "./zoho";

/**
 * The one-time step Zoho makes you do by hand: trade the short-lived grant code
 * from their console for a refresh token, which is the credential that lasts.
 *
 * The grant code dies in ten minutes and can only be spent once. The refresh
 * token it returns does not expire, and everything afterwards mints access
 * tokens from it.
 *
 * The data centre has to match the one the code was issued in. A code from the
 * India console redeemed against accounts.zoho.com fails with invalid_code,
 * which reads like a typo and sends people back for another code.
 *
 * The scopes come back when Zoho lists them in its answer: that is what their
 * admin actually granted, and the connector writes only within it. Zoho's own
 * samples for this call do not always show the list, so null means "Zoho did
 * not say", never "nothing granted".
 */
export async function exchangeGrantCode(input: {
  dc: string;
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; apiDomain: string | null; scopes: string[] | null }> {
  const accounts = ACCOUNTS[input.dc.toLowerCase()];
  if (!accounts) throw new Error(`Unknown Zoho data centre "${input.dc}". One of: ${Object.keys(ACCOUNTS).join(", ")}.`);
  const url = `${accounts}/oauth/v2/token`;
  await assertClientUrl(url);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
  });
  const res = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "error",
  });
  const j = (await res.json().catch(() => ({}))) as {
    refresh_token?: string; access_token?: string; expires_in?: number; api_domain?: string; scope?: string; error?: string;
  };

  if (j.error === "invalid_code") {
    throw new Error("Zoho rejected the grant code. It expires ten minutes after it is issued and works only once, and it must be redeemed in the data centre that issued it. Generate a fresh one.");
  }
  if (j.error) throw new Error(`Zoho refused the exchange: ${j.error}`);
  if (!j.refresh_token) {
    throw new Error("Zoho returned an access token but no refresh token. That happens when the code has already been spent once: generate a fresh one and redeem it only here.");
  }
  return {
    refreshToken: j.refresh_token,
    accessToken: j.access_token ?? "",
    expiresIn: j.expires_in ?? 3600,
    apiDomain: j.api_domain ?? null,
    scopes: zohoScopes(j.scope),
  };
}

/**
 * What a new Zoho connection takes: every event it can write something for.
 * A lead's stage reaches Zoho only through a field mapping, so lead.updated is
 * taken only once one is set (zohoConnector.wants).
 */
const ZOHO_EVENTS = ["call.completed", "lead.updated", "appointment.booked", "do_not_call.added"];

/**
 * Puts a Zoho grant on the client's Zoho connection, or makes the connection
 * if they have none.
 *
 * Connecting again is how their admin re-grants a scope, so it must not undo
 * what the client set up: record creation, what to pull, the field mapping,
 * the name, and which events it takes stay. `setup` is for a new connection
 * only; `module` changes the module on purpose (the script's --module).
 *
 * The scopes are the new grant's, or none recorded when Zoho did not list
 * them: the old ones went with the old token, and keeping them would hide a
 * scope the new grant adds. Unknown scopes are safe, because a write Zoho
 * refuses for lack of one is remembered and left out (zoho.ts), not taken as
 * the connection failing; what was refused under the old grant is forgotten.
 *
 * A grant from another data centre is another Zoho account, where the
 * records we linked people to do not exist, so those links go.
 *
 * It stays a draft until a test shows Zoho answers. Events are still queued
 * for it meanwhile, and wait.
 */
export async function saveZohoConnection(
  tx: Tx,
  tenantId: string,
  grant: {
    dc: string;
    credentials: Record<string, string>;
    scopes: string[] | null;
    module?: string;
    setup?: { name?: string; module?: string; events?: string[] };
    createdBy?: string;
  },
): Promise<{ integration: Integration; reconnected: boolean }> {
  const [existing] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.kind, "zoho_crm")))
    .orderBy(integrations.createdAt)
    .limit(1);
  const kept: Record<string, unknown> = { ...existing?.config };
  delete kept.scopes;
  delete kept.denied;
  const module = grant.module ?? (existing ? String(kept.module ?? "Leads") : (grant.setup?.module ?? "Leads"));
  const row = {
    name: existing?.name ?? grant.setup?.name ?? `Zoho CRM (${grant.dc})`,
    status: "draft" as const,
    config: { ...kept, dc: grant.dc, module, ...(grant.scopes ? { scopes: grant.scopes } : {}) },
    events: existing?.events ?? grant.setup?.events ?? ZOHO_EVENTS,
    credentials: sealCredentials(tenantId, grant.credentials),
    lastError: null,
    lastErrorAt: null,
    updatedAt: new Date(),
  };
  if (existing) {
    if (String(existing.config.dc ?? "in") !== grant.dc) await tx.delete(externalLinks).where(eq(externalLinks.integrationId, existing.id));
    const [i] = await tx.update(integrations).set(row).where(and(eq(integrations.tenantId, tenantId), eq(integrations.id, existing.id))).returning();
    return { integration: i!, reconnected: true };
  }
  const [i] = await tx.insert(integrations).values({ tenantId, kind: "zoho_crm", direction: "both", createdBy: grant.createdBy, ...row }).returning();
  return { integration: i!, reconnected: false };
}
