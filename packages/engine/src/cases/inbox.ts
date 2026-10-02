import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { whatsappChannels, whatsappInbox, withTenant } from "@jenai/db";
import { handleInbound, type CaseReader } from "./cases";
import { OpenWaWhatsApp, openWaMediaId, whatsappFor, type InboundMessage, type QueuedMessage, type WhatsAppSender } from "./whatsapp";

/** A message that keeps failing (the model is down, the number cannot be resolved) is given up after this many tries. */
const MAX_ATTEMPTS = 5;

/**
 * Queues one inbound message for the worker. The webhook answers OpenWA at once;
 * reading the reply with a local model can take minutes. A retried delivery of the
 * same message is dropped here.
 */
export async function queueInbound(tenantId: string, m: QueuedMessage): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .insert(whatsappInbox)
      .values({ tenantId, externalId: m.id, message: m as unknown as Record<string, unknown> })
      .onConflictDoNothing()
      .returning({ id: whatsappInbox.id }),
  );
  return rows.length > 0;
}

/** What OpenWA last said about the link (waiting for the QR scan, ready, disconnected) and the linked number. */
export async function recordLink(tenantId: string, link: { status: string | null; phone: string | null }): Promise<void> {
  if (!link.status && !link.phone) return;
  await withTenant(tenantId, (tx) =>
    tx
      .update(whatsappChannels)
      .set({ ...(link.status ? { linkStatus: link.status.slice(0, 40) } : {}), ...(link.phone ? { displayE164: link.phone } : {}), updatedAt: new Date() })
      .where(eq(whatsappChannels.tenantId, tenantId)),
  );
}

/** Turns a queued message into one the case logic reads, resolving a privacy id (…@lid) to the phone number. */
async function toInbound(m: QueuedMessage, sender: WhatsAppSender): Promise<InboundMessage | null> {
  let from = m.from;
  if (!from && m.lid && sender instanceof OpenWaWhatsApp) from = await sender.resolvePhone(m.lid);
  if (!from) return null;
  const msg: InboundMessage = { from, id: m.id, at: new Date(m.at), ...(m.text ? { text: m.text } : {}) };
  if (m.media) {
    msg.media = {
      id: openWaMediaId(m.chatId, m.id),
      kind: m.media.kind,
      mime: m.media.mime,
      filename: m.media.filename,
      caption: m.text,
      ...(m.media.dataBase64 ? { inline: { bytes: Buffer.from(m.media.dataBase64, "base64"), mime: m.media.mime ?? "application/octet-stream" } } : {}),
    };
  }
  return msg;
}

/**
 * Reads the queued WhatsApp messages of one workspace, oldest first, since each
 * reply answers the question asked before it. A failure is retried on the next round.
 */
export async function processInbox(tenantId: string, reader: CaseReader, sender?: WhatsAppSender, limit = 10): Promise<{ handled: number; failed: number }> {
  const stats = { handled: 0, failed: 0 };
  const wa = await withTenant(tenantId, (tx) => whatsappFor(tx, tenantId, sender));
  if (!wa) return stats;
  const due = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(whatsappInbox)
      .where(and(isNull(whatsappInbox.processedAt), lt(whatsappInbox.attempts, MAX_ATTEMPTS)))
      .orderBy(asc(whatsappInbox.receivedAt))
      .limit(limit),
  );
  for (const row of due) {
    try {
      const msg = await toInbound(row.message as unknown as QueuedMessage, wa.sender);
      if (!msg) throw new Error("WhatsApp did not show this sender's phone number");
      await handleInbound(tenantId, msg, reader, wa.sender);
      await withTenant(tenantId, (tx) => tx.update(whatsappInbox).set({ processedAt: new Date(), lastError: null }).where(eq(whatsappInbox.id, row.id)));
      stats.handled++;
    } catch (e) {
      await withTenant(tenantId, (tx) =>
        tx
          .update(whatsappInbox)
          .set({ attempts: sql`${whatsappInbox.attempts} + 1`, lastError: (e as Error).message.slice(0, 300) })
          .where(eq(whatsappInbox.id, row.id)),
      );
      stats.failed++;
    }
  }
  return stats;
}
