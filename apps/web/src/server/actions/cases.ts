"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { can, holdsAnywhere } from "@jenai/authz";
import { audit, cases, sealSecret, whatsappChannels, withTenant } from "@jenai/db";
import { OpenWaWhatsApp, channelCredentials } from "@jenai/engine";
import { actorFields, requireWorkspace } from "../access";
import { requestMeta } from "../session";

const go = (slug: string, path: string, msg: { ok?: string; error?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`/w/${slug}/${path}${path.includes("?") ? "&" : "?"}${q}`);
};

/** An officer takes a case up, closes it, assigns it or adds a note. */
export async function updateCase(fd: FormData) {
  const slug = String(fd.get("slug"));
  const id = z.uuid().parse(fd.get("id"));
  const ctx = await requireWorkspace(slug);
  const [c] = await withTenant(ctx.org.id, (tx) => tx.select().from(cases).where(eq(cases.id, id)));
  if (!c) go(slug, "cases", { error: "Case not found" });
  if (!can(ctx.access, "contacts:edit", { branchId: c!.branchId })) go(slug, `cases/${id}`, { error: "Your role cannot update cases." });
  const status = z.enum(["collecting", "ready", "taken_up", "closed"]).optional().parse(fd.get("status") || undefined);
  const assignee = String(fd.get("assignee") ?? "");
  const note = String(fd.get("note") ?? "").trim().slice(0, 1000);
  await withTenant(ctx.org.id, async (tx) => {
    await tx
      .update(cases)
      .set({
        ...(status ? { status } : {}),
        ...(assignee ? { assignedMembershipId: assignee === "none" ? null : z.uuid().parse(assignee) } : {}),
        ...(note ? { officerNote: note } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cases.id, id));
    await audit(tx, {
      ...actorFields(ctx),
      tenantId: ctx.org.id,
      ...(await requestMeta()),
      action: "case.updated",
      targetType: "case",
      targetId: id,
      summary: `Case updated${status ? `: ${status.replace("_", " ")}` : ""}${assignee ? ", assignee changed" : ""}${note ? ", note added" : ""}`,
    });
  });
  go(slug, `cases/${id}`, { ok: "Case updated" });
}

/** Where the OpenWA container on this server delivers events (nginx passes it to the portal). */
const webhookUrl = () => process.env.JENAI_OPENWA_WEBHOOK_URL ?? "http://host.docker.internal:8086/api/whatsapp/openwa";

async function channelForSetup(slug: string) {
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "integrations:manage")) go(slug, "whatsapp", { error: "Your role cannot set up WhatsApp." });
  const [ch] = await withTenant(ctx.org.id, (tx) => tx.select().from(whatsappChannels).where(eq(whatsappChannels.tenantId, ctx.org.id)).limit(1));
  const creds = ch ? channelCredentials(ch) : null;
  if (!ch || ch.mode !== "openwa" || !ch.openwaUrl || !creds) go(slug, "whatsapp", { error: "OpenWA is not set up on this server yet: run openwa-setup.sh on the server first." });
  return { ctx, ch: ch!, creds: creds! };
}

/**
 * Links the police WhatsApp number through the OpenWA gateway on this server:
 * makes the session if there is none, points its events at this portal with a
 * fresh signing secret, and starts it, so the page shows the QR code to scan.
 */
export async function linkWhatsapp(fd: FormData) {
  const slug = String(fd.get("slug"));
  const { ctx, ch, creds } = await channelForSetup(slug);
  let error: string | null = null;
  try {
    const sessionId = ch.openwaSession ?? (await OpenWaWhatsApp.createSession(ch.openwaUrl!, creds.apiKey, `jenai-${slug}`.slice(0, 50)));
    const gw = new OpenWaWhatsApp(ch.openwaUrl!, sessionId, creds.apiKey);
    const secret = randomBytes(32).toString("hex");
    await gw.registerWebhook(webhookUrl(), secret);
    await gw.start().catch(() => null); // already running is fine
    const live = await gw.session().catch(() => null);
    await withTenant(ctx.org.id, async (tx) => {
      await tx
        .update(whatsappChannels)
        .set({
          openwaSession: sessionId,
          credentials: sealSecret(ctx.org.id, "whatsapp", JSON.stringify({ apiKey: creds.apiKey, webhookSecret: secret })),
          linkStatus: live?.status ?? "initializing",
          updatedAt: new Date(),
        })
        .where(eq(whatsappChannels.id, ch.id));
      await audit(tx, {
        ...actorFields(ctx),
        tenantId: ctx.org.id,
        ...(await requestMeta()),
        action: "whatsapp.link_started",
        targetType: "whatsapp_channel",
        targetId: ch.id,
        summary: "Started linking the WhatsApp number through OpenWA on this server",
      });
    });
  } catch (e) {
    error = `The WhatsApp gateway did not respond as expected: ${(e as Error).message.slice(0, 200)}`;
  }
  if (error) go(slug, "whatsapp", { error });
  go(slug, "whatsapp", { ok: "Now scan the QR code with the police phone" });
}

/** Unlinks the number (the phone shows it under Linked devices until then). Messages stop until it is linked again. */
export async function unlinkWhatsapp(fd: FormData) {
  const slug = String(fd.get("slug"));
  const { ctx, ch, creds } = await channelForSetup(slug);
  let error: string | null = null;
  try {
    if (ch.openwaSession) await new OpenWaWhatsApp(ch.openwaUrl!, ch.openwaSession, creds.apiKey).logout();
  } catch (e) {
    error = `The WhatsApp gateway did not respond as expected: ${(e as Error).message.slice(0, 200)}`;
  }
  if (error) go(slug, "whatsapp", { error });
  await withTenant(ctx.org.id, async (tx) => {
    await tx.update(whatsappChannels).set({ linkStatus: "disconnected", displayE164: null, updatedAt: new Date() }).where(eq(whatsappChannels.id, ch.id));
    await audit(tx, {
      ...actorFields(ctx),
      tenantId: ctx.org.id,
      ...(await requestMeta()),
      action: "whatsapp.unlinked",
      targetType: "whatsapp_channel",
      targetId: ch.id,
      summary: "Unlinked the WhatsApp number",
    });
  });
  go(slug, "whatsapp", { ok: "WhatsApp number unlinked" });
}

/** The cyber team's complaint form, sent on WhatsApp to complainants who lost no money. */
export async function saveFormLink(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await requireWorkspace(slug);
  if (!holdsAnywhere(ctx.access, "integrations:manage")) go(slug, "whatsapp", { error: "Your role cannot set up WhatsApp." });
  const url = String(fd.get("formUrl") ?? "").trim();
  if (url && !z.url().safeParse(url).success) go(slug, "whatsapp", { error: "Enter the full link of the complaint form, starting with https://" });
  if (url && !url.startsWith("https://")) go(slug, "whatsapp", { error: "The form link must start with https://" });
  await withTenant(ctx.org.id, async (tx) => {
    const [ch] = await tx.select().from(whatsappChannels).where(eq(whatsappChannels.tenantId, ctx.org.id)).limit(1);
    if (ch) await tx.update(whatsappChannels).set({ formUrl: url || null, updatedAt: new Date() }).where(eq(whatsappChannels.id, ch.id));
    else await tx.insert(whatsappChannels).values({ tenantId: ctx.org.id, mode: "simulated", formUrl: url || null });
    await audit(tx, {
      ...actorFields(ctx),
      tenantId: ctx.org.id,
      ...(await requestMeta()),
      action: "whatsapp.form_link_saved",
      targetType: "whatsapp_channel",
      summary: url ? `Complaint form link set to ${url.slice(0, 120)}` : "Complaint form link removed",
    });
  });
  go(slug, "whatsapp", { ok: url ? "Form link saved" : "Form link removed" });
}
