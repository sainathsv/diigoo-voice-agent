import { createHmac, timingSafeEqual } from "node:crypto";
import { assertClientUrl } from "@jenai/voice";
import { applyMapping, retryable, type Connector, type ConnectorContext, type OutEvent, type SendResult } from "./types";

/**
 * Two connectors that need no vendor at all:
 *   webhook_out   signed HTTP push to an endpoint the client owns
 *   rest_generic  a call into their own API, with the fields mapped to theirs
 *
 * Both refuse internal addresses (the SSRF guard), so a client cannot point
 * JENAI at our own network or the cloud metadata service.
 */

const TIMEOUT_MS = 15_000;

/** `t=<unix seconds>,v1=<hex>` over `<t>.<body>`, the way Stripe and Slack do it. */
export function signPayload(secret: string, body: string, atSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${atSeconds}.${body}`).digest("hex");
  return `t=${atSeconds},v1=${mac}`;
}

/** For the client's own code: check a signature we sent, inside a five-minute window. */
export function verifySignature(secret: string, body: string, header: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1 ?? "", "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function post(ctx: ConnectorContext, url: string, headers: Record<string, string>, body: string, method = "POST"): Promise<SendResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // A client typed this address: our own network is never a valid destination.
    await assertClientUrl(url);
    const res = await ctx.fetch(url, { method, headers, body, signal: ctrl.signal, redirect: "error" });
    const text = (await res.text().catch(() => "")).slice(0, 2000);
    return { ok: res.ok, httpStatus: res.status, response: text, retry: retryable(res.status) };
  } catch (e) {
    const blocked = (e as Error).name === "BlockedUrlError";
    return { ok: false, response: (e as Error).message.slice(0, 300), retry: !blocked };
  } finally {
    clearTimeout(timer);
  }
}

export const webhookConnector: Connector = {
  kind: "webhook_out",
  async test(ctx) {
    const url = String(ctx.integration.config.url ?? "");
    if (!url) return { ok: false, message: "No address to send to." };
    const r = await this.send(ctx, { id: "test", kind: "ping", idempotencyKey: `ping-${Date.now()}`, externalId: null, payload: { event: "ping", at: new Date().toISOString() } });
    return r.ok ? { ok: true, message: `Your endpoint answered ${r.httpStatus}.` } : { ok: false, message: `Your endpoint answered ${r.httpStatus ?? "nothing"}: ${r.response ?? ""}`.slice(0, 200) };
  },
  async send(ctx, e) {
    const url = String(ctx.integration.config.url ?? "");
    if (!url) return { ok: false, response: "No address configured", retry: false };
    const body = JSON.stringify(applyMapping(e.payload, ctx.integration.mapping?.[e.kind]));
    const secret = ctx.credentials.signing_secret ?? "";
    return post(ctx, url, {
      "Content-Type": "application/json",
      "User-Agent": "JENAI/1.0 (+https://jenai.in)",
      "X-JENAI-Event": e.kind,
      "X-JENAI-Delivery": e.id,
      "Idempotency-Key": e.idempotencyKey,
      ...(secret ? { "X-JENAI-Signature": signPayload(secret, body) } : {}),
      ...((ctx.integration.config.headers as Record<string, string> | undefined) ?? {}),
    }, body);
  },
};

export const restConnector: Connector = {
  kind: "rest_generic",
  async test(ctx) {
    const url = String(ctx.integration.config.testUrl ?? ctx.integration.config.url ?? "");
    if (!url) return { ok: false, message: "No address to call." };
    const r = await post(ctx, url, authHeaders(ctx), JSON.stringify({ event: "ping" }), String(ctx.integration.config.testMethod ?? "GET"));
    return r.ok ? { ok: true, message: `Your API answered ${r.httpStatus}.` } : { ok: false, message: `Your API answered ${r.httpStatus ?? "nothing"}: ${r.response ?? ""}`.slice(0, 200) };
  },
  async send(ctx, e) {
    const routes = (ctx.integration.config.routes as Record<string, { url: string; method?: string }> | undefined) ?? {};
    const route = routes[e.kind] ?? routes.default;
    if (!route?.url) return { ok: false, response: `No route configured for ${e.kind}`, retry: false };
    const url = route.url.replace(/\{\{\s*external_id\s*\}\}/g, e.externalId ?? "");
    const body = JSON.stringify(applyMapping(e.payload, ctx.integration.mapping?.[e.kind]));
    return post(ctx, url, { "Content-Type": "application/json", ...authHeaders(ctx) }, body, route.method ?? "POST");
  },
};

function authHeaders(ctx: ConnectorContext): Record<string, string> {
  const h: Record<string, string> = { ...((ctx.integration.config.headers as Record<string, string> | undefined) ?? {}) };
  const { api_key, bearer_token, basic_user, basic_password } = ctx.credentials;
  const headerName = String(ctx.integration.config.apiKeyHeader ?? "X-API-Key");
  if (bearer_token) h.Authorization = `Bearer ${bearer_token}`;
  else if (api_key) h[headerName] = api_key;
  else if (basic_user) h.Authorization = `Basic ${Buffer.from(`${basic_user}:${basic_password ?? ""}`).toString("base64")}`;
  return h;
}
