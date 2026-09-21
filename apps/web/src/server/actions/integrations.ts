"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiKeys, audit, integrationEvents, integrations, withTenant } from "@jenai/db";
import { CONNECTORS, credentialsOf, sealCredentials } from "@jenai/engine";
import { actorFields, requireWorkspace, workspaceAction } from "../access";
import { requestMeta } from "../session";
import { SCOPES, newApiKey } from "../api/key";

const go = (slug: string, msg: { ok?: string; error?: string; key?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  if (msg.key) q.set("new_key", msg.key);
  redirect(`/w/${slug}/integrations?${q}`);
};

async function meta(ctx: Awaited<ReturnType<typeof requireWorkspace>>) {
  return { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()) };
}

const EVENTS = ["call.completed", "appointment.booked", "do_not_call.added"] as const;

/** Connect the client's own system: a webhook they own, their API, or Zoho CRM. */
export async function connectSystem(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  const p = z
    .object({
      kind: z.enum(["webhook_out", "rest_generic", "zoho_crm"]),
      name: z.string().trim().min(2).max(60),
      url: z.string().trim().max(400).optional(),
      dc: z.string().trim().max(4).optional(),
      module: z.string().trim().max(40).optional(),
      client_id: z.string().trim().max(200).optional(),
      client_secret: z.string().trim().max(200).optional(),
      refresh_token: z.string().trim().max(400).optional(),
      api_key: z.string().trim().max(300).optional(),
    })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) go(slug, { error: "Check the connection details." });
  const d = p.data!;
  const events = EVENTS.filter((e) => fd.get(`event_${e}`) === "on");

  let config: Record<string, unknown> = {};
  let credentials: Record<string, string> = {};
  if (d.kind === "webhook_out") {
    if (!d.url?.startsWith("https://")) go(slug, { error: "Give the https address JENAI should send to." });
    config = { url: d.url };
    credentials = { signing_secret: `whsec_${randomBytes(24).toString("base64url")}` };
  } else if (d.kind === "rest_generic") {
    if (!d.url?.startsWith("https://")) go(slug, { error: "Give the https address of your API." });
    config = { routes: { default: { url: d.url, method: "POST" } }, testUrl: d.url, testMethod: "POST" };
    credentials = d.api_key ? { api_key: d.api_key } : {};
  } else {
    if (!d.client_id || !d.client_secret || !d.refresh_token) go(slug, { error: "Zoho needs the client id, client secret and refresh token from your Zoho API console." });
    config = { dc: (d.dc || "in").toLowerCase(), module: d.module || "Leads" };
    credentials = { client_id: d.client_id!, client_secret: d.client_secret!, refresh_token: d.refresh_token! };
  }

  const row = await withTenant(ctx.org.id, async (tx) => {
    const [i] = await tx
      .insert(integrations)
      .values({ tenantId: ctx.org.id, kind: d.kind, name: d.name, config, credentials: sealCredentials(ctx.org.id, credentials), events, status: "draft", createdBy: ctx.user.userId })
      .returning();
    await audit(tx, { ...(await meta(ctx)), action: "integration.connected", targetType: "integration", targetId: i!.id, summary: `Connected ${d.name} (${d.kind.replace("_", " ")})`, diff: { kind: d.kind, events } });
    return i!;
  });
  go(slug, { ok: `${row.name} added. Test it to make sure JENAI can reach it.` });
}

/** Ask their system whether it is reachable, and say so in one line. */
export async function testSystem(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  const r = await withTenant(ctx.org.id, async (tx) => {
    const [i] = await tx.select().from(integrations).where(eq(integrations.id, id));
    if (!i) return { error: "That connection is gone." };
    const connector = CONNECTORS[i.kind];
    if (!connector) return { error: "That kind of system is not ready yet." };
    const res = await connector.test({
      integration: i,
      credentials: credentialsOf(i),
      fetch,
      async save(patch) {
        await tx
          .update(integrations)
          .set({ ...(patch.credentials ? { credentials: sealCredentials(ctx.org.id, patch.credentials) } : {}), ...(patch.config ? { config: { ...i.config, ...patch.config } } : {}), updatedAt: new Date() })
          .where(eq(integrations.id, i.id));
      },
    });
    await tx
      .update(integrations)
      .set({ status: res.ok ? "connected" : "error", lastOkAt: res.ok ? new Date() : i.lastOkAt, lastError: res.ok ? null : res.message, lastErrorAt: res.ok ? i.lastErrorAt : new Date(), updatedAt: new Date() })
      .where(eq(integrations.id, i.id));
    return res.ok ? { ok: res.message } : { error: res.message };
  });
  go(slug, r);
}

export async function setSystemStatus(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const to = String(fd.get("to"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  if (!["paused", "connected", "removed"].includes(to)) go(slug, { error: "Unknown change." });
  await withTenant(ctx.org.id, async (tx) => {
    const [i] = await tx.select().from(integrations).where(eq(integrations.id, id));
    if (!i) return;
    if (to === "removed") await tx.delete(integrations).where(eq(integrations.id, id));
    else await tx.update(integrations).set({ status: to as "paused" | "connected", updatedAt: new Date() }).where(eq(integrations.id, id));
    await audit(tx, { ...(await meta(ctx)), action: `integration.${to}`, targetType: "integration", targetId: id, summary: `${to === "removed" ? "Removed" : to === "paused" ? "Paused" : "Resumed"} ${i.name}` });
  });
  go(slug, { ok: to === "removed" ? "Connection removed." : to === "paused" ? "Paused. Nothing will be sent until you resume." : "Resumed." });
}

/** Send the deliveries that failed again, now. */
export async function retryDeliveries(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  const n = await withTenant(ctx.org.id, async (tx) => {
    const rows = await tx
      .update(integrationEvents)
      .set({ status: "queued", attempts: 0, nextAttemptAt: new Date(), error: null, updatedAt: new Date() })
      .where(and(eq(integrationEvents.integrationId, id), inArray(integrationEvents.status, ["failed"])))
      .returning({ id: integrationEvents.id });
    return rows.length;
  });
  go(slug, { ok: n ? `${n} put back in the queue. The worker sends them within a minute.` : "Nothing was waiting." });
}

/** A key for the client's own systems. Shown once. */
export async function createApiKey(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "apikeys:manage");
  const name = String(fd.get("name") ?? "").trim().slice(0, 60) || "Their system";
  const scopes = SCOPES.filter((s) => fd.get(`scope_${s}`) === "on");
  const allowedIps = String(fd.get("allowedIps") ?? "")
    .split(/[\s,]+/)
    .filter((x) => /^[0-9a-f.:]{3,45}$/i.test(x))
    .slice(0, 20);
  if (!scopes.length) go(slug, { error: "Choose what this key may do." });
  const { key, prefix, keyHash } = newApiKey();
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.insert(apiKeys).values({ tenantId: ctx.org.id, name, prefix, keyHash, scopes: [...scopes], allowedIps, createdBy: ctx.user.userId }).returning();
    await audit(tx, { ...(await meta(ctx)), action: "apikey.created", targetType: "api_key", targetId: row!.id, summary: `Created the API key ${name}`, diff: { scopes, allowedIps } });
  });
  go(slug, { ok: "Key created. Copy it now: it is not shown again.", key });
}

export async function revokeApiKey(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const ctx = await workspaceAction(slug, "apikeys:manage");
  await withTenant(ctx.org.id, async (tx) => {
    const [row] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id)).returning();
    if (row) await audit(tx, { ...(await meta(ctx)), action: "apikey.revoked", targetType: "api_key", targetId: id, summary: `Revoked the API key ${row.name}` });
  });
  go(slug, { ok: "Key revoked. Anything using it stops working now." });
}

/** The signing secret, shown once so their developer can check our signature. */
export async function revealSigningSecret(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = String(fd.get("id"));
  const ctx = await workspaceAction(slug, "integrations:manage");
  const secret = await withTenant(ctx.org.id, async (tx) => {
    const [i] = await tx.select().from(integrations).where(eq(integrations.id, id));
    if (!i) return null;
    await audit(tx, { ...(await meta(ctx)), action: "integration.secret_revealed", targetType: "integration", targetId: id, summary: `Looked at the signing secret for ${i.name}` });
    return credentialsOf(i).signing_secret ?? null;
  });
  go(slug, secret ? { ok: "Signing secret below. Keep it in your code, not in a browser.", key: secret } : { error: "This connection has no signing secret." });
}
