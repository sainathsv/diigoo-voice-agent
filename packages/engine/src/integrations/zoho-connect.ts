import { assertClientUrl } from "@jenai/voice";
import { ACCOUNTS } from "./zoho";

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
 */
export async function exchangeGrantCode(input: {
  dc: string;
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; apiDomain: string | null }> {
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
    refresh_token?: string; access_token?: string; expires_in?: number; api_domain?: string; error?: string;
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
  };
}
