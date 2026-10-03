import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { whatsappChannels, whatsappInbox, withTenant } from "@jenai/db";
import { handleInbound, type CaseReader } from "./cases";
import { OpenWaWhatsApp, keepConnected, lidAddress, openWaMediaId, whatsappFor, type InboundMessage, type QueuedMessage, type WhatsAppSender } from "./whatsapp";

/**
 * A message that keeps failing (the number cannot be resolved, the database is down) is
 * tried again with a widening gap: 15 s, 30 s, 1 min, 2 min … about an hour in all, then
 * shown on the WhatsApp page as not read, with a button to read it again.
 */
export const INBOX_MAX_ATTEMPTS = 9;
const dueAt = (receivedAt: Date, attempts: number) => receivedAt.getTime() + 15_000 * (2 ** attempts - 1);

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

/**
 * Turns a queued message into one the case logic reads, resolving a privacy id (…@lid) to the
 * phone number. When WhatsApp hides the number from this account, the chat runs on the
 * private id and the complaint asks the number instead.
 */
async function toInbound(m: QueuedMessage, sender: WhatsAppSender): Promise<InboundMessage | null> {
  let from = m.from;
  if (!from && m.lid && sender instanceof OpenWaWhatsApp) from = await sender.resolvePhone(m.lid);
  if (!from && m.lid) from = lidAddress(m.lid);
  if (!from) return null;
  const msg: InboundMessage = { from, id: m.id, at: new Date(m.at), ...(m.name ? { name: m.name } : {}), ...(m.text ? { text: m.text } : {}) };
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
 * Reads the queued WhatsApp messages of one workspace, oldest first, since each reply
 * answers the question asked before it: while one person's message waits for another try,
 * their later messages wait behind it (other people's do not).
 */
export async function processInbox(tenantId: string, reader: CaseReader, sender?: WhatsAppSender, limit = 10): Promise<{ handled: number; failed: number }> {
  const stats = { handled: 0, failed: 0 };
  const wa = await withTenant(tenantId, (tx) => whatsappFor(tx, tenantId, sender));
  if (!wa) return stats;
  const pending = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(whatsappInbox)
      .where(and(isNull(whatsappInbox.processedAt), lt(whatsappInbox.attempts, INBOX_MAX_ATTEMPTS)))
      .orderBy(asc(whatsappInbox.receivedAt))
      .limit(200),
  );
  const held = new Set<string>();
  for (const row of pending) {
    if (stats.handled + stats.failed >= limit) break;
    const queued = row.message as unknown as QueuedMessage;
    const who = queued.chatId || queued.from || row.id;
    if (held.has(who)) continue;
    if (Date.now() < dueAt(row.receivedAt, row.attempts)) {
      held.add(who);
      continue;
    }
    try {
      const msg = await toInbound(queued, wa.sender);
      if (!msg) throw new Error("WhatsApp did not show this sender's phone number");
      await handleInbound(tenantId, msg, reader, wa.sender);
      await withTenant(tenantId, (tx) => tx.update(whatsappInbox).set({ processedAt: new Date(), lastError: null }).where(eq(whatsappInbox.id, row.id)));
      stats.handled++;
    } catch (e) {
      held.add(who);
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

/** The workspace's WhatsApp number, reconnected when the gateway dropped it; null when it has no OpenWA channel. */
export async function keepWhatsappConnected(tenantId: string): Promise<{ status: string; reconnecting: boolean } | null> {
  const wa = await withTenant(tenantId, (tx) => whatsappFor(tx, tenantId));
  if (!wa || !(wa.sender instanceof OpenWaWhatsApp)) return null;
  const r = await keepConnected(wa.sender);
  if (r.reconnecting) await recordLink(tenantId, { status: "initializing", phone: r.phone ? `+${r.phone.replace(/\D/g, "")}` : null });
  return { status: r.status, reconnecting: r.reconnecting };
}

/** Puts the messages that could not be read back in the queue (the WhatsApp page's "Read them again"). */
export async function retryInbox(tenantId: string): Promise<number> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .update(whatsappInbox)
      .set({ attempts: 0, lastError: null })
      .where(and(isNull(whatsappInbox.processedAt), gte(whatsappInbox.attempts, INBOX_MAX_ATTEMPTS)))
      .returning({ id: whatsappInbox.id }),
  );
  return rows.length;
}
